'use strict';

/** @type {Map<string, AbortController>} */
const runControllers = new Map();
/** @type {Map<string, Set<string>>} */
const sessionToRuns = new Map();

function normalizeId(id) {
  const s = String(id || '').trim();
  return s || '';
}

/**
 * 为 agent run 注册/复用 AbortController（协议级 run 取消令牌）。
 * @param {string} runId
 * @param {string} [sessionId]
 * @returns {AbortController | null}
 */
function ensureRunAbortController(runId, sessionId) {
  const rid = normalizeId(runId);
  if (!rid) return null;
  let ac = runControllers.get(rid);
  if (!ac) {
    ac = new AbortController();
    runControllers.set(rid, ac);
  }
  const sid = normalizeId(sessionId);
  if (sid) {
    let set = sessionToRuns.get(sid);
    if (!set) {
      set = new Set();
      sessionToRuns.set(sid, set);
    }
    set.add(rid);
  }
  return ac;
}

/**
 * @param {string} runId
 * @returns {AbortSignal | null}
 */
function getRunAbortSignal(runId) {
  const ac = runControllers.get(normalizeId(runId));
  return ac ? ac.signal : null;
}

/**
 * @param {string} runId
 * @returns {boolean}
 */
function isRunAborted(runId) {
  const signal = getRunAbortSignal(runId);
  return !!(signal && signal.aborted);
}

/**
 * @param {string} runId
 * @returns {boolean} whether a controller existed and was aborted now
 */
function abortRun(runId) {
  const rid = normalizeId(runId);
  if (!rid) return false;
  const ac = runControllers.get(rid);
  if (!ac) return false;
  if (!ac.signal.aborted) {
    try {
      ac.abort();
    } catch {
      // ignore
    }
  }
  return true;
}

/**
 * @param {string} sessionId
 * @returns {string[]} aborted runIds
 */
function abortSessionRuns(sessionId) {
  const sid = normalizeId(sessionId);
  const set = sid ? sessionToRuns.get(sid) : null;
  const out = [];
  if (!set) return out;
  for (const rid of [...set]) {
    if (abortRun(rid)) out.push(rid);
  }
  return out;
}

/**
 * @param {string} runId
 */
function clearRunAbortController(runId) {
  const rid = normalizeId(runId);
  if (!rid) return;
  runControllers.delete(rid);
  for (const [sid, set] of sessionToRuns.entries()) {
    if (set.delete(rid) && set.size === 0) sessionToRuns.delete(sid);
  }
}

module.exports = {
  ensureRunAbortController,
  getRunAbortSignal,
  isRunAborted,
  abortRun,
  abortSessionRuns,
  clearRunAbortController
};
