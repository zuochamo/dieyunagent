'use strict';
/**
 * 远端失败契约过隧道的完整性：code / retryable / suggestedFix 三个字段必须一起到岸。
 *
 * tool-harness 直接读 `thrownErr.retryable` 与 `thrownErr.suggestedFix` 决定「能不能重试、
 * 建议模型怎么改」；这些字段如果在 WebSocket 信封里被削成一条中文 message，
 * 上层就只能靠文案正则猜——而这正是 P5 要消掉的东西。
 */
const assert = require('node:assert/strict');
const net = require('node:net');
const WebSocket = require('ws');
const { RemoteAgentClient } = require('../../src/gateway/remote-agent-client');

function startServer(onConnection) {
  return new Promise((resolve) => {
    const wss = new WebSocket.Server({ port: 0, host: '127.0.0.1' }, () => {
      const port = wss.address().port;
      // 假装成 SSH 通道（P4 之后只有这一种形态：没有 url / token）
      resolve({ wss, openChannel: () => Promise.resolve(net.connect(port, '127.0.0.1')) });
    });
    wss.on('connection', (ws) => onConnection(ws));
  });
}

/** 服务器：握手成功后按 handler 回包 */
function serveWith(handler) {
  return startServer((ws) => {
    ws.on('message', (raw) => {
      const msg = JSON.parse(String(raw));
      if (msg.type === 'hello') {
        ws.send(JSON.stringify({ v: 1, type: 'hello_ok', id: msg.id, workspace: '/srv/p' }));
        return;
      }
      if (msg.type === 'call') handler(ws, msg);
    });
  });
}

describe('RemoteAgentClient 失败契约', () => {
  it('远端失败：code / retryable / suggestedFix 全部保留', async () => {
    const { wss, openChannel } = await serveWith((ws, msg) => {
      ws.send(
        JSON.stringify({
          v: 1,
          type: 'result',
          id: msg.id,
          ok: false,
          error: {
            code: 'SSH_EXEC_TIMEOUT',
            message: '远程命令超时（90000ms）',
            retryable: false,
            suggestedFix: '缩小范围（head -n / tail -n）后重试'
          }
        })
      );
    });
    const client = new RemoteAgentClient({ openChannel, connectTimeoutMs: 500 });
    try {
      await assert.rejects(
        () => client.call('host.exec', { command: 'rg x' }, 3000),
        (err) => {
          assert.equal(err.code, 'SSH_EXEC_TIMEOUT');
          assert.equal(err.retryable, false);
          assert.equal(err.suggestedFix, '缩小范围（head -n / tail -n）后重试');
          assert.match(err.message, /超时/);
          return true;
        }
      );
    } finally {
      client.close();
      await new Promise((r) => wss.close(r));
    }
  }, 15000);

  it('成功结果原样返回（不被错误分支污染）', async () => {
    const { wss, openChannel } = await serveWith((ws, msg) => {
      ws.send(
        JSON.stringify({ v: 1, type: 'result', id: msg.id, ok: true, data: { code: 0, stdout: 'ok' } })
      );
    });
    const client = new RemoteAgentClient({ openChannel, connectTimeoutMs: 500 });
    try {
      const r = await client.call('host.exec', {}, 3000);
      assert.deepEqual(r, { code: 0, stdout: 'ok' });
    } finally {
      client.close();
      await new Promise((r) => wss.close(r));
    }
  }, 15000);

  it('RPC 超时带 code（有 code = 真失败，没 code = 链路没通）', async () => {
    const { wss, openChannel } = await serveWith(() => {
      // 故意不回包
    });
    const client = new RemoteAgentClient({ openChannel, connectTimeoutMs: 500 });
    try {
      await assert.rejects(
        () => client.call('host.exec', {}, 150),
        (err) => {
          assert.equal(err.code, 'REMOTE_AGENT_RPC_TIMEOUT');
          assert.equal(err.method, 'host.exec');
          return true;
        }
      );
    } finally {
      client.close();
      await new Promise((r) => wss.close(r));
    }
  }, 15000);
});
