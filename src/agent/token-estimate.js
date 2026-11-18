'use strict';

/**
 * 文本 → token 估算的**唯一来源**。
 *
 * 公式与 Rust `crates/dieyun-base/src/compaction/tokens.rs` **逐字对齐**：
 * `ceil(cjk / CJK_CHARS_PER_TOKEN + other / CHARS_PER_TOKEN)`，且总长按 **Unicode 码点**
 * 计（与 Rust `str::chars()` 一致：星平面字符算 1，而非 UTF-16 码元的 2）。
 * 两语言共用同一基线 `test/fixtures/token-estimate-cases.json`，由
 * `test/unit/token-estimate.test.cjs` 与 `tokens.rs` 的 `#[cfg(test)]` 两侧分别校验
 * —— 改公式必须同时改两侧实现与该基线。
 *
 * Main 侧 compaction 直接走 Rust；JS 侧（账本扣减 / 用量估算 / UI 圆环 / 上下文预算）
 * 一律消费本模块，避免出现「中文按 3.2、英文按 3.2 / 或只算 CJK」这类互相打架的启发式。
 *
 * 系数来自 `agent-limits.js`（唯一来源，刻意不上设置页）。
 * CJK 字符类与 Rust `is_cjk` 逐段对齐：汉字 / 扩展 A / 兼容汉字 / 平假名 / 片假名 / 谚文。
 */

const { AGENT_LIMITS_DEFAULTS } = require('./agent-limits');
// 图片 part 形状的单一来源（OpenAI chat `image_url` / Responses `input_image` / Anthropic `image`）：
// 出站图片闸门（sanitizeChatBodyImagesForApi）与计费必须认同一套形状，否则会漂移成
// 「闸门拦下了、账本还把 base64 当正文算」。
const { isChatImagePart } = require('./guardrails-shared');

const CHARS_PER_TOKEN = AGENT_LIMITS_DEFAULTS.charsPerToken;
const CJK_CHARS_PER_TOKEN = AGENT_LIMITS_DEFAULTS.cjkCharsPerToken;

/** 单个图片 part 的等效字符数（唯一来源 `agent-limits.visionPartEqChars`）。 */
const IMAGE_PART_EQUIV_CHARS = Number(AGENT_LIMITS_DEFAULTS.visionPartEqChars);

/**
 * 单个图片 part 的等效 token。
 *
 * 图片在真实请求里由服务端**按像素**换算成「图片 token」，与 base64 长度无关：
 * 同一张图存成 1.5MB PNG 与压成 200KB JPEG，输入 token 几乎相同。若按 base64 长度计
 * （旧行为：image part 既无 `text` 也无 `content`，退化成整个 JSON 计费），一张图就会被
 * 放大数百倍 —— 实测一次 PNG 让压缩侧估到 685406 token，直接越过触发线，而图片既不可
 * 折叠也不可压缩，于是变成「每轮都压、却压不掉」的假压缩（其中一次白等 75s 超时），
 * 上下文圆环与用量统计也一并虚高。
 *
 * 这里只做「等效字符 → token」的同系数换算，折算系数本身仍唯一来源 `agent-limits.js`。
 * Rust 侧同值见 `crates/dieyun-base/src/compaction/tokens.rs::IMAGE_PART_EQUIV_TOKENS`，
 * 两侧一致性由 `test/fixtures/token-estimate-cases.json` 的图片用例锁定（改一侧必改另一侧）。
 */
const IMAGE_PART_EQUIV_TOKENS = Math.ceil(IMAGE_PART_EQUIV_CHARS / CHARS_PER_TOKEN);

/** CJK 字符类单一来源（与 Rust `is_cjk` 的区段一一对应）。 */
const CJK_CLASS = '\\u4e00-\\u9fff\\u3400-\\u4dbf\\uf900-\\ufaff\\u3040-\\u309f\\u30a0-\\u30ff\\uac00-\\ud7af';
/** 全局版：用于 `match` 统计个数。 */
const CJK_RE = new RegExp(`[${CJK_CLASS}]`, 'g');
/** 单字符版：用于逐码点 `test`（不可带 g，否则 lastIndex 有状态）。 */
const CJK_CHAR_RE = new RegExp(`[${CJK_CLASS}]`);

/** 统计字符串中的 CJK 字符数（乱码修复 / token 估算共用同一字符类）。 */
function countCjkChars(text) {
  const s = String(text == null ? '' : text);
  if (!s) return 0;
  return (s.match(CJK_RE) || []).length;
}

