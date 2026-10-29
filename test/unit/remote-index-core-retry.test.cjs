'use strict';
/**
 * remote index 超时重试必须有上限（2026-10-28 issue）。
 *
 * 原实现：status 类方法一旦超时，catch 里直接 return this.bridge.invoke(...)，
 * 既没有次数上限也没有退避，且绕过了 run() 的 _ensureStarted / 启动态复用。
 * core 一次不返回就是死循环：RPC 永不返回 → 上层 stop() → SIGTERM 2s 不退 → SIGKILL。
 */
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');

const { RemoteIndexCoreHost } = require('../../src/remote/remote-index-core.js');

/** 构造 host，绕开真实二进制：只测重试策略本身。 */
function makeHost() {
  const base = path.join(os.tmpdir(), 'dieyun-remote-index-retry-test');
  const logs = [];
  const host = new RemoteIndexCoreHost({
    workspaceRoot: path.join(base, 'ws'),
    packRoot: path.join(base, 'pack'),
    log: (m) => logs.push(String(m))
  });
  host._ensureStarted = async () => {};
  return { host, logs };
}

/**
 * @param {Error} err 抛出的错误
 * @param {number} [failTimes] 前 N 次调用抛错，之后成功；默认一直抛（Infinity）
 */
function fakeBridge(err, failTimes = Infinity) {
  const state = { calls: 0, timeouts: [], stops: 0 };
  state.bridge = {
    async invoke(method, _payload, timeout) {
      state.calls += 1;
      state.timeouts.push(timeout);
      if (state.calls <= failTimes) throw err;
      return { ok: true, method };
    },
    async stop() {
      state.stops += 1;
    }
  };
  return state;
}

function timeoutError(method) {
  const e = new Error('dieyun-core 超时: ' + method);
  e.code = 'CORE_RPC_TIMEOUT';
  return e;
}

describe('remote index 超时重试有上限', () => {
  it('graph.status 连续超时：有上限次后抛错，不会无限重试', async () => {
    const { host, logs } = makeHost();
    const state = fakeBridge(timeoutError('graph.status'));
    host.bridge = state.bridge;

    await assert.rejects(() => host.invoke('graph.status', {}), /超时/);
    assert.equal(state.calls, 2, '含首次共 STATUS_RETRY_MAX + 1 = 2 次');
    assert.ok(logs.some((l) => /放弃重试/.test(l)), '放弃时必须留日志，否则看起来还像卡死');
  });

  it('重试后成功即返回，不浪费后续次数', async () => {
    const { host } = makeHost();
    const state = fakeBridge(timeoutError('codebase.status'), 1);
    host.bridge = state.bridge;

    const res = await host.invoke('codebase.status', {});
    assert.equal(res.ok, true);
    assert.equal(state.calls, 2);
  });

  it('core 已死分支同样有上限，且每轮重启前先 stop 旧进程', async () => {
    const { host, logs } = makeHost();
    const state = fakeBridge(new Error('dieyun-core 未启动'));
    host.bridge = state.bridge;

    await assert.rejects(() => host.invoke('graph.status', {}), /未启动/);
    assert.equal(state.calls, 2);
    assert.equal(state.stops, 1, '只有首轮允许重启，最后一次直接抛');
    assert.ok(
      logs.every((l) => l.indexOf('第 2/1 次') === -1),
      '日志里不应出现越界次数'
    );
  });

  it('非 status 方法（长索引类）超时不重试，直接抛给上层', async () => {
    const { host } = makeHost();
    const state = fakeBridge(timeoutError('codebase.search'));
    host.bridge = state.bridge;

    await assert.rejects(() => host.invoke('codebase.search', {}), /超时/);
    assert.equal(state.calls, 1);
  });

  it('与超时无关的错误不重试', async () => {
    const { host } = makeHost();
    const state = fakeBridge(new Error('boom: disk full'));
    host.bridge = state.bridge;

    await assert.rejects(() => host.invoke('graph.status', {}), /boom/);
    assert.equal(state.calls, 1);
  });

  it('超时值来自 core-rpc-timeouts 单一来源（status=15s，不再写死 45s）', async () => {
    const { host } = makeHost();
    const timeouts = [];
    host.bridge = {
      async invoke(method, _payload, timeout) {
        timeouts.push(timeout);
        return { ok: true, method };
      },
      async stop() {}
    };

    await host.invoke('graph.status', {});
    await host.invoke('codebase.index', {});
    await host.invoke('codebase.search', {});

    assert.deepEqual(timeouts, [15000, 600000, 120000]);
  });

  it('index.ping 不经过 invoke（所以重试分支不必特判它）', async () => {
    const { host } = makeHost();
    const state = fakeBridge(new Error('should not be reached'));
    host.bridge = state.bridge;

    await assert.rejects(() => host.invoke('index.ping', {}), /不支持/);
    assert.equal(state.calls, 0);
  });
});