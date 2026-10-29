'use strict';

const { createRemoteGatewayManager } = require('./remote-gateway-manager');
const { sshGatewayKey, sshTargetKey, normalizeRemotePath } = require('../workspace/target');

/**
 * 一个主机只跑一个 daemon（Unix socket），所以「槽位」不再各占一个 TCP 端口，
 * 也不再需要端口分配：同主机的多个槽位探测到已有 daemon 就直接复用，
 * workspace 由每条 WS 连接的 `hello{workspace}` 决定。
 *
 * @param {{ log?: (msg: string) => void }} opts
 */
function createRemoteGatewayPool(opts = {}) {
  const log = opts.log || (() => {});
  /** @type {Map<string, { manager: ReturnType<createRemoteGatewayManager>, targetKey: string, refCount: number }>} */
  const entries = new Map();

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
   * @param {object} ctx ensureRemoteGateway context (packRoot, appVersion, onProgress)
   */
  async function ensureForTarget(target, sshManager, ctx) {
    const gKey = sshGatewayKey(target);
    const tKey = sshTargetKey(target);
    if (!gKey || !tKey) {
      throw Object.assign(new Error('无效的远程 Gateway 目标'), { code: 'REMOTE_GATEWAY_INVALID_TARGET' });
    }
    let entry = entries.get(gKey);
    if (!entry) {
      entry = {
        manager: createRemoteGatewayManager({ log }),
        targetKey: tKey,
        refCount: 0
      };
      entries.set(gKey, entry);
      log(`Remote Gateway pool slot ${gKey}`);
    }
    entry.refCount += 1;
    // 幂等判定只在 manager 里做一份（含活体探测）：池子自己再看一眼 isActive
    // 就等于把「active 就复用」这条错误假设复制一遍，探活永远不生效。
    const remotePath = normalizeRemotePath(target.remotePath || '/');
    return entry.manager.ensureRemoteGateway({
      ...ctx,
      sshManager,
      workspaceRemotePath: remotePath
    });
  }

  function releaseForTarget(target) {
    const gKey = sshGatewayKey(target);
    if (!gKey) return;
    const entry = entries.get(gKey);
    if (!entry) return;
    entry.refCount = Math.max(0, entry.refCount - 1);
  }

  /**
   * 单个 workspace 释放：**不杀**远端 daemon。
   *
   * daemon 是按主机一份的，同一台机器上别的 workspace 可能正连着它；
   * 切工作区就把 daemon 杀掉 = 让邻居重连一次。真正要收的是「SSH 断开 / 应用退出」
   * （`stopForEndpoint` / `stopAll`），那里才 killRemote。
   */
  async function stopForTarget(target, sshManager) {
    const gKey = sshGatewayKey(target);
    if (!gKey) return;
    const entry = entries.get(gKey);
    if (!entry) return;
    await entry.manager.stop(sshManager, { killRemote: false });
    entries.delete(gKey);
  }

  /**
   * 停掉同一 SSH 端点上的所有 Remote Gateway（跨 remotePath）。
   * `ssh:disconnect` 断连接是按端点前缀断的（connection-pool.disconnectEndpoint），
   * 这里若只停 exact key，同服务器其它项目的 agent 进程会变成远端孤儿。
   * @returns {Promise<string[]>} 被停掉的 gateway key
   */
  async function stopForEndpoint(target, sshManager) {
    const tKey = sshTargetKey(target);
    if (!tKey) return [];
    const stopped = [];
    for (const [gKey, entry] of [...entries.entries()]) {
      if (entry.targetKey !== tKey) continue;
      try {
        await entry.manager.stop(sshManager, { killRemote: true });
      } catch {
        // ignore — 单个槽失败不能挡住其它槽与 SSH 断开
      }
      entries.delete(gKey);
      stopped.push(gKey);
      log(`Remote Gateway pool stopped endpoint ${gKey}`);
    }
    return stopped;
  }

  /**
   * 退出时把**所有**远端 agent 停掉（先杀进程再断 SSH）。
   *
   * 不调用它的话，`nohup` 起的 agent 在远端成为孤儿：占着端口与
   * `<workspace>/.dieyun/index.sqlite`，下次启动要先靠「清孤儿 core」兜。
   */
  async function stopAll(sshPoolDisconnect) {
    for (const [gKey, entry] of [...entries.entries()]) {
      try {
        await entry.manager.stop(null, { killRemote: true });
      } catch {
        // ignore — 一个槽失败不能挡住退出
      }
      entries.delete(gKey);
      log(`Remote Gateway pool stopped ${gKey}`);
    }
    if (typeof sshPoolDisconnect === 'function') await sshPoolDisconnect();
  }

  function getStatusSummary() {
    return [...entries.entries()].map(([gKey, e]) => ({
      gatewayKey: gKey,
      targetKey: e.targetKey,
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
    stopForEndpoint,
    stopAll,
    getStatusSummary
  };
}

module.exports = { createRemoteGatewayPool };
