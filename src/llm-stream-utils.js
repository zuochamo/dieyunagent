'use strict';
// @ts-check

const { streamChatSse } = require('./llm-proxy');
const { parseCompleteJsonArgs } = require('./llm-tool-call-fallback');
const { buildLlmHeaders } = require('./agent/llm-request');
// SSE 纯解析层抽到 ./agent/sse-delta-parse（零 Node 依赖）：Renderer 经 agent-bundle 复用**同一份**实现，
// 避免 renderer-agent-llm.js 再抄一份 emitParsedSseJson / processSseTextChunk / buildToolCallAccumulator。
const {
  emitParsedSseJson,
  processSseTextChunk,
  flushSseBuffer,
  extractDeltaReasoning,
  buildToolCallAccumulator
} = require('./agent/sse-delta-parse');

/**
 * @param {object|null|undefined} resp
 * @param {{ reasoning?: string, content?: string }|null|undefined} frozen
 */
function mergeMissingReasoning(resp, frozen) {
  if (!resp) return resp;
  const next = { ...resp };
  const frozenReasoning = frozen && String(frozen.reasoning || '').trim();
  const frozenContent = frozen && String(frozen.content || '').trim();
  if (!String(next.reasoning || '').trim() && frozenReasoning) {
    next.reasoning = frozen.reasoning;
    next.reasoningRecovered = true;
  }
  if (
    !String(next.content || '').trim() &&
    frozenContent &&
    !(Array.isArray(next.toolCalls) && next.toolCalls.length)
  ) {
    next.content = frozen.content;
    next.contentRecovered = true;
  }
  return next;
}

/**
 * @param {Error & { partial?: { reasoning?: string, content?: string } }} err
 * @param {{ reasoning?: string, content?: string }|null|undefined} partial
 */
function attachPartialStreamError(err, partial) {
  if (!err || !partial) return err;
  const reasoning = String(partial.reasoning || '').trim();
  const content = String(partial.content || '').trim();
  if (!reasoning && !content) return err;
  err.partial = { reasoning: partial.reasoning || '', content: partial.content || '' };
  return err;
}

/**
 * Main 进程流式 chat completion（单次请求；重试由 rust-loop-runner 的 reconnect 层负责）
 * @param {object} body OpenAI chat body（含 model/messages/tools）
 * @param {{ url?: string, apiKey?: string, headers?: object, signal?: object, onDelta?: Function,
 *   firstTokenTimeoutMs?: number, idleTimeoutMs?: number, tag?: object }} [opts]
 *   `headers`   = 调用方经 llm-request.js 装配好的**完整**请求头（含自定义头 / User-Agent /
 *                 会话标识）；给了就用它，未给（旧调用点）才按 apiKey 兜底生成。
 *   `idleTimeoutMs` = 两包之间的容忍时长（只认真实 SSE data 行），由 agent-limits 注入
 *   `tag`       = 透传给 `llm-raw-tap` 的归属标签（仅 `DIEYUN_LLM_RAW_LOG` 打开时落盘）
 */
async function streamChatCompletionMain(body, opts = {}) {
  const sendBody = { ...body };
  sendBody.stream = true;
  sendBody.stream_options = { ...(sendBody.stream_options || {}), include_usage: true };

  const providedHeaders =
    opts.headers && typeof opts.headers === 'object' && Object.keys(opts.headers).length
      ? opts.headers
      : null;
  const headers = providedHeaders ? { ...providedHeaders } : buildLlmHeaders({ apiKey: opts.apiKey });

  let content = '';
  let reasoning = '';
  let usage = null;
  /** 流里出现的上游错误载荷（见 sse-delta-parse#upstreamStreamErrorMessage） */
  let upstreamError = '';
  const tcAcc = buildToolCallAccumulator();
  let sseBuffer = '';
  let finishReason = '';

  const applyDelta = (delta) => {
    if (!delta) return;
    if (delta._upstreamError) upstreamError = String(delta._upstreamError);
    if (delta.content) content += delta.content;
    const rc = extractDeltaReasoning(delta);
    if (rc) reasoning += rc;
    if (delta._usage) usage = delta._usage;
    if (delta._finishReason) finishReason = String(delta._finishReason);
    tcAcc.apply(delta);
    if (opts.onDelta) {
      opts.onDelta({ content, reasoning, hasToolCalls: false });
    }
  };

  try {
    await streamChatSse(opts.url, {
      headers,
      body: JSON.stringify(sendBody),
      signal: opts.signal,
      firstTokenTimeoutMs: opts.firstTokenTimeoutMs,
      idleTimeoutMs: opts.idleTimeoutMs,
      tag: opts.tag,
      onChunk: (text) => {
        const r = processSseTextChunk(sseBuffer, text, applyDelta);
        sseBuffer = r.buffer;
        if (r.done) sseBuffer = '';
      }
    });
  } catch (err) {
    attachPartialStreamError(/** @type {any} */ (err), { content, reasoning });
    throw err;
  }
  flushSseBuffer(sseBuffer, applyDelta);

  // 上游把错误当正常流回吐（HTTP 200 + `data: {"error":...}`）：必须变成失败。
  // 否则这一轮会以「空回复」收尾，上层只会看到「计划执行完成，无文本摘要」这类空话，
  // 完全没执行的任务被记成成功。已收到的部分内容经 partial 保留，由重连层按既有语义处理。
  if (upstreamError) {
    const err = new Error(`LLM 上游错误：${upstreamError}`);
    attachPartialStreamError(/** @type {any} */ (err), { content, reasoning });
    throw err;
  }

  const toolCallsRaw = tcAcc.flush() || [];
  const toolCalls = [];
  let droppedIncomplete = false;
  for (const tc of toolCallsRaw) {
    const name = tc && tc.function ? tc.function.name : '';
    if (!String(name || '').trim()) {
      droppedIncomplete = true;
      continue;
    }
    const args = parseCompleteJsonArgs(tc.function && tc.function.arguments);
    if (args == null) {
      droppedIncomplete = true;
      continue;
    }
    toolCalls.push({
      id: tc.id,
      name,
      arguments: args
    });
  }

  if (opts.onDelta) {
    opts.onDelta({ content, reasoning, hasToolCalls: toolCalls.length > 0 });
  }

  return {
    content: content.trim(),
    reasoning: reasoning.trim(),
    toolCalls,
    usage,
    finishReason: finishReason || null,
    incompleteJsonToolCalls: droppedIncomplete && toolCalls.length === 0
  };
}

module.exports = {
  streamChatCompletionMain,
  buildToolCallAccumulator,
  mergeMissingReasoning,
  attachPartialStreamError
};
