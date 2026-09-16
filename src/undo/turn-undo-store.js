'use strict';

const fs = require('fs/promises');
const fsSync = require('fs');
const path = require('path');

const STORE_VERSION = 1;
const SAVE_DEBOUNCE_MS = 400;

function safeSessionFileName(sessionId) {
  return String(sessionId || 'unknown')
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .slice(0, 120);
}

function undoSessionsDir(userDataPath) {
  return path.join(String(userDataPath || ''), 'undo-sessions');
}

function sessionFilePath(userDataPath, sessionId) {
  return path.join(undoSessionsDir(userDataPath), `${safeSessionFileName(sessionId)}.json`);
}

function serializeSessionState(st) {
  if (!st) return null;
  const records = {};
  for (const [turnId, record] of st.records.entries()) {
    records[turnId] = record;
  }
  return {
    version: STORE_VERSION,
    activeTurnId: st.activeTurnId || null,
    stack: Array.isArray(st.stack) ? st.stack.slice() : [],
    records
  };
}

function deserializeSessionState(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const records = new Map();
  for (const [turnId, record] of Object.entries(raw.records || {})) {
    if (record && typeof record === 'object') records.set(turnId, record);
  }
  return {
    activeTurnId: raw.activeTurnId || null,
    stack: Array.isArray(raw.stack) ? raw.stack.slice() : [],
    records
  };
}

/**
 * @param {string} userDataPath
 */
function createTurnUndoStore(userDataPath) {
  const root = String(userDataPath || '').trim();
  /** @type {Map<string, ReturnType<typeof setTimeout>>} */
  const pendingTimers = new Map();
  /** @type {Map<string, object>} */
  const pendingPayloads = new Map();

  async function ensureDir() {
    if (!root) return;
    await fs.mkdir(undoSessionsDir(root), { recursive: true });
  }

  async function loadSession(sessionId) {
    return loadSessionSync(sessionId);
  }

  function loadSessionSync(sessionId) {
    const sid = String(sessionId || '').trim();
    if (!root || !sid) return null;
    const fp = sessionFilePath(root, sid);
    try {
      const text = fsSync.readFileSync(fp, 'utf8');
      const parsed = JSON.parse(text);
      return deserializeSessionState(parsed);
    } catch (err) {
      if (err && err.code === 'ENOENT') return null;
      return null;
    }
  }

  async function writeSessionNow(sessionId, st) {
    writeSessionSync(sessionId, st);
  }

  function writeSessionSync(sessionId, st) {
    const sid = String(sessionId || '').trim();
    if (!root || !sid || !st) return;
    const payload = serializeSessionState(st);
    if (!payload) return;
    fsSync.mkdirSync(undoSessionsDir(root), { recursive: true });
    const fp = sessionFilePath(root, sid);
    const tmp = `${fp}.${process.pid}.${Date.now()}.tmp`;
    const body = JSON.stringify(payload);
    fsSync.writeFileSync(tmp, body, 'utf8');
    fsSync.renameSync(tmp, fp);
  }

  function scheduleSave(sessionId, st) {
    const sid = String(sessionId || '').trim();
    if (!root || !sid || !st) return;
    pendingPayloads.set(sid, st);
    const prev = pendingTimers.get(sid);
    if (prev) clearTimeout(prev);
    pendingTimers.set(
      sid,
      setTimeout(() => {
        pendingTimers.delete(sid);
        const latest = pendingPayloads.get(sid);
        pendingPayloads.delete(sid);
        if (!latest) return;
        writeSessionNow(sid, latest).catch(() => {});
      }, SAVE_DEBOUNCE_MS)
    );
  }

  async function flushSession(sessionId) {
    const sid = String(sessionId || '').trim();
    if (!root || !sid) return;
    const timer = pendingTimers.get(sid);
    if (timer) {
      clearTimeout(timer);
      pendingTimers.delete(sid);
    }
    const st = pendingPayloads.get(sid);
    pendingPayloads.delete(sid);
    if (st) await writeSessionNow(sid, st);
  }

  async function deleteSession(sessionId) {
    const sid = String(sessionId || '').trim();
    if (!root || !sid) return;
    const timer = pendingTimers.get(sid);
    if (timer) {
      clearTimeout(timer);
      pendingTimers.delete(sid);
    }
    pendingPayloads.delete(sid);
    const fp = sessionFilePath(root, sid);
    try {
      await fs.unlink(fp);
    } catch (err) {
      if (err && err.code !== 'ENOENT') throw err;
    }
  }

  function hasStore() {
    return !!root;
  }

  return {
    hasStore,
    loadSession,
    loadSessionSync,
    scheduleSave,
    flushSession,
    deleteSession,
    writeSessionNow,
    writeSessionSync
  };
}

module.exports = {
  STORE_VERSION,
  createTurnUndoStore,
  serializeSessionState,
  deserializeSessionState,
  safeSessionFileName,
  undoSessionsDir
};
