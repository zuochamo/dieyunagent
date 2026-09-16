'use strict';

/**
 * Per-session browser metadata + active view session (BrowserView is singleton).
 */
function createBrowserSessionScope() {
  /** @type {string | null} */
  let activeViewSessionId = null;
  /** @type {Map<string, { url?: string, title?: string, engine?: string, updatedAt?: number }>} */
  const meta = new Map();

  function setActiveViewSessionId(sessionId) {
    activeViewSessionId = sessionId != null && String(sessionId).trim() ? String(sessionId).trim() : null;
  }

  function getActiveViewSessionId() {
    return activeViewSessionId;
  }

  function isBackgroundSession(sessionId) {
    if (!sessionId) return false;
    const sid = String(sessionId).trim();
    if (!sid) return false;
    if (!activeViewSessionId) return false;
    return sid !== activeViewSessionId;
  }

  function updateMeta(sessionId, patch) {
    if (!sessionId) return;
    const sid = String(sessionId).trim();
    if (!sid) return;
    const prev = meta.get(sid) || {};
    meta.set(sid, { ...prev, ...(patch || {}), updatedAt: Date.now() });
  }

  function getMeta(sessionId) {
    if (!sessionId) return null;
    return meta.get(String(sessionId).trim()) || null;
  }

  function removeMeta(sessionId) {
    if (!sessionId) return;
    meta.delete(String(sessionId).trim());
  }

  return {
    setActiveViewSessionId,
    getActiveViewSessionId,
    isBackgroundSession,
    updateMeta,
    getMeta,
    removeMeta
  };
}

module.exports = { createBrowserSessionScope };
