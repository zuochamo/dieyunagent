'use strict';

/**
 * SSH 动作的**唯一实现**：IPC（设置页 / 连接面板）与 Agent 工具 `ssh` 共用同一份。
 *
 * 为什么抽出来：这些动作原先只写在 `src/main/ipc/workspace-remote.js` 的 handler 里，
 * 结果是「人能在界面上连服务器，Agent 只能在本机干活」。复制一份给工具就是两套语义
 * （租约、端口转发清理、远端 agent 进程回收各漏一半），所以这里按 IPC 同一份代码执行，
 * handler 只做转发。
 *
 * 依赖全部用取值函数传入（启动期这些对象还是 null，晚绑定才拿得到）。
 *
 * @param {object} ctx
 * @param {() => object|null} ctx.getLocalGateway
 * @param {() => object|null} ctx.getSshSessionManager
 * @param {() => object|null} ctx.getSshCredentialsStore
 * @param {() => Array<any>} [ctx.getSshConfigBlocks]
 * @param {() => object|null} [ctx.getSshConnectionPool]
 * @param {() => object|null} [ctx.getRemoteGatewayPool]
 * @param {() => object|null} [ctx.getPortForwardManager]
 * @param {Function} [ctx.resolveSshConnectSessionStatus]
 * @param {Function} [ctx.invalidateRemoteAgentClient]
 * @param {Function} [ctx.suppressSshReconnect]
 * @param {{ info?: Function, warn?: Function }} [ctx.log]
 */
