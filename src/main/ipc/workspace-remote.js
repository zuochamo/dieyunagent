'use strict';

const fs = require('fs');
const { createSshActions } = require('../../ssh/actions');
const { remoteLogDisplayPath } = require('../../ssh/remote-gateway-manager');
const { bindSessionWorkspace } = require('../../agent/session-workspace-bind');

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
    getActiveRemoteGatewayStatus,
    getActiveRemoteGatewayWireInfo,
    getRemoteGatewayPackRoot,
    // SSH 动作的唯一实现（Agent 工具 `ssh` 走同一份）：见 src/ssh/actions.js
    sshActions
  } = ctx;
  // Main 装配时会传同一份实例（工具与 IPC 共用）；测试/单独调用时按 ctx 里的取值函数现建一份。
  const ssh = sshActions || createSshActions(ctx);

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
      // 只清运行时上下文还不够：DB 行里的旧路径下次启动又会被 session_get 带回来。
      // 两处的写入由 bindSessionWorkspace 一处负责（'' = 解绑 → 会话行写 NULL）。
      try {
        await bindSessionWorkspace(localGateway, sid, '');
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
    let effectiveWorkspacePath = '';
    if (sessionRemoteTransport) {
      const { parseWorkspaceInput } = require('../../workspace/target');
      const sid = sessionId ? String(sessionId).trim() : '';
      let target = workspacePath ? parseWorkspaceInput(workspacePath) : null;
      if (!target && sid && localGateway) {
        target = localGateway.getSessionWorkspaceTarget(sid);
      }
      // 租约可能把会话切进它自己的 worktree（见 src/session/session-worktree.js）：把**生效后**
      // 的工作区路径回给渲染端，否则它会继续用租约前的旧根查索引（两份 index.sqlite，
      // 严格比对直接报 WORKSPACE_SCOPE_MISMATCH）。
      effectiveWorkspacePath = (await sessionRemoteTransport.setSessionRemoteLease(sid, !!active, target)) || '';
    }
    localGateway?.syncWorkspaceDiagnosticsWatch?.();
    return { ok: true, workspacePath: effectiveWorkspacePath };
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

  ipcMain.handle('workspace:set-ssh-remote', (_evt, { remotePath } = {}) =>
    ssh.useWorkspace(remotePath || '/')
  );

  ipcMain.handle('ssh:connect', async (_evt, payload) => ssh.connect(payload || {}));

  ipcMain.handle('ssh:remote-agent-log', async (_evt, { lines } = {}) => {
    const sshSessionManager = getSshSessionManager();
    if (!sshSessionManager) return { ok: false, error: 'SSH 未就绪' };
    const { shellQuoteSingle } = require('../../ssh/remote-path');
    try {
      sshSessionManager.assertConnected();
      // 日志按项目分开（remote-gateway-manager: remoteLogDir/remoteLogPathFor）：
      // 以当前槽位回报的 remoteLogPath 为准；没有槽位时也用同一个展示路径函数，
      // 别再手写一份 `current/agent.log`（那份早就不存在，问不到的地方各写一套必然漂移）
      const rgStatus = getActiveRemoteGatewayStatus();
      const rel = (rgStatus && rgStatus.remoteLogPath) || remoteLogDisplayPath();
      // `~` 在远端展开：以前是先 `echo $HOME` 再 tail，两次往返。连接内的 exec 是串行的，
      // 面板每开一次就等于自己排了两次队（还有一半是白问的 HOME），所以合成一趟。
      const logRef = rel.startsWith('~/')
        ? `"$HOME"/${shellQuoteSingle(rel.slice(2))}`
        : shellQuoteSingle(rel);
      const n = Math.min(200, Math.max(10, Number(lines) || 80));
      const r = await sshSessionManager.execScript(
        `LOG=${logRef}\nif test -f "$LOG"; then tail -n ${n} "$LOG"; else echo "(无 agent.log)"; fi`,
        10000
      );
      return { ok: true, log: String(r.stdout || ''), path: rel };
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
    const sshState = sshSessionManager ? sshSessionManager.status() : { connected: false };
    const rg = getActiveRemoteGatewayStatus();
    const sshOn = !!sshState.connected;
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
      return { authType: 'password', remember: false, canEncrypt: false, storeCorrupt: false };
    }
    // 健康度要先读一次才算数（损坏态只在「读到坏文件」时成立）
    const health = sshCredentialsStore.readStoreHealth();
    const profile = sshCredentialsStore.getProfile(host, port, username);
    return {
      authType: profile?.authType || 'password',
      privateKeyPath: profile?.privateKeyPath || '',
      remember: !!(profile && profile.remember),
      hasSecret: !!(profile && profile.hasSecret),
      canEncrypt: sshCredentialsStore.canEncrypt(),
      // 文件坏了：面板要明说「已保存的凭据读不出来，请重新填写」，而不是装作没有凭据
      storeCorrupt: !!health.corrupt,
      storeCorruptMessage: health.message || ''
    };
  });

  /** 备份坏的 `ssh-profiles.json` 并按空态重建（连接面板「备份并重建」）。 */
  ipcMain.handle('ssh:credentials-reset', () => {
    const sshCredentialsStore = getSshCredentialsStore();
    if (!sshCredentialsStore) return { moved: false, backupPath: '' };
    return sshCredentialsStore.resetStore();
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

  ipcMain.handle('ssh:disconnect', async (_evt, opts = {}) => ssh.disconnect(opts || {}));

  ipcMain.handle('ssh:port-forward-add', async (_evt, payload = {}) => ssh.portForwardAdd(payload || {}));

  ipcMain.handle('ssh:port-forward-remove', async (_evt, { id } = {}) => ssh.portForwardRemove({ id }));

  ipcMain.handle('ssh:port-forward-list', () => ssh.portForwardList());

  ipcMain.handle('ssh:status', () => ssh.status());

  ipcMain.handle('ssh:browse', async (_evt, { path: remotePath } = {}) => ssh.browse(remotePath || '/'));

  ipcMain.handle('ssh:home', async () => ssh.home());
}

module.exports = { registerWorkspaceRemoteIpc };
