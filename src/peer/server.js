'use strict';

// @ts-check
/**
 * peer 服务端：**本机对内网暴露的那一扇门**。
 *
 * 只做三件事：
 * 1. `GET /api/peer/info` —— 无凭据的能力宣告（供发现层核对「这个端口真的是 dieyun peer」），
 *    不含会话内容；
 * 2. `/peer` 的 WS 握手 —— 交换身份 / workspace，随后 `msg` 帧才被处理；
 * 3. 把归一后的信封交给协调器，并把协调器的结论原样回成 `ack`。
 *
 * 边界：这里**不做业务判定**（要不要投递、要不要跑一轮、租约给不给），
 * 全部在 `src/peer/coordinator.js`。服务层只知道「这个 peerId 我这边信不信」，
 * 用来决定握手回执里要不要带上我的租约快照（陌生人不该看到我在改哪些文件）。
 */

const http = require('http');
const { WebSocketServer } = require('ws');
const { FRAME, createHelloOk, createHelloErr, normalizeEnvelope, parseFrame } = require('./wire');

const AUTH_TIMEOUT_MS = 15000;
const MAX_FRAME_BYTES = 1024 * 1024;

/**
 * @param {object} opts
 * @param {string} opts.peerId
 * @param {() => string} opts.getName
 * @param {() => string} [opts.getRole]
 * @param {() => { key: string, name: string, path: string }} opts.getWorkspace
 * @param {(peerId: string) => boolean} [opts.isTrusted]
 * @param {() => object[]} [opts.getClaims]
 * @param {(peer: object, env: object) => Promise<{ ok: boolean, error?: string, data?: object }>} opts.onEnvelope
 * @param {number} [opts.portBase]
 * @param {number} [opts.portTryCount]
 * @param {(msg: string) => void} [opts.log]
 * @param {number} [opts.maxTextChars]
 * @param {number} [opts.maxTtlMs]
 */
