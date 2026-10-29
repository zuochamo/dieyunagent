'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const http = require('http');
const net = require('net');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { WebSocketServer } = require('ws');
const { assertAllowedPath, remoteAllowedRoots } = require('../gateway/path-policy');
const { runShell, normalizeFilePathInput } = require('../gateway/host-control');
const { normalizeReadParams } = require('../gateway/fs-read-limits');
const { runEditFile } = require('../gateway/fs-edit-file');
const { grepWorkspace, globWorkspace } = require('../gateway/rg-search');
const { RemoteIndexCoreHost, createRemoteIndexCoreHandlers } = require('./remote-index-core');
const { queryLspPosition } = require('../lsp/navigate-service');
const { LspClient } = require('../lsp/lsp-client');
const { getServerSpec } = require('../lsp/language-registry');
const { computeLineDiffStats } = require('../gateway/line-diff-stats');
const { scanRecentArtifactFiles, createLocalScanIo } = require('../gateway/artifact-scan');
const { isGraphSourcePath } = require('../index/source-files');

/** 已有 daemon 在跑时的退出码：调用方据此判断「复用现成的」，不是失败 */
const AGENT_ALREADY_RUNNING_EXIT = 42;

function summarizeLineDiff(beforeText, afterText) {
  return computeLineDiffStats(beforeText, afterText);
}

