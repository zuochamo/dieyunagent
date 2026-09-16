'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { createCoreBridge } = require('../core-bridge');
const { workspaceDieyunDir, workspaceIndexDbPath } = require('./workspace-index-path');
const {
  maxGlibcInFile,
  hostGlibcVersion,
  glibcMismatchHint,
  sanitizeCoreErrorText
} = require('./linux-elf-compat');

const INDEX_RPC_METHODS = new Set([
  'codebase.status',
  'codebase.index',
  'codebase.index.start',
  'codebase.search',
  'graph.status',
  'graph.index',
  'graph.index.start',
  'graph.embed_symbols',
  'graph.symbol_semantic_search',
  'graph.module_deps',
  'graph.repo_map',
  'graph.symbol_search',
  'graph.callers',
  'graph.callees',
  'graph.impact',
  'graph.ingest_lsp_callers'
]);

const INDEX_TIMEOUT_MS = 600000;
const STATUS_FAST_METHODS = new Set([
  'codebase.status',
  'graph.status',
  'index.ping',
  'codebase.index.start',
  'graph.index.start'
]);

/**
 * 远程工作区项目内 dieyun-core（索引库：<workspace>/.dieyun/index.sqlite）
 */
class RemoteIndexCoreHost {
  /**
   * @param {{ workspaceRoot: string, packRoot: string, log?: (msg: string) => void }} opts
   */
  constructor(opts) {
    this.workspaceRoot = path.resolve(String(opts.workspaceRoot || '/'));
    this.packRoot = path.resolve(String(opts.packRoot || '.'));
    this.log = typeof opts.log === 'function' ? opts.log : () => {};
    this.dieyunDir = workspaceDieyunDir(this.workspaceRoot);
    this.indexDbPath = workspaceIndexDbPath(this.workspaceRoot);
    this.binaryPath = path.join(this.packRoot, 'bin', 'dieyun-core');
    // 进程 data-dir 用 HOME，避免把记忆库和项目 index.sqlite 混在一起；
    // 也不把 --workspace 传给 CLI：旧 Linux 二进制没有该参数时 clap 会立刻退出。
    const runtimeDataDir = path.join(os.homedir() || '/tmp', '.dieyunagent');
    this.bridge = createCoreBridge({
      binaryPath: this.binaryPath,
      args: ['serve-stdio'],
      env: { DIEYUN_DATA_DIR: runtimeDataDir },
      pingTimeoutMs: 30000,
      log: (m) => this.log(m)
    });
    /** @type {object | null} */
    this.configureOpts = null;
    this.started = false;
    /** @type {Promise<void> | null} */
    this.starting = null;
    /** @type {string} */
    this.lastStartError = '';
    /** @type {string|undefined} */
    this._cachedMaxGlibc = undefined;
    /** @type {string|undefined} */
    this._cachedHostGlibc = undefined;
    /** @type {Promise<unknown>} */
    this._opQueue = Promise.resolve();
  }

  hasBinary() {
    try {
      const st = fs.statSync(this.binaryPath);
      return st.isFile() && st.size > 500 * 1024;
    } catch {
      return false;
    }
  }

  _ensureExecutable() {
    try {
      fs.chmodSync(this.binaryPath, 0o755);
    } catch {
      // ignore
    }
  }

  _maxGlibcNeeded() {
    if (this._cachedMaxGlibc === undefined) {
      this._cachedMaxGlibc = this.hasBinary() ? maxGlibcInFile(this.binaryPath) : '';
    }
    return this._cachedMaxGlibc || '';
  }

  _hostGlibc() {
    if (this._cachedHostGlibc === undefined) {
      this._cachedHostGlibc = hostGlibcVersion();
    }
    return this._cachedHostGlibc || '';
  }

  _glibcMismatchHint() {
    return glibcMismatchHint(this._maxGlibcNeeded(), this._hostGlibc());
  }

