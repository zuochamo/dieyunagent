'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const { createRpcHandlers } = require('./rpc');
const { createTurnUndoService } = require('../undo/turn-undo-service');
const { createLspDiagnosticsService } = require('../lsp/diagnostics-service');
const {
  loadPermissions,
  savePermissions,
  normalizePermissions,
  stripDerivedPermissions,
  withSandboxMode
} = require('./permissions-store');
const {
  normalizeSandboxMode,
  sandboxErrorFor,
  SANDBOX_MODE_META,
  SANDBOX_MODES
} = require('./sandbox-policy');
const { createSandboxApprovals } = require('./sandbox-approvals');
const {
  dieyunDefaultWorkspaceDir,
  dieyunHome,
  dieyunMemoryDir,
  dieyunSkillsDir,
  dieyunUserHome,
  systemTempDir
} = require('../agent-home');
const { dieyunMdPath } = require('../dieyun-instructions');
const { getEmbeddingConfig, loadModelSettings } = require('../model-settings');
const { buildLlmHeadersFromConfig } = require('../agent/llm-request');
const { createGraphIncrementalScheduler } = require('../graph/graph-incremental-scheduler');
const { createCodebaseIncrementalScheduler } = require('../index/codebase-incremental-scheduler');
const { createWorkspaceIndexWatcher } = require('../index/workspace-index-watcher');
const {
  targetFromDisk,
  targetToDisk,
  formatWorkspaceDisplay,
  workspacePathForSession,
  parseWorkspaceInput,
  isSameSshTarget,
  normalizeRemotePath,
  stripWorktreeSuffix,
} = require('../workspace/target');
const { repoRemotePathOf } = require('../ssh/remote-worktree');

const DEFAULT_PORT = 17330;

/**
 * 本机所有卷根（「完全放开路径限制」开关用）：Windows 枚举实际存在的盘符，POSIX 只有 `/`。
 * 不可访问的卷（未插入的读卡器 / 断开的网络盘）跳过，避免后续 canonicalize 失败。
 */
function localVolumeRoots() {
  if (process.platform !== 'win32') return [path.parse(process.cwd()).root || '/'];
  const out = [];
  for (let i = 65; i <= 90; i += 1) {
    const root = `${String.fromCharCode(i)}:\\`;
    try {
      if (fs.existsSync(root)) out.push(root);
    } catch {
      // 跳过不可访问的卷
    }
  }
  return out.length ? out : [path.parse(process.cwd()).root];
}

/** resolve + 去重根列表（读 / 写白名单共用，保持其一处置去重规则）。 */
function uniqueResolvedRoots(roots) {
  const seen = new Set();
  const out = [];
  for (const raw of roots) {
    if (!raw) continue;
    const resolved = path.resolve(raw);
    const key = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(resolved);
  }
  return out;
}

/**
 * @typedef {object} GatewayOptions
 * @property {string} userDataPath app.getPath('userData')
 * @property {string} readableDir 只读文件白名单根之一
 * @property {string[]} [extraReadRoots] 开发态等额外根
 * @property {(msg: string) => void} [log]
 * @property {(msg: string) => void} [logDebug] 低噪心跳日志（如 LSP 空批次）；不给就不打，主日志只留「有产出/失败」的行
 * @property {import('./permissions-store').DEFAULTS & object} [permissions]
 * @property {string} [sandboxModeOverride] 只本次进程生效的沙箱档位（不落盘；headless `--sandbox` 用）
 * @property {ReturnType<import('../browser/service').createBrowserService> | null} [browser]
 * @property {ReturnType<import('../ssh/session-manager').createSshSessionManager> | null} [ssh]
 * @property {(sessionId?: string) => { url: string, token: string } | null} [getRemoteAgentInfo]
 */

