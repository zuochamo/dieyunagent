'use strict';

// @ts-check
/**
 * peer 持久化（**身份 / 信任清单 / 会话绑定 / 手工对端 / 开关 的唯一落盘点**）。
 *
 * 为什么全部收在一个文件：这些状态分属发现层、服务层、协调器三层，但都是
 * 「同一台机器上同一个用户的一小组文件」。分散写会让「谁负责迁移 / 谁负责默认值」
 * 变成无人认领的问题，也会让测试不得不 mock 五个路径。
 *
 * 目录：`<userData>/peer/`（与 mobile-bridge-token.txt 同级，但独立子目录，
 * 免得内网互通与手机桥互相覆盖配置）。
 *
 * **授权模型（P1 起）**：不再有共享配对码，改为「首次来信 → 人确认 → 记住这台机器」。
 * 信任清单是唯一授权来源：`allow` 才投递消息，`deny` 静默丢弃，不在清单里就弹一次确认。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const IDENTITY_FILE = 'identity.json';
const TRUST_FILE = 'trusted-peers.json';
const LINKS_FILE = 'session-links.json';
const PEERS_FILE = 'static-peers.json';
const SETTINGS_FILE = 'settings.json';
const ROOMS_FILE = 'rooms.json';

const TRUST_STATUSES = ['allow', 'deny'];
const ROOM_STATUSES = ['open', 'closed'];

function readJson(filePath, fallback) {
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return raw && typeof raw === 'object' ? raw : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(filePath, value) {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8');
    return true;
  } catch {
    return false;
  }
}

function normalizeName(value, fallback) {
  const s = String(value == null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, 64);
  return s || fallback;
}

/**
 * @param {string} userDataPath
 */
