'use strict';

const { createSshSessionManager } = require('./session-manager');
const { sshTargetKey } = require('../workspace/target');

/**
 * 一条 SSH 连接对应**一个端点**（user@host:port）。
 *
 * 旧实现按 `user@host:port|remotePath` 分槽：同一台机器上的两个会话（各自一份 worktree =
 * 两个 remotePath）会各开一条 TCP + exec 链，于是同一份连接身份被复制成 N 份 ——
 * 断开要不要断、谁在用它、refCount 该记在哪个键上，全都变成判断题（已经出过一次
 * acquire 用仓库键、release 用 worktree 键的泄漏）。
 * 连接是端点级资源，路径级状态（工作目录、索引、agent 端口）都属于调用方。
 */
function poolKeyForTarget(target) {
  return sshTargetKey(target);
}

/**
 * @param {{
 *   userDataPath?: string,
 *   maxConnections?: number,
 *   idleTtlMs?: number,
 *   log?: (msg: string) => void,
 *   onTargetClose?: (targetKey: string) => void
 * }} opts
 */
function createSshConnectionPool(opts = {}) {
  const log = opts.log || (() => {});
  const maxConnections = Math.max(1, Number(opts.maxConnections) || 4);
  const idleTtlMs = Math.max(30_000, Number(opts.idleTtlMs) || 5 * 60 * 1000);
  /** @type {Map<string, { manager: ReturnType<createSshSessionManager>, refCount: number, lastUsedAt: number }>} */
  const entries = new Map();

  function getEntry(targetKey) {
    return targetKey ? entries.get(targetKey) || null : null;
  }

  /** 端点对应的连接对象（不管连没连上） */
  function getManagerForTarget(target) {
    const key = poolKeyForTarget(target);
    if (!key) return null;
    const entry = entries.get(key);
    return entry ? entry.manager : null;
  }

  /** 端点对应的连接对象，但只有真连着才给 */
  function getConnectedManager(target) {
    const m = getManagerForTarget(target);
    return m && m.status().connected ? m : null;
  }

  function getLastConnectedManager() {
    // 后进先出：最近建立/使用的端点优先（entries 的插入顺序即创建顺序）
    for (const entry of [...entries.values()].reverse()) {
      if (entry?.manager?.status()?.connected) return entry.manager;
    }
    return null;
  }

  function isConnected(target) {
    const m = getManagerForTarget(target);
    return !!(m && m.status().connected);
  }

  function touchEntry(entry) {
    entry.lastUsedAt = Date.now();
  }

  async function evictIdle() {
    const now = Date.now();
    for (const [key, entry] of [...entries.entries()]) {
      if (entry.refCount > 0) continue;
      if (now - entry.lastUsedAt < idleTtlMs) continue;
      try {
        await entry.manager.disconnect();
      } catch {
        // ignore
      }
      // disconnect 有 await：期间可能有人 acquire 了同一条（refCount 变 1），
      // 也可能这个槽位已经被换成新对象。两种情况都不能删。
      const current = entries.get(key);
      if (current !== entry) continue;
      if (entry.refCount > 0) {
        log(`SSH pool keep ${key} (acquired during evict)`);
        continue;
      }
      entries.delete(key);
      log(`SSH pool evicted idle ${key}`);
    }
  }

  async function evictIfOverCap() {
    const connected = [...entries.entries()].filter(([, e]) => e.manager.status().connected);
    const over = connected.length - maxConnections;
    if (over <= 0) return;
    const candidates = connected
      .filter(([, e]) => e.refCount <= 0)
      .sort((a, b) => a[1].lastUsedAt - b[1].lastUsedAt);
    let evicted = 0;
    for (const [key, entry] of candidates) {
      if (evicted >= over) break;
      // 同样的道理：await 之后要重新确认这条还没被需要
      if (entries.get(key) !== entry || entry.refCount > 0) continue;
      try {
        await entry.manager.disconnect();
      } catch {
        // ignore
      }
      if (entries.get(key) !== entry || entry.refCount > 0) continue;
      entries.delete(key);
      evicted += 1;
      log(`SSH pool evicted over-cap ${key}`);
    }
  }

  function createManagerForKey(targetKey) {
    // 单测注入点：连接对象的生命周期（单飞、驱逐时二次校验、facade 不回落到别的主机）
    // 都是竞态行为，只能靠可控制的假 manager 锁住。
    if (typeof opts.createManager === 'function') return opts.createManager(targetKey);
    return createSshSessionManager({
      userDataPath: opts.userDataPath,
      log: (msg) => log(`[${targetKey}] ${msg}`),
      onClose: () => {
        try {
          if (typeof opts.onTargetClose === 'function') opts.onTargetClose(targetKey);
        } catch {
          // ignore
        }
      }
    });
  }

  /**
   * @param {import('../workspace/target').SshWorkspaceTarget} target
   * @param {object} [connectPayload]
   */
  async function ensureConnected(target, connectPayload) {
    const key = poolKeyForTarget(target);
    if (!key) {
      throw Object.assign(new Error('无效的 SSH 目标'), { code: 'SSH_INVALID_TARGET' });
    }
    let entry = entries.get(key);
    if (!entry) {
      entry = { manager: createManagerForKey(key), refCount: 0, lastUsedAt: Date.now() };
      entries.set(key, entry);
    }
    if (!entry.manager.status().connected) {
      if (!connectPayload) {
        const err = new Error('SSH 未连接');
        err.code = 'SSH_NOT_CONNECTED';
        throw err;
      }
      await entry.manager.connect(connectPayload);
    } else {
    }
    touchEntry(entry);
    await evictIfOverCap();
    return entry.manager;
  }

  /**
   * UI 手动连上的端点也是「有人要用」：记一个最小引用（幂等，不累加）。
   *
   * 否则这类连接 refCount 恒为 0，`evictIdle` 一旦在别处被 `release()` 触发，
   * 就会把用户明明连着的连接当成闲置回收掉（界面显示已连接、实际断了）。
   */
  function holdEndpoint(target) {
    const key = poolKeyForTarget(target);
    if (!key) return null;
    const entry = entries.get(key);
    if (!entry) return null;
    if (entry.refCount < 1) entry.refCount = 1;
    touchEntry(entry);
    return entry.manager;
  }

  async function acquire(target, connectPayload) {
    const key = poolKeyForTarget(target);
    if (!key) {
      throw Object.assign(new Error('无效的 SSH 目标'), { code: 'SSH_INVALID_TARGET' });
    }
    let entry = entries.get(key);
    if (!entry) {
      entry = { manager: createManagerForKey(key), refCount: 0, lastUsedAt: Date.now() };
      entries.set(key, entry);
    }
    entry.refCount += 1;
    try {
      await ensureConnected(target, connectPayload);
      return entry.manager;
    } catch (err) {
      entry.refCount = Math.max(0, entry.refCount - 1);
      throw err;
    }
  }

  /**
   * @param {import('../workspace/target').SshWorkspaceTarget} target
   */
  function release(target) {
    const key = poolKeyForTarget(target);
    if (!key) return;
    const entry = entries.get(key);
    if (!entry) return;
    entry.refCount = Math.max(0, entry.refCount - 1);
    touchEntry(entry);
    void evictIdle();
  }

  /**
   * @param {import('../workspace/target').SshWorkspaceTarget} target
   * @param {object} payload
   */
  async function connect(target, payload) {
    const m = await ensureConnected(target, payload);
    return m ? m.status() : { connected: false };
  }

  /**
   * 断开一个端点的连接（键就是端点，所以只有这一个断开动作）。
   * `force:false` 时只要还有人持有（refCount>0）就不动，避免把别的会话的连接掐掉。
   * @param {import('../workspace/target').SshWorkspaceTarget} target
   * @param {{ force?: boolean }} [opts]
   */
  async function disconnectEndpoint(target, opts = {}) {
    const key = poolKeyForTarget(target);
    if (!key) return;
    const entry = entries.get(key);
    if (!entry) return;
    if (opts.force !== true && entry.refCount > 0) {
      log(`SSH pool skip disconnect ${key} (refCount=${entry.refCount})`);
      return;
    }
    entry.refCount = 0;
    try {
      await entry.manager.disconnect();
    } catch {
      // 断开失败也要把槽位清掉：留着它只会让下一次 acquire 拿到死连接
    }
    entries.delete(key);
  }

  async function disconnectAll() {
    for (const [, entry] of [...entries.entries()]) {
      entry.refCount = 0;
      try {
        await entry.manager.disconnect();
      } catch {
        // ignore
      }
    }
    entries.clear();
  }

  /**
   * Facade for UI/terminal: routes to the active workspace SSH target.
   * @param {() => import('../workspace/target').WorkspaceTarget | null} getActiveTarget
   */
  function createFacade(getActiveTarget) {
    function activeTarget() {
      const t = getActiveTarget();
      return t && t.kind === 'ssh' ? t : null;
    }

    function activeManager() {
      const t = activeTarget();
      // 有明确的活动工作区时**不回落**：回落到「最近连上的端点」会让 browse / exec / 日志
      // 静默打到另一台主机上（而路径白名单用的是活动目标的根）。这里没连就报没连。
      if (t) return getConnectedManager(t);
      return getLastConnectedManager();
    }

    function requireActive() {
      const m = activeManager();
      if (!m || !m.status().connected) {
        const err = new Error('SSH 未连接，请在工作空间菜单中重新连接远程主机');
        err.code = 'SSH_NOT_CONNECTED';
        throw err;
      }
      return m;
    }

    return {
      connect: async (payload) => {
        const active = activeTarget();
        const sameHost =
          active &&
          active.kind === 'ssh' &&
          active.host === payload.host &&
          (Number(active.port) || 22) === (Number(payload.port) || 22) &&
          active.username === payload.username;
        const target = {
          kind: 'ssh',
          host: payload.host,
          port: Number(payload.port) || 22,
          username: payload.username,
          remotePath: sameHost ? active.remotePath || '/' : payload.remotePath || '/'
        };
        const existing = getConnectedManager(target);
        if (existing) {
          // 键就是端点，走到这里就说明「同一个端点已经连着」——不必再比对 host/port，
          // 只要补上持有标记，别让闲置回收把用户手动连上的连接掐掉
          holdEndpoint(target);
          return existing.status();
        }
        const st = await connect(target, payload);
        holdEndpoint(target);
        return st;
      },
      disconnect: async () => {
        const t = activeTarget();
        if (t) {
          await disconnectEndpoint(t, { force: true });
          return;
        }
        const last = getLastConnectedManager();
        if (last) {
          const st = last.status();
          await disconnectEndpoint(
            {
              kind: 'ssh',
              host: st.host,
              port: st.port,
              username: st.username,
              remotePath: '/'
            },
            { force: true }
          );
        }
      },
      status: () => {
        const m = activeManager();
        return m ? m.status() : { connected: false };
      },
      browse: (...args) => requireActive().browse(...args),
      resolveHomeDir: (...args) => requireActive().resolveHomeDir(...args),
      primeHomeDir: (...args) => requireActive().primeHomeDir(...args),
      // 同步读缓存：路径白名单要在非 async 处拼兜底根（见 remote-path.remoteAllowedRoots）
      getHomeDir: () => {
        const m = activeManager();
        return m && typeof m.getHomeDir === 'function' ? m.getHomeDir() : '';
      },
      sftpReaddir: (...args) => requireActive().sftpReaddir(...args),
      sftpReadFile: (...args) => requireActive().sftpReadFile(...args),
      sftpWriteFile: (...args) => requireActive().sftpWriteFile(...args),
      sftpRename: (...args) => requireActive().sftpRename(...args),
      sftpUnlink: (...args) => requireActive().sftpUnlink(...args),
      sftpMkdirp: (...args) => requireActive().sftpMkdirp(...args),
      sftpStat: (...args) => requireActive().sftpStat(...args),
      exec: (...args) => requireActive().exec(...args),
      execScript: (...args) => requireActive().execScript(...args),
      openShell: (...args) => requireActive().openShell(...args),
      assertConnected: () => requireActive(),
      getClient: () => requireActive().getClient(),
      getSftp: () => requireActive().getSftp()
    };
  }

  function statusFromManager(m) {
    if (!m) return null;
    const st = m.status();
    if (!st || !st.connected) return null;
    return { host: st.host, port: st.port, username: st.username, authType: st.authType || null };
  }

  function findConnectedEndpoint(hint) {
    if (hint && hint.host && hint.username) {
      const m = getConnectedManager({
        kind: 'ssh',
        host: hint.host,
        port: Number(hint.port) || 22,
        username: hint.username,
        remotePath: hint.remotePath || '/'
      });
      const ep = statusFromManager(m);
      if (ep) return ep;
    }
    return statusFromManager(getLastConnectedManager());
  }

  return {
    acquire,
    release,
    connect,
    getManagerForTarget,
    getConnectedManager,
    holdEndpoint,
    getLastConnectedManager,
    isConnected,
    disconnectEndpoint,
    disconnectAll,
    createFacade,
    getEntry,
    findConnectedEndpoint
  };
}

module.exports = { createSshConnectionPool };
