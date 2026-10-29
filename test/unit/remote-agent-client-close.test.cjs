'use strict';

/**
 * 关闭与重连的竞态：`close()` 之后**不许**再出现一个活着的 socket。
 *
 * `connect()` 是异步两步（先开 SSH 通道，再在通道上做 WebSocket 握手）。期间被 close() /
 * 掉线重建时，旧实现照样往下走：`this.ws = new WebSocket(...)` 把一个刚关闭的 client
 * 复活成 live socket —— 于是 `clientCache` 里那条「已关闭」的记录带着活连接，
 * 后续 RPC 打在一个没人认领的会话上，daemon 侧按 workspace 建的 session 也留着。
 */
const assert = require('node:assert/strict');
const { PassThrough } = require('node:stream');

const { RemoteAgentClient } = require('../../src/gateway/remote-agent-client');

const INFO = {
  socketPath: '/run/dieyun/agent.sock',
  workspaceRoot: '/srv/ws',
  connectTimeoutMs: 3000
};

/** 手动控制的通道开启：`open()` 决定 openChannel 何时 resolve。 */
function deferredChannel() {
  let resolve, reject;
  const opened = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { opened, resolve, reject };
}

describe('RemoteAgentClient 的关闭竞态', () => {
  it('开通道期间被 close() → 连接尝试作废，绝不复活 socket', async () => {
    const ch = deferredChannel();
    const client = new RemoteAgentClient({ ...INFO, openChannel: () => ch.opened });

    const connecting = client.connect();
    // 通道还没开回来就关闭
    client.close();
    ch.resolve(new PassThrough());

    await assert.rejects(() => connecting, (e) => {
      assert.equal(e.code, 'REMOTE_AGENT_CLOSED');
      assert.equal(e.retryable, true);
      return true;
    });
    assert.equal(client.ws, null, 'close() 之后不许有 socket');
    assert.equal(client.authed, false);
    assert.equal(client.connecting, null);
  });

  it('通道开启失败时也不留 connecting 残影（下次还能重试）', async () => {
    const ch = deferredChannel();
    const client = new RemoteAgentClient({ ...INFO, openChannel: () => ch.opened });
    const connecting = client.connect();
    ch.reject(Object.assign(new Error('SSH 通道打不开'), { code: 'SSH_CHANNEL_FAILED' }));
    await assert.rejects(() => connecting, /SSH 通道打不开/);
    assert.equal(client.connecting, null, '失败后 connecting 必须清空，否则永远不再重连');
  });

  it('掉线重建（_resetForReconnect）也作废在途握手', async () => {
    const ch = deferredChannel();
    const client = new RemoteAgentClient({ ...INFO, openChannel: () => ch.opened });
    const connecting = client.connect();
    client._resetForReconnect();
    ch.resolve(new PassThrough());
    await assert.rejects(() => connecting, (e) => e.code === 'REMOTE_AGENT_CLOSED');
    assert.equal(client.ws, null);
  });

  it('close() 幂等，且之后 connect() 是一次全新尝试', async () => {
    const client = new RemoteAgentClient({ ...INFO, openChannel: async () => new PassThrough() });
    client.close();
    client.close();
    assert.equal(client.ws, null);
    assert.equal(client.connecting, null);
  });
});
