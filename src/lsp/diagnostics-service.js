'use strict';

const fs = require('fs/promises');
const path = require('path');
const { LspClient } = require('./lsp-client');
const { getLanguageIdForPath, getServerKeyForLanguage, getServerSpec, resolveTsServerPath } = require('./language-registry');
const fsSync = require('fs');
const {
  findProjectRoot,
  findWorkspaceTsProjectRoot,
  findWorkspacePyProjectRoot,
  findWorkspaceEslintProjectRoot,
  findWorkspaceRuffProjectRoot,
  findWorkspacePrettierProjectRoot
} = require('./project-root');
const {
  runTscFallback,
  runPyrightFallback,
  runRemoteTscBatch,
  runRemoteEslintBatch,
  runRemoteRuffBatch,
  runRemotePrettierBatch,
  runRemoteEslintProjectScan,
  runRemoteRuffProjectScan,
  runRemoteTscProjectScan,
  runRemotePrettierProjectScan,
  runTscProjectScan,
  runPyrightProjectScan,
  runEslintProjectScan,
  runRuffProjectScan,
  runPrettierProjectScan,
  runEslintFileScan,
  runRuffFileScan,
  runPrettierFileScan,
  isPlausibleDiagnosticFilePath,
  runCargoCheckFallback,
  runGoVetFallback
} = require('./cli-fallback');
const {
  upsertEngineLayer,
  clearEngineLayer,
  removeFileFromBucket,
  snapshotBucket,
  buildItemView,
  normalizeStoreFileKey
} = require('./diagnostics-store');
const { resolveSymbolCallers, DEFAULT_RESOLVE_TIMEOUT_MS } = require('./reference-service');
const { queryLspPosition } = require('./navigate-service');

const DEFAULT_MAX_FILES = 6;
const DEFAULT_MAX_PER_FILE = 20;
const DEFAULT_TIMEOUT_MS = 8000;
const CACHE_TTL_MS = 30000;
const STORE_STALE_MS = 45000;
const PROJECT_SCAN_COOLDOWN_MS = 10 * 60 * 1000;
const PROJECT_SCAN_TIMEOUT_MS = 120000;
const PROJECT_SCAN_MAX_FILES = 0;
const PROJECT_SCAN_MAX_PER_FILE = 12;
const IDLE_SHUTDOWN_MS = 5 * 60 * 1000;
const WATCH_DEBOUNCE_MS = 450;
const SSH_DIRTY_POLL_MS = 25000;
const WATCH_IGNORE_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  '.next',
  'coverage',
  '.venv',
  'venv',
  '__pycache__',
  '.dieyun'
]);
const WATCH_EXT_RE = /\.(tsx?|jsx?|mjs|cjs|vue|py|json|md|css|scss|less|html|yaml|yml)$/i;
const ESLINT_FILE_RE = /\.(tsx?|jsx?|mjs|cjs|vue)$/i;
const RUFF_FILE_RE = /\.py$/i;
const PRETTIER_FILE_RE = /\.(tsx?|jsx?|mjs|cjs|vue|json|md|css|scss|less|html|yaml|yml)$/i;

function lspSettingsPath(userDataPath) {
  return path.join(userDataPath, 'lsp-settings.json');
}

function loadLspSettings(userDataPath) {
  const defaults = {
    enabled: true,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    cacheTtlMs: CACHE_TTL_MS,
    maxFiles: DEFAULT_MAX_FILES,
    maxPerFile: DEFAULT_MAX_PER_FILE,
    minSeverity: 'warning'
  };
  try {
    const raw = JSON.parse(require('fs').readFileSync(lspSettingsPath(userDataPath), 'utf8'));
    return {
      enabled: raw.enabled !== false,
      timeoutMs: Number(raw.timeoutMs) || DEFAULT_TIMEOUT_MS,
      cacheTtlMs: Number(raw.cacheTtlMs) || CACHE_TTL_MS,
      maxFiles: Number(raw.maxFiles) || DEFAULT_MAX_FILES,
      maxPerFile: Number(raw.maxPerFile) || DEFAULT_MAX_PER_FILE,
      minSeverity: raw.minSeverity === 'error' ? 'error' : 'warning'
    };
  } catch {
    return defaults;
  }
}

function saveLspSettings(userDataPath, partial) {
  const current = loadLspSettings(userDataPath);
  const next = {
    enabled: partial && partial.enabled !== undefined ? partial.enabled !== false : current.enabled,
    timeoutMs:
      partial && partial.timeoutMs != null
        ? Math.max(1000, Number(partial.timeoutMs) || current.timeoutMs)
        : current.timeoutMs,
    cacheTtlMs:
      partial && partial.cacheTtlMs != null
        ? Math.max(1000, Number(partial.cacheTtlMs) || current.cacheTtlMs)
        : current.cacheTtlMs,
    maxFiles:
      partial && partial.maxFiles != null
        ? Math.max(1, Number(partial.maxFiles) || current.maxFiles)
        : current.maxFiles,
    maxPerFile:
      partial && partial.maxPerFile != null
        ? Math.max(1, Number(partial.maxPerFile) || current.maxPerFile)
        : current.maxPerFile,
    minSeverity:
      partial && partial.minSeverity === 'error' ? 'error' : current.minSeverity
  };
  require('fs').mkdirSync(path.dirname(lspSettingsPath(userDataPath)), { recursive: true });
  require('fs').writeFileSync(lspSettingsPath(userDataPath), JSON.stringify(next, null, 2), 'utf8');
  return next;
}

function resolveFileAbs(filePath, workspaceRoot) {
  const raw = String(filePath || '').trim();
  if (!raw) return null;
  if (path.isAbsolute(raw)) return path.normalize(raw);
  if (!workspaceRoot) return null;
  return path.normalize(path.join(workspaceRoot, raw));
}

