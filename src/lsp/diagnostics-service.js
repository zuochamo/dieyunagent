'use strict';

const fs = require('fs/promises');
const path = require('path');
const { LspClient } = require('./lsp-client');
const { getLanguageIdForPath, getServerKeyForLanguage, getServerSpec, resolveTsServerPath, pythonStubDir } = require('./language-registry');
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
/**
 * lsp-settings 缺省值：LSP 诊断「文件数 / 单文件条数 / 超时」的唯一来源。
 * 其它模块（Gateway `lsp.settings_get` 兜底、Agent 注入路径）一律引用这里，勿再各写一份。
 */
const LSP_SETTINGS_DEFAULTS = Object.freeze({
  enabled: true,
  timeoutMs: DEFAULT_TIMEOUT_MS,
  cacheTtlMs: CACHE_TTL_MS,
  maxFiles: DEFAULT_MAX_FILES,
  maxPerFile: DEFAULT_MAX_PER_FILE,
  minSeverity: 'warning'
});
const IDLE_SHUTDOWN_MS = 5 * 60 * 1000;
const WATCH_DEBOUNCE_MS = 450;
/**
 * watch 批量诊断的三个上限。
 *
 * 批量写文件（脚本生成、大批量保存、拉分支）会让 `fs.watch(recursive)` 喷出成百上千事件。
 * 旧实现是**每个文件一个独立 450ms 定时器**：这些定时器同一刻到期，然后串行跑完
 * 读文件 → didOpen → 等诊断 → didClose 的完整往返。实测一个 1100 个 .py 的工程被批量
 * 写入后，单轮 855 个文件连续 didOpen/didClose 跑了约 90 秒（pyright 776MB），期间主线程
 * 一直排队，界面卡死。
 *
 * 现在合并成「脏集合 + 单定时器 + 分批」：
 * - `WATCH_BATCH_MAX_FILES` 单批最多处理几个文件，处理完让出事件循环；
 * - `WATCH_BATCH_GAP_MS`    批与批之间的间隔，给 UI / 其它 RPC 留出窗口；
 * - `WATCH_DIRTY_MAX_QUEUE` 队列硬上限，超出丢弃最旧的（保留最近改动的）。
 */
const WATCH_BATCH_MAX_FILES = 24;
const WATCH_BATCH_GAP_MS = 800;
const WATCH_DIRTY_MAX_QUEUE = 400;
const SSH_DIRTY_POLL_MS = 25000;

/**
 * 远程引擎负缓存的 TTL（见 `remoteEngineVerdicts`）。
 * - `structural`：命令/工具确实不存在 → 长时间不再试（每 10 分钟才探测一次，日志也才一行）；
 * - `transient` ：引擎跑起来了但报错（tsconfig 坏了之类）→ 只压 1 分钟，避免每文件刷一轮。
 */
const REMOTE_ENGINE_BLOCK_MS = Object.freeze({ structural: 10 * 60 * 1000, transient: 60 * 1000 });
/** 「工具本身不存在」的签名：包管理器/内核报的这几种，与「代码有问题」不重叠。 */
const REMOTE_ENGINE_MISSING_RE =
  /command not found|not recognized as an internal|could not determine executable|cannot find module|no such file or directory|ENOENT/i;
/** 远程项目探测：结果缓存多久（项目加/删配置文件属低频事件）。 */
const REMOTE_PROJECT_CAPS_TTL_MS = 5 * 60 * 1000;
/** 探测命令里「配置文件清单」与「package.json 依赖清单」的分隔标记。 */
const REMOTE_DEPS_MARKER = '--dieyun-deps--';

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
  const defaults = LSP_SETTINGS_DEFAULTS;
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

/**
 * 工作区根归一：**远端 POSIX 路径不能过 `path.resolve`**。
 *
 * Windows 上 `path.resolve('/home/u/proj')` → `E:\home\u\proj`，一旦进了 watch 队列：
 * ① `stopWorkspaceDiagnosticsWatch` / `getWatchStatus` 用原串算 key，两边永不相等 →
 *    stop 永远 return（SSH poll interval 泄漏）、面板 watch 状态恒 off；
 * ② `pollSshDirtyFiles` 把这个根当远程 cwd 传给 sshExec，`git diff` 在远程不存在的
 *    目录里跑，永远拉不到脏文件 → SSH 侧 watch 形同虚设。
 * 所以「以 / 开头」就是远端绝对路径的唯一判据，本地路径才 resolve。
 */
function watchRootPath(workspaceRoot) {
  const raw = String(workspaceRoot || '').trim().replace(/\\/g, '/').replace(/\/$/, '');
  if (!raw) return '';
  return raw.startsWith('/') ? raw : path.resolve(raw);
}

function workspaceStoreKey(workspaceRoot) {
  return watchRootPath(workspaceRoot).toLowerCase();
}

