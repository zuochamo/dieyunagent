'use strict';

const { isSameSshTarget, normalizeRemotePath, sshTargetKey, workspacePathForSession } = require('../workspace/target');
const { ensureSessionWorktree } = require('./session-worktree');
const { remoteWorktreePath, repoRemotePathOf } = require('../ssh/remote-worktree');

/**
 * 视图侧「后台确保」的去重时间上限：同 (会话, 目标路径) 在这段时间内只发一次。
 * 超过就允许再发 —— 远端 exec 单条最长可等 10 分钟，卡住的 ensure 不该永久占住 key。
 */
const VIEW_ENSURE_DEDUPE_MS = 60 * 1000;

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
  /** 视图侧后台确保的在飞表（key = 会话|目标路径）：只挡重复，见 ensureRemoteGatewayInBackground */
  const viewEnsureInFlight = new Map();  /** @type {import('../workspace/target').WorkspaceTarget | null} */
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
      // 「哪些会话正在用远端」只有租约表知道：回收过期 worktree 必须把它们全部保住
      listLeasedSessionIds: () => [...sessionLeases.keys()],
      log: deps.log
    });
  }

  async function setSessionRemoteLease(sessionId, active, target) {
    const sid = String(sessionId || '').trim();
    if (!sid) return '';
    if (active && target && isRemoteTarget(target)) {
      const prev = sessionLeases.get(sid);
      if (prev && sameViewTransport(prev.target, target)) {
        // 端点已持有：refCount 不变，但仍补一次 worktree（首次激活时可能还没连上）
        const effective = await withSessionWorktree(sid, target);
        sessionLeases.set(sid, { ...prev, target: snapshotTarget(effective) });
        // 返回值是**生效后**的会话工作区：租约可能把会话切进 worktree，渲染端缓存的是
        // 租约之前的值，不告诉它就会拿着旧根去查索引（根不一致 → 面板「状态暂不可用」）。
        return workspacePathForSession(effective) || '';
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
          await ensureRemoteGatewayForTarget(effective, sid);
        } catch (e) {
          const log = deps.log || (() => {});
          log('session remote lease gateway: ' + (e && e.message ? e.message : String(e)));
        }
      }
      return workspacePathForSession(effective) || '';
    }
    const lease = sessionLeases.get(sid);
    if (!lease) return '';
    // Release is session-level: drop the whole lease (matches single hold on activate).
    sessionLeases.delete(sid);
    if (lease.target.kind === 'ssh') {
      if (deps.remoteGatewayPool) deps.remoteGatewayPool.releaseForTarget(lease.target);
      // 只在真记过引用时释放（见 setSessionRemoteLease 里 acquired 的注释）
      if (deps.sshPool && lease.acquired) deps.sshPool.release(lease.target);
    }
    return '';
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

  /**
   * 起/复用某条 SSH 端点上的远端 Agent 槽位。
   *
   * `sessionId` 必须由调用方给：以前缺省时用「按端点反查会话」补（端点只认
   * `user@host:port`，不含仓库），同机多仓库时会把**别的会话**挑出来，接着
   * `withSessionWorktree(别人的会话, 这个仓库)` 在该仓库里建一份别人的 worktree，
   * 并把仓库路径写回别人的会话工作区 —— 历史分组跟着跳到另一个项目，
   * 远端 agent 也可能被起在错仓库的 worktree 上。
   *
   * 没有会话身份时只起槽位、不建 worktree、不碰任何会话工作区（拿到的仍是传进来的目标）。
   *
   * @param {object} target 端点目标；可以是仓库根，也可以已是该会话的 worktree
   * @param {string} [sessionId] 会话身份（唯一来源是调用方手里的 sessionId）
   */
  async function ensureRemoteGatewayForTarget(target, sessionId) {
    if (!target || target.kind !== 'ssh' || !deps.remoteGatewayPool) return null;
    const manager = sshManagerForTarget(target);
    if (!manager) return null;
    // 不要在这里先看 isActiveForTarget：那个布尔不能证明隧道/对端还活着，
    // 幂等 + 活体探测统一由 manager.ensureRemoteGateway 判定（单一来源）。
    // 重连等外部入口传进来的是仓库根：先换成本会话的 worktree，再按它分槽起 agent
    const sid = String(sessionId || '').trim();
    let effective = target;
    if (sid) {
      const wtPath = remoteWorktreePath(repoRemotePathOf(target.remotePath), sid);
      if (normalizeRemotePath(target.remotePath) !== wtPath) {
        effective = (await withSessionWorktree(sid, target)) || target;
      }
    }
    const ctx = await deps.buildRemoteGatewayPackContext();
    return deps.remoteGatewayPool.ensureForTarget(effective, manager, ctx);
  }

  /**
   * 视图切换用的「后台确保」：worktree 检查与 agent 槽位仍在后台建，但**同一份目标只发一次**。
   *
   * 为什么需要这一层：那两件活都要排进 `session-manager` 的每连接串行 exec 链，快速连点几个
   * 会话就会把同一份 worktree 检查重复堆在链上（实测队列深度涨到 5）。这里只挡重复，不改变
   * 语义 —— 每个 (会话, 目标路径) 同时最多一条在飞，落地后立刻从表里摘掉（失败也只记日志）。
   *
   * 去重有**时间上限**（{@link VIEW_ENSURE_DEDUPE_MS}）：远端 exec 单条最长可等 10 分钟，
   * 一条卡住的 ensure 若永久占着 key，这个会话的后台确保就再也不发了（远端 agent 起不来 →
   * 工具静默退到 SFTP）。超龄后允许再发一条，代价最多是重复一次幂等检查。
   *
   * @param {object} target
   * @param {string} sessionId
   */
  function ensureRemoteGatewayInBackground(target, sessionId) {
    if (!target || !deps.remoteGatewayPool) return null;
    const key = `${String(sessionId || '').trim()}|${normalizeRemotePath(target.remotePath || '/')}`;
    const prev = viewEnsureInFlight.get(key);
    if (prev && Date.now() - prev.at < VIEW_ENSURE_DEDUPE_MS) return prev.promise;
    let promise = null;
    promise = ensureRemoteGatewayForTarget(target, sessionId)
      .catch((e) => {
        // 后台失败不影响视图；下一次切换或真正开跑时还会再试
        const log = deps.log || (() => {});
        log('session ssh remote gateway: ' + (e && e.message ? e.message : String(e)));
        return null;
      })
      .finally(() => {
        if (viewEnsureInFlight.get(key) && viewEnsureInFlight.get(key).promise === promise) {
          viewEnsureInFlight.delete(key);
        }
      });
    viewEnsureInFlight.set(key, { promise, at: Date.now() });
    return promise;
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

  /**
   * 重连要的是「哪条会话跑在哪个目标上」：只有目标时端点（user@host:port）分不出会话，
   * 同机多仓库就会串仓（见 `ensureRemoteGatewayForTarget`）。
   * @returns {Array<{ sessionId: string, target: object }>}
   */
  function getLeasedTargets() {
    const out = [];
    for (const [sessionId, lease] of sessionLeases) {
      if (!lease.target || lease.target.kind !== 'ssh') continue;
      out.push({ sessionId, target: lease.target });
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
      // 视图切换只做「这条会话属于哪条连接」这一件事，**不等任何远端命令**。
      //
      // 以前这里 await 了两件远端活：worktree 幂等检查（`git rev-parse` + `test -d`）与 agent
      // 槽位部署。两者都走 `session-manager` 的每连接串行 exec 链，于是「另一个会话正在跑一个
      // 长 host_exec」时，切换要排在那条命令后面 —— 真机实测：一次切换 57.3s，其中 56.4s 全在
      // 等一条 60s 的远端命令（`[perf] sh-exec wait=56450ms`，改后同场景 31–44ms）。
      //
      // 现在：连接与引用照旧（断开/回收仍靠它），worktree 与 agent 槽位仍按需建立，但在**后台**
      // 建 —— `ensureRemoteGatewayForTarget` 内部照旧先落到本会话 worktree（`withSessionWorktree`），
      // 最终状态不变，只是不把界面卡在串行链上。真正要用远端的入口（`setSessionRemoteLease`
      // 开跑前、RPC 自愈 `healRemoteAgentTransport`）仍会 await，那里等得起。
      await releaseInactiveViewTransport(prevTarget, nextTarget);
      const needsAcquire = !sameViewTransport(prevTarget, nextTarget);
      const ok = await ensureSshForTarget(target, { acquire: needsAcquire });
      activeViewTarget = nextTarget;
      if (!ok) {
        return { ok: false, kind: 'ssh', reason: 'not_connected' };
      }
      void ensureRemoteGatewayInBackground(target, sid);
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
    getLeasedTargets,
    getLeasedSessionIds,
    isEndpointLeased
  };
}

module.exports = { createSessionRemoteTransport };
