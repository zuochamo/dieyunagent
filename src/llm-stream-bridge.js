'use strict';

/**
 * Renderer 的 LLM IPC 通路 —— **只做转发，不发 HTTP**。
 *
 * 请求的发出、SSE 解析、usage、抓包都在 core（RPC `llm.complete`，见 docs/LLM-RPC.md）；
 * 本文件只做三件事：
 *   1. 把渲染层给来的 `url` / `headers` / `body` 原样递给 core；
 *   2. 把 core 推来的增量（事件 `agent.delta`，按本次生成的 `runId` 过滤）转成 IPC 事件；
 *   3. 把 core 的结果按宿主约定形状回给渲染层。
 *
 * 为什么不留一份自己的 HTTP 客户端：`llm-proxy.js` / `llm-stream-utils.js` 曾在这里维护
 * 第二份端点、超时、SSE 解析与错误分类，与 core 的 `agent/llm.rs` 各改一处就漂移
 * （历史上出现过「对话正常、压缩一跑就 400」）。现在 Node 侧**没有** HTTP 客户端。
 *
 * abort：core 没有取消 RPC（为一次性调用新增一条取消协议是加法）。宿主侧的做法是
 * **退订 + 不再转发**，并让 `completeOnce` 立刻以 AbortError 返回，core 那次请求自己跑完就丢。
 */

const { completeOnce, currentLlmCompleteBridge } = require('./agent/llm-complete');
const { sanitizeChatBodyImagesForApi } = require('./agent/guardrails-shared');
const { isAbortError } = require('./llm-reconnect-retry');

/** @type {Map<string, { abort: () => void }>} */
const active = new Map();

function createAbortSignal() {
  const listeners = [];
  let aborted = false;
  return {
    get aborted() {
      return aborted;
    },
    abort() {
      if (aborted) return;
      aborted = true;
      for (const fn of listeners) {
        try {
          fn();
        } catch {
          // ignore
        }
      }
    },
    addEventListener(_type, fn, opts) {
      if (aborted && opts && opts.once) {
        fn();
        return;
      }
      listeners.push(fn);
    },
    removeEventListener(_type, fn) {
      const i = listeners.indexOf(fn);
      if (i >= 0) listeners.splice(i, 1);
    }
  };
}

function abortStream(streamId) {
  const entry = active.get(streamId);
  if (entry) entry.abort();
}

/** 装配错误就直说：没有 core 桥时这条 IPC 无法工作，不当成「网络失败」糊过去。 */
function requireCoreBridge() {
  const bridge = currentLlmCompleteBridge();
  if (!bridge || typeof bridge.invoke !== 'function') {
    throw new Error('LLM 请求只能由 core 发：入口应先 setLlmCompleteBridge(coreBridge)');
  }
  return bridge;
}

/**
 * IPC 契约里的 `body` 是渲染层拼好的 OpenAI 请求体（JSON 字符串），core 要的是对象。
 * 解析失败直接抛：把坏 body 送给 core 只会得到一条更难读的上游 400。
 *
 * 出站图片最后一道闸（单一来源 `agent/guardrails-shared`）随 `llm-proxy` 一起搬到这里：
 * 历史账本里残留的 bmp/svg/heic 或坏 base64 会让上游以 400 "unsupported image" 打回整轮请求。
 */
function parseBody(raw) {
  let body;
  if (raw && typeof raw === 'object') {
    body = raw;
  } else {
    const text = String(raw || '').trim();
    if (!text) return {};
    try {
      body = JSON.parse(text);
    } catch (e) {
      throw new Error(`LLM 请求体不是合法 JSON：${String((e && e.message) || e)}`);
    }
  }
  sanitizeChatBodyImagesForApi(body);
  return body;
}

/** runId 由宿主生成（core 在 invoke 返回之前就开始推增量，等返回值再订阅必丢第一段）。 */
function newRunId(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * @param {import('electron').WebContents} webContents
 * @param {{ channel: string, streamId: string, url: string, headers: object, body: string }} payload
 */
async function runStreamChat(webContents, payload) {
  const streamId = String(payload.streamId || '');
  const channel = String(payload.channel || '');
  if (!streamId || !channel) throw new Error('streamId/channel 必填');

  const bridge = requireCoreBridge();
  const runId = newRunId('llm-stream');
  const signal = createAbortSignal();
  const body = parseBody(payload.body);
  active.set(streamId, { abort: () => signal.abort() });

  const send = (msg) => {
    // 已 abort：退订之外再挡一道，避免停止后还有一段增量落到 UI 上。
    if (signal.aborted) return;
    if (webContents.isDestroyed()) return;
    try {
      webContents.send(channel, msg);
    } catch {
      // ignore
    }
  };

  // 订阅必须在发请求**之前**：core 在第一条增量到达时就开始推 `agent.delta`，
  // 晚一步订阅第一段必然丢（与 rust-loop-runner 的 runId 约定同一条事件通道）。
  const detach =
    typeof bridge.onCoreEvent === 'function'
      ? bridge.onCoreEvent((event) => {
          if (!event || event.type !== 'agent.delta') return;
          if (String(event.runId || '') !== runId) return;
          send({ type: 'delta', content: event.content || '', reasoning: event.reasoning || '' });
        })
      : () => {};

  try {
    const result = await completeOnce({
      coreBridge: bridge,
      url: String(payload.url || ''),
      llm: { headers: payload.headers || {} },
      body,
      stream: true,
      runId,
      signal
    });
    send({ type: 'done', result });
    return { ok: true, result };
  } catch (err) {
    if (isAbortError(err)) {
      send({ type: 'error', message: 'aborted', code: 'ABORT_ERR' });
      return { ok: false, aborted: true };
    }
    send({ type: 'error', message: err.message || String(err), code: err.code || '', statusCode: err.statusCode || 0 });
    return { ok: false, error: err.message || String(err) };
  } finally {
    detach();
    active.delete(streamId);
  }
}

/**
 * 非流式一次调用。返回 core 归一后的结果（`{ content, reasoning, toolCalls, finishReason,
 * usage, model }`）—— 不再把 core 的结果包成假的 OpenAI `choices` 信封：core 是唯一解析者，
 * 上游原始 JSON 只在 core 内部存在，宿主侧再造一份「看起来像上游」的形状就是第二份表示。
 */
async function runChatCompletion(payload) {
  const id = String(payload.requestId || '');
  const bridge = requireCoreBridge();
  const signal = createAbortSignal();
  const body = parseBody(payload.body);
  if (id) active.set(id, { abort: () => signal.abort() });
  try {
    const result = await completeOnce({
      coreBridge: bridge,
      url: String(payload.url || ''),
      llm: { headers: payload.headers || {} },
      body,
      signal
    });
    return { ok: true, result };
  } catch (err) {
    if (isAbortError(err)) {
      return { ok: false, aborted: true, error: err.message || 'aborted' };
    }
    return { ok: false, error: err.message || String(err) };
  } finally {
    if (id) active.delete(id);
  }
}

function registerLlmIpc(ipcMain) {
  ipcMain.handle('llm:stream-chat', async (event, payload) => {
    return runStreamChat(event.sender, payload || {});
  });
  ipcMain.handle('llm:stream-abort', (_evt, { streamId }) => {
    abortStream(String(streamId || ''));
    return { ok: true };
  });
  ipcMain.handle('llm:chat-completion', async (_evt, payload) => {
    return runChatCompletion(payload || {});
  });
  ipcMain.handle('llm:chat-completion-abort', (_evt, { requestId }) => {
    abortStream(String(requestId || ''));
    return { ok: true };
  });
}

module.exports = {
  registerLlmIpc
};
