'use strict';
/**
 * Remote Agent 握手必须有超时。
 *
 * 原实现只在 `error` / `close` 事件上失败：通道连上但对端不说话（半开连接 / 对端卡住）时，
 * `open` 之后永远等不到 `hello_ok`，也没有 close —— connect 的 Promise 永久 pending，
 * 上层 3 次重试全部卡死，RPC 永不返回（原事故的「失联」形态）。
 *
 * P4 之后客户端只走「通道 + hello」形态（没有 url / token），所以这里的假 daemon
 * 也是一个 TCP 服务器，由 `openChannel` 交出一根连到它的流 —— 与真机上的
 * `direct-streamlocal` 通道形状一致。
 */
const assert = require('node:assert/strict');
const net = require('node:net');
const WebSocket = require('ws');
const {
  RemoteAgentClient,
  isChannelDownError,
  CONNECT_TIMEOUT_MS
} = require('../../src/gateway/remote-agent-client');

/** @param {(ws: WebSocket, req: object) => void} onConnection */
function startServer(onConnection) {
  return new Promise((resolve) => {
    const wss = new WebSocket.Server({ port: 0, host: '127.0.0.1' }, () => {
      const port = wss.address().port;
      resolve({
        wss,
        /** 假装成 SSH 通道：一根直连 daemon 的流 */
        openChannel: () => Promise.resolve(net.connect(port, '127.0.0.1'))
      });
    });
    wss.on('connection', (ws, req) => onConnection(ws, req));
  });
}

describe('RemoteAgentClient 握手超时', () => {
  it('对端不说话时 connect 会超时失败，而不是永久挂起', async () => {
    // 只接受连接，永远不发 hello_ok
    const { wss, openChannel } = await startServer(() => {});
    const client = new RemoteAgentClient({ openChannel, connectTimeoutMs: 200 });
    try {
      await assert.rejects(
        () => client.connect(),
        (err) => {
          assert.equal(err.code, 'REMOTE_AGENT_CONNECT_TIMEOUT');
          assert.equal(client.connecting, null, '失败后必须清掉 connecting，否则后续调用直接复用死 Promise');
          assert.equal(client.authed, false);
          return true;
        }
      );
      assert.equal(isChannelDownError({ code: 'REMOTE_AGENT_CONNECT_TIMEOUT' }), true);
      // 只看错误码：文案再改也不会把「断线」判丢
      assert.equal(isChannelDownError(new Error('Remote Agent 已断开')), false);
    } finally {
      client.close();
      await new Promise((r) => wss.close(r));
    }
  }, 15000);

  it('握手成功时定时器要清掉（不许事后把正常连接判死）', async () => {
    const { wss, openChannel } = await startServer((ws) => {
      ws.on('message', (raw) => {
        const msg = JSON.parse(String(raw));
        if (msg.type !== 'hello') return;
        ws.send(JSON.stringify({ v: 1, type: 'hello_ok', id: msg.id, workspace: '/srv/p' }));
      });
    });
    const client = new RemoteAgentClient({ openChannel, connectTimeoutMs: 120, workspaceRoot: '/srv/p' });
    try {
      await client.connect();
      assert.equal(client.authed, true);
      // 等过原定超时点：连接仍应存活
      await new Promise((r) => setTimeout(r, 220));
      assert.equal(client.authed, true, '握手成功后的连接不能被超时定时器杀掉');
    } finally {
      client.close();
      await new Promise((r) => wss.close(r));
    }
  }, 15000);

  it('默认预算存在且是个正数（15s 级，不是无限）', () => {
    assert.equal(Number.isFinite(CONNECT_TIMEOUT_MS), true);
    assert.ok(CONNECT_TIMEOUT_MS > 1000 && CONNECT_TIMEOUT_MS <= 60000);
  });
});
