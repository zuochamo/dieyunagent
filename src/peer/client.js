'use strict';

// @ts-check
/**
 * peer 客户端：**出站连接的唯一实现**。
 *
 * 一次请求 = 一次连接（握手 → 发信 → 收 ack →〔可选〕等回复 → 关闭）。
 *
 * 为什么不做长连接池：内网里的 agent 都是「偶尔说一句话」，长连接要维护重连、半开探测、
 * 双方时钟与心跳，而每次握手只是一来一回的几百字节。真的需要持续态的东西（在场、租约）
 * 已经走 UDP 宣告与每次握手自带的 claims 快照，不需要靠连接存活来维持。少一层状态机。
 */

const http = require('http');
const { WebSocket } = require('ws');
const { FRAME, createHello, createEnvelope, normalizeEnvelope, parseFrame } = require('./wire');

/**
 * @param {object} opts
 * @param {() => string} opts.getPeerId
 * @param {() => string} opts.getName
 * @param {() => { key: string, name: string, path: string }} opts.getWorkspace
 * @param {() => object[]} [opts.getClaims]
 * @param {() => number} [opts.getPort]
 * @param {number} [opts.connectTimeoutMs]
 * @param {number} [opts.maxTextChars]
 * @param {number} [opts.maxTtlMs]
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
          } catch (err) {
            done({ ok: false, error: `BAD_BODY: ${err && err.message ? err.message : err}` });
          }
        });
      });
      req.on('error', (err) => done({ ok: false, error: err && err.code ? err.code : 'ERROR' }));
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
   * @param {object} input
   * @param {string} input.host
   * @param {number} input.port
   * @param {string} input.type
   * @param {string} [input.text]
   * @param {string} [input.toSessionId]
   * @param {string} [input.fromSessionId]
   * @param {string} [input.inReplyTo]
   * @param {number} [input.hops]
   * @param {object} [input.claim]
   * @param {string} [input.decision]
   * @param {string} [input.note]
   * @param {boolean} [input.expectReply]  等对端跑完一轮再回
   * @param {number} [input.replyTimeoutMs]
   * @returns {Promise<{ ok: boolean, error?: string, data?: object, reply?: string|null, peer?: object }>}
   */
  function send(input) {
    const i = input || /** @type {any} */ ({});
    const host = String(i.host || '').trim();
    const port = Number(i.port);
    if (!host || !Number.isInteger(port) || port <= 0) {
      return Promise.resolve({ ok: false, error: 'BAD_TARGET' });
    }
    const env = createEnvelope({
      type: i.type,
      text: i.text,
      fromPeerId: String(o.getPeerId ? o.getPeerId() : ''),
      fromName: String(o.getName ? o.getName() : ''),
      fromSessionId: i.fromSessionId,
      toPeerId: '',
      toSessionId: i.toSessionId,
      inReplyTo: i.inReplyTo,
      hops: i.hops,
      claim: i.claim,
      decision: i.decision,
      note: i.note
    });

    return new Promise((resolve) => {
      let settled = false;
      let ws = null;
      let replyTimer = null;
      const done = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(connectTimer);
        if (replyTimer) clearTimeout(replyTimer);
        try {
          if (ws) ws.close(1000, 'done');
        } catch {
          // ignore
        }
        resolve(value);
      };
      const connectTimer = setTimeout(() => done({ ok: false, error: 'CONNECT_TIMEOUT' }), connectTimeoutMs);

      try {
        ws = new WebSocket(`ws://${host}:${port}/peer`, { handshakeTimeout: connectTimeoutMs });
      } catch (err) {
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
                workspace: o.getWorkspace ? o.getWorkspace() : {},
                claims: o.getClaims ? o.getClaims() : [],
                // 让对端知道「往哪个端口回连我」：UDP 被防火墙挡住时，这是唯一的反向通路
                port: Number(o.getPort ? o.getPort() : 0) || 0
              })
            )
          );
        } catch (err) {
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
            workspace: frame.workspace || {},
            claims: Array.isArray(frame.claims) ? frame.claims : [],
            // 对方是否已确认我这台机器：false = 它那边刚弹了（或等着弹）确认，这条会被拦下
            trusted: frame.trusted === true
          };
          try {
            ws.send(JSON.stringify({ t: FRAME.MSG, env }));
          } catch (err) {
            done({ ok: false, error: `SEND_FAILED: ${err && err.message ? err.message : err}`, peer });
            return;
          }
          if (i.expectReply) {
            const wait = Math.max(5000, Number(i.replyTimeoutMs) || 120000);
            replyTimer = setTimeout(() => done({ ok: true, data: null, reply: null, peer, timeout: true }), wait);
          }
          return;
        }
        if (frame.t === FRAME.ACK) {
          if (frame.id && frame.id !== env.id) return;
          if (!frame.ok) {
            done({ ok: false, error: String(frame.error || 'PEER_REJECTED'), data: frame.data, peer });
            return;
          }
          if (!i.expectReply) {
            done({ ok: true, data: frame.data || null, peer });
          }
          return;
        }
        if (frame.t === FRAME.MSG) {
          const inbound = normalizeEnvelope(frame.env, {
            maxTextChars: o.maxTextChars,
            maxTtlMs: o.maxTtlMs
          });
          if (!inbound) return;
          if (inbound.type !== 'reply') return;
          if (inbound.inReplyTo && inbound.inReplyTo !== env.id) return;
          done({ ok: true, data: null, reply: inbound.text, peer });
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
