'use strict';
// @ts-check

/**
 * SSE 增量解析的**唯一来源**（Main 与 Renderer 共用）。
 *
 * 为什么单独成模块：解析器本身是纯函数，但 `src/llm-stream-utils.js` 顶部
 * `require('./llm-proxy')`（Node http/https）——Renderer 无法直接 require 它。
 * 于是把纯解析层抽到这里：
 *   - Main：`src/llm-stream-utils.js` 直接 require，仍由它提供 `streamChatCompletionMain`；
 *   - Renderer：经 `src/renderer/agent/agent-bundle-entry.js` 注册为 `window.SseDeltaParse`，
 *     `renderer-agent-llm.js` 消费同一份实现（同源复用先例：`llm-request` / `llm-channel`）。
 *
 * 这样「上游 JSON → 带字段的 delta」只实现一次，两侧行为天然一致；
 * 渲染器特有的乱码修复不进本模块，改由 `opts.repairText` 注入（见下）。
 */

const { REASONING_KEY_CANDIDATES } = require('./llm-channel');

/**
 * 从 delta 里取思考文本（第一个非空的候选键）。
 * 键序与 `llm-channel` 的候选表同源 —— 勿在此另起一份键名列表。
 *
 * @param {object|null|undefined} delta
 * @returns {string}
 */
function extractDeltaReasoning(delta) {
  if (!delta || typeof delta !== 'object') return '';
  for (const key of REASONING_KEY_CANDIDATES) {
    const text = delta[key];
    if (typeof text === 'string' && text) return text;
  }
  return '';
}

/**
 * 对 delta 内的所有文本字段做**注入式**修复。
 * Renderer 用它修复主进程透传 SSE 文本时的单字节/UTF-8 损坏；Main 不传 `repairText` 时整体跳过。
 *
 * 字段名（含思考键候选）由此处统一决定，调用方只需提供 `(s: string) => string`。
 *
 * @param {object} delta
 * @param {((text: string) => string)|null|undefined} repairText
 * @returns {object}
 */
function repairDeltaTextFields(delta, repairText) {
  if (!delta || typeof delta !== 'object' || typeof repairText !== 'function') return delta;
  if (typeof delta.content === 'string') delta.content = repairText(delta.content);
  for (const key of REASONING_KEY_CANDIDATES) {
    if (typeof delta[key] === 'string') delta[key] = repairText(delta[key]);
  }
  for (const tc of delta.tool_calls || []) {
    if (tc && tc.function) {
      if (typeof tc.function.name === 'string') tc.function.name = repairText(tc.function.name);
      if (typeof tc.function.arguments === 'string') {
        tc.function.arguments = repairText(tc.function.arguments);
      }
    }
  }
  return delta;
}

/**
 * 上游把错误装进「正常响应」时的载荷识别（**唯一来源**）。
 *
 * 为什么必须有：OpenAI 兼容中转普遍在 HTTP 200 里回吐上游错误 ——
 * 流式是 `data: {"error": {...}}`（如叠云中转把 opencode 的 Go 额度用尽原样下发），
 * 非流式是 `{"error": {...}}`。这类响应**既无 content 也无 tool_calls**，
 * 若当成「正常空回复」，上层就会把「额度用尽」交付成一句空话 ——
 * 定时任务曾因此把一次完全没执行的巡检记成 `lastRunOk: true`。
 *
 * 判据只认结构性字段（`error` 键 / `type: "error"`），不做文案正则。
 *
 * @param {any} json
 * @returns {string} 错误文案；非错误载荷返回 ''
 */
function upstreamStreamErrorMessage(json) {
  if (!json || typeof json !== 'object') return '';
  const err = json.error;
  if (!err && json.type !== 'error') return '';
  if (typeof err === 'string') return err.trim();
  if (err && typeof err === 'object') {
    const text = err.message || err.code || err.type;
    if (typeof text === 'string' && text.trim()) return text.trim();
  }
  if (typeof json.message === 'string' && json.message.trim()) return json.message.trim();
  return '上游返回错误但未给出信息';
}

/**
 * 把一条已解析的 SSE JSON 翻译成 delta 交给 emit（流式走 `delta`，非流式走 `message`）。
 *
 * @param {any} json
 * @param {(delta: object) => void} emit
 * @param {{ repairText?: (text: string) => string }} [opts]
 */