function createPeerStore(userDataPath) {
  const root = String(userDataPath || '');
  const dir = root ? path.join(root, 'peer') : '';
  const files = {
    identity: dir ? path.join(dir, IDENTITY_FILE) : '',
    trust: dir ? path.join(dir, TRUST_FILE) : '',
    links: dir ? path.join(dir, LINKS_FILE) : '',
    peers: dir ? path.join(dir, PEERS_FILE) : '',
    settings: dir ? path.join(dir, SETTINGS_FILE) : '',
    rooms: dir ? path.join(dir, ROOMS_FILE) : ''
  };

  /** @type {{ peerId: string, name: string, role: string, createdAt: number }} */
  let identityCache = null;
  let trustCache = null;
  let linksCache = null;
  let roomsCache = null;

  function defaultName() {
    const envName = process.env.DIEYUN_PEER_NAME;
    if (envName && String(envName).trim()) return normalizeName(envName, 'agent');
    const host = String(process.env.COMPUTERNAME || process.env.HOSTNAME || 'agent');
    return normalizeName(host, 'agent');
  }

  /**
   * 本机身份：`peerId` 一旦生成就不再变（改了等于换了一个 agent）。
   *
   * `role` 是**工作身份**（"发票模块" / "前端" 这类一行自称）：跟着 name 一起随握手广播，
   * 只影响界面显示与来信抬头，**不参与授权**（授权只认 peerId 的信任清单）。
   */
  function identity() {
    if (identityCache) return identityCache;
    const raw = files.identity ? readJson(files.identity, {}) : {};
    let peerId = String(raw.peerId || '').trim();
    if (!/^peer_[0-9a-f]{16,64}$/.test(peerId)) {
      peerId = `peer_${crypto.randomBytes(9).toString('hex')}`;
    }
    identityCache = {
      peerId,
      name: normalizeName(raw.name, defaultName()),
      role: normalizeName(raw.role, '').slice(0, 32),
      createdAt: Number(raw.createdAt) || Date.now()
    };
    if (!raw.peerId || raw.peerId !== peerId || !raw.name || raw.role == null) {
      if (files.identity) writeJson(files.identity, identityCache);
    }
    return identityCache;
  }

  function setName(value) {
    const id = identity();
    const next = { ...id, name: normalizeName(value, id.name) };
    identityCache = next;
    if (files.identity) writeJson(files.identity, next);
    return next;
  }

  /** 设工作身份。空串 = 清掉（界面回到只显示名字）。 */
  function setRole(value) {
    const id = identity();
    const next = { ...id, role: normalizeName(value, '').slice(0, 32) };
    identityCache = next;
    if (files.identity) writeJson(files.identity, next);
    return next;
  }

  /**
   * 信任清单：`{ [peerId]: { name, status: 'allow'|'deny', at } }`。
   *
   * 用 `peerId` 而不是 IP 做键：DHCP 会把地址换给别的机器，而 peerId 落盘在对方
   * `<userData>/peer/identity.json` 里、随机器走。代价是对方重装客户端会换 id，
   * 于是需要重新确认一次 —— 这是刻意的（等价于重装后重新授权一把钥匙）。
   */
  function readTrust() {
    if (trustCache) return trustCache;
    const raw = files.trust ? readJson(files.trust, {}) : {};
    /** @type {Record<string, { name: string, status: 'allow'|'deny', at: number }>} */
    const out = {};
    for (const [key, value] of Object.entries(raw)) {
      const peerId = String(key || '').trim();
      const status = String((value && value.status) || '').trim();
      if (!peerId || !TRUST_STATUSES.includes(status)) continue;
      out[peerId] = {
        name: normalizeName(value && value.name, ''),
        status: /** @type {'allow'|'deny'} */ (status),
        at: Number(value && value.at) || 0
      };
    }
    trustCache = out;
    return trustCache;
  }

  function flushTrust() {
    if (files.trust) writeJson(files.trust, readTrust());
    return readTrust();
  }

  function trustStatus(peerId) {
    const id = String(peerId || '').trim();
    if (!id) return '';
    const entry = readTrust()[id];
    return entry ? entry.status : '';
  }

  function isTrusted(peerId) {
    return trustStatus(peerId) === 'allow';
  }

  function trustEntries() {
    return Object.entries(readTrust())
      .map(([peerId, entry]) => ({ peerId, ...entry }))
      .sort((a, b) => b.at - a.at);
  }

  /**
   * 写入一次决定。`status` 传 `'clear'` 表示撤销（回到「不认识」，下次来信会重新确认）。
   * @param {string} peerId
   * @param {'allow'|'deny'|'clear'} status
   * @param {string} [name]
   */
  function setTrust(peerId, status, name) {
    const id = String(peerId || '').trim();
    if (!id) return trustEntries();
    const trust = readTrust();
    if (status === 'clear') {
      delete trust[id];
    } else if (TRUST_STATUSES.includes(status)) {
      trust[id] = { name: normalizeName(name, trust[id] ? trust[id].name : ''), status, at: Date.now() };
    }
    flushTrust();
    return trustEntries();
  }

  function readLinks() {
    if (linksCache) return linksCache;
    const raw = files.links ? readJson(files.links, {}) : {};
    const out = {};
    for (const [sessionId, peerId] of Object.entries(raw)) {
      const s = String(sessionId || '').trim();
      const p = String(peerId || '').trim();
      if (s && p) out[s] = p;
    }
    linksCache = out;
    return linksCache;
  }

  function flushLinks() {
    if (files.links) writeJson(files.links, readLinks());
    return readLinks();
  }

  function linkSession(sessionId, peerId) {
    const s = String(sessionId || '').trim();
    const p = String(peerId || '').trim();
    if (!s || !p) return readLinks();
    readLinks()[s] = p;
    return flushLinks();
  }

  function unlinkSession(sessionId) {
    const s = String(sessionId || '').trim();
    const links = readLinks();
    if (s && links[s]) {
      delete links[s];
      flushLinks();
    }
    return links;
  }

  function peerForSession(sessionId) {
    const s = String(sessionId || '').trim();
    if (!s) return '';
    return String(readLinks()[s] || '');
  }

  function sessionsForPeer(peerId) {
    const p = String(peerId || '').trim();
    if (!p) return [];
    return Object.entries(readLinks())
      .filter(([, v]) => v === p)
      .map(([k]) => k);
  }

  // ---- 房间（agent 聊天室） -------------------------------------------------
  //
  // 房间 = 一次任务的**本机视图**：谁跟我一起干这件事，成员是 peerId 列表。
  //
  // 为什么房间不进 Rust 的库、消息也不写 `meta.roomId`：
  // 每个成员本来就有一条「与 X 的对话」会话（`links`），房间时间线可以由
  // 「成员会话 + 房间存活时间窗」聚合出来，不需要给消息加字段、也不动 core 的表结构。
  // 于是房间就是 peer 目录下的一个文件，跟信任清单一起随机器走。

  /** 读全部房间（新的在前）。坏条目直接跳过，不修补。 */
  function rooms() {
    if (roomsCache) return roomsCache;
    const raw = files.rooms ? readJson(files.rooms, {}) : {};
    const list = Array.isArray(raw.rooms) ? raw.rooms : [];
    /** @type {Array<{ roomId: string, title: string, projectKey: string, members: string[], status: 'open'|'closed', createdAt: number, closedAt: number }>} */
    const out = [];
    for (const item of list) {
      if (!item || typeof item !== 'object') continue;
      const roomId = String(item.roomId || '').trim();
      const status = String(item.status || '').trim();
      if (!roomId || !ROOM_STATUSES.includes(status)) continue;
      const members = [];
      for (const m of Array.isArray(item.members) ? item.members : []) {
        const id = String(m || '').trim();
        if (id && !members.includes(id)) members.push(id);
      }
      out.push({
        roomId,
        title: normalizeName(item.title, '未命名任务'),
        projectKey: String(item.projectKey || '').trim(),
        members,
        status: /** @type {'open'|'closed'} */ (status),
        createdAt: Number(item.createdAt) || 0,
        closedAt: Number(item.closedAt) || 0
      });
    }
    out.sort((a, b) => b.createdAt - a.createdAt);
    roomsCache = out;
    return roomsCache;
  }

  function flushRooms() {
    if (files.rooms) writeJson(files.rooms, { rooms: rooms() });
    return rooms();
  }

  /** @param {string} roomId */
  function roomById(roomId) {
    const id = String(roomId || '').trim();
    if (!id) return null;
    return rooms().find((r) => r.roomId === id) || null;
  }

  /**
   * 新建一个「开着的」房间。`roomId` 由调用方生成（协调器掌握 id 规则），store 只管存取。
   * @param {{ roomId?: string, title?: string, projectKey?: string, members?: string[], createdAt?: number }} input
   */
  function createRoom(input) {
    const src = input || {};
    const roomId = String(src.roomId || '').trim();
    if (!roomId) return null;
    const members = [];
    for (const m of Array.isArray(src.members) ? src.members : []) {
      const id = String(m || '').trim();
      if (id && !members.includes(id)) members.push(id);
    }
    /** @type {{ roomId: string, title: string, projectKey: string, members: string[], status: 'open'|'closed', createdAt: number, closedAt: number }} */
    const room = {
      roomId,
      title: normalizeName(src.title, '未命名任务'),
      projectKey: String(src.projectKey || '').trim(),
      members,
      status: 'open',
      createdAt: Number(src.createdAt) || Date.now(),
      closedAt: 0
    };
    const list = rooms();
    const idx = list.findIndex((r) => r.roomId === roomId);
    if (idx >= 0) list[idx] = room;
    else list.unshift(room);
    flushRooms();
    return room;
  }

  /** 关房间：只改状态与时间，**不删会话、不删消息**（历史仍可回看）。幂等。 */
  function closeRoom(roomId) {
    const room = roomById(roomId);
    if (!room) return null;
    if (room.status === 'open') {
      room.status = 'closed';
      room.closedAt = Date.now();
      flushRooms();
    }
    return room;
  }

  /**
   * 有界保留：只在超出 `keep` 时丢**最老的已关闭**房间。
   * 打开中的房间永不丢（宁可超一点，也不删用户还在用的）。
   * @param {number} keep
   */
  function pruneRooms(keep) {
    const max = Number(keep) > 0 ? Math.trunc(Number(keep)) : 0;
    const list = rooms();
    if (!max || list.length <= max) return list;
    const kept = list.slice();
    while (kept.length > max) {
      let idx = -1;
      for (let i = 0; i < kept.length; i += 1) {
        if (kept[i].status !== 'closed') continue;
        if (idx < 0 || kept[i].createdAt < kept[idx].createdAt) idx = i;
      }
      if (idx < 0) break;
      kept.splice(idx, 1);
    }
    roomsCache = kept;
    flushRooms();
    return kept;
  }

  function staticPeers() {
    const raw = files.peers ? readJson(files.peers, {}) : {};
    const list = Array.isArray(raw.peers) ? raw.peers : [];
    const out = [];
    for (const item of list) {
      if (!item || typeof item !== 'object') continue;
      const host = String(item.host || '').trim();
      const port = Number(item.port);
      if (!host || !Number.isInteger(port) || port <= 0 || port > 65535) continue;
      out.push({ host, port, name: normalizeName(item.name, '') });
    }
    return out;
  }

  function setStaticPeers(peers) {
    const clean = (Array.isArray(peers) ? peers : [])
      .map((item) => ({
        host: String((item && item.host) || '').trim(),
        port: Number(item && item.port),
        name: normalizeName(item && item.name, '')
      }))
      .filter((item) => item.host && Number.isInteger(item.port) && item.port > 0 && item.port <= 65535);
    if (files.peers) writeJson(files.peers, { peers: clean });
    return clean;
  }

  function settings() {
    const raw = files.settings ? readJson(files.settings, {}) : {};
    return {
      // 默认开：用户装了客户端就能被同项目同事找到；关掉即完全静默（不监听、不宣告）。
      enabled: raw.enabled !== false,
      // 默认开：对方来信直接在这台机器上跑一轮（互通即「另一台机器上的我」，用户要的是马上有回应）。
      // 只认字面 true/false：缺省或脏值都按默认开；显式关掉必须落成 false 才生效。
      autoTurn: raw.autoTurn == null ? true : raw.autoTurn === true
    };
  }

  function setSettings(patch) {
    const next = { ...settings(), ...(patch && typeof patch === 'object' ? patch : {}) };
    const clean = {
      enabled: next.enabled !== false,
      autoTurn: next.autoTurn == null ? true : next.autoTurn === true
    };
    if (files.settings) writeJson(files.settings, clean);
    return clean;
  }

  return {
    dir,
    files,
    identity,
    setName,
    setRole,
    trustEntries,
    trustStatus,
    isTrusted,
    setTrust,
    links: readLinks,
    linkSession,
    unlinkSession,
    peerForSession,
    sessionsForPeer,
    rooms,
    roomById,
    createRoom,
    closeRoom,
    pruneRooms,
    staticPeers,
    setStaticPeers,
    settings,
    setSettings
  };
}

module.exports = { createPeerStore };
