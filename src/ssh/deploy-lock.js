'use strict';

/**
 * 远程 Agent 注入的跨 manager 串行锁。
 *
 * 远程安装目录（`~/.dieyun/remote-agent/<version>`）和 `current` 软链是**整台服务器共享**的，
 * 而 `deployPack` 里有 `rm -rf <remoteBase>`。`ensureRemoteGateway` 内部的 `deploying` 变量
 * 只能管住自己那个槽（sshGatewayKey 含 remotePath）—— 同服务器两个项目并发注入会互相删目录、
 * 上传到一半被清空、校验失败后整包重传。
 *
 * 这里按 SSH 端点（`user@host:port`）串行，进程内共享；不同端点互不阻塞。
 * @type {Map<string, Promise<void>>}
 */
const locks = new Map();

/** 锁的作用域：SSH 端点（不含 remotePath）。取不到时退化到 'default'（全局串行，偏安全）。 */
function endpointScopeOf(sshManager) {
  try {
    const st = sshManager && typeof sshManager.status === 'function' ? sshManager.status() : null;
    if (st && st.host) {
      return `${st.username || ''}@${st.host}:${Number(st.port) || 22}`;
    }
  } catch {
    // ignore — 锁不能因为状态读取失败而抛
  }
  return 'default';
}

/**
 * 同 key 串行执行 task，返回本次 task 的结果。
 * 前一次失败不短路后续排队（部署失败后用户重试必须还能进队列）。
 */
function withEndpointDeployLock(scopeKey, task) {
  const key = String(scopeKey || 'default');
  const prev = locks.get(key) || Promise.resolve();
  const run = prev.then(task, task);
  const settled = run.then(
    () => {},
    () => {}
  );
  locks.set(key, settled);
  settled.then(() => {
    if (locks.get(key) === settled) locks.delete(key);
  });
  return run;
}

function pendingLockCount() {
  return locks.size;
}

module.exports = { endpointScopeOf, withEndpointDeployLock, pendingLockCount };
