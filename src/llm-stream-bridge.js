'use strict';

const { streamChatSse, chatCompletionJson, isAbortError } = require('./llm-proxy');

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

/**
 * @param {import('electron').WebContents} webContents
 * @param {{ channel: string, streamId: string, url: string, headers: object, body: string }} payload
 */
async function runStreamChat(webContents, payload) {
  const streamId = String(payload.streamId || '');
  const channel = String(payload.channel || '');
  if (!streamId || !channel) throw new Error('streamId/channel 必填');

  const signal = createAbortSignal();
  active.set(streamId, { abort: () => signal.abort() });

  const send = (msg) => {
    if (webContents.isDestroyed()) return;
    try {
      webContents.send(channel, msg);
    } catch {
      // ignore
    }
  };

  try {
    await streamChatSse(payload.url, {
      headers: payload.headers || {},
      body: payload.body || '',
      signal,
      onChunk: (text) => send({ type: 'raw', text })
    });
    send({ type: 'done' });
    return { ok: true };
  } catch (err) {
    if (isAbortError(err)) {
      send({ type: 'error', message: 'aborted', code: 'ABORT_ERR' });
      return { ok: false, aborted: true };
    }
    send({ type: 'error', message: err.message || String(err), code: err.code || '', statusCode: err.statusCode || 0 });
    return { ok: false, error: err.message || String(err) };
  } finally {
    active.delete(streamId);
  }
}

async function runChatCompletion(payload) {
  const signal = createAbortSignal();
  const id = String(payload.requestId || '');
  if (id) active.set(id, { abort: () => signal.abort() });
  try {
    const json = await chatCompletionJson(payload.url, {
      headers: payload.headers || {},
      body: payload.body || '',
      signal
    });
    return { ok: true, json };
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
  registerLlmIpc,
  abortStream
};