class LocalGateway {
  /**
   * @param {GatewayOptions} opts
   */
  constructor(opts) {
    this.userDataPath = opts.userDataPath;
    this.readableDir = opts.readableDir;
    this.extraReadRoots = opts.extraReadRoots || [];
    this.log = opts.log || (() => {});
    this.logDebug = opts.logDebug || (() => {});
    /** @type {import('../workspace/target').WorkspaceTarget | null} */
    this.workspaceTarget = null;
    this.workspaceRoot = null;
    /** @type {Map<string, import('../workspace/target').WorkspaceTarget>} */
    this.sessionWorkspaceTargets = new Map();
    /** @type {ReturnType<import('../ssh/connection-pool').createSshConnectionPool> | null} */
    this.sshPool = null;
    /** @type {ReturnType<import('../ssh/remote-gateway-pool').createRemoteGatewayPool> | null} */
    this.remoteGatewayPool = null;
    /** @type {ReturnType<import('../ssh/port-forward-manager').createPortForwardManager> | null} */
    this.portForwardManager = null;
    this.permissionsPath = path.join(this.userDataPath, 'host-permissions.json');
    this.workspacePathFile = path.join(this.userDataPath, 'workspace.json');
    const storedPermissions = opts.permissions || loadPermissions(this.permissionsPath);
    // `sandboxModeOverride`：只本次进程生效的档位覆盖（headless `--sandbox`），**不落盘**。
    // 走同一个归一入口，行为与设置页改档一致，只是不写 host-permissions.json。
    this.permissions = opts.sandboxModeOverride
      ? withSandboxMode(storedPermissions, opts.sandboxModeOverride)
      : normalizePermissions(storedPermissions);
    /**
     * ask-once 审批：越界操作问用户一次，本会话内同类直接放行。
     * `opts.requestSandboxApproval` 由 Main 注入（走 Renderer 弹窗）；没有注入时 fail-closed。
     */
    this.sandboxApprovals = createSandboxApprovals({
      request: opts.requestSandboxApproval,
      log: (msg) => this.log(msg)
    });

    this.port = Number(process.env.DIECLOUD_GATEWAY_PORT) || DEFAULT_PORT;
    this.tokenPath = path.join(this.userDataPath, 'gateway-token.txt');

    /** @type {import('ws').WebSocketServer | null} */
    this.wss = null;
    /** @type {Set<import('ws').WebSocket>} */
    this.wsClients = new Set();
    /** @type {ReturnType<createRpcHandlers> | null} */
    this.handlers = null;
    this.token = '';
    /** @type {ReturnType<import('../browser/service').createBrowserService> | null} */
    this.browser = opts.browser || null;
    /** @type {ReturnType<import('../computer/service').createComputerService> | null} */
    this.computer = opts.computer || null;
    /** @type {ReturnType<import('../ssh/session-manager').createSshSessionManager> | null} */
    this.ssh = opts.ssh || null;
    this.getRemoteAgentInfo = typeof opts.getRemoteAgentInfo === 'function' ? opts.getRemoteAgentInfo : () => null;
    this.healRemoteAgentTransport =
      typeof opts.healRemoteAgentTransport === 'function' ? opts.healRemoteAgentTransport : null;
    this.getLeasedSessionIds = typeof opts.getLeasedSessionIds === 'function' ? opts.getLeasedSessionIds : () => [];
    /** @type {Array<{ watchKey: string, root: string }>} */
    this._activeWatchRoots = [];
    /** @type {ReturnType<import('../core-bridge').createCoreBridge> | null} */
    this.rustCore = opts.rustCore || null;
    this.turnUndo = createTurnUndoService({ userDataPath: this.userDataPath });
    this.lspDiagnostics = createLspDiagnosticsService({
      userDataPath: this.userDataPath,
      log: (msg) => this.log(`[lsp] ${msg}`),
      logDebug: (msg) => this.logDebug(`[lsp] ${msg}`),
      onStoreUpdated: (workspaceRoot) => this._broadcastDiagnosticsStoreUpdated(workspaceRoot)
    });
    this.graphIncremental = createGraphIncrementalScheduler({
      userDataPath: this.userDataPath,
      getWorkspaceRoot: () => this._effectiveWorkspaceRoot() || this.workspaceRoot,
      invokeRustCore: async (method, params, timeoutMs) => {
        if (!this.rustCore || !this.rustCore.isReady()) return null;
        try {
          return await this.rustCore.invoke(method, params, timeoutMs);
        } catch {
          return null;
        }
      },
      log: (msg) => this.log(msg)
    });
    this.codebaseIncremental = createCodebaseIncrementalScheduler({
      userDataPath: this.userDataPath,
      getWorkspaceRoot: () => this._effectiveWorkspaceRoot() || this.workspaceRoot,
      invokeRustCore: async (method, params, timeoutMs) => {
        if (!this.rustCore || !this.rustCore.isReady()) return null;
        try {
          return await this.rustCore.invoke(method, params, timeoutMs);
        } catch {
          return null;
        }
      },
      log: (msg) => this.log(msg)
    });
    // 外部改动（git checkout / 外部编辑器 / 构建产物）也要刷新索引，
    // 此前只有经 fs.write_file RPC 的写入会触发
    this.indexWatcher = createWorkspaceIndexWatcher({
      onFileChanged: (absPath, root) => {
        this.codebaseIncremental?.notifyFileSaved(absPath, root);
        this.graphIncremental?.notifyFileSaved(absPath, root);
      },
      log: (msg) => this.log(msg)
    });
  }

  setSshConnectionPool(pool) {
    this.sshPool = pool || null;
    this._refreshHandlers();
  }

  setRemoteGatewayPool(pool) {
    this.remoteGatewayPool = pool || null;
    this._refreshHandlers();
  }

  setPortForwardManager(pfm) {
    this.portForwardManager = pfm || null;
    this._refreshHandlers();
  }

  /**
   * 端口转发只服务于当前远程工作空间的预览。切到本地或另一台主机后必须回收，
   * 否则旧隧道会长期占着本地端口（本地 dev server 反而起不来）。
   * @param {{ kind?: string, host?: string, port?: number, username?: string } | null} nextTarget
   */
  _dropPortForwardsForWorkspaceChange(nextTarget) {
    if (!this.portForwardManager) return;
    const cur = this.workspaceTarget;
    if (!cur || cur.kind !== 'ssh') return;
    if (nextTarget && nextTarget.kind === 'ssh' && isSameSshTarget(cur, nextTarget)) return;
    Promise.resolve()
      .then(() => this.portForwardManager.removeAll())
      .catch((e) => this.log('port forward cleanup: ' + (e && e.message ? e.message : String(e))));
  }


  getSshManagerForTarget(target) {
    if (target && target.kind === 'ssh' && this.sshPool) {
      const m = this.sshPool.getConnectedManager(target);
      if (m) return m;
      return this.sshPool.getManagerForTarget(target);
    }
    return null;
  }


  setRemoteAgentInfoProvider(fn) {
    this.getRemoteAgentInfo = typeof fn === 'function' ? fn : () => null;
    this._refreshHandlers();
  }

  setHealRemoteAgentTransport(fn) {
    this.healRemoteAgentTransport = typeof fn === 'function' ? fn : null;
    this._refreshHandlers();
  }

  setLeasedSessionIdsProvider(fn) {
    this.getLeasedSessionIds = typeof fn === 'function' ? fn : () => [];
  }

  syncWorkspaceDiagnosticsWatch() {
    this._syncWorkspaceDiagnosticsWatch();
  }

  setRemoteDisconnectGuard(fn) {
    this._remoteDisconnectGuard = typeof fn === 'function' ? fn : null;
  }

  setSshManager(ssh) {
    this.ssh = ssh || null;
    this._refreshHandlers();
  }


  setBrowser(browser) {
    this.browser = browser || null;
    this._refreshHandlers();
  }

  setComputer(computer) {
    this.computer = computer || null;
    this._refreshHandlers();
  }

  setRustCore(bridge) {
    this.rustCore = bridge || null;
    this._refreshHandlers();
  }

  _syncRustCoreConfig() {
    if (!this.rustCore || typeof this.rustCore.configure !== 'function') return Promise.resolve();
    if (this._rustCoreConfigureInFlight) return this._rustCoreConfigureInFlight;
    const roots = this._collectReadRoots();
    const embedding = getEmbeddingConfig(loadModelSettings(this.userDataPath));
    const modelSettings = loadModelSettings(this.userDataPath);
    this._rustCoreConfigureInFlight = this.rustCore
      .configure({
        data_dir: this.userDataPath,
        workspace_roots: roots,
        embedding: {
          disabled: !!embedding.disabled,
          baseUrl: embedding.baseUrl || '',
          apiKey: embedding.apiKey || '',
          model: embedding.model || '',
          dimensions: Number(embedding.dimensions) || 1024,
          // 请求头由 llm-request 装配后交给 Rust 直接应用，Rust 不自行推导鉴权
          headers: buildLlmHeadersFromConfig(embedding),
          authMode: String(embedding.authMode || '').trim()
        },
        llm: {
          baseUrl: modelSettings.baseUrl || '',
          apiKey: modelSettings.apiKey || '',
          textModel: modelSettings.textModel || '',
          headers: buildLlmHeadersFromConfig(modelSettings),
          authMode: String(modelSettings.authMode || '').trim()
        }
      })
      .catch((e) => {
        this.log('rust core configure: ' + (e && e.message ? e.message : String(e)));
      })
      .finally(() => {
        this._rustCoreConfigureInFlight = null;
      });
    return this._rustCoreConfigureInFlight;
  }

