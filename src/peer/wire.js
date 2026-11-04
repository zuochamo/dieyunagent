'use strict';

// @ts-check
/**
 * 内网 peer 线协议（**帧与信封的唯一来源**）。
 *
 * 与 `src/agent/message-bus.js` 的分工必须分清，否则会写两套语义：
 * - `message-bus.js` 是**同一进程内** planner 子 Agent 的总线，投递单位是 `toRole`；
 * - 本文件是**跨机器**的线协议，投递单位是 `peerId + sessionId`，且必须落成可序列化的帧。
 *
 * 刻意不做的事：
 * - 不做「按关键词判断这是不是消息」之类的路由（AGENTS.md §3）：类型是显式字段 `type`。
 * - 不在这里做重试 / 重连（那是 client 的事），也不在这里做去重（协调器按 `id` 去重）。
 */

const PROTO_VERSION = 1;

/** 帧类型：握手 / 消息 / 心跳。 */
const FRAME = Object.freeze({
  HELLO: 'hello',
  HELLO_OK: 'hello_ok',
  HELLO_ERR: 'hello_err',
  MSG: 'msg',
  ACK: 'ack',
  PING: 'ping',
  PONG: 'pong'
});

/**
 * 信封类型。刻意与 `message-bus.js` 的措辞保持一致（task 相关的那几个），
 * 只多了 peer 独有的 `claim` 家族：租约必须有「请求 / 裁决」两帧，否则无法区分
 * 「我以为拿到了」和「别人先拿到了」。
 */
const ENVELOPE_TYPE = Object.freeze({
  MESSAGE: 'message',
  REPLY: 'reply',
  CLAIM: 'claim',
  CLAIM_REPLY: 'claim_reply',
  RELEASE: 'release',
  PRESENCE: 'presence'
});

const ENVELOPE_TYPES = Object.freeze(Object.values(ENVELOPE_TYPE));

const CLAIM_KIND = Object.freeze({
  FILE: 'file',
  TASK: 'task'
});

const MAX_ID_LEN = 96;
const MAX_NAME_LEN = 64;
const MAX_WORKSPACE_NAME_LEN = 160;
/** 工作身份（角色）长度上限：一行说明，不是小作文 */
const MAX_ROLE_LEN = 32;
const MAX_CLAIM_KEY_LEN = 512;
const MAX_CLAIM_NOTE_LEN = 400;

/** 内置生成器：不依赖 crypto，避免测试环境差异（碰撞概率足够低：时间戳 + 随机后缀）。 */
function newMessageId(prefix) {
  const rand = Math.random().toString(36).slice(2, 10);
  return `${prefix || 'pmsg'}_${Date.now().toString(36)}_${rand}`;
}

function str(value, maxLen) {
  const s = String(value == null ? '' : value);
  return maxLen ? s.slice(0, maxLen) : s;
}