  _diagnoseBinary() {
    const hints = [];
    const mismatch = this._glibcMismatchHint();
    if (mismatch) hints.push(mismatch);
    try {
      const fd = fs.openSync(this.binaryPath, 'r');
      const buf = Buffer.alloc(4);
      fs.readSync(fd, buf, 0, 4, 0);
      fs.closeSync(fd);
      const elf = buf[0] === 0x7f && buf[1] === 0x45 && buf[2] === 0x4c && buf[3] === 0x46;
      if (!elf) {
        hints.push('bin/dieyun-core 不是 Linux ELF。请在本机运行 npm run pack:dieyun-core:linux 后重新连接 SSH');
      }
    } catch (err) {
      hints.push(`无法读取 ${this.binaryPath}: ${err && err.message ? err.message : err}`);
    }
    try {
      const { spawnSync } = require('child_process');
      const r = spawnSync('ldd', [this.binaryPath], { encoding: 'utf8', timeout: 4000 });
      const out = `${r.stdout || ''}${r.stderr || ''}`.trim();
      if (out && /not found|No such file/i.test(out)) {
        hints.push(`动态库缺失:\n${out.slice(0, 800)}`);
      }
    } catch {
      // ldd 可选
    }
    return hints;
  }

  isReady() {
    return this.started && this.bridge.isReady();
  }

  /**
   * 清掉仍占用本工作区 index.sqlite 的孤儿 dieyun-core（PPID=1 等），
   * 避免 busy 锁导致 codebase.status 一直超时。
   */
  _killStaleIndexHolders() {
    const dbPath = this.indexDbPath;
    if (!dbPath) return;
    let pidText = '';
    try {
      pidText = execFileSync('fuser', [dbPath], {
        encoding: 'utf8',
        timeout: 4000,
        stdio: ['ignore', 'pipe', 'pipe']
      });
    } catch (err) {
      if (err && err.code === 'ENOENT') return;
      pidText = `${err && err.stdout ? err.stdout : ''}${err && err.stderr ? err.stderr : ''}`;
    }
    const pids = String(pidText).match(/\d+/g) || [];
    if (!pids.length) return;
    const self = process.pid;
    const killed = [];
    for (const raw of pids) {
      const pid = Number(raw);
      if (!pid || pid === self) continue;
      try {
        process.kill(pid, 'SIGTERM');
        killed.push(pid);
      } catch {
        // ignore ESRCH
      }
    }
    if (killed.length) {
      this.log(`remote index: 已清理占用库的旧进程 pid=${killed.join(',')}`);
    }
  }

  _runExclusive(fn) {
    const next = this._opQueue.then(() => fn());
    this._opQueue = next.catch(() => {});
    return next;
  }

  async _configureBridge(opts = {}) {
    const embedding = opts.embedding || { disabled: true };
    return this.bridge.configure({
      data_dir: this.dieyunDir,
      index_db_path: this.indexDbPath,
      workspace_roots: [this.workspaceRoot],
      models_dirs: Array.isArray(opts.modelsDirs) ? opts.modelsDirs : [],
      embedding: {
        disabled: !!embedding.disabled,
        builtin: !!embedding.builtin,
        baseUrl: embedding.baseUrl || '',
        apiKey: embedding.apiKey || '',
        model: embedding.model || '',
        dimensions: Number(embedding.dimensions) || 1024
      }
    });
  }

  async _ensureStarted() {
    if (this.isReady()) return;
    if (this.starting) {
      await this.starting;
      return;
    }
    if (!this.hasBinary()) {
      const e = new Error('远程 dieyun-core 二进制缺失');
      e.code = 'REMOTE_INDEX_CORE_MISSING';
      this.lastStartError = e.message;
      throw e;
    }
    const mismatch = this._glibcMismatchHint();
    if (mismatch) {
      this.lastStartError = mismatch;
      const e = new Error(mismatch);
      e.code = 'REMOTE_INDEX_CORE_INCOMPATIBLE';
      throw e;
    }
    this.starting = (async () => {
      await fsp.mkdir(this.dieyunDir, { recursive: true });
      try {
        this._killStaleIndexHolders();
        this._ensureExecutable();
        await this.bridge.start();
        this.started = true;
        this.lastStartError = '';
        await this._configureBridge(this.configureOpts || {});
        this.log(`remote index: 已启动 index=${this.indexDbPath}`);
      } catch (err) {
        this.started = false;
        try {
          await this.bridge.stop();
        } catch {
          // ignore
        }
        const msg = sanitizeCoreErrorText(err && err.message ? err.message : String(err));
        const hints = this._diagnoseBinary();
        const detail = sanitizeCoreErrorText(hints.length ? `${hints.join('\n')}\n${msg}` : msg);
        this.lastStartError = detail;
        this.log(`remote index start failed: ${detail}`);
        const e = new Error(detail);
        e.code = err && err.code ? err.code : 'REMOTE_INDEX_START_FAILED';
        throw e;
      }
    })();
    try {
      await this.starting;
    } finally {
      this.starting = null;
    }
  }