  async syncRemoteIndexCoreConfig() {
    const fn = this.handlers && this.handlers['index.remote_sync_configure'];
    if (!fn) return { ok: false, reason: 'handlers_missing' };
    try {
      return await fn({});
    } catch (e) {
      this.log('remote index configure: ' + (e && e.message ? e.message : String(e)));
      return { ok: false, error: e.message || String(e) };
    }
  }

  getRustCore() {
    return this.rustCore;
  }

  _ensureToken() {
    try {
      if (fs.existsSync(this.tokenPath)) {
        this.token = fs.readFileSync(this.tokenPath, 'utf8').trim();
      }
      if (!this.token) {
        this.token = crypto.randomBytes(24).toString('hex');
        fs.writeFileSync(this.tokenPath, this.token, 'utf8');
      }
    } catch (e) {
      this.log('gateway token error: ' + (e && e.message));
      this.token = crypto.randomBytes(12).toString('hex');
    }
  }

  _loadWorkspaceFromDisk() {
    try {
      if (fs.existsSync(this.workspacePathFile)) {
        const raw = JSON.parse(fs.readFileSync(this.workspacePathFile, 'utf8'));
        const target = targetFromDisk(raw);
        // 全局工作空间目录可能已被系统外删除；不校验的话每次启动都会复活死路径
        // （index-watch watching/stopped，composer 徽标跟着显示死路径）。
        // 只校验本地目录；SSH target 交给既有重连逻辑（远端可能只是暂时离线）。
        if (target && target.kind === 'local' && !fs.existsSync(target.path)) {
          this.log(`全局工作空间目录已不存在，重置为默认: ${target.path}`);
          this.workspaceTarget = null;
          this.workspaceRoot = null;
          this._persistWorkspaceTarget();
          return;
        }
        this.workspaceTarget = target;
        this.workspaceRoot =
          this.workspaceTarget && this.workspaceTarget.kind === 'local' ? this.workspaceTarget.path : null;
      }
    } catch {
      // ignore
    }
  }

  _persistWorkspaceTarget() {
    if (!this.workspaceTarget) {
      try {
        if (fs.existsSync(this.workspacePathFile)) fs.unlinkSync(this.workspacePathFile);
      } catch {
        // ignore
      }
      return;
    }
    fs.mkdirSync(path.dirname(this.workspacePathFile), { recursive: true });
    fs.writeFileSync(this.workspacePathFile, JSON.stringify(targetToDisk(this.workspaceTarget), null, 2), 'utf8');
  }

  _sshConnectedForTarget(target = this.getEffectiveWorkspaceTarget()) {
    if (!target || target.kind !== 'ssh') return false;
    if (this.sshPool) {
      if (this.sshPool.isConnected(target)) return true;
      // 池按 host+remotePath 分槽；同主机已连通但目录不同时仍应视为已连接
      if (typeof this.sshPool.findConnectedEndpoint === 'function') {
        const ep = this.sshPool.findConnectedEndpoint(target);
        return !!(ep && isSameSshTarget(target, { kind: 'ssh', ...ep }));
      }
      return false;
    }
    if (!this.ssh || !this.ssh.status) return false;
    const st = this.ssh.status();
    return st.connected && isSameSshTarget(target, st);
  }


  _disconnectOtherRemoteKinds(activeKind) {
    const guard = this._remoteDisconnectGuard;
    if (activeKind !== 'ssh' && this.ssh) {
      if (!guard || !guard('ssh')) this.ssh.disconnect();
    }
  }

  _collectReadRoots() {
    // 「完全放开路径限制」（设置页开关，默认关）：本机所有卷根直接放行，不再拼白名单
    if (this.permissions && this.permissions.unrestrictedPaths === true) {
      return uniqueResolvedRoots(localVolumeRoots());
    }
    const roots = [
      this.readableDir,
      this.userDataPath,
      dieyunHome(),
      dieyunSkillsDir(),
      // 默认 workspace（~/.dieyun/workspace）恒定在读写白名单里：它是「随时能落脚」的
      // 兜底目录。绑定其它工作空间后仍要保留——否则工作空间不可写 / 远程未连通 /
      // 用户没选工作空间时，Agent 连一个能落盘的地方都没有。
      dieyunDefaultWorkspaceDir(),
      // 宽松档：用户主目录 + 系统临时目录。本机 Agent 默认已授 shell 执行，
      // 这两个根让「工作空间之外的日常动作」不必先报 PATH_NOT_ALLOWED。
      dieyunUserHome(),
      systemTempDir(),
      ...this.extraReadRoots
    ];
    const effRoot = this._effectiveWorkspaceRoot();
    if (effRoot) roots.push(effRoot);
    else if (!this.activeSessionId && this.workspaceRoot) roots.push(this.workspaceRoot);
    // 并行本地任务：所有已绑定本地会话工作区都进白名单，避免后台任务 cwd/索引被拒或串到当前视图
    for (const t of this.sessionWorkspaceTargets.values()) {
      if (t && t.kind === 'local' && t.path) roots.push(t.path);
    }
    // 工作区可能已被删除/重命名；不存在的目录必须剔除，否则 Rust configure 因 canonicalize 失败而整体不生效
    return uniqueResolvedRoots(roots).filter((r) => this._keepExistingReadRoot(r));
  }

  _keepExistingReadRoot(root) {
    let exists = false;
    try {
      exists = fs.existsSync(root);
    } catch {
      exists = false;
    }
    if (exists) return true;
    if (!this._missingReadRoots) this._missingReadRoots = new Set();
    const key = process.platform === 'win32' ? String(root).toLowerCase() : String(root);
    if (!this._missingReadRoots.has(key)) {
      this._missingReadRoots.add(key);
      this.log(`工作区目录不存在，已跳过: ${root}（可在界面重新选择工作区）`);
    }
    return false;
  }