function createRemoteGatewayHandlers(workspaceRoot, opts = {}) {
  const root = path.resolve(String(workspaceRoot || '/'));
  /**
   * 可用根与桌面端**同一份规则**（`gateway/path-policy.remoteAllowedRoots`）：
   * 工作空间根 + 远端 HOME + /tmp。
   *
   * 不只是放宽体验：桌面端把截图 / 临时产物落到 `<HOME>/.dieyun/workspace` 是常态，
   * 这里若只认工作空间单根，同一批写操作就会「经 RPC 被拒、经 SFTP 成功」——
   * 两种传输对同一件事给出不同答案，比两边都拒绝更难查。
   */
  const roots = remoteAllowedRoots(root, os.homedir());
  const writable = roots;
  const defaultCwd = root;
  const log = typeof opts.log === 'function' ? opts.log : () => {};
  const packRoot = opts.packRoot ? path.resolve(String(opts.packRoot)) : path.resolve(__dirname, '..');

  /** @type {import('./remote-index-core').RemoteIndexCoreHost | null} */
  let indexCore = null;
  let graphIncTimer = null;
  let codebaseIncTimer = null;

  /**
   * 远程 LSP client 池（serverKey -> LspClient）。
   * LSP server 由远程环境提供：rust-analyzer / gopls 走 PATH，
   * ts/py 走远程工作区自己的 node_modules；都没装时 spawn 失败，
   * 上层返回 LSP_UNAVAILABLE，不影响其它能力。
   */
  const lspClients = new Map();
  const lspUserData = path.join(packRoot, '.lsp');

  async function lspGetClient(workspaceRoot, serverKey) {
    const spec = getServerSpec(serverKey, lspUserData, workspaceRoot);
    if (!spec) return null;
    const existing = lspClients.get(serverKey);
    if (existing && !existing.closed) return existing;
    try {
      await fsp.mkdir(lspUserData, { recursive: true });
    } catch {
      /* 目录已存在或不可写都不影响启动 */
    }
    const client = new LspClient({ spec, workspaceRoot, serverKey, log });
    lspClients.set(serverKey, client);
    return client;
  }

  function lspListClients() {
    return [...lspClients.entries()].map(([serverKey, client]) => ({
      serverKey,
      initialized: !!client.initialized
    }));
  }

  function shouldSkipIncrementalPath(filePath) {
    const rel = path.relative(root, filePath).replace(/\\/g, '/');
    if (!rel || rel.startsWith('..')) return true;
    if (rel === '.dieyun' || rel.startsWith('.dieyun/')) return true;
    return false;
  }

  function scheduleRemoteGraphIncremental(reason) {
    if (!indexCore || !indexCore.isReady()) return;
    if (graphIncTimer) clearTimeout(graphIncTimer);
    graphIncTimer = setTimeout(() => {
      graphIncTimer = null;
      indexCore
        .invoke('graph.status', { workspaceRoot: root })
        .then((st) => {
          if (!st || !st.indexed) return null;
          if (st.indexing) return null;
          return indexCore.invoke('graph.index.start', {
            workspaceRoot: root,
            force: false,
            skipIfReady: false
          });
        })
        .then((r) => {
          if (r) log(`remote graph incremental started (${reason || 'save'})`);
        })
        .catch((err) =>
          log(`remote graph incremental skipped: ${err && err.message ? err.message : err}`)
        );
    }, 800);
  }

  function scheduleRemoteCodebaseIncremental(reason, busyAttempt) {
    if (!indexCore || !indexCore.isReady()) return;
    if (codebaseIncTimer) clearTimeout(codebaseIncTimer);
    const attempt = Number(busyAttempt) || 0;
    codebaseIncTimer = setTimeout(() => {
      codebaseIncTimer = null;
      indexCore
        .invoke('codebase.status', { workspaceRoot: root })
        .then((st) => {
          if (!st || !st.indexed) return null;
          if (st.indexing) {
            if (attempt >= 60) {
              log('remote codebase incremental skipped: still busy after retries');
              return null;
            }
            scheduleRemoteCodebaseIncremental(reason || 'busy', attempt + 1);
            return null;
          }
          // force:false + skipIfReady:false → 后台 mtime 增量，不堵 stdio
          return indexCore.invoke('codebase.index.start', {
            workspaceRoot: root,
            force: false,
            skipIfReady: false
          });
        })
        .then((r) => {
          if (r) log(`remote codebase incremental started (${reason || 'save'})`);
        })
        .catch((err) =>
          log(`remote codebase incremental skipped: ${err && err.message ? err.message : err}`)
        );
    }, attempt > 0 ? 5000 : 800);
  }

  function resolvePath(input) {
    const resolved = normalizeFilePathInput(input, defaultCwd);
    return assertAllowedPath(resolved, roots);
  }

  /**
   * 「这个文件变了」→ 调度增量索引。判定规则只有这一份：`fs.write_file`（远端自己写）
   * 与 `index.notify_change`（桌面端走 SFTP 写/删）都从这里走。
   *
   * 桌面端的写不经过本进程，若不通知，远端索引会一直停留在旧内容上 —— grep / 图谱
   * 全部基于旧索引，Agent 会照着旧代码改。
   */
  function scheduleIndexForChange({ filePath, encoding, op } = {}) {
    const kind = String(op || 'write');
    if (kind === 'write' && encoding && encoding !== 'utf8') {
      return { scheduled: false, reason: 'non_utf8' };
    }
    let safe = '';
    if (filePath) {
      try {
        safe = resolvePath(filePath);
      } catch {
        return { scheduled: false, reason: 'out_of_root' };
      }
      if (shouldSkipIncrementalPath(safe)) return { scheduled: false, reason: 'ignored_path' };
    }
    // core 没就绪时调度器本来就是空转（scheduleRemote* 自己会 return），
    // 这里显式说出来，免得调用方以为「通知成功了，索引应该新了」
    if (!indexCore || !indexCore.isReady()) return { scheduled: false, reason: 'core_not_ready' };
    scheduleRemoteCodebaseIncremental(kind === 'write' ? 'save' : `external_${kind}`);
    // 删掉的文件本身已经不是源码了（后缀还在），仍然按源码路径处理：删除同样改变图谱
    if (!safe || isGraphSourcePath(safe)) scheduleRemoteGraphIncremental('save');
    return { scheduled: true };
  }

  async function readFile(filePath, encoding, readOpts = {}) {
    const safe = resolvePath(filePath);
    const st = await fsp.stat(safe);
    const { offset, maxBytes } = normalizeReadParams(readOpts);
    const enc = encoding === 'base64' ? 'base64' : encoding || 'utf8';
    const readLen = Math.min(maxBytes, Math.max(0, st.size - offset));
    if (readLen <= 0) {
      return {
        data: '',
        encoding: enc,
        path: safe,
        size: st.size,
        offset,
        truncated: offset < st.size,
        remote: true
      };
    }
    const fh = await fsp.open(safe, 'r');
    try {
      const buf = Buffer.alloc(readLen);
      const { bytesRead } = await fh.read(buf, 0, readLen, offset);
      const slice = buf.subarray(0, bytesRead);
      return {
        data: enc === 'base64' ? slice.toString('base64') : slice.toString(enc === 'utf8' ? 'utf8' : enc),
        encoding: enc,
        path: safe,
        size: st.size,
        offset,
        truncated: offset + bytesRead < st.size,
        remote: true
      };
    } finally {
      await fh.close();
    }
  }

  const handlers = {
    'workspace.get': async () => ({
      kind: 'local',
      workspacePath: root,
      displayPath: root,
      sshConnected: false,
      remoteGateway: true
    }),

    'fs.read_file': async ({ filePath, encoding, offset, maxBytes }) =>
      readFile(filePath, encoding, { offset, maxBytes }),

    'fs.write_file': async ({ filePath, data, encoding }) => {
      const safe = resolvePath(filePath);
      const enc = encoding === 'base64' ? 'base64' : 'utf8';
      const buf = enc === 'base64' ? Buffer.from(String(data), 'base64') : Buffer.from(String(data), 'utf8');
      let beforeText = null;
      try {
        if (enc === 'utf8' && fs.existsSync(safe)) beforeText = await fsp.readFile(safe, 'utf8');
      } catch {
        beforeText = null;
      }
      await fsp.mkdir(path.dirname(safe), { recursive: true });
      await fsp.writeFile(safe, buf);
      scheduleIndexForChange({ filePath: safe, encoding: enc, op: 'write' });
      return {
        ok: true,
        path: safe,
        diff: enc === 'utf8' ? summarizeLineDiff(beforeText, data) : null,
        remote: true
      };
    },

    'fs.edit_file': async (params) => {
      return runEditFile(params, {
        extra: { remote: true },
        readUtf8: (filePath, maxBytes) => readFile(filePath, 'utf8', { maxBytes }),
        writeUtf8: (filePath, data) =>
          handlers['fs.write_file']({
            filePath,
            data,
            encoding: 'utf8'
          })
      });
    },

    'fs.mkdir': async ({ dirPath }) => {
      const safe = assertAllowedPath(normalizeFilePathInput(dirPath, defaultCwd), writable);
      await fsp.mkdir(safe, { recursive: true });
      return { ok: true, path: safe, remote: true };
    },

    'fs.list_dir': async ({ dirPath }) => {
      const safe = resolvePath(dirPath || root);
      const names = await fsp.readdir(safe, { withFileTypes: true });
      const out = [];
      for (const ent of names) {
        const full = path.join(safe, ent.name);
        let st;
        try {
          st = await fsp.stat(full);
        } catch {
          continue;
        }
        out.push({
          name: ent.name,
          isDirectory: st.isDirectory(),
          size: st.size,
          mtimeMs: st.mtimeMs
        });
      }
      return out;
    },

    'fs.stat': async ({ filePath }) => {
      const safe = resolvePath(filePath);
      const st = await fsp.stat(safe);
      return {
        isFile: st.isFile(),
        isDirectory: st.isDirectory(),
        size: st.size,
        mtimeMs: st.mtimeMs,
        remote: true
      };
    },

    // 远程 LSP 定位：用远程环境自己的 Language Server（rust-analyzer / gopls 等）
    'lsp.query': async ({ operation, op, filePath, file_path, line, character, query }) => {
      const opName = String(operation || op || '').trim();
      const fp = filePath || file_path;
      const params = {
        operation: opName,
        workspaceRoot: root,
        line,
        character,
        query,
        getClient: lspGetClient,
        listClients: lspListClients
      };
      if (fp) params.absPath = resolvePath(fp);
      return queryLspPosition(params);
    },

    'fs.delete_file': async ({ filePath }) => {
      const safe = resolvePath(filePath);
      await fsp.unlink(safe);
      scheduleIndexForChange({ filePath: safe, op: 'delete' });
      return { ok: true, path: safe, remote: true };
    },

    /**
     * 桌面端改完远端文件后的通知（写入/删除都走 SFTP，不经过本进程的 fs.write_file）。
     * 只调度增量索引，不做校验之外的事：调用方是 fire-and-forget，失败不影响那次写。
     */
    'index.notify_change': async (params) => scheduleIndexForChange(params || {}),

    'host.exec': async ({ command, cwd, timeoutMs }) => {
      if (!command || typeof command !== 'string') {
        const e = new Error('command 必填');
        e.code = 'INVALID_COMMAND';
        throw e;
      }
      const workDir = cwd
        ? assertAllowedPath(normalizeFilePathInput(cwd, defaultCwd), roots)
        : defaultCwd;
      const wrapped =
        process.platform === 'win32'
          ? command
          : `bash -lc ${JSON.stringify(`cd ${workDir} && ${command}`)}`;
      return runShell(wrapped, { cwd: workDir, timeoutMs });
    },

    /**
     * 远端唯一 grep：rg-search（`grepWorkspace`）在远端跑，**没有 rg 时它自己退到 GNU grep**
     * ——那套降级与退出码归一已经在 rg-search 里做过一次（P5），这里不再叠一层自拼 grep。
     */
    'fs.grep': async ({ pattern, glob, path: searchPath, regex, caseInsensitive, maxResults }) => {
      const r = await grepWorkspace(root, {
        pattern,
        glob,
        path: searchPath,
        regex: regex === true,
        caseInsensitive: caseInsensitive === true,
        maxResults
      });
      return { ...r, remote: true };
    },

    'fs.glob': async ({ pattern, maxResults }) => {
      const r = await globWorkspace(root, { pattern, maxResults });
      return { ...r, remote: true };
    },

    'artifact.read_file': async ({ filePath, encoding, offset, maxBytes }) =>
      readFile(filePath, encoding, { offset, maxBytes }),

    'artifact.list_files': async ({ limit, sinceMs, maxDepth }) => {
      const res = await scanRecentArtifactFiles(createLocalScanIo(), {
        base: root,
        sinceMs,
        limit,
        maxDepth
      });
      return { ...res, files: res.files.map((f) => ({ ...f, remote: true })) };
    }
  };

  indexCore = new RemoteIndexCoreHost({ workspaceRoot: root, packRoot, log });
  Object.assign(handlers, createRemoteIndexCoreHandlers(indexCore));

  let warmupTimer = null;
  handlers.__warmupRemoteIndex = () => {
    if (warmupTimer || !indexCore) return;
    warmupTimer = setTimeout(() => {
      warmupTimer = null;
      if (!indexCore) return;
      indexCore.start().catch((err) => {
        log(`remote index warmup failed: ${err && err.message ? err.message : err}`);
      });
    }, 800);
  };

  handlers.__disposeRemoteIndex = () => {
    if (warmupTimer) {
      clearTimeout(warmupTimer);
      warmupTimer = null;
    }
    if (graphIncTimer) {
      clearTimeout(graphIncTimer);
      graphIncTimer = null;
    }
    if (codebaseIncTimer) {
      clearTimeout(codebaseIncTimer);
      codebaseIncTimer = null;
    }
    if (indexCore) {
      const core = indexCore;
      indexCore = null;
      return core.stop().catch(() => {});
    }
    return Promise.resolve();
  };

  return handlers;
}

