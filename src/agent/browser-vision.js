'use strict';

/**
 * 运行期视觉输入缓冲（浏览器截图 + 附件补看）。
 *
 * 背景：工具结果里的 base64 会被剥离（browser_*）或落盘（fs_read_file），
 * 模型因此看不见画面。这里把「需要真正看见」的图片暂存到内存，由
 * rust-loop-runner 在下一轮 LLM 请求前作为 user 消息（image_url）注入。
 *
 * 两种来源：
 * - `browser`：browser_screenshot / browser_observe 捕获的页面画面；
 * - `attachment`：模型用 fs_read_file 设 encoding=base64 重新读取的历史附件图片。
 *
 * 约束（与 dieyun-core 的 strip_inline_images_from_messages 同源策略一致）：
 * - 只暂存、不写入 Rust 消息账本，也不进 checkpoint，避免 base64 长期驻留与重复发送；
 * - 按来源分别限流，额度口径是「每个 LLM 轮次在途上限」（注入后清空，下一轮重新计）；
 * - 单张超过上限直接丢弃；同一路径重复入队按幂等处理，不重复注入也不吃额度；
 * - 注入后立即释放；run 结束时 rust-loop-runner 会兜底清理。
 *
 * 张数与体积上限的唯一来源是 agent-limits（由调用方解析后传入，缺省时退回默认值）。
 */

const { AGENT_LIMITS_DEFAULTS } = require('./agent-limits');
const { normalizeVisionImageMime } = require('./guardrails-shared');

const SOURCE_BROWSER = 'browser';
const SOURCE_ATTACHMENT = 'attachment';

/** 兼容旧调用方的常量（现由 agent-limits 单一来源，此处仅做再导出） */
const MAX_SHOTS_PER_RUN = AGENT_LIMITS_DEFAULTS.visionShotsPerRound;
const MAX_BASE64_CHARS = AGENT_LIMITS_DEFAULTS.visionMaxBase64Chars;

/** @type {Map<string, Array<{ source: string, tool?: string, mime: string, base64: string, path?: string, width?: number, height?: number }>>} */
const pendingByRun = new Map();

function normalizeRunId(runId) {
  return runId == null ? '' : String(runId).trim();
}

function toPositiveInt(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.floor(n);
}

/**
 * 解析视觉注入额度；缺省时退回 agent-limits 默认值。
 * 额度的口径是「每个 LLM 轮次在途上限」——缓冲注入后即清空，下一轮重新计。
 * @param {object} [limits] agent-limits 解析结果
 */
function resolveVisionLimits(limits) {
  const l = limits && typeof limits === 'object' ? limits : {};
  return {
    maxPerSource: {
      [SOURCE_BROWSER]: toPositiveInt(l.visionShotsPerRound, MAX_SHOTS_PER_RUN),
      [SOURCE_ATTACHMENT]: toPositiveInt(
        l.visionReattachPerRound,
        AGENT_LIMITS_DEFAULTS.visionReattachPerRound
      )
    },
    maxBase64Chars: toPositiveInt(l.visionMaxBase64Chars, MAX_BASE64_CHARS)
  };
}

function extractShot(toolName, result) {
  if (!result || typeof result !== 'object') return null;
  if (result.ok === false) return null;
  let base64 = '';
  let mime = 'image/png';
  let width;
  let height;
  if (toolName === 'browser_screenshot' && typeof result.base64 === 'string') {
    base64 = result.base64;
    mime = result.mime || mime;
    width = result.width;
    height = result.height;
  } else if (
    toolName === 'browser_observe' &&
    result.screenshot &&
    typeof result.screenshot.base64 === 'string'
  ) {
    base64 = result.screenshot.base64;
    mime = result.screenshot.mime || mime;
    width = result.screenshot.width;
    height = result.screenshot.height;
  } else {
    return null;
  }
  if (!base64) return null;
  return { source: SOURCE_BROWSER, tool: toolName, mime, base64, width, height };
}

/**
 * 暂存一张视觉图片。
 *
 * 幂等：同来源 + 同 path 已在队列里时直接返回 true（不重复入队、不消耗额度）。
 *
 * 额度已满时有两种语义：
 * - 默认（模型显式请求补看）：直接拒绝并入队失败，让调用方回一条明确说明，
 *   避免静默丢图——模型会误以为「我要的 5 张都附上了」。
 * - `evictOldest`（隐式截图）：挤掉同来源最旧的一张，保留最新画面。
 *
 * 格式：声明的 mime 必须在上游支持集内（png/jpeg/gif/webp），否则直接拒绝
 * （注入只会换回 HTTP 400 unsupported image）；未声明 mime 按 png 处理。
 *
 * @param {string} runId
 * @param {{ source?: string, tool?: string, mime?: string, base64?: string, path?: string, width?: number, height?: number }} entry
 * @param {object} [limits] agent-limits 解析结果
 * @param {{ evictOldest?: boolean }} [opts]
 * @returns {boolean} 是否真的入队
 */
