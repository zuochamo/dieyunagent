'use strict';

/**
 * 连接池的三条竞态不变式。
 *
 *  - **一条端点一条连接**：并发 connect 不许各建一个 manager（"同端点多份连接"是历史事故的根）。
 *    真正的「只连一次」去重在 session-manager（`connect()` 的单一入口），因为自动重连那条路
 *    不经过池；这里验池不会自己再造一份。
 *  - **驱逐前二次校验**：`disconnect()` 有 await，期间可能有人 acquire 了同一条（refCount 变 1）
 *    或槽位已被换掉；此时再 `entries.delete(key)` 会把正在用的连接从池里摘走。
 *  - **facade 不回落**：活动端点存在但没连上时，回落到「最近连上的端点」会让 browse / exec /
 *    日志静默打到**另一台主机**，而路径白名单用的还是活动目标的根。
 */
const assert = require('node:assert/strict');

const { createSshConnectionPool } = require('../../src/ssh/connection-pool');
const { createSshSessionManager } = require('../../src/ssh/session-manager');
const { sshTargetKey } = require('../../src/workspace/target');

const TARGET_A = { kind: 'ssh', host: 'a', port: 22, username: 'u', remotePath: '/srv/a' };
const TARGET_B = { kind: 'ssh', host: 'b', port: 22, username: 'u', remotePath: '/srv/b' };
const PAYLOAD = { host: 'a', port: 22, username: 'u', password: 'pw', authType: 'password' };
/** 真 ssh2 客户端但指向必然拒绝的端口：用来验「去重」而不依赖网络。 */
const FAST_FAIL = {
  host: '127.0.0.1',
  hostname: '127.0.0.1',
  port: 1,
  username: 'u',
  password: 'x',
  authType: 'password'
};

/** 可控的 session-manager 替身。 */
function fakeManagers() {
  const created = [];
  const factory = (key) => {
    const rec = {
      key,
      connected: false,
      connectCalls: 0,
      disconnectCalls: 0,
      /** 设置后 connect 挂住，由测试决定何时连上 */
      deferConnect: false,
      /** @type {Array<() => void>} */
      pending: [],
      status() {
        return rec.connected ? { connected: true, host: key, port: 22, username: 'u' } : { connected: false };
      },
      connect() {
        rec.connectCalls += 1;
        if (!rec.deferConnect) {
          rec.connected = true;
          return Promise.resolve();
        }
        return new Promise((resolve) => {
          rec.pending.push(() => {
            rec.connected = true;
            resolve();
          });
        });
      },
      disconnect() {
        rec.disconnectCalls += 1;
        rec.connected = false;
        return Promise.resolve();
      },
      finishConnect() {
        for (const fn of rec.pending.splice(0)) fn();
      }
    };
    created.push(rec);
    return rec;
  };
  return { created, factory };
}

describe('连接池：一条端点只对应一个连接对象', () => {
  it('并发 connect 不会各建一个 manager', async () => {
    const { created, factory } = fakeManagers();
    const pool = createSshConnectionPool({ createManager: factory });
    const [st1, st2] = await Promise.all([
      pool.connect(TARGET_A, PAYLOAD),
      pool.connect(TARGET_A, PAYLOAD)
    ]);
    assert.equal(created.length, 1, '同一端点只许有一个连接对象');
    assert.equal(st1.connected, true);
    assert.equal(st2.connected, true);
    assert.equal(pool.getManagerForTarget(TARGET_A), pool.getManagerForTarget(TARGET_A));
  });

  it('session-manager 对同一意图的并发 connect 返回同一个 promise（真正的去重）', async () => {
    const ssh = createSshSessionManager({ log: () => {} });
    const p1 = ssh.connect(FAST_FAIL);
    const p2 = ssh.connect(FAST_FAIL);
    assert.equal(p1, p2, '两个并发 connect 必须共享同一次尝试');
    await Promise.allSettled([p1, p2]);
  });

  it('换了目标才作废上一次尝试（返回新 promise）', async () => {
    const ssh = createSshSessionManager({ log: () => {} });
    const p1 = ssh.connect(FAST_FAIL);
    const p2 = ssh.connect({ ...FAST_FAIL, host: '127.0.0.2', hostname: '127.0.0.2' });
    assert.notEqual(p1, p2);
    await Promise.allSettled([p1, p2]);
  });
});

describe('连接池：驱逐不许偷走正在用的连接', () => {
  it('disconnect 期间被 acquire 的条目不会被删掉', async () => {
    const { created, factory } = fakeManagers();
    const pool = createSshConnectionPool({ createManager: factory, idleTtlMs: 0, maxConnections: 4 });
    const key = sshTargetKey(TARGET_A);
    await pool.connect(TARGET_A, PAYLOAD);
    pool.release(TARGET_A); // 不 await：release 里是 void evictIdle()

    // 让 disconnect 挂住：模拟「驱逐进行中，另一路 acquire 进来」
    let releaseDisconnect = () => {};
    created[0].disconnect = () => {
      created[0].disconnectCalls += 1;
      return new Promise((resolve) => {
        releaseDisconnect = () => {
          created[0].connected = false;
          resolve();
        };
      });
    };
    pool.release(TARGET_A); // 触发第二轮 idle 驱逐（refCount 0 + ttl 0）
    await new Promise((r) => setTimeout(r, 5));
    const reclaimed = await pool.acquire(TARGET_A, PAYLOAD);
    assert.ok(reclaimed, 'acquire 应当拿到同一条（不重建）');
    releaseDisconnect();
    await new Promise((r) => setTimeout(r, 20));

    assert.ok(pool.getEntry(key), '被 acquire 的条目不许在 await 之后被删掉');
    assert.equal(created.length, 1, '不该为了这件事新建连接');
  });

  it('超过上限时按连接数判断，且只删该删的', async () => {
    const { created, factory } = fakeManagers();
    const pool = createSshConnectionPool({ createManager: factory, maxConnections: 1 });
    await pool.connect(TARGET_A, PAYLOAD);
    await pool.connect(TARGET_B, { ...PAYLOAD, host: 'b' });

    const keyA = sshTargetKey(TARGET_A);
    const keyB = sshTargetKey(TARGET_B);
    assert.equal(pool.getEntry(keyA), null, '超上限应驱逐较旧的那条');
    assert.ok(pool.getEntry(keyB), '刚建立的连接不许被驱逐');
    assert.equal(created.length, 2);
  });
});

describe('连接池：facade 不许回落到别的端点', () => {
  it('活动工作区是 ssh 但没连上 → 报未连接，而不是拿另一台主机的连接', async () => {
    const { factory } = fakeManagers();
    const pool = createSshConnectionPool({ createManager: factory });
    await pool.connect(TARGET_B, { ...PAYLOAD, host: 'b' });

    let active = TARGET_A; // A 没连
    const facade = pool.createFacade(() => active);
    assert.throws(() => facade.exec('ls', null, 5000), (e) => e.code === 'SSH_NOT_CONNECTED');
    assert.deepEqual(facade.status(), { connected: false });

    active = null; // 没有活动 ssh 工作区时才允许回落（终端/全局入口）
    assert.ok(facade.status().connected, '无活动目标时回落到最近连上的端点');
  });
});
