'use strict';

const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { pathToFileURL, fileURLToPath } = require('url');
const {
  buildInitializeOptions,
  getLanguageIdForPath,
  getServerKeyForLanguage,
  isLanguageServable,
  isTypescriptProjectConfigPath,
  pythonStubDir,
  shouldOpenOnTypescriptLanguageServer
} = require('./language-registry');
const { buildCmdLine } = require('./spawn-args');

function childEnvForCommand(command) {
  if (command !== process.execPath) return process.env;
  return { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
}

const INIT_TIMEOUT_MS = 45000;
const DEFAULT_DIAG_TIMEOUT_MS = 8000;
const DIAG_DEBOUNCE_MS = 400;

function uriKeyFromAbs(absPath) {
  return path.resolve(absPath).toLowerCase();
}

function uriKeyFromUri(uri) {
  try {
    return path.resolve(fileURLToPath(uri)).toLowerCase();
  } catch {
    return String(uri).toLowerCase();
  }
}

function fileUriFromAbs(absPath) {
  const href = pathToFileURL(path.resolve(absPath)).href;
  // Node 给的是 file:///C:/Users/...；VS Code / pyright / clangd 的规范形式是
  // file:///c%3A/Users/...（盘符小写 + 冒号编码）。用非规范形式发 didOpen 时，
  // pyright 会把它当成另一个文档，只做「导入解析」不做类型检查，
  // 表现为诊断永远为空（等满超时后返回 []）。key 用 fileURLToPath 归一化，故两边仍能对上。
  if (process.platform !== 'win32') return href;
  return href.replace(/^file:\/\/\/([A-Za-z]):/, (_m, drive) => `file:///${drive.toLowerCase()}%3A`);
}

function resolveSpawnSpec(spec, workspaceRoot) {
  if (process.platform === 'win32' && spec.command === 'npx') {
    // 与 cli-fallback 共用同一份引号规则（tsserver 路径同样可能含空格）
    const cmdLine = buildCmdLine('npx', spec.args);
    return {
      command: 'cmd.exe',
      args: ['/d', '/s', '/c', cmdLine],
      options: { shell: false }
    };
  }
  if (!spec.shell) {
    return {
      command: spec.command,
      args: spec.args || [],
      options: { shell: false }
    };
  }
  return {
    command: spec.command,
    args: spec.args || [],
    options: { shell: true }
  };
}

function encodeMessage(obj) {
  const json = JSON.stringify(obj);
  return `Content-Length: ${Buffer.byteLength(json, 'utf8')}\r\n\r\n${json}`;
}

function parseSeverity(value) {
  const n = Number(value);
  if (n === 1) return 'error';
  if (n === 2) return 'warning';
  if (n === 3) return 'info';
  if (n === 4) return 'hint';
  return 'unknown';
}

function normalizeDiagnostic(d) {
  const range = d.range || {};
  const start = range.start || {};
  return {
    severity: parseSeverity(d.severity),
    line: Number(start.line || 0) + 1,
    col: Number(start.character || 0) + 1,
    message: String(d.message || '').trim(),
    code: d.code != null ? String(d.code) : '',
    source: d.source != null ? String(d.source) : ''
  };
}

function severityRank(sev) {
  if (sev === 'error') return 1;
  if (sev === 'warning') return 2;
  if (sev === 'info') return 3;
  if (sev === 'hint') return 4;
  return 9;
}

function filterByMinSeverity(items, minSeverity) {
  const min = severityRank(minSeverity || 'warning');
  return (items || []).filter((d) => severityRank(d.severity) <= min);
}

/**
 * Minimal LSP client over stdio (initialize / didOpen / publishDiagnostics).
 */
class LspClient {
  /**
   * @param {{ spec: object, workspaceRoot: string, serverKey?: string, log?: (msg: string) => void }} opts
   */
  constructor(opts) {
    this.spec = opts.spec;
    this.workspaceRoot = opts.workspaceRoot;
    this.serverKey = opts.serverKey || '';
    /** userData 用于解析 Python 类型存根目录（lsp-stubs）；缺省时不下发 stub 配置 */
    this.userDataPath = opts.userDataPath || '';
    this.log = opts.log || (() => {});
    /** @type {import('child_process').ChildProcess | null} */
    this.proc = null;
    this.buffer = '';
    this.nextId = 1;
    this.initialized = false;
    this.initPromise = null;
    /** @type {Map<number, { resolve: Function, reject: Function }>} */
    this.pending = new Map();
    /** @type {Map<string, object[]>} */
    this.diagnosticsByUri = new Map();
    /** @type {Map<string, { resolve: Function, reject: Function, timer: NodeJS.Timeout }>} */
    this.waiters = new Map();
    /** @type {Map<string, { uri: string, languageId: string, version: number, absPath: string }>} */
    this.openDocuments = new Map();
    /**
     * pyright 的 python.analysis 覆盖项（目前只有类型存根目录）。
     * 通过 workspace/configuration 下发；目录不存在时为 null（保持 pyright 默认）。
     */
    this.pythonAnalysisSettings = null;
    if (this.serverKey === 'python' && this.userDataPath) {
      const stubDir = pythonStubDir(this.userDataPath);
      try {
        if (stubDir && fs.statSync(stubDir).isDirectory()) {
          this.pythonAnalysisSettings = { stubPath: stubDir, extraPaths: [stubDir] };
        }
      } catch {
        this.pythonAnalysisSettings = null;
      }
    }
    this.closed = false;
  }

  start() {
    if (this.proc && !this.closed) return;
    if (this.proc) {
      try {
        this.proc.kill();
      } catch {
        // already gone
      }
      this.proc = null;
    }
    this.closed = false;
    const spec = this.spec;
    const spawnSpec = resolveSpawnSpec(spec, this.workspaceRoot);
    this.proc = spawn(spawnSpec.command, spawnSpec.args, {
      cwd: spec.cwd || this.workspaceRoot,
      env: childEnvForCommand(spawnSpec.command),
      shell: spawnSpec.options.shell,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    });
    this.proc.stdout.on('data', (chunk) => this._onStdout(chunk));
    this.proc.stderr.on('data', (chunk) => {
      const text = String(chunk || '').trim();
      if (text) this.log(`[lsp stderr] ${text.slice(0, 400)}`);
    });
    this.proc.on('exit', (code, signal) => {
      this.log(`[lsp] exited code=${code} signal=${signal || ''}`);
      this._abortPending('language server exited');
    });
    this.proc.on('error', (err) => {
      // ENOENT（rust-analyzer / gopls 未安装）等：立即失败，
      // 否则上层要等 initialize/request 超时（最长 45s）才知道不可用。
      this.log(`[lsp] spawn error: ${err.message}`);
      this._abortPending(`language server unavailable: ${err.message}`);
    });
    this.proc.stdin.on('error', (err) => {
      // 子进程已退出时写入会触发 EPIPE；无监听会冒泡成 uncaught exception
      this.log(`[lsp] stdin error: ${err.message}`);
      this._abortPending('language server write failed');
    });
  }

  /** 子进程不可用：立即失败在途请求与等诊断的 waiter，避免静默等超时 */
  _abortPending(message) {
    this.closed = true;
    this.initialized = false;
    this.initPromise = null;
    this.proc = null;
    for (const [, p] of this.pending.entries()) {
      p.reject(new Error(message));
    }
    this.pending.clear();
    for (const [key, w] of this.waiters.entries()) {
      if (w.hardTimer) clearTimeout(w.hardTimer);
      if (w.debounceTimer) clearTimeout(w.debounceTimer);
      if (typeof w.resolve === 'function') {
        w.resolve(this.diagnosticsByUri.get(key) || []);
      }
    }
    this.waiters.clear();
  }

  _onStdout(chunk) {
    this.buffer += chunk.toString('utf8');
    while (true) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n');
      if (headerEnd < 0) break;
      const header = this.buffer.slice(0, headerEnd);
      const match = /Content-Length:\s*(\d+)/i.exec(header);
      if (!match) {
        this.buffer = this.buffer.slice(headerEnd + 4);
        continue;
      }
      const length = Number(match[1]);
      const bodyStart = headerEnd + 4;
      if (this.buffer.length < bodyStart + length) break;
      const body = this.buffer.slice(bodyStart, bodyStart + length);
      this.buffer = this.buffer.slice(bodyStart + length);
      let msg;
      try {
        msg = JSON.parse(body);
      } catch {
        continue;
      }
      this._handleMessage(msg);
    }
  }

  _handleMessage(msg) {
    if (msg.id != null && (msg.result !== undefined || msg.error !== undefined)) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
      else p.resolve(msg.result);
      return;
    }
    if (msg.method === 'textDocument/publishDiagnostics') {
      const params = msg.params || {};
      const uri = String(params.uri || '');
      const key = uriKeyFromUri(uri);
      const diags = (params.diagnostics || []).map(normalizeDiagnostic);
      this.diagnosticsByUri.set(key, diags);
      // 只在真有诊断时打一行：批量诊断时「diag 0 条」占了绝大多数（实测一轮 855 个
      // .py 有 700+ 条空诊断），逐条落盘会把 main.log 冲爆并拖慢主进程。
      // 汇总口径看 diagnostics-service 的 `[diagnostics] watch batch`。
      if (diags.length) this.log(`[lsp] diag ${diags.length} 条 ← ${key}`);
      const waiter = this.waiters.get(key);
      if (waiter && typeof waiter.onDiagnostics === 'function') {
        waiter.onDiagnostics(diags);
      }
      return;
    }
    if (msg.method === 'workspace/configuration' && msg.id != null) {
      const items = (msg.params && msg.params.items) || [];
      this._configSeenAt = Date.now();
      this.sendResponse(
        msg.id,
        items.map((item) => this._configurationFor(item && item.section))
      );
      return;
    }
    if (msg.method === 'window/logMessage' && msg.params && msg.params.message) {
      this.log(`[lsp log] ${String(msg.params.message).slice(0, 200)}`);
      return;
    }
    /**
     * 服务端发起的请求必须回应，否则 server 会一直等它。
     * 典型：pyright 初始化后发 client/registerCapability（注册 didOpen/didChange），
     * 没回应时文档「打开」从未生效——只能拿到 workspace 扫描产生的 import 级诊断，
     * 类型检查（赋值、参数、属性）永远为空，且表现为「20s 后返回空数组」。
     */
    if (msg.id != null && typeof msg.method === 'string') {
      if (msg.method === 'workspace/workspaceFolders') {
        this.sendResponse(msg.id, [
          {
            uri: fileUriFromAbs(this.workspaceRoot),
            name: path.basename(this.workspaceRoot) || 'workspace'
          }
        ]);
        return;
      }
      this.sendResponse(msg.id, null);
    }
  }

  _send(raw) {
    if (!this.proc || !this.proc.stdin || this.closed) {
      throw new Error('language server not running');
    }
    this.proc.stdin.write(raw);
  }

  sendRequest(method, params) {
    const id = this.nextId++;
    const payload = { jsonrpc: '2.0', id, method, params };
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this._send(encodeMessage(payload));
      } catch (err) {
        this.pending.delete(id);
        reject(err);
      }
    });
  }

  sendNotification(method, params) {
    const payload = { jsonrpc: '2.0', method, params };
    this._send(encodeMessage(payload));
  }

  /**
   * 回应服务端请求。**不能抛错**：
   * 它只可能被 `_onStdout` 的 `data` 回调调用，而 `_abortPending`（进程 exit / spawn
   * error）会把 `proc` 置 null 并 `closed=true`；此时 stdout 里已缓冲的消息仍会被派发，
   * `_send` 抛出的 `language server not running` 在事件回调里无人接管 → uncaughtException
   * → 主进程崩（`main-entry.js` 只挂了 unhandledRejection）。
   */
  sendResponse(id, result) {
    try {
      this._send(encodeMessage({ jsonrpc: '2.0', id, result }));
    } catch (err) {
      this.log(`[lsp] 回包丢弃（server 已退出）id=${id}: ${err && err.message ? err.message : err}`);
    }
  }

  /**
   * 响应 language server 的 workspace/configuration。
   * pyright 通过这个通道读取 python.analysis.*（vscode-pyright 同款），
   * 早先一律返回 {} 导致「下发 python 设置」的所有尝试都是静默无效。
   */
  _configurationFor(section) {
    const key = String(section || '').toLowerCase();
    const py = this.pythonAnalysisSettings;
    if (!py) return {};
    if (key === 'python') return { analysis: py };
    if (key === 'python.analysis') return py;
    return {};
  }

  async ensureInitialized() {
    if (this.initialized) return;
    if (this.initPromise) return this.initPromise;
    this.initPromise = this._initialize().catch((err) => {
      this.initPromise = null;
      this.initialized = false;
      throw err;
    });
    return this.initPromise;
  }

  async _initialize() {
    this.start();
    // 统一用规范 URI（与 didOpen 同一套），否则 pyright 会把 workspace 根和文档
    // 当成两棵不同的树，打开的文件落在 workspace 之外，类型检查直接被跳过。
    const rootUri = fileUriFromAbs(this.workspaceRoot);
    const initOptions = buildInitializeOptions(this.serverKey, this.workspaceRoot, {
      userDataPath: this.userDataPath
    });
    const initResult = await Promise.race([
      this.sendRequest('initialize', {
        processId: process.pid,
        rootUri,
        capabilities: {
          workspace: { configuration: true, symbol: {} },
          textDocument: {
            publishDiagnostics: { relatedInformation: true },
            synchronization: { dynamicRegistration: true, willSave: false, didSave: false },
            definition: {},
            typeDefinition: {},
            references: {},
            implementation: {},
            hover: {},
            documentSymbol: {},
            callHierarchy: {}
          }
        },
        initializationOptions: initOptions,
        workspaceFolders: [{ uri: rootUri, name: path.basename(this.workspaceRoot) || 'workspace' }]
      }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('LSP initialize timeout')), INIT_TIMEOUT_MS)
      )
    ]);
    this.sendNotification('initialized', {});
    this.initialized = true;
    // pyright 类 server 在收到 initialized 后才请求 workspace/configuration 并建 program；
    // program 就绪前发 didOpen 会被丢弃（表现为「怎么都不推诊断」）。这里等它建完再放行。
    await this._waitProgramReady();
    if (initResult && initResult.capabilities) {
      this.log(`[lsp] initialized ${this.spec.id || 'server'}`);
    }
  }

  /**
   * 等服务端 program 就绪。
   * 探测信号：initialized 之后 150ms 内是否收到 workspace/configuration 请求。
   * - 收到（pyright 等）：继续等最后一次请求后 150ms 静默，最多 2000ms；
   * - 没收到（tsserver 等）：立即返回，不引入延迟。
   */
  async _waitProgramReady() {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const start = Date.now();
    await sleep(150);
    if (!this._configSeenAt) return;
    while (Date.now() - start < 2000 && Date.now() - this._configSeenAt < 150) {
      await sleep(50);
    }
  }

  hasOpenDocument(absPath) {
    return this.openDocuments.has(uriKeyFromAbs(absPath));
  }

  _waitForDiagnostics(key, timeoutMs) {
    return new Promise((resolve) => {
      const waiter = {
        hardTimer: null,
        debounceTimer: null,
        resolve,
        onDiagnostics: () => {
          if (waiter.debounceTimer) clearTimeout(waiter.debounceTimer);
          waiter.debounceTimer = setTimeout(finish, DIAG_DEBOUNCE_MS);
        }
      };
      const finish = () => {
        if (waiter.hardTimer) clearTimeout(waiter.hardTimer);
        if (waiter.debounceTimer) clearTimeout(waiter.debounceTimer);
        this.waiters.delete(key);
        resolve(this.diagnosticsByUri.get(key) || []);
      };
      waiter.hardTimer = setTimeout(finish, timeoutMs);
      this.waiters.set(key, waiter);
    });
  }

  _finalizeDiagnostics(diags, opts) {
    let out = filterByMinSeverity(diags, opts.minSeverity || 'warning');
    const maxPerFile = opts.maxPerFile != null ? Number(opts.maxPerFile) : 20;
    out.sort((a, b) => {
      const sr = severityRank(a.severity) - severityRank(b.severity);
      if (sr !== 0) return sr;
      return a.line - b.line || a.col - b.col;
    });
    if (maxPerFile > 0 && out.length > maxPerFile) {
      out = out.slice(0, maxPerFile);
    }
    return out;
  }

  /**
   * @param {{ absPath: string, languageId: string, text: string, timeoutMs?: number, minSeverity?: string, maxPerFile?: number }} opts
   */
  async syncDocument(opts) {
    if (!isLanguageServable(opts.absPath, opts.languageId)) {
      return [];
    }
    await this.ensureInitialized();
    const key = uriKeyFromAbs(opts.absPath);
    const uri = fileUriFromAbs(opts.absPath);
    const timeoutMs = opts.timeoutMs || DEFAULT_DIAG_TIMEOUT_MS;
    const diagPromise = this._waitForDiagnostics(key, timeoutMs);
    const existing = this.openDocuments.get(key);

    if (!existing) {
      const version = 1;
      this.openDocuments.set(key, {
        uri,
        languageId: opts.languageId,
        version,
        absPath: opts.absPath
      });
      this.sendNotification('textDocument/didOpen', {
        textDocument: {
          uri,
          languageId: opts.languageId,
          version,
          text: opts.text
        }
      });
    } else {
      existing.version += 1;
      if (opts.languageId) existing.languageId = opts.languageId;
      this.sendNotification('textDocument/didChange', {
        textDocument: { uri, version: existing.version },
        contentChanges: [{ text: opts.text }]
      });
    }

    const diags = await diagPromise;
    return this._finalizeDiagnostics(diags, opts);
  }

  /**
   * @param {{ absPath: string, languageId: string, text: string }} opts
   */
  async ensureDocumentOpen(opts) {
    // 只要该语言注册了 server 就打开文档（ts/js/py/rust/go）；
    // ts 的工程配置文件（package.json、tsconfig.json 等）仍需排除，否则 tsserver 会报 Unexpected resource。
    const lang = opts.languageId || getLanguageIdForPath(opts.absPath);
    const canOpen = !!getServerKeyForLanguage(lang) && !isTypescriptProjectConfigPath(opts.absPath);
    if (!canOpen) {
      return { uri: fileUriFromAbs(opts.absPath), key: uriKeyFromAbs(opts.absPath), skipped: true };
    }
    await this.ensureInitialized();
    const key = uriKeyFromAbs(opts.absPath);
    const uri = fileUriFromAbs(opts.absPath);
    const languageId = opts.languageId;
    const text = opts.text;
    const existing = this.openDocuments.get(key);

    if (!existing) {
      const version = 1;
      this.openDocuments.set(key, {
        uri,
        languageId,
        version,
        absPath: opts.absPath
      });
      this.sendNotification('textDocument/didOpen', {
        textDocument: {
          uri,
          languageId,
          version,
          text
        }
      });
    } else {
      existing.version += 1;
      if (languageId) existing.languageId = languageId;
      this.sendNotification('textDocument/didChange', {
        textDocument: { uri, version: existing.version },
        contentChanges: [{ text }]
      });
    }
    return { uri, key };
  }

  _requestWithTimeout(promise, timeoutMs, label) {
    const ms = timeoutMs || 15000;
    return Promise.race([
      promise,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`${label || 'LSP'} timeout`)), ms)
      )
    ]);
  }

  /**
   * @param {{ absPath: string, line: number, character: number, languageId: string, text: string, timeoutMs?: number }} opts
   */
  async getReferences(opts) {
    const { uri } = await this.ensureDocumentOpen(opts);
    const position = {
      line: Math.max(0, Number(opts.line || 1) - 1),
      character: Math.max(0, Number(opts.character || 0))
    };
    const result = await this._requestWithTimeout(
      this.sendRequest('textDocument/references', {
        textDocument: { uri },
        position,
        context: { includeDeclaration: opts.includeDeclaration === true }
      }),
      opts.timeoutMs,
      'references'
    );
    return Array.isArray(result) ? result : [];
  }

  async getDefinition(opts) {
    const { uri } = await this.ensureDocumentOpen(opts);
    const position = {
      line: Math.max(0, Number(opts.line || 1) - 1),
      character: Math.max(0, Number(opts.character || 0))
    };
    return this._requestWithTimeout(
      this.sendRequest('textDocument/definition', {
        textDocument: { uri },
        position
      }),
      opts.timeoutMs,
      'definition'
    );
  }

  async getImplementation(opts) {
    const { uri } = await this.ensureDocumentOpen(opts);
    const position = {
      line: Math.max(0, Number(opts.line || 1) - 1),
      character: Math.max(0, Number(opts.character || 0))
    };
    return this._requestWithTimeout(
      this.sendRequest('textDocument/implementation', {
        textDocument: { uri },
        position
      }),
      opts.timeoutMs,
      'implementation'
    );
  }

  async getHover(opts) {
    const { uri } = await this.ensureDocumentOpen(opts);
    const position = {
      line: Math.max(0, Number(opts.line || 1) - 1),
      character: Math.max(0, Number(opts.character || 0))
    };
    return this._requestWithTimeout(
      this.sendRequest('textDocument/hover', {
        textDocument: { uri },
        position
      }),
      opts.timeoutMs,
      'hover'
    );
  }

  async getTypeDefinition(opts) {
    const { uri } = await this.ensureDocumentOpen(opts);
    const position = {
      line: Math.max(0, Number(opts.line || 1) - 1),
      character: Math.max(0, Number(opts.character || 0))
    };
    return this._requestWithTimeout(
      this.sendRequest('textDocument/typeDefinition', {
        textDocument: { uri },
        position
      }),
      opts.timeoutMs,
      'typeDefinition'
    );
  }

  /**
   * 文件大纲：返回 DocumentSymbol/SymbolInformation 原始结构，由调用方归一化。
   * @param {{ absPath: string, languageId: string, text: string, timeoutMs?: number }} opts
   */
  async getDocumentSymbols(opts) {
    const { uri } = await this.ensureDocumentOpen(opts);
    return this._requestWithTimeout(
      this.sendRequest('textDocument/documentSymbol', { textDocument: { uri } }),
      opts.timeoutMs,
      'documentSymbol'
    );
  }

  /**
   * 全工作区按名搜符号（LSP workspace/symbol），无需打开具体文件。
   * @param {{ query: string, timeoutMs?: number }} opts
   */
  async getWorkspaceSymbols(opts) {
    await this.ensureInitialized();
    return this._requestWithTimeout(
      this.sendRequest('workspace/symbol', { query: String(opts.query || '') }),
      opts.timeoutMs,
      'workspaceSymbol'
    );
  }

  /**
   * @param {{ absPath: string, line: number, character: number, languageId: string, text: string, timeoutMs?: number }} opts
   */
  async getIncomingCalls(opts) {
    const { uri } = await this.ensureDocumentOpen(opts);
    const position = {
      line: Math.max(0, Number(opts.line || 1) - 1),
      character: Math.max(0, Number(opts.character || 0))
    };
    let items = [];
    try {
      items = await this._requestWithTimeout(
        this.sendRequest('textDocument/prepareCallHierarchy', {
          textDocument: { uri },
          position
        }),
        opts.timeoutMs,
        'prepareCallHierarchy'
      );
    } catch {
      return [];
    }
    if (!Array.isArray(items) || !items.length) return [];

    const all = [];
    for (const item of items.slice(0, 4)) {
      let incoming;
      try {
        incoming = await this._requestWithTimeout(
          this.sendRequest('callHierarchy/incomingCalls', { item }),
          opts.timeoutMs,
          'incomingCalls'
        );
      } catch {
        continue;
      }
      if (Array.isArray(incoming)) all.push(...incoming);
    }
    return all;
  }

  async closeDocument(absPath) {
    const key = uriKeyFromAbs(absPath);
    const existing = this.openDocuments.get(key);
    if (!existing) return;
    this.sendNotification('textDocument/didClose', {
      textDocument: { uri: existing.uri }
    });
    this.openDocuments.delete(key);
    this.diagnosticsByUri.delete(key);
    const waiter = this.waiters.get(key);
    if (waiter) {
      if (waiter.hardTimer) clearTimeout(waiter.hardTimer);
      if (waiter.debounceTimer) clearTimeout(waiter.debounceTimer);
      this.waiters.delete(key);
    }
  }

  /**
   * @param {{ absPath: string, languageId: string, text: string, timeoutMs?: number, minSeverity?: string, maxPerFile?: number }} opts
   */
  async getDiagnosticsForFile(opts) {
    await this.ensureInitialized();
    if (!isLanguageServable(opts.absPath, opts.languageId)) {
      return [];
    }
    const key = uriKeyFromAbs(opts.absPath);
    const uri = fileUriFromAbs(opts.absPath);
    const timeoutMs = opts.timeoutMs || DEFAULT_DIAG_TIMEOUT_MS;

    if (this.openDocuments.has(key)) {
      return this.syncDocument(opts);
    }

    const version = Date.now();
    const diagPromise = this._waitForDiagnostics(key, timeoutMs);
    this.openDocuments.set(key, {
      uri,
      languageId: opts.languageId,
      version,
      absPath: opts.absPath
    });

    this.sendNotification('textDocument/didOpen', {
      textDocument: {
        uri,
        languageId: opts.languageId,
        version,
        text: opts.text
      }
    });
    // 不再逐文件打 didOpen 日志：批量 watch 场景一轮几百个文件，每文件一行是纯噪音，
    // 汇总口径见 diagnostics-service 的 `[diagnostics] watch batch files=N`。

    try {
      const diags = await diagPromise;
      return this._finalizeDiagnostics(diags, opts);
    } finally {
      await this.closeDocument(opts.absPath);
    }
  }

  async shutdown() {
    if (!this.proc || this.closed) return;
    try {
      if (this.initialized) {
        await Promise.race([
          this.sendRequest('shutdown', null),
          new Promise((resolve) => setTimeout(resolve, 2000))
        ]);
        this.sendNotification('exit', null);
      }
    } catch {
      // ignore
    }
    try {
      this.proc.kill();
    } catch {
      // ignore
    }
    this.closed = true;
    this.proc = null;
    this.initialized = false;
    this.initPromise = null;
  }
}

module.exports = {
  LspClient,
  normalizeDiagnostic,
  filterByMinSeverity,
  severityRank
};
