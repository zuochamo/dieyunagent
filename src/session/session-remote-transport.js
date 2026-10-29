'use strict';

const {
  isSameSshTarget,
  normalizeRemotePath,
  sshGatewayKey,
  sshTargetKey
} = require('../workspace/target');
const { ensureSessionWorktree } = require('./session-worktree');
const { remoteWorktreePath, repoRemotePathOf } = require('../ssh/remote-worktree');

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
        // 只在真记过引用时释放（见上面 acquired 的注释）
        if (deps.sshPool && lease.acquired) deps.sshPool.release(lease.target);
      }
    }
    return dropped;
  }

  /**
   * SSH manager 查询的唯一入口（假 pool / 精简注入只保证部分方法存在）。
   * @returns {object | null} 已连通的 manager
   */
  function sshManagerForTarget(target) {
    if (!deps.sshPool || !target || target.kind !== 'ssh') return null;
    const pool = deps.sshPool;
    const m = pool.getConnectedManager(target) || pool.getManagerForTarget(target);
    return m && typeof m.status === 'function' && m.status().connected ? m : null;
  }

  /**
   * 会话开始用远端之前，把它落到自己那份 worktree（幂等）。
   * 必须在租约快照之前调用：租约、pool 槽位、端口、日志名都按 remotePath 分。
   */
  async function withSessionWorktree(sid, target) {
    if (!deps.localGateway || !isRemoteTarget(target)) return target;
    const manager = sshManagerForTarget(target);
    if (!manager) return target;
    return ensureSessionWorktree({
      localGateway: deps.localGateway,
      sshManager: manager,
      sessionId: sid,
      target,
      log: deps.log
    });
  }

  async function setSessionRemoteLease(sessionId, active, target) {
    const sid = String(sessionId || '').trim();
    if (!sid) return;
    if (active && target && isRemoteTarget(target)) {
      const prev = sessionLeases.get(sid);
      if (prev && sameViewTransport(prev.target, target)) {
        // 端点已持有：refCount 不变，但仍补一次 worktree（首次激活时可能还没连上）
        await withSessionWorktree(sid, target);
        return;
      }
      if (prev) {
        // Workspace path changed mid-run: release old then re-hold.
        sessionLeases.delete(sid);
        if (prev.target.kind === 'ssh') {
          if (deps.remoteGatewayPool) deps.remoteGatewayPool.releaseForTarget(prev.target);
          if (deps.sshPool && prev.acquired) deps.sshPool.release(prev.target);
        }
      }
      const ok = await ensureSshForTarget(target, { acquire: true });
      const effective = ok ? await withSessionWorktree(sid, target) : target;
      // 连接池一条连接对应一个端点：worktree 改写只换 remotePath，端点没变，
      // 所以记引用和放引用永远是同一个键（不再需要 holdTarget 那种「两把 key」补丁）。
      // acquired 记录「这一次真的记过引用」：没连上时也保留租约（视图仍属于远端），
      // 但释放时不能去减一个从没加过的计数（端点唯一之后计数是端点共享的）。
      sessionLeases.set(sid, {
        target: snapshotTarget(effective),
        acquired: ok,
        refCount: 1
      });
      if (ok) {
        try {
          await ensureRemoteGatewayForTarget(effective);
        } catch (e) {
          const log = deps.log || (() => {});
          log('session remote lease gateway: ' + (e && e.message ? e.message : String(e)));
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
      // 只在真记过引用时释放（见 setSessionRemoteLease 里 acquired 的注释）
      if (deps.sshPool && lease.acquired) deps.sshPool.release(lease.target);
    }
  }

  async function ensureSshForTarget(target, opts = {}) {
    const acquire = opts.acquire !== false;
    if (!deps.sshPool || !target || target.kind !== 'ssh') return false;
    if (deps.sshPool.isConnected(target)) {
      // acquire 是 async：不 await 会漏掉 rejection，且拿不到「引用已记上」的确认
      if (acquire) await deps.sshPool.acquire(target);
      return true;
    }
    if (typeof deps.sshPool.getConnectedManager === 'function') {
      const shared = deps.sshPool.getConnectedManager(target);
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
      getSshConfigBlocks: deps.getSshConfigBlocks,
      log: deps.log || (() => {})
    });
    if (!r.ok) return false;
    if (!acquire) return true;
    try {
      await deps.sshPool.acquire(target);
    } catch {
      return false;
    }
    return true;
  }

  /** 这个端点当前归哪个会话：租约优先，其次当前会话（端点一致才算） */
  function sessionIdForTarget(target) {
    const leased = listLeaseSessionIdsForTarget(target);
    if (leased.length) return leased[0];
    const active = deps.localGateway && deps.localGateway.activeSessionId;
    if (!active) return '';
    const t =
      deps.localGateway && typeof deps.localGateway.getSessionWorkspaceTarget === 'function'
        ? deps.localGateway.getSessionWorkspaceTarget(active)
        : null;
    return t && t.kind === 'ssh' && isSameSshTarget(t, target) ? String(active) : '';
  }

  async function ensureRemoteGatewayForTarget(target, sessionId) {
    if (!target || target.kind !== 'ssh' || !deps.remoteGatewayPool) return null;
    const manager = sshManagerForTarget(target);
    if (!manager) return null;
    // 不要在这里先看 isActiveForTarget：那个布尔不能证明隧道/对端还活着，
    // 幂等 + 活体探测统一由 manager.ensureRemoteGateway 判定（单一来源）。
    // 重连等外部入口传进来的是仓库根：先换成本会话的 worktree，再按它分槽起 agent
    const sid = String(sessionId || '').trim() || sessionIdForTarget(target);
    const wtPath = sid ? remoteWorktreePath(repoRemotePathOf(target.remotePath), sid) : '';
    const resolved = sid && normalizeRemotePath(target.remotePath) !== wtPath ? await withSessionWorktree(sid, target) : target;
    const effective = resolved || target;
    const ctx = await deps.buildRemoteGatewayPackContext();
    return deps.remoteGatewayPool.ensureForTarget(effective, manager, ctx);
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
      // 连上之后才知道该会话跑在哪份 worktree 上；pool 槽位 / 端口 / agent 全按它分
      const effective = await withSessionWorktree(sid, target);
      try {
        await ensureRemoteGatewayForTarget(effective);
      } catch (e) {
        log('session ssh remote gateway: ' + (e && e.message ? e.message : String(e)));
      }
      activeViewTarget = snapshotTarget(effective);
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
