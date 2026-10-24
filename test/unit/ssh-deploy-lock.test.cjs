'use strict';
/**
 * 远程 Agent 注入的跨 manager 串行锁。
 *
 * 审计背景：`deployPack` 里有 `rm -rf ~/.dieyun/remote-agent/<version>`，而这个目录与 `current`
 * 软链是整台服务器共享的；manager 内的 `deploying` 变量只管得住自己那个槽
 * （sshGatewayKey = user@host:port|remotePath）。同服务器两个项目并发注入会互删目录、
 * 上传到一半被清空，最终表现为「重复注入 + 校验失败」。
 */
const assert = require('node:assert/strict');

const {
  endpointScopeOf,
  withEndpointDeployLock,
  pendingLockCount
} = require('../../src/ssh/deploy-lock.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe('SSH 注入串行锁', () => {
  it('同端点并发注入不交叉（后一个必须等前一个结束）', async () => {
    const events = [];
    const task = (name, ms) => async () => {
      events.push(`${name}:start`);
      await sleep(ms);
      events.push(`${name}:end`);
      return name;
    };
    const p1 = withEndpointDeployLock('root@h1:22', task('A', 30));
    const p2 = withEndpointDeployLock('root@h1:22', task('B', 5));
    const [r1, r2] = await Promise.all([p1, p2]);
    assert.equal(r1, 'A');
    assert.equal(r2, 'B');
    assert.deepEqual(events, ['A:start', 'A:end', 'B:start', 'B:end']);
  });

  it('不同端点并行（互不阻塞）', async () => {
    const events = [];
    const mk = (name) => async () => {
      events.push(`${name}:start`);
      await sleep(20);
      events.push(`${name}:end`);
    };
    await Promise.all([
      withEndpointDeployLock('root@h1:22', mk('h1')),
      withEndpointDeployLock('root@h2:22', mk('h2'))
    ]);
    // 两个 start 必须都排在任一 end 之前
    const firstEnd = events.findIndex((e) => e.endsWith(':end'));
    const lastStart = events.map((e) => e.endsWith(':start')).lastIndexOf(true);
    assert.ok(lastStart < firstEnd, `期望并行，实际顺序：${events.join(',')}`);
  });

  it('前一次失败不短路后续排队', async () => {
    await assert.rejects(
      withEndpointDeployLock('root@h1:22', async () => {
        throw new Error('boom');
      }),
      /boom/
    );
    const v = await withEndpointDeployLock('root@h1:22', async () => 'ok');
    assert.equal(v, 'ok');
  });

  it('ticket 用完后清理，不常驻内存', async () => {
    await withEndpointDeployLock('root@h9:22', async () => 1);
    // settled.then 的清理是微任务链，等一拍
    await sleep(0);
    assert.equal(pendingLockCount(), 0);
  });

  it('endpointScopeOf 只按 host/port/user 取键，与 remotePath 无关', () => {
    const st = { connected: true, host: 'h1', port: 22, username: 'root' };
    const sm = {
      status: () => st,
      a: { remotePath: '/a' },
      b: { remotePath: '/b' }
    };
    assert.equal(endpointScopeOf(sm), 'root@h1:22');
    // 未连接 / 取不到状态时退化到 default（全局串行，偏安全）
    assert.equal(endpointScopeOf({ status: () => ({ connected: false }) }), 'default');
    assert.equal(endpointScopeOf(null), 'default');
    assert.equal(
      endpointScopeOf({
        status: () => {
          throw new Error('nope');
        }
      }),
      'default'
    );
  });
});