  async start() {
    return this._runExclusive(async () => {
      if (!this.hasBinary()) {
        this.log('remote index: dieyun-core 二进制缺失，跳过项目内索引');
        return { ok: false, hasCore: false, reason: 'binary_missing' };
      }
      await this._ensureStarted();
      return { ok: true, hasCore: true, indexDbPath: this.indexDbPath };
    });
  }

  async stop() {
    return this._runExclusive(async () => {
      this.started = false;
      await this.bridge.stop();
    });
  }

  /**
   * @param {{ embedding?: object, modelsDirs?: string[] }} opts
   */
  async applyConfigure(opts = {}) {
    return this._runExclusive(async () => {
      this.configureOpts = opts;
      if (!this.hasBinary()) {
        return { ok: false, reason: 'binary_missing' };
      }
      await this._ensureStarted();
      return this._configureBridge(opts);
    });
  }

  async ping() {
    if (this.starting) {
      try {
        await this.starting;
      } catch {
        // lastStartError already set
      }
    }
    const mismatch = this._glibcMismatchHint();
    if (mismatch && !this.isReady() && !this.lastStartError) {
      this.lastStartError = mismatch;
    }
    return {
      ok: true,
      hasCore: this.isReady(),
      hasBinary: this.hasBinary(),
      incompatible: !!mismatch && !this.isReady(),
      lastError: this.lastStartError || mismatch || undefined,
      indexDbPath: this.indexDbPath,
      workspaceRoot: this.workspaceRoot
    };
  }

  /**
   * @param {string} method
   * @param {object} params
   */
  async invoke(method, params = {}) {
    if (!INDEX_RPC_METHODS.has(method)) {
      const e = new Error(`远程索引不支持: ${method}`);
      e.code = 'REMOTE_INDEX_UNSUPPORTED';
      throw e;
    }
    const run = async () => {
      await this._ensureStarted();
      const workspaceRoot = params.workspaceRoot
        ? path.resolve(String(params.workspaceRoot))
        : this.workspaceRoot;
      const payload = { ...params, workspaceRoot };
      const timeout =
        method === 'codebase.index' || method === 'graph.index' || method === 'graph.embed_symbols'
          ? INDEX_TIMEOUT_MS
          : method === 'codebase.index.start' || method === 'graph.index.start'
            ? 60000
            : method === 'codebase.status' || method === 'graph.status'
              ? 45000
              : undefined;
      try {
        return await this.bridge.invoke(method, payload, timeout);
      } catch (err) {
        const msg = err && err.message ? String(err.message) : String(err);
        // 进程真挂了：再拉起。仅「超时」绝不要 SIGTERM——会杀掉正在 embedding/建库的任务
        if (/已停止|已退出|not running|未启动/i.test(msg)) {
          this.log(`remote index: ${method} 检测到 core 已死，重启后重试`);
          this.started = false;
          try {
            await this.bridge.stop();
          } catch {
            // ignore
          }
          await this._ensureStarted();
          return this.bridge.invoke(method, payload, timeout);
        }
        if (
          STATUS_FAST_METHODS.has(method) &&
          method !== 'index.ping' &&
          /超时|timeout/i.test(msg)
        ) {
          this.log(`remote index: ${method} 超时，不杀进程，再试一次`);
          return this.bridge.invoke(method, payload, timeout);
        }
        throw err;
      }
    };
    // status / index.start 与长索引并行
    if (STATUS_FAST_METHODS.has(method)) {
      return run();
    }
    return this._runExclusive(run);
  }
}

function createRemoteIndexCoreHandlers(coreHost) {
  const handlers = {
    'index.ping': async () => coreHost.ping(),
    'index.configure': async (params) => coreHost.applyConfigure(params || {})
  };
  for (const method of INDEX_RPC_METHODS) {
    handlers[method] = async (params) => coreHost.invoke(method, params || {});
  }
  return handlers;
}

module.exports = {
  RemoteIndexCoreHost,
  createRemoteIndexCoreHandlers,
  INDEX_RPC_METHODS
};
