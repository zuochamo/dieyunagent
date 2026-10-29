'use strict';
/**
 * SSH 连接的身份是**端点**（user@host:port），不是「端点+路径」。
 *
 * 按路径分槽的代价：同一台机器上的两个会话（各自一份 worktree）各开一条 TCP，
 * 而且「谁记了引用、该用哪把 key 释放」变成判断题 —— 已经出过一次 acquire 用仓库键、
 * release 用 worktree 键的泄漏（refCount 只增不减，连接整个进程生命周期不回收）。
 */
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');

const { createSshConnectionPool } = require('../../src/ssh/connection-pool');
const { sshTargetKey } = require('../../src/workspace/target');

function makePool() {
  return createSshConnectionPool({
    userDataPath: path.join(os.tmpdir(), 'dieyun-ssh-pool-test'),
    log: () => {}
  });
}

const repo = { kind: 'ssh', host: 'h', port: 22, username: 'u', remotePath: '/srv/proj' };
const worktree = {
  kind: 'ssh',
  host: 'h',
  port: 22,
  username: 'u',
  remotePath: '/srv/proj/.dieyun/worktrees/sess-1a2b3c4d/main'
};
const otherHost = { kind: 'ssh', host: 'h2', port: 22, username: 'u', remotePath: '/srv/proj' };
const otherPort = { kind: 'ssh', host: 'h', port: 2200, username: 'u', remotePath: '/srv/proj' };

/** 建槽位但不真连（没给 payload → SSH_NOT_CONNECTED），只为拿到 entry */
async function seedEntry(pool, target) {
  await pool.acquire(target).catch(() => {});
  return pool.getEntry(sshTargetKey(target));
}

describe('connection-pool 的键 = 端点', () => {
  it('同端点不同路径（仓库 / 会话副本）共用同一条连接', async () => {
    const pool = makePool();
    const entry = await seedEntry(pool, repo);
    assert.ok(entry, '应当建出了槽位');
    assert.equal(pool.getManagerForTarget(worktree), entry.manager);
    assert.equal(pool.getEntry(sshTargetKey(worktree)), entry);
  });

  it('不同主机 / 不同端口才是不同连接', async () => {
    const pool = makePool();
    const entry = await seedEntry(pool, repo);
    assert.notEqual(pool.getManagerForTarget(otherHost), entry.manager);
    assert.notEqual(pool.getManagerForTarget(otherPort), entry.manager);
  });

  it('用另一条路径的 target 释放，也落在同一个槽上（不再需要 holdTarget 补丁）', async () => {
    const pool = makePool();
    const entry = await seedEntry(pool, worktree);
    entry.refCount = 1;
    pool.release(repo);
    assert.equal(entry.refCount, 0, 'acquire 用副本键、release 用仓库键必须互相抵消');
  });

  it('没连上的端点 getConnectedManager 返回 null（调用方据此重连，而不是拿到死连接）', async () => {
    const pool = makePool();
    await seedEntry(pool, repo);
    assert.equal(pool.getConnectedManager(repo), null);
    assert.ok(pool.getManagerForTarget(repo), '未连接的 manager 仍可取，用于重连/状态展示');
  });

  it('一次只断一个端点：另一个端点的槽位不受影响', async () => {
    const pool = makePool();
    await seedEntry(pool, repo);
    await seedEntry(pool, otherHost);
    await pool.disconnectEndpoint(repo, { force: true });
    assert.equal(pool.getManagerForTarget(repo), null);
    assert.ok(pool.getManagerForTarget(otherHost), '别的端点不许被连带断掉');
  });

  it('UI 手动连上的端点被记一个最小引用（幂等），不会被当闲置回收', async () => {
    const pool = makePool();
    const entry = await seedEntry(pool, repo);
    assert.equal(entry.refCount, 0);
    pool.holdEndpoint(repo);
    assert.equal(entry.refCount, 1);
    pool.holdEndpoint(worktree);
    assert.equal(entry.refCount, 1, '同一个端点重复连接不累加');
    pool.release(repo);
    assert.equal(entry.refCount, 0);
  });
});
