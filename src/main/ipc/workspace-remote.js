'use strict';

const fs = require('fs');

/**
 * Workspace and SSH IPC (live getters — do not capture stale nulls).
 * @param {object} ctx
 */
function registerWorkspaceRemoteIpc(ctx) {
  const {
    ipcMain,
    log,
    getLocalGateway,
    getBrowserService,
    getSessionRemoteTransport,
    getUserDataPath,
    ensureAgentHomeDirs,
    tryReconnectCurrentSshWorkspace,
    getSshSessionManager,
    getSshCredentialsStore,
    getSshConnectionPool,
    getRemoteGatewayPool,
    getPortForwardManager,
    resolveSshConnectSessionStatus,
    getActiveRemoteGatewayStatus,
    getActiveRemoteGatewayInfo,
    getRemoteGatewayPackRoot,
    invalidateRemoteAgentClient,
    ensureRemoteGatewayForCurrentWorkspace,
    suppressSshReconnect
  } = ctx;

  ipcMain.handle('workspace:set-active-session', async (_evt, { sessionId, workspacePath, bindOnly, skipRemoteTransport } = {}) => {
    const localGateway = getLocalGateway();
    const browserService = getBrowserService();
    const sessionRemoteTransport = getSessionRemoteTransport();
    if (!localGateway) {
      return { kind: 'local', workspacePath: null, displayPath: '', sshConnected: false };
    }
    const sid = sessionId ? String(sessionId).trim() : '';
    if (sid && workspacePath !== undefined) {
      localGateway.setSessionWorkspaceContext(sid, workspacePath || null);
    } else if (sid && !localGateway.sessionWorkspaceTargets.has(sid)) {
      try {
        const row = await localGateway.invokeRpc('memory.session_get', { sessionId: sid });
        if (row && row.workspacePath) {
          localGateway.setSessionWorkspaceContext(sid, row.workspacePath);
        }
      } catch (e) {
        log.info('workspace:set-active-session session_get:', e && e.message);
      }
    }
    if (bindOnly) {
      return { ok: true, bindOnly: true, sessionId: sid || null };
    }
    localGateway.setActiveSession(sid || null);
    if (browserService && typeof browserService.setActiveViewSessionId === 'function' && sid) {
      browserService.setActiveViewSessionId(sid);
    }
    if (!skipRemoteTransport && sessionRemoteTransport && sid) {
      try {
        await sessionRemoteTransport.applySessionRemoteTransport(sid);
      } catch (e) {
        log.info('applySessionRemoteTransport:', e && e.message);
      }
    }
    return localGateway.getWorkspace();
  });

  ipcMain.handle('remote:session-lease', async (_evt, { sessionId, active, workspacePath } = {}) => {
    const localGateway = getLocalGateway();
    const sessionRemoteTransport = getSessionRemoteTransport();
    if (sessionRemoteTransport) {
      const { parseWorkspaceInput } = require('../../workspace/target');
      const sid = sessionId ? String(sessionId).trim() : '';
      let target = workspacePath ? parseWorkspaceInput(workspacePath) : null;
      if (!target && sid && localGateway) {
        target = localGateway.getSessionWorkspaceTarget(sid);
      }
      await sessionRemoteTransport.setSessionRemoteLease(sid, !!active, target);
    }
    localGateway?.syncWorkspaceDiagnosticsWatch?.();
    return { ok: true };
  });

  ipcMain.handle('workspace:get', () => {
    const localGateway = getLocalGateway();
    if (!localGateway) return { kind: 'local', workspacePath: null, displayPath: '', sshConnected: false };
    return localGateway.getWorkspace();
  });

  ipcMain.handle('workspace:set', async (_evt, workspacePath) => {
    const localGateway = getLocalGateway();
    const userData = getUserDataPath();
    if (!localGateway) return { kind: 'local', workspacePath: null, displayPath: '', sshConnected: false };
    try {
      const ws = localGateway.setWorkspace(workspacePath || null);
      try {
        const localRoot = ws.kind === 'local' ? ws.workspacePath : null;
        ensureAgentHomeDirs(userData, localRoot);
      } catch (e) {
        log.warn('工作空间 Agent 目录初始化失败:', e.message);
      }
      if (ws && ws.kind === 'ssh' && !ws.sshConnected) {
        try {
          await tryReconnectCurrentSshWorkspace('workspace_set', { awaitAfterReconnect: true });
        } catch (e) {
          log.info('SSH auto reconnect skipped on workspace_set:', e && e.message);
        }
        return localGateway.getWorkspace();
      }
      return ws;
    } catch (e) {
      log.warn('workspace:set', e.message);
      throw e;
    }
  });

  ipcMain.handle('workspace:set-local', (_evt, { path: localPath } = {}) => {
    const localGateway = getLocalGateway();
    const userData = getUserDataPath();
    if (!localGateway) return { kind: 'local', workspacePath: null, displayPath: '', sshConnected: false };
    const ws = localGateway.setLocalWorkspace(localPath || null);
    try {
      ensureAgentHomeDirs(userData, ws.kind === 'local' ? ws.workspacePath : null);
    } catch (e) {
      log.warn('工作空间 Agent 目录初始化失败:', e.message);
    }
    return ws;
  });

  ipcMain.handle('workspace:set-ssh-remote', (_evt, { remotePath } = {}) => {
    const localGateway = getLocalGateway();
    if (!localGateway) throw new Error('Gateway 未就绪');
    return localGateway.setSshWorkspace(remotePath || '/');
  });

  ipcMain.handle('ssh:connect', async (_evt, payload) => {
    const sshSessionManager = getSshSessionManager();
    const sshCredentialsStore = getSshCredentialsStore();
    if (!sshSessionManager) throw new Error('SSH 服务未就绪');
    const p = { ...(payload || {}) };
    if (sshCredentialsStore) {
      const authType = p.authType === 'key' ? 'key' : 'password';
      const needsSaved =
        p.remember &&
        ((authType === 'password' && !p.password) ||
          (authType === 'key' && !p.passphrase && !p.privateKeyPath));
      if (needsSaved || (p.remember && authType === 'key' && !p.passphrase)) {
        const saved = sshCredentialsStore.loadConnectSecrets(p.host, p.port, p.username);
        if (saved) {
          p.authType = saved.authType;
          if (saved.authType === 'key') {
            if (!p.privateKeyPath) p.privateKeyPath = saved.privateKeyPath;
            if (!p.passphrase) p.passphrase = saved.passphrase;
          } else if (!p.password) {
            p.password = saved.password;
          }
        }
      }
    }
    let result;
    try {
      result = await sshSessionManager.connect(p);
    } catch (e) {
      if (e && e.code === 'SSH_HOST_KEY_UNKNOWN') {
        return {
          ok: false,
          connected: false,
          needHostKeyTrust: true,
          hostKeyMismatch: false,
          fingerprint: e.fingerprint || '',
          host: p.host,
          port: Number(p.port) || 22,
          username: p.username || ''
        };
      }
      if (e && e.code === 'SSH_HOST_KEY_MISMATCH') {
        return {
          ok: false,
          connected: false,
          needHostKeyTrust: true,
          hostKeyMismatch: true,
          fingerprint: e.fingerprint || '',
          savedFingerprint: e.savedFingerprint || '',
          host: p.host,
          port: Number(p.port) || 22,
          username: p.username || ''
        };
      }
      throw e;
    }
    if (sshCredentialsStore) {
      if (p.remember) sshCredentialsStore.saveProfile(p);
      else if (p.host && p.username) sshCredentialsStore.clearProfile(p.host, p.port, p.username);
    }
    const session = resolveSshConnectSessionStatus(p, result);
    return { ...result, connected: !!session.connected, session };
  });

  ipcMain.handle('ssh:remote-agent-log', async (_evt, { lines } = {}) => {
    const sshSessionManager = getSshSessionManager();
    if (!sshSessionManager) return { ok: false, error: 'SSH 未就绪' };
    const { shellQuoteSingle } = require('../../ssh/remote-path');
    try {
      sshSessionManager.assertConnected();
      const homeR = await sshSessionManager.exec('echo $HOME', null, 5000, { loginShell: false });
      const home = String(homeR.stdout || '').trim();
      const logPath = `${home}/.dieyun/remote-agent/current/agent.log`;
      const n = Math.min(200, Math.max(10, Number(lines) || 80));
      const r = await sshSessionManager.execScript(
        `test -f ${shellQuoteSingle(logPath)} && tail -n ${n} ${shellQuoteSingle(logPath)} || echo "(无 agent.log)"`,
        10000
      );
      return { ok: true, log: String(r.stdout || ''), path: logPath };
    } catch (e) {
      return { ok: false, error: e.message || String(e) };
    }
  });

  ipcMain.handle('ssh:remote-gateway-status', () => {
    const localGateway = getLocalGateway();
    const sshSessionManager = getSshSessionManager();
    const ws = localGateway ? localGateway.getWorkspace() : null;
    const ssh = sshSessionManager ? sshSessionManager.status() : { connected: false };
    const rg = getActiveRemoteGatewayStatus();
    const sshOn = !!ssh.connected;
    const isSshWs = ws && ws.kind === 'ssh';
    let sshBackend = 'none';
    if (isSshWs && sshOn) {
      sshBackend = rg && rg.active ? 'remote-gateway' : 'sftp';
    }
    return {
      sshConnected: sshOn,
      workspaceKind: ws ? ws.kind : null,
      workspacePath: ws ? ws.workspacePath : null,
      sshBackend,
      remoteGateway: rg,
      tunnelActive: !!(rg && rg.active),
      packRoot: getRemoteGatewayPackRoot(),
      packExists: fs.existsSync(getRemoteGatewayPackRoot())
    };
  });

  ipcMain.handle('ssh:ensure-remote-gateway', async () => {
    const localGateway = getLocalGateway();
    try {
      const info = await ensureRemoteGatewayForCurrentWorkspace();
      if (info && localGateway && typeof localGateway.syncRemoteIndexCoreConfig === 'function') {
        await localGateway.syncRemoteIndexCoreConfig();
      }
      if (!info) {
        return {
          ok: false,
          code: 'REMOTE_GATEWAY_SKIPPED',
          error: '远程工作空间未连接或当前不是 SSH 工作空间',
          remoteGateway: getActiveRemoteGatewayStatus()
        };
      }
      return { ok: true, remoteGateway: info, status: getActiveRemoteGatewayStatus() };
    } catch (e) {
      return {
        ok: false,
        error: e.message || String(e),
        code: e.code || 'REMOTE_GATEWAY_FAILED',
        detail: e.detail || '',
        status: getActiveRemoteGatewayStatus()
      };
    }
  });

  ipcMain.handle('ssh:get-profile', (_evt, { host, port, username } = {}) => {
    const sshCredentialsStore = getSshCredentialsStore();
    if (!sshCredentialsStore) {
      return { authType: 'password', remember: false, canEncrypt: false };
    }
    const profile = sshCredentialsStore.getProfile(host, port, username);
    return {
      authType: profile?.authType || 'password',
      privateKeyPath: profile?.privateKeyPath || '',
      remember: !!(profile && profile.remember),
      hasSecret: !!(profile && profile.hasSecret),
      canEncrypt: sshCredentialsStore.canEncrypt()
    };
  });

  ipcMain.handle('ssh:auto-reconnect', async () => {
    const localGateway = getLocalGateway();
    try {
      const r = await tryReconnectCurrentSshWorkspace('ipc_auto_reconnect', { awaitAfterReconnect: true });
      return {
        ...r,
        workspace: localGateway ? localGateway.getWorkspace() : null,
        remoteGateway: getActiveRemoteGatewayInfo()
      };
    } catch (e) {
      return { ok: false, error: e.message || String(e), workspace: localGateway ? localGateway.getWorkspace() : null };
    }
  });

  ipcMain.handle('ssh:disconnect', async (_evt, opts = {}) => {
    const localGateway = getLocalGateway();
    const sessionRemoteTransport = getSessionRemoteTransport();
    const sshSessionManager = getSshSessionManager();
    const sshConnectionPool = getSshConnectionPool();
    const remoteGatewayPool = getRemoteGatewayPool();
    const portForwardManager = getPortForwardManager();
    const force = opts && opts.force === true;
    suppressSshReconnect();
    const target = localGateway ? localGateway.getEffectiveWorkspaceTarget() : null;
    if (target && target.kind === 'ssh' && sessionRemoteTransport?.hasLeaseForTarget(target)) {
      const leasedSessions = sessionRemoteTransport.listLeaseSessionIdsForTarget
        ? sessionRemoteTransport.listLeaseSessionIdsForTarget(target)
        : sessionRemoteTransport.getLeasedSessionIds?.() || [];
      if (!force) {
        return {
          ok: true,
          kept: true,
          reason: 'background_lease',
          leasedSessions,
          leaseCount: leasedSessions.length
        };
      }
      if (typeof sessionRemoteTransport.dropLeasesForTarget === 'function') {
        sessionRemoteTransport.dropLeasesForTarget(target);
      }
    }
    if (target && target.kind === 'ssh' && sshConnectionPool && remoteGatewayPool) {
      const manager =
        (typeof sshConnectionPool.getConnectedManagerForEndpoint === 'function'
          ? sshConnectionPool.getConnectedManagerForEndpoint(target)
          : null) || sshConnectionPool.getManagerForTarget(target);
      if (manager) {
        await remoteGatewayPool.stopForTarget(target, manager);
      }
      if (portForwardManager) await portForwardManager.removeAll();
      invalidateRemoteAgentClient();
      if (typeof sshConnectionPool.disconnectEndpoint === 'function') {
        await sshConnectionPool.disconnectEndpoint(target, { force: true });
      } else {
        await sshConnectionPool.disconnectTarget(target, { force: true });
      }
      return { ok: true, forced: force };
    }
    if (portForwardManager) await portForwardManager.removeAll();
    invalidateRemoteAgentClient();
    if (sshSessionManager) await sshSessionManager.disconnect();
    return { ok: true, forced: force };
  });

  ipcMain.handle('ssh:port-forward-add', async (_evt, payload = {}) => {
    const sshSessionManager = getSshSessionManager();
    const portForwardManager = getPortForwardManager();
    if (!sshSessionManager || !portForwardManager) {
      return { ok: false, error: 'SSH 未就绪' };
    }
    try {
      sshSessionManager.assertConnected();
      const row = await portForwardManager.addForward(sshSessionManager, {
        localPort: Number(payload.localPort) || 0,
        remoteHost: payload.remoteHost || '127.0.0.1',
        remotePort: Number(payload.remotePort)
      });
      return { ok: true, forward: row };
    } catch (e) {
      return { ok: false, error: e.message || String(e) };
    }
  });

  ipcMain.handle('ssh:port-forward-remove', async (_evt, { id } = {}) => {
    const portForwardManager = getPortForwardManager();
    if (!portForwardManager) return { ok: false, error: '端口转发未就绪' };
    return portForwardManager.removeForward(id);
  });

  ipcMain.handle('ssh:port-forward-list', () => {
    const portForwardManager = getPortForwardManager();
    if (!portForwardManager) return { ok: true, forwards: [] };
    return { ok: true, forwards: portForwardManager.listForwards() };
  });

  ipcMain.handle('ssh:status', () => {
    const sshSessionManager = getSshSessionManager();
    const sshConnectionPool = getSshConnectionPool();
    if (!sshSessionManager) return { connected: false };
    const st = sshSessionManager.status();
    if (st.connected) return st;
    if (sshConnectionPool && typeof sshConnectionPool.findConnectedEndpoint === 'function') {
      const ep = sshConnectionPool.findConnectedEndpoint();
      if (ep) return { ...ep, connected: true };
    }
    return { connected: false };
  });

  ipcMain.handle('ssh:browse', async (_evt, { path: remotePath } = {}) => {
    const sshSessionManager = getSshSessionManager();
    if (!sshSessionManager) throw new Error('SSH 未就绪');
    return sshSessionManager.browse(remotePath || '/');
  });

  ipcMain.handle('ssh:home', async () => {
    const sshSessionManager = getSshSessionManager();
    if (!sshSessionManager) throw new Error('SSH 未就绪');
    sshSessionManager.assertConnected();
    const home = await sshSessionManager.resolveHomeDir();
    return { ok: true, home };
  });
}

module.exports = { registerWorkspaceRemoteIpc };
