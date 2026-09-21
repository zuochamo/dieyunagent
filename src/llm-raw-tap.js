'use strict';

const path = require('path');
const { getRotatingLog } = require('./logs/rotating-file-log');

/**
 * LLM 原始响应体抓包（排障专用，默认关闭）。
 *
 * 为什么需要这一层：
 * `TraceRound`（Rust `agent/loop_run.rs`）一轮只留 `thought` / `fullThought` / `tools`，
 * 而 `thought_raw = reasoning || content` —— 也就是**上游给的是 `reasoning_content` 就用
 * `reasoning_content`，为空才退回 `content`**。落库后两者已经合成一段文字，
 * 于是「界面上那段文字到底来自 `content` 还是 `reasoning_content`」在库里无法区分；
 * `logs/main.log` 也只记事件、不记响应体。
 *
 * 打开本抓包后，**上游原始响应体**（流式 = 原始 SSE 文本，非流式 = 原始 JSON 体）
 * 会原样落到指定文件。搜那段文字，看它落在 `"content"` 还是 `"reasoning_content"` 键下，
 * 就能把字段归属钉死 —— 不需要改任何业务逻辑，也不需要再猜。
 *
 * 打开方式：`DIEYUN_LLM_RAW_LOG=<文件路径>`（相对路径按 cwd 解析）。
 * 变量值是**输出文件路径本身**，不是开关值：少一处「默认目录从哪来」的隐式配置。
 * 留空 / `0` / `off` / `false` 即关闭。
 *
 * 边界（三条都是为了「抓包不反过来害了正常请求」）：
 *  - 不记录请求头：`Authorization` / apiKey 一律不进本文件；
 *  - 不记录请求体：请求里可能有 base64 图片，抓它只会把检索目标淹掉；
 *  - 单条有上限、文件经统一落盘闸门（有界 + 轮转 + 失败不抛），任何异常直接吞掉。
 */

/** 单条抓包正文上限（超出留头尾）。一段话归属之争远用不到这么多。 */
const MAX_CAPTURE_CHARS = 512 * 1024;
/** 抓包文件上限。 */
const MAX_FILE_BYTES = 8 * 1024 * 1024;
/**
 * 缓冲上限必须大于单条正文：`rotating-file-log` 的熔断策略是**丢头留尾**，
 * 若缓冲比一条记录还小，最先写进去的 `===== 头部 =====` 会被裁掉，抓包就失去上下文。
 */
const MAX_BUFFER_CHARS = MAX_CAPTURE_CHARS + 256 * 1024;

/** 关闭态的几种写法，避免有人把变量设成 `0` 却以为开了。 */
const OFF_VALUES = new Set(['0', 'off', 'false', 'no', 'null', 'undefined']);

/** 抓包文件路径；未开启返回 ''。 */
function llmRawTapFile() {
  const raw = String(process.env.DIEYUN_LLM_RAW_LOG || '').trim();
  if (!raw || OFF_VALUES.has(raw.toLowerCase())) return '';
  return path.resolve(raw);
}

function llmRawTapEnabled() {
  return !!llmRawTapFile();
}

/**
 * URL 只留 origin + path，丢掉 query。
 * 部分供应商把密钥塞在 query（`?api-key=xxx`），整条 URL 落盘就等于把密钥写了。
 */
function safeUrl(url) {
  try {
    const u = new URL(String(url || ''));
    return `${u.origin}${u.pathname}`;
  } catch {
    return String(url || '');
  }
}

function clipForCapture(text) {
  const s = String(text == null ? '' : text);
  if (s.length <= MAX_CAPTURE_CHARS) return { text: s, truncated: false };
  const head = Math.floor(MAX_CAPTURE_CHARS / 2);
  const tail = MAX_CAPTURE_CHARS - head;
  const omitted = s.length - MAX_CAPTURE_CHARS;
  return {
    text: `${s.slice(0, head)}\n…（中段省略 ${omitted} 字符）…\n${s.slice(-tail)}`,
    truncated: true
  };
}

/**
 * 有界累积流式分片：超限时留「头 + 尾」。
 * 首尾都留是因为要排的那句话既可能在开头（首个 delta），也可能在最后（收尾轮）。
 * @param {number} [limit]
 */
function createRawAccumulator(limit = MAX_CAPTURE_CHARS) {
  const cap = Math.max(1024, Number(limit) || MAX_CAPTURE_CHARS);
  let text = '';
  let droppedChars = 0;
  return {
    push(chunk) {
      const s = String(chunk == null ? '' : chunk);
      if (!s) return;
      text += s;
      // 超出 1.25 倍才裁剪，避免每个分片都做一次 O(cap) 字符串重排
      if (text.length > cap * 1.25) {
        const head = Math.floor(cap / 2);
        const tail = cap - head;
        droppedChars += text.length - cap;
        text = `${text.slice(0, head)}\n…（中段省略 ${text.length - cap} 字符）…\n${text.slice(-tail)}`;
      }
    },
    text() {
      return text;
    },
    droppedChars() {
      return droppedChars;
    }
  };
}

/**
 * 落一条抓包记录。未开启、或任何异常 → 静默 `false`。
 *
 * 记录格式刻意做成「人能直接读」而不是 JSONL：排障时是打开文件搜一句话，
 * 半结构化文本比转义后的 JSON 好搜得多。
 *
 * @param {{ tag?: object, mode?: string, url?: string, raw?: string, note?: string }} entry
 * @returns {boolean} 是否真的写了
 */
function captureLlmRaw(entry = {}) {
  const file = llmRawTapFile();
  if (!file) return false;
  try {
    const log = getRotatingLog(file, {
      maxBytes: MAX_FILE_BYTES,
      maxBufferChars: MAX_BUFFER_CHARS
    });
    if (!log) return false;
    const source = String(entry.raw == null ? '' : entry.raw);
    const { text, truncated } = clipForCapture(source);
    const lines = [
      `\n===== LLM RAW ${new Date().toISOString()} =====`,
      `mode: ${entry.mode || 'unknown'}`,
      `url: ${safeUrl(entry.url)}`,
      `tag: ${JSON.stringify(entry.tag || {})}`,
      `rawChars: ${source.length} truncated: ${truncated}`
    ];
    if (entry.note) lines.push(`note: ${entry.note}`);
    lines.push('--- raw ---', text, '--- end ---', '');
    log.write(lines.join('\n'));
    return true;
  } catch {
    // 抓包是排障手段，不能因为写不出去把 LLM 调用带崩
    return false;
  }
}

module.exports = {
  MAX_CAPTURE_CHARS,
  llmRawTapEnabled,
  llmRawTapFile,
  captureLlmRaw,
  createRawAccumulator,
  safeUrl
};
