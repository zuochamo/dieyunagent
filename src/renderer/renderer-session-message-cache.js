/* global unpackUserMessageContent */
'use strict';

/** 首屏只露最近这么多条。 */
const CHAT_INITIAL_LOAD_LIMIT = 32;
/**
 * 往上翻一页取多少条 —— 刻意小：一页就该是「再读一小段」，不是把剩下的全塞进来
 * （本机会话普遍一两百条，100 条一页等于一次点完，看不出渐进）。
 */
const CHAT_LOAD_MORE_LIMIT = 30;
/**
 * 对齐「轮次开头」时每次往前问多少条（与一页的宽度无关：宽一点才能一次就问到位够的区间）。
 */
const CHAT_TURN_ALIGN_FETCH = 100;
/**
 * 窗口头对齐到「轮次开头」时，为了补到那条用户消息最多再多拉多少条。
 * 一轮里塞满几百条工具消息时不能无限往前拉 —— 拉满就接受这个不齐的头。
 */
const CHAT_TURN_ALIGN_MAX_ROWS = 500;
const MAX_CACHED_SESSIONS = 16;

/** @type {Map<string, { messages: object[], hasMore: boolean }>} */
const sessionMessageCache = new Map();
/** Sessions whose cache must not be used (background append / completion). */
const sessionMessageCacheStale = new Set();
/**
 * 「视图可能比库少」的会话：跑动中沿用了缓存快照，而库里已经多了东西
 * （对端来信 / 回复在这期间落库）。只当标记用 —— 本轮结束时补一次真回源，
 * 这里不塞合并逻辑（见 `renderer-chat-history.js#resolveChatLoadMode`）。
 */
const sessionCacheDiverged = new Set();
/** @type {string[]} LRU order (newest access at end) */
const sessionCacheAccess = [];

function touchSessionCacheLru(sessionId) {
  const sid = String(sessionId || '').trim();
  if (!sid) return;
  const idx = sessionCacheAccess.indexOf(sid);
  if (idx >= 0) sessionCacheAccess.splice(idx, 1);
  sessionCacheAccess.push(sid);
}

function trimSessionMessageCache() {
  while (sessionCacheAccess.length > MAX_CACHED_SESSIONS) {
    const drop = sessionCacheAccess.shift();
    if (drop) sessionMessageCache.delete(drop);
  }
}

function cloneChatMessage(m) {
  if (!m || typeof m !== 'object') return m;
  return {
    ...m,
    meta: m.meta && typeof m.meta === 'object' ? { ...m.meta } : m.meta
  };
}

function gatewayRowsToMessages(rows) {
  const out = [];
  const unpack =
    typeof unpackUserMessageContent === 'function'
      ? unpackUserMessageContent
      : (raw) => ({ content: String(raw || ''), meta: null });
  for (const r of rows || []) {
    if (r.role !== 'user' && r.role !== 'assistant') continue;
    const unpacked = unpack(r.content);
    const packedMeta = unpacked.meta || null;
    out.push({
      id: r.id,
      localMsgId: r.id,
      role: r.role,
      content: r.content,
      displayContent: packedMeta?.inputText || undefined,
      meta: packedMeta || undefined,
      // 账本真思考（与 content 分列）：重建历史时只作上行回传真值来源，不并进 content。
      reasoning: typeof r.reasoning === 'string' && r.reasoning.trim() ? r.reasoning : undefined,
      // `memory.messages_*` 的返回是 Rust `MessageRow`（serde camelCase）→ 字段名是 `createdAt`。
      // 这里写 `r.created_at` 会永远读到 undefined，界面上每一轮的时间就退化成「渲染那一刻」
      // （回放会话时全变成同一个时间），触发条的 `ts` 也一起退化成 `Date.now()`。
      created_at: r.createdAt || r.created_at
    });
  }
  return out;
}