/** 文件绝对路径归一：远端 POSIX 路径保持原串，本地路径才 resolve（与 watchRootPath 同规）。 */
function watchAbsPath(absPath, root) {
  const raw = String(absPath || '').trim().replace(/\\/g, '/');
  if (!raw) return '';
  if (raw.startsWith('/') || String(root || '').startsWith('/')) return raw;
  return path.resolve(raw);
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
 * @param {{ userDataPath: string, log?: (msg: string) => void, logDebug?: (msg: string) => void }} opts
 */
function createLspDiagnosticsService(opts) {
  const userDataPath = opts.userDataPath;
  const log = opts.log || (() => {});
  /**
   * 低噪通道：watch 的「空批次」心跳（files=N withDiagnostics=0）走这里。
   *
   * 远端工作空间每 25s 一轮，全打 info 实测把主日志淹掉（3 天 830 条里 754 条是 0 诊断）；
   * 但这条又是「watch 跑过了却没出诊断」的唯一证据，不能直接删，所以降级到 debug。
   */
  const logDebug = typeof opts.logDebug === 'function' ? opts.logDebug : () => {};
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
  /** @type {Map<string, { watcher: import('fs').FSWatcher|null, pollTimer: NodeJS.Timeout|null, queueTimer: NodeJS.Timeout|null, draining: boolean, dirty: Map<string, { abs: string, ts: number }>, refreshing: Set<string>, retry: Map<string, number>, workspaceRoot: string, mode: string, sshExec?: Function|null }>} */
  const watchState = new Map();
  /**
   * 远程引擎「跑不起来」的负缓存（`root|engine`）。
   *
   * 事故形态（2026-10-27 实测日志）：远端没装 typescript / eslint / prettier 时，
   * watch 每来一个脏文件就重新 spawn 三条必然失败的命令（tsc→eslint→prettier，约 1.4s 一轮），
   * 且每次失败都打一行日志 —— 打开一个大工程＝几千条无效 SSH 命令 + 刷屏。
   *
   * 纪律：**只记「结构性不可用」**（命令/工具本身不存在），超时与断线不记
   * （把一次网络抖动记成「引擎不可用」会让诊断永久失灵）。TTL 到期放行一次探测，
   * 用户在远端装好依赖 / 修好 tsconfig 后能自愈，无需重启应用。
   * @type {Map<string, { at: number, ttlMs: number, kind: string, reason: string, skipped: number }>}
   */
  const remoteEngineVerdicts = new Map();
  /**
   * 远程项目「该跑哪些引擎」的探测缓存（`root`），TTL 见 `REMOTE_PROJECT_CAPS_TTL_MS`。
   * @type {Map<string, { at: number, ok: boolean, engines?: { ts: boolean, eslint: boolean, ruff: boolean, prettier: boolean }, error?: string }>}
   */
  const remoteProjectCaps = new Map();

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
      userDataPath,
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
  /**
   * 远程引擎「没跑起来」的唯一日志出口。
   *
   * 批量路径的上层以前一律 `.catch(() => new Map())`，失败被吞成「0 条诊断」⇒ 面板显示
   * 「没有问题」。现在失败只做两件事：落一行可检索的日志 + 由调用方**跳过写空诊断**，
   * 保留上一次可信结果（引擎残废时最危险的不是报错，是假装干净）。
   *
   * 只能由 `runRemoteEngine` 调用：那里已把「同一个引擎连续失败」压成 TTL 内只记一次，
   * 否则每个脏文件都会重打一行（线上实测 1.4s 一条）。
   */
  function logRemoteEngineUnavailable(workspaceRoot, r, opts = {}) {
    if (!r || r.ok !== false) return;
    const pause = opts.latchedMs ? `（本轮起暂停该引擎 ${Math.round(opts.latchedMs / 60000)} 分钟后再探测）` : '';
    log(
      `[diagnostics] 远程引擎未运行 engine=${r.engine || '?'} exitCode=${r.exitCode == null ? '-' : r.exitCode} ` +
        `root=${workspaceRoot} error=${r.error || '未知错误'}${r.detail ? ` detail=${r.detail}` : ''}${pause}`
    );
  }

  /** 批量引擎调用：抛错也归一成 `ok:false`，与 cli-fallback 的失败形状一致。 */
  function settleRemoteBatch(promise) {
    return promise.catch((err) => ({
      ok: false,
      engine: '?',
      byFile: new Map(),
      error: String((err && err.message) || err),
      exitCode: null
    }));
  }

  function remoteEngineVerdictKey(root, engine) {
    return `${String(root || '').replace(/\/$/, '').toLowerCase()}|${String(engine || '?')}`;
  }

  /**
   * 失败分类（唯一来源）：只有「命令/工具本身不存在」才算结构性不可用。
   * `exitCode == null` = exec 抛错（超时 / 断线 / 权限），属瞬时问题，**绝不**记成引擎缺失。
   * @returns {{ kind: 'structural'|'transient', ttlMs: number } | null}
   */
  function classifyRemoteEngineFailure(r) {
    if (!r || r.ok !== false) return null;
    const exit = r.exitCode == null ? null : Number(r.exitCode);
    const hay = `${r.error || ''} ${r.detail || ''}`;
    if (exit === 126 || exit === 127 || REMOTE_ENGINE_MISSING_RE.test(hay)) {
      return { kind: 'structural', ttlMs: REMOTE_ENGINE_BLOCK_MS.structural };
    }
    if (exit == null) return null;
    return { kind: 'transient', ttlMs: REMOTE_ENGINE_BLOCK_MS.transient };
  }

  /** TTL 内已知不可用 → 返回负缓存条目（调用方据此跳过 spawn，且不再打日志）。 */
  function takeBlockedRemoteEngine(root, engine) {
    const key = remoteEngineVerdictKey(root, engine);
    const hit = remoteEngineVerdicts.get(key);
    if (!hit) return null;
    if (Date.now() - hit.at >= hit.ttlMs) {
      // TTL 到期：删缓存、放行一次探测（远端装好依赖 / 修好 tsconfig 后自愈，不必重启）
      remoteEngineVerdicts.delete(key);
      return null;
    }
    hit.skipped += 1;
    return hit;
  }

  /** 工作区重建（stop / 本地↔SSH 切换）时清掉该根的负缓存与探测缓存，下次从头探测。 */
  function clearRemoteEngineVerdicts(workspaceRoot) {
    const prefix = `${String(workspaceRoot || '').replace(/\/$/, '').toLowerCase()}`;
    for (const key of [...remoteEngineVerdicts.keys()]) {
      if (key.startsWith(`${prefix}|`)) remoteEngineVerdicts.delete(key);
    }
    remoteProjectCaps.delete(prefix);
  }

  /**
   * 远程引擎调用的**唯一出口**：负缓存判定 → 执行 → 失败分类 → 日志限流。
   *
   * 返回形状与 cli-fallback 的 `remoteEngineFailure` 一致：`ok:false` 时上层不写 store
   * （保留上一次可信结果），`blocked:true` 表示这次连命令都没发（TTL 内已知不可用）。
   */
  async function runRemoteEngine(root, engine, runFn) {
    const blocked = takeBlockedRemoteEngine(root, engine);
    if (blocked) {
      return {
        ok: false,
        engine,
        blocked: true,
        byFile: new Map(),
        error: `引擎近期不可用，本轮跳过（${blocked.reason}）`,
        exitCode: null,
        skipped: blocked.skipped
      };
    }
    // async IIFE：`runFn` 同步抛错也要归一成 ok:false，不能穿透到 watch 队列里
    const settled = await settleRemoteBatch((async () => runFn())());
    const named = settled && settled.engine && settled.engine !== '?' ? settled : { ...settled, engine };
    const verdict = classifyRemoteEngineFailure(named);
    if (verdict) {
      remoteEngineVerdicts.set(remoteEngineVerdictKey(root, engine), {
        at: Date.now(),
        ttlMs: verdict.ttlMs,
        kind: verdict.kind,
        reason: String(named.error || '引擎未运行'),
        skipped: 0
      });
      logRemoteEngineUnavailable(root, named, { latchedMs: verdict.ttlMs });
    }
    return named;
  }

  /**
   * 单文件远程 CLI 诊断的统一落库出口：**只写 ok 的引擎**。
   * 失败时不 upsert（保留上一次可信结果）；日志与负缓存在 `runRemoteEngine` 里（唯一出口）。
   */
  function upsertRemoteCliEntry(root, abs, scan, meta) {
    if (!scan || !scan.ok) return false;
    upsertWorkspaceStoreEntry(
      root,
      {
        file: abs,
        diagnostics: scan.byFile.get(abs) || [],
        language: meta.language || '',
        server: meta.server,
        source: 'watch'
      },
      meta.engine
    );
    return true;
  }

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

    // 先探测项目自带哪些工具，再决定跑谁：项目没配 eslint/prettier 就**不跑**
    // （`npx -y eslint` 会去拉一个用户没装的 eslint 来指责他的代码风格，那是替用户决定装什么）。
    const caps = await getRemoteProjectEngines(workspaceRoot, sshExec, timeoutMs);
    if (!caps.ok) {
      return {
        ok: false,
        error: `远程项目探测失败：${caps.error}`,
        items: [],
        skipped,
        failures: [{ engine: 'probe', error: caps.error || '探测失败', detail: caps.detail || '', exitCode: caps.exitCode == null ? null : caps.exitCode }]
      };
    }
    const want = caps.engines;
    // 只报「本批文件本来该跑、但项目没配」的引擎：没有 .py 文件时提 ruff 是噪音。
    const unusedEngines = [
      tsTargets.length && !want.ts ? 'tsc' : null,
      eslintTargets.length && !want.eslint ? 'eslint' : null,
      pyTargets.length && !want.ruff ? 'ruff' : null,
      prettierTargets.length && !want.prettier ? 'prettier' : null
    ].filter(Boolean);

    const scanOpts = {
      exec: sshExec,
      projectRoot: workspaceRoot,
      timeoutMs,
      minSeverity,
      maxPerFile
    };

    const [tscScan, eslintScan, ruffScan, prettierScan] = await Promise.all([
      want.ts && tsTargets.length
        ? runRemoteEngine(workspaceRoot, 'tsc', () => runRemoteTscBatch({ ...scanOpts, absPaths: tsTargets }))
        : null,
      want.eslint && eslintTargets.length
        ? runRemoteEngine(workspaceRoot, 'eslint', () =>
            runRemoteEslintBatch({ ...scanOpts, absPaths: eslintTargets })
          )
        : null,
      want.ruff && pyTargets.length
        ? runRemoteEngine(workspaceRoot, 'ruff', () => runRemoteRuffBatch({ ...scanOpts, absPaths: pyTargets }))
        : null,
      want.prettier && prettierTargets.length
        ? runRemoteEngine(workspaceRoot, 'prettier', () =>
            runRemotePrettierBatch({ ...scanOpts, absPaths: prettierTargets })
          )
        : null
    ]);
    // 失败引擎的日志与负缓存都在 runRemoteEngine 里（唯一出口），这里不再重复记。
    const engineFailures = [tscScan, eslintScan, ruffScan, prettierScan].filter((r) => r && r.ok === false);
    // 只有 ok 的引擎才写 store：失败引擎不写空数组，避免把上次的问题「洗白」。
    const tscDiags = tscScan && tscScan.ok ? tscScan.byFile : new Map();
    const eslintDiags = eslintScan && eslintScan.ok ? eslintScan.byFile : new Map();
    const ruffDiags = ruffScan && ruffScan.ok ? ruffScan.byFile : new Map();
    const prettierDiags = prettierScan && prettierScan.ok ? prettierScan.byFile : new Map();

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
      skipped,
      // 有引擎没跑起来时诊断是不完整的：只回 items=[] 会让调用方以为「全都干净」。
      ...(engineFailures.length
        ? {
            failures: engineFailures.map((r) => ({
              engine: r.engine || '?',
              error: r.error || '引擎未运行',
              detail: r.detail || '',
              exitCode: r.exitCode == null ? null : r.exitCode,
              // true = 这次连命令都没发（TTL 内已知不可用，见 remoteEngineVerdicts）
              ...(r.blocked ? { blocked: true } : {})
            }))
          }
        : null),
      // 项目里没有对应工具 ⇒ 这些引擎**故意没跑**（不是失败，也不是「0 个问题」）
      ...(unusedEngines.length ? { skippedEngines: unusedEngines } : null)
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
    return {
      settings,
      active,
      cacheSize: cache.size,
      storeWorkspaces: workspaceStores.size,
      // 远程引擎负缓存快照：面板/排查用（引擎不可用时，TTL 内不会再发远程命令）
      remoteEngines: [...remoteEngineVerdicts.entries()].map(([key, v]) => ({
        key,
        kind: v.kind,
        reason: v.reason,
        skipped: v.skipped,
        retryInMs: Math.max(0, v.ttlMs - (Date.now() - v.at))
      })),
      // 远程项目探测快照：哪些引擎是「项目里没有，所以没跑」
      remoteProjects: [...remoteProjectCaps.entries()].map(([root, v]) => ({
        root,
        ok: v.ok !== false,
        engines: v.ok ? v.engines : null,
        ...(v.ok ? {} : { error: v.error || '' })
      }))
    };
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

  function getWatchBucket(workspaceRoot) {
    const wk = workspaceStoreKey(workspaceRoot);
    if (!watchState.has(wk)) {
      watchState.set(wk, {
        watcher: null,
        pollTimer: null,
        /**
         * 待诊断文件：key = absPath.toLowerCase()，value = { abs, ts }。
         * 用 Map 而不是 per-file 定时器：同一文件的多次事件只保留最新一次，
         * 批量写入时不会攒出成百上千个独立 timer。ts 用于超限时保留最近改动。
         */
        dirty: new Map(),
        /** 合并后的单一定时器（到点触发 drainWatchQueue） */
        queueTimer: null,
        /** 正在排空队列：期间新事件只入队，不再起第二个 drain */
        draining: false,
        refreshing: new Set(),
        /** key → 已失败次数：单文件异常最多回队重试一次，避免坏文件把队列拖成死循环 */
        retry: new Map(),
        workspaceRoot: watchRootPath(workspaceRoot),
        mode: 'local',
        sshExec: null
      });
    }
    return watchState.get(wk);
  }

  function stopWorkspaceDiagnosticsWatch(workspaceRoot) {
    // 停止/重建 watch 时清掉该根的远程引擎负缓存：重连、切工作区后应当重新探测一次。
    clearRemoteEngineVerdicts(workspaceRoot);
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
    if (bucket.queueTimer) {
      clearTimeout(bucket.queueTimer);
    }
    bucket.dirty.clear();
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

    // 远端根必须保持 POSIX 原串：resolve 成 E:\home\... 会让 sshExec 的 cwd 失效，
    // 且与 stop/getWatchStatus 的 key 对不上（见 watchRootPath 注释）。
    const root = watchRootPath(workspaceRoot);
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
      pending: bucket ? bucket.dirty.size : 0,
      refreshing: bucket ? bucket.refreshing.size : 0
    };
  }

  /**
   * 入队一个「需要重新诊断」的文件。
   *
   * 与旧实现的区别只有两点：① 不再为每个文件建定时器，全部事件合并到一个 450ms 单定时器；
   * ② 到点后走 `drainWatchQueue` 分批处理，而不是一次性把整批串行排完。
   */
  function scheduleFileDiagnosticsRefresh(workspaceRoot, absPath, opts = {}) {
    const settings = loadLspSettings(userDataPath);
    if (!settings.enabled) return Promise.resolve(null);

    const root = watchRootPath(workspaceRoot);
    const abs = watchAbsPath(absPath, root);
    if (!root || !abs || !isUnderRoot(abs, root)) return Promise.resolve(null);

    invalidateCacheForPath(abs);
    const bucket = getWatchBucket(root);
    const key = abs.toLowerCase();

    if (opts.immediate) {
      // 立即刷新＝调用方明确要等结果（保存后马上要看诊断），跳过排队。
      // mode/sshExec 用调用方显式给的优先：SSH 写文件时 watch 可能还没建立
      // （bucket 默认 local/null），只信 bucket 会把远端路径当本地路径诊断，静默失败。
      bucket.dirty.delete(key);
      return refreshFileDiagnostics(root, abs, {
        mode: opts.mode || bucket.mode,
        sshExec: typeof opts.sshExec === 'function' ? opts.sshExec : bucket.sshExec
      });
    }

    bucket.dirty.set(key, { abs, ts: Date.now() });
    if (bucket.dirty.size > WATCH_DIRTY_MAX_QUEUE) {
      // 硬上限：丢掉最旧的那批（它们多半已被后续写入覆盖，再诊断也是旧内容）
      const oldest = [...bucket.dirty.entries()]
        .sort((a, b) => a[1].ts - b[1].ts)
        .slice(0, bucket.dirty.size - WATCH_DIRTY_MAX_QUEUE);
      for (const [oldKey] of oldest) bucket.dirty.delete(oldKey);
    }

    if (!bucket.queueTimer && !bucket.draining) {
      const delay = opts.debounceMs != null ? Number(opts.debounceMs) : WATCH_DEBOUNCE_MS;
      bucket.queueTimer = setTimeout(() => {
        bucket.queueTimer = null;
        void drainWatchQueue(root);
      }, delay);
    }
    return Promise.resolve({ scheduled: true, file: abs, queued: bucket.dirty.size });
  }

  /**
   * 分批排空脏队列：每批最多 `WATCH_BATCH_MAX_FILES` 个，批间 sleep 让出事件循环。
   *
   * 单文件之间仍然是串行（`refreshFileDiagnostics` 内部只处理一个文件），这是刻意的：
   * LSP 客户端本身是单连接 + 单 program，堆并发只会让 pyright 同时开更多文档，
   * 反而更容易把内存推高。真正要掐掉的是「一口气把整批排完」。
   */
  async function drainWatchQueue(workspaceRoot) {
    const root = watchRootPath(workspaceRoot);
    if (!root) return;
    const wk = workspaceStoreKey(root);
    const bucket = watchState.get(wk);
    if (!bucket || bucket.draining) return;
    bucket.draining = true;
    let total = 0;
    let batches = 0;
    let withDiagnostics = 0;
    let failed = 0;
    try {
      while (bucket.dirty.size) {
        // stop（含 local↔ssh 切换）/ 重建后旧 bucket 已废弃：立刻收手，
        // 否则会继续用旧的 mode/sshExec 把整批跑完，结果写进新模式下的 store。
        if (watchState.get(wk) !== bucket) return;
        const batch = [...bucket.dirty.entries()]
          .sort((a, b) => b[1].ts - a[1].ts)
          .slice(0, WATCH_BATCH_MAX_FILES);
        for (const [key] of batch) bucket.dirty.delete(key);
        batches += 1;
        for (const [key, row] of batch) {
          if (watchState.get(wk) !== bucket) return;
          try {
            const result = await refreshFileDiagnostics(root, row.abs, {
              mode: bucket.mode,
              sshExec: bucket.sshExec
            });
            total += 1;
            bucket.retry.delete(key);
            if (result && result.count > 0) withDiagnostics += 1;
          } catch (err) {
            // 单文件失败不能吃掉整批：其它文件照常诊断，这一条最多回队重试一次
            // （无限重试会把「一个坏文件」变成 800ms 一轮的死循环）。
            failed += 1;
            const tries = (bucket.retry.get(key) || 0) + 1;
            if (tries < 2) {
              bucket.retry.set(key, tries);
              if (!bucket.dirty.has(key)) bucket.dirty.set(key, { ...row, ts: Date.now() });
            } else {
              bucket.retry.delete(key);
              log(
                `[diagnostics] watch 放弃 ${row.abs}（连续失败 ${tries} 次）: ${err && err.message ? err.message : err}`
              );
            }
          }
        }
        if (bucket.dirty.size) {
          await new Promise((resolve) => setTimeout(resolve, WATCH_BATCH_GAP_MS));
        }
      }
    } catch (err) {
      log(`[diagnostics] watch drain error ${root}: ${err.message || err}`);
    } finally {
      const live = watchState.get(wk);
      // 只清自己那个 bucket 的标志：stop 后重建的新 bucket 可能已有别的 drain 在跑，
      // 误清会让 schedule 再起一个 drain，两个 drain 同时对同一连接分批 didOpen。
      if (live && live === bucket) live.draining = false;
      if (total > 0 || failed) {
        const line =
          `[diagnostics] watch batch ${root} files=${total} batches=${batches} withDiagnostics=${withDiagnostics}` +
          (failed ? ` failed=${failed}` : '');
        // 有产出或失败 = 主日志（排查入口）；纯心跳降级到 debug，别把 25s 一轮的轮询写满 main.log
        if (withDiagnostics > 0 || failed) log(line);
        else logDebug(line);
      }
      // 排空过程中又来了新事件（dirty 又有货）→ 补一次，避免丢事件
      if (live && live === bucket && live.dirty.size && !live.queueTimer) {
        live.queueTimer = setTimeout(() => {
          live.queueTimer = null;
          void drainWatchQueue(root);
        }, WATCH_BATCH_GAP_MS);
      }
    }
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
    // 探测闸门与 `diagnoseFilesRemote` / 项目扫描**同一来源**：项目没配的工具不跑。
    // 没有这道闸，watch 会对着「项目里根本没有 eslint」的文件反复 `npx -y eslint`，
    // 把「用户没装也没用」变成一串引擎失败刷屏。
    const caps = await getRemoteProjectEngines(root, sshExec, settings.timeoutMs);
    if (!caps.ok) {
      return { ok: false, file: abs, skipped: 'probe_failed', error: caps.error || '远程项目探测失败' };
    }
    const want = caps.engines;
    const scanOpts = {
      exec: sshExec,
      projectRoot: root,
      absPaths: [abs],
      timeoutMs: settings.timeoutMs,
      minSeverity: settings.minSeverity,
      maxPerFile: settings.maxPerFile
    };

    const unconfigured = [];
    if (['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'].includes(ext)) {
      if (want.ts) {
        upsertRemoteCliEntry(root, abs, await runRemoteEngine(root, 'tsc', () => runRemoteTscBatch(scanOpts)), {
          language: 'typescript',
          server: 'tsc-cli-remote',
          engine: 'tsc'
        });
      } else {
        unconfigured.push('tsc');
      }
      if (want.eslint) {
        upsertRemoteCliEntry(
          root,
          abs,
          await runRemoteEngine(root, 'eslint', () => runRemoteEslintBatch(scanOpts)),
          {
            language: 'javascript',
            server: 'eslint-cli-remote',
            engine: 'eslint'
          }
        );
      } else {
        unconfigured.push('eslint');
      }
      if (want.prettier) {
        upsertRemoteCliEntry(
          root,
          abs,
          await runRemoteEngine(root, 'prettier', () => runRemotePrettierBatch(scanOpts)),
          {
            language: 'javascript',
            server: 'prettier-cli-remote',
            engine: 'prettier'
          }
        );
      } else {
        unconfigured.push('prettier');
      }
    } else if (ext === '.py') {
      if (want.ruff) {
        upsertRemoteCliEntry(root, abs, await runRemoteEngine(root, 'ruff', () => runRemoteRuffBatch(scanOpts)), {
          language: 'python',
          server: 'ruff-cli-remote',
          engine: 'ruff'
        });
      } else {
        unconfigured.push('ruff');
      }
    } else if (PRETTIER_FILE_RE.test(abs) && want.prettier) {
      upsertRemoteCliEntry(
        root,
        abs,
        await runRemoteEngine(root, 'prettier', () => runRemotePrettierBatch(scanOpts)),
        {
          language: '',
          server: 'prettier-cli-remote',
          engine: 'prettier'
        }
      );
    }

    notifyStoreUpdated(root, abs);
    const view = getWorkspaceStoreEntry(root, abs);
    return {
      ok: true,
      file: abs,
      count: view ? view.diagnostics.length : 0,
      ...(unconfigured.length ? { skippedEngines: unconfigured } : {})
    };
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

    const workspaceRoot = watchRootPath(opts.workspaceRoot);
    if (!workspaceRoot) {
      return { ok: false, error: 'workspaceRoot 必填', items: [], skipped: [] };
    }

    const maxFiles = opts.maxFiles != null ? Number(opts.maxFiles) : settings.maxFiles;
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
        // 这里只要问「有没有达阈值的诊断」：合并视图（union + 去重 + 排序）是纯浪费 ——
        // 合并不新增也不过滤任何一条，逐层判与合并后判等价。
        const layers = Object.values(raw.byEngine || {});
        const relevant = layers.some(
          (layer) =>
            Array.isArray(layer && layer.diagnostics) &&
            hasRelevantDiagnostics(layer.diagnostics, minSeverity)
        );
        if (relevant) addPath(raw.file);
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
    const skippedEngines = new Set();
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
        const refreshed = await refreshFileDiagnostics(workspaceRoot, abs, {
          mode: 'ssh',
          sshExec: opts.sshExec
        });
        // 项目没配的引擎要如实带出去：否则模型/面板只能看到「没有诊断」，分不清「干净」与「没扫」
        if (refreshed && Array.isArray(refreshed.skippedEngines)) {
          for (const engine of refreshed.skippedEngines) skippedEngines.add(engine);
        }
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
      ...(skippedEngines.size ? { skippedEngines: [...skippedEngines] } : null),
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

  /**
   * 远程项目类型探测（一次 ls 判定该跑哪些引擎），对齐本地 `findWorkspaceXProjectRoot` 的语义。
   *
   * 为什么要有：远程分支以前无条件跑 tsc+eslint+ruff+prettier。非 JS/Python 的仓库
   * 会白付四次 `npx -y` 冷启动（慢且耗网络），并把「这个项目没有 eslint 配置」
   * 汇报成「扫描完成，0 个问题」——用户与模型都无法区分「干净」与「没扫」。
   *
   * 判据也包含 `package.json` 里**声明了**哪些工具：只有 package.json 而没有 eslint 依赖/配置
   * 的项目不该跑 lint —— `npx -y eslint` 会去拉一个用户没装的 eslint 来指责他的代码风格，
   * 那是「我们替他决定装什么」，不是他项目的一部分（本地路径同样只跑项目自带的工具）。
   *
   * @returns {Promise<{ ok: boolean, engines?: {ts:boolean,eslint:boolean,ruff:boolean,prettier:boolean}, error?: string, detail?: string, exitCode?: number|null }>}
   */
  async function probeRemoteProjectEngines(sshExec, workspaceRoot, timeoutMs) {
    const files =
      'tsconfig.json jsconfig.json package.json eslint.config.js eslint.config.mjs ' +
      'eslint.config.cjs eslint.config.ts .eslintrc .eslintrc.js .eslintrc.cjs .eslintrc.json ' +
      'pyproject.toml ruff.toml .ruff.toml setup.cfg .prettierrc .prettierrc.json .prettierrc.js ' +
      '.prettierrc.yml .prettierrc.yaml prettier.config.js prettier.config.mjs';
    // 一条命令同时拿「有哪些配置文件」与「package.json 声明了哪些工具」：分成两条会让
    // watch 路径的固定成本翻倍，而这里只需要一个布尔矩阵。
    const cmd =
      `ls -1d ${files} 2>/dev/null; ` +
      `echo '${REMOTE_DEPS_MARKER}'; ` +
      `grep -oE '"(eslint|prettier|typescript|@typescript-eslint/[a-z-]+|@vue/eslint-config-[a-z-]+)":' package.json 2>/dev/null | head -40`;
    let r;
    try {
      r = await sshExec(cmd, workspaceRoot, Math.min(15000, timeoutMs || 15000));
    } catch (err) {
      return { ok: false, error: err && err.message ? String(err.message) : String(err) };
    }
    const stdout = String((r && r.stdout) || '');
    const markerAt = stdout.indexOf(REMOTE_DEPS_MARKER);
    const listPart = markerAt >= 0 ? stdout.slice(0, markerAt) : stdout;
    const depsPart = markerAt >= 0 ? stdout.slice(markerAt + REMOTE_DEPS_MARKER.length) : '';
    const names = listPart
      .split('\n')
      .map((s) => s.trim().replace(/^\.\//, ''))
      .filter(Boolean);
    const deps = depsPart
      .split('\n')
      .map((s) => (s.match(/"([^"]+)"/) || [])[1] || '')
      .filter(Boolean);
    // 一条都没列出来未必是「探测失败」：空目录 / 没有上述配置文件都正常。
    // 但 stderr 非空且 exit != 0 时（cd 不进去、目录不存在）必须报错而不是当成空项目。
    const stderr = String((r && r.stderr) || '').trim();
    const code = r && r.code != null ? Number(r.code) : null;
    if (!names.length && stderr && code !== 0) {
      return { ok: false, error: `探测命令失败（退出码 ${code}）`, detail: stderr.slice(-400), exitCode: code };
    }
    const has = (re) => names.some((n) => re.test(n));
    const dep = (name) => deps.includes(name);
    return {
      ok: true,
      engines: {
        ts: has(/^(tsconfig|jsconfig)\.json$/),
        eslint:
          has(/^(eslint\.config\.|\.eslintrc)/) ||
          dep('eslint') ||
          deps.some((d) => d.startsWith('@typescript-eslint/') || d.startsWith('@vue/eslint-config-')),
        ruff: has(/^(pyproject\.toml|ruff\.toml|\.ruff\.toml|setup\.cfg)$/),
        prettier: has(/^(\.prettierrc|prettier\.config\.)/) || dep('prettier')
      }
    };
  }

  /**
   * 探测结果的缓存（`root` 一档，TTL 5 分钟）。
   *
   * watch 每来一个脏文件都会问「这个项目该跑哪些引擎」；缓存后固定成本从「每文件一次 ls」
   * 降到「每 5 分钟一次」。失败也缓存：目录不可读时不该每个文件都去撞一次 SSH。
   */
  async function getRemoteProjectEngines(root, sshExec, timeoutMs, opts = {}) {
    const key = String(root || '').replace(/\/$/, '').toLowerCase();
    const hit = remoteProjectCaps.get(key);
    if (!opts.fresh && hit && Date.now() - hit.at < REMOTE_PROJECT_CAPS_TTL_MS) return hit;
    const fresh = await probeRemoteProjectEngines(sshExec, root, timeoutMs);
    const entry = { at: Date.now(), ...fresh };
    remoteProjectCaps.set(key, entry);
    if (!fresh.ok) {
      log(`[diagnostics] 远程项目探测失败 root=${root} error=${fresh.error || '未知'}${fresh.detail ? ` detail=${fresh.detail}` : ''}`);
    }
    return entry;
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
        // 远程必须**先探测项目类型**再决定跑哪些引擎：此前无条件跑 tsc+eslint+ruff+prettier，
        // 对 Go / PHP / 纯文档仓库等于白付四次 npx 冷启动，而且「工具没装/没配置」
        // 和「扫完没问题」被压成同一种结果。一次 ls 的成本远低于四次 npx。
        // 用**同一份**探测（含 watch 路径共用的缓存）；显式扫描要求最新的项目现状。
        const probe = await getRemoteProjectEngines(workspaceRoot, opts.sshExec, timeoutMs, { fresh: true });
        if (!probe.ok) {
          const result = {
            ok: false,
            error: `远程项目探测失败：${probe.error}`,
            engines: [],
            failures: [{ engine: 'probe', error: probe.error, detail: probe.detail || '', exitCode: probe.exitCode }],
            fileCount: 0,
            errorCount: 0,
            remote
          };
          projectScanState.set(wk, { running: null, lastTs: Date.now(), lastResult: result });
          log(`[diagnostics] project scan FAILED ${workspaceRoot} probe ${probe.error}`);
          return result;
        }
        if (probe.engines.ts) {
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
        }
        if (probe.engines.eslint) {
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
        }
        if (probe.engines.ruff) {
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
        }
        if (probe.engines.prettier) {
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
        }
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
              maxPerFile,
              stubDir: pythonStubDir(userDataPath)
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
      // 失败的扫描必须显式带到结果里：以前只有「成功」才进 successful，
      // 失败项被静默丢弃，最终表现为「扫描完成 0 个问题」。
      const failures = scans
        .filter((scan) => scan && scan.ok === false)
        .map((scan) => ({
          engine: scan.engine,
          error: scan.error || '未知原因',
          detail: scan.detail || '',
          exitCode: scan.exitCode != null ? scan.exitCode : null
        }));
      if (!successful.length) {
        const result = failures.length
          ? {
              ok: false,
              error: `诊断未跑起来（${failures.map((f) => f.engine).join('+') || 'unknown'}）：${failures[0].error}`,
              engines: [],
              failures,
              fileCount: 0,
              errorCount: 0,
              remote
            }
          : { ok: true, skipped: 'no_project', engines: [], fileCount: 0, errorCount: 0, remote };
        projectScanState.set(wk, { running: null, lastTs: Date.now(), lastResult: result });
        if (failures.length) {
          log(
            `[diagnostics] project scan FAILED ${workspaceRoot} ${failures.map((f) => f.engine).join('+')} ${failures[0].error}`
          );
        }
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
          // 真正被引擎检查过的文件数（eslint/ruff 由 JSON 条目数得到；其它引擎不提供则为 0）
          scannedFiles: scan.scannedFiles || 0,
          projectRoot: scan.projectRoot || workspaceRoot
        };
      }

      const result = {
        ok: true,
        engines,
        engine: engines.join('+') || null,
        byEngine,
        // 口径：fileCount = **有诊断**的文件数（items 只含有问题的文件），
        // 不是「扫描过的文件数」。旧日志把它写成 `files=` 被读成「一个文件都没扫到」，
        // 直接导致「远程索引不可用」的误判，所以这里连字段名一起说清楚。
        fileCount,
        errorCount,
        warningCount,
        ...(failures.length ? { failures } : null),
        remote
      };
      projectScanState.set(wk, { running: null, lastTs: Date.now(), lastResult: result });
      notifyStoreUpdated(workspaceRoot);
      log(
        `[diagnostics] project scan ${workspaceRoot} ${engines.join('+')} ` +
          `filesWithDiagnostics=${fileCount} errors=${errorCount} warnings=${warningCount}` +
          (failures.length ? ` failed=${failures.map((f) => f.engine).join('+')}` : '')
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
          maxPerFile: opts.maxPerFile,
          stubDir: pythonStubDir(userDataPath)
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
  LSP_SETTINGS_DEFAULTS,
  loadLspSettings,
  saveLspSettings,
  DEFAULT_RESOLVE_TIMEOUT_MS
};