class MinimalRemoteGatewayHost {
  /**
   * @param {{ workspaceRoot?: string, socketPath?: string, packRoot?: string, log?: (msg: string) => void }} opts
   *
   * P2 之后只有一种形态：**每主机一个 daemon**，`socketPath` 指向用户私有的 AF_UNIX socket，
   * 一个进程按连接服务任意多个 workspace（连接上 `hello` 声明根路径）。
   * 没有 TCP 端口、没有 token —— 安全边界就是文件权限（目录 0700 / socket 0600，同 uid 才能连）。
   */
  constructor(opts) {
    this.defaultWorkspaceRoot = opts.workspaceRoot ? path.resolve(String(opts.workspaceRoot)) : '';
    this.workspaceRoot = this.defaultWorkspaceRoot;
    this.socketPath = String(opts.socketPath || '');
    this.packRoot = opts.packRoot ? path.resolve(String(opts.packRoot)) : path.resolve(__dirname, '..');
    this.log = opts.log || (() => {});
    /** @type {import('ws').WebSocketServer | null} */
    this.wss = null;
    /** @type {import('http').Server | null} */
    this.httpServer = null;
    /**
     * workspace 根 → handlers。同一个根被两条连接用到时**共用同一份**（索引 core / 定时器 /
     * LSP 池都在 handler 闭包里，重复创建等于两个实例抢同一个 index.sqlite）。
     * @type {Map<string, { root: string, handlers: object }>}
     */
    this.sessions = new Map();
    // 旧形态（单 workspace 预建）只在 port 模式用；socket 模式按连接懒建
    if (!this.socketPath) this._sessionFor(this.defaultWorkspaceRoot);
  }

