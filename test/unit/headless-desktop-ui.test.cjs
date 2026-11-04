/* globals describe, it, expect */
/**
 * 桌面界面当网页提供（headless `--web` 的 /app/）：
 * 这里锁的是「别把包根目录当静态目录敞开」和「没有 token 就什么都拿不到」这两条底线。
 */
const path = require('path');
const vm = require('vm');
const { createDesktopUi, buildShim, mountOf, SHIM_PATH } = require('../../src/headless/desktop-ui.js');

const PACKAGE_ROOT = path.join(__dirname, '..', '..');
const TOKEN = 'tok-123';

function fakeReq(url, cookie) {
  return { url, headers: cookie ? { cookie, host: 'example:17340' } : { host: 'example:17340' } };
}

function fakeRes() {
  const res = {
    status: 0,
    headers: null,
    body: '',
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers || {};
    },
    end(body) {
      this.body = body == null ? '' : String(body);
    }
  };
  return res;
}

function makeUi() {  return createDesktopUi({
    packageRoot: PACKAGE_ROOT,
    getGatewayInfo: () => ({ url: 'ws://127.0.0.1:17330', port: 17330, token: 'gw-token' }),
    getWebToken: () => TOKEN,
    log: () => {}
  });
}

/** 模拟浏览器全局：默认像「非安全上下文」那样缺 randomUUID / clipboard */
function makeSandbox(opts = {}) {
  const crypto = opts.cryptoWithoutUuid
    ? { getRandomValues: (arr) => require('crypto').randomFillSync(arr) }
    : require('crypto').webcrypto;
  return {
    window: { crypto },
    crypto,
    navigator: {},
    location: { protocol: 'http:', host: 'example:17340' },
    console: { warn: () => {}, info: () => {} },
    document: { createElement: () => ({ style: {}, setAttribute() {}, select() {}, remove() {} }), body: { appendChild() {} }, execCommand: () => true }
  };
}

