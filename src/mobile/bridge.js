'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
// 局域网地址枚举的唯一来源（与 src/peer 共用）：评分 / 保留段只在那里改。
const { lanHosts } = require('../net/lan');

const DEFAULT_MOBILE_PORT = 17331;

/**
 * 服务端 → 手机端的请求等待上限。
 * 手机拍照要「唤醒相机 + 对焦 + 编码 JPEG」，比一次静态查询慢得多，所以默认给 20s；
 * 调用方（`src/mobile/camera-source.js`）按 agent-limits 的 cameraCaptureTimeoutMs 覆盖。
 */
const DEFAULT_REQUEST_TIMEOUT_MS = 20000;

/** 客户端自报能力的白名单：只有这里列出的能力会被记录，其余丢弃。 */
const KNOWN_CAPABILITIES = Object.freeze(['camera']);

function normalizeCapabilities(raw) {
  const out = new Set();
  if (!Array.isArray(raw)) return out;
  for (const item of raw) {
    const v = String(item || '').trim();
    if (v && KNOWN_CAPABILITIES.includes(v)) out.add(v);
  }
  return out;
}

function contentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.html') return 'text/html; charset=utf-8';
  if (ext === '.js') return 'application/javascript; charset=utf-8';
  if (ext === '.css') return 'text/css; charset=utf-8';
  if (ext === '.json') return 'application/json; charset=utf-8';
  if (ext === '.svg') return 'image/svg+xml';
  return 'application/octet-stream';
}

class MobileBridge {
  constructor(opts = {}) {
    this.agentService = opts.agentService;
    this.userDataPath = opts.userDataPath;
    this.log = typeof opts.log === 'function' ? opts.log : () => {};
    this.port = Number(process.env.DIEYUN_MOBILE_PORT) || DEFAULT_MOBILE_PORT;
    this.host = process.env.DIEYUN_MOBILE_HOST || '0.0.0.0';
    this.publicDir = path.join(__dirname, 'public');
    this.tokenPath = path.join(this.userDataPath, 'mobile-bridge-token.txt');
    this.token = '';
    this.server = null;
    this.wss = null;
    /** @type {null | ((req: import('http').IncomingMessage, res: import('http').ServerResponse) => boolean)} */
    this.extraHttp = null;
    /** @type {null | ((req: import('http').IncomingMessage, socket: import('stream').Duplex, head: Buffer) => boolean)} */
    this.upgradeHook = null;
    this.clients = new Set();
    /**
     * 服务端发起的「请求 / 响应」（与手机的 `call` 方向相反）：id → 等待中的调用。
     * 目前只有一条用途——Agent 主动让手机拍一张（`camera.capture`）。
     */
    this.pending = new Map();
    /** 已认证客户端声明的能力（ws → Set<string>）。拍照走 `camera`，见 `_pickClient`。 */
    this.clientCaps = new Map();
  }

  _ensureToken() {
    try {
      if (fs.existsSync(this.tokenPath)) {
        this.token = fs.readFileSync(this.tokenPath, 'utf8').trim();
      }
      if (!this.token) {
        this.token = crypto.randomBytes(18).toString('hex');
        fs.mkdirSync(path.dirname(this.tokenPath), { recursive: true });
        fs.writeFileSync(this.tokenPath, this.token, 'utf8');
      }
    } catch (e) {
      this.log('mobile token error: ' + (e && e.message));
      this.token = crypto.randomBytes(12).toString('hex');
    }
  }

  getInfo() {
    // 绑在回环上就不该报局域网地址：那个 URL 从别的机器根本连不上。
    // 真机踩过：headless 用 DIEYUN_MOBILE_HOST=127.0.0.1 起服务，日志却打印
    // `http://192.168.31.14:17340/#token=…`，运维照着点必然失败（远程要走 ssh -L 转发）。
    const loopbackOnly = ['127.0.0.1', 'localhost', '::1'].includes(String(this.host || '').trim());
    const hosts = loopbackOnly ? ['127.0.0.1'] : lanHosts();
    const urls = hosts.map((ip) => `http://${ip}:${this.port}/#token=${this.token}`);
    return {
      host: this.host,
      port: this.port,
      token: this.token,
      urls
    };
  }

