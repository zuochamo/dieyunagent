'use strict';

const { createSshSessionManager } = require('./session-manager');
const { sshGatewayKey, sshTargetKey } = require('../workspace/target');

/** Scheme B: one TCP + exec chain per host+remotePath (parallel agents on same host). */
function poolKeyForTarget(target) {
  return sshGatewayKey(target);
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
  /** @type {string} */
  let lastConnectedKey = '';

  function listTargetKeys() {
    return [...entries.keys()];
  }

  function getEntry(targetKey) {
    return targetKey ? entries.get(targetKey) || null : null;
  }

  function getManagerForTarget(target) {
    const key = poolKeyForTarget(target);
    if (!key) return null;
    const entry = entries.get(key);
    return entry ? entry.manager : null;
  }

  function endpointPrefixFor(target) {
    const tk = sshTargetKey(target);
    return tk ? `${tk}|` : '';
  }

  function getConnectedManagerForEndpoint(target) {
    const exact = getManagerForTarget(target);
    if (exact && exact.status().connected) return exact;
    const prefix = endpointPrefixFor(target);
    if (!prefix) return null;
    if (lastConnectedKey && lastConnectedKey.startsWith(prefix)) {
      const last = entries.get(lastConnectedKey);
      if (last?.manager?.status()?.connected) return last.manager;
    }
    for (const [key, entry] of entries) {
      if (!key.startsWith(prefix)) continue;
      if (entry?.manager?.status()?.connected) return entry.manager;
    }
    return null;
  }

  function getLastConnectedManager() {
    if (lastConnectedKey) {
      const entry = entries.get(lastConnectedKey);
      if (entry?.manager?.status()?.connected) return entry.manager;
    }
    for (const [, entry] of entries) {
      if (entry?.manager?.status()?.connected) return entry.manager;
    }
    return null;
  }

  function isConnected(target) {
    const m = getManagerForTarget(target);
    return !!(m && m.status().connected);
  }

  function markConnected(key) {
    if (key) lastConnectedKey = key;
  }

  function clearLastIfKey(key) {
    if (key && lastConnectedKey === key) lastConnectedKey = '';
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
      entries.delete(key);
      clearLastIfKey(key);
      log(`SSH pool evicted idle ${key}`);
    }
  }

  async function evictIfOverCap() {
    const connected = [...entries.entries()].filter(([, e]) => e.manager.status().connected);
    if (connected.length <= maxConnections) return;
    const candidates = connected
      .filter(([, e]) => e.refCount <= 0)
      .sort((a, b) => a[1].lastUsedAt - b[1].lastUsedAt);
    for (const [key, entry] of candidates) {
      if (entries.size <= maxConnections) break;
      try {
        await entry.manager.disconnect();
      } catch {
        // ignore
      }
      entries.delete(key);
      clearLastIfKey(key);
      log(`SSH pool evicted over-cap ${key}`);
    }
  }

  function createManagerForKey(targetKey) {
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
      markConnected(key);
    } else {
      markConnected(key);
    }
    touchEntry(entry);
    await evictIfOverCap();
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
   * @param {import('../workspace/target').SshWorkspaceTarget} target
   * @param {{ force?: boolean }} [opts]
   */
  async function disconnectTarget(target, opts = {}) {
    const force = opts.force === true;
    const key = poolKeyForTarget(target);
    if (!key) return;
    const entry = entries.get(key);
    if (!entry) return;
    if (!force && entry.refCount > 0) {
      log(`SSH pool skip disconnect ${key} (refCount=${entry.refCount})`);
      return;
    }
    entry.refCount = 0;
    await entry.manager.disconnect();
    entries.delete(key);
    clearLastIfKey(key);
  }

  async function disconnectEndpoint(target, opts = {}) {
    const prefix = endpointPrefixFor(target);
    if (!prefix) {
      await disconnectTarget(target, opts);
      return;
    }
    for (const key of [...entries.keys()]) {
      if (!key.startsWith(prefix)) continue;
      const entry = entries.get(key);
      if (!entry) continue;
      if (!opts.force && entry.refCount > 0) continue;
      entry.refCount = 0;
      try {
        await entry.manager.disconnect();
      } catch {
        // ignore
      }
      entries.delete(key);
      clearLastIfKey(key);
    }
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
    lastConnectedKey = '';
  }

  /**
   * 断开未在 keepKeys 中的 SSH 端点（refCount 为 0 时）；供会话切换释放视图传输层。
   * @param {Set<string>} keepKeys sshGatewayKey 集合
   */
  async function disconnectExceptEndpointKeys(keepKeys) {
    const keep = keepKeys instanceof Set ? keepKeys : new Set();
    for (const key of listTargetKeys()) {
      if (keep.has(key)) continue;
      const entry = entries.get(key);
      if (!entry || entry.refCount > 0) continue;
      try {
        await entry.manager.disconnect();
      } catch {
        // ignore
      }
      entries.delete(key);
      clearLastIfKey(key);
      log(`SSH pool disconnected unleased ${key}`);
    }
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
      if (t) {
        const m = getConnectedManagerForEndpoint(t);
        if (m) return m;
      }
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
        const existing = getConnectedManagerForEndpoint(target);
        if (existing && existing.status().connected) {
          const st = existing.status();
          if (
            st.host === target.host &&
            (Number(st.port) || 22) === target.port &&
            st.username === target.username
          ) {
            return st;
          }
        }
        return connect(target, payload);
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
      const m = getConnectedManagerForEndpoint({
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
    getConnectedManagerForEndpoint,
    getLastConnectedManager,
    isConnected,
    disconnectTarget,
    disconnectEndpoint,
    disconnectAll,
    disconnectExceptEndpointKeys,
    createFacade,
    listTargetKeys,
    getEntry,
    findConnectedEndpoint
  };
}

module.exports = { createSshConnectionPool };
