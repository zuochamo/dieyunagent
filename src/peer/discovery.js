'use strict';

// @ts-check
/**
 * 局域网 peer 发现（UDP 广播）。
 *
 * 为什么用 UDP 广播而不是 mDNS / 中心服务：内网里没有任何公共设施可依赖，
 * 而「同一个子网内互相看得见」正是 P2P 的前提。广播包只宣告**可连接性**
 * （peerId / 名字 / 端口 / 项目 key）——发现不等于信任，能否投递由本机信任清单决定，
 * 真正放行发生在 WS 握手的 token 校验（`src/peer/server.js`）。
 *
 * 三个刻意的取舍：
 * 1. `255.255.255.255` 与各子网定向广播都发：部分无线控制器会丢弃前者；
 * 2. 收到 announce 只单播回一次 `here`，不做「回广播」——否则 N 台机器互相回响，
 *    包量按 N² 涨；
 * 3. 只做「在场」不做「路由」：谁离线了由 TTL 判定，不引入心跳超时重传。
 */

const dgram = require('dgram');
const os = require('os');
const { EventEmitter } = require('events');
const { subnetBroadcastAddresses } = require('../net/lan');

const PACKET_ANNOUNCE = 'announce';
const PACKET_HERE = 'here';

/**
 * @param {object} opts
 * @param {string} opts.peerId
 * @param {string} opts.name
 * @param {string} [opts.role]            工作身份（自称的角色），只用于显示
 * @param {number} opts.port              本机 peer 服务端口（宣告给对端连接用）
 * @param {string} [opts.workspaceKey]
 * @param {number} opts.discoveryPort
 * @param {number} [opts.intervalMs]
 * @param {number} [opts.ttlMs]
 * @param {{ host: string, port: number, name?: string }[]} [opts.staticPeers]
 * @param {(msg: string) => void} [opts.log]
 */