/**
 * 与 Rust `estimate_text_tokens` 同式：`ceil(cjk/1.5 + other/3.2)`。
 * 迭代 **Unicode 码点**（`for...of`），CJK 与总长同口径，避免 emoji / 扩展区字符
 * 被 UTF-16 码元计成 2 而与 Rust 分叉。
 */
function estimateTextTokens(text) {
  const s = String(text == null ? '' : text);
  if (!s) return 0;
  let cjk = 0;
  let total = 0;
  for (const ch of s) {
    total += 1;
    if (CJK_CHAR_RE.test(ch)) cjk += 1;
  }
  return Math.ceil(cjk / CJK_CHARS_PER_TOKEN + (total - cjk) / CHARS_PER_TOKEN);
}

/** 对象按 JSON 全量计费（与 Rust `Value::to_string()` 一致）；异常退化为 0。 */
function estimateJsonTokens(value) {
  try {
    return estimateTextTokens(JSON.stringify(value));
  } catch {
    return 0;
  }
}

/**
 * 与 Rust `estimate_tokens` 逐字对齐的内容计费：
 * - 图片 part（三种形状）→ `IMAGE_PART_EQUIV_TOKENS`（不按 base64 长度计）
 * - `null` / `undefined` → 0
 * - string → 文本
 * - array → 各元素**分别**计费后求和（**无分隔符**；与 Rust 一致）
 * - object → 取 `text`（否则 `content`）字符串；非字符串或缺失时按整个 JSON 计费
 * - 其它标量 → `String(value)`
 */
function estimateContentTokens(content) {
  // 图片先判：它是「由服务端换算的图片 token」，与文本长度无关，绝不能落到下方 JSON 全量计费
  if (isChatImagePart(content)) return IMAGE_PART_EQUIV_TOKENS;
  if (content == null) return 0;
  if (typeof content === 'string') return estimateTextTokens(content);
  if (Array.isArray(content)) {
    let sum = 0;
    for (const part of content) sum += estimateContentTokens(part);
    return sum;
  }
  if (typeof content === 'object') {
    for (const key of ['text', 'content']) {
      if (content[key] !== undefined) {
        return typeof content[key] === 'string'
          ? estimateTextTokens(content[key])
          : estimateJsonTokens(content);
      }
    }
    return estimateJsonTokens(content);
  }
  return estimateTextTokens(String(content));
}

/**
 * 单条消息计费：正文（`estimateContentTokens`，与 Rust `estimate_messages_tokens` 同构）
 * + 6 结构开销 + **`assistant.tool_calls`**。
 * tool_calls 是**刻意的 JS 侧增量**：该部分同样占真实窗口，Rust 侧不计，故两侧
 * message 级总量在此项存在受预期的差异（见 fixture 的 `jsOnly`）。
 */
function estimateMessageTokens(message) {
  if (!message) return 6;
  let tokens = estimateContentTokens(message.content) + 6;
  if (message.tool_calls) tokens += estimateContentTokens(message.tool_calls);
  return tokens;
}

/** 整段消息计费。 */
function estimateMessagesTokens(messages) {
  let total = 0;
  for (const m of messages || []) total += estimateMessageTokens(m);
  return total;
}

/** 工具 schema 计费（JSON 全量）：不计入 messages，但占真实窗口。 */
function estimateToolsTokens(tools) {
  if (!Array.isArray(tools) || !tools.length) return 0;
  try {
    return estimateTextTokens(JSON.stringify(tools));
  } catch {
    return Math.ceil(tools.length * 120);
  }
}

/** 组合用量：system + messages + tools (+ draft)。UI 圆环 / 发送前预估共用。 */
function estimateFullContextUsage({ systemContent, messages, tools, draft } = {}) {
  let total = estimateTextTokens(systemContent || '');
  total += estimateMessagesTokens(messages || []);
  total += estimateToolsTokens(tools || []);
  if (draft && String(draft).trim()) total += estimateTextTokens(draft) + 6;
  return total;
}

module.exports = {
  CHARS_PER_TOKEN,
  CJK_CHARS_PER_TOKEN,
  IMAGE_PART_EQUIV_CHARS,
  IMAGE_PART_EQUIV_TOKENS,
  CJK_RE,
  countCjkChars,
  estimateTextTokens,
  estimateContentTokens,
  estimateMessageTokens,
  estimateMessagesTokens,
  estimateToolsTokens,
  estimateFullContextUsage
};
