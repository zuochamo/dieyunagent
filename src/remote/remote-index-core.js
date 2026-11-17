'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { createCoreBridge } = require('../core-bridge');
const { resolveCoreRpcTimeoutMs } = require('../core-rpc-timeouts');
const { workspaceDieyunDir, workspaceIndexDbPath } = require('./workspace-index-path');
const { resolveIndexRoot, normalizeIndexRoot } = require('./index-root');

const INDEX_RPC_METHODS = new Set([
  'codebase.status',
  'codebase.index',
  'codebase.index.start',
  'codebase.search',
  'graph.status',
  'graph.index',
  'graph.index.start',
  'graph.module_deps',
  'graph.repo_map',
  'graph.symbol_search',
  'graph.callers',
  'graph.callees',
  'graph.impact',
  'graph.ingest_lsp_callers'
]);

/**
 * status 类超时 / core 已死的重试次数上限：含首次共 STATUS_RETRY_MAX + 1 次。
 * 超时值本身由 core-rpc-timeouts.js 单一来源决定（status 15s）。
 * 上限取 1 而不是随手一个数：网关侧 status RPC 预算是 45s，15s×2 + 0.3s ≈ 30s 严格
 * 小于它，这样上层拿到的是本层带日志的真实错误，而不是它自己的 RPC_TIMEOUT。
 */
const STATUS_RETRY_MAX = 1;
const STATUS_RETRY_BACKOFF_MS = 300;
const STATUS_FAST_METHODS = new Set([
  'codebase.status',
  'graph.status',
  'index.ping',
  'codebase.index.start',
  'graph.index.start'
]);

/**
 * 谁能被当作「孤儿 core」清理掉。
 *
 * `fuser <index.sqlite>` 只回答「谁持有这个文件」：sqlite3、备份脚本、**另一个 App 实例
 * 正在用的 core** 都算。按 PID 盲杀就是互杀 —— 两个会话共享同一工作区时会互相把对方
 * 的 core 杀成重启风暴（原事故的加速器）。
 *
 * 判据只留一条真正能证明「没人管它」的证据：**父进程是 init（ppid<=1）**。
 * 有活着的父进程 = 有人监督 = 不是我们的孤儿，不碰。
 *
 * @param {{ pids: number[], selfPid?: number, probe: (pid: number) => ({ cmdline?: string, ppid?: number } | null) }} input
 * @returns {{ kill: number[], skip: Array<{ pid: number, reason: string }> }}
 */
function selectStaleCoreHolders({ pids, selfPid, probe }) {
  const kill = [];
  const skip = [];
  const seen = new Set();
  for (const raw of Array.isArray(pids) ? pids : []) {
    const pid = Number(raw);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    if (seen.has(pid)) continue;
    seen.add(pid);
    if (selfPid && pid === selfPid) {
      skip.push({ pid, reason: 'self' });
      continue;
    }
    let info = null;
    try {
      info = probe(pid);
    } catch {
      info = null;
    }
    if (!info) {
      skip.push({ pid, reason: 'unknown_pid' });
      continue;
    }
    const cmdline = String(info.cmdline || '');
    if (!/dieyun-core/.test(cmdline)) {
      skip.push({ pid, reason: 'not_dieyun_core' });
      continue;
    }
    const ppid = Number(info.ppid);
    if (!Number.isFinite(ppid) || ppid > 1) {
      skip.push({ pid, reason: 'supervised' });
      continue;
    }
    kill.push(pid);
  }
  return { kill, skip };
}

/** 读 /proc/<pid> 的 cmdline 与 ppid；读不到返回 null（非 Linux / 已退出 / 无权限） */
function readProcInfo(pid) {
  try {
    const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ').trim();
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    // stat 格式：pid (comm) state ppid ...；comm 里可能有空格和括号，取最后一个 ')' 之后切
    const tail = stat.slice(stat.lastIndexOf(')') + 1).trim();
    const fields = tail.split(/\s+/);
    const ppid = Number(fields[1]);
    return { cmdline, ppid };
  } catch {
    return null;
  }
}

/** fuser 输出里的 PID（异步，别在启动路径上阻塞事件循环 4 秒） */
function listFileHolders(dbPath) {
  return new Promise((resolve) => {
    execFile('fuser', [dbPath], { timeout: 4000 }, (err, stdout, stderr) => {
      if (err && err.code === 'ENOENT') {
        resolve([]);
        return;
      }
      const text = `${stdout || ''}${stderr || ''}`;
      resolve(String(text).match(/\d+/g) || []);
    });
  });
}

/**
 * 远程 core 的 configure 载荷（纯函数，便于验证「记忆库不落在工作区」）。
 * @param {{ workspaceRoot: string, runtimeDataDir: string, indexDbPath: string, opts?: object }} p
 */
