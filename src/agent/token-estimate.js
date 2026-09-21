'use strict';

/**
 * 文本 → token 估算的**唯一来源**。
 *
 * 公式与 Rust `crates/dieyun-core/src/compaction/tokens.rs::estimate_text_tokens`
 * 逐字对齐：`ceil(cjk / CJK_CHARS_PER_TOKEN + other / CHARS_PER_TOKEN)`。
 * Main 侧 compaction 直接走 Rust；JS 侧（账本扣减 / 用量估算 / UI 圆环 / 上下文预算）
 * 一律消费本模块，避免出现「中文按 3.2、英文按 3.2 / 或只算 CJK」这类互相打架的启发式。
 *
 * 系数来自 `agent-limits.js`（唯一来源，刻意不上设置页）。
 * CJK 字符类与 Rust `is_cjk` 逐段对齐：汉字 / 扩展 A / 兼容汉字 / 平假名 / 片假名 / 谚文。
 */

const { AGENT_LIMITS_DEFAULTS } = require('./agent-limits');

const CHARS_PER_TOKEN = AGENT_LIMITS_DEFAULTS.charsPerToken;
const CJK_CHARS_PER_TOKEN = AGENT_LIMITS_DEFAULTS.cjkCharsPerToken;

const CJK_RE = /[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/g;

/** 统计字符串中的 CJK 字符数（乱码修复 / token 估算共用同一字符类）。 */
function countCjkChars(text) {
  const s = String(text == null ? '' : text);
  if (!s) return 0;
  return (s.match(CJK_RE) || []).length;
}

/** 与 Rust `estimate_text_tokens` 同式：`ceil(cjk/1.5 + other/3.2)`。 */
function estimateTextTokens(text) {
  const s = String(text == null ? '' : text);
  if (!s) return 0;
  const cjk = countCjkChars(s);
  return Math.ceil(cjk / CJK_CHARS_PER_TOKEN + (s.length - cjk) / CHARS_PER_TOKEN);
}

/** 提取消息正文文本：字符串 / 多段 parts（text|content）。 */
function messageContentText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object') return part.text || part.content || '';
        return '';
      })
      .join('\n');
  }
  return '';
}

/**
 * 单条消息计费：正文 + 工具调用参数 + 6 结构开销。
 * 与 Rust `estimate_messages_tokens` 同构，并额外计入 assistant.tool_calls
 * （该部分同样占用真实窗口）。
 */
function estimateMessageTokens(message) {
  if (!message) return 6;
  let text = messageContentText(message.content);
  if (message.tool_calls) {
    try {
      text = `${text || ''}\n${JSON.stringify(message.tool_calls)}`;
    } catch {
      // 循环引用等异常：忽略 tool_calls 部分
    }
  }
  return estimateTextTokens(text) + 6;
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
  CJK_RE,
  countCjkChars,
  estimateTextTokens,
  messageContentText,
  estimateMessageTokens,
  estimateMessagesTokens,
  estimateToolsTokens,
  estimateFullContextUsage
};