  /**
   * 取某个 workspace 的 handler 集合（脚本 / 单测直接调用，不必起 socket）。
   * @param {string} [workspaceRoot]
   */
  getHandlers(workspaceRoot) {
    return this._sessionFor(workspaceRoot || this.defaultWorkspaceRoot).handlers;
  }

  /** @param {string} workspaceRoot */
  _sessionFor(workspaceRoot) {
    const root = path.resolve(String(workspaceRoot || this.defaultWorkspaceRoot || '/'));
    const hit = this.sessions.get(root);
    if (hit) return hit;
    const handlers = createRemoteGatewayHandlers(root, { packRoot: this.packRoot, log: this.log });
    const session = { root, handlers };
    this.sessions.set(root, session);
    if (typeof handlers.__warmupRemoteIndex === 'function') {
      try {
        handlers.__warmupRemoteIndex();
      } catch {
        // 预热失败不影响后续按需启动
      }
    }
    return session;
  }

  getInfo() {
    return {
      socketPath: this.socketPath,
      workspaceRoot: this.defaultWorkspaceRoot,
      remoteGateway: true
    };
  }

  start() {
    if (this.wss) return;
    if (!this.socketPath) {
      const e = new Error('远端 Agent 必须给 socketPath（P2 之后没有 TCP 端口形态）');
      e.code = 'REMOTE_AGENT_NO_SOCKET';
      throw e;
    }
    this._startSocket();
  }

