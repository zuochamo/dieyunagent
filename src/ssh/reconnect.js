'use strict';

const { tryAutoReconnectSsh } = require('./auto-reconnect');
const { sshGatewayKey } = require('../workspace/target');
const { remoteAgentInfoKey } = require('../workspace/workspace-cache-keys');

/**
 * 重连目标清单。
 *
 * 每条都必须带**会话身份**：`sshGatewayKey` 只到「登录端点 + 仓库」，端点本身（`user@host:port`）
 * 分不出会话。以前这里只传裸 target，下游 `ensureRemoteGatewayForTarget` 只能按端点反查会话，
 * 同机多仓库时把别人的 worktree 建到这个仓库，并把仓库路径写回别人的会话工作区。
 *
 * @param {{ target: object|null, sessionId?: string }|null} viewEntry 当前视图（含当前会话）
 * @param {Array<{ target: object, sessionId?: string }>} [leasedEntries] 已持租约的会话与目标
 * @returns {Array<{ target: object, sessionId: string }>}
 */
function collectSshReconnectEntries(viewEntry, leasedEntries) {
  const seen = new Set();
  const out = [];
  const push = (entry) => {
    const target = entry && entry.target;
    if (!target || target.kind !== 'ssh') return;
    const key = sshGatewayKey(target);
    if (!key || seen.has(key)) return;
    seen.add(key);
    out.push({ target, sessionId: entry.sessionId ? String(entry.sessionId) : '' });
  };
  push(viewEntry);
  if (Array.isArray(leasedEntries)) {
    for (const e of leasedEntries) push(e);
  }
  return out;
}

/**
 * SSH reconnect + Remote Agent heal (TCP then tunnel).
 * @param {object} deps
 */
