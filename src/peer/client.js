// @ts-check
'use strict';

/**
 * peer 客户端：**出站连接的唯一实现**。
 *
 * 一次请求 = 一次连接（握手 → 发信 → 收 ack → 关闭）。「对方跑完一轮的答复」不在这条连接上：
 * 对端回连我的服务端发 `reply` 信封，由协调器按 `inReplyTo` 关联（见 `send` 注释）。
 *
 * 为什么不做长连接池：内网里的 agent 都是「偶尔说一句话」，长连接要维护重连、半开探测、
 * 双方时钟与心跳，而每次握手只是一来一回的几百字节。真的需要持续态的东西（在场、租约）
 * 已经走 UDP 宣告与每次握手自带的 claims 快照，不需要靠连接存活来维持。少一层状态机。
 */

const http = require('http');
const { WebSocket } = require('ws');
const { FRAME, createHello, createEnvelope, parseFrame } = require('./wire');

/**
 * @param {object} opts
 * @param {() => string} opts.getPeerId
 * @param {() => string} opts.getName
 * @param {() => { key: string, name: string, path: string }} opts.getWorkspace
 * @param {() => object[]} [opts.getClaims]
 * @param {() => number} [opts.getPort]
 * @param {number} [opts.connectTimeoutMs]
 * @param {(msg: string) => void} [opts.log]
 */
