'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const os = require('os');
const { WebSocketServer } = require('ws');

const DEFAULT_MOBILE_PORT = 17331;

function contentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.html') return 'text/html; charset=utf-8';
  if (ext === '.js') return 'application/javascript; charset=utf-8';
  if (ext === '.css') return 'text/css; charset=utf-8';
  if (ext === '.json') return 'application/json; charset=utf-8';
  if (ext === '.svg') return 'image/svg+xml';
  return 'application/octet-stream';
}

function ipv4Parts(address) {
  const parts = String(address || '').split('.').map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return null;
  }
  return parts;
}

function isReservedIpv4(parts) {
  const [a, b, c] = parts;
  if (a === 0 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a >= 224) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a === 192 && b === 0 && c === 2) return true;
  if (a === 198 && b === 51 && c === 100) return true;
  if (a === 203 && b === 0 && c === 113) return true;
  return false;
}

function ipv4Score(parts, ifName) {
  const [a, b] = parts;
  let score = 10;
  if (a === 192 && b === 168) score = 100;
  else if (a === 10) score = 90;
  else if (a === 172 && b >= 16 && b <= 31) score = 80;
  else if (a === 100 && b >= 64 && b <= 127) score = 20;

  const name = String(ifName || '').toLowerCase();
  if (/wi-?fi|wlan|wireless|以太网|ethernet/.test(name)) score += 10;
  if (/virtual|vmware|vbox|hyper-v|wsl|docker|tailscale|zerotier|clash|tun|tap|vpn/.test(name)) score -= 50;
  return score;
}

function lanHosts() {
  const candidates = [];
  const nets = os.networkInterfaces();
  for (const [name, infos] of Object.entries(nets)) {
    for (const info of infos || []) {
      if (!info || info.internal || info.family !== 'IPv4') continue;
      const parts = ipv4Parts(info.address);
      if (!parts || isReservedIpv4(parts)) continue;
      candidates.push({
        address: info.address,
        score: ipv4Score(parts, name)
      });
    }
  }
  const seen = new Set();
  return candidates
    .sort((a, b) => b.score - a.score || a.address.localeCompare(b.address, 'en', { numeric: true }))
    .map((item) => item.address)
    .filter((address) => {
      if (seen.has(address)) return false;
      seen.add(address);
      return true;
    });
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
    this.clients = new Set();
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
    const urls = lanHosts().map((ip) => `http://${ip}:${this.port}/#token=${this.token}`);
    return {
      host: this.host,
      port: this.port,
      token: this.token,
      urls
    };
  }

  start() {
    if (this.server) return;
    this._ensureToken();
    this.server = http.createServer((req, res) => this._handleHttp(req, res));
    this.wss = new WebSocketServer({ server: this.server, path: '/ws' });
    this.wss.on('connection', (ws) => this._handleWs(ws));
    this.server.on('error', (err) => {
      this.log('mobile bridge error: ' + (err && err.message));
    });
    this.server.listen(this.port, this.host, () => {
      const urls = this.getInfo().urls;
      this.log(`mobile bridge listening :${this.port}`);
      if (urls.length) this.log(`mobile bridge url: ${urls[0]}`);
    });
  }

  _handleHttp(req, res) {
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
      if (msg.type !== 'call') {
        this._send(ws, { type: 'error', id, error: 'UNKNOWN_TYPE' });
        return;
      }
      void this._handleCall(ws, id, msg.method, msg.params || {});
    });

    ws.on('close', () => {
      clearTimeout(authTimer);
      this.clients.delete(ws);
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
      else if (method === 'service.info') data = this.agentService.info();
      else throw new Error('未知方法: ' + method);
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
