'use strict';

/**
 * server 已退出后收到请求回包不得抛错（2026-10-17 修复）。
 *
 * 事故形态：`_abortPending`（进程 exit / spawn error）把 `proc` 置 null 并
 * `closed=true`，但 stdout 里已缓冲的消息仍会被 `data` 回调派发。此时
 * `sendResponse → _send` 抛 `language server not running`，抛点在事件回调里，
 * `main-entry.js` 只挂了 unhandledRejection → uncaughtException → 主进程崩。
 */

const { LspClient } = require('../../src/lsp/lsp-client');

function deadClient() {
  const logs = [];
  const client = new LspClient({
    spec: { command: 'no-such-server', args: [] },
    workspaceRoot: '/tmp/ws',
    serverKey: 'python',
    userDataPath: '',
    log: (msg) => logs.push(String(msg))
  });
  // 模拟 exit 之后的状态
  client.closed = true;
  client.proc = null;
  return { client, logs };
}

describe('LSP 回包容错', () => {
  it('未知服务端请求在 server 已退出时只记日志，不抛错', () => {
    const { client, logs } = deadClient();
    expect(() =>
      client._handleMessage({ jsonrpc: '2.0', id: 7, method: 'client/registerCapability', params: {} })
    ).not.toThrow();
    expect(logs.some((l) => l.includes('server 已退出'))).toBe(true);
  });

  it('workspace/workspaceFolders 与 workspace/configuration 同样不抛', () => {
    const { client } = deadClient();
    expect(() =>
      client._handleMessage({ jsonrpc: '2.0', id: 8, method: 'workspace/workspaceFolders' })
    ).not.toThrow();
    expect(() =>
      client._handleMessage({
        jsonrpc: '2.0',
        id: 9,
        method: 'workspace/configuration',
        params: { items: [{ section: 'python.analysis' }] }
      })
    ).not.toThrow();
  });

  it('进程正常时 sendResponse 仍能把消息写进 stdin', () => {
    const writes = [];
    const { client } = deadClient();
    client.closed = false;
    client.proc = { stdin: { write: (raw) => writes.push(raw) }, stdout: null };
    client.sendResponse(11, { ok: true });
    expect(writes).toHaveLength(1);
    expect(writes[0]).toContain('"id":11');
  });
});
