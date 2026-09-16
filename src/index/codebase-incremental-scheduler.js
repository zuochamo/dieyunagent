'use strict';

const fs = require('fs');
const path = require('path');
const { loadModelSettings } = require('../model-settings');
const {
  isUnderWorkspaceRoot
} = require('../graph/graph-incremental-scheduler');

/** 明确二进制：永不触发增量索引。未知扩展名交给 dieyun-core 内容嗅探。 */
const CODEBASE_IGNORE_EXT = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.ico',
  '.bmp',
  '.zip',
  '.7z',
  '.rar',
  '.gz',
  '.exe',
  '.dll',
  '.so',
  '.dylib',
  '.pdf',
  '.woff',
  '.woff2',
  '.ttf',
  '.mp4',
  '.mp3',
  '.sqlite',
  '.db',
  '.wasm',
  '.pyc',
  '.class',
  '.jar'
]);

const DEFAULT_DEBOUNCE_MS = 800;
const WORKSPACE_OPEN_DEBOUNCE_MS = 1500;
const INDEX_BUSY_RETRY_MS = 5000;
const MAX_BUSY_RETRIES = 60;

function isCodebaseSourcePath(filePath) {
  const p = String(filePath || '');
  const ext = path.extname(p).toLowerCase();
  if (ext && CODEBASE_IGNORE_EXT.has(ext)) return false;
  const base = path.basename(p);
  if (base === 'Dockerfile' || base === 'Makefile' || base.startsWith('.env')) return true;
  // 已知文本或未知扩展：只要不像二进制就触发（具体是否可索引由 dieyun-core walker 嗅探）
  if (!ext) return true;
  try {
    const fd = fs.openSync(p, 'r');
    try {
      const buf = Buffer.alloc(512);
      const n = fs.readSync(fd, buf, 0, 512, 0);
      if (n <= 0) return false;
      for (let i = 0; i < n; i++) {
        if (buf[i] === 0) return false;
      }
      return true;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    // 文件可能刚删：仍返回 true，让后端侧忽略
    return true;
  }
}

/**
 * Debounced background codebase.index (force=false, mtime 增量) after saves / workspace open.
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
function createCodebaseIncrementalScheduler(opts) {
  const debounceMs = opts.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const log = typeof opts.log === 'function' ? opts.log : () => {};
  /** @type {Map<string, ReturnType<typeof setTimeout>>} */
  const timers = new Map();
  /** @type {Map<string, number>} */
  const busyRetries = new Map();
  /** @type {Map<string, number>} 最近一次「保存触发了刷新意图」的时间 */
  const lastSavedAt = new Map();

  function isAutoEnabled() {
    const settings = loadModelSettings(opts.userDataPath);
    return settings.codebaseAutoIncremental !== false;
  }

  async function runIncremental(workspaceRoot, reason) {
    if (!workspaceRoot) return;
    if (!isAutoEnabled()) return;

    try {
      const st = await opts.invokeRustCore('codebase.status', { workspaceRoot }, 15000);
      if (!st) {
        log(`[codebase] incremental index skipped: status unavailable`);
        return;
      }
      if (!st.indexed) return;
      if (st.indexing) {
        const n = (busyRetries.get(workspaceRoot) || 0) + 1;
        busyRetries.set(workspaceRoot, n);
        if (n > MAX_BUSY_RETRIES) {
          busyRetries.delete(workspaceRoot);
          log(`[codebase] incremental index skipped: still busy after ${MAX_BUSY_RETRIES} retries`);
          return;
        }
        schedule(workspaceRoot, INDEX_BUSY_RETRY_MS, reason);
        return;
      }
      busyRetries.delete(workspaceRoot);

      // 用 index.start 后台增量，避免同步 codebase.index 堵死 dieyun-core stdio
      const result = await opts.invokeRustCore(
        'codebase.index.start',
        { workspaceRoot, force: false, skipIfReady: false },
        60000
      );
      if (!result) {
        log(`[codebase] incremental index skipped: start returned empty`);
        return;
      }
      log(`[codebase] incremental index started (${reason || 'save'})`);
    } catch (err) {
      log(`[codebase] incremental index skipped: ${err && (err.message || err)}`);
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
    if (!isCodebaseSourcePath(absPath)) return;
    if (!isUnderWorkspaceRoot(absPath, root)) return;
    lastSavedAt.set(root, Date.now());
    schedule(root, debounceMs, 'save');
  }

  function notifyWorkspaceOpened(workspaceRootOverride) {
    const root = resolveWorkspaceRoot(workspaceRootOverride);
    if (!root) return;
    if (!workspaceRootOverride && opts.isRemoteWorkspace()) return;
    schedule(root, WORKSPACE_OPEN_DEBOUNCE_MS, 'workspace');
  }

  /**
   * 供 status / prep 判断「刚保存过、索引可能还没跟上」。
   * pending 为防抖窗口内（索引尚未启动），lastSavedAt 用于判断新鲜度。
   */
  function getRefreshState(workspaceRootOverride) {
    const root = resolveWorkspaceRoot(workspaceRootOverride);
    if (!root) return null;
    return {
      pending: timers.has(root),
      lastSavedAt: lastSavedAt.get(root) || 0
    };
  }

  return {
    notifyFileSaved,
    notifyWorkspaceOpened,
    getRefreshState,
    isCodebaseSourcePath
  };
}

module.exports = {
  createCodebaseIncrementalScheduler,
  isCodebaseSourcePath,
  CODEBASE_IGNORE_EXT
};