function buildCoreConfigurePayload({ workspaceRoot, runtimeDataDir, indexDbPath, opts = {} }) {
  const embedding = (opts && opts.embedding) || { disabled: true };
  // 原样透传（唯一装配点是 src/agent/embedding-config.js）：这里只做「字段存在性」归一，
  // 不再逐字段重拼——逐字段重拼正是本地 provider 字段会被无声丢掉的原因。
  const embeddingPayload = {
    disabled: !!embedding.disabled,
    provider: String(embedding.provider || ''),
    baseUrl: embedding.baseUrl || '',
    apiKey: embedding.apiKey || '',
    model: embedding.model || '',
    dimensions: Number(embedding.dimensions) || 1024,
    headers: embedding.headers && typeof embedding.headers === 'object' ? embedding.headers : {},
    authMode: String(embedding.authMode || '').trim()
  };
  if (embedding.localModelDir) embeddingPayload.localModelDir = String(embedding.localModelDir);
  if (embedding.localRuntimeLib) {
    embeddingPayload.localRuntimeLib = String(embedding.localRuntimeLib);
  }
  return {
    // data_dir 只放记忆/账本库，必须与 spawn 时的 DIEYUN_DATA_DIR 一致（$HOME 下）。
    // 早前这里写的是 <workspace>/.dieyun，等于把记忆库塞回用户项目里，
    // 还会和项目 index.sqlite 抢同一目录 —— 项目目录只留索引（index_db_path）。
    data_dir: runtimeDataDir,
    index_db_path: indexDbPath,
    workspace_roots: [workspaceRoot],
    embedding: embeddingPayload
  };
}

/**
 * 远程工作区项目内 dieyun-core（索引库：<workspace>/.dieyun/index.sqlite）
 */