  /**
   * 各档位的可写根：**唯一组装点**。
   *
   * 同一个路径有两条判定链 —— `assertSandboxWritable` / `permissions.sandbox_state`
   * （用 `_collectWritableRoots()`）与 handler 里的 `decideFsWrite/decideShellCommand`
   * （用 `sandboxContext()` 的 internalRoots / workspaceRoots）。两条链各拼一份清单就会打架：
   * 临时目录曾只出现在前者，于是同一份 `%TEMP%` 下的写在文件工具里放行、在 shell 里弹窗。
   * 现在档位语义只写一次，两条链都从这里取：
   * - danger-full-access：整盘（历史 unrestrictedPaths 语义）
   * - workspace-write：内部目录 + 临时目录 + 工作区
   * - read-only：只有内部目录（工作区与临时目录的写都要问 —— 临时目录里的项目不该整片免问）
   */
  writableRootsForMode() {
    const mode = this.getSandboxMode();
    if (mode === 'danger-full-access') return { internal: localVolumeRoots(), workspace: [] };
    const internal = this._internalWriteRoots();
    if (mode === 'workspace-write') {
      return { internal: [...internal, systemTempDir()], workspace: this._workspaceWriteRoots() };
    }
    return { internal, workspace: [] };
  }

  _collectWritableRoots() {
    const { internal, workspace } = this.writableRootsForMode();
    return uniqueResolvedRoots([...internal, ...workspace]);
  }

  /**
   * 本机内部目录：DB / 日志 / 撤销栈 / 技能 / 记忆 / 全局说明。任何档位都可写。
   *
   * 这里**不能**放 `~/.dieyun` 这个父目录：它包着 `~/.dieyun/workspace`（默认工作区），
   * 放行父目录等于给 read-only 开后门 —— 默认工作区里的写会整片绕过档位判定
   * （实测：read-only 下 `fs.write_file` 写 `~/.dieyun/workspace/x` 0 次询问成功）。
   * 需要写的子目录逐个列出即可，这也让「可写范围」在代码里是可读的清单。
   */
  _internalWriteRoots() {
    return [
      this.userDataPath,
      this.readableDir,
      dieyunSkillsDir(),
      dieyunMemoryDir(),
      dieyunMdPath()
    ];
  }

  /** 当前生效的工作区写根（含并行会话各自的工作区 + 默认工作区）。 */
  _workspaceWriteRoots() {
    const roots = [];
    const effRoot = this._effectiveWorkspaceRoot();
    if (effRoot) roots.push(effRoot);
    else if (!this.activeSessionId && this.workspaceRoot) roots.push(this.workspaceRoot);
    // 默认工作区（~/.dieyun/workspace）按"工作区"算，不再按"内部目录"算 ——
    // 它受档位管，read-only 才有意义（否则「只看不改」在最常见的首次使用场景里是空的）。
    roots.push(dieyunDefaultWorkspaceDir());
    for (const t of this.sessionWorkspaceTargets.values()) {
      if (t && t.kind === 'local' && t.path) roots.push(t.path);
    }
    return roots;
  }

  getSandboxMode() {
    return normalizeSandboxMode(this.permissions && this.permissions.sandboxMode);
  }

  /** 沙箱判定上下文（窗口/工具层共用一份，避免各处自己拼 roots）。 */
  sandboxContext(opts = {}) {
    // 工作区根始终给（相对路径的基准、审批记忆里的目录都靠它），
    // 是否「可写」由 mode 决定，见 `writableRootsForMode()`。
    const { internal } = this.writableRootsForMode();
    return {
      mode: this.getSandboxMode(),
      workspaceRoots: this._workspaceWriteRoots(),
      internalRoots: internal,
      cwd: opts.cwd
    };
  }

  /** 越界判定 + 一次批准的唯一入口（host.exec / fs 写操作都走这里）。 */
  async sandboxGuard(decision, opts = {}) {
    if (!decision || decision.action === 'allow') return null;
    const tool = opts.tool || '';
    if (decision.action === 'deny') {
      this.log(
        `SANDBOX_DENY tool=${tool} mode=${decision.mode} detail=${String(decision.detail || '').slice(0, 160)}`
      );
      return sandboxErrorFor(decision);
    }
    const result = await this.sandboxApprovals.ask(decision, {
      sessionId: opts.sessionId || this.activeSessionId || '',
      tool,
      /** 批准后把这个目录并入写白名单（否则旧 whitelist 会挡下刚被批准的写） */
      path: opts.path || ''
    });
    if (!result.granted) {
      this.log(
        `SANDBOX_DECLINED tool=${tool} mode=${decision.mode} category=${decision.category} reason=${result.reason}` +
          `${result.noChannel ? ' noChannel=1' : ''}${result.expired ? ' expired=1' : ''}`
      );
      return sandboxErrorFor(decision, {
        declined: !result.noChannel && !result.expired,
        noChannel: result.noChannel === true,
        expired: result.expired === true
      });
    }
    this.log(`SANDBOX_APPROVED tool=${tool} mode=${decision.mode} category=${decision.category}`);
    return null;
  }

  _defaultCwd() {
    const target = this.getEffectiveWorkspaceTarget();
    if (target?.kind === 'ssh') return target.remotePath;
    const effRoot = this._effectiveWorkspaceRoot();
    if (effRoot) return effRoot;
    if (this.activeSessionId) return dieyunDefaultWorkspaceDir();
    return this.workspaceRoot || dieyunDefaultWorkspaceDir();
  }

  _collectDiagnosticsWatchTargets() {
    /** @type {Map<string, { watchKey: string, root: string, mode: 'local'|'ssh', target?: object }>} */
    const rows = new Map();

    const addLocal = (localPath) => {
      if (!localPath) return;
      const root = path.resolve(localPath);
      const watchKey = `local:${root.toLowerCase()}`;
      rows.set(watchKey, { watchKey, root, mode: 'local' });
    };

    const addSsh = (target) => {
      if (!target || target.kind !== 'ssh' || !this._sshConnectedForTarget(target)) return;
      const remoteRoot = target.remotePath;
      const watchKey = `ssh:${target.username}@${target.host}:${Number(target.port) || 22}:${String(remoteRoot).replace(/\\/g, '/').replace(/\/$/, '').toLowerCase()}`;
      rows.set(watchKey, { watchKey, root: remoteRoot, mode: 'ssh', target });
    };

    const active = this.getEffectiveWorkspaceTarget();
    if (active?.kind === 'local') addLocal(this._effectiveWorkspaceRoot());
    else if (active?.kind === 'ssh') addSsh(active);

    for (const sid of this.getLeasedSessionIds()) {
      const t = this.getSessionWorkspaceTarget(sid);
      if (!t) continue;
      if (t.kind === 'local') addLocal(t.path);
      else if (t.kind === 'ssh') addSsh(t);
    }

    return rows;
  }

