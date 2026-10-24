'use strict';
/**
 * 写类工具串行队列的 stall 看门狗（2026-10-23 事故护栏）。
 *
 * 事故：一个永不 settle 的 `host_exec` 把 workspace 队列钉死，之后同 workspace 所有写类工具
 * 永久排队，读类工具与 Gateway 照常工作 ⇒ 表面「应用还活着」，实际 agent 停摆两小时无日志。
 *
 * 这里锁三件事：
 * 1. stall 必须能放行**已经排在后面**的项（这是闸门模型的全部意义，Promise 链救不了）；
 * 2. stall 只开闸，不终止原调用（取消由 delegate-batch 的 abort 契约负责）；
 * 3. 排队时长不计入 stall 计时（否则前面的慢调用会连带把后面的判死）。
 */
const assert = require('node:assert/strict');

const {
  runExclusive,
  setMutateQueueLog,
  getWorkspaceMutateSnapshot,
  getWorkspaceMutatePending
} = require('../../src/agent/mutate-queue.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function deferred() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('写类工具队列 stall 看门狗', () => {
  let logs = [];
  beforeEach(() => {
    logs = [];
    setMutateQueueLog((m) => logs.push(m));
  });
  afterEach(() => setMutateQueueLog(null));

  it('同 workspace 串行：前一项结束前不会启动后一项', async () => {
    const order = [];
    const p1 = runExclusive(
      async () => {
        order.push('A:start');
        await sleep(20);
        order.push('A:end');
      },
      'ws-serial',
      null,
      { tool: 'fs_edit', stallMs: 5000 }
    );
    const p2 = runExclusive(
      async () => {
        order.push('B:start');
      },
      'ws-serial',
      null,
      { tool: 'host_exec', stallMs: 5000 }
    );
    await Promise.all([p1, p2]);
    assert.deepEqual(order, ['A:start', 'A:end', 'B:start']);
    assert.equal(logs.length, 0, '正常完成不该有 stall 日志');
  });

  it('卡住的调用不会拖死已排队的后续项（stall 开闸）', async () => {
    const stuck = deferred();
    const order = [];
    const p1 = runExclusive(
      async () => {
        order.push('A:start');
        await stuck.promise; // 永不返回
        order.push('A:end');
        return 'A';
      },
      'ws-stall',
      null,
      { tool: 'host_exec', stallMs: 40 }
    );
    const p2 = runExclusive(
      async () => {
        order.push('B:start');
        return 'B';
      },
      'ws-stall',
      null,
      { tool: 'fs_edit', stallMs: 40 }
    );

    // B 必须在 A 还没结束时就被放行 —— 这正是旧 Promise 链实现做不到的
    assert.equal(await p2, 'B');
    assert.deepEqual(order, ['A:start', 'B:start']);
    assert.equal(logs.length, 1);
    assert.match(logs[0], /MUTATE_QUEUE_STALL/);
    assert.match(logs[0], /tool=host_exec/);
    assert.match(logs[0], /已放行后续写类工具/);

    // A 仍在跑（未被终止），队列计数已归还
    let aSettled = false;
    p1.then(() => {
      aSettled = true;
    });
    await sleep(10);
    assert.equal(aSettled, false, 'stall 不能终止原调用');
    assert.equal(getWorkspaceMutatePending('ws-stall'), 0);

    stuck.resolve();
    assert.equal(await p1, 'A');
    assert.deepEqual(order, ['A:start', 'B:start', 'A:end']);
  });

  it('排队时长不计入 stall：前一项慢不连带判死后一项', async () => {
    // A 耗时 120ms（< stall 200ms，不会 stall）；B 排在其后，自己只跑 10ms。
    // 旧实现（从入队开始计时）下，B 的 200ms 窗口里已经等了 120ms，容易误判。
    const order = [];
    const p1 = runExclusive(
      async () => {
        order.push('A:start');
        await sleep(120);
        order.push('A:end');
      },
      'ws-queue-time',
      null,
      { tool: 'fs_edit', stallMs: 200 }
    );
    const p2 = runExclusive(
      async () => {
        order.push('B:start');
        await sleep(10);
        order.push('B:end');
      },
      'ws-queue-time',
      null,
      { tool: 'fs_edit', stallMs: 200 }
    );
    await Promise.all([p1, p2]);
    assert.deepEqual(order, ['A:start', 'A:end', 'B:start', 'B:end']);
    assert.equal(logs.length, 0);
  });

  it('连续两项都卡住时逐项开闸，不会互相等待', async () => {
    const d1 = deferred();
    const d2 = deferred();
    const started = [];
    const p1 = runExclusive(
      async () => {
        started.push('A');
        await d1.promise;
      },
      'ws-2stall',
      null,
      { tool: 'host_exec', stallMs: 30 }
    );
    const p2 = runExclusive(
      async () => {
        started.push('B');
        await d2.promise;
      },
      'ws-2stall',
      null,
      { tool: 'host_exec', stallMs: 30 }
    );
    const p3 = runExclusive(
      async () => {
        started.push('C');
        return 'C';
      },
      'ws-2stall',
      null,
      { tool: 'fs_edit', stallMs: 30 }
    );
    assert.equal(await p3, 'C');
    assert.deepEqual(started, ['A', 'B', 'C']);
    assert.equal(logs.length, 2, 'A、B 各一条 stall 日志');
    d1.resolve();
    d2.resolve();
    await Promise.all([p1, p2]);
  });

  it('snapshot 能看出谁在跑、还在等几个', async () => {
    const d = deferred();
    const p1 = runExclusive(
      async () => {
        await d.promise;
      },
      'ws-snap',
      null,
      { tool: 'host_exec', sessionId: 's-1', stallMs: 5000 }
    );
    const p2 = runExclusive(async () => {}, 'ws-snap', null, { tool: 'fs_edit', stallMs: 5000 });
    await sleep(10);
    const snap = getWorkspaceMutateSnapshot('ws-snap');
    assert.equal(snap.pending, 2);
    assert.equal(snap.active.tool, 'host_exec');
    assert.equal(snap.active.sessionId, 's-1');
    assert.equal(typeof snap.active.runningMs, 'number');
    d.resolve();
    await Promise.all([p1, p2]);
    const after = getWorkspaceMutateSnapshot('ws-snap');
    assert.equal(after.pending, 0);
    assert.equal(after.active, null);
  });
});
