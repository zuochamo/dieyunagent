'use strict';

const path = require('path');
const { loadModelSettings } = require('../model-settings');

const GRAPH_SOURCE_EXT = new Set([
  '.js',
  '.mjs',
  '.cjs',
  '.ts',
  '.tsx',
  '.jsx',
  '.py',
  '.go',
  '.rs'
]);

const DEFAULT_DEBOUNCE_MS = 800;
const WORKSPACE_OPEN_DEBOUNCE_MS = 1500;
const RETRY_DELAY_MS = 2000;
const CODEBASE_BUSY_RETRY_MS = 5000;

function isGraphSourcePath(filePath) {
  return GRAPH_SOURCE_EXT.has(path.extname(String(filePath || '')).toLowerCase());
}

function isUnderWorkspaceRoot(filePath, workspaceRoot) {
  if (!filePath || !workspaceRoot) return false;
  const rel = path.relative(path.resolve(workspaceRoot), path.resolve(filePath));
  if (rel === '') return true;
  return Boolean(rel) && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * Debounced background graph.index (force=false) after saves / workspace open.
 *
 * @param {{
 *   userDataPath: string,
 *   getWorkspaceRoot: () => string | null,
 *   isRemoteWorkspace: () => boolean,
 *   invokeRustCore: (method: string, params: object, timeoutMs?: number) => Promise<object | null>,
 *   log?: (msg: string) => void,
 *   debounceMs?: number,
 * }} opts
 */
function createGraphIncrementalScheduler(opts) {
  const debounceMs = opts.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const log = typeof opts.log === 'function' ? opts.log : () => {};
  /** @type {Map<string, ReturnType<typeof setTimeout>>} */
  const timers = new Map();
  /** @type {Set<string>} */
  const queuedAfterBusy = new Set();

  function isAutoEnabled() {
    const settings = loadModelSettings(opts.userDataPath);
    return settings.graphAutoIncremental !== false;
  }

  async function isCodebaseIndexing(workspaceRoot) {
    try {
      const st = await opts.invokeRustCore('codebase.status', { workspaceRoot }, 15000);
      return !!(st && st.indexing);
    } catch {
      return false;
    }
  }

  async function runIncremental(workspaceRoot, reason) {
    if (!workspaceRoot) return;
    if (!isAutoEnabled()) return;

    try {
      if (await isCodebaseIndexing(workspaceRoot)) {
        queuedAfterBusy.add(workspaceRoot);
        schedule(workspaceRoot, CODEBASE_BUSY_RETRY_MS, reason);
        return;
      }

      const st = await opts.invokeRustCore('graph.status', { workspaceRoot }, 30000);
      if (!st || !st.indexed) return;
      if (st.indexing) {
        queuedAfterBusy.add(workspaceRoot);
        schedule(workspaceRoot, RETRY_DELAY_MS, reason);
        return;
      }

      // 用 index.start 后台增量，避免同步 graph.index 堵死 stdio
      const result = await opts.invokeRustCore(
        'graph.index.start',
        { workspaceRoot, force: false, skipIfReady: false },
        60000
      );
      if (!result) {
        log(`[graph] incremental index skipped: start returned empty`);
        return;
      }
      log(`[graph] incremental index started (${reason || 'save'})`);
    } catch (err) {
      log(`[graph] incremental index skipped: ${err && (err.message || err)}`);
    } finally {
      if (queuedAfterBusy.has(workspaceRoot)) {
        queuedAfterBusy.delete(workspaceRoot);
      }
    }
  }

  function schedule(workspaceRoot, delayMs, reason) {
    if (!workspaceRoot) return;
    const key = path.resolve(workspaceRoot);
    const prev = timers.get(key);
    if (prev) clearTimeout(prev);
    timers.set(
      key,
      setTimeout(() => {
        timers.delete(key);
        void runIncremental(key, reason);
      }, delayMs ?? debounceMs)
    );
  }

  function resolveWorkspaceRoot(override) {
    const raw =
      override != null && String(override).trim()
        ? String(override).trim()
        : opts.getWorkspaceRoot();
    if (!raw) return null;
    return path.resolve(raw);
  }

  function notifyFileSaved(absPath, workspaceRootOverride) {
    const root = resolveWorkspaceRoot(workspaceRootOverride);
    if (!root) return;
    if (!workspaceRootOverride && opts.isRemoteWorkspace()) return;
    if (!isGraphSourcePath(absPath)) return;
    if (!isUnderWorkspaceRoot(absPath, root)) return;
    schedule(root, debounceMs, 'save');
  }

  function notifyWorkspaceOpened(workspaceRootOverride) {
    const root = resolveWorkspaceRoot(workspaceRootOverride);
    if (!root) return;
    if (!workspaceRootOverride && opts.isRemoteWorkspace()) return;
    schedule(root, WORKSPACE_OPEN_DEBOUNCE_MS, 'workspace');
  }

  return {
    notifyFileSaved,
    notifyWorkspaceOpened,
    isGraphSourcePath
  };
}

module.exports = {
  createGraphIncrementalScheduler,
  isGraphSourcePath,
  isUnderWorkspaceRoot,
  GRAPH_SOURCE_EXT
};
