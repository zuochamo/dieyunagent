/* global unpackUserMessageContent */
'use strict';

/** Initial fetch when cache miss; scroll-up page size. */
const CHAT_INITIAL_LOAD_LIMIT = 32;
const CHAT_LOAD_MORE_LIMIT = 100;
const MAX_CACHED_SESSIONS = 16;

/** @type {Map<string, { messages: object[], hasMore: boolean }>} */
const sessionMessageCache = new Map();
/** Sessions whose cache must not be used (background append / completion). */
const sessionMessageCacheStale = new Set();
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
      created_at: r.created_at
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

function applyMessagesFromCache(sessionId, targetMessages) {
  const cached = getSessionMessageCache(sessionId);
  if (!cached) return false;
  targetMessages.length = 0;
  targetMessages.push(...cached.messages);
  return true;
}

window.CHAT_INITIAL_LOAD_LIMIT = CHAT_INITIAL_LOAD_LIMIT;
window.CHAT_LOAD_MORE_LIMIT = CHAT_LOAD_MORE_LIMIT;
window.gatewayRowsToMessages = gatewayRowsToMessages;
window.saveSessionMessageCache = saveSessionMessageCache;
window.getSessionMessageCache = getSessionMessageCache;
window.getSessionCacheHasMore = getSessionCacheHasMore;
window.setSessionCacheHasMore = setSessionCacheHasMore;
window.invalidateSessionMessageCache = invalidateSessionMessageCache;
window.isSessionMessageCacheStale = isSessionMessageCacheStale;
window.clearSessionMessageCacheStale = clearSessionMessageCacheStale;
window.applyMessagesFromCache = applyMessagesFromCache;