function createSshReconnect(deps) {
  const {
    log,
    getLocalGateway,
    getSshSessionManager,
    getSshCredentialsStore,
    getSshConnectionPool,
    getSshConfigBlocks,
    getSessionRemoteTransport,
    invalidateRemoteAgentClient,
    ensureRemoteGatewayForCurrentWorkspace,
    // 远端状态只取可跨进程投影：本函数产出的对象会进 `gateway:ssh-reconnected` 广播，
    // 而 `getActiveRemoteGatewayInfo()` 带 `openChannel` 函数，过 IPC 会抛
    // `An object could not be cloned`（投影的单一来源见 remote-gateway.js:getActiveRemoteGatewayWireInfo）。
    getActiveRemoteGatewayWireInfo,
    broadcastToRenderers
  } = deps;

  let sshReconnectTimer = null;
  let sshReconnectSuppressedUntil = 0;

  function suppressSshReconnect(ms = 10000) {
    sshReconnectSuppressedUntil = Date.now() + ms;
  }

  function disposeSshReconnectTimer() {
    if (sshReconnectTimer) {
      clearTimeout(sshReconnectTimer);
      sshReconnectTimer = null;
    }
  }

  function resolveSshConnectSessionStatus(payload, connectResult) {
    const localGateway = getLocalGateway();
    const sshConnectionPool = getSshConnectionPool();
    const sshSessionManager = getSshSessionManager();
    const host = String(payload?.host || '').trim();
    const username = String(payload?.username || '').trim();
    const port = Number(payload?.port) || 22;
    if (sshConnectionPool && host && username) {
      const viewTarget = localGateway?.getEffectiveWorkspaceTarget?.();
      const remotePath =
        viewTarget?.kind === 'ssh' &&
        viewTarget.host === host &&
        (Number(viewTarget.port) || 22) === port &&
        viewTarget.username === username
          ? viewTarget.remotePath || '/'
          : payload.remotePath || '/';
      const targetHint = {
        kind: 'ssh',
        host,
        port,
        username,
        remotePath
      };
      const manager =
        sshConnectionPool.getConnectedManager(targetHint) ||
        sshConnectionPool.getManagerForTarget(targetHint);
      if (manager) {
        const st = manager.status();
        if (st.connected) return st;
      }
    }
    if (connectResult && connectResult.connected) return connectResult;
    if (sshSessionManager) return sshSessionManager.status();
    return { connected: false };
  }

  async function afterSshReconnectSuccess() {
    const localGateway = getLocalGateway();
    try {
      await new Promise((res) => setTimeout(res, 350));
      await ensureRemoteGatewayForCurrentWorkspace();
      if (localGateway && typeof localGateway.syncRemoteIndexCoreConfig === 'function') {
        await localGateway.syncRemoteIndexCoreConfig();
      }
    } catch (e) {
      log.warn('Remote Gateway 启动失败:', e && e.message);
      if (e && e.detail) log.warn('Remote Gateway 详情:', e.detail);
      if (e && e.code) log.warn('Remote Gateway 错误码:', e.code);
    }
    broadcastToRenderers('gateway:ssh-reconnected', {
      workspace: localGateway ? localGateway.getWorkspace() : null,
      remoteGateway: getActiveRemoteGatewayWireInfo()
    });
  }

  async function tryReconnectSshTarget(target, reason = 'manual', opts = {}) {
    const localGateway = getLocalGateway();
    const sshSessionManager = getSshSessionManager();
    const sshCredentialsStore = getSshCredentialsStore();
    const sshConnectionPool = getSshConnectionPool();
    const sessionRemoteTransport = getSessionRemoteTransport();
    if (!localGateway || !sshSessionManager || !sshCredentialsStore) {
      return { ok: false, reason: 'missing_services' };
    }
    if (!target || target.kind !== 'ssh') {
      return { ok: false, reason: 'not_ssh_target' };
    }
    if (sshConnectionPool?.isConnected(target)) {
      return { ok: true, already: true };
    }

    const r = await tryAutoReconnectSsh({
      localGateway,
      sshSessionManager,
      sshPool: sshConnectionPool,
      target,
      credentialsStore: sshCredentialsStore,
      // 走与手动连接同一套装配（connect-payload）：别名解析、已存凭据、ssh_config 都在那里定。
      // 这里必须把 deps 里的函数原样传下去，不能读不存在的局部变量。
      getSshConfigBlocks: typeof getSshConfigBlocks === 'function' ? getSshConfigBlocks : undefined,
      log: (m) => log.info(m)
    });
    if (r.ok && r.reconnected) {
      log.info(`SSH auto reconnect OK (${reason}): ${target.username}@${target.host}`);
      if (opts.ensureGateway !== false && sessionRemoteTransport) {
        try {
          // 会话身份必须显式给：端点分不出会话，缺了就只能起槽位（不再替别的会话建 worktree）
          await sessionRemoteTransport.ensureRemoteGatewayForTarget(target, opts.sessionId);
        } catch (e) {
          log.warn('SSH leased reconnect gateway:', e && e.message);
        }
      }
    }
    return r;
  }

  function listReconnectTargets() {
    const localGateway = getLocalGateway();
    const sessionRemoteTransport = getSessionRemoteTransport();
    const activeSid = localGateway?.activeSessionId ? String(localGateway.activeSessionId) : '';
    const viewEntry = {
      // getEffectiveWorkspaceTarget() 就是「当前会话（没有才回落到视图）的目标」，与会话身份同源
      target: localGateway?.getEffectiveWorkspaceTarget?.() || null,
      sessionId: activeSid
    };
    const leased =
      sessionRemoteTransport?.getLeasedTargets ? sessionRemoteTransport.getLeasedTargets() : [];
    return collectSshReconnectEntries(viewEntry, leased);
  }

  async function reconnectActiveAndLeasedSsh(reason = 'close', opts = {}) {
    const localGateway = getLocalGateway();
    const targets = listReconnectTargets();
    if (!targets.length) return { ok: true, count: 0, reconnectedAny: false };

    const batchSize = Math.max(1, Math.min(2, Number(opts.concurrency) || 2));
    let reconnectedAny = false;
    for (let i = 0; i < targets.length; i += batchSize) {
      const batch = targets.slice(i, i + batchSize);
      const results = await Promise.all(
        batch.map((entry) =>
          tryReconnectSshTarget(entry.target, reason, {
            ensureGateway: opts.ensureGateway !== false,
            sessionId: entry.sessionId
          })
        )
      );
      if (results.some((r) => r && r.reconnected)) reconnectedAny = true;
    }

    const viewTarget = localGateway?.getEffectiveWorkspaceTarget?.();
    if (reconnectedAny && viewTarget?.kind === 'ssh') {
      const after = afterSshReconnectSuccess();
      if (opts.awaitAfterReconnect) {
        await after;
      } else {
        after.catch((e) => log.warn('SSH post-reconnect failed:', e && e.message));
      }
    }
    return { ok: true, count: targets.length, reconnectedAny };
  }

  async function tryReconnectCurrentSshWorkspace(reason = 'manual', opts = {}) {
    const localGateway = getLocalGateway();
    const sshSessionManager = getSshSessionManager();
    const sshCredentialsStore = getSshCredentialsStore();
    if (!localGateway || !sshSessionManager || !sshCredentialsStore) {
      return { ok: false, reason: 'missing_services' };
    }
    const ws = localGateway.getWorkspace();
    if (!ws || ws.kind !== 'ssh') {
      return { ok: false, reason: 'not_ssh_workspace' };
    }
    if (ws.sshConnected) {
      return { ok: true, already: true };
    }
    const target = localGateway.getEffectiveWorkspaceTarget();
    // getEffectiveWorkspaceTarget() 有当前会话时就是它的目标：会话身份一起带上，别让下游按端点猜
    const r = await tryReconnectSshTarget(target, reason, {
      ...opts,
      sessionId: localGateway.activeSessionId ? String(localGateway.activeSessionId) : ''
    });
    if (r.ok && r.reconnected) {
      const after = afterSshReconnectSuccess();
      if (opts.awaitAfterReconnect) {
        await after;
      } else {
        after.catch((e) => log.warn('SSH post-reconnect failed:', e && e.message));
      }
    }
    return r;
  }

  async function healRemoteAgentTransport(opts = {}) {
    const reason = String(opts.reason || 'manual');
    const steps = [];
    const localGateway = getLocalGateway();
    if (!localGateway) {
      return { ok: false, reason: 'missing_gateway', steps };
    }
    const ws = localGateway.getWorkspace();
    if (!ws || ws.kind !== 'ssh') {
      return { ok: false, reason: 'not_remote_workspace', steps };
    }

    const prevInfo = getActiveRemoteGatewayWireInfo();
    if (prevInfo) {
      try {
        invalidateRemoteAgentClient(prevInfo);
        steps.push('invalidate_stale_client');
      } catch {
        // ignore
      }
    }

    if (ws.kind === 'ssh') {
      if (!ws.sshConnected) {
        steps.push('ssh_reconnect');
        const r = await tryReconnectCurrentSshWorkspace(`heal_${reason}`, {
          awaitAfterReconnect: true,
          ensureGateway: true
        });
        if (!r.ok && !r.already) {
          return {
            ok: false,
            reason: 'ssh_reconnect_failed',
            error: r.reason || r.error || 'SSH 重连失败',
            steps
          };
        }
        if (r.reconnected) steps.push('ssh_reconnected');
        const infoAfter = getActiveRemoteGatewayWireInfo();
        if (infoAfter) {
          try {
            await localGateway.syncRemoteIndexCoreConfig();
            steps.push('sync_configure');
          } catch {
            // ignore
          }
          return { ok: true, steps, reconnectedSsh: !!r.reconnected, info: infoAfter };
        }
      }

      steps.push('ensure_gateway');
      try {
        const info = await ensureRemoteGatewayForCurrentWorkspace();
        if (!info) {
          return {
            ok: false,
            reason: 'ensure_skipped',
            error: '远程工作空间未连接或无法注入 Remote Agent',
            steps
          };
        }
        // 重建后的 Agent 身份变了（socket 路径或 workspace 变了）→ 旧客户端必须丢弃，
        // 否则后续 RPC 还挂在上一代通道上。身份只有 remoteAgentInfoKey 一份。
        if (prevInfo && remoteAgentInfoKey(prevInfo) !== remoteAgentInfoKey(info)) {
          try {
            invalidateRemoteAgentClient(prevInfo);
            steps.push('invalidate_rotated_client');
          } catch {
            // ignore
          }
        }
        try {
          await localGateway.syncRemoteIndexCoreConfig();
          steps.push('sync_configure');
        } catch {
          // ignore
        }
        return { ok: true, steps, info };
      } catch (e) {
        return {
          ok: false,
          reason: 'ensure_failed',
          error: e && e.message ? e.message : String(e),
          code: e && e.code,
          steps
        };
      }
    }

  }

  function scheduleSshAutoReconnect(reason = 'close') {
    if (Date.now() < sshReconnectSuppressedUntil) return;
    if (sshReconnectTimer) return;
    sshReconnectTimer = setTimeout(async () => {
      sshReconnectTimer = null;
      try {
        await reconnectActiveAndLeasedSsh(reason, { awaitAfterReconnect: true });
      } catch (e) {
        log.warn('SSH 自动重连失败:', e && e.message);
      }
    }, 2500);
  }

  return {
    resolveSshConnectSessionStatus,
    tryReconnectCurrentSshWorkspace,
    reconnectActiveAndLeasedSsh,
    healRemoteAgentTransport,
    scheduleSshAutoReconnect,
    suppressSshReconnect,
    disposeSshReconnectTimer
  };
}

module.exports = { createSshReconnect, collectSshReconnectEntries };
