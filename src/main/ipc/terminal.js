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
    getTerminalSession,
    setTerminalSession,
    getSshSessionManager,
    getSshConnectionPool
  } = ctx;

  function stopTerminalSession(sessionId) {
    const terminalPool = getTerminalPool();
    if (terminalPool) {
      if (sessionId) terminalPool.kill(String(sessionId));
      else if (terminalPool.getAttachedSessionId()) terminalPool.kill(terminalPool.getAttachedSessionId());
      return;
    }
    const terminalSession = getTerminalSession();
    if (terminalSession) {
      try {
        terminalSession.kill();
      } catch {
        // ignore
      }
      setTerminalSession(null);
    }
  }

  function sendTerminalData(sessionId, text) {
    const localGateway = getLocalGateway();
    const userData = getUserDataPath();
    const ws = localGateway ? localGateway.getWorkspace() : null;
    appendTerminalLog(text, {
      workspacePath: ws && ws.kind === 'local' ? ws.workspacePath : null,
      userDataPath: userData
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

  async function createTerminalHandleForWorkspace(sessionId, ws, cwd) {
    const localGateway = getLocalGateway();
    const terminalPool = getTerminalPool();
    const sshSessionManager = getSshSessionManager();
    const sshConnectionPool = getSshConnectionPool();
    const target = localGateway?.getEffectiveWorkspaceTarget?.() || null;
    const meta = terminalPool.workspaceMetaFromTarget(
      target ||
        (ws?.kind === 'local' ? { kind: 'local', path: cwd || ws.workspacePath } : null)
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
      cwd: cwd || undefined,
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
    const localGateway = getLocalGateway();
    const userData = getUserDataPath();
    if (!terminalPool) throw new Error('终端池未就绪');
    const sessionId = resolveTerminalSessionId(payload);
    const force = payload.force === true;
    const ws = localGateway ? localGateway.getWorkspace() : null;
    resetTerminalLogTarget(ws && ws.kind === 'local' ? ws.workspacePath : null, userData);

    const existing = terminalPool.getEntry(sessionId);
    if (!force && existing) {
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

    if (force && existing) terminalPool.kill(sessionId);

    const cwd = payload.cwd;
    const { handle, meta } = await createTerminalHandleForWorkspace(sessionId, ws, cwd);
    terminalPool.register(sessionId, handle, meta);
    terminalPool.attach(sessionId, {
      onData: (text) => sendTerminalData(sessionId, text),
      onExit: (code) => sendTerminalExit(sessionId, code)
    });
    setTerminalSession(handle);
    return { ok: true, sessionId, localEcho: !meta.remote, ...meta };
  });

  ipcMain.handle('terminal:detach', (_evt, payload = {}) => {
    const terminalPool = getTerminalPool();
    if (!terminalPool) return { ok: true };
    const sessionId = resolveTerminalSessionId(payload);
    terminalPool.detach(sessionId);
    if (getTerminalSession()) setTerminalSession(null);
    return { ok: true, sessionId };
  });

  ipcMain.handle('terminal:write', (_evt, { data, sessionId } = {}) => {
    const terminalPool = getTerminalPool();
    const sid = resolveTerminalSessionId({ sessionId });
    if (terminalPool) {
      const entry = terminalPool.getEntry(sid);
      if (entry && terminalPool.getAttachedSessionId() !== sid) {
        terminalPool.attach(sid, {
          onData: (text) => sendTerminalData(sid, text),
          onExit: (code) => sendTerminalExit(sid, code)
        });
      }
      if (terminalPool.writeForSession(sid, String(data || ''))) {
        return { ok: true, sessionId: sid, attached: true };
      }
    }
    const terminalSession = getTerminalSession();
    if (terminalSession) {
      terminalSession.write(String(data || ''));
      return { ok: true, sessionId: sid, attached: true };
    }
    return { ok: false, sessionId: sid, attached: false };
  });

  ipcMain.handle('terminal:stop', (_evt, payload = {}) => {
    const sessionId = payload && payload.sessionId ? String(payload.sessionId).trim() : '';
    stopTerminalSession(sessionId || null);
    return { ok: true };
  });
}

module.exports = { registerTerminalIpc };
