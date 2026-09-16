'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const { createRpcHandlers } = require('./rpc');
const { createTurnUndoService } = require('../undo/turn-undo-service');
const { createLspDiagnosticsService } = require('../lsp/diagnostics-service');
const { loadPermissions, savePermissions, DEFAULTS } = require('./permissions-store');
const { dieyunDefaultWorkspaceDir, dieyunHome, dieyunSkillsDir } = require('../agent-home');
const { PluginHost } = require('../plugins/host');
const { createDatabasePlugin } = require('../plugins/database');
const { getEmbeddingConfig, loadModelSettings } = require('../model-settings');
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
} = require('../workspace/target');

const DEFAULT_PORT = 17330;

/**
 * @typedef {object} GatewayOptions
 * @property {string} userDataPath app.getPath('userData')
 * @property {string} readableDir 只读文件白名单根之一
 * @property {string[]} [extraReadRoots] 开发态等额外根
 * @property {(msg: string) => void} [log]
 * @property {import('./permissions-store').DEFAULTS & object} [permissions]
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
    this.permissions = opts.permissions || loadPermissions(this.permissionsPath);

    this.port = Number(process.env.DIECLOUD_GATEWAY_PORT) || DEFAULT_PORT;
    this.tokenPath = path.join(this.userDataPath, 'gateway-token.txt');

    /** @type {import('ws').WebSocketServer | null} */
    this.wss = null;
    /** @type {Set<import('ws').WebSocket>} */
    this.wsClients = new Set();
    /** @type {ReturnType<createRpcHandlers> | null} */
    this.handlers = null;
    this.token = '';
    this.plugins = new PluginHost({
      userDataPath: this.userDataPath,
      log: this.log,
      appVersion: opts.appVersion || '0.0.0',
      appRoot: opts.appRoot || process.cwd()
    });
    this.plugins.register(createDatabasePlugin());
    this.plugins.loadUserPlugins();
    /** @type {import('../plugins/database/sqlserver').SqlServerService | null} */
    this.sql = null;
    /** @type {ReturnType<import('../browser/service').createBrowserService> | null} */
    this.browser = opts.browser || null;
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
      onStoreUpdated: (workspaceRoot) => this._broadcastDiagnosticsStoreUpdated(workspaceRoot)
    });
    this.graphIncremental = createGraphIncrementalScheduler({
      userDataPath: this.userDataPath,
      getWorkspaceRoot: () => this._effectiveWorkspaceRoot() || this.workspaceRoot,
      isRemoteWorkspace: () => {
        const t = this.getEffectiveWorkspaceTarget();
        return t?.kind === 'ssh';
      },
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
      isRemoteWorkspace: () => {
        const t = this.getEffectiveWorkspaceTarget();
        return t?.kind === 'ssh';
      },
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
      if (typeof this.sshPool.getConnectedManagerForEndpoint === 'function') {
        const m = this.sshPool.getConnectedManagerForEndpoint(target);
        if (m) return m;
      }
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
        models_dirs: this._collectModelsDirs(),
        embedding: {
          disabled: !!embedding.disabled,
          builtin: !!embedding.builtin,
          baseUrl: embedding.baseUrl || '',
          apiKey: embedding.apiKey || '',
          model: embedding.model || '',
          dimensions: Number(embedding.dimensions) || 1024
        },
        llm: {
          baseUrl: modelSettings.baseUrl || '',
          apiKey: modelSettings.apiKey || '',
          textModel: modelSettings.textModel || ''
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

  _collectModelsDirs() {
    const dirs = [];
    if (this.userDataPath) {
      dirs.push(path.join(this.userDataPath, '.dieyun', 'optional-assets'));
    }
    if (process.resourcesPath) {
      dirs.push(path.join(process.resourcesPath, 'models'));
    }
    try {
      const { app } = require('electron');
      if (app && typeof app.getAppPath === 'function') {
        dirs.push(path.join(app.getAppPath(), 'models'));
      }
    } catch {
      // ignore outside Electron
    }
    dirs.push(path.join(__dirname, '..', '..', 'models'));
    const seen = new Set();
    return dirs.filter((d) => {
      const key = path.resolve(d);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
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
        this.workspaceTarget = targetFromDisk(raw);
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
    const roots = [
      this.readableDir,
      this.userDataPath,
      dieyunHome(),
      dieyunSkillsDir(),
      ...this.extraReadRoots
    ];
    const effRoot = this._effectiveWorkspaceRoot();
    if (effRoot) roots.push(effRoot);
    else if (!this.activeSessionId && this.workspaceRoot) roots.push(this.workspaceRoot);
    else if (!this.activeSessionId) roots.push(dieyunDefaultWorkspaceDir());
    else roots.push(dieyunDefaultWorkspaceDir());
    // 并行本地任务：所有已绑定本地会话工作区都进白名单，避免后台任务 cwd/索引被拒或串到当前视图
    for (const t of this.sessionWorkspaceTargets.values()) {
      if (t && t.kind === 'local' && t.path) roots.push(t.path);
    }
    const seen = new Set();
    return roots
      .filter(Boolean)
      .map((r) => path.resolve(r))
      .filter((r) => {
        const key = process.platform === 'win32' ? r.toLowerCase() : r;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
  }

  _collectWritableRoots() {
    const roots = [this.readableDir, dieyunSkillsDir()];
    const effRoot = this._effectiveWorkspaceRoot();
    if (effRoot) roots.push(effRoot);
    else if (!this.activeSessionId && this.workspaceRoot) roots.push(this.workspaceRoot);
    else if (!this.activeSessionId) roots.push(dieyunDefaultWorkspaceDir());
    else roots.push(dieyunDefaultWorkspaceDir());
    for (const t of this.sessionWorkspaceTargets.values()) {
      if (t && t.kind === 'local' && t.path) roots.push(t.path);
    }
    const seen = new Set();
    return roots
      .filter(Boolean)
      .map((r) => path.resolve(r))
      .filter((r) => {
        const key = process.platform === 'win32' ? r.toLowerCase() : r;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
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

  setSessionWorkspaceContext(sessionId, workspacePath) {
    const sid = String(sessionId || '').trim();
    if (!sid) return;
    if (!workspacePath) {
      this.sessionWorkspaceTargets.delete(sid);
    } else {
      const target = parseWorkspaceInput(workspacePath);
      if (target) this.sessionWorkspaceTargets.set(sid, { ...target });
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
    this.activeSessionId = sid || null;
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
    this.sessionWorkspaceTargets.set(this.activeSessionId, { ...this.workspaceTarget });
  }

  getWorkspaceTarget() {
    return this.getEffectiveWorkspaceTarget();
  }

  _refreshHandlers() {
    const rpcBundle = createRpcHandlers({
      allowedReadRoots: this._collectReadRoots(),
      writableRoots: this._collectWritableRoots(),
      permissions: this.permissions,
      defaultCwd: this._defaultCwd(),
      sql: this.sql,
      plugins: this.plugins,
      getEmbeddingConfig: () => getEmbeddingConfig(loadModelSettings(this.userDataPath)),
      onPluginsChanged: () => {
        this.sql = this.plugins.getService('sql');
        this._refreshHandlers();
      },
      browser: this.browser,
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
    this.permissions = { ...DEFAULTS, ...next };
    savePermissions(this.permissionsPath, this.permissions);
    this._refreshHandlers();
    return this.getPermissions();
  }

  getWorkspace() {
    const target = this.getEffectiveWorkspaceTarget();
    const sshConnected = this._sshConnectedForTarget(target);
    const connected = target?.kind === 'ssh' ? sshConnected : false;
    const displayPath = formatWorkspaceDisplay(target, { connected });
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
      workspace: this.getWorkspace(),
      sql: this.sql ? this.sql.getStatus() : null,
      plugins: this.plugins.listPublic()
    };
  }

  async warmupSql() {
    if (!this.sql || !this.sql.config.enabled) return;
    try {
      await this.sql.testConnection();
    } catch {
      // 预热失败静默处理，不写入运行日志
    }
  }

  start() {
    if (this.wss) return;

    fs.mkdirSync(this.readableDir, { recursive: true });
    this._ensureToken();

    this.plugins.initAll();
    this.sql = this.plugins.getService('sql');
    this._loadWorkspaceFromDisk();
    this._refreshHandlers();
    this._syncWorkspaceDiagnosticsWatch();
    this.warmupSql().catch(() => {});

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
                message: err.message || String(err)
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
   */
  async invokeRpc(method, params = {}) {
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
    if (this._runWithCallContext) {
      return this._runWithCallContext(
        { runWorkspaceRoot, sessionId: callSessionId },
        call
      );
    }
    if (this._runWithWorkspaceRoot) {
      return this._runWithWorkspaceRoot(runWorkspaceRoot, call);
    }
    return call();
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
    if (this.plugins) this.plugins.disposeAll();
    this.sql = null;
    this.handlers = null;
    if (this.lspDiagnostics) {
      void this.lspDiagnostics.shutdown();
    }
  }
}

module.exports = { LocalGateway, DEFAULT_PORT };
