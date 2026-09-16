'use strict';

const {
  isSameSshTarget,
  normalizeRemotePath,
  sshGatewayKey,
  sshTargetKey
} = require('../workspace/target');

/**
 * @param {{
 *   localGateway: import('../gateway/server').LocalGateway | null,
 *   sshPool: ReturnType<import('../ssh/connection-pool').createSshConnectionPool> | null,
 *   remoteGatewayPool: ReturnType<import('../ssh/remote-gateway-pool').createRemoteGatewayPool> | null,
 *   sshFacade: ReturnType<ReturnType<import('../ssh/connection-pool').createSshConnectionPool>['createFacade']> | null,
 *   sshCredentialsStore: ReturnType<import('../ssh/credentials-store').createSshCredentialsStore> | null,
 *   tryAutoReconnectSsh: typeof import('../ssh/auto-reconnect').tryAutoReconnectSsh,
 *   buildRemoteGatewayPackContext: () => Promise<object>,
 *   invalidateRemoteAgentClient: (info?: { url?: string, token?: string }) => void,
 *   log?: (msg: string) => void
 * }} deps
 */
function createSessionRemoteTransport(deps) {
  /** @type {Map<string, { target: object, refCount: number }>} */
  const sessionLeases = new Map();
  /** @type {import('../workspace/target').WorkspaceTarget | null} */
  let activeViewTarget = null;

  function isRemoteTarget(target) {
    return !!(target && target.kind === 'ssh');
  }

  function snapshotTarget(target) {
    if (!target) return null;
    if (target.kind === 'ssh') {
      return {
        kind: 'ssh',
        host: target.host,
        port: target.port,
        username: target.username,
        remotePath: normalizeRemotePath(target.remotePath || '/')
      };
    }
    if (target.kind === 'local') {
      return { kind: 'local', path: target.path || '' };
    }
    return { ...target };
  }

  function sameViewTransport(a, b) {
    if (!a && !b) return true;
    if (!a || !b) return false;
    if (a.kind !== b.kind) return false;
    if (a.kind === 'local') return String(a.path || '') === String(b.path || '');
    if (a.kind === 'ssh') {
      return sshTargetKey(a) === sshTargetKey(b);
    }
    return false;
  }

  function isEndpointLeased(target) {
    if (!target || target.kind !== 'ssh') return false;
    for (const lease of sessionLeases.values()) {
      if (lease.target.kind === 'ssh' && isSameSshTarget(lease.target, target)) return true;
    }
    return false;
  }

  function getRemoteAgentInfoForSession(sessionId) {
    const sid =
      sessionId != null && String(sessionId).trim()
        ? String(sessionId).trim()
        : deps.localGateway?.activeSessionId
          ? String(deps.localGateway.activeSessionId)
          : null;
    if (!sid || !deps.localGateway) return null;

    const target = deps.localGateway.getSessionWorkspaceTarget(sid);
    if (!target || target.kind !== 'ssh') {
      return null;
    }

    if (deps.remoteGatewayPool) {
      return deps.remoteGatewayPool.getInfoForTarget(target);
    }
    return null;
  }

  function anyRemoteLeaseHeld() {
    return sessionLeases.size > 0;
  }

  function anyLeaseHeldForKind(kind) {
    const k = String(kind || '').trim();
    if (!k) return false;
    for (const lease of sessionLeases.values()) {
      if (lease.target.kind === k) return true;
    }
    return false;
  }

  function hasLeaseForTarget(target) {
    if (!target) return false;
    for (const lease of sessionLeases.values()) {
      if (sameViewTransport(target, lease.target)) return true;
    }
    return false;
  }

  function listLeaseSessionIdsForTarget(target) {
    if (!target) return [];
    const out = [];
    for (const [sid, lease] of sessionLeases.entries()) {
      if (sameViewTransport(target, lease.target)) out.push(sid);
    }
    return out;
  }

  /**
   * Drop all session leases for a target (used by forced SSH disconnect).
   * Releases pool refs once per lease, then clears lease map entries.
   */
  function dropLeasesForTarget(target) {
    if (!target) return [];
    const dropped = [];
    for (const [sid, lease] of [...sessionLeases.entries()]) {
      if (!sameViewTransport(target, lease.target)) continue;
      sessionLeases.delete(sid);
      dropped.push(sid);
      if (lease.target.kind === 'ssh') {
        if (deps.remoteGatewayPool) deps.remoteGatewayPool.releaseForTarget(lease.target);
        if (deps.sshPool) deps.sshPool.release(lease.target);
      }
    }
    return dropped;
  }

  async function setSessionRemoteLease(sessionId, active, target) {
    const sid = String(sessionId || '').trim();
    if (!sid) return;
    if (active && target && isRemoteTarget(target)) {
      const prev = sessionLeases.get(sid);
      const snap = snapshotTarget(target);
      if (prev) {
        // Same session hold is boolean, not nested refCount — avoid sticky lease after double-acquire.
        if (sameViewTransport(prev.target, snap)) {
          return;
        }
        // Workspace path changed mid-run: release old then re-hold.
        sessionLeases.delete(sid);
        if (prev.target.kind === 'ssh') {
          if (deps.remoteGatewayPool) deps.remoteGatewayPool.releaseForTarget(prev.target);
          if (deps.sshPool) deps.sshPool.release(prev.target);
        }
      }
      sessionLeases.set(sid, { target: snap, refCount: 1 });
      if (target.kind === 'ssh') {
        const ok = await ensureSshForTarget(target, { acquire: true });
        if (ok) {
          try {
            await ensureRemoteGatewayForTarget(target);
          } catch (e) {
            const log = deps.log || (() => {});
            log('session remote lease gateway: ' + (e && e.message ? e.message : String(e)));
          }
        }
      }
      return;
    }
    const lease = sessionLeases.get(sid);
    if (!lease) return;
    // Release is session-level: drop the whole lease (matches single hold on activate).
    sessionLeases.delete(sid);
    if (lease.target.kind === 'ssh') {
      if (deps.remoteGatewayPool) deps.remoteGatewayPool.releaseForTarget(lease.target);
      if (deps.sshPool) deps.sshPool.release(lease.target);
    }
  }

  async function ensureSshForTarget(target, opts = {}) {
    const acquire = opts.acquire !== false;
    if (!deps.sshPool || !target || target.kind !== 'ssh') return false;
    if (deps.sshPool.isConnected(target)) {
      if (acquire) deps.sshPool.acquire(target);
      return true;
    }
    if (typeof deps.sshPool.getConnectedManagerForEndpoint === 'function') {
      const shared = deps.sshPool.getConnectedManagerForEndpoint(target);
      if (shared && shared.status && shared.status().connected) {
        return true;
      }
    }
    if (!deps.tryAutoReconnectSsh || !deps.sshCredentialsStore || !deps.localGateway || !deps.sshFacade) {
      return false;
    }
    const r = await deps.tryAutoReconnectSsh({
      localGateway: deps.localGateway,
      sshSessionManager: deps.sshFacade,
      sshPool: deps.sshPool,
      target,
      credentialsStore: deps.sshCredentialsStore,
      log: deps.log || (() => {})
    });
    if (!r.ok) return false;
    if (deps.sshPool.isConnected(target)) {
      try {
        if (acquire) deps.sshPool.acquire(target);
      } catch {
        return false;
      }
    } else if (acquire) {
      deps.sshPool.acquire(target);
    }
    return true;
  }

  async function ensureRemoteGatewayForTarget(target) {
    if (!target || target.kind !== 'ssh' || !deps.remoteGatewayPool || !deps.sshPool) return null;
    const manager =
      (typeof deps.sshPool.getConnectedManagerForEndpoint === 'function'
        ? deps.sshPool.getConnectedManagerForEndpoint(target)
        : null) || deps.sshPool.getManagerForTarget(target);
    if (!manager || !manager.status().connected) return null;
    if (deps.remoteGatewayPool.isActiveForTarget(target)) {
      return deps.remoteGatewayPool.getInfoForTarget(target);
    }
    const ctx = await deps.buildRemoteGatewayPackContext();
    return deps.remoteGatewayPool.ensureForTarget(target, manager, ctx);
  }

  /**
   * Drop the view-level SSH pool hold. Do not stop Remote Agent or the TCP
   * session: conversation switches should keep the connection in the background
   * until explicit disconnect / idle eviction / app quit.
   */
  async function releaseViewSshTransport(target) {
    if (!target || target.kind !== 'ssh') return;
    if (deps.sshPool) deps.sshPool.release(target);
  }

  async function releaseInactiveViewTransport(prevTarget, nextTarget) {
    if (!prevTarget || sameViewTransport(prevTarget, nextTarget)) return;
    if (prevTarget.kind === 'ssh') {
      await releaseViewSshTransport(prevTarget);
    }
  }

  function getLeasedSshTargets() {
    const seen = new Set();
    const out = [];
    for (const lease of sessionLeases.values()) {
      if (lease.target.kind !== 'ssh') continue;
      const ek = sshGatewayKey(lease.target);
      if (!ek || seen.has(ek)) continue;
      seen.add(ek);
      out.push(lease.target);
    }
    return out;
  }

  function getLeasedSessionIds() {
    return [...sessionLeases.keys()];
  }

  async function applySessionRemoteTransport(sessionId) {
    const log = deps.log || (() => {});
    if (!deps.localGateway) return { ok: false, reason: 'no_gateway' };
    const sid = sessionId ? String(sessionId).trim() : '';
    if (!sid) return { ok: true, kind: 'none' };

    const prevTarget = activeViewTarget;
    const target =
      (typeof deps.localGateway.getSessionWorkspaceTarget === 'function'
        ? deps.localGateway.getSessionWorkspaceTarget(sid)
        : null) || deps.localGateway.getEffectiveWorkspaceTarget();
    const nextTarget = snapshotTarget(target);

    if (!target) {
      await releaseInactiveViewTransport(prevTarget, null);
      activeViewTarget = null;
      return { ok: true, kind: 'none', keptTransport: anyRemoteLeaseHeld() };
    }

    if (target.kind === 'local') {
      await releaseInactiveViewTransport(prevTarget, nextTarget);
      const keptIdle = !!(prevTarget && prevTarget.kind === 'ssh');
      const kept = anyRemoteLeaseHeld() || keptIdle;
      activeViewTarget = nextTarget;
      return { ok: true, kind: 'local', keptTransport: kept };
    }

    if (target.kind === 'ssh') {
      await releaseInactiveViewTransport(prevTarget, nextTarget);
      const needsAcquire = !sameViewTransport(prevTarget, nextTarget);
      const ok = await ensureSshForTarget(target, { acquire: needsAcquire });
      if (!ok) {
        activeViewTarget = nextTarget;
        return { ok: false, kind: 'ssh', reason: 'not_connected' };
      }
      try {
        await ensureRemoteGatewayForTarget(target);
      } catch (e) {
        log('session ssh remote gateway: ' + (e && e.message ? e.message : String(e)));
      }
      activeViewTarget = nextTarget;
      return { ok: true, kind: 'ssh', connected: true };
    }

    activeViewTarget = nextTarget;
    return { ok: true, kind: 'unknown' };
  }

  return {
    getRemoteAgentInfoForSession,
    applySessionRemoteTransport,
    setSessionRemoteLease,
    anyRemoteLeaseHeld,
    anyLeaseHeldForKind,
    hasLeaseForTarget,
    listLeaseSessionIdsForTarget,
    dropLeasesForTarget,
    ensureSshForTarget,
    ensureRemoteGatewayForTarget,
    getActiveViewTarget: () => activeViewTarget,
    getLeasedSshTargets,
    getLeasedSessionIds,
    isEndpointLeased
  };
}

module.exports = { createSessionRemoteTransport };