  _syncWorkspaceDiagnosticsWatch() {
    if (!this.lspDiagnostics) return;
    const desired = this._collectDiagnosticsWatchTargets();
    const desiredKeys = new Set(desired.keys());
    const prev = Array.isArray(this._activeWatchRoots) ? this._activeWatchRoots : [];

    for (const row of prev) {
      if (!desiredKeys.has(row.watchKey) && typeof this.lspDiagnostics.stopWorkspaceDiagnosticsWatch === 'function') {
        this.lspDiagnostics.stopWorkspaceDiagnosticsWatch(row.root);
      }
    }

    /** @type {Array<{ watchKey: string, root: string }>} */
    const activeWatchRoots = [];
    for (const row of desired.values()) {
      if (row.mode === 'ssh') {
        const manager = row.target ? this.getSshManagerForTarget(row.target) : null;
        const sshExec = manager && typeof manager.exec === 'function' ? manager.exec.bind(manager) : this.ssh?.exec?.bind(this.ssh);
        if (!sshExec) continue;
        if (typeof this.lspDiagnostics.startWorkspaceDiagnosticsWatch === 'function') {
          this.lspDiagnostics.startWorkspaceDiagnosticsWatch(row.root, {
            mode: 'ssh',
            sshExec: (command, cwd, timeoutMs) => sshExec(command, cwd, timeoutMs)
          });
        }
      } else if (typeof this.lspDiagnostics.startWorkspaceDiagnosticsWatch === 'function') {
        this.lspDiagnostics.startWorkspaceDiagnosticsWatch(row.root);
      }
      activeWatchRoots.push({ watchKey: row.watchKey, root: row.root });
    }
    this._activeWatchRoots = activeWatchRoots;
  }

  _broadcastDiagnosticsStoreUpdated(workspaceRoot) {
    if (!this.wsClients.size) return;
    const payload = {
      v: 1,
      type: 'event',
      event: 'diagnostics.store_updated',
      data: {
        workspaceRoot: workspaceRoot ? path.resolve(String(workspaceRoot)) : null,
        projectScan:
          this.lspDiagnostics && typeof this.lspDiagnostics.getProjectScanStatus === 'function'
            ? this.lspDiagnostics.getProjectScanStatus(workspaceRoot)
            : null
      }
    };
    for (const ws of this.wsClients) {
      this._send(ws, payload);
    }
  }

  broadcastEvent(event, data) {
    if (!this.wsClients.size) return;
    const payload = { v: 1, type: 'event', event, data: data || {} };
    for (const ws of this.wsClients) {
      this._send(ws, payload);
    }
  }

  getEffectiveWorkspaceTarget() {
    if (this.activeSessionId) {
      return this.sessionWorkspaceTargets.get(this.activeSessionId) || null;
    }
    return this.workspaceTarget;
  }

  getSessionWorkspaceTarget(sessionId) {
    const sid = String(sessionId || '').trim();
    if (!sid) return null;
    return this.sessionWorkspaceTargets.get(sid) || null;
  }

  getSessionWorkspacePath(sessionId) {
    return workspacePathForSession(this.getSessionWorkspaceTarget(sessionId));
  }

  async hydrateSessionWorkspaceContext(sessionId) {
    const sid = String(sessionId || '').trim();
    if (!sid || this.sessionWorkspaceTargets.has(sid)) return;
    if (!this.handlers) this._refreshHandlers();
    const fn = this.handlers && this.handlers['memory.session_get'];
    if (!fn) return;
    try {
      const row = await fn({ sessionId: sid });
      if (row && row.workspacePath) {
        this.setSessionWorkspaceContext(sid, row.workspacePath);
      }
    } catch {
      // ignore
    }
  }

  _effectiveWorkspaceRoot() {
    const t = this.getEffectiveWorkspaceTarget();
    if (t && t.kind === 'local') return t.path;
    return null;
  }

  /** 索引监听只跟随「当前生效的本地工作区」；远程工作区由远程 agent 侧负责 */
  _syncWorkspaceIndexWatch() {
    if (!this.indexWatcher) return;
    const root = this._effectiveWorkspaceRoot();
    if (!root) {
      this.indexWatcher.stop();
      return;
    }
    this.indexWatcher.start(root);
  }

  /**
   * 会话工作区目标的唯一写入口。
   *
   * 会话已经落在自己的 worktree 上之后，把仓库根再写回来不该把它抹掉：渲染端缓存里
   * 可能还是用户选的仓库路径，抹掉就会出现「agent 在 worktree、RPC 却查仓库」的错位。
   * 只有同一个仓库的「worktree → 仓库根」这一种写回被忽略，其它改动照常生效。
   */
  _storeSessionWorkspaceTarget(sid, target) {
    const prev = this.sessionWorkspaceTargets.get(sid);
    if (prev && prev.kind === 'ssh' && target && target.kind === 'ssh') {
      const prevPath = normalizeRemotePath(prev.remotePath);
      const nextPath = normalizeRemotePath(target.remotePath);
      const prevRepo = repoRemotePathOf(prevPath);
      const prevIsWorktree = prevRepo !== prevPath;
      const nextIsRepoRoot = repoRemotePathOf(nextPath) === nextPath;
      if (prevIsWorktree && nextIsRepoRoot && prevRepo === nextPath) return;
    }
    this.sessionWorkspaceTargets.set(sid, { ...target });
  }

  setSessionWorkspaceContext(sessionId, workspacePath) {
    const sid = String(sessionId || '').trim();
    if (!sid) return;
    if (!workspacePath) {
      this.sessionWorkspaceTargets.delete(sid);
    } else {
      const target = parseWorkspaceInput(workspacePath);
      if (target) this._storeSessionWorkspaceTarget(sid, target);
      else this.sessionWorkspaceTargets.delete(sid);
    }
    // 任意会话绑定本地工作区都刷新白名单，保证并行后台任务可用
    this._refreshHandlers();
    if (sid === this.activeSessionId) {
      this._syncWorkspaceDiagnosticsWatch();
      this._syncWorkspaceIndexWatch();
    }
  }