  /**
   * 起 HTTP/WS 服务。返回的 promise 在 listen 成功时 resolve、失败时 reject。
   *
   * 为什么要返回 promise：端口被占 / 地址不可绑时，无窗口模式**没有别的出口** ——
   * 以前只往日志写一行，调用方照旧打印一个点不开的 URL，systemd 看到进程还在跑。
   */
  start() {
    if (this.server) return Promise.resolve(this.getInfo());
    this._ensureToken();
    this.server = http.createServer((req, res) => this._handleHttp(req, res));
    // noServer + 自己路由：以前 `path: '/ws'` 会让其它路径的 upgrade 被 ws 直接 400 掉，
    // 无窗口模式下 `/gateway`（桌面界面的同源 WS 代理）就永远轮不到。
    this.wss = new WebSocketServer({ noServer: true });
    this.wss.on('connection', (ws) => this._handleWs(ws));
    this.server.on('upgrade', (req, socket, head) => this._handleUpgrade(req, socket, head));
    return new Promise((resolve, reject) => {
      const onListenError = (err) => {
        this.log('mobile bridge error: ' + (err && err.message));
        reject(err);
      };
      this.server.once('error', onListenError);
      this.server.listen(this.port, this.host, () => {
        this.server.removeListener('error', onListenError);
        // listen 之后的错误只记日志：连接级失败不该拖垮整个服务
        this.server.on('error', (err) => this.log('mobile bridge error: ' + (err && err.message)));
        const urls = this.getInfo().urls;
        this.log(`mobile bridge listening :${this.port}`);
        if (urls.length) this.log(`mobile bridge url: ${urls[0]}`);
        resolve(this.getInfo());
      });
    });
  }

  /** upgrade 路由：`/ws` 归手机端；其它路径先问外挂钩子（桌面界面的 `/gateway`） */
  _handleUpgrade(req, socket, head) {
    let pathname = '';
    try {
      pathname = new URL(req.url || '/', 'http://localhost').pathname;
    } catch {
      pathname = '';
    }
    if (pathname === '/ws') {
      this.wss.handleUpgrade(req, socket, head, (ws) => this.wss.emit('connection', ws, req));
      return;
    }
    if (typeof this.upgradeHook === 'function' && this.upgradeHook(req, socket, head) === true) return;
    socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    socket.destroy();
  }

