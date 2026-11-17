/* globals describe, it, expect */
/**
 * 本地 Gateway 端点（`src/gateway/local-endpoint.js` + `server.js` 的监听）。
 *
 * 锁住两件事：
 * 1. 默认**不占 TCP 端口**（POSIX socket / Windows 命名管道），TCP 只在显式配端口时；
 * 2. 私有端点上「能连上就是已授权」—— 不需要 token 文件，协议仍是 auth / call / result。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const WebSocket = require('ws');
const {
  resolveLocalGatewayEndpoint,
  describeLocalGatewayEndpoint,
  createConnectionForEndpoint,
  webSocketUrlForEndpoint,
  isEndpointListening,
  removeStaleUnixSocket,
  unixSocketPath,
  pipePath
} = require('../../src/gateway/local-endpoint');
const { LocalGateway } = require('../../src/gateway/server');

const POSIX = process.platform !== 'win32';

function tmpDir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `dieyun-endpoint-${tag}-`));
}

async function waitForListening(gateway, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (gateway.server && gateway.server.listening) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return false;
}

/** 连私有端点（真 ws 客户端，走 net.connect），跑一次 auth + call。 */
function openSocketClient(endpoint) {
  const createConnection = createConnectionForEndpoint(endpoint);
  const ws = new WebSocket(webSocketUrlForEndpoint(endpoint), createConnection ? { createConnection } : undefined);
  const pending = new Map();
  let seq = 0;
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('connect timeout')), 4000);
    ws.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    ws.on('open', () => ws.send(JSON.stringify({ v: 1, type: 'auth', token: '' })));
    ws.on('message', (raw) => {
      const msg = JSON.parse(String(raw));
      if (msg.type === 'auth_ok') {
        clearTimeout(timer);
        resolve();
        return;
      }
      const box = pending.get(msg.id);
      if (!box) return;
      pending.delete(msg.id);
      box(msg);
    });
  });
  const call = async (method, params) => {
    await ready;
    const id = `t-${++seq}`;
    return new Promise((resolve) => {
      pending.set(id, resolve);
      ws.send(JSON.stringify({ v: 1, type: 'call', id, method, params: params || {} }));
    });
  };
  return { ws, ready, call };
}