function createPeerServer(opts) {
  const o = opts || /** @type {any} */ ({});
  const log = typeof o.log === 'function' ? o.log : () => {};
  const portBase = Number(o.portBase) || 17350;
  const portTryCount = Math.max(1, Number(o.portTryCount) || 11);

  /** @type {http.Server | null} */
  let server = null;
  /** @type {WebSocketServer | null} */
  let wss = null;
  let boundPort = 0;
  /** @type {Set<any>} */
  const clients = new Set();
  /** @type {Map<string, { peerId: string, name: string, workspace: object, host: string, at: number }>} */
  const connected = new Map();

  function handleHttp(req, res) {
    const url = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);
    if (url.pathname === '/api/peer/info') {
      const body = JSON.stringify({
        ok: true,
        v: 1,
        peerId: String(o.peerId || ''),
        name: String(o.getName ? o.getName() : ''),
        workspace: o.getWorkspace ? o.getWorkspace() : { key: '', name: '', path: '' },
        port: boundPort
      });
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store'
      });
      res.end(body);
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('not found');
  }

  function send(ws, obj) {
    try {
      if (ws.readyState === 1) ws.send(JSON.stringify(obj));
    } catch {
      // ignore
    }
  }

  function handleConnection(ws, req) {
    ws.on('error', (err) => {
      log(`peer client ws error: ${err && err.message ? err.message : err}`);
    });
    let authed = false;
    let peer = null;
    const authTimer = setTimeout(() => {
      if (!authed) {
        try {
          ws.close(4001, 'auth timeout');
        } catch {
          // ignore
        }
      }
    }, AUTH_TIMEOUT_MS);

    ws.on('message', (raw) => {
      if (Buffer.byteLength(String(raw)) > MAX_FRAME_BYTES) {
        try {
          ws.close(4009, 'frame too large');
        } catch {
          // ignore
        }
        return;
      }
      const frame = parseFrame(raw);
      if (!frame) {
        send(ws, { t: FRAME.ACK, id: null, ok: false, error: 'BAD_JSON' });
        return;
      }

      if (frame.t === FRAME.HELLO) {
        if (authed) return;
        const peerId = String(frame.peerId || '').trim();
        if (!peerId) {
          send(ws, createHelloErr('BAD_PEER_ID', 'peerId required'));
          try {
            ws.close(4002, 'bad peer id');
          } catch {
            // ignore
          }
          return;
        }
        authed = true;
        clearTimeout(authTimer);
        const peerIdTrusted = !!(o.isTrusted && o.isTrusted(peerId));
        peer = {
          peerId,
          name: String(frame.name || '').slice(0, 64),
          // 工作身份（自称的角色）：与 name 同源，只在握手时采信一次
          role: String(frame.role || '').slice(0, 32),
          workspace: frame.workspace && typeof frame.workspace === 'object' ? frame.workspace : {},
          port: Number(frame.port) || 0,
          // remoteAddress 在双栈 socket 上形如 ::ffff:192.168.31.37，回连前必须去掉前缀
          host: String((req && req.socket && req.socket.remoteAddress) || '').replace(/^::ffff:/, ''),
          at: Date.now(),
          trusted: peerIdTrusted,
          claims: Array.isArray(frame.claims) ? frame.claims : []
        };
        connected.set(peerId, peer);
        send(
          ws,
          createHelloOk({
            peerId: String(o.peerId || ''),
            name: String(o.getName ? o.getName() : ''),
            role: String(o.getRole ? o.getRole() : ''),
            workspace: o.getWorkspace ? o.getWorkspace() : {},
            // 租约快照属于「我在改什么」，只给信任过的机器看
            claims: peerIdTrusted && o.getClaims ? o.getClaims() : [],
            trusted: peerIdTrusted
          })
        );
        log(`peer inbound hello: ${peer.name || peerId} @${peer.host}${peerIdTrusted ? '' : ' (未确认)'}`);
        return;
      }

      if (!authed || !peer) {
        send(ws, { t: FRAME.ACK, id: frame.id || null, ok: false, error: 'NOT_AUTHED' });
        return;
      }

      if (frame.t === FRAME.PING) {
        send(ws, { t: FRAME.PONG, at: Date.now() });
        return;
      }

      if (frame.t !== FRAME.MSG) {
        send(ws, { t: FRAME.ACK, id: frame.id || null, ok: false, error: 'UNKNOWN_FRAME' });
        return;
      }

      const env = normalizeEnvelope(frame.env, {
        maxTextChars: o.maxTextChars,
        maxTtlMs: o.maxTtlMs
      });
      if (!env) {
        send(ws, { t: FRAME.ACK, id: null, ok: false, error: 'BAD_ENVELOPE' });
        return;
      }

      // 信封里的 from 一律以握手身份为准：不允许一个连接替别人发言。
      // `role` 同样覆盖（而不是采信信封）：自称的工作身份只有握手时说的那次算数，
      // 否则每条消息都能换一个身份，界面上的「对方自称」就没有意义了。
      const envWithFrom = {
        ...env,
        from: { ...env.from, peerId: peer.peerId, name: peer.name || env.from.name, role: peer.role || '' }
      };
      Promise.resolve()
        .then(() => (o.onEnvelope ? o.onEnvelope(peer, envWithFrom) : { ok: false, error: 'NO_HANDLER' }))
        .then((result) => {
          send(ws, {
            t: FRAME.ACK,
            id: env.id,
            ok: !!(result && result.ok),
            error: result && result.error ? String(result.error) : undefined,
            data: result && result.data ? result.data : undefined
          });
        })
        .catch((err) => {
          send(ws, {
            t: FRAME.ACK,
            id: env.id,
            ok: false,
            error: `HANDLER_ERROR: ${err && err.message ? err.message : err}`
          });
        });
    });

    ws.on('close', () => {
      clearTimeout(authTimer);
      clients.delete(ws);
      if (peer && connected.get(peer.peerId) === peer) connected.delete(peer.peerId);
    });
  }

  function listenOn(port) {
    return new Promise((resolve) => {
      const attempt = http.createServer(handleHttp);
      attempt.once('error', (err) => {
        try {
          attempt.close();
        } catch {
          // ignore
        }
        resolve({ ok: false, error: err });
      });
      attempt.listen(port, '0.0.0.0', () => {
        resolve({ ok: true, server: attempt });
      });
    });
  }

  /**
   * 端口从 `portBase` 起顺延，避免与同机多个实例（多窗口 / 远端 agent）互踢。
   * 全部占用时返回 `{ ok: false }` —— 上层据此关闭互通但**不影响主流程**（agent 仍可用）。
   */
  async function start() {
    if (server) return { ok: true, port: boundPort };
    for (let i = 0; i < portTryCount; i++) {
      const port = portBase + i;
      const r = await listenOn(port);
      if (!r.ok) continue;
      server = r.server;
      boundPort = port;
      wss = new WebSocketServer({ server, path: '/peer', maxPayload: MAX_FRAME_BYTES });
      wss.on('connection', (ws, req) => {
        clients.add(ws);
        handleConnection(ws, req);
      });
      log(`peer server listening 0.0.0.0:${boundPort}`);
      return { ok: true, port: boundPort };
    }
    log(`peer server could not bind any port in ${portBase}..${portBase + portTryCount - 1}`);
    return { ok: false, error: 'NO_FREE_PORT' };
  }

  function stop() {
    for (const ws of clients) {
      try {
        ws.close(1001, 'server stop');
      } catch {
        // ignore
      }
    }
    clients.clear();
    connected.clear();
    if (wss) {
      try {
        wss.close();
      } catch {
        // ignore
      }
      wss = null;
    }
    if (server) {
      try {
        server.close();
      } catch {
        // ignore
      }
      server = null;
    }
    boundPort = 0;
  }

  return {
    start,
    stop,
    port: () => boundPort,
    connections: () => connected
  };
}

module.exports = { createPeerServer };