class RemoteIndexCoreHost {
  /**
   * @param {{ workspaceRoot: string, packRoot: string, log?: (msg: string) => void }} opts
   */
  constructor(opts) {
    this.workspaceRoot = path.resolve(String(opts.workspaceRoot || '/'));
    // 比对用的身份（POSIX 归一）与文件系统路径分开：`path.resolve` 是平台相关的
    // （Windows 上把 `/srv/app` 变成 `E:\srv\app`），而请求里的根永远是 daemon 坐标。
    // 用「原始声明串」算身份，两边才可比；Linux daemon 上两者本来就相同。
    this.indexRoot = normalizeIndexRoot(String(opts.workspaceRoot || '/')) || this.workspaceRoot;
    this.packRoot = path.resolve(String(opts.packRoot || '.'));
    this.log = typeof opts.log === 'function' ? opts.log : () => {};
    this.dieyunDir = workspaceDieyunDir(this.workspaceRoot);
    this.indexDbPath = workspaceIndexDbPath(this.workspaceRoot);
    this.binaryPath = path.join(this.packRoot, 'bin', 'dieyun-core');
    // 进程 data-dir 用 HOME，避免把记忆库和项目 index.sqlite 混在一起；
    // 也不把 --workspace 传给 CLI：旧 Linux 二进制没有该参数时 clap 会立刻退出。
    this.runtimeDataDir = path.join(os.homedir() || '/tmp', '.dieyunagent');
    this.bridge = createCoreBridge({
      binaryPath: this.binaryPath,
      args: ['serve-stdio'],
      env: { DIEYUN_DATA_DIR: this.runtimeDataDir },
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

  /**
   * 启动失败时的取证信息。
   *
   * 这里**不再**判断「宿主 glibc 够不够」：那是产物侧的性质，已经在打包时用
   * `assertCoreGlibcTarget()` 卡死在 GLIBC ≤ 2.17 上了（scripts/pack-dieyun-core-linux-lib.cjs）。
   * 运行时再猜一遍宿主版本只会把「产物不对」误诊成「你的机器太老」。
   * 留下的是「二进制在不在 / 是不是 ELF / 动态库缺不缺」——这些只有现场才能知道。
   */
  _diagnoseBinary() {
    const hints = [];
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
   * 清掉仍占用本工作区 index.sqlite 的**孤儿** dieyun-core（父进程已是 init），
   * 避免 busy 锁导致 codebase.status 一直超时。
   * 有监督者的 core 不碰：那是别的实例正在用的进程，杀了就是互杀。
   */
  async _killStaleIndexHolders() {
    const dbPath = this.indexDbPath;
    if (!dbPath) return;
    const pids = await listFileHolders(dbPath);
    if (!pids.length) return;
    const { kill, skip } = selectStaleCoreHolders({
      pids,
      selfPid: process.pid,
      probe: readProcInfo
    });
    const killed = [];
    for (const pid of kill) {
      try {
        process.kill(pid, 'SIGTERM');
        killed.push(pid);
      } catch {
        // ignore ESRCH
      }
    }
    if (killed.length) {
      this.log(`remote index: 已清理占库孤儿 core pid=${killed.join(',')}`);
    }
    if (skip.length) {
      this.log(
        `remote index: 占库进程未清理 ${skip.map((s) => `${s.pid}(${s.reason})`).join(',')}`
      );
    }
  }

  _runExclusive(fn) {
    const next = this._opQueue.then(() => fn());
    this._opQueue = next.catch(() => {});
    return next;
  }

  async _configureBridge(opts = {}) {
    return this.bridge.configure(
      buildCoreConfigurePayload({
        workspaceRoot: this.workspaceRoot,
        runtimeDataDir: this.runtimeDataDir,
        indexDbPath: this.indexDbPath,
        opts
      })
    );
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
    this.starting = (async () => {
      await fsp.mkdir(this.dieyunDir, { recursive: true });
      try {
        await this._killStaleIndexHolders();
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
        const msg = String(err && err.message ? err.message : String(err)).replace(/`/g, "'");
        const hints = this._diagnoseBinary();
        const detail = (hints.length ? `${hints.join('\n')}\n${msg}` : msg).replace(/`/g, "'");
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
   * @param {{ embedding?: object }} opts
   */
  async applyConfigure(opts = {}) {
    return this._runExclusive(async () => {
      // 载荷里**没带** embedding 时保留上一次的：`_ensureStarted` 用的是
      // `this.configureOpts || {}`，一旦被空值覆盖，core 会以「没有 embedding 模型」的状态
      // 起来 —— 建向量永远停在 embedding 阶段（真机现场：换模型后 core 重启，
      // 状态 `embeddingModel=null`、`vectorCount=0`、DB 不再增长）。
      // 显式带 `disabled: true` 仍然照办：那是「关掉语义」的意图，不是缺省。
      const incoming = opts && typeof opts === 'object' ? opts : {};
      const merged = { ...(this.configureOpts || {}), ...incoming };
      const hasIncomingEmbedding = !!(incoming.embedding && typeof incoming.embedding === 'object');
      if (!hasIncomingEmbedding && this.configureOpts && this.configureOpts.embedding) {
        merged.embedding = this.configureOpts.embedding;
      }
      this.configureOpts = merged;
      if (!this.hasBinary()) {
        return { ok: false, reason: 'binary_missing' };
      }
      await this._ensureStarted();
      return this._configureBridge(merged);
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
    return {
      ok: true,
      hasCore: this.isReady(),
      hasBinary: this.hasBinary(),
      lastError: this.lastStartError || undefined,
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
    /** @param {number} [attempt] 已失败次数；超过 STATUS_RETRY_MAX 一律 throw */
    const run = async (attempt = 0) => {
      // 本进程只服务一个根（`index_db_path` 在 configure 时已钉死在这个根下）。
      // 请求带来的根必须与它一致：旧实现照抄 `params.workspaceRoot` 传给 core，
      // 于是用「A 的库」建/查「B 的哈希」，两边看起来都成功，症状却是永远「未建立」。
      // 比对放在起进程之前：根不对是调用方的错，不必先花几十秒拉一个用不上的 core。
      const workspaceRoot = resolveIndexRoot({
        explicitRoot: params.workspaceRoot,
        scopeRoot: this.indexRoot,
        label: String(method),
        scopeLabel: '本进程负责的工作区根'
      }).root;
      await this._ensureStarted();
      const payload = { ...params, workspaceRoot };
      // 超时映射不再在本文件维护第二份：与本地 core-bridge 共用 core-rpc-timeouts.js。
      const timeout = resolveCoreRpcTimeoutMs(method);
      try {
        return await this.bridge.invoke(method, payload, timeout);
      } catch (err) {
        const msg = err && err.message ? String(err.message) : String(err);
        const retriesLeft = attempt < STATUS_RETRY_MAX;
        // 进程真挂了：再拉起。仅「超时」绝不要 SIGTERM——会杀掉正在 embedding/建库的任务
        if (/已停止|已退出|not running|未启动/i.test(msg)) {
          if (!retriesLeft) throw err;
          this.log(
            `remote index: ${method} 检测到 core 已死，重启后重试（第 ${attempt + 1}/${STATUS_RETRY_MAX} 次）`
          );
          this.started = false;
          try {
            await this.bridge.stop();
          } catch {
            // ignore
          }
          return run(attempt + 1);
        }
        // index.ping 不走 invoke（走 handlers / host.ping()），所以这里无需排除它
        if (STATUS_FAST_METHODS.has(method) && /超时|timeout/i.test(msg)) {
          // 重试必须回到 run()：只有 run() 会重新 _ensureStarted 并复用启动态。
          // 直接 bridge.invoke 会绕过这两步，让「超时重试」和「重启后重试」语义分叉。
          if (!retriesLeft) {
            this.log(`remote index: ${method} 连续失败 ${attempt + 1} 次，放弃重试并上报`);
            throw err;
          }
          this.log(`remote index: ${method} 超时，第 ${attempt + 1}/${STATUS_RETRY_MAX} 次重试`);
          await new Promise((r) => setTimeout(r, STATUS_RETRY_BACKOFF_MS * (attempt + 1)));
          return run(attempt + 1);
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
  buildCoreConfigurePayload,
  INDEX_RPC_METHODS,
  selectStaleCoreHolders
};
