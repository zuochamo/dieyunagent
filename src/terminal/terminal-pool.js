'use strict';

const { sshTargetKey, normalizeRemotePath } = require('../workspace/target');

const MAX_PENDING_CHARS = 512 * 1024;
const TRIM_PENDING_TO = 256 * 1024;

/**
 * @param {{
 *   maxEntries?: number,
 *   log?: (msg: string) => void
 * }} [opts]
 */
function createTerminalPool(opts = {}) {
  const log = opts.log || (() => {});
  const maxEntries = Math.max(1, Number(opts.maxEntries) || 8);
  /** @type {Map<string, {
   *   sessionId: string,
   *   handle: { write: Function, kill: Function, shell?: string, cwd?: string },
   *   meta: object,
   *   pendingOutput: string,
   *   lastUsedAt: number,
   *   dataListener: ((text: string) => void) | null,
   *   exitListener: ((code: number | null) => void) | null
   * }>} */
  const entries = new Map();
  /** @type {string | null} */
  let attachedSessionId = null;

  function listSessionIds() {
    return [...entries.keys()];
  }

  function getEntry(sessionId) {
    const key = sessionId ? String(sessionId).trim() : '';
    return key ? entries.get(key) || null : null;
  }

  function getAttachedSessionId() {
    return attachedSessionId;
  }

  function trimPending(text) {
    if (text.length <= MAX_PENDING_CHARS) return text;
    return text.slice(-TRIM_PENDING_TO);
  }

  function touchEntry(entry) {
    entry.lastUsedAt = Date.now();
  }

  function evictIfOverCap() {
    if (entries.size <= maxEntries) return;
    const candidates = [...entries.entries()]
      .filter(([key]) => key !== attachedSessionId)
      .sort((a, b) => a[1].lastUsedAt - b[1].lastUsedAt);
    for (const [key, entry] of candidates) {
      if (entries.size <= maxEntries) break;
      try {
        entry.handle.kill();
      } catch {
        // ignore
      }
      entries.delete(key);
      log(`Terminal pool evicted ${key}`);
    }
  }

  /**
   * @param {string} sessionId
   * @param {{ write: Function, kill: Function }} handle
   * @param {object} meta
   */
  function register(sessionId, handle, meta = {}) {
    const key = String(sessionId || '').trim();
    if (!key) throw new Error('terminal pool: sessionId required');
    const prev = entries.get(key);
    if (prev && prev.handle !== handle) {
      try {
        prev.handle.kill();
      } catch {
        // ignore
      }
    }
    entries.set(key, {
      sessionId: key,
      handle,
      meta: { ...meta },
      pendingOutput: prev?.pendingOutput || '',
      lastUsedAt: Date.now(),
      dataListener: null,
      exitListener: null
    });
    evictIfOverCap();
    return entries.get(key);
  }

  function routeData(sessionId, text) {
    const key = String(sessionId || '').trim();
    const entry = key ? entries.get(key) : null;
    if (!entry) return;
    touchEntry(entry);
    if (attachedSessionId === key && entry.dataListener) {
      entry.dataListener(String(text || ''));
      return;
    }
    entry.pendingOutput = trimPending(entry.pendingOutput + String(text || ''));
  }

  function routeExit(sessionId, code) {
    const key = String(sessionId || '').trim();
    const entry = key ? entries.get(key) : null;
    if (!entry) return;
    entries.delete(key);
    if (attachedSessionId === key) {
      attachedSessionId = null;
      if (entry.exitListener) entry.exitListener(code ?? null);
      return;
    }
    void code;
  }

  /**
   * @param {string} sessionId
   * @param {{ onData?: (text: string) => void, onExit?: (code: number | null) => void }} listeners
   */
  function attach(sessionId, listeners = {}) {
    const key = String(sessionId || '').trim();
    const entry = key ? entries.get(key) : null;
    if (!entry) return null;
    attachedSessionId = key;
    entry.dataListener = typeof listeners.onData === 'function' ? listeners.onData : null;
    entry.exitListener = typeof listeners.onExit === 'function' ? listeners.onExit : null;
    touchEntry(entry);
    const pending = entry.pendingOutput;
    entry.pendingOutput = '';
    if (pending && entry.dataListener) entry.dataListener(pending);
    return entry;
  }

  function detach(sessionId) {
    const key = sessionId ? String(sessionId).trim() : attachedSessionId;
    if (!key) return;
    const entry = entries.get(key);
    if (entry) {
      entry.dataListener = null;
      entry.exitListener = null;
      touchEntry(entry);
    }
    if (attachedSessionId === key) attachedSessionId = null;
  }

  function write(data) {
    const key = attachedSessionId;
    if (!key) return false;
    return writeForSession(key, data);
  }

  function writeForSession(sessionId, data) {
    const key = sessionId ? String(sessionId).trim() : attachedSessionId;
    if (!key) return false;
    const entry = entries.get(key);
    if (!entry || !entry.handle) return false;
    entry.handle.write(String(data || ''));
    touchEntry(entry);
    return true;
  }

  function kill(sessionId) {
    const key = sessionId ? String(sessionId).trim() : attachedSessionId;
    if (!key) return;
    const entry = entries.get(key);
    if (!entry) return;
    try {
      entry.handle.kill();
    } catch {
      // ignore
    }
    entries.delete(key);
    if (attachedSessionId === key) attachedSessionId = null;
  }

  function killExceptSessionIds(keepIds) {
    const keep = new Set(
      [...(keepIds instanceof Set ? keepIds : keepIds || [])].map((id) => String(id || '').trim()).filter(Boolean)
    );
    for (const key of listSessionIds()) {
      if (keep.has(key)) continue;
      kill(key);
    }
  }

  function killForRemoteEndpoint(endpointKey, kind) {
    const ek = String(endpointKey || '').trim();
    if (!ek) return;
    for (const [key, entry] of entries.entries()) {
      if (entry.meta?.kind !== kind) continue;
      if (entry.meta?.endpointKey === ek) kill(key);
    }
  }

  function workspaceMetaFromTarget(target) {
    if (!target) {
      return { kind: 'local', endpointKey: 'local', workspaceKey: 'local' };
    }
    if (target.kind === 'ssh') {
      return {
        kind: 'ssh',
        endpointKey: sshTargetKey(target),
        workspaceKey: `ssh:${sshTargetKey(target)}|${normalizeRemotePath(target.remotePath || '/')}`,
        host: target.host,
        username: target.username,
        remotePath: target.remotePath
      };
    }
    const p = target.path ? String(target.path) : 'local';
    return { kind: 'local', endpointKey: 'local', workspaceKey: `local:${p}`, path: p };
  }

  return {
    register,
    attach,
    detach,
    write,
    writeForSession,
    kill,
    killExceptSessionIds,
    killForRemoteEndpoint,
    routeData,
    routeExit,
    getEntry,
    getAttachedSessionId,
    listSessionIds,
    workspaceMetaFromTarget
  };
}

module.exports = { createTerminalPool };