  _handleHttp(req, res) {
    // 无窗口模式下桌面界面（src/renderer）也由这个端口提供；桌面端不装这个钩子，行为不变
    if (typeof this.extraHttp === 'function' && this.extraHttp(req, res)) return;
    const url = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);
    if (url.pathname === '/api/info') {
      const body = JSON.stringify({ ok: true, mode: 'lan', port: this.port });
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store'
      });
      res.end(body);
      return;
    }

    if (url.pathname === '/api/version') {
      let version = '0.0.0';
      try {
        const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8'));
        version = pkg.version || version;
      } catch { /* ignore */ }
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store'
      });
      res.end(JSON.stringify({ ok: true, version }));
      return;
    }

    let rel = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\/+/, '');
    rel = rel.replace(/\\/g, '/');
    if (rel.includes('..')) {
      res.writeHead(403);
      res.end('forbidden');
      return;
    }
    const filePath = path.join(this.publicDir, rel);
    if (!filePath.startsWith(this.publicDir)) {
      res.writeHead(403);
      res.end('forbidden');
      return;
    }
    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404);
        res.end('not found');
        return;
      }
      res.writeHead(200, {
        'Content-Type': contentType(filePath),
        'Cache-Control': 'no-store'
      });
      res.end(data);
    });
  }

  _send(ws, obj) {
    try {
      if (ws.readyState === 1) ws.send(JSON.stringify(obj));
    } catch {
      // ignore
    }
  }

  _handleWs(ws) {
    // 底层 socket 异常会 emit 'error'；无监听将变成 uncaught exception，故兜底记录
    ws.on('error', (err) => {
      this.log('mobile client ws error: ' + (err && err.message ? err.message : err));
    });
    let authed = false;
    const authTimer = setTimeout(() => {
      if (!authed) ws.close(4001, 'auth timeout');
    }, 15000);

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        this._send(ws, { type: 'error', id: null, error: 'BAD_JSON' });
        return;
      }
      const id = msg.id || null;
      if (msg.type === 'auth') {
        if (msg.token === this.token) {
          authed = true;
          clearTimeout(authTimer);
          this.clients.add(ws);
          // 能力由客户端自报（它才知道自己有没有原生拍照接口）：不认识的一律丢弃，
          // 避免页面随便声明一个能力就把「Agent 主动拍照」路由到拿不到画面的客户端。
          this.clientCaps.set(ws, normalizeCapabilities(msg.capabilities));
          this._send(ws, { type: 'auth_ok', id, data: this.agentService.info() });
        } else {
          this._send(ws, { type: 'error', id, error: 'AUTH_FAILED' });
          ws.close(4003, 'auth failed');
        }
        return;
      }
      if (!authed) {
        this._send(ws, { type: 'error', id, error: 'NOT_AUTHED' });
        return;
      }
      if (msg.type === 'response') {
        this._settlePending(msg);
        return;
      }
      if (msg.type !== 'call') {
        this._send(ws, { type: 'error', id, error: 'UNKNOWN_TYPE' });
        return;
      }
      void this._handleCall(ws, id, msg.method, msg.params || {});
    });

    ws.on('close', () => {
      clearTimeout(authTimer);
      this.clients.delete(ws);
      this.clientCaps.delete(ws);
      // 页面关掉/刷新：它发起的那一轮不能留在后台继续跑（与点「停止」等价）
      if (this.desktopTurn) this.desktopTurn.cancelForSocket(ws);
      // 这台手机断线/关页面时，等它回话的请求必须立刻失败：
      // 否则 Agent 会一直挂到超时，把「手机没了」误读成「手机很慢」。
      this._rejectPendingOf(ws);
    });
  }

  _settlePending(msg) {
    const id = msg && msg.id ? String(msg.id) : '';
    const box = id ? this.pending.get(id) : null;
    if (!box) return;
    this.pending.delete(id);
    clearTimeout(box.timer);
    if (msg.ok) {
      box.resolve(msg.data);
      return;
    }
    const err = new Error(
      (msg.error && (msg.error.message || msg.error.code)) || '手机端处理失败'
    );
    err.code = (msg.error && msg.error.code) || 'CLIENT_ERROR';
    box.reject(err);
  }

  _rejectPendingOf(ws) {
    for (const [id, box] of this.pending) {
      if (box.ws !== ws) continue;
      this.pending.delete(id);
      clearTimeout(box.timer);
      const err = new Error('手机端连接已断开');
      err.code = 'NO_CLIENT';
      box.reject(err);
    }
  }

  /** 有该能力的最早/最新客户端。取「最新认证的那个」：重连/换机后它就是用户眼前那台。 */
  _pickClient(capability) {
    const want = String(capability || '');
    const list = Array.from(this.clients);
    for (let i = list.length - 1; i >= 0; i -= 1) {
      const ws = list[i];
      if (ws.readyState !== 1) continue;
      if (!want) return ws;
      const caps = this.clientCaps.get(ws);
      if (caps && caps.has(want)) return ws;
    }
    return null;
  }

  /** 是否有客户端在线（可选：要求具备某项能力）。 */
  hasClient(capability) {
    return !!this._pickClient(capability);
  }

  /**
   * 服务端 → 手机端的请求（目前只有 `camera.capture`）。
   *
   * 与 `_handleCall` 是同一套线协议的镜像方向：请求带 id，客户端回
   * `{ type: 'response', id, ok, data | error }`。没有可用客户端时**立即拒绝**
   * （NO_CLIENT），不等超时——调用方要能马上告诉模型「手机没连上」而不是卡 20 秒。
   *
   * @param {string} method 方法名
   * @param {object} [params] 参数
   * @param {{ capability?: string, timeoutMs?: number }} [opts]
   * @returns {Promise<any>} 客户端回传的 data
   */
  request(method, params, opts = {}) {
    const capability = opts.capability ? String(opts.capability) : '';
    const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : DEFAULT_REQUEST_TIMEOUT_MS;
    const ws = this._pickClient(capability);
    if (!ws) {
      const err = new Error('手机端未连接');
      err.code = 'NO_CLIENT';
      return Promise.reject(err);
    }
    const id = crypto.randomBytes(8).toString('hex');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        const err = new Error('手机端未在限定时间内回应');
        err.code = 'TIMEOUT';
        reject(err);
      }, timeoutMs);
      if (timer.unref) timer.unref();
      this.pending.set(id, { resolve, reject, timer, ws });
      this._send(ws, { type: 'request', id, method: String(method || ''), params: params || {} });
    });
  }

  async _handleCall(ws, id, method, params) {
    try {
      let data;
      if (method === 'sessions.list') data = await this.agentService.listSessions(params.limit);
      else if (method === 'messages.list') data = await this.agentService.getMessages(params.sessionId, params.limit);
      else if (method === 'trace.get') data = await this.agentService.getTrace(params);
      else if (method === 'settings.speech') data = this.agentService.getSpeechSettings();
      else if (method === 'task.submit') data = await this.agentService.submitTask(params);
      else if (method === 'task.stop') data = this.agentService.stopTask(params);
      else if (method === 'speech.transcribe') data = await this.agentService.transcribeSpeech(params);
      else if (method === 'speech.synthesize') data = await this.agentService.synthesizeSpeech(params);
      else if (method === 'service.info') data = this.agentService.info();
      // 浏览器里的桌面界面（/app/）：渲染层驱动的聊天轮，循环仍在 Main 侧跑（见 headless/desktop-turn.js）
      else if (method.startsWith('desktop.') && this.desktopTurn) {
        data = await this.desktopTurn.handleCall(
          method,
          params,
          (frame) => this._send(ws, { type: 'event', event: frame }),
          ws
        );
      } else throw new Error('未知方法: ' + method);
      this._send(ws, { type: 'result', id, ok: true, data });
    } catch (e) {
      this._send(ws, {
        type: 'result',
        id,
        ok: false,
        error: {
          code: e.code || 'EXEC_ERROR',
          message: e.message || String(e)
        }
      });
    }
  }

  broadcast(event) {
    for (const ws of this.clients) {
      this._send(ws, { type: 'event', event });
    }
  }

  stop() {
    for (const [id, box] of this.pending) {
      this.pending.delete(id);
      clearTimeout(box.timer);
      const err = new Error('手机桥已停止');
      err.code = 'NO_CLIENT';
      box.reject(err);
    }
    this.pending.clear();
    this.clientCaps.clear();
    for (const ws of this.clients) {
      try {
        ws.close(1001, 'server stop');
      } catch {
        // ignore
      }
    }
    this.clients.clear();
    if (this.wss) {
      try {
        this.wss.close();
      } catch {
        // ignore
      }
      this.wss = null;
    }
    if (this.server) {
      try {
        this.server.close();
      } catch {
        // ignore
      }
      this.server = null;
    }
  }
}

module.exports = { MobileBridge, DEFAULT_MOBILE_PORT };