  /**
   * Unix socket 监听。安全边界就是文件系统：目录 0700、socket 0600，
   * 只有同一个 uid 能连（SSH 的 direct-streamlocal 也是以登录用户身份连）。所以这里**没有 token**。
   *
   * 单例也由 socket 自己承担（不需要 flock / pid 文件）：
   * - 能 connect 上 → 已有 daemon 在跑，进程以 42 退出，让调用方去复用；
   * - connect 报 ENOENT/ECONNREFUSED → 上一次崩溃留下的陈旧文件，删掉重绑；
   * - 并发抢绑 → 后到者 bind 拿 EADDRINUSE，同样以 42 退出。
   */
  _startSocket() {
    const socketPath = this.socketPath;
    const dir = path.dirname(socketPath);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    try {
      fs.chmodSync(dir, 0o700);
    } catch {
      // 目录不是自己的时 chmod 会失败，交给 listen 报错
    }
    const probe = net.connect(socketPath);
    probe.once('connect', () => {
      probe.destroy();
      this.log(`remote agent already listening on ${socketPath} (exit 42)`);
      process.exit(AGENT_ALREADY_RUNNING_EXIT);
    });
    probe.once('error', () => {
      probe.destroy();
      try {
        fs.unlinkSync(socketPath);
      } catch {
        // 不存在就是好事
      }
      this._bindSocket();
    });
  }

  _bindSocket() {
    const socketPath = this.socketPath;
    this.httpServer = http.createServer((req, res) => {
      res.statusCode = 426;
      res.end('dieyun-agent: websocket only');
    });
    this.wss = new WebSocketServer({ server: this.httpServer });
    this.wss.on('connection', (ws) => this._bindClient(ws));
    this.httpServer.on('error', (err) => {
      if (err && err.code === 'EADDRINUSE') {
        this.log(`remote agent socket busy: ${socketPath} (exit 42)`);
        process.exit(AGENT_ALREADY_RUNNING_EXIT);
      }
      this.log('remote agent socket error: ' + (err && err.message ? err.message : err));
      process.exit(1);
    });
    this.httpServer.listen(socketPath, () => {
      try {
        fs.chmodSync(socketPath, 0o600);
      } catch {
        // ignore
      }
      this.log(`remote agent listening on ${socketPath}`);
      if (this.defaultWorkspaceRoot) this._sessionFor(this.defaultWorkspaceRoot);
    });
  }

