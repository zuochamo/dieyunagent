'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const { assertAllowedPath } = require('../gateway/path-policy');
const { runShell, normalizeFilePathInput } = require('../gateway/host-control');
const { normalizeReadParams } = require('../gateway/fs-read-limits');
const { runEditFile } = require('../gateway/fs-edit-file');
const { grepWorkspace, globWorkspace } = require('../gateway/rg-search');
const { RemoteIndexCoreHost, createRemoteIndexCoreHandlers } = require('./remote-index-core');
const { queryLspPosition } = require('../lsp/navigate-service');
const { LspClient } = require('../lsp/lsp-client');
const { getServerSpec } = require('../lsp/language-registry');

const GRAPH_SOURCE_EXT = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.go', '.rs']);

function isGraphSourcePath(filePath) {
  return GRAPH_SOURCE_EXT.has(path.extname(String(filePath || '')).toLowerCase());
}

const DEFAULT_REMOTE_PORT = 17331;

function summarizeLineDiff(beforeText, afterText) {
  const before = beforeText == null ? [] : String(beforeText).split(/\r?\n/);
  const after = String(afterText || '').split(/\r?\n/);
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let beforeEnd = before.length - 1;
  let afterEnd = after.length - 1;
  while (beforeEnd >= start && afterEnd >= start && before[beforeEnd] === after[afterEnd]) {
    beforeEnd--;
    afterEnd--;
  }
  return {
    added: Math.max(0, afterEnd - start + 1),
    removed: Math.max(0, beforeEnd - start + 1)
  };
}