function saveSessionMessageCache(sessionId, messageList, opts = {}) {
  const sid = String(sessionId || '').trim();
  if (!sid || !Array.isArray(messageList)) return;
  const prev = sessionMessageCache.get(sid);
  const hasMore =
    opts.hasMore !== undefined ? !!opts.hasMore : prev ? prev.hasMore : false;
  sessionMessageCache.set(sid, {
    messages: messageList.map(cloneChatMessage),
    hasMore
  });
  sessionMessageCacheStale.delete(sid);
  touchSessionCacheLru(sid);
  trimSessionMessageCache();
}

function getSessionMessageCache(sessionId) {
  const sid = String(sessionId || '').trim();
  const entry = sessionMessageCache.get(sid);
  if (!entry || !entry.messages.length) return null;
  touchSessionCacheLru(sid);
  return {
    messages: entry.messages.map(cloneChatMessage),
    hasMore: !!entry.hasMore
  };
}

function getSessionCacheHasMore(sessionId) {
  const sid = String(sessionId || '').trim();
  return !!sessionMessageCache.get(sid)?.hasMore;
}

function setSessionCacheHasMore(sessionId, hasMore) {
  const sid = String(sessionId || '').trim();
  const entry = sessionMessageCache.get(sid);
  if (entry) entry.hasMore = !!hasMore;
}

function invalidateSessionMessageCache(sessionId) {
  const sid = String(sessionId || '').trim();
  if (!sid) return;
  sessionMessageCache.delete(sid);
  sessionMessageCacheStale.add(sid);
  const idx = sessionCacheAccess.indexOf(sid);
  if (idx >= 0) sessionCacheAccess.splice(idx, 1);
}

function isSessionMessageCacheStale(sessionId) {
  const sid = String(sessionId || '').trim();
  return sid ? sessionMessageCacheStale.has(sid) : false;
}

function clearSessionMessageCacheStale(sessionId) {
  const sid = String(sessionId || '').trim();
  if (sid) sessionMessageCacheStale.delete(sid);
}

/** 记下「这次没回源，视图可能比库少」：下一次机会必须真回源，别再拿缓存顶上。 */
function markSessionCacheDiverged(sessionId) {
  const sid = String(sessionId || '').trim();
  if (!sid) return false;
  sessionCacheDiverged.add(sid);
  return true;
}

function isSessionCacheDiverged(sessionId) {
  const sid = String(sessionId || '').trim();
  return sid ? sessionCacheDiverged.has(sid) : false;
}

function clearSessionCacheDiverged(sessionId) {
  const sid = String(sessionId || '').trim();
  if (sid) sessionCacheDiverged.delete(sid);
}

function applyMessagesFromCache(sessionId, targetMessages) {
  const cached = getSessionMessageCache(sessionId);
  if (!cached) return false;
  targetMessages.length = 0;
  targetMessages.push(...cached.messages);
  return true;
}

window.CHAT_INITIAL_LOAD_LIMIT = CHAT_INITIAL_LOAD_LIMIT;
window.CHAT_LOAD_MORE_LIMIT = CHAT_LOAD_MORE_LIMIT;
window.CHAT_TURN_ALIGN_FETCH = CHAT_TURN_ALIGN_FETCH;
window.CHAT_TURN_ALIGN_MAX_ROWS = CHAT_TURN_ALIGN_MAX_ROWS;
window.gatewayRowsToMessages = gatewayRowsToMessages;
window.saveSessionMessageCache = saveSessionMessageCache;
window.getSessionMessageCache = getSessionMessageCache;
window.getSessionCacheHasMore = getSessionCacheHasMore;
window.setSessionCacheHasMore = setSessionCacheHasMore;
window.invalidateSessionMessageCache = invalidateSessionMessageCache;
window.isSessionMessageCacheStale = isSessionMessageCacheStale;
window.clearSessionMessageCacheStale = clearSessionMessageCacheStale;
window.markSessionCacheDiverged = markSessionCacheDiverged;
window.isSessionCacheDiverged = isSessionCacheDiverged;
window.clearSessionCacheDiverged = clearSessionCacheDiverged;
window.applyMessagesFromCache = applyMessagesFromCache;