function isUnderRoot(absPath, workspaceRoot) {
  if (!absPath || !workspaceRoot) return false;
  const abs = String(absPath).replace(/\\/g, '/');
  const root = String(workspaceRoot).replace(/\\/g, '/').replace(/\/$/, '');
  if (root.startsWith('/') || abs.startsWith('/')) {
    return abs === root || abs.startsWith(`${root}/`);
  }
  const resolvedRoot = path.resolve(workspaceRoot);
  const resolvedAbs = path.resolve(absPath);
  const rel = path.relative(resolvedRoot, resolvedAbs);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function workspaceStoreKey(workspaceRoot) {
  const raw = String(workspaceRoot || '').trim().replace(/\\/g, '/').replace(/\/$/, '');
  if (raw.startsWith('/')) return raw.toLowerCase();
  return path.resolve(raw).toLowerCase();
}

function filterDiagnosticsBySeverity(diagnostics, minSeverity) {
  const rows = Array.isArray(diagnostics) ? diagnostics : [];
  if (minSeverity === 'error') {
    return rows.filter((d) => d && d.severity === 'error');
  }
  return rows.filter((d) => d && (d.severity === 'error' || d.severity === 'warning'));
}

function hasRelevantDiagnostics(diagnostics, minSeverity) {
  return filterDiagnosticsBySeverity(diagnostics, minSeverity).length > 0;
}

/**
 * @param {{ userDataPath: string, log?: (msg: string) => void }} opts
 */
function createLspDiagnosticsService(opts) {
  const userDataPath = opts.userDataPath;
  const log = opts.log || (() => {});
  /** @type {(workspaceRoot: string, filePath?: string) => void} */
  let onStoreUpdated = typeof opts.onStoreUpdated === 'function' ? opts.onStoreUpdated : null;

  /** @type {Map<string, Map<string, LspClient>>} workspaceRoot -> serverKey -> client */
  const clients = new Map();
  /** @type {Map<string, { diagnostics: object[], ts: number }>} */
  const cache = new Map();
  /** @type {Map<string, NodeJS.Timeout>} */
  const idleTimers = new Map();
  /** @type {Map<string, { file: string, diagnostics: object[], ts: number, language: string, server: string }>} */
  const liveDiagnostics = new Map();
  /** @type {Map<string, Map<string, { file: string, diagnostics: object[], ts: number, language: string, server: string, source: string }>>} */
  const workspaceStores = new Map();
  /** @type {Map<string, { running: Promise<any>|null, lastTs: number, lastResult: object|null }>} */
  const projectScanState = new Map();
  /** @type {Map<string, { watcher: import('fs').FSWatcher|null, pollTimer: NodeJS.Timeout|null, sshExec?: Function|null, pending: Map<string, NodeJS.Timeout>, refreshing: Set<string>, workspaceRoot: string, mode: string }>} */
  const watchState = new Map();

  function getWorkspaceBucket(workspaceRoot) {
    const wk = workspaceStoreKey(workspaceRoot);
    if (!workspaceStores.has(wk)) workspaceStores.set(wk, new Map());
    return workspaceStores.get(wk);
  }

  function upsertWorkspaceStoreEntry(workspaceRoot, item, engineKey) {
    if (!item || !item.file) return;
    if (!isPlausibleDiagnosticFilePath(item.file, workspaceRoot)) return;
    const rootNorm = String(workspaceRoot || '').replace(/\\/g, '/');
    const fileNorm = String(item.file || '').replace(/\\/g, '/');
    if (rootNorm.startsWith('/')) {
      const abs = fileNorm.startsWith('/') ? fileNorm : `${rootNorm.replace(/\/$/, '')}/${fileNorm.replace(/^\.\//, '')}`;
      if (!isUnderRoot(abs, workspaceRoot)) return;
      const bucket = getWorkspaceBucket(workspaceRoot);
      const engine = engineKey || inferEngineKey(item);
      upsertEngineLayer(bucket, abs, engine, { ...item, file: abs });
      return;
    }
    const abs = path.resolve(String(item.file));
    if (!isUnderRoot(abs, workspaceRoot)) return;
    const bucket = getWorkspaceBucket(workspaceRoot);
    const engine = engineKey || inferEngineKey(item);
    upsertEngineLayer(bucket, abs, engine, item);
  }

  function inferEngineKey(item) {
    const server = String(item.server || '');
    if (server.includes('eslint')) return 'eslint';
    if (server.includes('ruff')) return 'ruff';
    if (server.includes('prettier')) return 'prettier';
    if (server.includes('pyright')) return 'pyright';
    if (server.includes('tsc')) return 'tsc';
    if (item.source === 'report') return 'report';
    if (item.source === 'project_scan') return 'tsc';
    return 'lsp';
  }

  function getWorkspaceStoreEntry(workspaceRoot, absPath) {
    const entry = getWorkspaceBucket(workspaceRoot).get(normalizeStoreFileKey(absPath));
    return entry ? buildItemView(entry) : null;
  }

  function removeWorkspaceStoreEntry(workspaceRoot, absPath) {
    if (!absPath) return;
    removeFileFromBucket(getWorkspaceBucket(workspaceRoot), absPath);
  }

  function liveKey(absPath) {
    return path.resolve(String(absPath)).toLowerCase();
  }

  function clientKey(workspaceRoot, serverKey) {
    return `${workspaceRoot}::${serverKey}`;
  }

  function touchClient(key) {
    const prev = idleTimers.get(key);
    if (prev) clearTimeout(prev);
    idleTimers.set(
      key,
      setTimeout(() => {
        void shutdownClientKey(key);
      }, IDLE_SHUTDOWN_MS)
    );
  }

  async function shutdownClientKey(key) {
    idleTimers.delete(key);
    const [workspaceRoot, serverKey] = key.split('::');
    const bucket = clients.get(workspaceRoot);
    if (!bucket) return;
    const client = bucket.get(serverKey);
    if (client) {
      await client.shutdown().catch(() => {});
      bucket.delete(serverKey);
    }
    if (bucket.size === 0) clients.delete(workspaceRoot);
  }

  async function getClient(workspaceRoot, serverKey) {
    const spec = getServerSpec(serverKey, userDataPath, workspaceRoot);
    if (!spec) return null;
    if (!clients.has(workspaceRoot)) clients.set(workspaceRoot, new Map());
    const bucket = clients.get(workspaceRoot);
    if (bucket.has(serverKey)) {
      const existing = bucket.get(serverKey);
      if (existing && !existing.closed) {
        touchClient(clientKey(workspaceRoot, serverKey));
        return existing;
      }
      bucket.delete(serverKey);
    }
    const client = new LspClient({
      spec,
      workspaceRoot,
      serverKey,
      log
    });
    bucket.set(serverKey, client);
    touchClient(clientKey(workspaceRoot, serverKey));
    return client;
  }

  /** 当前已知的 client 列表（供 workspaceSymbol 选 server，不主动启动） */
  function listClients(workspaceRoot) {
    const out = [];
    for (const [root, bucket] of clients.entries()) {
      for (const [serverKey, client] of bucket.entries()) {
        out.push({
          workspaceRoot: root,
          serverKey,
          serverId: (client && client.spec && client.spec.id) || serverKey,
          initialized: !!(client && client.initialized)
        });
      }
    }
    return out;
  }

  function cacheGet(key, ttlMs) {
    const hit = cache.get(key);
    if (!hit) return null;
    if (Date.now() - hit.ts > ttlMs) {
      cache.delete(key);
      return null;
    }
    return hit.diagnostics;
  }

  function cacheSet(key, diagnostics, ttlMs) {
    cache.set(key, { diagnostics, ts: Date.now() });
    if (cache.size > 200) {
      const oldest = [...cache.entries()].sort((a, b) => a[1].ts - b[1].ts)[0];
      if (oldest) cache.delete(oldest[0]);
    }
    void ttlMs;
  }

  /**
   * @param {{
   *   workspaceRoot: string,
   *   files: string[],
   *   maxFiles?: number,
   *   maxPerFile?: number,
   *   minSeverity?: string,
   *   timeoutMs?: number,
   *   assertReadable?: (absPath: string) => Promise<string>
   * }} opts
   */
  async function diagnoseFiles(opts) {
    const settings = loadLspSettings(userDataPath);
    if (!settings.enabled) {
      return { ok: true, enabled: false, cached: false, items: [], skipped: [] };
    }

    const workspaceRoot = path.resolve(String(opts.workspaceRoot || ''));
    if (!workspaceRoot) {
      return { ok: false, error: 'workspaceRoot 必填', items: [], skipped: [] };
    }

    const maxFiles = opts.maxFiles != null ? Number(opts.maxFiles) : settings.maxFiles;
    const maxPerFile = opts.maxPerFile != null ? Number(opts.maxPerFile) : settings.maxPerFile;
    const minSeverity = opts.minSeverity || settings.minSeverity;
    const timeoutMs = opts.timeoutMs != null ? Number(opts.timeoutMs) : settings.timeoutMs;
    const assertReadable = opts.assertReadable;

    const unique = [];
    const seen = new Set();
    for (const f of opts.files || []) {
      const abs = resolveFileAbs(f, workspaceRoot);
      if (!abs || seen.has(abs.toLowerCase())) continue;
      if (!isUnderRoot(abs, workspaceRoot)) continue;
      seen.add(abs.toLowerCase());
      unique.push(abs);
      if (unique.length >= maxFiles) break;
    }

    const items = [];
    const skipped = [];
    let anyCached = false;

    for (const absPath of unique) {
      const result = await diagnoseOneLocalFile(absPath, {
        workspaceRoot,
        settings,
        minSeverity,
        timeoutMs,
        maxPerFile,
        assertReadable
      });
      if (result.skipped) {
        skipped.push(result.skipped);
        continue;
      }
      if (result.item) {
        if (result.item.cached) anyCached = true;
        upsertWorkspaceStoreEntry(workspaceRoot, result.item, 'lsp');
        items.push(result.item);
      }
    }

    return {
      ok: true,
      enabled: true,
      mode: 'local_lsp',
      cached: anyCached,
      workspaceRoot,
      items,
      skipped
    };
  }

  /**
   * SSH 工作区：不 spawn 本地 LSP，远程跑 tsc CLI。
   * @param {{
   *   sshExec: (command: string, cwd: string | null, timeoutMs: number) => Promise<{ stdout?: string, stderr?: string }>,
   *   workspaceRoot: string,
   *   files: string[],
   *   maxFiles?: number,
   *   maxPerFile?: number,
   *   minSeverity?: string,
   *   timeoutMs?: number
   * }} opts
   */
  async function diagnoseFilesRemote(opts) {
    const settings = loadLspSettings(userDataPath);
    if (!settings.enabled) {
      return { ok: true, enabled: false, mode: 'ssh_cli', cached: false, items: [], skipped: [] };
    }

    const workspaceRoot = String(opts.workspaceRoot || '').replace(/\\/g, '/').replace(/\/$/, '');
    if (!workspaceRoot) {
      return { ok: false, error: 'workspaceRoot 必填', items: [], skipped: [] };
    }

    const maxFiles = opts.maxFiles != null ? Number(opts.maxFiles) : settings.maxFiles;
    const maxPerFile = opts.maxPerFile != null ? Number(opts.maxPerFile) : settings.maxPerFile;
    const minSeverity = opts.minSeverity || settings.minSeverity;
    const timeoutMs = opts.timeoutMs != null ? Number(opts.timeoutMs) : settings.timeoutMs;
    const sshExec = opts.sshExec;
    if (typeof sshExec !== 'function') {
      return { ok: false, error: 'SSH exec 不可用', items: [], skipped: [] };
    }

    const items = [];
    const skipped = [];
    const fileList = (opts.files || []).slice(0, maxFiles);
    const tsTargets = [];
    const pyTargets = [];
    const eslintTargets = [];
    const prettierTargets = [];

    for (const f of fileList) {
      const rel = String(f || '').trim().replace(/\\/g, '/');
      if (!rel) continue;
      const absRemote = rel.startsWith('/') ? rel : `${workspaceRoot}/${rel.replace(/^\.\//, '')}`;
      const ext = path.extname(rel).toLowerCase();
      if (['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'].includes(ext)) {
        tsTargets.push(absRemote);
        if (ESLINT_FILE_RE.test(rel)) eslintTargets.push(absRemote);
        if (PRETTIER_FILE_RE.test(rel)) prettierTargets.push(absRemote);
      } else if (ext === '.py') {
        pyTargets.push(absRemote);
      } else if (PRETTIER_FILE_RE.test(rel)) {
        prettierTargets.push(absRemote);
      } else {
        skipped.push({ file: absRemote, reason: 'remote_unsupported_ext' });
      }
    }

    const scanOpts = {
      exec: sshExec,
      projectRoot: workspaceRoot,
      timeoutMs,
      minSeverity,
      maxPerFile
    };

    const [tscDiags, eslintDiags, ruffDiags, prettierDiags] = await Promise.all([
      tsTargets.length
        ? runRemoteTscBatch({ ...scanOpts, absPaths: tsTargets }).catch(() => new Map())
        : Promise.resolve(new Map()),
      eslintTargets.length
        ? runRemoteEslintBatch({ ...scanOpts, absPaths: eslintTargets }).catch(() => new Map())
        : Promise.resolve(new Map()),
      pyTargets.length
        ? runRemoteRuffBatch({ ...scanOpts, absPaths: pyTargets }).catch(() => new Map())
        : Promise.resolve(new Map()),
      prettierTargets.length
        ? runRemotePrettierBatch({ ...scanOpts, absPaths: prettierTargets }).catch(() => new Map())
        : Promise.resolve(new Map())
    ]);

    const allFiles = new Set([...tsTargets, ...pyTargets, ...eslintTargets, ...prettierTargets]);
    for (const absRemote of allFiles) {
      if (tscDiags.has(absRemote)) {
        upsertWorkspaceStoreEntry(
          workspaceRoot,
          {
            file: absRemote,
            diagnostics: tscDiags.get(absRemote) || [],
            language: 'typescript',
            server: 'tsc-cli-remote',
            source: 'ssh_cli'
          },
          'tsc'
        );
      }
      if (eslintDiags.has(absRemote)) {
        upsertWorkspaceStoreEntry(
          workspaceRoot,
          {
            file: absRemote,
            diagnostics: eslintDiags.get(absRemote) || [],
            language: 'javascript',
            server: 'eslint-cli-remote',
            source: 'ssh_cli'
          },
          'eslint'
        );
      }
      if (ruffDiags.has(absRemote)) {
        upsertWorkspaceStoreEntry(
          workspaceRoot,
          {
            file: absRemote,
            diagnostics: ruffDiags.get(absRemote) || [],
            language: 'python',
            server: 'ruff-cli-remote',
            source: 'ssh_cli'
          },
          'ruff'
        );
      }
      if (prettierDiags.has(absRemote)) {
        upsertWorkspaceStoreEntry(
          workspaceRoot,
          {
            file: absRemote,
            diagnostics: prettierDiags.get(absRemote) || [],
            language: '',
            server: 'prettier-cli-remote',
            source: 'ssh_cli'
          },
          'prettier'
        );
      }
      const view = getWorkspaceStoreEntry(workspaceRoot, absRemote);
      if (view) {
        items.push({
          file: view.file,
          language: view.language,
          server: view.server,
          projectRoot: workspaceRoot,
          diagnostics: view.diagnostics,
          cached: false,
          remote: true
        });
      }
    }

    return {
      ok: true,
      enabled: true,
      mode: 'ssh_cli',
      cached: false,
      workspaceRoot,
      items,
      skipped
    };
  }

  async function getStatus() {
    const settings = loadLspSettings(userDataPath);
    const active = [];
    for (const [workspaceRoot, bucket] of clients.entries()) {
      for (const [serverKey, client] of bucket.entries()) {
        active.push({
          workspaceRoot,
          serverKey,
          serverId: client.spec?.id || serverKey,
          initialized: client.initialized
        });
      }
    }
    return { settings, active, cacheSize: cache.size, storeWorkspaces: workspaceStores.size };
  }

  async function shutdown() {
    for (const key of [...idleTimers.keys()]) {
      clearTimeout(idleTimers.get(key));
      idleTimers.delete(key);
    }
    for (const wk of [...watchState.keys()]) {
      stopWorkspaceDiagnosticsWatch(wk);
    }
    const closes = [];
    for (const bucket of clients.values()) {
      for (const client of bucket.values()) {
        closes.push(client.shutdown().catch(() => {}));
      }
    }
    await Promise.all(closes);
    clients.clear();
    cache.clear();
    workspaceStores.clear();
    liveDiagnostics.clear();
  }

  function invalidateCache() {
    cache.clear();
    workspaceStores.clear();
    liveDiagnostics.clear();
  }

  function invalidateCacheForPath(filePath) {
    if (!filePath) {
      invalidateCache();
      return;
    }
    const needle = path.resolve(String(filePath)).toLowerCase();
    for (const key of [...cache.keys()]) {
      const parts = key.split('|');
      if (parts.length >= 2 && parts[1].toLowerCase() === needle) {
        cache.delete(key);
      }
    }
    liveDiagnostics.delete(needle);
  }

  function removeWorkspaceStoreFile(workspaceRoot, absPath) {
    removeWorkspaceStoreEntry(workspaceRoot, absPath);
    notifyStoreUpdated(workspaceRoot, absPath);
  }

  function notifyStoreUpdated(workspaceRoot, filePath) {
    if (onStoreUpdated) {
      try {
        onStoreUpdated(workspaceRoot, filePath);
      } catch {
        // ignore
      }
    }
  }

  function isWatchableRelativePath(relPath) {
    const rel = String(relPath || '').replace(/\\/g, '/');
    if (!rel || rel.endsWith('~')) return false;
    const parts = rel.split('/').filter(Boolean);
    for (const part of parts) {
      if (WATCH_IGNORE_DIRS.has(part)) return false;
    }
    const base = parts[parts.length - 1] || '';
    return WATCH_EXT_RE.test(base);
  }

  function normalizeWatchRoot(workspaceRoot) {
    const raw = String(workspaceRoot || '').trim().replace(/\\/g, '/').replace(/\/$/, '');
    if (raw.startsWith('/')) return raw;
    return path.resolve(raw);
  }

  function getWatchBucket(workspaceRoot) {
    const wk = workspaceStoreKey(workspaceRoot);
    if (!watchState.has(wk)) {
      watchState.set(wk, {
        watcher: null,
        pollTimer: null,
        pending: new Map(),
        refreshing: new Set(),
        workspaceRoot: normalizeWatchRoot(workspaceRoot),
        mode: 'local',
        sshExec: null
      });
    }
    return watchState.get(wk);
  }

  function stopWorkspaceDiagnosticsWatch(workspaceRoot) {
    const wk = workspaceStoreKey(workspaceRoot);
    const bucket = watchState.get(wk);
    if (!bucket) return;
    if (bucket.watcher) {
      try {
        bucket.watcher.close();
      } catch {
        // ignore
      }
    }
    if (bucket.pollTimer) {
      clearInterval(bucket.pollTimer);
    }
    for (const timer of bucket.pending.values()) {
      clearTimeout(timer);
    }
    watchState.delete(wk);
  }

  async function pollSshDirtyFiles(workspaceRoot, sshExec) {
    const root = String(workspaceRoot || '').replace(/\\/g, '/').replace(/\/$/, '');
    if (!root || typeof sshExec !== 'function') return;
    const cmd =
      'git diff --name-only HEAD 2>/dev/null; git diff --name-only --cached 2>/dev/null; git ls-files --others --exclude-standard 2>/dev/null';
    const r = await sshExec(cmd, root, 20000);
    const seen = new Set();
    for (const line of String(r.stdout || '').split(/\r?\n/)) {
      const rel = String(line || '').trim().replace(/\\/g, '/');
      if (!rel || seen.has(rel)) continue;
      seen.add(rel);
      if (!isWatchableRelativePath(rel)) continue;
      const abs = rel.startsWith('/') ? rel : `${root}/${rel.replace(/^\.\//, '')}`;
      scheduleFileDiagnosticsRefresh(root, abs, { mode: 'ssh', sshExec });
    }
  }

  function startWorkspaceDiagnosticsWatch(workspaceRoot, opts = {}) {
    const settings = loadLspSettings(userDataPath);
    if (!settings.enabled) return { ok: false, skipped: 'disabled' };

    const root = path.resolve(String(workspaceRoot || ''));
    if (!root) return { ok: false, error: 'workspaceRoot 必填' };

    const wantSsh = opts.mode === 'ssh' && typeof opts.sshExec === 'function';
    const existing = watchState.get(workspaceStoreKey(root));
    if (existing) {
      if (wantSsh && existing.pollTimer && existing.mode === 'ssh') {
        existing.sshExec = opts.sshExec;
        return { ok: true, workspaceRoot: root, mode: 'ssh_poll', reused: true };
      }
      if (!wantSsh && existing.watcher && existing.mode === 'local') {
        return { ok: true, workspaceRoot: root, mode: 'local_watch', reused: true };
      }
    }

    stopWorkspaceDiagnosticsWatch(root);
    const bucket = getWatchBucket(root);
    bucket.mode = opts.mode === 'ssh' ? 'ssh' : 'local';
    bucket.sshExec = typeof opts.sshExec === 'function' ? opts.sshExec : null;

    if (bucket.mode === 'ssh' && bucket.sshExec) {
      const poll = () => {
        void pollSshDirtyFiles(root, bucket.sshExec).catch(() => {});
      };
      poll();
      bucket.pollTimer = setInterval(poll, SSH_DIRTY_POLL_MS);
      log(`[diagnostics] ssh dirty poll started ${root}`);
      return { ok: true, workspaceRoot: root, mode: 'ssh_poll' };
    }

    try {
      bucket.watcher = fsSync.watch(root, { recursive: true }, (eventType, filename) => {
        if (!filename) return;
        const rel = String(filename).replace(/\\/g, '/');
        if (!isWatchableRelativePath(rel)) return;
        const abs = path.resolve(root, rel);
        if (!isUnderRoot(abs, root)) return;
        if (eventType === 'rename') {
          fs.stat(abs)
            .then((st) => {
              if (st.isFile()) scheduleFileDiagnosticsRefresh(root, abs);
              else removeWorkspaceStoreFile(root, abs);
            })
            .catch(() => {
              removeWorkspaceStoreFile(root, abs);
            });
          return;
        }
        scheduleFileDiagnosticsRefresh(root, abs);
      });
      bucket.watcher.on('error', (err) => {
        log(`[diagnostics] watch error ${root}: ${err.message || err}`);
      });
      log(`[diagnostics] watch started ${root}`);
      return { ok: true, workspaceRoot: root, mode: 'local_watch' };
    } catch (err) {
      return { ok: false, error: err.message || String(err) };
    }
  }

  function getWatchStatus(workspaceRoot) {
    const wk = workspaceStoreKey(workspaceRoot);
    const bucket = watchState.get(wk);
    return {
      active: !!(bucket && (bucket.watcher || bucket.pollTimer)),
      mode: bucket ? bucket.mode : 'off',
      pending: bucket ? bucket.pending.size : 0,
      refreshing: bucket ? bucket.refreshing.size : 0
    };
  }

  function scheduleFileDiagnosticsRefresh(workspaceRoot, absPath, opts = {}) {
    const settings = loadLspSettings(userDataPath);
    if (!settings.enabled) return Promise.resolve(null);

    const root = path.resolve(String(workspaceRoot || ''));
    const abs = path.resolve(String(absPath || ''));
    if (!root || !abs || !isUnderRoot(abs, root)) return Promise.resolve(null);

    invalidateCacheForPath(abs);
    const bucket = getWatchBucket(root);
    const key = abs.toLowerCase();

    if (opts.immediate) {
      if (bucket.pending.has(key)) {
        clearTimeout(bucket.pending.get(key));
        bucket.pending.delete(key);
      }
      return refreshFileDiagnostics(root, abs, {
        mode: bucket.mode,
        sshExec: bucket.sshExec
      });
    }

    if (bucket.pending.has(key)) {
      clearTimeout(bucket.pending.get(key));
    }

    const delay = opts.debounceMs != null ? Number(opts.debounceMs) : WATCH_DEBOUNCE_MS;
    const timer = setTimeout(() => {
      bucket.pending.delete(key);
      void refreshFileDiagnostics(root, abs, {
        mode: bucket.mode,
        sshExec: bucket.sshExec
      });
    }, delay);
    bucket.pending.set(key, timer);
    return Promise.resolve({ scheduled: true, file: abs });
  }

  async function runWatchCliScansForFile(root, abs, settings) {
    const scans = [];
    const eslintRoot = findWorkspaceEslintProjectRoot(root);
    if (eslintRoot && ESLINT_FILE_RE.test(abs)) {
      scans.push(
        runEslintFileScan({
          projectRoot: eslintRoot,
          absPath: abs,
          timeoutMs: settings.timeoutMs,
          minSeverity: settings.minSeverity,
          maxPerFile: settings.maxPerFile
        }).then((diagnostics) => ({
          engine: 'eslint',
          diagnostics,
          server: 'eslint-watch'
        }))
      );
    }
    const ruffRoot = findWorkspaceRuffProjectRoot(root);
    if (ruffRoot && RUFF_FILE_RE.test(abs)) {
      scans.push(
        runRuffFileScan({
          projectRoot: ruffRoot,
          absPath: abs,
          timeoutMs: settings.timeoutMs,
          minSeverity: settings.minSeverity,
          maxPerFile: settings.maxPerFile
        }).then((diagnostics) => ({
          engine: 'ruff',
          diagnostics,
          server: 'ruff-watch'
        }))
      );
    }
    const prettierRoot = findWorkspacePrettierProjectRoot(root);
    if (prettierRoot && PRETTIER_FILE_RE.test(abs)) {
      scans.push(
        runPrettierFileScan({
          projectRoot: prettierRoot,
          absPath: abs,
          timeoutMs: settings.timeoutMs,
          minSeverity: settings.minSeverity,
          maxPerFile: settings.maxPerFile
        }).then((diagnostics) => ({
          engine: 'prettier',
          diagnostics,
          server: 'prettier-watch'
        }))
      );
    }
    const settled = await Promise.all(scans.map((p) => p.catch(() => null)));
    return settled.filter(Boolean);
  }

  async function refreshFileDiagnosticsRemote(workspaceRoot, absPath, sshExec, settings) {
    const root = String(workspaceRoot || '').replace(/\\/g, '/').replace(/\/$/, '');
    const abs = String(absPath || '').replace(/\\/g, '/');
    const ext = path.extname(abs).toLowerCase();
    const scanOpts = {
      exec: sshExec,
      projectRoot: root,
      absPaths: [abs],
      timeoutMs: settings.timeoutMs,
      minSeverity: settings.minSeverity,
      maxPerFile: settings.maxPerFile
    };

    if (['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'].includes(ext)) {
      const tscMap = await runRemoteTscBatch(scanOpts).catch(() => new Map());
      upsertWorkspaceStoreEntry(
        root,
        {
          file: abs,
          diagnostics: tscMap.get(abs) || [],
          language: 'typescript',
          server: 'tsc-cli-remote',
          source: 'watch'
        },
        'tsc'
      );
      const eslintMap = await runRemoteEslintBatch(scanOpts).catch(() => new Map());
      upsertWorkspaceStoreEntry(
        root,
        {
          file: abs,
          diagnostics: eslintMap.get(abs) || [],
          language: 'javascript',
          server: 'eslint-cli-remote',
          source: 'watch'
        },
        'eslint'
      );
      const prettierMap = await runRemotePrettierBatch(scanOpts).catch(() => new Map());
      upsertWorkspaceStoreEntry(
        root,
        {
          file: abs,
          diagnostics: prettierMap.get(abs) || [],
          language: 'javascript',
          server: 'prettier-cli-remote',
          source: 'watch'
        },
        'prettier'
      );
    } else if (ext === '.py') {
      const ruffMap = await runRemoteRuffBatch(scanOpts).catch(() => new Map());
      upsertWorkspaceStoreEntry(
        root,
        {
          file: abs,
          diagnostics: ruffMap.get(abs) || [],
          language: 'python',
          server: 'ruff-cli-remote',
          source: 'watch'
        },
        'ruff'
      );
    } else if (PRETTIER_FILE_RE.test(abs)) {
      const prettierMap = await runRemotePrettierBatch(scanOpts).catch(() => new Map());
      upsertWorkspaceStoreEntry(
        root,
        {
          file: abs,
          diagnostics: prettierMap.get(abs) || [],
          language: '',
          server: 'prettier-cli-remote',
          source: 'watch'
        },
        'prettier'
      );
    }

    notifyStoreUpdated(root, abs);
    const view = getWorkspaceStoreEntry(root, abs);
    return { ok: true, file: abs, count: view ? view.diagnostics.length : 0 };
  }

  async function refreshFileDiagnostics(workspaceRoot, absPath, opts = {}) {
    const settings = loadLspSettings(userDataPath);
    if (!settings.enabled) return null;

    if (opts.mode === 'ssh' && typeof opts.sshExec === 'function') {
      const root = String(workspaceRoot || '').replace(/\\/g, '/');
      const abs = String(absPath || '').replace(/\\/g, '/');
      const bucket = getWatchBucket(root);
      const key = abs.toLowerCase();
      if (bucket.refreshing.has(key)) return null;
      bucket.refreshing.add(key);
      try {
        return await refreshFileDiagnosticsRemote(root, abs, opts.sshExec, settings);
      } finally {
        bucket.refreshing.delete(key);
      }
    }

    const root = path.resolve(String(workspaceRoot || ''));
    const abs = path.resolve(String(absPath || ''));
    if (!root || !abs || !isUnderRoot(abs, root)) return null;

    const bucket = getWatchBucket(root);
    const key = abs.toLowerCase();
    if (bucket.refreshing.has(key)) return null;
    bucket.refreshing.add(key);

    try {
      let stat;
      try {
        stat = await fs.stat(abs);
      } catch {
        removeWorkspaceStoreFile(root, abs);
        return null;
      }
      if (!stat.isFile()) {
        removeWorkspaceStoreFile(root, abs);
        return null;
      }

      const result = await diagnoseOneLocalFile(abs, {
        workspaceRoot: root,
        settings,
        minSeverity: settings.minSeverity,
        timeoutMs: settings.timeoutMs,
        maxPerFile: settings.maxPerFile,
        assertReadable: null
      });

      if (result.item) {
        upsertWorkspaceStoreEntry(
          root,
          { ...result.item, source: 'watch' },
          'lsp'
        );
      }

      const cliScans = await runWatchCliScansForFile(root, abs, settings);
      for (const scan of cliScans) {
        upsertWorkspaceStoreEntry(
          root,
          {
            file: abs,
            diagnostics: scan.diagnostics || [],
            language: getLanguageIdForPath(abs) || '',
            server: scan.server,
            source: 'watch'
          },
          scan.engine
        );
      }

      notifyStoreUpdated(root, abs);
      const view = getWorkspaceStoreEntry(root, abs);
      return { ok: true, file: abs, count: view ? view.diagnostics.length : 0 };
    } finally {
      bucket.refreshing.delete(key);
    }
  }

  function setStoreUpdatedCallback(fn) {
    onStoreUpdated = typeof fn === 'function' ? fn : null;
  }

  async function closeLiveDocumentForPath(absPath, workspaceRoot) {
    const languageId = getLanguageIdForPath(absPath);
    if (!languageId) return;
    const serverKey = getServerKeyForLanguage(languageId);
    if (!serverKey) return;
    const projectRoot = findProjectRoot(absPath, workspaceRoot, serverKey);
    const bucket = clients.get(projectRoot);
    if (bucket && bucket.has(serverKey)) {
      await bucket.get(serverKey).closeDocument(absPath);
    }
    liveDiagnostics.delete(liveKey(absPath));
  }

  /**
   * @param {{
   *   workspaceRoot: string,
   *   filePath: string,
   *   text?: string,
   *   close?: boolean,
   *   timeoutMs?: number,
   *   minSeverity?: string,
   *   maxPerFile?: number,
   *   assertReadable?: (absPath: string) => Promise<string>
   * }} opts
   */
  async function syncLiveDocument(opts) {
    const settings = loadLspSettings(userDataPath);
    if (!settings.enabled) {
      return { ok: true, enabled: false, diagnostics: [], file: opts.filePath || '' };
    }

    const workspaceRoot = path.resolve(String(opts.workspaceRoot || ''));
    const absPath = resolveFileAbs(opts.filePath, workspaceRoot);
    if (!absPath || !isUnderRoot(absPath, workspaceRoot)) {
      return { ok: false, error: 'invalid file path', diagnostics: [], file: opts.filePath || '' };
    }

    if (opts.close) {
      await closeLiveDocumentForPath(absPath, workspaceRoot);
      return { ok: true, diagnostics: [], file: absPath, closed: true };
    }

    const languageId = getLanguageIdForPath(absPath);
    if (!languageId) {
      return { ok: true, diagnostics: [], file: absPath, skipped: 'no_lsp' };
    }
    const serverKey = getServerKeyForLanguage(languageId);
    if (!serverKey || !getServerSpec(serverKey, userDataPath, workspaceRoot)) {
      return { ok: true, diagnostics: [], file: absPath, skipped: 'no_server' };
    }

    const text = opts.text != null ? String(opts.text) : '';
    if (text.length > 512 * 1024) {
      return { ok: false, error: 'file too large for live LSP', diagnostics: [], file: absPath };
    }

    const projectRoot = findProjectRoot(absPath, workspaceRoot, serverKey);
    const timeoutMs = opts.timeoutMs != null ? Number(opts.timeoutMs) : settings.timeoutMs;
    const minSeverity = opts.minSeverity || settings.minSeverity;
    const maxPerFile = opts.maxPerFile != null ? Number(opts.maxPerFile) : settings.maxPerFile;

    let diagnostics = [];
    let serverId = getServerSpec(serverKey, userDataPath, workspaceRoot).id;
    let itemError = null;
    const skipLsp = serverKey === 'typescript' && !resolveTsServerPath(projectRoot);

    if (!skipLsp) {
      try {
        const client = await getClient(projectRoot, serverKey);
        if (client) {
          diagnostics = await client.syncDocument({
            absPath,
            languageId,
            text,
            timeoutMs,
            minSeverity,
            maxPerFile
          });
        }
      } catch (err) {
        itemError = err.message || String(err);
      }
    }

    if (!diagnostics.length) {
      const fb = await tryCliFallback(serverKey, projectRoot, absPath, {
        timeoutMs,
        minSeverity,
        maxPerFile
      });
      if (fb && fb.diagnostics.length) {
        diagnostics = fb.diagnostics;
        serverId = fb.server;
        itemError = null;
      }
    }

    const key = liveKey(absPath);
    liveDiagnostics.set(key, {
      file: absPath,
      diagnostics,
      ts: Date.now(),
      language: languageId,
      server: serverId
    });
    upsertWorkspaceStoreEntry(workspaceRoot, {
      file: absPath,
      diagnostics,
      language: languageId,
      server: serverId,
      source: 'live'
    }, 'lsp');

    return {
      ok: true,
      enabled: true,
      file: absPath,
      language: languageId,
      server: serverId,
      diagnostics,
      error: itemError,
      projectRoot
    };
  }

  function getLiveDiagnosticsSnapshot() {
    return [...liveDiagnostics.values()].map((row) => ({
      file: row.file,
      language: row.language,
      server: row.server,
      diagnostics: row.diagnostics,
      ts: row.ts
    }));
  }

  function getWorkspaceStoreSnapshot(workspaceRoot) {
    return snapshotBucket(getWorkspaceBucket(workspaceRoot)).filter((row) =>
      isPlausibleDiagnosticFilePath(row.file, workspaceRoot)
    );
  }

  function reportDiagnostics(workspaceRoot, filePath, diagnostics, meta = {}) {
    const abs = resolveFileAbs(filePath, workspaceRoot);
    if (!abs) return { ok: false, error: 'invalid path' };
    upsertWorkspaceStoreEntry(workspaceRoot, {
      file: abs,
      diagnostics: Array.isArray(diagnostics) ? diagnostics : [],
      language: meta.language || '',
      server: meta.server || 'report',
      source: meta.source || 'report'
    }, 'report');
    return { ok: true, file: abs };
  }

  /**
   * Agent 发消息前：读 Diagnostic Store，按需 refresh，支持 git 脏文件 fallback。
   */
  async function getAgentDiagnosticsContext(opts) {
    const settings = loadLspSettings(userDataPath);
    if (!settings.enabled) {
      return { ok: true, enabled: false, mode: 'store', items: [], skipped: [] };
    }

    const workspaceRoot = path.resolve(String(opts.workspaceRoot || ''));
    if (!workspaceRoot) {
      return { ok: false, error: 'workspaceRoot 必填', items: [], skipped: [] };
    }

    const maxFiles = opts.maxFiles != null ? Number(opts.maxFiles) : Math.max(settings.maxFiles, 24);
    const maxPerFile = opts.maxPerFile != null ? Number(opts.maxPerFile) : settings.maxPerFile;
    const minSeverity = opts.minSeverity || settings.minSeverity;
    const timeoutMs = opts.timeoutMs != null ? Number(opts.timeoutMs) : settings.timeoutMs;
    const storeStaleMs =
      opts.storeStaleMs != null ? Number(opts.storeStaleMs) : STORE_STALE_MS;
    const assertReadable = opts.assertReadable;

    const pathMap = new Map();
    function addPath(raw) {
      const abs = resolveFileAbs(raw, workspaceRoot);
      if (!abs || !isUnderRoot(abs, workspaceRoot)) return;
      pathMap.set(abs.toLowerCase(), abs);
    }

    for (const f of opts.files || []) addPath(f);
    for (const f of opts.gitDirtyFiles || []) addPath(f);

    for (const row of liveDiagnostics.values()) {
      if (!isUnderRoot(row.file, workspaceRoot)) continue;
      if (hasRelevantDiagnostics(row.diagnostics, minSeverity)) {
        addPath(row.file);
      }
    }

    const bucket = getWorkspaceBucket(workspaceRoot);
    if (pathMap.size === 0) {
      for (const raw of bucket.values()) {
        const entry = buildItemView(raw);
        if (hasRelevantDiagnostics(entry.diagnostics, minSeverity)) {
          addPath(entry.file);
        }
      }
    }

    const focusLower = new Set(
      (opts.files || [])
        .map((f) => {
          const abs = resolveFileAbs(f, workspaceRoot);
          return abs ? abs.toLowerCase() : '';
        })
        .filter(Boolean)
    );

    const skipped = [];
    const toRefresh = [];
    for (const abs of pathMap.values()) {
      const entry = getWorkspaceStoreEntry(workspaceRoot, abs);
      const stale = !entry || Date.now() - entry.ts > storeStaleMs;
      const focus = focusLower.has(abs.toLowerCase());
      if (stale || (focus && (!entry || Date.now() - entry.ts > 8000))) {
        toRefresh.push(abs);
      }
    }

    if (opts.triggerProjectScan !== false) {
      void scheduleWorkspaceProjectScan(workspaceRoot, {
        force: opts.forceProjectScan === true,
        sshExec: typeof opts.sshExec === 'function' ? opts.sshExec : undefined
      }).catch(() => {});
    }

    for (const abs of toRefresh.slice(0, maxFiles)) {
      if (typeof opts.sshExec === 'function') {
        await refreshFileDiagnostics(workspaceRoot, abs, {
          mode: 'ssh',
          sshExec: opts.sshExec
        });
        continue;
      }
      const result = await diagnoseOneLocalFile(abs, {
        workspaceRoot,
        settings,
        minSeverity,
        timeoutMs,
        maxPerFile,
        assertReadable
      });
      if (result.skipped) skipped.push(result.skipped);
    }

    const items = [];
    const outBucket = getWorkspaceBucket(workspaceRoot);
    for (const raw of outBucket.values()) {
      const entry = buildItemView(raw);
      if (!isUnderRoot(entry.file, workspaceRoot)) continue;
      const diagnostics = filterDiagnosticsBySeverity(entry.diagnostics, minSeverity).slice(
        0,
        maxPerFile
      );
      if (!diagnostics.length) continue;
      items.push({
        file: entry.file,
        language: entry.language,
        server: entry.server,
        diagnostics,
        cached: Date.now() - entry.ts <= storeStaleMs,
        source: entry.source,
        sources: entry.sources
      });
    }

    items.sort((a, b) => {
      const aErr = a.diagnostics.some((d) => d.severity === 'error') ? 0 : 1;
      const bErr = b.diagnostics.some((d) => d.severity === 'error') ? 0 : 1;
      if (aErr !== bErr) return aErr - bErr;
      const aProj = a.source === 'project_scan' || a.source === 'watch' ? 0 : 1;
      const bProj = b.source === 'project_scan' || b.source === 'watch' ? 0 : 1;
      if (aProj !== bProj) return aProj - bProj;
      const aFocus = focusLower.has(String(a.file || '').toLowerCase()) ? 0 : 1;
      const bFocus = focusLower.has(String(b.file || '').toLowerCase()) ? 0 : 1;
      if (aFocus !== bFocus) return aFocus - bFocus;
      return String(a.file).localeCompare(String(b.file));
    });

    return {
      ok: true,
      enabled: true,
      mode: 'diagnostic_store',
      cached: items.every((it) => it.cached),
      workspaceRoot,
      items: items.slice(0, maxFiles),
      skipped,
      storeSize: outBucket.size,
      projectScan: getProjectScanStatus(workspaceRoot)
    };
  }

  function getProjectScanStatus(workspaceRoot) {
    const wk = workspaceStoreKey(workspaceRoot);
    const st = projectScanState.get(wk);
    const watch = getWatchStatus(workspaceRoot);
    if (!st) return { running: false, lastTs: 0, watch };
    return {
      running: !!st.running,
      lastTs: st.lastTs || 0,
      lastResult: st.lastResult || null,
      watch
    };
  }

  function languageForScanEngine(engine) {
    if (engine === 'pyright' || engine === 'ruff') return 'python';
    if (engine === 'eslint' || engine === 'prettier') return 'javascript';
    return 'typescript';
  }

  async function runWorkspaceProjectScan(opts) {
    const settings = loadLspSettings(userDataPath);
    if (!settings.enabled) {
      return { ok: true, skipped: 'disabled', items: [] };
    }

    const workspaceRoot = opts.sshExec
      ? String(opts.workspaceRoot || '').replace(/\\/g, '/').replace(/\/$/, '')
      : path.resolve(String(opts.workspaceRoot || ''));
    if (!workspaceRoot) {
      return { ok: false, error: 'workspaceRoot 必填' };
    }

    const wk = workspaceStoreKey(workspaceRoot);
    const prev = projectScanState.get(wk);
    if (prev && prev.running) return prev.running;

    const minSeverity = opts.minSeverity || settings.minSeverity;
    const maxFiles = opts.maxFiles != null ? Number(opts.maxFiles) : PROJECT_SCAN_MAX_FILES;
    const maxPerFile = opts.maxPerFile != null ? Number(opts.maxPerFile) : PROJECT_SCAN_MAX_PER_FILE;
    const timeoutMs = opts.timeoutMs != null ? Number(opts.timeoutMs) : PROJECT_SCAN_TIMEOUT_MS;
    const storeBucket = getWorkspaceBucket(workspaceRoot);

    const job = (async () => {
      const scanJobs = [];
      const remote = typeof opts.sshExec === 'function';

      if (remote) {
        scanJobs.push(
          runRemoteTscProjectScan({
            exec: opts.sshExec,
            projectRoot: workspaceRoot,
            workspaceRoot,
            timeoutMs,
            minSeverity,
            maxFiles,
            maxPerFile
          })
        );
        scanJobs.push(
          runRemoteEslintProjectScan({
            exec: opts.sshExec,
            projectRoot: workspaceRoot,
            workspaceRoot,
            timeoutMs,
            minSeverity,
            maxFiles,
            maxPerFile
          })
        );
        scanJobs.push(
          runRemoteRuffProjectScan({
            exec: opts.sshExec,
            projectRoot: workspaceRoot,
            workspaceRoot,
            timeoutMs,
            minSeverity,
            maxFiles,
            maxPerFile
          })
        );
        scanJobs.push(
          runRemotePrettierProjectScan({
            exec: opts.sshExec,
            projectRoot: workspaceRoot,
            workspaceRoot,
            timeoutMs,
            minSeverity,
            maxFiles,
            maxPerFile
          })
        );
      } else {
        const tsRoot = findWorkspaceTsProjectRoot(workspaceRoot);
        if (tsRoot) {
          scanJobs.push(
            runTscProjectScan({
              projectRoot: tsRoot,
              workspaceRoot,
              timeoutMs,
              minSeverity,
              maxFiles,
              maxPerFile
            })
          );
        }
        const pyRoot = findWorkspacePyProjectRoot(workspaceRoot);
        if (pyRoot) {
          scanJobs.push(
            runPyrightProjectScan({
              projectRoot: pyRoot,
              workspaceRoot,
              timeoutMs,
              minSeverity,
              maxFiles,
              maxPerFile
            })
          );
        }
        const eslintRoot = findWorkspaceEslintProjectRoot(workspaceRoot);
        if (eslintRoot) {
          scanJobs.push(
            runEslintProjectScan({
              projectRoot: eslintRoot,
              workspaceRoot,
              timeoutMs,
              minSeverity,
              maxFiles,
              maxPerFile
            })
          );
        }
        const ruffRoot = findWorkspaceRuffProjectRoot(workspaceRoot);
        if (ruffRoot) {
          scanJobs.push(
            runRuffProjectScan({
              projectRoot: ruffRoot,
              workspaceRoot,
              timeoutMs,
              minSeverity,
              maxFiles,
              maxPerFile
            })
          );
        }
        const prettierRoot = findWorkspacePrettierProjectRoot(workspaceRoot);
        if (prettierRoot) {
          scanJobs.push(
            runPrettierProjectScan({
              projectRoot: prettierRoot,
              workspaceRoot,
              timeoutMs,
              minSeverity,
              maxFiles,
              maxPerFile
            })
          );
        }
      }

      const scans = (await Promise.all(scanJobs)).filter(Boolean);
      const successful = scans.filter((scan) => scan && scan.ok !== false && scan.engine);
      if (!successful.length) {
        const result = { ok: true, skipped: 'no_project', engines: [], fileCount: 0, errorCount: 0 };
        projectScanState.set(wk, { running: null, lastTs: Date.now(), lastResult: result });
        return result;
      }

      let errorCount = 0;
      let warningCount = 0;
      let fileCount = 0;
      const engines = [];
      const byEngine = {};

      for (const scan of successful) {
        if (scan.engine) engines.push(scan.engine);
        clearEngineLayer(storeBucket, scan.engine);
        let engErrors = 0;
        let engWarnings = 0;
        let engFiles = 0;

        for (const item of scan.items || []) {
          upsertWorkspaceStoreEntry(
            workspaceRoot,
            {
              file: item.file,
              diagnostics: item.diagnostics,
              language: languageForScanEngine(scan.engine),
              server: `${scan.engine}-project`,
              source: 'project_scan'
            },
            scan.engine
          );
          engFiles += 1;
          for (const d of item.diagnostics || []) {
            if (d.severity === 'error') {
              errorCount += 1;
              engErrors += 1;
            } else if (d.severity === 'warning') {
              warningCount += 1;
              engWarnings += 1;
            }
          }
        }

        fileCount += engFiles;
        byEngine[scan.engine] = {
          fileCount: engFiles,
          errorCount: engErrors,
          warningCount: engWarnings,
          rawCount: scan.rawCount || 0,
          projectRoot: scan.projectRoot || workspaceRoot
        };
      }

      const result = {
        ok: true,
        engines,
        engine: engines.join('+') || null,
        byEngine,
        fileCount,
        errorCount,
        warningCount,
        remote
      };
      projectScanState.set(wk, { running: null, lastTs: Date.now(), lastResult: result });
      notifyStoreUpdated(workspaceRoot);
      log(
        `[diagnostics] project scan ${workspaceRoot} ${engines.join('+')} files=${fileCount} errors=${errorCount}`
      );
      return result;
    })().catch((err) => {
      const result = { ok: false, error: err.message || String(err) };
      projectScanState.set(wk, { running: null, lastTs: Date.now(), lastResult: result });
      return result;
    });

    projectScanState.set(wk, {
      ...(prev || {}),
      running: job
    });

    return job;
  }

  function scheduleWorkspaceProjectScan(workspaceRoot, opts = {}) {
    const wk = workspaceStoreKey(workspaceRoot);
    const prev = projectScanState.get(wk) || {};
    if (prev.running) return prev.running;

    const force = opts.force === true;
    if (
      !force &&
      prev.lastTs &&
      Date.now() - prev.lastTs < (opts.cooldownMs != null ? opts.cooldownMs : PROJECT_SCAN_COOLDOWN_MS)
    ) {
      return Promise.resolve({ ok: true, cached: true, ...(prev.lastResult || {}) });
    }

    return runWorkspaceProjectScan({ workspaceRoot, ...opts });
  }

  async function tryCliFallback(serverKey, projectRoot, absPath, opts) {
    try {
      if (serverKey === 'typescript') {
        const diagnostics = await runTscFallback({
          projectRoot,
          absPath,
          timeoutMs: opts.timeoutMs,
          minSeverity: opts.minSeverity,
          maxPerFile: opts.maxPerFile
        });
        return { diagnostics, server: 'tsc-cli', error: null };
      }
      if (serverKey === 'python') {
        const diagnostics = await runPyrightFallback({
          projectRoot,
          absPath,
          timeoutMs: opts.timeoutMs,
          minSeverity: opts.minSeverity,
          maxPerFile: opts.maxPerFile
        });
        return { diagnostics, server: 'pyright-cli', error: null };
      }
      if (serverKey === 'rust') {
        const diagnostics = await runCargoCheckFallback({
          projectRoot,
          absPath,
          timeoutMs: opts.timeoutMs,
          minSeverity: opts.minSeverity,
          maxPerFile: opts.maxPerFile
        });
        return { diagnostics, server: 'cargo-cli', error: null };
      }
      if (serverKey === 'go') {
        const diagnostics = await runGoVetFallback({
          projectRoot,
          absPath,
          timeoutMs: opts.timeoutMs,
          minSeverity: opts.minSeverity,
          maxPerFile: opts.maxPerFile
        });
        return { diagnostics, server: 'go-vet-cli', error: null };
      }
    } catch (err) {
      return { diagnostics: [], server: `${serverKey}-cli`, error: err.message || String(err) };
    }
    return null;
  }

  async function diagnoseOneLocalFile(absPath, ctx) {
    const {
      workspaceRoot,
      settings,
      minSeverity,
      timeoutMs,
      maxPerFile,
      assertReadable
    } = ctx;

    const languageId = getLanguageIdForPath(absPath);
    if (!languageId) {
      return { skipped: { file: absPath, reason: 'no_lsp' } };
    }
    const serverKey = getServerKeyForLanguage(languageId);
    if (!serverKey || !getServerSpec(serverKey, userDataPath, workspaceRoot)) {
      return { skipped: { file: absPath, reason: 'no_server' } };
    }

    let stat;
    try {
      const readTarget = assertReadable ? await assertReadable(absPath) : absPath;
      stat = await fs.stat(readTarget);
    } catch (err) {
      return {
        skipped: { file: absPath, reason: err.code === 'ENOENT' ? 'not_found' : 'read_failed' }
      };
    }
    if (!stat.isFile()) {
      return { skipped: { file: absPath, reason: 'not_file' } };
    }

    const cacheKey = `${workspaceRoot}|${absPath}|${stat.mtimeMs}|${stat.size}`;
    const cached = cacheGet(cacheKey, settings.cacheTtlMs);
    if (cached) {
      const item = {
        file: absPath,
        language: languageId,
        server: getServerSpec(serverKey, userDataPath, workspaceRoot).id,
        projectRoot: findProjectRoot(absPath, workspaceRoot, serverKey),
        diagnostics: cached,
        error: null,
        cached: true
      };
      upsertWorkspaceStoreEntry(workspaceRoot, item, 'lsp');
      return { item };
    }

    let text;
    try {
      const readPath = assertReadable ? await assertReadable(absPath) : absPath;
      if (stat.size > 512 * 1024) {
        return { skipped: { file: absPath, reason: 'file_too_large' } };
      }
      text = await fs.readFile(readPath, 'utf8');
    } catch {
      return { skipped: { file: absPath, reason: 'read_failed' } };
    }

    const projectRoot = findProjectRoot(absPath, workspaceRoot, serverKey);
    let diagnostics = [];
    let serverId = getServerSpec(serverKey, userDataPath, workspaceRoot).id;
    let itemError = null;
    const skipLsp = serverKey === 'typescript' && !resolveTsServerPath(projectRoot);

    if (!skipLsp) {
      try {
        const client = await getClient(projectRoot, serverKey);
        if (!client) {
          return { skipped: { file: absPath, reason: 'no_server' } };
        }
        diagnostics = await client.getDiagnosticsForFile({
          absPath,
          languageId,
          text,
          timeoutMs,
          minSeverity,
          maxPerFile
        });
      } catch (err) {
        itemError = err.message || String(err);
      }
    }

    if (!diagnostics.length) {
      const fb = await tryCliFallback(serverKey, projectRoot, absPath, {
        timeoutMs,
        minSeverity,
        maxPerFile
      });
      if (fb) {
        if (fb.diagnostics.length) {
          diagnostics = fb.diagnostics;
          serverId = fb.server;
          itemError = null;
        } else if (fb.error && !itemError) {
          itemError = fb.error;
        }
      }
    }

    cacheSet(cacheKey, diagnostics, settings.cacheTtlMs);
    const item = {
      file: absPath,
      language: languageId,
      server: serverId,
      projectRoot,
      diagnostics,
      error: itemError,
      cached: false
    };
    upsertWorkspaceStoreEntry(workspaceRoot, item, 'lsp');
    return { item };
  }

  return {
    diagnoseFiles,
    diagnoseFilesRemote,
    syncLiveDocument,
    closeLiveDocumentForPath,
    getLiveDiagnosticsSnapshot,
    getWorkspaceStoreSnapshot,
    getAgentDiagnosticsContext,
    reportDiagnostics,
    runWorkspaceProjectScan,
    scheduleWorkspaceProjectScan,
    getProjectScanStatus,
    startWorkspaceDiagnosticsWatch,
    stopWorkspaceDiagnosticsWatch,
    scheduleFileDiagnosticsRefresh,
    getWatchStatus,
    setStoreUpdatedCallback,
    getStatus,
    shutdown,
    invalidateCache,
    invalidateCacheForPath,
    resolveSymbolCallers: (opts) =>
      resolveSymbolCallers({
        ...opts,
        getClient
      }),
    queryPosition: (opts) =>
      queryLspPosition({
        ...opts,
        getClient,
        listClients
      }),
    loadLspSettings: () => loadLspSettings(userDataPath),
    saveLspSettings: (partial) => {
      const next = saveLspSettings(userDataPath, partial || {});
      invalidateCache();
      return next;
    }
  };
}

module.exports = {
  createLspDiagnosticsService,
  loadLspSettings,
  saveLspSettings,
  lspSettingsPath,
  resolveFileAbs,
  isUnderRoot,
  DEFAULT_RESOLVE_TIMEOUT_MS
};