function emitParsedSseJson(json, emit, opts) {
  if (!json || typeof emit !== 'function') return;
  // 流级元信息（与 `_usage` / `_finishReason` 同一条通道）：上游错误随 delta 交给消费方，
  // 由消费方决定「抛错」还是「忽略」——本层保持纯解析、不抛异常（否则会被坏行 try 吞掉）。
  const upstreamError = upstreamStreamErrorMessage(json);
  if (upstreamError) {
    emit({ _upstreamError: upstreamError });
    return;
  }
  const repairText = opts && opts.repairText;
  const choice = json?.choices?.[0];
  const delta = choice?.delta;
  if (delta) {
    repairDeltaTextFields(delta, repairText);
    if (json.usage) delta._usage = json.usage;
    if (choice.finish_reason) delta._finishReason = choice.finish_reason;
    emit(delta);
    return;
  }
  if (choice?.message) {
    const msg = choice.message;
    const merged = {
      content: typeof msg.content === 'string' ? msg.content : '',
      reasoning_content:
        typeof msg.reasoning_content === 'string' ? msg.reasoning_content : extractDeltaReasoning(msg)
    };
    if (Array.isArray(msg.tool_calls) && msg.tool_calls.length) merged.tool_calls = msg.tool_calls;
    if (merged.content || merged.reasoning_content || merged.tool_calls) {
      repairDeltaTextFields(merged, repairText);
      if (json.usage) merged._usage = json.usage;
      emit(merged);
    } else if (json?.usage) {
      emit({ _usage: json.usage });
    }
    return;
  }
  if (json?.usage) emit({ _usage: json.usage });
}

/**
 * @param {string} trimmed
 * @param {(delta: object) => void} emit
 * @param {{ repairText?: (text: string) => string }} [opts]
 * @returns {'done'|null}
 */
function processSseLineTrimmed(trimmed, emit, opts) {
  if (!trimmed || !trimmed.startsWith('data:')) return null;
  const json = trimmed.slice(5).trim();
  if (!json) return null;
  if (json === '[DONE]') return 'done';
  try {
    emitParsedSseJson(JSON.parse(json), emit, opts);
  } catch {
    // 忽略坏行
  }
  return null;
}

/**
 * 消费一段 SSE 文本，返回剩余半行与是否已收到 `[DONE]`。
 *
 * @param {string} buffer
 * @param {string} text
 * @param {(delta: object) => void} emit
 * @param {{ repairText?: (text: string) => string }} [opts]
 * @returns {{ buffer: string, done: boolean }}
 */
function processSseTextChunk(buffer, text, emit, opts) {
  let buf = buffer + String(text || '');
  const lines = buf.split(/\r?\n/);
  buf = lines.pop() || '';
  for (const line of lines) {
    if (processSseLineTrimmed(line.trim(), emit, opts) === 'done') return { buffer: '', done: true };
  }
  return { buffer: buf, done: false };
}

/**
 * 流结束：把残留的半行（未以换行结尾的最后一条 data）也解析掉。
 *
 * @param {string} buffer
 * @param {(delta: object) => void} emit
 * @param {{ repairText?: (text: string) => string }} [opts]
 */
function flushSseBuffer(buffer, emit, opts) {
  const tail = String(buffer || '').trim();
  if (!tail.startsWith('data:')) return;
  processSseLineTrimmed(tail, emit, opts);
}

/**
 * tool_call deltas 是分片到达的，按 index 累积合并；流结束后 `flush()` 返回完整 tool_calls。
 */
function buildToolCallAccumulator() {
  const byIndex = new Map();
  /**
   * @param {object} delta
   */
  function apply(delta) {
    const calls = delta.tool_calls;
    if (!calls || !calls.length) return;
    calls.forEach((tc, callIdx) => {
      const idx = String(tc.index != null ? tc.index : callIdx);
      let acc = byIndex.get(idx);
      if (!acc) {
        acc = { id: tc.id || '', type: tc.type || 'function', function: { name: '', arguments: '' } };
        byIndex.set(idx, acc);
      }
      if (tc.id) acc.id = tc.id;
      if (tc.type) acc.type = tc.type;
      if (tc.function) {
        if (tc.function.name) acc.function.name += tc.function.name;
        if (tc.function.arguments != null && tc.function.arguments !== '') {
          const chunk = tc.function.arguments;
          if (typeof chunk === 'object') {
            acc.function.arguments = chunk;
          } else if (typeof acc.function.arguments === 'object') {
            acc.function.arguments = JSON.stringify(acc.function.arguments) + String(chunk);
          } else {
            acc.function.arguments += chunk;
          }
        }
      }
    });
  }
  function flush() {
    const out = [];
    for (const [, acc] of [...byIndex.entries()].sort((a, b) => Number(a[0]) - Number(b[0]))) {
      if (!String(acc.function?.name || '').trim()) continue;
      out.push({ ...acc, type: acc.type || 'function' });
    }
    return out.length ? out : null;
  }
  return { apply, flush };
}

module.exports = {
  extractDeltaReasoning,
  upstreamStreamErrorMessage,
  emitParsedSseJson,
  processSseLineTrimmed,
  processSseTextChunk,
  flushSseBuffer,
  buildToolCallAccumulator
};