  setActiveSession(sessionId) {
    const sid = sessionId ? String(sessionId).trim() : null;
    const prev = this.activeSessionId;
    this.activeSessionId = sid || null;
    // 换会话 = 换任务：上一个会话的「越界已批准」不该延续到新任务
    if (prev && prev !== this.activeSessionId) this.sandboxApprovals.clearSession(prev);
    this._refreshHandlers();
    this._syncWorkspaceDiagnosticsWatch();
    this._syncWorkspaceIndexWatch();
    const eff = this.getEffectiveWorkspaceTarget();
    if (eff?.kind === 'local' && this._effectiveWorkspaceRoot()) {
      this.graphIncremental?.notifyWorkspaceOpened();
      this.codebaseIncremental?.notifyWorkspaceOpened();
    }
    return this.getWorkspace();
  }

  _mirrorGlobalWorkspaceToActiveSession() {
    if (!this.activeSessionId) return;
    if (!this.workspaceTarget) {
      this.sessionWorkspaceTargets.delete(this.activeSessionId);
      return;
    }
    this._storeSessionWorkspaceTarget(this.activeSessionId, this.workspaceTarget);
  }

  /**
   * 会话作用域的视图目标：该会话已绑定的目标优先，未绑定时跟随当前视图。
   * 终端这类「随会话走的视图」必须走这个入口，否则会话尚未绑工作区时会拿到视图之外的
   * 类型 —— 表现就是 SSH 工作区里开出本机 shell。
   */
  getWorkspaceTarget(sessionId) {
    const sid = String(sessionId || '').trim();
    if (sid) return this.sessionWorkspaceTargets.get(sid) || this.getEffectiveWorkspaceTarget();
    return this.getEffectiveWorkspaceTarget();
  }

  _refreshHandlers() {
    const rpcBundle = createRpcHandlers({
      allowedReadRoots: this._collectReadRoots(),
      writableRoots: this._collectWritableRoots(),
      permissions: this.permissions,
      /**
       * 会话工作空间绑定的不变式：**写会话行 = 同时更新进程内上下文**。
       * 放在这里（而不是各调用方）是因为 `memory.session_workspace_set` 是会话行的唯一写入口：
       * 只写库的话，下一次 hydrate 之前 Gateway 处理 RPC（工具/索引/读写）仍按旧上下文解析路径。
       */
      setSessionWorkspaceContext: (sessionId, workspacePath) =>
        this.setSessionWorkspaceContext(sessionId, workspacePath),
      /** 沙箱判定的唯一注入面：mode + roots + 审批。handler 不再自己拼白名单。 */
      sandbox: {
        context: (opts) => this.sandboxContext(opts),
        guard: (decision, opts) => this.sandboxGuard(decision, opts),
        approvals: this.sandboxApprovals,
        /** 本会话已被批准写的目录：并入 `writeRootsForCall()`，保证「批准了就能写」 */
        grantedWriteRoots: (sessionId) => this.sandboxApprovals.grantedPathsFor(sessionId),
        /** 实时可写白名单（档位决定），供 `permissions.sandbox_state` 如实回报 */
        writableRoots: () => this._collectWritableRoots()
      },
      defaultCwd: this._defaultCwd(),
      getEmbeddingConfig: () => getEmbeddingConfig(loadModelSettings(this.userDataPath)),
      browser: this.browser,
      computer: this.computer,
      ssh: this.ssh,
      portForwardManager: this.portForwardManager,
      getWorkspaceTarget: () => this.getWorkspaceTarget(),
      getSessionWorkspaceTarget: (sessionId) => this.getSessionWorkspaceTarget(sessionId),
      getSshManagerForTarget: (target) => this.getSshManagerForTarget(target),
      isSshTargetConnected: (target) => this._sshConnectedForTarget(target),
      isSshWorkspaceConnected: () => this._sshConnectedForTarget(),
      getRemoteAgentInfo: (sessionId) => this.getRemoteAgentInfo(sessionId),
      healRemoteAgentTransport: this.healRemoteAgentTransport
        ? (opts) => this.healRemoteAgentTransport(opts)
        : null,
      turnUndo: this.turnUndo,
      userDataPath: this.userDataPath,
      rustCore: this.rustCore,
      lspDiagnostics: this.lspDiagnostics,
      graphIncremental: this.graphIncremental,
      codebaseIncremental: this.codebaseIncremental
    });
    this.handlers = rpcBundle.handlers;
    this._runWithWorkspaceRoot = rpcBundle.runWithWorkspaceRoot;
    this._runWithCallContext = rpcBundle.runWithCallContext;
    void this._syncRustCoreConfig();
  }

  getPermissions() {
    return { ...this.permissions };
  }

  setPermissions(next) {
    // 归一在 store 里做（`unrestrictedPaths` ⇄ `sandboxMode`）。这里必须先剔掉**已存储的派生值**：
    // 否则「完全放开」时落盘的 `unrestrictedPaths: true` 会在下次只改档位时被当成用户新指令，
    // 把档位又顶回完全放开（表现为「切了档位没生效」）。
    const incoming = next && typeof next === 'object' ? next : {};
    const merged = { ...stripDerivedPermissions(this.permissions), ...incoming };
    const before = this.getSandboxMode();
    this.permissions = savePermissions(
      this.permissionsPath,
      // `unrestrictedPaths: true` 是明确的用户动作，优先于档位；否则按档位归一。
      incoming.unrestrictedPaths === true ? merged : withSandboxMode(merged, incoming.sandboxMode)
    );
    // 档位收紧（含切到 read-only）时作废已有批准：否则"我刚切到只读"之后旧批准照样放行，
    // 用户看到的是一个不生效的安全开关。
    const after = this.getSandboxMode();
    if (SANDBOX_MODES.indexOf(after) < SANDBOX_MODES.indexOf(before)) {
      this.sandboxApprovals.clearAll();
      this.log(`SANDBOX_GRANTS_CLEARED ${before} -> ${after}`);
    }
    this._refreshHandlers();
    return this.getPermissions();
  }

