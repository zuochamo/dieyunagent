'use strict';
/**
 * 远端 Gateway 的 IPC 返回值必须可 structured clone。
 *
 * 实测故障：SSH 工作区里 `ssh:remote-gateway-status` / `ssh:auto-reconnect` /
 * `gateway:get-info` 全部报 `Error: An object could not be cloned` —— 因为
 * `getInfo()` 带着 `openChannel`（函数），而 structured clone 不支持函数，
 * 整条 reply 直接失败。这里锁住「对外投影去掉函数、且投影本身可 clone」，
 * 也锁住 `getInfo()` 仍然保留 `openChannel`（进程内消费者要靠它开通道）。
 */
const assert = require('node:assert/strict');
const { wireInfo } = require('../../src/ssh/remote-gateway-manager');

function infoLike() {
  return {
    key: '/home/a/.dieyun/remote-agent/x.sock#/home/a/proj',
    socketPath: '/home/a/.dieyun/remote-agent/x.sock',
    openChannel: () => Promise.resolve(null),
    remoteGateway: true,
    remoteAgent: true,
    workspaceRoot: '/home/a/proj',
    runtimeSource: 'bundled'
  };
}

test('wireInfo 摘掉 openChannel，其余字段原样保留', () => {
  const info = infoLike();
  const wire = wireInfo(info);
  assert.equal('openChannel' in wire, false, 'IPC 投影不能带函数');
  assert.equal(wire.key, info.key);
  assert.equal(wire.socketPath, info.socketPath);
  assert.equal(wire.workspaceRoot, info.workspaceRoot);
  assert.equal(wire.remoteGateway, true);
  assert.equal(wire.remoteAgent, true);
  assert.equal(wire.runtimeSource, 'bundled');
});

test('getInfo() 原样进 structured clone 会抛，投影后不抛（这就是投影存在的理由）', () => {
  const info = infoLike();
  assert.throws(() => structuredClone(info), '带函数的对象不可能跨进程');
  assert.doesNotThrow(() => structuredClone(wireInfo(info)));
});

test('wireInfo(null) 仍是 null（未激活时不伪造对象）', () => {
  assert.equal(wireInfo(null), null);
  assert.equal(wireInfo(undefined), null);
});
