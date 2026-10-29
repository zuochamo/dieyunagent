'use strict';
/**
 * SSH 自动重连必须真的跑起来。
 *
 * 事故形态：`tryReconnectSshTarget` 里写了 `typeof ctx.getSshConfigBlocks === 'function'`
 * —— `ctx` 在这个作用域根本不存在（它是 `tryAutoReconnectSsh` 的参数名）。对未声明标识符的
 * **成员访问**会抛 ReferenceError（只有 `typeof 裸标识符` 才安全），于是这条主路径在任何真实
 * 掉线场景下都在「发起连接之前」抛错：自动重连、界面上的「重连」、RPC 侧 heal 全部静默失败，
 * 只剩一条 warn 日志，重连定时器也不会再排下一次。
 *
 * 这里钉住：整条路径不抛错，且 deps 里的 `getSshConfigBlocks` 被原样转发（真被调用一次）。
 */
const assert = require('node:assert/strict');

const { createSshReconnect, collectSshReconnectEntries } = require('../../src/ssh/reconnect');

const TARGET = {
  kind: 'ssh',
  host: 'prod',
  hostname: '10.0.0.5',
  port: 22,
  username: '',
  remotePath: '/srv/app'
};

function makeReconnect(overrides = {}) {
  return createSshReconnect({
    // 真实 main-entry 传的是 electron-log 风格对象（log / log.info / log.warn）
    log: Object.assign(() => {}, { info: () => {}, warn: () => {} }),
    getLocalGateway: () => ({
      getWorkspace: () => ({ kind: 'ssh', sshConnected: false }),
      getEffectiveWorkspaceTarget: () => TARGET
    }),
    getSshSessionManager: () => ({ status: () => ({ connected: false }) }),
    getSshCredentialsStore: () => ({ loadConnectSecrets: () => null }),
    // 池为空：走 session-manager 分支，不去建真连接
    getSshConnectionPool: () => null,
    getSessionRemoteTransport: () => null,
    invalidateRemoteAgentClient: () => {},
    ensureRemoteGatewayForCurrentWorkspace: async () => null,
    getActiveRemoteGatewayInfo: () => null,
    broadcastToRenderers: () => {},
    ...overrides
  });
}

describe('SSH 重连入口不许引用未声明的 ctx', () => {
  it('没有可用凭据时返回「需要手动重连」，而不是抛 ReferenceError', async () => {
    const reconnect = makeReconnect();
    const r = await reconnect.tryReconnectCurrentSshWorkspace('manual');
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'no_saved_credentials');
    assert.equal(typeof r.error, 'string');
  });

  it('deps 的 getSshConfigBlocks 被转发并调用（ssh_config 解析不能丢）', async () => {
    let reads = 0;
    const reconnect = makeReconnect({
      getSshConfigBlocks: () => {
        reads += 1;
        return [];
      }
    });
    await reconnect.tryReconnectCurrentSshWorkspace('manual');
    assert.equal(reads, 1, '自动重连必须用与手动连接同一份 ssh_config 解析结果');
  });

  it('deps 没给 getSshConfigBlocks 时退化成空列表，同样不抛', async () => {
    const reconnect = makeReconnect();
    const r = await reconnect.tryReconnectCurrentSshWorkspace('manual');
    assert.equal(r.reason, 'no_saved_credentials');
  });

  it('批量重连入口在「没有可重连目标」时也不抛', async () => {
    const reconnect = makeReconnect();
    const r = await reconnect.reconnectActiveAndLeasedSsh('close');
    assert.equal(r.ok, true);
    assert.equal(r.count, 0);
    assert.deepEqual(collectSshReconnectEntries(null, []), []);
  });
});