describe('本地 Gateway 端点', () => {
  it('默认走私有端点，只有显式 DIECLOUD_GATEWAY_PORT 才用 TCP', () => {
    const dir = tmpDir('resolve');
    const posix = resolveLocalGatewayEndpoint({ userDataPath: dir, env: {}, platform: 'linux' });
    expect(posix).toEqual({ transport: 'unix', path: unixSocketPath(dir) });

    const win = resolveLocalGatewayEndpoint({ userDataPath: dir, env: {}, platform: 'win32' });
    expect(win.transport).toBe('pipe');
    expect(win.path.startsWith('\\\\.\\pipe\\dieyun-gateway-')).toBe(true);
    // 同一个 userData 恒定，不同 userData 互不影响（否则两个实例会抢同一个管道名）
    expect(resolveLocalGatewayEndpoint({ userDataPath: dir, env: {}, platform: 'win32' }).path).toBe(win.path);
    expect(resolveLocalGatewayEndpoint({ userDataPath: dir + '-b', env: {}, platform: 'win32' }).path).not.toBe(
      win.path
    );
    expect(pipePath(dir)).toBe(win.path);

    const tcp = resolveLocalGatewayEndpoint({ userDataPath: dir, env: { DIECLOUD_GATEWAY_PORT: '17555' }, platform: 'linux' });
    expect(tcp).toEqual({ transport: 'tcp', host: '127.0.0.1', port: 17555 });
  });

  it('没有 userData 就报错（端点必须能定位到一份数据目录）', () => {
    expect(() => resolveLocalGatewayEndpoint({ userDataPath: '', env: {} })).toThrow(/userDataPath/);
  });

  it('描述与客户端连接入口对得上', () => {
    expect(describeLocalGatewayEndpoint({ transport: 'tcp', host: '127.0.0.1', port: 1 })).toBe('ws://127.0.0.1:1');
    expect(describeLocalGatewayEndpoint({ transport: 'unix', path: '/tmp/a.sock' })).toBe('unix:/tmp/a.sock');
    // `ws` 只认 URL：私有端点给假 host，真连接由 createConnection 交给 net
    expect(webSocketUrlForEndpoint({ transport: 'unix', path: '/tmp/a.sock' })).toBe('ws://dieyun-gateway/');
    expect(createConnectionForEndpoint({ transport: 'tcp', host: '127.0.0.1', port: 1 })).toBe(null);
    expect(typeof createConnectionForEndpoint({ transport: 'unix', path: '/tmp/a.sock' })).toBe('function');
  });

  it('探测能区分「有人在听」与「上次崩溃留下的文件」', async () => {
    if (!POSIX) return;
    const dir = tmpDir('probe');
    const endpoint = { transport: 'unix', path: path.join(dir, 'gateway.sock') };
    const server = net.createServer();
    await new Promise((r) => server.listen(endpoint.path, r));
    try {
      expect(await isEndpointListening(endpoint)).toBe(true);
    } finally {
      await new Promise((r) => server.close(r));
    }
    // 关掉监听后文件还在：这是残留，不是活着的端点
    expect(fs.existsSync(endpoint.path)).toBe(true);
    expect(await isEndpointListening(endpoint)).toBe(false);
    expect(removeStaleUnixSocket(endpoint)).toBe(true);
    expect(fs.existsSync(endpoint.path)).toBe(false);
  });

  it('真 Gateway：getInfo 报私有端点，socket 上不用 token 就能 call', async () => {
    const userData = tmpDir('live');
    const workspace = path.join(userData, 'ws');
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(path.join(workspace, 'marker.txt'), 'hello-endpoint', 'utf8');
    const gw = new LocalGateway({
      userDataPath: userData,
      readableDir: userData,
      extraReadRoots: [workspace],
      log: () => {}
    });
    gw.start();
    gw.setWorkspace(workspace);
    try {
      expect(await waitForListening(gw)).toBe(true);
      const info = gw.getInfo();
      expect(info.transport).toBe(POSIX ? 'unix' : 'pipe');
      expect(info.url).toBe(null);
      expect(info.token).toBe('');
      expect(info.rpcReady).toBe(true);
      // 默认不写 token 文件：私有端点的边界是文件系统权限
      expect(fs.existsSync(path.join(userData, 'gateway-token.txt'))).toBe(false);

      const client = openSocketClient(gw.endpoint);
      try {
        const denied = await client.call('agent.no_such_method', {});
        expect(denied.ok).toBe(false);
        expect(denied.error.code).toBe('UNKNOWN_METHOD');

        const read = await client.call('fs.read_file', {
          filePath: 'marker.txt',
          runWorkspaceRoot: workspace
        });
        expect(read.ok).toBe(true);
        expect(JSON.stringify(read.data)).toContain('hello-endpoint');
      } finally {
        client.ws.close();
      }
    } finally {
      gw.stop();
      fs.rmSync(userData, { recursive: true, force: true });
    }
  });

  it('进程内事件订阅与 WS 广播同一出口（Renderer 靠它拿 diagnostics 推送）', () => {
    const userData = tmpDir('events');
    const gw = new LocalGateway({ userDataPath: userData, readableDir: userData, log: () => {} });
    const seen = [];
    const off = gw.onEvent((payload) => seen.push(payload));
    gw.broadcastEvent('diagnostics.store_updated', { workspaceRoot: path.join(userData, 'ws') });
    off();
    gw.broadcastEvent('diagnostics.store_updated', { workspaceRoot: null });
    expect(seen.length).toBe(1);
    expect(seen[0].event).toBe('diagnostics.store_updated');
    expect(String(seen[0].data.workspaceRoot)).toContain('ws');
    fs.rmSync(userData, { recursive: true, force: true });
  });
});