  stop() {
    for (const { handlers } of this.sessions.values()) {
      if (handlers && typeof handlers.__disposeRemoteIndex === 'function') {
        try {
          const p = handlers.__disposeRemoteIndex();
          if (p && typeof p.then === 'function') p.catch(() => {});
        } catch {
          // ignore
        }
      }
    }
    this.sessions.clear();
    if (this.httpServer) {
      try {
        this.httpServer.close();
      } catch {
        // ignore
      }
      this.httpServer = null;
    }
    if (!this.wss) return;
    try {
      this.wss.close();
    } catch {
      // ignore
    }
    this.wss = null;
    if (this.socketPath) {
      try {
        fs.unlinkSync(this.socketPath);
      } catch {
        // ignore
      }
    }
  }

  _send(ws, obj) {
    try {
      if (ws.readyState === 1) ws.send(JSON.stringify(obj));
    } catch {
      // ignore
    }
  }

  _bindClient(ws) {
    // 底层 socket 异常会 emit 'error'；无监听将变成 uncaught exception，故兜底记录
    ws.on('error', (err) => {
      this.log('remote gateway client ws error: ' + (err && err.message ? err.message : err));
    });
    /** @type {{ root: string, handlers: object } | null} */
    let session = null;
    let authed = false;
    const authTimer = setTimeout(() => {
      if (!authed) {
        try {
          ws.close(4001, 'handshake timeout');
        } catch {
          // ignore
        }
      }
    }, 15000);

    ws.on('message', async (raw) => {
      let msg;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        this._send(ws, { v: 1, type: 'error', id: null, error: { code: 'BAD_JSON', message: 'invalid json' } });
        return;
      }
      const id = msg.id != null ? msg.id : null;

      // 一条连接 = 一个 workspace，握手时声明根路径。
      // 没有 token 握手：能连上这个 0600 socket 的只有同一个 uid。
      if (msg.type === 'hello') {
        const root = String(msg.workspace || msg.runWorkspaceRoot || '').trim();
        try {
          session = this._sessionFor(root || this.defaultWorkspaceRoot);
        } catch (err) {
          this._send(ws, {
            v: 1,
            type: 'error',
            id,
            error: { code: 'WORKSPACE_UNAVAILABLE', message: String((err && err.message) || err) }
          });
          ws.close(4004, 'workspace unavailable');
          return;
        }
        authed = true;
        clearTimeout(authTimer);
        this._send(ws, { v: 1, type: 'hello_ok', id, workspace: session.root });
        return;
      }

      if (!authed || !session) {
        this._send(ws, { v: 1, type: 'error', id, error: { code: 'NOT_READY', message: 'send hello first' } });
        return;
      }

      if (msg.type !== 'call') {
        this._send(ws, { v: 1, type: 'error', id, error: { code: 'UNKNOWN_TYPE', message: String(msg.type) } });
        return;
      }

      const fn = session.handlers[msg.method];
      if (!fn) {
        this._send(ws, {
          v: 1,
          type: 'result',
          id,
          ok: false,
          error: { code: 'UNKNOWN_METHOD', message: String(msg.method) }
        });
        return;
      }

      const params = msg.params && typeof msg.params === 'object' ? msg.params : {};
      try {
        const result = await fn(params);
        this._send(ws, { v: 1, type: 'result', id, ok: true, data: result });
      } catch (err) {
        this._send(ws, {
          v: 1,
          type: 'result',
          id,
          ok: false,
          // 与本地 Gateway 同一份失败契约：code / retryable / suggestedFix 一起过隧道，
          // 否则隧道另一头只剩一句中文文案，工具层没法判断能不能重试。
          error: {
            code: err.code || 'EXEC_ERROR',
            message: err.message || String(err),
            ...(typeof err.retryable === 'boolean' ? { retryable: err.retryable } : {}),
            ...(err.suggestedFix ? { suggestedFix: String(err.suggestedFix) } : {})
          }
        });
      }
    });

    ws.on('close', () => clearTimeout(authTimer));
  }
}

module.exports = {
  MinimalRemoteGatewayHost,
  AGENT_ALREADY_RUNNING_EXIT,
  createRemoteGatewayHandlers
};
