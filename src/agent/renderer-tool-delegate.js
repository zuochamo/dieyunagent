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

/** @type {Map<string, { resolve: Function, timer: NodeJS.Timeout }>} */
const pendingApproval = new Map();

/**
 * 沙箱越界审批：Main → Renderer 弹一次窗，等用户点「允许 / 拒绝」。
 *
 * 与工具委托的区别：这里**没人回话就等于拒绝**（超时 deny）——
 * 默认放行会让整个档位形同虚设。
 *
 * @param {import('electron').WebContents | null | undefined} webContents
 * @param {object} payload
 * @param {number} [timeoutMs]
 */
function requestSandboxApproval(webContents, payload, timeoutMs = 120000) {
  if (!webContents || webContents.isDestroyed()) {
    return Promise.resolve({ granted: false, reason: '没有可用的窗口，默认拒绝' });
  }
  const requestId = String((payload && payload.requestId) || `sbx-${Date.now()}`);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingApproval.delete(requestId);
      // 告诉界面这张卡片已经作废：否则它会一直挂在角上，
      // 用户事后再点「允许」只会让 completeSandboxApproval 返回 false，看起来像"点了没反应"。
      try {
        if (webContents && !webContents.isDestroyed()) {
          webContents.send('agent:sandbox-approval-expired', { requestId });
        }
      } catch {
        // ignore
      }
      resolve({ granted: false, expired: true, reason: '等待确认超时，默认拒绝' });
    }, timeoutMs);
    pendingApproval.set(requestId, {
      resolve: (r) => {
        clearTimeout(timer);
        resolve(r);
      },
      timer
    });
    try {
      webContents.send('agent:sandbox-approval', { ...(payload || {}), requestId });
    } catch (e) {
      clearTimeout(timer);
      pendingApproval.delete(requestId);
      resolve({ granted: false, reason: `弹窗失败：${e && e.message ? e.message : e}` });
    }
  });
}

function completeSandboxApproval(requestId, decision) {
  const entry = pendingApproval.get(String(requestId || ''));
  if (!entry) return false;
  pendingApproval.delete(String(requestId));
  entry.resolve(decision || { granted: false, reason: '空回包' });
  return true;
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
  ipcMain.handle('agent:sandbox-approval-result', (_evt, payload = {}) => {
    const requestId = String(payload.requestId || '');
    return { ok: completeSandboxApproval(requestId, payload.decision) };
  });
}

module.exports = {
  RENDERER_ONLY_TOOLS,
  isRendererOnlyTool,
  requestToolFromRenderer,
  requestSandboxApproval,
  registerRendererToolDelegateIpc
};
