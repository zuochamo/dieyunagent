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
    getSshConfigBlocks,
    getSshConnectionPool,
    getRemoteGatewayPool,
    getPortForwardManager,
    resolveSshConnectSessionStatus,
    getActiveRemoteGatewayStatus,
    getActiveRemoteGatewayWireInfo,
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
    // 会话行持久化的 workspace_path 可能指向早已删除的本地目录；不校验的话
    // 每次启动/切会话都会把它重新绑回来（索引 watcher 随即 stop）
    let clearedMissingWorkspace = false;
    const isMissingLocalPath = (p) =>
      !!p && !/^ssh:/i.test(String(p)) && !fs.existsSync(String(p));
    const clearMissingWorkspace = async () => {
      clearedMissingWorkspace = true;
      localGateway.setSessionWorkspaceContext(sid, null);
      // 只清运行时上下文还不够：DB 行里的旧路径下次启动又会被 session_get 带回来
      try {
        await localGateway.invokeRpc('memory.session_workspace_set', {
          sessionId: sid,
          workspacePath: null
        });
      } catch (e) {
        log.info('session_workspace_set null:', e && e.message);
      }
    };
    if (sid && workspacePath !== undefined) {
      if (isMissingLocalPath(workspacePath)) {
        await clearMissingWorkspace();
      } else {
        localGateway.setSessionWorkspaceContext(sid, workspacePath || null);
      }
    } else if (sid && !localGateway.sessionWorkspaceTargets.has(sid)) {
      try {
        const row = await localGateway.invokeRpc('memory.session_get', { sessionId: sid });
        if (row && row.workspacePath && isMissingLocalPath(row.workspacePath)) {
          await clearMissingWorkspace();
        } else if (row && row.workspacePath) {
          localGateway.setSessionWorkspaceContext(sid, row.workspacePath);
        }
      } catch (e) {
        log.info('workspace:set-active-session session_get:', e && e.message);
      }
    }
    if (bindOnly) {
      return { ok: true, bindOnly: true, sessionId: sid || null, clearedMissingWorkspace };
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
    return { ...localGateway.getWorkspace(), clearedMissingWorkspace };
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
    // 「连接意图 → 有效参数」的唯一来源（~/.ssh/config 别名、已存凭据、认证方式都在这里定）
    const { resolveConnectPayload } = require('../../ssh/connect-payload');
    const p = resolveConnectPayload(payload || {}, {
      credentialsStore: sshCredentialsStore,
      sshConfigBlocks: typeof getSshConfigBlocks === 'function' ? getSshConfigBlocks() : []
    });
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
    // 「记住登录信息」是连接的**副产物**，失败不许把已经建立的连接判成失败。
    // 典型触发：系统钥匙串不可用（无法加密）、私钥认证 + 没填 passphrase（passphrase 本就可选）。
    let credentialsWarning = '';
    if (sshCredentialsStore) {
      try {
        // agent 认证没有可保存的秘密，别写成一条空记录再报「无有效凭据可保存」
        const hasSecret = !!(p.password || p.passphrase);
        if (p.remember && hasSecret) sshCredentialsStore.saveProfile(p);
        else if (!p.remember && p.host && p.username) sshCredentialsStore.clearProfile(p.host, p.port, p.username);
      } catch (e) {
        credentialsWarning = (e && e.message) || String(e);
        console.warn('[ssh:connect] 保存登录信息失败（连接本身已成功）:', credentialsWarning);
      }
    }
    const session = resolveSshConnectSessionStatus(p, result);
    return {
      ...result,
      connected: !!session.connected,
      session,
      credentialsWarning,
      // 让 UI 说清「实际连到哪」：别名只是入口，地址/认证方式/跳板才是事实
      resolved: {
        host: p.host,
        hostname: p.hostname,
        port: p.port,
        username: p.username,
        authType: p.authType,
        viaJump: (p.jumps || []).map((h) => h.hostname),
        fromSshConfig: !!(p.config && p.config.matched),
        warnings: p.warnings || []
      }
    };
  });

  ipcMain.handle('ssh:remote-agent-log', async (_evt, { lines } = {}) => {
    const sshSessionManager = getSshSessionManager();
    if (!sshSessionManager) return { ok: false, error: 'SSH 未就绪' };
    const { shellQuoteSingle } = require('../../ssh/remote-path');
    try {
      sshSessionManager.assertConnected();
      const homeR = await sshSessionManager.exec('echo $HOME', null, 5000, { loginShell: false });
      const home = String(homeR.stdout || '').trim();
      // 日志按项目分开（remote-gateway-manager: remoteLogDir/remoteLogPathFor）：
      // 以当前槽位回报的 remoteLogPath 为准，别再用共享的 current/agent.log
      const rgStatus = getActiveRemoteGatewayStatus();
      const rel = rgStatus && rgStatus.remoteLogPath ? String(rgStatus.remoteLogPath) : '';
      const logPath = rel.startsWith('~/')
        ? `${home}/${rel.slice(2)}`
        : rel || `${home}/.dieyun/remote-agent/current/agent.log`;
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

  /**
   * 可跨进程的远端 Gateway 信息（IPC 专用）。
   * `getInfo()` 带 `openChannel` 函数，原样进 IPC 会让整条 reply 抛
   * `An object could not be cloned`；投影的单一来源见 `remote-gateway-manager.wireInfo`。
   */
  function activeRemoteGatewayWireInfo() {
    return typeof getActiveRemoteGatewayWireInfo === 'function' ? getActiveRemoteGatewayWireInfo() : null;
  }

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
        remoteGateway: activeRemoteGatewayWireInfo()
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
        sshConnectionPool.getConnectedManager(target) || sshConnectionPool.getManagerForTarget(target);
      // 一条 SSH 连接就是一个端点，断开也按端点：同服务器其它会话的 agent 进程
      // 必须一起停，否则它们在远端变成孤儿（占端口、占索引库）。
      await remoteGatewayPool.stopForEndpoint(target, manager);
      if (portForwardManager) await portForwardManager.removeAll();
      invalidateRemoteAgentClient();
      await sshConnectionPool.disconnectEndpoint(target, { force: true });
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
