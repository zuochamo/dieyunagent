/* globals describe, it, expect */
/**
 * Main 侧 Gateway 桥（`src/main/ipc/gateway-shell.js`）。
 *
 * Renderer 的唯一 RPC 通道就是这里：`gateway:rpc` → `gateway.invokeRpc`，
 * 以及 `gateway:event` → `webContents.send`。这两条最容易在重构里悄悄掉，
 * 掉了的表现是「界面一切正常，工具不执行 / 诊断面板不刷新」。
 */
const { registerGatewayShellIpc } = require('../../src/main/ipc/gateway-shell');

function makeCtx({ gateway = {}, coreReady = true } = {}) {
  const handlers = new Map();
  const sent = [];
  const ctx = {
    ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) },
    getLocalGateway: () => gateway,
    getBrowserService: () => null,
    getMobileBridge: () => null,
    getCoreBridge: () => ({ isReady: () => coreReady }),
    getActiveRemoteGatewayWireInfo: () => null,
    resolveDieyunCoreBinary: () => '/bin/dieyun-core',
    getMainWindow: () => ({
      isDestroyed: () => false,
      webContents: { send: (channel, payload) => sent.push({ channel, payload }) }
    }),
    QRCode: { toDataURL: async () => '' },
    log: { warn: () => {} }
  };
  registerGatewayShellIpc(ctx);
  return { handlers, sent, ctx };
}

describe('Gateway IPC 桥', () => {
  it('get-info：网关在时给 {...local, local, rustCore}，不在时只报 rustCore', async () => {
    const local = { transport: 'unix', path: '/tmp/gw.sock', token: '', rpcReady: true, listening: true };
    const a = makeCtx({ gateway: { getInfo: () => local } });
    const info = await a.handlers.get('gateway:get-info')();
    expect(info.local).toEqual(local);
    expect(info.transport).toBe('unix');
    expect(info.rustCore).toEqual({
      enabled: true,
      agentLoop: true,
      planner: true,
      binary: '/bin/dieyun-core'
    });

    const b = makeCtx({ gateway: null, coreReady: false });
    const bare = await b.handlers.get('gateway:get-info')();
    expect(bare.local).toBe(undefined);
    expect(bare.rustCore.enabled).toBe(false);
  });

  it('gateway:rpc 成功：{ ok:true, data }，超时口径透传给 invokeRpc', async () => {
    const calls = [];
    const { handlers } = makeCtx({
      gateway: {
        invokeRpc: async (method, params, opts) => {
          calls.push({ method, params, opts });
          return { echoed: method };
        }
      }
    });
    const res = await handlers.get('gateway:rpc')({}, { method: 'fs.read_file', params: { filePath: 'a' }, timeoutMs: 1234 });
    expect(res).toEqual({ ok: true, data: { echoed: 'fs.read_file' } });
    expect(calls[0]).toEqual({ method: 'fs.read_file', params: { filePath: 'a' }, opts: { timeoutMs: 1234 } });
  });

  it('gateway:rpc 失败：不抛回 IPC，而是把 code / retryable / suggestedFix 原样带回', async () => {
    const { handlers } = makeCtx({
      gateway: {
        invokeRpc: async () => {
          const err = new Error('越界');
          err.code = 'PATH_FORBIDDEN';
          err.retryable = false;
          err.suggestedFix = '换到工作区内';
          throw err;
        }
      }
    });
    const res = await handlers.get('gateway:rpc')({}, { method: 'fs.write_file', params: {} });
    expect(res.ok).toBe(false);
    expect(res.error).toEqual({
      code: 'PATH_FORBIDDEN',
      message: '越界',
      retryable: false,
      suggestedFix: '换到工作区内'
    });
  });

  it('gateway:rpc：网关还没装配 / method 为空都给明确错误码', async () => {
    const none = makeCtx({ gateway: null });
    expect((await none.handlers.get('gateway:rpc')({}, { method: 'fs.glob' })).error.code).toBe('GATEWAY_UNAVAILABLE');
    const some = makeCtx({ gateway: { invokeRpc: async () => ({}) } });
    expect((await some.handlers.get('gateway:rpc')({}, {})).error.code).toBe('BAD_METHOD');
  });

  it('Gateway 事件经 gateway:event 转发到窗口（懒挂载，不重复订阅）', async () => {
    const sinks = new Set();
    const { handlers, sent } = makeCtx({
      gateway: {
        getInfo: () => ({ transport: 'unix', path: '/tmp/gw.sock', token: '', rpcReady: true, listening: true }),
        onEvent: (fn) => {
          sinks.add(fn);
          return () => sinks.delete(fn);
        },
        invokeRpc: async () => ({})
      }
    });
    // 懒挂载：第一次取 info 时才订阅
    await handlers.get('gateway:get-info')();
    await handlers.get('gateway:get-info')();
    expect(sinks.size).toBe(1);
    for (const fn of sinks) fn({ event: 'diagnostics.store_updated', data: { workspaceRoot: '/ws' } });
    expect(sent).toEqual([
      { channel: 'gateway:event', payload: { event: 'diagnostics.store_updated', data: { workspaceRoot: '/ws' } } }
    ]);
  });
});
