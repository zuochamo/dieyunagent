'use strict';
// @ts-check

const { streamChatSse } = require('./llm-proxy');
const { parseCompleteJsonArgs } = require('./llm-tool-call-fallback');

function extractDeltaReasoning(delta) {
  if (!delta || typeof delta !== 'object') return '';
  for (const key of ['reasoning_content', 'reasoning', 'thinking']) {
    const text = delta[key];
    if (typeof text === 'string' && text) return text;
  }
  return '';
}

function emitParsedSseJson(json, emit) {
  if (!json || typeof emit !== 'function') return;
  const choice = json?.choices?.[0];
  const delta = choice?.delta;
  if (delta) {
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
      if (json.usage) merged._usage = json.usage;
      emit(merged);
    } else if (json?.usage) {
      emit({ _usage: json.usage });
    }
    return;
  }
  if (json?.usage) emit({ _usage: json.usage });
}

function processSseLineTrimmed(trimmed, emit) {
  if (!trimmed || !trimmed.startsWith('data:')) return null;
  const json = trimmed.slice(5).trim();
  if (!json) return null;
  if (json === '[DONE]') return 'done';
  try {
    emitParsedSseJson(JSON.parse(json), emit);
  } catch {
    // ignore
  }
  return null;
}

function processSseTextChunk(buffer, text, emit) {
  let buf = buffer + String(text || '');
  const lines = buf.split(/\r?\n/);
  buf = lines.pop() || '';
  for (const line of lines) {
    if (processSseLineTrimmed(line.trim(), emit) === 'done') return { buffer: '', done: true };
  }
  return { buffer: buf, done: false };
}

function flushSseBuffer(buffer, emit) {
  const tail = String(buffer || '').trim();
  if (!tail.startsWith('data:')) return;
  processSseLineTrimmed(tail, emit);
}

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

function buildToolCallAccumulator() {
  const byIndex = new Map();
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

/**
 * Main 进程流式 chat completion（单次请求；重试由 rust-loop-runner 的 reconnect 层负责）
 * @param {object} body OpenAI chat body（含 model/messages/tools）
 * @param {{ url?: string, apiKey?: string, signal?: object, onDelta?: Function, firstTokenTimeoutMs?: number,
 *   idleTimeoutMs?: number }} [opts]
 *   `idleTimeoutMs` = 两包之间的容忍时长（只认真实 SSE data 行），由 agent-limits 注入
 */
async function streamChatCompletionMain(body, opts = {}) {
  const sendBody = { ...body };
  sendBody.stream = true;
  sendBody.stream_options = { ...(sendBody.stream_options || {}), include_usage: true };

  const headers = { 'Content-Type': 'application/json' };
  if (opts.apiKey) headers.Authorization = `Bearer ${opts.apiKey}`;

  let content = '';
  let reasoning = '';
  let usage = null;
  const tcAcc = buildToolCallAccumulator();
  let sseBuffer = '';
  let finishReason = '';

  const applyDelta = (delta) => {
    if (!delta) return;
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