function createPeerClient(opts) {
  const o = opts || /** @type {any} */ ({});
  const log = typeof o.log === 'function' ? o.log : () => {};
  const connectTimeoutMs = Math.max(1000, Number(o.connectTimeoutMs) || 20000);

  /**
   * 读对端能力宣告（公开接口；用于「这个 host:port 是不是 dieyun peer」的核对）。
   * @param {{ host: string, port: number, timeoutMs?: number }} target
   */
  function probe(target) {
    const host = String((target && target.host) || '').trim();
    const port = Number(target && target.port);
    if (!host || !Number.isInteger(port) || port <= 0) {
      return Promise.resolve({ ok: false, error: 'BAD_TARGET' });
    }
    const timeoutMs = Math.max(500, Number(target && target.timeoutMs) || 3000);
    return new Promise((resolve) => {
      let settled = false;
      const done = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      };
      const timer = setTimeout(() => done({ ok: false, error: 'TIMEOUT' }), timeoutMs);
      const req = http.get({ host, port, path: '/api/peer/info', timeout: timeoutMs }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            done({ ok: true, info: body });
          } catch (err0) {
    /** @type {Error & { code?: string }} */
    const err = /** @type {Error & { code?: string }} */ (err0);
            done({ ok: false, error: `BAD_BODY: ${err && err.message ? err.message : err}` });
          }
        });
      });
      req.on('error', (/** @type {Error & { code?: string }} */ err) => done({ ok: false, error: err && err.code ? err.code : 'ERROR' }));
      req.on('timeout', () => {
        try {
          req.destroy();
        } catch {
          // ignore
        }
        done({ ok: false, error: 'TIMEOUT' });
      });
    });
  }

  /**
   * 发一条信封。
   *
   * **一次请求 = 一次连接**：握手 → 发信封 → 收 ack → 关闭。「对方的答复」不在这条连接上：
   * 对端跑完一轮是把 `reply` 信封回连到我的服务端（`server` → `coordinator#onEnvelope` →
   * `handleReply`），所以「等答复」在协调器里按 `inReplyTo` 关联，不由这里收尾。
   * 早先这里照着「同一条连接上等 reply 帧」写，而服务端从不发这种帧 —— 于是只能等到超时，
   * 把「对方要跑 30 秒」误报成连接失败（2026-11-13 `peer_send` 的 20s 假警报）。
   *
   * @param {object} input
   * @param {string} input.host
   * @param {number} input.port
   * @param {string} input.type
   * @param {string} [input.text]
   * @param {string} [input.id]            指定信封 id（调用方要用它关联答复时给）
   * @param {string} [input.toSessionId]
   * @param {string} [input.fromSessionId]
   * @param {string} [input.inReplyTo]
   * @param {number} [input.hops]
   * @param {object} [input.claim]
   * @param {string} [input.decision]
   * @param {string} [input.note]
   * @param {string} [input.roomId]
   * @returns {Promise<{ ok: boolean, error?: string, data?: object, envId?: string, peer?: object }>}
   */
  function send(input) {
    const i = input || /** @type {any} */ ({});
    const host = String(i.host || '').trim();
    const port = Number(i.port);
    if (!host || !Number.isInteger(port) || port <= 0) {
      return Promise.resolve({ ok: false, error: 'BAD_TARGET' });
    }
    const env = createEnvelope({
      id: i.id,
      type: i.type,
      text: i.text,
      fromPeerId: String(o.getPeerId ? o.getPeerId() : ''),
      fromName: String(o.getName ? o.getName() : ''),
      fromRole: String(o.getRole ? o.getRole() : ''),
      fromSessionId: i.fromSessionId,
      toPeerId: '',
      toSessionId: i.toSessionId,
      inReplyTo: i.inReplyTo,
      hops: i.hops,
      claim: i.claim,
      decision: i.decision,
      note: i.note,
      roomId: i.roomId
    });

    return new Promise((resolve) => {
      let settled = false;
      let ws = null;
      let ackTimer = null;
      const done = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(connectTimer);
        if (ackTimer) clearTimeout(ackTimer);
        try {
          if (ws) ws.close(1000, 'done');
        } catch {
          // ignore
        }
        resolve(value && Object.assign({}, value, { envId: env.id }));
      };
      const connectTimer = setTimeout(() => done({ ok: false, error: 'CONNECT_TIMEOUT' }), connectTimeoutMs);

      try {
        ws = new WebSocket(`ws://${host}:${port}/peer`, { handshakeTimeout: connectTimeoutMs });
      } catch (err0) {
    /** @type {Error & { code?: string }} */
    const err = /** @type {Error & { code?: string }} */ (err0);
        done({ ok: false, error: `CONNECT_FAILED: ${err && err.message ? err.message : err}` });
        return;
      }

      let peer = null;
      ws.on('error', (err) => {
        done({ ok: false, error: err && err.code ? String(err.code) : 'WS_ERROR' });
      });
      ws.on('open', () => {
        try {
          ws.send(
            JSON.stringify(
              createHello({
                peerId: String(o.getPeerId ? o.getPeerId() : ''),
                name: String(o.getName ? o.getName() : ''),
                role: String(o.getRole ? o.getRole() : ''),
                workspace: o.getWorkspace ? o.getWorkspace() : {},
                claims: o.getClaims ? o.getClaims() : [],
                // 让对端知道「往哪个端口回连我」：UDP 被防火墙挡住时，这是唯一的反向通路
                port: Number(o.getPort ? o.getPort() : 0) || 0
              })
            )
          );
        } catch (err0) {
    /** @type {Error & { code?: string }} */
    const err = /** @type {Error & { code?: string }} */ (err0);
          done({ ok: false, error: `HELLO_FAILED: ${err && err.message ? err.message : err}` });
        }
      });

      ws.on('message', (raw) => {
        const frame = parseFrame(raw);
        if (!frame) return;
        if (frame.t === FRAME.HELLO_ERR) {
          done({ ok: false, error: String(frame.code || 'HELLO_REJECTED') });
          return;
        }
        if (frame.t === FRAME.HELLO_OK) {
          peer = {
            peerId: String(frame.peerId || ''),
            name: String(frame.name || ''),
            // 工作身份：对端握手时自己声明的，只用于显示（界面标「对方自称」）
            role: String(frame.role || ''),
            workspace: frame.workspace || {},
            claims: Array.isArray(frame.claims) ? frame.claims : [],
            // 对方是否已确认我这台机器：false = 它那边刚弹了（或等着弹）确认，这条会被拦下
            trusted: frame.trusted === true
          };
          try {
            ws.send(JSON.stringify({ t: FRAME.MSG, env }));
          } catch (err0) {
    /** @type {Error & { code?: string }} */
    const err = /** @type {Error & { code?: string }} */ (err0);
            done({ ok: false, error: `SEND_FAILED: ${err && err.message ? err.message : err}`, peer });
            return;
          }
          // 连接已经建立（TCP + 101 + hello_ok）：连接超时到此为止，换成「等回执」——
          // 曾经这里不换，连接定时器一直跑到 done()，于是把「等对端跑一轮」的时间也算进
          // 20s 连接预算，任何慢一点的对面轮次都被报成 CONNECT_TIMEOUT → PEER_UNREACHABLE。
          clearTimeout(connectTimer);
          // 连上了却没回执 = 这次投递失败（不是「连不上」）
          ackTimer = setTimeout(() => done({ ok: false, error: 'ACK_TIMEOUT', peer }), connectTimeoutMs);
          return;
        }
        if (frame.t === FRAME.ACK) {
          if (frame.id && frame.id !== env.id) return;
          if (!frame.ok) {
            done({ ok: false, error: String(frame.error || 'PEER_REJECTED'), data: frame.data, peer });
            return;
          }
          done({ ok: true, data: frame.data || null, peer });
          return;
        }
      });

      ws.on('close', () => {
        if (!settled) done({ ok: false, error: 'CLOSED' });
      });
    });
  }

  return { send, probe };
}

module.exports = { createPeerClient };