  /** 沙箱状态（设置页 / 状态图标 / 排查用）。 */
  getSandboxState() {
    const mode = this.getSandboxMode();
    return {
      mode,
      meta: SANDBOX_MODE_META[mode],
      writableRoots: this._collectWritableRoots(),
      grants: this.sandboxApprovals.snapshot()
    };
  }

  /**
   * Main 注入审批通道（能弹窗的那个窗口稍后才就绪）。
   * 没注入时 `sandboxApprovals` 走 fail-closed：越界一律拒，不会静默放行。
   */
  setSandboxApprovalChannel(fn) {
    this.sandboxApprovals.setRequest(fn);
  }

  /** @param {string} [sessionId] 传入会话 id 时返回该会话的工作区视图（终端等随会话走的视图用） */
  getWorkspace(sessionId) {
    return this._workspaceView(this.getWorkspaceTarget(sessionId));
  }

  /** 工作区视图的唯一成形处：getWorkspace 的两个入口都走这里 */
  _workspaceView(target) {
    const sshConnected = this._sshConnectedForTarget(target);
    const connected = target?.kind === 'ssh' ? sshConnected : false;
    // 会话副本（worktree）是「写到哪儿」，不是「在哪个项目」。显示用项目路径，
    // 否则同一项目的每个会话都显示成 …/.dieyun/worktrees/sess-xxx/main。
    // 功能路径（workspacePath / ssh.remotePath）保持副本原值，别让显示污染路由。
    const displayTarget = target
      ? target.kind === 'ssh'
        ? { ...target, remotePath: stripWorktreeSuffix(normalizeRemotePath(target.remotePath)) }
        : { ...target, path: stripWorktreeSuffix(target.path) }
      : target;
    const displayPath = formatWorkspaceDisplay(displayTarget, { connected });
    const workspacePath = workspacePathForSession(target);
    if (!target) {
      return {
        kind: 'local',
        workspacePath: null,
        displayPath: '',
        sshConnected: false,
        activeSessionId: this.activeSessionId
      };
    }
    if (target.kind === 'ssh') {
      return {
        kind: 'ssh',
        workspacePath,
        displayPath,
        sshConnected,
        activeSessionId: this.activeSessionId,
        ssh: {
          host: target.host,
          port: target.port,
          username: target.username,
          remotePath: target.remotePath
        }
      };
    }
    return {
      kind: 'local',
      workspacePath: target.path,
      displayPath: displayPath || target.path,
      sshConnected: false,
      activeSessionId: this.activeSessionId
    };
  }

  setWorkspace(workspacePath) {
    if (!workspacePath) {
      this._dropPortForwardsForWorkspaceChange(null);
      this.workspaceTarget = null;
      this.workspaceRoot = null;
      this._persistWorkspaceTarget();
      this._refreshHandlers();
      this._syncWorkspaceDiagnosticsWatch();
      this._syncWorkspaceIndexWatch();
      return this.getWorkspace();
    }
    const target = parseWorkspaceInput(workspacePath);
    this._dropPortForwardsForWorkspaceChange(target);
    if (!target) {
      this.workspaceTarget = null;
      this.workspaceRoot = null;
    } else if (target.kind === 'local') {
      this._disconnectOtherRemoteKinds('local');
      this.workspaceTarget = target;
      this.workspaceRoot = target.path;
    } else {
      this._disconnectOtherRemoteKinds('ssh');
      const st = this.ssh?.status();
      this.workspaceTarget =
        st?.connected && isSameSshTarget(target, st)
          ? {
              kind: 'ssh',
              host: st.host,
              port: st.port,
              username: st.username,
              remotePath: target.remotePath
            }
          : target;
      this.workspaceRoot = null;
    }
    this._persistWorkspaceTarget();
    this._mirrorGlobalWorkspaceToActiveSession();
    this._refreshHandlers();
    if (this.workspaceTarget?.kind === 'local' && this.workspaceRoot) {
      this.graphIncremental?.notifyWorkspaceOpened();
      this.codebaseIncremental?.notifyWorkspaceOpened();
    }
    this._syncWorkspaceDiagnosticsWatch();
    this._syncWorkspaceIndexWatch();
    return this.getWorkspace();
  }

  setLocalWorkspace(localPath) {
    this._disconnectOtherRemoteKinds('local');
    if (!localPath) return this.setWorkspace(null);
    return this.setWorkspace(localPath);
  }

  setSshWorkspace(remotePath) {
    const { normalizeRemotePath } = require('../workspace/target');
    const rp = normalizeRemotePath(remotePath || '/');
    let endpoint = null;
    const current = this.workspaceTarget?.kind === 'ssh' ? this.workspaceTarget : null;
    if (current && this._sshConnectedForTarget(current)) {
      endpoint = {
        host: current.host,
        port: current.port,
        username: current.username
      };
    } else if (this.sshPool && typeof this.sshPool.findConnectedEndpoint === 'function') {
      const last =
        typeof this.sshPool.getLastConnectedManager === 'function'
          ? this.sshPool.getLastConnectedManager()
          : null;
      const st = last && last.status && last.status();
      endpoint =
        st && st.connected
          ? { host: st.host, port: st.port, username: st.username }
          : this.sshPool.findConnectedEndpoint();
    } else if (this.ssh && typeof this.ssh.status === 'function') {
      const st = this.ssh.status();
      if (st?.connected) {
        endpoint = { host: st.host, port: st.port, username: st.username };
      }
    }
    if (!endpoint || !endpoint.host || !endpoint.username) {
      const err = new Error('SSH 未连接');
      err.code = 'SSH_NOT_CONNECTED';
      throw err;
    }
    const nextTarget = {
      kind: 'ssh',
      host: endpoint.host,
      port: Number(endpoint.port) || 22,
      username: endpoint.username,
      remotePath: rp
    };
    this._dropPortForwardsForWorkspaceChange(nextTarget);
    this.workspaceTarget = nextTarget;
    this.workspaceRoot = null;
    this._persistWorkspaceTarget();
    this._mirrorGlobalWorkspaceToActiveSession();
    this._refreshHandlers();
    this._syncWorkspaceDiagnosticsWatch();
    this._syncWorkspaceIndexWatch();
    return this.getWorkspace();
  }