describe('headless 桌面界面（/app/）', () => {  it('只接管 /app 与 /node_modules，其它路径交还手机端', () => {
    expect(mountOf('/app/')).toBe('renderer');
    expect(mountOf('/app/index.html')).toBe('renderer');
    expect(mountOf('/node_modules/mermaid/dist/mermaid.min.js')).toBe('node_modules');
    expect(mountOf('/')).toBe('');
    expect(mountOf('/ws')).toBe('');
    expect(mountOf('/api/info')).toBe('');
  });

  it('没有 token 一律 401（静态资源也不给）', () => {
    const ui = makeUi();
    for (const url of ['/app/', '/app/index.html', '/app/app.js', '/node_modules/x/y.js', SHIM_PATH]) {
      const res = fakeRes();
      expect(ui.handleHttp(fakeReq(url), res)).toBe(true);
      expect(res.status).toBe(401);
    }
  });

  it('?token 正确时放行 index 并注入 preload 替身，同时种 cookie', () => {
    const ui = makeUi();
    const res = fakeRes();
    ui.handleHttp(fakeReq(`/app/?token=${TOKEN}`), res);
    expect(res.status).toBe(200);
    expect(res.headers['Set-Cookie']).toContain('dieyun_web=tok-123');
    expect(res.body).toContain(`<script src="${SHIM_PATH}"></script>`);
    // 注入必须在渲染层自己的脚本之前（否则 window.diecloud 还不存在）
    expect(res.body.indexOf(SHIM_PATH)).toBeLessThan(res.body.indexOf('renderer-theme-bootstrap.js'));
  });

  it('带着 cookie 的后续静态请求不再需要 ?token', () => {
    const ui = makeUi();
    const res = fakeRes();
    ui.handleHttp(fakeReq('/app/index.html', 'dieyun_web=tok-123'), res);
    expect(res.status).toBe(200);
  });

  it('路径穿越拿不到包外文件', () => {
    const ui = makeUi();
    for (const url of ['/app/../../../../etc/passwd', '/app/%2e%2e/%2e%2e/package.json', '/node_modules/../../package.json']) {
      const res = fakeRes();
      // 越界请求要么被本模块拒（403/404），要么压根不归它管（交还手机端，同样拿不到文件）
      const handled = ui.handleHttp(fakeReq(`${url}?token=${TOKEN}`), res);
      if (handled) expect([403, 404]).toContain(res.status);
      expect(res.body).not.toContain('root:');
      expect(res.body).not.toContain('"devDependencies"');
    }
  });

  it('替身脚本带同源 /gateway 地址与 Gateway token', () => {
    const shim = buildShim({ gatewayUrl: 'ws://example:17340/gateway', gatewayToken: 'gw-token', workspacePath: '/srv/ws' });
    // 优先用页面地址推导（反代/HTTPS 自动 wss），Host 头只作兜底
    expect(shim).toContain("location.protocol === 'https:' ? 'wss://' : 'ws://'");
    expect(shim).toContain("+ '/gateway'");
    expect(shim).toContain('ws://example:17340/gateway');
    expect(shim).toContain('gw-token');
    expect(shim).toContain('/srv/ws');
    expect(shim).toContain("Object.defineProperty(window, 'diecloud'");
  });

  it('替身真跑一遍：getWorkspace/getGatewayInfo 返回 Promise，没实现的能力必须不存在', async () => {
    const shim = buildShim({
      gatewayUrl: 'ws://example:17340/gateway',
      gatewayToken: 'gw-token',
      workspacePath: '/srv/ws',
      permissions: { hostControl: true, fsRead: true, fsWrite: true, shellExec: true }
    });
    const sandbox = makeSandbox();
    vm.runInNewContext(shim, sandbox);
    const api = sandbox.window.diecloud;

    // preload 的 invoke 语义是 Promise：渲染层会直接 `api.getWorkspace().then(...)`
    const wsPromise = api.getWorkspace();
    expect(typeof wsPromise.then).toBe('function');
    // 形状必须是 gateway.getWorkspace() 那套（渲染层读 .kind / .workspacePath / .displayPath）
    expect(await wsPromise).toEqual({
      kind: 'local',
      workspacePath: '/srv/ws',
      displayPath: '/srv/ws',
      sshConnected: false
    });
    // 环境事实：默认工作空间（composer 标签如实显示）
    expect(sandbox.window.appDefaultWorkspacePath).toBe('/srv/ws');
    const info = await api.getGatewayInfo();
    // rustCore.enabled 是渲染层 isDieyunCoreReady() 的判据：不报就会在点发送时抛「需要 sidecar」。
    // permissions 决定给模型哪些工具（浏览器里没有写入通道，所以是启动时的一份只读快照）。
    expect(info).toEqual({
      url: 'ws://example:17340/gateway',
      token: 'gw-token',
      rustCore: { enabled: true },
      permissions: { hostControl: true, fsRead: true, fsWrite: true, shellExec: true },
      workspace: '/srv/ws'
    });

    // webUtils 那个是同步的：浏览器里拿不到真实路径
    expect(api.getPathForFile()).toBe(null);

    // 能力探测必须诚实：渲染层用 `if (api.llmChatCompletion)` 决定走 IPC 还是浏览器直连，
    // 这里装成函数就会让它走 Electron 专用通道拿到 null（真机踩过：getWorkspace(...).then is not a function）。
    // LLM 两个接口现在有同源转发实现（见 /llm），其余没实现的必须是 undefined。
    expect(typeof api.llmChatCompletion).toBe('function');
    expect(typeof api.streamChatViaMain).toBe('function');
    expect(typeof api.getModelSettingsFromMain).toBe('function');
    // 工具集闸门靠它：缺了就只有记忆/计划类工具，模型会回答「没有能写文件的工具」
    expect(typeof api.getPermissions).toBe('function');
    expect(api.onStatus).toBe(undefined);
    expect(api.setWindowZoom).toBe(undefined);
  });

  it('非安全上下文（明文 http 的 192.168.x.x）缺的 API 要补回来', async () => {
    const shim = buildShim({ gatewayUrl: 'ws://example:17340/gateway', gatewayToken: 'gw-token', workspacePath: '/srv/ws' });
    // 模拟浏览器在非安全上下文里：crypto 没有 randomUUID，navigator 没有 clipboard
    const sandbox = makeSandbox({ cryptoWithoutUuid: true });
    vm.runInNewContext(shim, sandbox);

    const uuid = sandbox.window.crypto.randomUUID();
    expect(uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(sandbox.window.crypto.randomUUID()).not.toBe(uuid);

    // 复制按钮：写进 textarea + execCommand('copy')
    let copied = null;
    sandbox.document = { createElement: () => ({ style: {}, setAttribute() {}, select() {}, remove() {} }), body: { appendChild() {} }, execCommand: (c) => ((copied = c), true) };
    await sandbox.navigator.clipboard.writeText('hello');
    expect(copied).toBe('copy');
  });

  it('/llm 是「要 token 的同源转发」：带 token 才转发，上游地址只认请求头', async () => {
    const http = require('http');
    const ui = makeUi();
    // 上游伪装成模型端点
    const upstream = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ path: req.url, auth: req.headers.authorization || '', cookie: req.headers.cookie || '', body }));
      });
    });
    await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
    const upPort = upstream.address().port;
    // 本服务：/llm 以外一律 404
    const server = http.createServer((req, res) => {
      if (!ui.handleHttp(req, res)) {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;

    const post = (path, headers, body) =>
      new Promise((resolve, reject) => {
        const req = http.request(base + path, { method: 'POST', headers }, (res) => {
          let data = '';
          res.on('data', (c) => (data += c));
          res.on('end', () => resolve({ status: res.statusCode, body: data }));
        });
        req.on('error', reject);
        req.end(body);
      });

    try {
      const upstreamUrl = `http://127.0.0.1:${upPort}/v1/chat/completions`;
      // 没有 token：拒绝（否则就是局域网开放代理）
      const noTok = await post('/llm', { 'x-dieyun-upstream': upstreamUrl }, '{}');
      expect(noTok.status).toBe(401);
      // 没有上游地址：400
      const noUp = await post(`/llm?token=${TOKEN}`, {}, '{}');
      expect(noUp.status).toBe(400);
      // 正常转发：请求头/body 到达上游，本服务的 cookie 不外泄
      const ok = await post(
        `/llm?token=${TOKEN}`,
        { 'x-dieyun-upstream': upstreamUrl, authorization: 'Bearer sk-test', 'content-type': 'application/json', cookie: 'dieyun_web=secret' },
        '{"model":"m"}'
      );
      expect(ok.status).toBe(200);
      const echoed = JSON.parse(ok.body);
      expect(echoed.path).toBe('/v1/chat/completions');
      expect(echoed.auth).toBe('Bearer sk-test');
      expect(echoed.cookie).toBe('');
      expect(echoed.body).toBe('{"model":"m"}');
    } finally {
      await new Promise((r) => server.close(r));
      await new Promise((r) => upstream.close(r));
    }
  });
});
