'use strict';

const { RENDERER_ONLY_TOOLS: RENDERER_ONLY_TOOL_LIST } = require('./tool-catalog');

/** @type {Map<string, { resolve: Function, reject: Function, timer: NodeJS.Timeout }>} */
const pending = new Map();

const RENDERER_ONLY_TOOLS = new Set(RENDERER_ONLY_TOOL_LIST);

function isRendererOnlyTool(name) {
  return RENDERER_ONLY_TOOLS.has(String(name || ''));
}

/**
 * @param {import('electron').WebContents | null | undefined} webContents
 * @param {string} name
 * @param {object} args
 * @param {number} [timeoutMs]
 * @param {{ sessionId?: string }} [opts]
 */
function requestToolFromRenderer(webContents, name, args, timeoutMs = 120000, opts = {}) {
  if (!webContents || webContents.isDestroyed()) {
    return Promise.reject(new Error('Renderer 不可用，无法执行 UI 工具'));
  }
  const requestId = `td-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(requestId);
      reject(new Error(`工具 ${name} 等待 Renderer 超时`));
    }, timeoutMs);
    pending.set(requestId, {
      resolve: (r) => {
        clearTimeout(timer);
        resolve(r);
      },
      reject: (e) => {
        clearTimeout(timer);
        reject(e);
      },
      timer
    });
    try {
      webContents.send('agent:main-tool-delegate', {
        requestId,
        name,
        args: args || {},
        sessionId: opts.sessionId ? String(opts.sessionId) : undefined
      });
    } catch (e) {
      clearTimeout(timer);
      pending.delete(requestId);
      reject(e);
    }
  });
}

function completeRendererToolDelegate(requestId, result) {
  const entry = pending.get(String(requestId || ''));
  if (!entry) return false;
  pending.delete(String(requestId));
  entry.resolve(result);
  return true;
}

function failRendererToolDelegate(requestId, error) {
  const entry = pending.get(String(requestId || ''));
  if (!entry) return false;
  pending.delete(String(requestId));
  entry.reject(error instanceof Error ? error : new Error(String(error || 'delegate failed')));
  return true;
}

/** @type {Map<string, { resolve: Function, reject: Function, timer: NodeJS.Timeout }>} */
const pendingArbitration = new Map();

function requestPlannerArbitration(webContents, payload, timeoutMs = 300000) {
  if (!webContents || webContents.isDestroyed()) {
    return Promise.resolve({ action: 'retry', note: 'auto-no-renderer' });
  }
  const requestId = `arb-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingArbitration.delete(requestId);
      resolve({ action: 'retry', note: 'timeout-auto-retry' });
    }, timeoutMs);
    pendingArbitration.set(requestId, {
      resolve: (r) => {
        clearTimeout(timer);
        resolve(r);
      },
      reject: (e) => {
        clearTimeout(timer);
        reject(e);
      },
      timer
    });
    try {
      webContents.send('agent:planner-arbitrate', { requestId, ...(payload || {}) });
    } catch (e) {
      clearTimeout(timer);
      pendingArbitration.delete(requestId);
      reject(e);
    }
  });
}

function registerRendererToolDelegateIpc(ipcMain) {
  ipcMain.handle('agent:main-tool-delegate-result', (_evt, payload = {}) => {
    const requestId = String(payload.requestId || '');
    if (payload.error) {
      failRendererToolDelegate(requestId, payload.error);
      return { ok: true };
    }
    completeRendererToolDelegate(requestId, payload.result);
    return { ok: true };
  });
  ipcMain.handle('agent:planner-arbitrate-result', (_evt, payload = {}) => {
    const requestId = String(payload.requestId || '');
    const entry = pendingArbitration.get(requestId);
    if (!entry) return { ok: false };
    pendingArbitration.delete(requestId);
    if (payload.error) {
      entry.reject(payload.error);
    } else {
      entry.resolve(payload.decision || { action: 'fail' });
    }
    return { ok: true };
  });
}

module.exports = {
  RENDERER_ONLY_TOOLS,
  isRendererOnlyTool,
  requestToolFromRenderer,
  requestPlannerArbitration,
  registerRendererToolDelegateIpc
};