function recordVisionImage(runId, entry, limits, opts = {}) {
  const id = normalizeRunId(runId);
  if (!id || !entry || typeof entry !== 'object') return false;
  const cfg = resolveVisionLimits(limits);
  const base64 = typeof entry.base64 === 'string' ? entry.base64 : '';
  if (!base64 || base64.length > cfg.maxBase64Chars) return false;
  const source = entry.source === SOURCE_ATTACHMENT ? SOURCE_ATTACHMENT : SOURCE_BROWSER;
  const cap = cfg.maxPerSource[source] || 0;
  if (!(cap > 0)) return false;

  // 声明了却不受上游支持的格式（bmp/svg/heic…）直接拒绝：注入只会换回 400。
  // 未声明 mime 按 png 处理（浏览器截图即 png），保持既有调用方语义。
  const declaredMime = String(entry.mime || '').trim();
  const mime = declaredMime ? normalizeVisionImageMime(declaredMime) : 'image/png';
  if (!mime) return false;

  const list = pendingByRun.get(id) || [];
  const path = typeof entry.path === 'string' ? entry.path : '';
  // 同一张图本轮已在队列里：幂等返回 true。既不重复注入同一份像素，也不消耗额度。
  if (path && list.some((it) => it.source === source && it.path === path)) return true;
  const sameSource = list.filter((it) => it.source === source).length;
  if (sameSource >= cap) {
    if (opts.evictOldest !== true) return false;
    const idx = list.findIndex((it) => it.source === source);
    if (idx >= 0) list.splice(idx, 1);
  }
  list.push({
    source,
    tool: entry.tool,
    mime,
    base64,
    path,
    width: entry.width,
    height: entry.height
  });
  pendingByRun.set(id, list);
  return true;
}

/**
 * 暂存一张浏览器截图（隐式来源：额度满时保留最新画面）。
 * @returns {boolean} 是否真的入队
 */
function recordBrowserScreenshot(runId, toolName, result, limits) {
  const id = normalizeRunId(runId);
  if (!id) return false;
  const shot = extractShot(toolName, result);
  if (!shot) return false;
  return recordVisionImage(id, shot, limits, { evictOldest: true });
}

/** 取走并清空该 run 的待注入视觉图片。 */
function takePendingVisionImages(runId) {
  const id = normalizeRunId(runId);
  if (!id) return [];
  const list = pendingByRun.get(id);
  if (!list || !list.length) return [];
  pendingByRun.delete(id);
  return list;
}

/** 兜底清理（run 结束 / 异常退出）。 */
function clearPendingVisionImages(runId) {
  const id = normalizeRunId(runId);
  if (id) pendingByRun.delete(id);
}

/** 测试探针：按 run 取出全部待注入图片（生产路径用 takePendingVisionImages）。 */
function takePendingBrowserScreenshots(runId) {
  return takePendingVisionImages(runId);
}

/** 构造把图片交给模型的 user 消息；无有效图片时返回 null。 */
function buildVisionMessage(images) {
  const list = Array.isArray(images) ? images.filter((s) => s && s.base64) : [];
  if (!list.length) return null;
  const browser = list.filter((s) => s.source === SOURCE_BROWSER);
  const attachments = list.filter((s) => s.source === SOURCE_ATTACHMENT);
  const lines = [];
  if (browser.length) {
    const tools = Array.from(new Set(browser.map((s) => s.tool).filter(Boolean))).join('、');
    lines.push(
      `以下是浏览器当前画面截图（${browser.length} 张${tools ? `，来自 ${tools}` : ''}）。` +
        '请据此做视觉判断；页面结构与可点元素仍以 browser_snapshot 返回的 ref 为准。'
    );
  }
  if (attachments.length) {
    const paths = attachments.map((s) => s.path).filter(Boolean).join('、');
    lines.push(
      `以下是重新读取的历史附件图片（${attachments.length} 张${paths ? `：${paths}` : ''}）。` +
        '请直接据此作答；同一张图已提供，无需再次读取。'
    );
  }
  return {
    role: 'user',
    content: [
      { type: 'text', text: lines.join('\n') },
      ...list.map((s) => ({
        type: 'image_url',
        image_url: { url: `data:${s.mime || 'image/png'};base64,${s.base64}` }
      }))
    ]
  };
}

module.exports = {
  SOURCE_BROWSER,
  SOURCE_ATTACHMENT,
  MAX_SHOTS_PER_RUN,
  MAX_BASE64_CHARS,
  resolveVisionLimits,
  recordVisionImage,
  recordBrowserScreenshot,
  takePendingVisionImages,
  clearPendingVisionImages,
  takePendingBrowserScreenshots,
  buildVisionMessage
};
