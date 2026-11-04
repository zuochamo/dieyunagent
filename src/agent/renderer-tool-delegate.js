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
    // 带 errorCode：「没有界面可以问」（headless / 窗口已销毁）与「工具自己失败」必须能区分，
    // 否则手机端 / Web 端只能把一句中文原样贴给用户。
    const e = new Error('Renderer 不可用，无法执行 UI 工具');
    e.code = 'RENDERER_UNAVAILABLE';
    return Promise.reject(e);
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
 * 迟到的决定去哪儿：由 Main 注入 `gateway.applyLateSandboxApproval`。
 * 没注入时迟到按钮只能报「已过期」，绝不静默 —— 静默正是以前那个 bug。
 */
let lateApprovalHandler = null;

function setLateSandboxApprovalHandler(fn) {
  lateApprovalHandler = typeof fn === 'function' ? fn : null;
}

/**
 * 沙箱越界审批：Main → Renderer 弹一次窗，等用户点「允许 / 拒绝」。
 *
 * 与工具委托的区别：这里**没人回话就等于拒绝**（超时 deny）——
 * 默认放行会让整个档位形同虚设。
 *
 * 超时**不再作废界面上的卡片**：人可能离开 20 分钟，回来点「允许」仍然有意义
 * （批准记的是「本会话在这个位置允许这类操作」，不是「重试刚才那条命令」）。
 * 那次工具调用本身确实已经失败，所以迟到的批准只落 grant，由 `lateApprovalHandler` 收口。
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
      // 只结束「等回包」这件事，卡片留在界面上让用户还能点（点了会走迟到路径）。
      pendingApproval.delete(requestId);
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

/**
 * 界面回包。返回 `delivered`：
 * - `live`：还在等回包的那次工具调用，直接把决定交给它；
 * - `late`：那次调用早已超时结束，把批准记进本会话的 grant（`granted` 表示是否记住）；
 * - `none`：没有可落 grant 的通道，只能告诉用户已过期（**绝不静默返回 false**）。
 *
 * @param {string} requestId
 * @param {{ granted?: boolean, reason?: string }} [decision]
 * @returns {{ ok: boolean, delivered: 'live'|'late'|'none', expired?: boolean, granted?: boolean, reason?: string }}
 */
function completeSandboxApproval(requestId, decision) {
  const id = String(requestId || '');
  const entry = pendingApproval.get(id);
  if (entry) {
    pendingApproval.delete(id);
    entry.resolve(decision || { granted: false, reason: '空回包' });
    return { ok: true, delivered: 'live', granted: !!(decision && decision.granted === true) };
  }
  if (!lateApprovalHandler) {
    return {
      ok: false,
      delivered: 'none',
      expired: true,
      reason: '该确认已过期，且当前没有可记录的审批通道，请重新让 Agent 执行'
    };
  }
  const r = lateApprovalHandler(id, decision || {}) || {};
  return {
    ok: r.ok !== false,
    delivered: 'late',
    expired: r.expired === true,
    granted: r.granted === true,
    reason: r.reason || ''
  };
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
    // 结果原样回给界面：`delivered:'late'` 时界面要告诉用户「批准已记住 / 已过期」，
    // 不能再像以前那样返回一个 false 让按钮变成哑的。
    return completeSandboxApproval(requestId, payload.decision);
  });
}

module.exports = {
  RENDERER_ONLY_TOOLS,
  isRendererOnlyTool,
  requestToolFromRenderer,
  requestSandboxApproval,
  completeSandboxApproval,
  setLateSandboxApprovalHandler,
  registerRendererToolDelegateIpc
};
