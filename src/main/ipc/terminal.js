'use strict';

const { createTerminalSession } = require('../../terminal/session');
const { appendTerminalLog, resetTerminalLogTarget } = require('../../agent/terminal-log');

/**
 * @param {object} ctx
 */
function registerTerminalIpc(ctx) {
  const {
    ipcMain,
    getLocalGateway,
    getMainWindow,
    getUserDataPath,
    getTerminalPool,
    getSshSessionManager,
    getSshConnectionPool
  } = ctx;

  /**
   * 主动停止（重启 / 换工作区）不是「异常断线」：先摘挂再杀，渲染端就不会收到假的
   * terminal:exit 提示。真正的断线由 terminalPool.kill → routeExit 上报。
   */
  function stopTerminalSession(sessionId) {
    const terminalPool = getTerminalPool();
    if (!terminalPool) return;
    const key = sessionId ? String(sessionId).trim() : terminalPool.getAttachedSessionId();
    if (!key) return;
    terminalPool.detach(key);
    terminalPool.kill(key);
  }

  /**
   * 终端的工作区只能从「终端自己的会话 id」解析：该会话已绑定的目标优先，未绑定则跟随当前
   * 视图。旧写法读的是网关「当前活动会话」的视图，两者错位时就会在 SSH 工作区里开出本机
   * shell（本机与会话对不上时的另一半：远端路径换了还继续复用旧 shell）。
   * @returns {Promise<{ target: object | null, ws: object | null }>}
   */
  async function resolveTerminalWorkspace(sessionId) {
    const localGateway = getLocalGateway();
    if (!localGateway) return { target: null, ws: null };
    if (typeof localGateway.hydrateSessionWorkspaceContext === 'function') {
      await localGateway.hydrateSessionWorkspaceContext(sessionId);
    }
    const target =
      typeof localGateway.getWorkspaceTarget === 'function'
        ? localGateway.getWorkspaceTarget(sessionId) || null
        : null;
    const ws =
      typeof localGateway.getWorkspace === 'function' ? localGateway.getWorkspace(sessionId) : null;
    return { target, ws };
  }

  function sendTerminalData(sessionId, text) {
    const terminalPool = getTerminalPool();
    const entry = terminalPool ? terminalPool.getEntry(sessionId) : null;
    // 日志落点跟随该终端自己的工作区（会话级 meta），不再看"当前视图"是谁
    appendTerminalLog(text, {
      workspacePath: entry && entry.meta?.kind === 'local' ? entry.meta.path : null,
      userDataPath: getUserDataPath()
    });
    const win = getMainWindow();
    if (win) {
      win.webContents.send('terminal:data', {
        sessionId: sessionId ? String(sessionId) : '',
        data: text
      });
    }
  }

  function sendTerminalExit(sessionId, code) {
    const win = getMainWindow();
    if (win) {
      win.webContents.send('terminal:exit', {
        sessionId: sessionId ? String(sessionId) : '',
        code
      });
    }
  }

  function resolveTerminalSessionId(payload = {}) {
    const localGateway = getLocalGateway();
    const fromPayload = payload.sessionId != null ? String(payload.sessionId).trim() : '';
    if (fromPayload) return fromPayload;
    if (localGateway?.activeSessionId) return String(localGateway.activeSessionId);
    return 'default';
  }

  async function createTerminalHandleForWorkspace(sessionId, ws, target) {
    const terminalPool = getTerminalPool();
    const sshSessionManager = getSshSessionManager();
    const sshConnectionPool = getSshConnectionPool();
    const meta = terminalPool.workspaceMetaFromTarget(
      target || (ws?.kind === 'local' ? { kind: 'local', path: ws.workspacePath } : null)
    );

    if (ws && ws.kind === 'ssh') {
      if (!sshSessionManager || !ws.sshConnected) {
        throw new Error('SSH 未连接，无法启动远程终端');
      }
      const manager =
        target && target.kind === 'ssh' && sshConnectionPool
          ? sshConnectionPool.getManagerForTarget(target) || sshSessionManager
          : sshSessionManager;
      const handle = await manager.openShell({
        cwd: (ws.ssh && ws.ssh.remotePath) || '/',
        onData: (text) => terminalPool.routeData(sessionId, text),
        onExit: (code) => terminalPool.routeExit(sessionId, code)
      });
      return {
        handle,
        meta: {
          ...meta,
          cwd: handle.cwd,
          shell: handle.shell,
          remote: true,
          host: ws.ssh && ws.ssh.host,
          username: ws.ssh && ws.ssh.username
        }
      };
    }

    const handle = createTerminalSession({
      cwd: (target && target.kind === 'local' ? target.path : null) || ws?.workspacePath || undefined,
      onData: (text) => terminalPool.routeData(sessionId, text),
      onExit: (code) => terminalPool.routeExit(sessionId, code)
    });
    return {
      handle,
      meta: {
        ...meta,
        cwd: handle.cwd,
        shell: handle.shell,
        remote: false
      }
    };
  }

  ipcMain.handle('terminal:start', async (_evt, payload = {}) => {
    const terminalPool = getTerminalPool();
    const userData = getUserDataPath();
    if (!terminalPool) throw new Error('终端池未就绪');
    const sessionId = resolveTerminalSessionId(payload);
    const force = payload.force === true;
    const { target, ws } = await resolveTerminalWorkspace(sessionId);

    // 终端必须跟着会话的工作区走：本地 ↔ SSH、远端路径变化都算换了壳，旧 shell 不能复用
    const expectedKey = terminalPool.workspaceMetaFromTarget(target).workspaceKey;
    const existing = terminalPool.getEntry(sessionId);
    if (!force && existing && existing.meta?.workspaceKey === expectedKey) {
      terminalPool.attach(sessionId, {
        onData: (text) => sendTerminalData(sessionId, text),
        onExit: (code) => sendTerminalExit(sessionId, code)
      });
      return {
        ok: true,
        reattached: true,
        sessionId,
        localEcho: !existing.meta?.remote,
        ...existing.meta
      };
    }
    if (existing) stopTerminalSession(sessionId);

    resetTerminalLogTarget(ws && ws.kind === 'local' ? ws.workspacePath : null, userData);
    const { handle, meta } = await createTerminalHandleForWorkspace(sessionId, ws, target);
    terminalPool.register(sessionId, handle, meta);
    terminalPool.attach(sessionId, {
      onData: (text) => sendTerminalData(sessionId, text),
      onExit: (code) => sendTerminalExit(sessionId, code)
    });
    return { ok: true, sessionId, localEcho: !meta.remote, ...meta };
  });

  ipcMain.handle('terminal:detach', (_evt, payload = {}) => {
    const terminalPool = getTerminalPool();
    if (!terminalPool) return { ok: true };
    const sessionId = resolveTerminalSessionId(payload);
    terminalPool.detach(sessionId);
    return { ok: true, sessionId };
  });

  // 池是终端会话的唯一来源：没有条目就是「会话已不在」，必须如实回 ok:false，
  // 让渲染端能提示用户，而不是把输入丢进黑洞还回一个 ok。
  ipcMain.handle('terminal:write', (_evt, { data, sessionId } = {}) => {
    const terminalPool = getTerminalPool();
    const sid = resolveTerminalSessionId({ sessionId });
    if (!terminalPool) return { ok: false, sessionId: sid, reason: 'pool-unavailable' };
    if (!terminalPool.getEntry(sid)) return { ok: false, sessionId: sid, reason: 'no-session' };
    if (terminalPool.getAttachedSessionId() !== sid) {
      terminalPool.attach(sid, {
        onData: (text) => sendTerminalData(sid, text),
        onExit: (code) => sendTerminalExit(sid, code)
      });
    }
    if (!terminalPool.writeForSession(sid, String(data || ''))) {
      return { ok: false, sessionId: sid, reason: 'no-handle' };
    }
    return { ok: true, sessionId: sid, attached: true };
  });

  ipcMain.handle('terminal:stop', (_evt, payload = {}) => {
    const sessionId = payload && payload.sessionId ? String(payload.sessionId).trim() : '';
    stopTerminalSession(sessionId || null);
    return { ok: true };
  });
}

module.exports = { registerTerminalIpc };