function createSshActions(ctx) {
  const deps = ctx && typeof ctx === 'object' ? ctx : {};
  const log = deps.log && typeof deps.log === 'object' ? deps.log : { info() {}, warn() {} };
  const get = (name) => (typeof deps[name] === 'function' ? deps[name]() : null);
  const call = (name, ...args) => {
    const fn = typeof deps[name] === 'function' ? deps[name] : null;
    return fn ? fn(...args) : undefined;
  };

  /**
   * 连接。`resolveConnectPayload` 是「连接意图 → 有效参数」的唯一来源：
   * 别名解析、已存凭据、认证方式都在那里定，这里只管执行与结果整形。
   */
  async function connect(payload) {
    const sshSessionManager = get('getSshSessionManager');
    const sshCredentialsStore = get('getSshCredentialsStore');
    if (!sshSessionManager) throw new Error('SSH 服务未就绪');
    const { resolveConnectPayload } = require('./connect-payload');
    const p = resolveConnectPayload(payload || {}, {
      credentialsStore: sshCredentialsStore,
      sshConfigBlocks: call('getSshConfigBlocks') || []
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
    let credentialsWarning = '';
    if (sshCredentialsStore) {
      try {
        const hasSecret = !!(p.password || p.passphrase);
        if (p.remember && hasSecret) sshCredentialsStore.saveProfile(p);
        else if (!p.remember && p.host && p.username) sshCredentialsStore.clearProfile(p.host, p.port, p.username);
      } catch (e) {
        credentialsWarning = (e && e.message) || String(e);
        log.warn('[ssh] 保存登录信息失败（连接本身已成功）:', credentialsWarning);
      }
    }
    const session = call('resolveSshConnectSessionStatus', p, result) || { connected: !!result };
    return {
      ...result,
      connected: !!session.connected,
      session,
      credentialsWarning,
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
  }

  /** 断开：一个端点一条连接，同服务器其它会话的远端 agent 进程必须一起停（否则变孤儿）。 */
  async function disconnect(opts = {}) {
    const localGateway = get('getLocalGateway');
    const sessionRemoteTransport = get('getSessionRemoteTransport');
    const sshSessionManager = get('getSshSessionManager');
    const sshConnectionPool = get('getSshConnectionPool');
    const remoteGatewayPool = get('getRemoteGatewayPool');
    const portForwardManager = get('getPortForwardManager');
    const force = opts && opts.force === true;
    call('suppressSshReconnect');
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
      await remoteGatewayPool.stopForEndpoint(target, manager);
      if (portForwardManager) await portForwardManager.removeAll();
      call('invalidateRemoteAgentClient');
      await sshConnectionPool.disconnectEndpoint(target, { force: true });
      return { ok: true, forced: force };
    }
    if (portForwardManager) await portForwardManager.removeAll();
    call('invalidateRemoteAgentClient');
    if (sshSessionManager) await sshSessionManager.disconnect();
    return { ok: true, forced: force };
  }

  function status() {
    const sshSessionManager = get('getSshSessionManager');
    const sshConnectionPool = get('getSshConnectionPool');
    if (!sshSessionManager) return { connected: false };
    const st = sshSessionManager.status();
    if (st.connected) return st;
    if (sshConnectionPool && typeof sshConnectionPool.findConnectedEndpoint === 'function') {
      const ep = sshConnectionPool.findConnectedEndpoint();
      if (ep) return { ...ep, connected: true };
    }
    return { connected: false };
  }

  async function browse(remotePath) {
    const sshSessionManager = get('getSshSessionManager');
    if (!sshSessionManager) throw new Error('SSH 未就绪');
    return sshSessionManager.browse(remotePath || '/');
  }

  async function home() {
    const sshSessionManager = get('getSshSessionManager');
    if (!sshSessionManager) throw new Error('SSH 未就绪');
    sshSessionManager.assertConnected();
    const h = await sshSessionManager.resolveHomeDir();
    return { ok: true, home: h };
  }

  async function portForwardAdd(payload = {}) {
    const sshSessionManager = get('getSshSessionManager');
    const portForwardManager = get('getPortForwardManager');
    if (!sshSessionManager || !portForwardManager) {
      return { ok: false, error: 'SSH 未就绪', errorCode: 'SSH_NOT_READY' };
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
      return { ok: false, error: e.message || String(e), errorCode: (e && e.code) || 'SSH_PORT_FORWARD_FAILED' };
    }
  }

  async function portForwardRemove(payload = {}) {
    const portForwardManager = get('getPortForwardManager');
    if (!portForwardManager) return { ok: false, error: '端口转发未就绪' };
    return portForwardManager.removeForward(payload.id);
  }

  function portForwardList() {
    const portForwardManager = get('getPortForwardManager');
    if (!portForwardManager) return { ok: true, forwards: [] };
    return { ok: true, forwards: portForwardManager.listForwards() };
  }

  /** 把工作空间切到远端目录（切换后 fs / host_exec 都按远端执行）。 */
  function useWorkspace(remotePath) {
    const localGateway = get('getLocalGateway');
    if (!localGateway) throw new Error('Gateway 未就绪');
    return localGateway.setSshWorkspace(remotePath || '/');
  }

  /** 工具用的目标清单：~/.ssh/config 的别名 + 当前连接态。不含任何密钥。 */
  function listTargets() {
    const { resolveHostConfig } = require('./ssh-config');
    const blocks = call('getSshConfigBlocks') || [];
    const aliases = [];
    const seen = new Set();
    for (const block of blocks) {
      for (const raw of (block && block.patterns) || []) {
        const name = String((raw && raw.text) || raw || '').trim();
        // 通配符条目不是可用别名（Block * 之类），列出来只会误导
        if (!name || name === '*' || /[*?]/.test(name) || seen.has(name)) continue;
        seen.add(name);
        const cfg = resolveHostConfig(blocks, name);
        aliases.push({
          alias: name,
          hostName: cfg.hostName || name,
          user: cfg.user || '',
          port: cfg.port || 22,
          viaJump: cfg.proxyJump ? cfg.proxyJump : ''
        });
      }
    }
    const st = status();
    const ws = get('getLocalGateway');
    const workspace = ws ? ws.getWorkspace() : null;
    return {
      connected: !!st.connected,
      host: st.host || st.hostname || '',
      username: st.username || '',
      workspaceKind: workspace ? workspace.kind : null,
      workspacePath: workspace ? workspace.workspacePath || workspace.remotePath || '' : '',
      configAliases: aliases,
      note: aliases.length
        ? '连接用 action=connect + profile=<别名>（走 ~/.ssh/config 里的 IdentityFile / ProxyJump）'
        : '~/.ssh/config 里没有可用别名：用 action=connect + host/username，并确保该主机密码或私钥已在本机保存'
    };
  }

  return {
    connect,
    disconnect,
    status,
    browse,
    home,
    portForwardAdd,
    portForwardRemove,
    portForwardList,
    useWorkspace,
    listTargets
  };
}

module.exports = { createSshActions };
