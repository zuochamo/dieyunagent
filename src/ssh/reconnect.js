'use strict';

const { tryAutoReconnectSsh } = require('./auto-reconnect');
const { sshGatewayKey } = require('../workspace/target');

function collectSshReconnectTargets(viewTarget, leasedTargets) {
  const seen = new Set();
  const out = [];
  const push = (target) => {
    if (!target || target.kind !== 'ssh') return;
    const key = sshGatewayKey(target);
    if (!key || seen.has(key)) return;
    seen.add(key);
    out.push(target);
  };
  push(viewTarget);
  if (Array.isArray(leasedTargets)) {
    for (const t of leasedTargets) push(t);
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
    getSessionRemoteTransport,
    invalidateRemoteAgentClient,
    ensureRemoteGatewayForCurrentWorkspace,
    getActiveRemoteGatewayInfo,
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
        (typeof sshConnectionPool.getConnectedManagerForEndpoint === 'function'
          ? sshConnectionPool.getConnectedManagerForEndpoint(targetHint)
          : null) || sshConnectionPool.getManagerForTarget(targetHint);
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
      remoteGateway: getActiveRemoteGatewayInfo()
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
      log: (m) => log.info(m)
    });
    if (r.ok && r.reconnected) {
      log.info(`SSH auto reconnect OK (${reason}): ${target.username}@${target.host}`);
      if (opts.ensureGateway !== false && sessionRemoteTransport) {
        try {
          await sessionRemoteTransport.ensureRemoteGatewayForTarget(target);
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
    const viewTarget = localGateway?.getEffectiveWorkspaceTarget?.();
    const leased =
      sessionRemoteTransport?.getLeasedSshTargets ? sessionRemoteTransport.getLeasedSshTargets() : [];
    return collectSshReconnectTargets(viewTarget, leased);
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
        batch.map((t) =>
          tryReconnectSshTarget(t, reason, {
            ensureGateway: opts.ensureGateway !== false
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
    const r = await tryReconnectSshTarget(target, reason, opts);
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

    const prevInfo = getActiveRemoteGatewayInfo();
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
        const infoAfter = getActiveRemoteGatewayInfo();
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
        if (prevInfo && (prevInfo.token !== info.token || prevInfo.url !== info.url)) {
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

module.exports = { createSshReconnect, collectSshReconnectTargets };
