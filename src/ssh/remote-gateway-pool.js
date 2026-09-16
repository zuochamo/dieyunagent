'use strict';

const { createRemoteGatewayManager } = require('./remote-gateway-manager');
const { sshGatewayKey, sshTargetKey, normalizeRemotePath } = require('../workspace/target');
const { DEFAULT_REMOTE_PORT } = require('../remote/minimal-gateway-host');

/**
 * @param {{ log?: (msg: string) => void }} opts
 */
function createRemoteGatewayPool(opts = {}) {
  const log = opts.log || (() => {});
  /** @type {Map<string, { manager: ReturnType<createRemoteGatewayManager>, targetKey: string, remotePort: number, refCount: number }>} */
  const entries = new Map();

  function allocateRemotePort(targetKey) {
    const used = new Set();
    for (const entry of entries.values()) {
      if (entry.targetKey === targetKey) used.add(entry.remotePort);
    }
    let port = DEFAULT_REMOTE_PORT;
    while (used.has(port)) port += 1;
    return port;
  }

  function getEntryForTarget(target) {
    const key = sshGatewayKey(target);
    return key ? entries.get(key) || null : null;
  }

  function getInfoForTarget(target) {
    const entry = getEntryForTarget(target);
    if (!entry || !entry.manager.isActive()) return null;
    return entry.manager.getInfo();
  }

  function getStatusForTarget(target) {
    const entry = getEntryForTarget(target);
    if (!entry || !entry.manager.isActive()) return null;
    return entry.manager.getStatus();
  }

  /**
   * @param {import('../workspace/target').SshWorkspaceTarget} target
   * @param {ReturnType<import('./session-manager').createSshSessionManager>} sshManager
   * @param {object} ctx ensureRemoteGateway context (packRoot, appVersion, onProgress, force)
   */
  async function ensureForTarget(target, sshManager, ctx) {
    const gKey = sshGatewayKey(target);
    const tKey = sshTargetKey(target);
    if (!gKey || !tKey) {
      throw Object.assign(new Error('无效的远程 Gateway 目标'), { code: 'REMOTE_GATEWAY_INVALID_TARGET' });
    }
    let entry = entries.get(gKey);
    if (entry && entry.manager.isActive()) {
      entry.refCount += 1;
      return entry.manager.getInfo();
    }
    if (!entry) {
      entry = {
        manager: createRemoteGatewayManager({ log }),
        targetKey: tKey,
        remotePort: allocateRemotePort(tKey),
        refCount: 0
      };
      entries.set(gKey, entry);
      log(`Remote Gateway pool slot ${gKey} → remote :${entry.remotePort}`);
    }
    entry.refCount += 1;
    const remotePath = normalizeRemotePath(target.remotePath || '/');
    return entry.manager.ensureRemoteGateway({
      ...ctx,
      sshManager,
      workspaceRemotePath: remotePath,
      remotePort: entry.remotePort
    });
  }

  function releaseForTarget(target) {
    const gKey = sshGatewayKey(target);
    if (!gKey) return;
    const entry = entries.get(gKey);
    if (!entry) return;
    entry.refCount = Math.max(0, entry.refCount - 1);
  }

  async function stopForTarget(target, sshManager) {
    const gKey = sshGatewayKey(target);
    if (!gKey) return;
    const entry = entries.get(gKey);
    if (!entry) return;
    await entry.manager.stop(sshManager, { killRemote: true });
    entries.delete(gKey);
  }

  async function stopAll(sshPoolDisconnect) {
    for (const [gKey, entry] of [...entries.entries()]) {
      try {
        await entry.manager.stop(null, { killRemote: true });
      } catch {
        // ignore
      }
      entries.delete(gKey);
      void gKey;
    }
    if (typeof sshPoolDisconnect === 'function') await sshPoolDisconnect();
  }

  /**
   * 停止不在 keepKeys 中的 Remote Gateway（无视 refCount，用于视图切换释放）。
   * @param {Set<string>} keepKeys sshGatewayKey 集合
   */
  async function stopExceptGatewayKeys(keepKeys) {
    const keep = keepKeys instanceof Set ? keepKeys : new Set();
    for (const [gKey, entry] of [...entries.entries()]) {
      if (keep.has(gKey)) continue;
      if (entry.refCount > 0) continue;
      try {
        await entry.manager.stop(null, { killRemote: true });
      } catch {
        // ignore
      }
      entries.delete(gKey);
      log(`Remote Gateway pool stopped unleased ${gKey}`);
    }
  }

  function isActiveForTarget(target) {
    const entry = getEntryForTarget(target);
    return !!(entry && entry.manager.isActive());
  }

  function getStatusSummary() {
    return [...entries.entries()].map(([gKey, e]) => ({
      gatewayKey: gKey,
      targetKey: e.targetKey,
      remotePort: e.remotePort,
      refCount: e.refCount,
      active: e.manager.isActive(),
      info: e.manager.getInfo()
    }));
  }

  return {
    ensureForTarget,
    releaseForTarget,
    getInfoForTarget,
    getStatusForTarget,
    stopForTarget,
    stopAll,
    stopExceptGatewayKeys,
    isActiveForTarget,
    getStatusSummary
  };
}

module.exports = { createRemoteGatewayPool };
