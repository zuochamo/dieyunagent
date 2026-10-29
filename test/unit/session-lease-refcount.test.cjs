'use strict';
/**
 * 租约与连接引用的对平：记一次就放一次，没记上就不放。
 *
 * 现场（G4）：`ensureSshForTarget` 失败时仍然登记租约，释放时却去 `release(target)`。
 * 连接按端点唯一之后 refCount 是全端点共享的，这一下就凭空减掉**别的会话**的引用，
 * 于是有人正在用的连接被 idle 回收。
 */
const assert = require('node:assert/strict');

const { createSessionRemoteTransport } = require('../../src/session/session-remote-transport');

const target = { kind: 'ssh', host: 'h', port: 22, username: 'u', remotePath: '/srv/proj' };

function makeTransport(sshPool) {
  return createSessionRemoteTransport({
    localGateway: { activeSessionId: 's0', getSessionWorkspaceTarget: () => target },
    sshPool,
    remoteGatewayPool: null,
    sshFacade: null,
    sshCredentialsStore: null,
    tryAutoReconnectSsh: null,
    buildRemoteGatewayPackContext: async () => ({}),
    invalidateRemoteAgentClient: () => {},
    log: () => {}
  });
}

describe('session remote lease 的引用记账', () => {
  it('连上了：acquire 一次、release 一次', async () => {
    const calls = [];
    const pool = {
      acquire: async () => calls.push('acquire'),
      release: () => calls.push('release'),
      isConnected: () => false,
      getManagerForTarget: () => null,
      getConnectedManager: () => null
    };
    // isConnected=false 且没有自愈函数 → ensureSshForTarget 返回 false，不会 acquire
    const t = makeTransport(pool);
    await t.setSessionRemoteLease('s1', true, target);
    assert.deepEqual(calls, []);
    assert.ok(t.getLeasedSessionIds().includes('s1'), '没连上也要保留租约（视图仍属远端）');
    await t.setSessionRemoteLease('s1', false, target);
    assert.deepEqual(calls, [], '没记过引用，就不许 release');
  });

  it('已连接：true 路径 acquire 且释放时 release', async () => {
    const calls = [];
    const pool = {
      acquire: async () => calls.push('acquire'),
      release: () => calls.push('release'),
      isConnected: () => true,
      getManagerForTarget: () => ({ status: () => ({ connected: true }) }),
      getConnectedManager: () => ({ status: () => ({ connected: true }) })
    };
    const t = makeTransport(pool);
    await t.setSessionRemoteLease('s2', true, target);
    assert.deepEqual(calls, ['acquire']);
    await t.setSessionRemoteLease('s2', false, target);
    assert.deepEqual(calls, ['acquire', 'release']);
  });
});