function createRemoteGatewayHandlers(workspaceRoot, opts = {}) {
  const root = path.resolve(String(workspaceRoot || '/'));
  const roots = [root];
  const writable = [root];
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
      if (enc === 'utf8' && !shouldSkipIncrementalPath(safe)) {
        scheduleRemoteCodebaseIncremental('save');
      }
      if (enc === 'utf8' && isGraphSourcePath(safe)) {
        scheduleRemoteGraphIncremental('save');
      }
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
      return { ok: true, path: safe, remote: true };
    },

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

    'codebase.grep': async ({ pattern, glob, maxResults }) => {
      const pat = String(pattern || '').trim();
      if (!pat) {
        const e = new Error('pattern 必填');
        e.code = 'INVALID_PATTERN';
        throw e;
      }
      const limit = Math.min(200, Math.max(1, Number(maxResults) || 50));
      const globPart = glob ? `--include=${JSON.stringify(String(glob))}` : '';
      const cmd = `grep -RIn ${globPart} --exclude-dir=.git --exclude-dir=node_modules -m ${limit} ${JSON.stringify(pat)} . 2>/dev/null | head -n ${limit}`;
      const r = await runShell(cmd, { cwd: root, timeoutMs: 60000 });
      const lines = String(r.stdout || '')
        .split(/\r?\n/)
        .filter(Boolean)
        .slice(0, limit)
        .map((line) => {
          const m = line.match(/^([^:]+):(\d+):(.*)$/);
          if (!m) return { raw: line };
          return { path: path.resolve(root, m[1]), line: Number(m[2]), text: m[3] };
        });
      return { ok: true, matches: lines, remote: true };
    },

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

    'agent.ping': async () => ({
      ok: true,
      remote: true,
      workspaceRoot: root,
      pid: process.pid,
      uptimeSec: Math.floor(process.uptime())
    }),

    'artifact.read_file': async ({ filePath, encoding, offset, maxBytes }) =>
      readFile(filePath, encoding, { offset, maxBytes }),

    'artifact.list_files': async ({ limit }) => {
      const max = Math.min(500, Math.max(1, Number(limit) || 200));
      const skipDirs = new Set(['.git', 'node_modules', '__pycache__', '.venv', 'venv', 'dist', 'build']);
      const out = [];
      const stack = [{ dir: root, depth: 0 }];
      while (stack.length && out.length < max) {
        const cur = stack.pop();
        let entries = [];
        try {
          entries = await fsp.readdir(cur.dir, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const ent of entries) {
          if (out.length >= max) break;
          if (!ent.name || ent.name.startsWith('~$')) continue;
          const full = path.join(cur.dir, ent.name);
          if (ent.isDirectory()) {
            if (cur.depth < 4 && !skipDirs.has(ent.name)) stack.push({ dir: full, depth: cur.depth + 1 });
            continue;
          }
          let st;
          try {
            st = await fsp.stat(full);
          } catch {
            continue;
          }
          out.push({
            path: full,
            relativePath: path.relative(root, full) || ent.name,
            size: st.size,
            mtimeMs: st.mtimeMs,
            remote: true
          });
        }
      }
      out.sort((a, b) => Number(b.mtimeMs || 0) - Number(a.mtimeMs || 0));
      return { base: root, files: out.slice(0, max) };
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
   * @param {{ workspaceRoot: string, packRoot?: string, port?: number, token?: string, log?: (msg: string) => void }} opts
   */
  constructor(opts) {
    this.workspaceRoot = path.resolve(String(opts.workspaceRoot || '/'));
    this.packRoot = opts.packRoot ? path.resolve(String(opts.packRoot)) : path.resolve(__dirname, '..');
    this.port = Number(opts.port) || DEFAULT_REMOTE_PORT;
    this.token = String(opts.token || crypto.randomBytes(24).toString('hex'));
    this.log = opts.log || (() => {});
    /** @type {import('ws').WebSocketServer | null} */
    this.wss = null;
    this.handlers = createRemoteGatewayHandlers(this.workspaceRoot, {
      packRoot: this.packRoot,
      log: this.log
    });
  }

  getInfo() {
    return {
      host: '127.0.0.1',
      port: this.port,
      url: `ws://127.0.0.1:${this.port}`,
      token: this.token,
      workspaceRoot: this.workspaceRoot,
      remoteGateway: true
    };
  }

  start() {
    if (this.wss) return;
    this.wss = new WebSocketServer({ host: '127.0.0.1', port: this.port });
    this.wss.on('connection', (ws) => this._bindClient(ws));
    this.wss.on('listening', () => {
      this.log(`remote gateway ws://127.0.0.1:${this.port} workspace=${this.workspaceRoot}`);
      const warmup = this.handlers && this.handlers.__warmupRemoteIndex;
      if (typeof warmup === 'function') warmup();
    });
    this.wss.on('error', (err) => {
      this.log('remote gateway error: ' + (err && err.message ? err.message : err));
      if (err && err.code === 'EADDRINUSE') {
        process.exit(1);
      }
    });
  }

  stop() {
    if (this.handlers && typeof this.handlers.__disposeRemoteIndex === 'function') {
      try {
        const p = this.handlers.__disposeRemoteIndex();
        if (p && typeof p.then === 'function') p.catch(() => {});
      } catch {
        // ignore
      }
    }
    if (!this.wss) return;
    try {
      this.wss.close();
    } catch {
      // ignore
    }
    this.wss = null;
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
    let authed = false;
    const authTimer = setTimeout(() => {
      if (!authed) {
        try {
          ws.close(4001, 'auth timeout');
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

      if (msg.type === 'auth') {
        if (msg.token === this.token) {
          authed = true;
          clearTimeout(authTimer);
          this._send(ws, { v: 1, type: 'auth_ok', id });
        } else {
          this._send(ws, { v: 1, type: 'error', id, error: { code: 'AUTH_FAILED', message: 'invalid token' } });
          ws.close(4003, 'auth failed');
        }
        return;
      }

      if (!authed) {
        this._send(ws, { v: 1, type: 'error', id, error: { code: 'NOT_AUTHED', message: 'send auth first' } });
        return;
      }

      if (msg.type !== 'call') {
        this._send(ws, { v: 1, type: 'error', id, error: { code: 'UNKNOWN_TYPE', message: String(msg.type) } });
        return;
      }

      const fn = this.handlers[msg.method];
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
          error: { code: err.code || 'EXEC_ERROR', message: err.message || String(err) }
        });
      }
    });

    ws.on('close', () => clearTimeout(authTimer));
  }
}

module.exports = { MinimalRemoteGatewayHost, DEFAULT_REMOTE_PORT };
