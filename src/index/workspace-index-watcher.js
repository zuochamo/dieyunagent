'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_DEBOUNCE_MS = 1200;
/** watcher 出错（EMFILE / NFS 抖动 / 目录被替换）后的自动重建参数 */
const WATCH_RETRY_MS = 5000;
const MAX_WATCH_RETRIES = 3;

/** 粗过滤：明显不属于源码的目录/扩展名直接跳过，细过滤交给索引调度器 */
const IGNORE_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'out',
  '.dieyun',
  'coverage',
  '__pycache__',
  '.venv',
  'venv',
  '.next',
  '.nuxt',
  'target',
  'vendor',
  'win-unpacked'
]);

const IGNORE_EXT = new Set([
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
  '.wasm',
  '.pdf',
  '.woff',
  '.woff2',
  '.ttf',
  '.mp4',
  '.mp3',
  '.sqlite',
  '.db',
  '.pyc',
  '.class',
  '.jar'
]);

function isIgnoredRelPath(rel) {
  const norm = String(rel || '').replace(/\\/g, '/');
  if (!norm) return true;
  const parts = norm.split('/');
  for (const seg of parts.slice(0, -1)) {
    if (IGNORE_DIRS.has(seg) || seg.startsWith('.')) return true;
  }
  const base = parts[parts.length - 1];
  if (!base) return true;
  const ext = path.extname(base).toLowerCase();
  // 无扩展名的隐藏文件（.DS_Store 等）忽略；带扩展名的按类型判断，
  // 否则 .eslintrc.js / .babelrc.js 这类源码级 dotfile 会被漏掉
  if (!ext) return base.startsWith('.');
  return IGNORE_EXT.has(ext);
}

/**
 * 工作区索引监听：让**外部改动**（git checkout、外部编辑器、构建产物）也能触发
 * codebase / graph 的增量刷新——此前只有经 fs.write_file RPC 的写入才会触发。
 *
 * 只监听当前生效的本地工作区；远程工作区由远程 agent 侧负责。
 */
function createWorkspaceIndexWatcher(opts = {}) {
  const log = typeof opts.log === 'function' ? opts.log : () => {};
  const debounceMs = opts.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const onFileChanged = typeof opts.onFileChanged === 'function' ? opts.onFileChanged : () => {};
  /** @type {{ watcher: import('fs').FSWatcher, root: string, pending: Map<string, ReturnType<typeof setTimeout>> } | null} */
  let state = null;
  /** watcher 连续重建次数（start 成功即归零） */
  let retryCount = 0;

  function schedule(root, abs) {
    if (!state || state.root !== root) return;
    const key = abs.toLowerCase();
    const prev = state.pending.get(key);
    if (prev) clearTimeout(prev);
    state.pending.set(
      key,
      setTimeout(() => {
        if (state) state.pending.delete(key);
        try {
          onFileChanged(abs, root);
        } catch (err) {
          log(`[index-watch] notify failed: ${err && (err.message || err)}`);
        }
      }, debounceMs)
    );
  }

  function stop() {
    if (!state) return;
    for (const timer of state.pending.values()) clearTimeout(timer);
    try {
      state.watcher.close();
    } catch {
      /* 已关闭 */
    }
    log(`[index-watch] stopped ${state.root}`);
    state = null;
  }

  function start(rootIn) {
    const root = rootIn ? path.resolve(String(rootIn)) : null;
    if (!root) {
      stop();
      return { ok: false, skipped: 'no_workspace' };
    }
    if (state && state.root === root) return { ok: true, active: true };
    stop();
    let watcher;
    try {
      watcher = fs.watch(root, { recursive: true }, (eventType, filename) => {
        if (!filename) return;
        const rel = String(filename).replace(/\\/g, '/');
        if (isIgnoredRelPath(rel)) return;
        schedule(root, path.resolve(root, rel));
      });
    } catch (err) {
      log(`[index-watch] start failed: ${err && (err.message || err)}`);
      return { ok: false, error: err && (err.message || String(err)) };
    }
    watcher.on('error', (err) => {
      log(`[index-watch] error: ${err && (err.message || err)}`);
      // 出错的 watcher 已失效；只 log 不清 state 会让「同 root 直接复用」永远拿不到新监听
      if (!state || state.watcher !== watcher) return;
      for (const timer of state.pending.values()) clearTimeout(timer);
      try {
        watcher.close();
      } catch {
        /* 已关闭 */
      }
      state = null;
      // 多数错误是瞬时的（EMFILE / 目录被替换）；限次自动重建，避免监听静默失效
      if (retryCount < MAX_WATCH_RETRIES) {
        retryCount += 1;
        const retryRoot = root;
        setTimeout(() => {
          if (!state) start(retryRoot);
        }, WATCH_RETRY_MS).unref?.();
      }
    });
    state = { watcher, root, pending: new Map() };
    retryCount = 0;
    log(`[index-watch] watching ${root}`);
    return { ok: true, active: true };
  }

  return {
    start,
    stop,
    getStatus: () => ({ active: !!state, root: state ? state.root : null })
  };
}

module.exports = { createWorkspaceIndexWatcher, isIgnoredRelPath };