function intOr(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

/**
 * 归一 workspace 标识。跨机比较只认 `key`（git remote 或路径指纹），
 * `path` / `name` 只用于展示——两台机器的绝对路径本来就不同。
 * @param {object} raw
 */
function normalizeWorkspace(raw) {
  const w = raw && typeof raw === 'object' ? raw : {};
  return {
    key: str(w.key, MAX_ID_LEN),
    name: str(w.name, MAX_WORKSPACE_NAME_LEN),
    path: str(w.path, 1024)
  };
}

/**
 * @typedef {object} PeerIdentityFrame
 * @property {string} peerId
 * @property {string} name
 * @property {ReturnType<typeof normalizeWorkspace>} workspace
 */

/**
 * 握手：**不带任何共享密钥**（P1 起取消配对码）。谁能给我发消息由本机信任清单决定，
 * 见 `coordinator.handleMessage`；握手阶段只交换身份、workspace 与租约快照。
 *
 * `role` 是**工作身份**（"发票模块 / 前端"这类自称），与 `name` 同源、同级别：
 * 都是对端自己在握手时声明的，所以界面必须按「对方自称」显示，**不参与任何授权判定**。
 * @param {{ peerId: string, name?: string, role?: string, workspace?: object, claims?: object[], port?: number }} input
 */
function createHello(input) {
  const src = input || /** @type {any} */ ({});
  return {
    t: FRAME.HELLO,
    v: PROTO_VERSION,
    peerId: str(src.peerId, MAX_ID_LEN),
    name: str(src.name, MAX_NAME_LEN),
    role: str(src.role, MAX_ROLE_LEN),
    workspace: normalizeWorkspace(src.workspace),
    claims: normalizeClaims(src.claims),
    port: intOr(src.port, 0),
    at: Date.now()
  };
}

/**
 * 握手回执。`trusted` 告诉对端「我这边是否已经允许你」：未确认时对端 UI 显示
 * 「等你确认」，而不是把 `NOT_TRUSTED` 当成网络故障去重试。
 * @param {{ peerId: string, name?: string, role?: string, workspace?: object, claims?: object[], trusted?: boolean }} input
 */
function createHelloOk(input) {
  const src = input || /** @type {any} */ ({});
  return {
    t: FRAME.HELLO_OK,
    v: PROTO_VERSION,
    peerId: str(src.peerId, MAX_ID_LEN),
    name: str(src.name, MAX_NAME_LEN),
    role: str(src.role, MAX_ROLE_LEN),
    workspace: normalizeWorkspace(src.workspace),
    claims: normalizeClaims(src.claims),
    trusted: src.trusted === true,
    at: Date.now()
  };
}

function createHelloErr(code, message) {
  return { t: FRAME.HELLO_ERR, v: PROTO_VERSION, code: str(code, 64), message: str(message, 400) };
}

/**
 * 租约声明（本地视图 + 线上视图同形）。
 * `expiresAt` 由持有者给定，接受方只做 clamp（不得超过自身 TTL 上限），不相信对端的任意时长。
 * @param {object} raw
 * @param {number} [maxTtlMs]
 */
function normalizeClaim(raw, maxTtlMs) {
  const c = raw && typeof raw === 'object' ? raw : {};
  const kind = String(c.kind || '');
  const now = Date.now();
  const ttlCap = Number.isFinite(maxTtlMs) && Number(maxTtlMs) > 0 ? Number(maxTtlMs) : 60 * 60 * 1000;
  const expiresAtRaw = intOr(c.expiresAt, now + ttlCap);
  return {
    kind: kind === CLAIM_KIND.TASK ? CLAIM_KIND.TASK : CLAIM_KIND.FILE,
    key: str(c.key, MAX_CLAIM_KEY_LEN),
    peerId: str(c.peerId, MAX_ID_LEN),
    peerName: str(c.peerName, MAX_NAME_LEN),
    sessionId: str(c.sessionId, MAX_ID_LEN),
    note: str(c.note, MAX_CLAIM_NOTE_LEN),
    createdAt: intOr(c.createdAt, now),
    expiresAt: Math.min(expiresAtRaw, now + ttlCap)
  };
}

/** @param {unknown} raw @param {number} [maxTtlMs] */
function normalizeClaims(raw, maxTtlMs) {
  const list = Array.isArray(raw) ? raw : [];
  const out = [];
  for (const item of list) {
    const c = normalizeClaim(item, maxTtlMs);
    if (c.key) out.push(c);
  }
  return out;
}

/**
 * 信封归一：**唯一**的入站信任边界。任何字段越界、类型非法、缺关键字段都返回 null，
 * 调用方据此丢弃（不做「尽量修补」，否则坏帧会以半成品形态进会话）。
 *
 * @param {unknown} raw
 * @param {{ maxTextChars?: number, maxTtlMs?: number, now?: number }} [opts]
 * @returns {null | {
 *   id: string, type: string, text: string, hops: number, createdAt: number,
 *   from: { peerId: string, name: string, role: string, sessionId: string },
 *   to: { peerId: string, sessionId: string },
 *   inReplyTo: string | null,
 *   claim: ReturnType<typeof normalizeClaim> | null,
 *   decision: 'grant' | 'deny' | null,
 *   note: string,
 *   roomId: string
 * }}
 */
function normalizeEnvelope(raw, opts = {}) {
  if (!raw || typeof raw !== 'object') return null;
  const env = /** @type {any} */ (raw);
  const type = String(env.type || '');
  if (!ENVELOPE_TYPES.includes(type)) return null;
  const from = env.from && typeof env.from === 'object' ? env.from : {};
  const to = env.to && typeof env.to === 'object' ? env.to : {};
  const fromPeerId = str(from.peerId, MAX_ID_LEN);
  if (!fromPeerId) return null;

  const maxTextChars = Number.isFinite(opts.maxTextChars) ? Number(opts.maxTextChars) : 8000;
  const text = str(env.text, maxTextChars);
  const hops = Math.max(0, Math.min(64, intOr(env.hops, 0)));
  const id = str(env.id, MAX_ID_LEN) || newMessageId('pin');

  const decisionRaw = String(env.decision || '');
  const decision = decisionRaw === 'grant' || decisionRaw === 'deny' ? decisionRaw : null;

  return {
    id,
    type,
    text,
    hops,
    createdAt: intOr(env.createdAt, opts.now || Date.now()),
    from: {
      peerId: fromPeerId,
      name: str(from.name, MAX_NAME_LEN),
      // 角色这里只是「信封里写了什么」；投递前由 `server.js` 用**握手得到的身份**覆盖，
      // 与 peerId / name 同一口径（见 docs/BOT-ROOM-PLAN.md §8）
      role: str(from.role, MAX_ROLE_LEN),
      sessionId: str(from.sessionId, MAX_ID_LEN)
    },
    to: {
      peerId: str(to.peerId, MAX_ID_LEN),
      sessionId: str(to.sessionId, MAX_ID_LEN)
    },
    inReplyTo: env.inReplyTo ? str(env.inReplyTo, MAX_ID_LEN) : null,
    claim: env.claim ? normalizeClaim(env.claim, opts.maxTtlMs) : null,
    decision,
    note: str(env.note, MAX_CLAIM_NOTE_LEN),
    // 房间标记：只是「这条消息属于我本机哪个房间」的标签，不参与授权。
    // 对端没有同名房间时按普通来信处理（房间是本机视图，见 docs/BOT-ROOM-PLAN.md §4）。
    roomId: str(env.roomId, MAX_ID_LEN)
  };
}

/**
 * 造一条外发信封（发送方身份由本地补齐，不信任模型给的字段）。
 * @param {object} input
 */
function createEnvelope(input) {
  const src = input || /** @type {any} */ ({});
  return {
    id: str(src.id, MAX_ID_LEN) || newMessageId('pmsg'),
    type: ENVELOPE_TYPES.includes(String(src.type)) ? String(src.type) : ENVELOPE_TYPE.MESSAGE,
    text: String(src.text == null ? '' : src.text),
    hops: Math.max(0, intOr(src.hops, 0)),
    createdAt: Date.now(),
    from: {
      peerId: str(src.fromPeerId, MAX_ID_LEN),
      name: str(src.fromName, MAX_NAME_LEN),
      role: str(src.fromRole, MAX_ROLE_LEN),
      sessionId: str(src.fromSessionId, MAX_ID_LEN)
    },
    to: {
      peerId: str(src.toPeerId, MAX_ID_LEN),
      sessionId: str(src.toSessionId, MAX_ID_LEN)
    },
    inReplyTo: src.inReplyTo ? str(src.inReplyTo, MAX_ID_LEN) : null,
    claim: src.claim || null,
    decision: src.decision === 'grant' || src.decision === 'deny' ? src.decision : null,
    note: str(src.note, MAX_CLAIM_NOTE_LEN),
    roomId: str(src.roomId, MAX_ID_LEN)
  };
}

/** 解析一帧（JSON 文本 → 对象）；坏 JSON 返回 null。 */
function parseFrame(raw) {
  try {
    const obj = JSON.parse(String(raw));
    if (!obj || typeof obj !== 'object') return null;
    return obj;
  } catch {
    return null;
  }
}

module.exports = {
  FRAME,
  ENVELOPE_TYPE,
  CLAIM_KIND,
  MAX_ROLE_LEN,
  normalizeClaim,
  normalizeClaims,
  normalizeEnvelope,
  createEnvelope,
  createHello,
  createHelloOk,
  createHelloErr,
  parseFrame
};