function createPeerDiscovery(opts) {
  const o = opts || /** @type {any} */ ({});
  const log = typeof o.log === 'function' ? o.log : () => {};
  const intervalMs = Math.max(2000, Number(o.intervalMs) || 30000);
  const ttlMs = Math.max(intervalMs * 2, Number(o.ttlMs) || 90000);
  const discoveryPort = Number(o.discoveryPort) || 17341;

  const emitter = new EventEmitter();

  /** @type {Map<string, { peerId: string, name: string, role: string, host: string, port: number, workspaceKey: string, source: 'lan'|'static', at: number }>} */
  const peers = new Map();

  let socket = null;
  let timer = null;
  let sweepTimer = null;
  let started = false;
  let loggedBindError = false;

  function keyOf(peerId, host, port) {
    return `${peerId}|${host}|${port}`;
  }

  function upsert(entry) {
    const key = keyOf(entry.peerId, entry.host, entry.port);
    const prev = peers.get(key);
    const isNew = !prev;
    peers.set(key, { ...entry, at: Date.now() });
    if (isNew) {
      try {
        emitter.emit('peer', peers.get(key));
      } catch {
        // 监听方异常不影响发现循环
      }
    }
    return peers.get(key);
  }

  function announcePayload(t) {
    return Buffer.from(
      JSON.stringify({
        t,
        v: 1,
        peerId: String(o.peerId || ''),
        name: String(o.name || ''),
        role: String(o.role || ''),
        port: Number(o.port) || 0,
        ws: String(o.workspaceKey || ''),
        host: os.hostname()
      })
    );
  }

  function targets() {
    const list = ['255.255.255.255', ...subnetBroadcastAddresses()];
    return [...new Set(list)];
  }

  function broadcastAnnounce() {
    if (!socket) return;
    const payload = announcePayload(PACKET_ANNOUNCE);
    for (const address of targets()) {
      try {
        socket.send(payload, discoveryPort, address);
      } catch {
        // 某些网卡没有广播路由，忽略即可
      }
    }
  }

  function sendHere(rinfo, port) {
    if (!socket || !rinfo || !rinfo.address) return;
    try {
      socket.send(announcePayload(PACKET_HERE), port || discoveryPort, rinfo.address);
    } catch {
      // ignore
    }
  }

  function onPacket(raw, rinfo) {
    let packet = null;
    try {
      packet = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (!packet || typeof packet !== 'object') return;
    const peerId = String(packet.peerId || '').trim();
    const port = Number(packet.port) || 0;
    if (!peerId || peerId === String(o.peerId || '')) return;
    if (!Number.isInteger(port) || port <= 0 || port > 65535) return;
    if (packet.t !== PACKET_ANNOUNCE && packet.t !== PACKET_HERE) return;

    upsert({
      peerId,
      name: String(packet.name || '').slice(0, 64),
      // 工作身份随宣告一起带出来：面板不用等第一次握手就能显示「自称：X」
      role: String(packet.role || '').slice(0, 32),
      host: rinfo && rinfo.address ? rinfo.address : '',
      port,
      workspaceKey: String(packet.ws || '').slice(0, 96),
      source: 'lan'
    });

    // 只在「听到别人的宣告」时回一次单播，避免 here 再触发回响。
    if (packet.t === PACKET_ANNOUNCE) sendHere(rinfo, port);
  }

  function start() {
    if (started) return { ok: true, port: discoveryPort };
    started = true;

    for (const item of Array.isArray(o.staticPeers) ? o.staticPeers : []) {
      const host = String((item && item.host) || '').trim();
      const port = Number(item && item.port);
      if (!host || !Number.isInteger(port) || port <= 0) continue;
      upsert({
        peerId: `static:${host}:${port}`,
        name: String((item && item.name) || `${host}:${port}`).slice(0, 64),
        role: '',
        host,
        port,
        workspaceKey: '',
        source: 'static'
      });
    }

    socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    socket.on('error', (err) => {
      if (!loggedBindError) {
        loggedBindError = true;
        log(`peer discovery disabled: ${err && err.message ? err.message : err}`);
      }
      try {
        socket && socket.close();
      } catch {
        // ignore
      }
      socket = null;
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    });
    socket.on('message', (raw, rinfo) => {
      try {
        onPacket(raw, rinfo);
      } catch {
        // ignore
      }
    });
    socket.on('listening', () => {
      try {
        socket.setBroadcast(true);
      } catch {
        // 少数环境不允许设置广播位，退化为只发定向广播
      }
      try {
        broadcastAnnounce();
      } catch {
        // ignore
      }
    });
    try {
      socket.bind(discoveryPort);
    } catch (err) {
      log(`peer discovery bind failed: ${err && err.message ? err.message : err}`);
    }

    timer = setInterval(() => {
      try {
        broadcastAnnounce();
      } catch {
        // ignore
      }
    }, intervalMs);
    if (timer && typeof timer.unref === 'function') timer.unref();

    // 立刻宣告一次，别等第一个 interval 才被看见
    setTimeout(() => {
      try {
        broadcastAnnounce();
      } catch {
        // ignore
      }
    }, 300).unref?.();

    sweepTimer = setInterval(() => {
      const now = Date.now();
      for (const [key, entry] of peers) {
        if (entry.source === 'static') continue;
        if (now - entry.at <= ttlMs) continue;
        peers.delete(key);
        try {
          emitter.emit('gone', entry);
        } catch {
          // ignore
        }
      }
    }, Math.min(ttlMs, 30000));
    if (sweepTimer && typeof sweepTimer.unref === 'function') sweepTimer.unref();

    return { ok: true, port: discoveryPort };
  }

  function stop() {
    started = false;
    if (timer) clearInterval(timer);
    if (sweepTimer) clearInterval(sweepTimer);
    timer = null;
    sweepTimer = null;
    if (socket) {
      try {
        socket.close();
      } catch {
        // ignore
      }
    }
    socket = null;
  }

  /** 主动催一次宣告（用户点「刷新」、或刚改完名字）。 */
  function poke() {
    try {
      broadcastAnnounce();
    } catch {
      // ignore
    }
  }

  function list() {
    return [...peers.values()].sort((a, b) => b.at - a.at);
  }

  function touch(peerId, patch) {
    for (const [key, entry] of peers) {
      if (entry.peerId !== peerId) continue;
      peers.set(key, { ...entry, ...(patch || {}), at: Date.now() });
    }
    return list();
  }

  function find(peerId) {
    for (const entry of peers.values()) {
      if (entry.peerId === peerId) return entry;
    }
    return null;
  }

  return {
    on: emitter.on.bind(emitter),
    off: emitter.off.bind(emitter),
    start,
    stop,
    poke,
    list,
    find,
    touch
  };
}

module.exports = { createPeerDiscovery};