  getInfo() {
    return {
      host: '127.0.0.1',
      port: this.port,
      url: `ws://127.0.0.1:${this.port}`,
      token: this.token,
      listening: !!this.wss,
      permissions: this.getPermissions(),
      workspace: this.getWorkspace()
    };
  }

  start() {
    if (this.wss) return;

    fs.mkdirSync(this.readableDir, { recursive: true });
    this._ensureToken();

    this._loadWorkspaceFromDisk();
    this._refreshHandlers();
    this._syncWorkspaceDiagnosticsWatch();
    this._syncWorkspaceIndexWatch();

    this.wss = new WebSocketServer({ host: '127.0.0.1', port: this.port });

    this.wss.on('connection', (ws) => {
      // 底层 socket 异常会 emit 'error'；无监听将变成 uncaught exception，故兜底记录
      ws.on('error', (err) => {
        this.log('gateway client ws error: ' + (err && err.message ? err.message : err));
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
            this.wsClients.add(ws);
            this._send(ws, { v: 1, type: 'auth_ok', id });
          } else {
            this._send(ws, {
              v: 1,
              type: 'error',
              id,
              error: { code: 'AUTH_FAILED', message: 'invalid token' }
            });
            ws.close(4003, 'auth failed');
          }
          return;
        }

        if (!authed) {
          this._send(ws, {
            v: 1,
            type: 'error',
            id,
            error: { code: 'NOT_AUTHED', message: 'send auth first' }
          });
          return;
        }

        if (msg.type !== 'call') {
          this._send(ws, {
            v: 1,
            type: 'error',
            id,
            error: { code: 'UNKNOWN_TYPE', message: String(msg.type) }
          });
          return;
        }

        const method = msg.method;
        const params = msg.params && typeof msg.params === 'object' ? msg.params : {};
        if (!this.handlers) {
          this._send(ws, {
            v: 1,
            type: 'result',
            id,
            ok: false,
            error: { code: 'GATEWAY_STOPPING', message: 'Gateway 正在关闭' }
          });
          return;
        }
        const fn = this.handlers[method];
        if (!fn) {
          this._send(ws, {
            v: 1,
            type: 'result',
            id,
            ok: false,
            error: { code: 'UNKNOWN_METHOD', message: method }
          });
          return;
        }

        const runWorkspaceRoot =
          params && params.runWorkspaceRoot ? String(params.runWorkspaceRoot) : null;
        const callSessionId = params && params.sessionId ? String(params.sessionId) : null;

        const runCall = async () => {
          if (callSessionId) await this.hydrateSessionWorkspaceContext(callSessionId);
          try {
            const result = await fn(params);
            this._send(ws, { v: 1, type: 'result', id, ok: true, data: result });
          } catch (err) {
            this._send(ws, {
              v: 1,
              type: 'result',
              id,
              ok: false,
              error: {
                code: err.code || 'EXEC_ERROR',
                message: err.message || String(err),
                // retryable / suggestedFix 是工具失败契约的一半（tool-harness 直接读它们），
                // 跨 WebSocket 传的时候不许只剩一条 message。
                ...(typeof err.retryable === 'boolean' ? { retryable: err.retryable } : {}),
                ...(err.suggestedFix ? { suggestedFix: String(err.suggestedFix) } : {})
              }
            });
          }
        };

        if (this._runWithCallContext) {
          await this._runWithCallContext({ runWorkspaceRoot, sessionId: callSessionId }, runCall);
        } else if (this._runWithWorkspaceRoot) {
          await this._runWithWorkspaceRoot(runWorkspaceRoot, runCall);
        } else {
          await runCall();
        }
        return;
      });

      ws.on('close', () => {
        clearTimeout(authTimer);
        this.wsClients.delete(ws);
      });
    });

    this.wss.on('error', (err) => {
      this.log('gateway wss error: ' + err.message);
      if (err && (err.code === 'EADDRINUSE' || err.code === 'EACCES')) {
        try {
          this.wss.close();
        } catch {
          // ignore
        }
        this.wss = null;
      }
    });

    this.log(`local gateway ws://127.0.0.1:${this.port} (loopback)`);
  }

  /**
   * @param {import('ws').WebSocket} ws
   * @param {object} obj
   */
  _send(ws, obj) {
    try {
      if (ws.readyState === 1) ws.send(JSON.stringify(obj));
    } catch {
      // ignore
    }
  }

  /**
   * 主进程内直接调用 RPC（无需 WebSocket）
   * @param {string} method
   * @param {object} [params]
   * @param {{ timeoutMs?: number }} [opts] 旁路写（快照 / 压缩归档）必须能设短超时，
   *   否则 DB 一慢就把等着发请求的主链路一起拖住
   */
  async invokeRpc(method, params = {}, opts = {}) {
    if (!this.handlers) this._refreshHandlers();
    const fn = this.handlers && this.handlers[method];
    if (!fn) {
      const err = new Error(`未知 RPC: ${method}`);
      err.code = 'UNKNOWN_METHOD';
      throw err;
    }
    const runWorkspaceRoot =
      params && params.runWorkspaceRoot ? String(params.runWorkspaceRoot) : null;
    const callSessionId = params && params.sessionId ? String(params.sessionId) : null;
    if (callSessionId) await this.hydrateSessionWorkspaceContext(callSessionId);
    const call = () => fn(params && typeof params === 'object' ? params : {});
    const run = () => {
      if (this._runWithCallContext) {
        return this._runWithCallContext({ runWorkspaceRoot, sessionId: callSessionId }, call);
      }
      if (this._runWithWorkspaceRoot) {
        return this._runWithWorkspaceRoot(runWorkspaceRoot, call);
      }
      return call();
    };
    const timeoutMs = Number(opts && opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : 0;
    if (!timeoutMs) return run();
    let timer = null;
    try {
      return await Promise.race([
        run(),
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            const e = new Error(`RPC 超时: ${method} (>${timeoutMs}ms)`);
            e.code = 'RPC_TIMEOUT';
            reject(e);
          }, timeoutMs);
          if (timer && typeof timer.unref === 'function') timer.unref();
        })
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  stop() {
    if (this.wss) {
      try {
        this.wss.close();
      } catch {
        // ignore
      }
      this.wss = null;
    }
    this.wsClients.clear();
    if (this.indexWatcher) this.indexWatcher.stop();
    this.handlers = null;
    if (this.lspDiagnostics) {
      void this.lspDiagnostics.shutdown();
    }
  }
}

module.exports = { LocalGateway };
