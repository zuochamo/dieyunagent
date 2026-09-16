'use strict';

const fs = require('fs/promises');
const fsSync = require('fs');
const path = require('path');
const {
  runShell,
  runShellDetached,
  openExternalUrl,
  normalizeFilePathInput,
  printImage
} = require('./host-control');
const webFetch = require('./web-fetch');
const { assertAllowedPath } = require('./path-policy');
const { validateShellCommand } = require('./exec-policy');
const { resolveBrowserNavigateUrl, parseRemotePreviewTarget } = require('../browser/url-policy');
const { createRemoteFsAdapter } = require('./remote-fs');
const { AsyncLocalStorage } = require('async_hooks');
const { buildSshUri, normalizeRemotePath, parseWorkspaceInput, isSameSshTarget, workspacePathForSession, sshTargetKey } = require('../workspace/target');
const { remoteAgentInfoKey, remoteIndexCacheKey } = require('../workspace/workspace-cache-keys');
const { normalizeReadParams, ABSOLUTE_READ_MAX_BYTES } = require('./fs-read-limits');
const { runEditFile } = require('./fs-edit-file');
const { grepWorkspace, globWorkspace } = require('./rg-search');
const { getRemoteAgentClient, setRemoteAgentInvalidateListener, isDisconnectError } = require('./remote-agent-client');
const { shellQuoteSingle } = require('../ssh/remote-path');
const { captureRemoteGitWorkingBaseline } = require('../git/remote-baseline-capture');
const { captureGitWorkingBaseline, mergeBaselineFilesInto } = require('../git/baseline-capture');
const { isGitRepo } = require('../git/worktree-service');
const { getWorkspaceGitDiffContext, getWorkspaceGitChangedAbsPaths } = require('../git/diff-context');
const { resolveHostSidecarLocalPath } = require('../agent/host-sidecar');

const { probeHostEnvironment } = require('./host-environment');
const { createPlaybookRpcHandlers } = require('../playbook/playbook-rpc');
const { createWikiRpcHandlers } = require('../wiki/wiki-rpc');
const { createExtractedHandlers } = require('./handlers');
const { projectMemoryScope } = require('./project-memory');
const { resolveCoreRpcTimeoutMs } = require('../core-rpc-timeouts');

function assertHostEnabled(ctx) {
  if (!ctx.permissions.hostControl) {
    const err = new Error('本机控制未启用');
    err.code = 'HOST_DISABLED';
    throw err;
  }
}

const DIFF_FULL_TEXT_CAP = 120000;

function summarizeLineDiff(beforeText, afterText) {
  const before = beforeText == null ? [] : String(beforeText).split(/\r?\n/);
  const after = String(afterText || '').split(/\r?\n/);
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) {
    start++;
  }
  let beforeEnd = before.length - 1;
  let afterEnd = after.length - 1;
  while (beforeEnd >= start && afterEnd >= start && before[beforeEnd] === after[afterEnd]) {
    beforeEnd--;
    afterEnd--;
  }
  const beforeSnippet = before.slice(Math.max(0, start), beforeEnd + 1).join('\n');
  const afterSnippet = after.slice(Math.max(0, start), afterEnd + 1).join('\n');
  const beforeFull = beforeText == null ? '' : String(beforeText);
  const afterFull = String(afterText || '');
  const includeFullText =
    beforeFull.length <= DIFF_FULL_TEXT_CAP && afterFull.length <= DIFF_FULL_TEXT_CAP;
  return {
    added: Math.max(0, afterEnd - start + 1),
    removed: Math.max(0, beforeEnd - start + 1),
    beforeLines: before.length,
    afterLines: after.length,
    created: beforeText == null,
    ...(includeFullText
      ? { beforeText: beforeFull, afterText: afterFull }
      : { textTruncated: true }),
    beforeSnippet,
    afterSnippet
  };
}

/**
 * @param {{
 *   allowedReadRoots: string[],
 *   writableRoots: string[],
 *   permissions: import('./permissions-store').DEFAULTS & object,
 *   defaultCwd?: string | null
 *   sql?: import('../plugins/database/sqlserver').SqlServerService | null
 *   plugins?: import('../plugins/host').PluginHost | null
 *   getEmbeddingConfig?: () => object
 *   onPluginsChanged?: Function
 *   browser?: import('../browser/service').createBrowserService extends (...args: any[]) => infer R ? R : never | null
 *   ssh?: ReturnType<import('../ssh/session-manager').createSshSessionManager> | null
 *   getWorkspaceTarget?: () => import('../workspace/target').WorkspaceTarget | null
 *   isSshWorkspaceConnected?: () => boolean
 *   getRemoteAgentInfo?: (sessionId?: string) => { url: string, token: string } | null
 *   turnUndo?: ReturnType<import('../undo/turn-undo-service').createTurnUndoService> | null
 *   userDataPath?: string
 *   rustCore?: ReturnType<import('../core-bridge').createCoreBridge> | null
 *   graphIncremental?: ReturnType<import('../graph/graph-incremental-scheduler').createGraphIncrementalScheduler> | null
 *   codebaseIncremental?: ReturnType<import('../index/codebase-incremental-scheduler').createCodebaseIncrementalScheduler> | null
 * }} ctx
 */
function createRpcHandlers(ctx) {
  const roots = ctx.allowedReadRoots.map((r) => path.resolve(r));
  const writable = ctx.writableRoots.map((r) => path.resolve(r));
  const perms = ctx.permissions;
  const defaultCwd = ctx.defaultCwd || null;
  const sqlSvc = ctx.sql || null;
  const plugins = ctx.plugins || null;
  const browser = ctx.browser || null;
  const ssh = ctx.ssh || null;
  const portForwardManager = ctx.portForwardManager || null;
  const turnUndo = ctx.turnUndo || null;
  const rustCore = ctx.rustCore || null;
  const lspDiagnostics = ctx.lspDiagnostics || null;
  const graphIncremental = ctx.graphIncremental || null;
  const codebaseIncremental = ctx.codebaseIncremental || null;

  const runWorkspaceAls = new AsyncLocalStorage();

  function getActiveRunWorkspaceRoot() {
    const store = runWorkspaceAls.getStore();
    if (store && store.runWorkspaceRoot) return store.runWorkspaceRoot;
    return null;
  }

  function getActiveCallSessionId() {
    const store = runWorkspaceAls.getStore();
    if (store && store.callSessionId) return store.callSessionId;
    return null;
  }

  async function runWithCallContext(callCtx, fn) {
    const runWorkspaceRoot =
      callCtx && callCtx.runWorkspaceRoot != null && String(callCtx.runWorkspaceRoot).trim()
        ? String(callCtx.runWorkspaceRoot).trim()
        : null;
    const callSessionId =
      callCtx && callCtx.sessionId != null && String(callCtx.sessionId).trim()
        ? String(callCtx.sessionId).trim()
        : null;
    return runWorkspaceAls.run({ runWorkspaceRoot, callSessionId }, fn);
  }

  async function runWithWorkspaceRoot(runWorkspaceRoot, fn) {
    return runWithCallContext({ runWorkspaceRoot }, fn);
  }

  function resolveCallWorkspaceTarget() {
    const activeRoot = getActiveRunWorkspaceRoot();
    if (activeRoot) {
      return parseWorkspaceInput(activeRoot);
    }
    const callSid = getActiveCallSessionId();
    if (callSid && typeof ctx.getSessionWorkspaceTarget === 'function') {
      const sessionTarget = ctx.getSessionWorkspaceTarget(callSid);
      if (sessionTarget) return sessionTarget;
      // 显式 sessionId 作用域：禁止回落到当前视图工作区（避免并行 SSH 串台）
      return null;
    }
    return typeof ctx.getWorkspaceTarget === 'function' ? ctx.getWorkspaceTarget() : null;
  }

  function resolveSshManager() {
    const target = resolveCallWorkspaceTarget();
    if (target && target.kind === 'ssh' && typeof ctx.getSshManagerForTarget === 'function') {
      const m = ctx.getSshManagerForTarget(target);
      if (m) return m;
    }
    return ssh;
  }

  function isSshConnectedForCall() {
    const target = resolveCallWorkspaceTarget();
    if (target && target.kind === 'ssh') {
      if (typeof ctx.isSshTargetConnected === 'function') {
        return ctx.isSshTargetConnected(target);
      }
      const m = resolveSshManager();
      return !!(m && typeof m.status === 'function' && m.status().connected);
    }
    return typeof ctx.isSshWorkspaceConnected === 'function' && ctx.isSshWorkspaceConnected();
  }

  function requireSshForCall() {
    const target = resolveCallWorkspaceTarget();
    if (!target || target.kind !== 'ssh') {
      const e = new Error('当前任务不是 SSH 工作空间');
      e.code = 'SSH_NOT_CONNECTED';
      throw e;
    }
    const manager = resolveSshManager();
    if (!manager || typeof manager.status !== 'function' || !manager.status().connected) {
      const e = new Error('SSH 未连接，请在工作空间菜单中重新连接远程主机');
      e.code = 'SSH_NOT_CONNECTED';
      throw e;
    }
    return manager;
  }

  function cwdForCall() {
    const target = resolveCallWorkspaceTarget();
    if (target && target.kind === 'local') return target.path;
    if (target && target.kind === 'ssh') return normalizeRemotePath(target.remotePath);
    return defaultCwd;
  }

  function extraLocalRunRoots() {
    const target = resolveCallWorkspaceTarget();
    if (target && target.kind === 'local' && target.path) {
      return [path.resolve(target.path)];
    }
    return [];
  }

  function readRootsForCall() {
    return Array.from(new Set([...roots, ...writable, ...extraLocalRunRoots()]));
  }

  function sidecarReadOpts() {
    return {
      workspacePath: workspacePathForSession(resolveCallWorkspaceTarget()) || '',
      userDataPath: ctx.userDataPath || ''
    };
  }

  async function readSidecarFileAt(absPath, encoding, readOpts = {}) {
    const enc = encoding === 'base64' ? null : encoding || 'utf8';
    const { offset, maxBytes } = normalizeReadParams(readOpts);
    const st = await fs.stat(absPath);
    const readLen = Math.min(maxBytes, Math.max(0, st.size - offset));
    if (readLen <= 0) {
      return {
        data: '',
        encoding: enc === null ? 'base64' : enc,
        path: absPath,
        size: st.size,
        offset,
        truncated: offset < st.size,
        sidecar: true
      };
    }
    const fh = await fs.open(absPath, 'r');
    try {
      const buf = Buffer.alloc(readLen);
      const { bytesRead } = await fh.read(buf, 0, readLen, offset);
      const slice = buf.subarray(0, bytesRead);
      if (enc === null) {
        return {
          data: slice.toString('base64'),
          encoding: 'base64',
          path: absPath,
          size: st.size,
          offset,
          truncated: offset + bytesRead < st.size,
          sidecar: true
        };
      }
      return {
        data: slice.toString(enc),
        encoding: enc,
        path: absPath,
        size: st.size,
        offset,
        truncated: offset + bytesRead < st.size,
        sidecar: true
      };
    } finally {
      await fh.close();
    }
  }

  async function listSidecarDirAt(absPath) {
    let names;
    try {
      names = await fs.readdir(absPath, { withFileTypes: true });
    } catch (err) {
      if (err && err.code === 'ENOENT') return [];
      throw err;
    }
    const out = [];
    for (const ent of names) {
      const full = path.join(absPath, ent.name);
      let st;
      try {
        st = await fs.stat(full);
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
  }

  function writeRootsForCall() {
    return Array.from(new Set([...writable, ...extraLocalRunRoots()]));
  }

  function currentSshWorkspaceRoot() {
    const target = resolveCallWorkspaceTarget();
    if (!target || target.kind !== 'ssh') return null;
    if (!isSshConnectedForCall()) return null;
    const manager = resolveSshManager();
    if (!manager || typeof manager.exec !== 'function') return null;
    return normalizeRemotePath(target.remotePath || defaultCwd || '/');
  }

  async function invokeRustCore(method, params, timeoutMs) {
    if (!rustCore || !rustCore.isReady()) {
      console.warn('[dieyun:core]', 'RUST_CORE_UNAVAILABLE', method);
      return null;
    }
    try {
      return await rustCore.invoke(method, params, timeoutMs);
    } catch (err) {
      const msg = String(err && err.message ? err.message : err);
      const code = (err && err.code) || 'RUST_CORE_ERROR';
      const benignFsMiss =
        method === 'fs.read_file' &&
        /os error 2|os error 3|找不到|No such file|not found/i.test(msg);
      if (!benignFsMiss) {
        console.warn('[dieyun:core]', code, method, msg);
      }
      return null;
    }
  }

  function rustCoreUnavailableError() {
    const e = new Error('dieyun-core 未就绪');
    e.code = 'RUST_CORE_UNAVAILABLE';
    return e;
  }

  /** sidecar 必须就绪；失败直接抛错，不再回退 JS MemoryStore */
  async function requireRustCore(method, params, timeoutMs) {
    if (!rustCore || !rustCore.isReady()) throw rustCoreUnavailableError();
    try {
      return await rustCore.invoke(method, params, timeoutMs);
    } catch (err) {
      const e = new Error(err && err.message ? err.message : String(err));
      e.code = (err && err.code) || 'RUST_CORE_ERROR';
      throw e;
    }
  }

  /** @type {Map<string, { readyUntil: number, ping: object }>} */
  const remoteCoreReadyByAgentKey = new Map();
  const REMOTE_INDEX_START_TIMEOUT_MS = 20000;
  const REMOTE_INDEX_PREP_TIMEOUT_MS = 45000;
  const REMOTE_INDEX_START_POLL_MS = 500;
  const REMOTE_INDEX_CONFIGURE_RETRY_MS = 10000;
  /** prep / start 后信任缓存，避免每次 status 再 wait core */
  const REMOTE_CORE_READY_TTL_MS = 120000;
  const INDEX_RPC_TIMEOUT_MS = 600000;
  /** 后台 job 监督上限（RPC 立即返回；客户端/prep 用短轮询） */
  const INDEX_JOB_WALL_MS = 60 * 60 * 1000;
  /** @type {Map<string, { promise: Promise<object>, settled: boolean, error: Error | null }>} */
  const codebaseIndexJobs = new Map();
  /** @type {Map<string, { promise: Promise<object>, settled: boolean, error: Error | null }>} */
  const graphIndexJobs = new Map();
  /** @type {Map<string, { settled: boolean, promise: Promise<object>|null, lastAt: number, indexedAt: number }>} */
  const graphLspEnrichJobs = new Map();
  const GRAPH_LSP_ENRICH_COOLDOWN_MS = 10 * 60 * 1000;
  const DEFAULT_REMOTE_RPC_TIMEOUT_MS = 120000;

  function remoteIndexError(code, message) {
    const e = new Error(message);
    e.code = code;
    return e;
  }

  function resetRemoteIndexCoreCache(agentKey) {
    if (!agentKey) {
      remoteCoreReadyByAgentKey.clear();
      return;
    }
    const prefix = String(agentKey);
    for (const k of [...remoteCoreReadyByAgentKey.keys()]) {
      if (k === prefix || k.startsWith(`${prefix}:`)) {
        remoteCoreReadyByAgentKey.delete(k);
      }
    }
  }

  function remoteIndexCacheKeyForContext(info, ctxInfo) {
    if (!ctxInfo || ctxInfo.kind !== 'remote') {
      return remoteAgentInfoKey(info);
    }
    return remoteIndexCacheKey(info, ctxInfo.remotePath || ctxInfo.rootKey);
  }

  function getRemoteCoreReadyCache(agentKey) {
    if (!agentKey) return null;
    const row = remoteCoreReadyByAgentKey.get(String(agentKey));
    if (!row || row.readyUntil <= Date.now() || !row.ping) return null;
    return row.ping;
  }

  function setRemoteCoreReadyCache(agentKey, ping) {
    if (!agentKey || !ping) return;
    remoteCoreReadyByAgentKey.set(String(agentKey), {
      readyUntil: Date.now() + REMOTE_CORE_READY_TTL_MS,
      ping
    });
  }

  function remoteRpcTimeout(method, timeoutMs) {
    return resolveCoreRpcTimeoutMs(method, timeoutMs);
  }

  async function pingRemoteIndex(info) {
    const client = getRemoteAgentClient(info);
    return client.call('index.ping', {}, 35000);
  }

  function isFatalRemoteCoreStartError(msg) {
    const s = String(msg || '');
    return /GLIBC_|不是 Linux ELF|Exec format error|unexpected argument|error: unexpected|cannot execute binary|Permission denied|No such file or directory|二进制缺失|ld-linux|wrong ELF class/i.test(
      s
    );
  }

  function formatRemoteIndexWaitFailure(configureAttempts, lastConfigureError, lastPing) {
    const detail = [lastConfigureError, lastPing && lastPing.lastError]
      .map((s) => String(s || '').trim())
      .filter(Boolean)
      .filter((s, i, arr) => arr.indexOf(s) === i);
    const head = `远程 dieyun-core 启动失败（已尝试拉起 ${configureAttempts} 次）`;
    if (detail.length) return `${head}：${detail[0].replace(/`/g, "'").slice(0, 800)}`;
    return `${head}，请检查 ~/.dieyun/remote-agent/current/agent.log`;
  }

  /**
   * 等待远程 dieyun-core 就绪：轮询 index.ping，并在未就绪时周期性重试 index.configure 拉起。
   * @param {object} ctxInfo
   * @param {{ timeoutMs?: number, maxConfigureRetries?: number, configureRetryMs?: number }} opts
   */
  async function waitRemoteIndexCoreReady(ctxInfo, opts = {}) {
    if (!ctxInfo || ctxInfo.kind !== 'remote') return null;
    const info = getRemoteAgentInfo();
    if (!info) {
      throw remoteIndexError(
        'REMOTE_AGENT_UNAVAILABLE',
        'Remote Agent 未就绪，请连接 SSH 并等待远程 Agent 启动'
      );
    }
    const key = remoteIndexCacheKeyForContext(info, ctxInfo);
    if (!key) {
      resetRemoteIndexCoreCache();
    }
    const cached = getRemoteCoreReadyCache(key);
    if (cached) return cached;

    const timeoutMs =
      opts.timeoutMs != null && Number(opts.timeoutMs) > 0
        ? Number(opts.timeoutMs)
        : REMOTE_INDEX_START_TIMEOUT_MS;
    const maxConfigureRetries =
      opts.maxConfigureRetries != null && Number(opts.maxConfigureRetries) >= 0
        ? Number(opts.maxConfigureRetries)
        : 3;
    const configureRetryMs =
      opts.configureRetryMs != null && Number(opts.configureRetryMs) > 0
        ? Number(opts.configureRetryMs)
        : REMOTE_INDEX_CONFIGURE_RETRY_MS;

    const deadline = Date.now() + timeoutMs;
    let configureAttempts = 0;
    let lastConfigureAt = 0;
    let lastPing = null;
    let lastConfigureError = '';

    while (Date.now() < deadline) {
      try {
        lastPing = await pingRemoteIndex(info);
      } catch (err) {
        // 链路已断时勿空转满超时：交给上层 prep 自愈（SSH/隧道 ensure）
        if (isDisconnectError(err)) {
          throw remoteIndexError(
            'REMOTE_AGENT_UNAVAILABLE',
            err && err.message ? err.message : 'Remote Agent 连接已关闭'
          );
        }
        if (Date.now() >= deadline) {
          throw remoteIndexError(
            'REMOTE_AGENT_UNAVAILABLE',
            err && err.message ? err.message : 'Remote Agent 无响应'
          );
        }
        await new Promise((resolve) => setTimeout(resolve, REMOTE_INDEX_START_POLL_MS));
        continue;
      }

      if (lastPing && lastPing.hasCore) {
        setRemoteCoreReadyCache(key, lastPing);
        return lastPing;
      }

      if (lastPing && !lastPing.hasBinary) {
        throw remoteIndexError(
          'REMOTE_INDEX_CORE_MISSING',
          '远程 Agent 未包含 Linux dieyun-core，无法在项目内构建索引。请在本机执行 npm run pack:dieyun-core:linux 与 npm run pack:remote-gateway 后重新连接 SSH'
        );
      }

      if (lastPing && lastPing.incompatible) {
        throw remoteIndexError(
          'REMOTE_INDEX_UNAVAILABLE',
          (lastPing.lastError && String(lastPing.lastError).trim()) ||
            formatRemoteIndexWaitFailure(configureAttempts, lastConfigureError, lastPing)
        );
      }

      if (lastPing && lastPing.lastError && isFatalRemoteCoreStartError(lastPing.lastError)) {
        throw remoteIndexError(
          'REMOTE_INDEX_UNAVAILABLE',
          formatRemoteIndexWaitFailure(configureAttempts, lastConfigureError, lastPing)
        );
      }

      const now = Date.now();
      const shouldConfigure =
        configureAttempts < maxConfigureRetries &&
        (configureAttempts === 0 || now - lastConfigureAt >= configureRetryMs);
      if (shouldConfigure) {
        configureAttempts += 1;
        lastConfigureAt = now;
        resetRemoteIndexCoreCache(remoteAgentInfoKey(info));
        const cfg = await syncRemoteIndexCoreConfig();
        if (cfg && cfg.ok === false && (cfg.error || cfg.reason)) {
          lastConfigureError = cfg.error || cfg.reason;
          if (isFatalRemoteCoreStartError(lastConfigureError)) {
            throw remoteIndexError(
              'REMOTE_INDEX_UNAVAILABLE',
              formatRemoteIndexWaitFailure(configureAttempts, lastConfigureError, lastPing)
            );
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 350));
        continue;
      }

      await new Promise((resolve) => setTimeout(resolve, REMOTE_INDEX_START_POLL_MS));
    }

    throw remoteIndexError(
      'REMOTE_INDEX_UNAVAILABLE',
      formatRemoteIndexWaitFailure(configureAttempts, lastConfigureError, lastPing)
    );
  }

  /** 远程工作区：仅允许项目内 dieyun-core；不回落本机 index_remote */
  async function assertRemoteIndexCore(ctxInfo) {
    return waitRemoteIndexCoreReady(ctxInfo, {
      timeoutMs: REMOTE_INDEX_START_TIMEOUT_MS,
      maxConfigureRetries: 2,
      configureRetryMs: REMOTE_INDEX_CONFIGURE_RETRY_MS
    });
  }

  async function invokeIndexCore(ctxInfo, method, params = {}, timeoutMs) {
    if (ctxInfo.kind === 'remote') {
      const info = getRemoteAgentInfo();
      if (!info) {
        throw remoteIndexError(
          'REMOTE_AGENT_UNAVAILABLE',
          'Remote Agent 未就绪，请连接 SSH 并等待远程 Agent 启动'
        );
      }
      const key = remoteIndexCacheKeyForContext(info, ctxInfo);
      const cached = getRemoteCoreReadyCache(key);
      const isStatus = method === 'codebase.status' || method === 'graph.status';
      if (!cached) {
        if (isStatus) {
          // status 轮询：短 wait、少 configure，避免与 prep 嵌套风暴
          await waitRemoteIndexCoreReady(ctxInfo, {
            timeoutMs: 8000,
            maxConfigureRetries: 1,
            configureRetryMs: REMOTE_INDEX_CONFIGURE_RETRY_MS
          });
        } else {
          await assertRemoteIndexCore(ctxInfo);
        }
      }
      const client = getRemoteAgentClient(info);
      return client.call(
        method,
        {
          ...params,
          workspaceRoot: ctxInfo.remotePath
        },
        remoteRpcTimeout(method, timeoutMs)
      );
    }
    const workspaceRoot = params.workspaceRoot != null ? params.workspaceRoot : ctxInfo.rootKey;
    return requireRustCore(method, { ...params, workspaceRoot }, timeoutMs);
  }

  async function syncRemoteIndexCoreConfig() {
    const info = getRemoteAgentInfo();
    if (!info) return { ok: false, reason: 'no_remote_agent' };
    const embedding = getActiveEmbeddingConfig();
    try {
      const client = getRemoteAgentClient(info);
      await client.call(
        'index.configure',
        {
          embedding: {
            disabled: !!embedding.disabled,
            builtin: !!embedding.builtin,
            baseUrl: embedding.baseUrl || '',
            apiKey: embedding.apiKey || '',
            model: embedding.model || '',
            dimensions: Number(embedding.dimensions) || 1024
          }
        },
        45000
      );
      resetRemoteIndexCoreCache(remoteAgentInfoKey(info));
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message || String(err) };
    }
  }

  const playbookHandlers = createPlaybookRpcHandlers({
    getRemoteFs,
    defaultCwd,
    writable,
    roots,
    normalizeFilePathInput,
    assertAllowedPath,
    userDataPath: ctx.userDataPath || '',
    getEmbeddingConfig: getActiveEmbeddingConfig,
    assertFsWrite: () => {
      assertHostEnabled(ctx);
      if (!perms.fsWrite) {
        const e = new Error('文件写入未授权');
        e.code = 'FS_WRITE_DISABLED';
        throw e;
      }
    },
    assertFsRead: () => {
      if (!perms.hostControl || !perms.fsRead) {
        const e = new Error('文件读取未授权');
        e.code = 'FS_READ_DISABLED';
        throw e;
      }
    }
  });

  const wikiHandlers = createWikiRpcHandlers({
    getRemoteFs,
    defaultCwd,
    writable,
    roots,
    normalizeFilePathInput,
    assertAllowedPath,
    userDataPath: ctx.userDataPath || '',
    getEmbeddingConfig: getActiveEmbeddingConfig,
    assertFsWrite: () => {
      assertHostEnabled(ctx);
      if (!perms.fsWrite) {
        const e = new Error('文件写入未授权');
        e.code = 'FS_WRITE_DISABLED';
        throw e;
      }
    },
    assertFsRead: () => {
      if (!perms.hostControl || !perms.fsRead) {
        const e = new Error('文件读取未授权');
        e.code = 'FS_READ_DISABLED';
        throw e;
      }
    }
  });

  function workspaceRootForUndo() {
    const target = resolveCallWorkspaceTarget();
    const cwd = cwdForCall();
    if (target && target.kind === 'ssh') {
      return cwd || null;
    }
    if (cwd) return path.resolve(cwd);
    if (defaultCwd) return path.resolve(defaultCwd);
    return null;
  }

  /**
   * 读取 undo 跟踪路径的当前磁盘内容，供 Phase B checkpoint 快照（非 turn 开始的 before）。
   */
  async function readUndoTrackedPathNow(relPath, meta) {
    const enc = meta && meta.encoding === 'base64' ? 'base64' : 'utf8';
    const remote = getRemoteFs();
    const useRemote = !!(remote && meta && meta.remote);
    try {
      if (useRemote) {
        const prev = await remote.readFile(relPath, enc === 'base64' ? 'base64' : 'utf8');
        return {
          before: prev && prev.data != null ? String(prev.data) : null,
          encoding: enc,
          remote: true
        };
      }
      const undoCwd = cwdForCall() || defaultCwd;
      const resolved = normalizeFilePathInput(relPath, undoCwd);
      const safe = assertAllowedPath(resolved, writable);
      if (!fsSync.existsSync(safe)) {
        return { before: null, encoding: enc, remote: false };
      }
      const st = fsSync.statSync(safe);
      if (!st.isFile()) {
        return { before: null, encoding: enc, remote: false };
      }
      const buf = fsSync.readFileSync(safe);
      if (buf.length > 4 * 1024 * 1024) {
        return {
          before: meta && meta.before != null ? String(meta.before) : null,
          encoding: meta && meta.encoding === 'base64' ? 'base64' : 'utf8',
          remote: false
        };
      }
      const isBinary = buf.includes(0);
      if (isBinary) {
        return { before: buf.toString('base64'), encoding: 'base64', remote: false };
      }
      return { before: buf.toString('utf8'), encoding: 'utf8', remote: false };
    } catch {
      return {
        before: meta && meta.before != null ? String(meta.before) : null,
        encoding: meta && meta.encoding === 'base64' ? 'base64' : 'utf8',
        remote: !!useRemote
      };
    }
  }

  function normalizeUndoTouchPaths(touchPaths, workspaceRoot) {
    const root = workspaceRoot ? String(workspaceRoot).replace(/\\/g, '/').replace(/\/+$/, '') : '';
    const out = new Set();
    for (const raw of touchPaths || []) {
      const fp = String(raw || '').replace(/\\/g, '/');
      if (!fp) continue;
      if (root && (fp === root || fp.startsWith(root + '/'))) {
        out.add(fp.slice(root.length + 1));
      } else {
        out.add(fp);
      }
    }
    return out;
  }

  async function mapWithConcurrency(items, limit, fn) {
    if (!items.length) return [];
    const results = new Array(items.length);
    let next = 0;
    async function worker() {
      while (next < items.length) {
        const idx = next++;
        results[idx] = await fn(items[idx], idx);
      }
    }
    await Promise.all(
      Array.from({ length: Math.min(Math.max(1, limit), items.length) }, () => worker())
    );
    return results;
  }

  async function captureUndoCheckpointSnapshot(filesMap, opts = {}) {
    const entries = Object.entries(filesMap || {}).filter(([relPath]) => relPath);
    const touchOnly = opts.touchOnly;
    const lastBatchFiles = opts.lastBatchFiles;
    /** @type {Record<string, { before: string|null, encoding: string, remote?: boolean }>} */
    const snap = {};
    /** @type {Array<[string, unknown]>} */
    const toRead = [];

    for (const [relPath, meta] of entries) {
      if (touchOnly && !touchOnly.has(relPath)) {
        if (lastBatchFiles && lastBatchFiles[relPath]) {
          snap[relPath] = { ...lastBatchFiles[relPath] };
        } else {
          toRead.push([relPath, meta]);
        }
        continue;
      }
      toRead.push([relPath, meta]);
    }

    await mapWithConcurrency(toRead, 8, async ([relPath, meta]) => {
      snap[relPath] = await readUndoTrackedPathNow(relPath, meta);
    });
    return snap;
  }

  function captureUndoWrite({ undoSessionId, undoTurnId, filePath, beforeText, encoding, remote }) {
    if (!turnUndo || !undoSessionId || !undoTurnId) return;
    try {
      turnUndo.captureWrite({
        sessionId: undoSessionId,
        turnId: undoTurnId,
        filePath,
        beforeText,
        encoding: encoding === 'base64' ? 'base64' : 'utf8',
        remote: !!remote,
        workspaceRoot: workspaceRootForUndo()
      });
    } catch {
      // ignore undo capture errors
    }
  }

  async function restoreUndoFile(item) {
    const useRemote = item.workspaceKind === 'ssh' || !!item.remote;
    const remote = useRemote ? getRemoteFs() : null;
    if (useRemote && !remote) {
      const e = new Error('远程工作区未连接，无法撤回文件');
      e.code = 'REMOTE_NOT_CONNECTED';
      throw e;
    }
    const enc = item.encoding === 'base64' ? 'base64' : 'utf8';
    // 撤回路径多为相对路径：必须用该 turn 绑定的工作区，禁止落到当前视图 defaultCwd
    const undoCwd = item.workspaceRoot || cwdForCall() || defaultCwd;
    if (item.before == null) {
      if (useRemote) {
        const safe = remote.resolve(item.path, remote.root);
        await requireSshForCall().exec(`rm -f ${shellQuoteSingle(safe)}`, remote.root, 15000);
      } else {
        const resolved = normalizeFilePathInput(item.path, undoCwd);
        const safe = assertAllowedPath(resolved, writeRootsForCall());
        if (fsSync.existsSync(safe)) {
          const st = await fs.stat(safe);
          if (st.isDirectory()) await fs.rm(safe, { recursive: true, force: true });
          else await fs.unlink(safe);
        }
      }
      return;
    }
    if (useRemote) {
      await remote.writeFile(item.path, item.before, enc);
      return;
    }
    const resolved = normalizeFilePathInput(item.path, undoCwd);
    const safe = assertAllowedPath(resolved, writeRootsForCall());
    const buf = enc === 'base64' ? Buffer.from(String(item.before), 'base64') : Buffer.from(String(item.before), 'utf8');
    await fs.mkdir(path.dirname(safe), { recursive: true });
    await fs.writeFile(safe, buf);
  }

  async function restoreUndoFilesConcurrent(items, limit = 6) {
    const list = Array.isArray(items) ? items : [];
    if (!list.length) return { restored: 0, errors: [] };
    const errors = [];
    const results = await mapWithConcurrency(list, limit, async (item) => {
      try {
        await restoreUndoFile(item);
        return { ok: true };
      } catch (err) {
        errors.push({ path: item.path, error: err.message || String(err) });
        return { ok: false };
      }
    });
    return { restored: results.filter((r) => r && r.ok).length, errors };
  }

  function undoRestoreCallContext(plan, sessionId) {
    const kind = plan && plan.workspaceKind;
    const fromPlan = plan && plan.runWorkspaceRoot ? String(plan.runWorkspaceRoot).trim() : '';
    const fromAls = getActiveRunWorkspaceRoot();
    const als = fromAls ? String(fromAls).trim() : '';
    const isUri = (s) => /^ssh:/i.test(s);
    let runWorkspaceRoot = fromPlan || als || '';
    if (kind === 'ssh' && runWorkspaceRoot && !isUri(runWorkspaceRoot)) {
      runWorkspaceRoot = isUri(als) ? als : '';
    }
    if (!runWorkspaceRoot && kind !== 'ssh' && plan && plan.workspaceRoot) {
      runWorkspaceRoot = String(plan.workspaceRoot);
    }
    return { runWorkspaceRoot: runWorkspaceRoot || null, sessionId: sessionId || null };
  }

  function getRemoteAgentInfo() {
    const callSid = getActiveCallSessionId();
    if (typeof ctx.getRemoteAgentInfo === 'function') {
      try {
        return ctx.getRemoteAgentInfo(callSid || undefined);
      } catch {
        return null;
      }
    }
    return null;
  }

  function parseClassicGrepLines(stdout, limit, ctx = {}) {
    const n = Math.min(200, Math.max(1, Number(limit) || 50));
    const before = Math.min(10, Math.max(0, Number(ctx.before) || 0));
    const after = Math.min(10, Math.max(0, Number(ctx.after) || 0));
    const wantContext = before > 0 || after > 0;
    /** @type {Map<string, Array<{ isMatch: boolean, line: number, text: string }>>} */
    const byPath = new Map();
    const order = [];
    // 命中行 path:N:text，上下文行 path-N-text（两个分隔符同类型）
    let rawItems = 0;
    for (const line of String(stdout || '').split(/\r?\n/)) {
      if (!line) continue;
      if (rawItems >= 20000) break;
      const m = line.match(/^(.+?)([:-])(\d+)\2(.*)$/);
      if (!m) continue;
      const rel = m[1].replace(/^\.\//, '').replace(/\\/g, '/');
      if (!byPath.has(rel)) {
        byPath.set(rel, []);
        order.push(rel);
      }
      byPath.get(rel).push({
        isMatch: m[2] === ':',
        line: Number(m[3]) || 1,
        text: String(m[4]).slice(0, 400)
      });
      rawItems += 1;
    }
    const matches = [];
    for (const rel of order) {
      const items = byPath.get(rel);
      for (let i = 0; i < items.length; i++) {
        if (!items[i].isMatch) continue;
        const entry = { path: rel, line: items[i].line, text: items[i].text };
        if (wantContext) {
          if (before > 0) {
            const seg = [];
            for (let j = Math.max(0, i - before); j < i; j++) {
              if (items[j].isMatch) continue;
              seg.push({ line: items[j].line, text: items[j].text });
            }
            if (seg.length) entry.before = seg;
          }
          if (after > 0) {
            const seg = [];
            for (let j = i + 1; j < Math.min(items.length, i + 1 + after); j++) {
              if (items[j].isMatch) continue;
              seg.push({ line: items[j].line, text: items[j].text });
            }
            if (seg.length) entry.after = seg;
          }
        }
        matches.push(entry);
        if (matches.length >= n) return matches;
      }
    }
    return matches;
  }

  async function grepViaRemoteExec(cwd, opts) {
    const n = Math.min(200, Math.max(1, Number(opts.maxResults) || 50));
    const before = Math.min(10, Math.max(0, Number(opts.beforeContext) || 0));
    const after = Math.min(10, Math.max(0, Number(opts.afterContext) || 0));
    const ctxPart = `${before > 0 ? ` -B ${before}` : ''}${after > 0 ? ` -A ${after}` : ''}`;
    const pat = shellQuoteSingle(String(opts.pattern || ''));
    const globPart = opts.glob ? `--include=${shellQuoteSingle(String(opts.glob))}` : '';
    if (opts.count) {
      // 远程 exec 只支持计数：系统 grep -c 输出 path:count
      const ccmd = `grep -RIn -c ${globPart} --exclude-dir=.git --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=target ${pat} . 2>/dev/null | head -n 400`;
      let rc = null;
      if (isSshConnectedForCall()) {
        rc = await requireSshForCall().exec(ccmd, cwd, 60000);
      }
      if (!rc) return null;
      let total = 0;
      for (const line of String(rc.stdout || '').split(/\r?\n/)) {
        const m = line.trim().match(/:(\d+)$/);
        if (m) total += Number(m[1]) || 0;
      }
      return {
        ok: true,
        matches: [],
        count: total,
        truncated: false,
        source: 'remote_grep',
        countOnly: true
      };
    }
    // path 限定：read_symbol 的兜底定位需要只搜某个文件，避免全库扫
    const target = opts.path ? shellQuoteSingle(String(opts.path)) : '.';
    // head 上限按「每个命中最多带 1+before+after 行」放大：
    // 否则 -A/-B 的上下文行会吃掉配额，maxResults 实际只能返回零头。
    const headN = n * (1 + before + after);
    const cmd = `grep -RIn${ctxPart} ${globPart} --exclude-dir=.git --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=target -m ${n} ${pat} ${target} 2>/dev/null | head -n ${headN}`;
    let r = null;
    if (isSshConnectedForCall()) {
      r = await requireSshForCall().exec(cmd, cwd, 60000);
    }
    if (!r) return null;
    const matches = parseClassicGrepLines(r.stdout, n, { before, after });
    return { ok: true, matches, truncated: matches.length >= n, source: 'remote_grep' };
  }

  async function globViaRemoteExec(cwd, opts) {
    const n = Math.min(400, Math.max(1, Number(opts.maxResults) || 80));
    const pat = shellQuoteSingle(String(opts.pattern || ''));
    const cmd = `rg --files --no-config --glob '!node_modules/**' --glob '!.git/**' -g ${pat} 2>/dev/null | head -n ${n}`;
    let r = null;
    try {
      if (isSshConnectedForCall()) {
        r = await requireSshForCall().exec(cmd, cwd, 60000);
      }
    } catch {
      return { ok: false, errorCode: 'GLOB_UNAVAILABLE', error: '远程没有 rg，改用 fs_list_dir' };
    }
    if (!r) return null;
    const files = String(r.stdout || '')
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, n);
    return { ok: true, files, truncated: files.length >= n, source: 'remote_rg' };
  }

  function formatGrepMatchesAsSearchResults(matches, limit) {
    const max = Math.min(20, Math.max(1, Number(limit) || 8));
    const list = Array.isArray(matches) ? matches : [];
    return list.slice(0, max).map((m, i) => {
      const rawPath = m.path ? String(m.path) : '';
      const relPath = rawPath.replace(/^.*[/\\]/, '') || (m.raw ? String(m.raw).slice(0, 80) : '');
      const text = m.text != null ? String(m.text) : m.raw ? String(m.raw) : '';
      return {
        path: relPath,
        startLine: m.line || 1,
        endLine: m.line || 1,
        score: Math.max(0.1, 1 - i * 0.05),
        snippet: text.slice(0, 900),
        source: 'grep_fallback'
      };
    });
  }

  async function tryRemoteGrepFallback(ctxInfo, query, limit) {
    const q = String(query || '').trim();
    if (!q || ctxInfo.kind !== 'remote') return null;

    const agentInfo = getRemoteAgentInfo();
    if (agentInfo && agentInfo.url) {
      try {
        const client = getRemoteAgentClient(agentInfo);
        let r = null;
        try {
          r = await client.call('fs.grep', { pattern: q, maxResults: limit });
        } catch {
          r = await client.call('codebase.grep', { pattern: q, maxResults: limit });
        }
        const results = formatGrepMatchesAsSearchResults(r && r.matches, limit);
        if (results.length) return { results, source: 'remote_agent_grep' };
      } catch {
        // fall through to SSH exec
      }
    }

    if (!isSshConnectedForCall()) {
      return null;
    }
    const sshCall = requireSshForCall();
    const cwd = normalizeRemotePath(ctxInfo.remotePath);
    const pat = shellQuoteSingle(q);
    const n = Math.min(200, Math.max(1, Number(limit) || 50));
    try {
      const r = await sshCall.exec(
        `grep -RIn --exclude-dir=.git --exclude-dir=node_modules -m ${n} ${pat} . 2>/dev/null | head -n ${n}`,
        cwd,
        60000
      );
      const lines = String(r.stdout || '')
        .split(/\r?\n/)
        .filter(Boolean)
        .slice(0, n)
        .map((line) => {
          const m = line.match(/^([^:]+):(\d+):(.*)$/);
          if (!m) return { raw: line };
          return { path: m[1], line: Number(m[2]), text: m[3] };
        });
      const results = formatGrepMatchesAsSearchResults(lines, limit);
      if (results.length) return { results, source: 'ssh_grep' };
    } catch {
      // ignore
    }
    return null;
  }

  function getRemoteFs() {
    const target = resolveCallWorkspaceTarget();
    if (!target) return null;
    if (target.kind !== 'ssh') return null;
    const sshCall = requireSshForCall();
    const st = sshCall.status();
    return createRemoteFsAdapter(sshCall, {
      kind: 'ssh',
      host: st.host,
      port: st.port,
      username: st.username,
      remotePath: target.remotePath
    });
  }

  function resolveCodebaseContext(workspaceRoot) {
    const target = resolveCallWorkspaceTarget();
    if (target && target.kind === 'ssh') {
      if (!isSshConnectedForCall()) {
        const e = new Error('SSH 未连接，无法索引或检索远程 Codebase');
        e.code = 'SSH_NOT_CONNECTED';
        throw e;
      }
      return {
        kind: 'remote',
        rootKey: buildSshUri(target),
        remotePath: target.remotePath
      };
    }
    const input =
      workspaceRoot || (target && target.kind === 'local' ? target.path : null) || cwdForCall();
    if (!input) {
      const e = new Error('未选择工作空间');
      e.code = 'WORKSPACE_REQUIRED';
      throw e;
    }
    const resolved = normalizeFilePathInput(input, cwdForCall());
    const root = assertAllowedPath(resolved, readRootsForCall());
    return { kind: 'local', rootKey: root };
  }

  function resolveCodebaseRoot(workspaceRoot) {
    return resolveCodebaseContext(workspaceRoot).rootKey;
  }

  function assertWebFetchEnabled() {
    if (perms.webFetch === false) {
      const e = new Error('联网抓取未授权');
      e.code = 'WEB_FETCH_DISABLED';
      throw e;
    }
  }

  function assertBrowserEnabled() {
    assertHostEnabled(ctx);
    if (perms.browserAutomation === false) {
      const e = new Error('浏览器自动化未授权');
      e.code = 'BROWSER_DISABLED';
      throw e;
    }
    if (!browser) {
      const e = new Error('浏览器服务未初始化');
      e.code = 'BROWSER_UNAVAILABLE';
      throw e;
    }
  }

  function assertSqlEnabled() {
    if (!perms.sqlRead) {
      const e = new Error('SQL 只读查询未授权');
      e.code = 'SQL_READ_DISABLED';
      throw e;
    }
    if (!sqlSvc) {
      const e = new Error('SQL Server 服务未初始化');
      e.code = 'SQL_UNAVAILABLE';
      throw e;
    }
  }

  function getActiveEmbeddingConfig() {
    if (typeof ctx.getEmbeddingConfig !== 'function') return {};
    try {
      return ctx.getEmbeddingConfig() || {};
    } catch {
      return {};
    }
  }

  function isGraphFilePath(relPath) {
    const rel = String(relPath || '').toLowerCase();
    return /\.(?:[cm]?[jt]sx?|py|go|rs)$/.test(rel);
  }

  function formatGraphIndexProgress(st) {
    if (!st) return '正在建立结构索引…';
    const phase = String(st.phase || '').trim();
    const phaseLabel =
      phase === 'walking'
        ? '扫描源文件'
        : phase === 'parsing'
          ? '解析符号/依赖'
          : phase === 'finishing'
            ? '写入结构索引'
            : phase === 'error'
              ? '结构索引失败'
              : '建立结构索引';
    const done = Number(st.filesDone) || 0;
    const total = Number(st.filesTotal) || 0;
    const symbols = Number(st.symbolCount) || 0;
    const edges = Number(st.edgeCount) || 0;
    const parts = [phaseLabel];
    if (total > 0) parts.push(`${done}/${total} 文件`);
    else if (done > 0) parts.push(`${done} 文件`);
    if (symbols > 0) parts.push(`${symbols} 符号`);
    if (edges > 0) parts.push(`${edges} 依赖`);
    return parts.join(' · ');
  }

  function graphNeedsRebuild(st, opts = {}) {
    if (opts.force) return true;
    if (!st || !st.indexed) return true;
    return false;
  }

  function graphNeedsFullIndex(st, opts = {}) {
    if (graphNeedsRebuild(st, opts)) return true;
    if (!st.symbolCount && !st.edgeCount) return true;
    if (opts.requireEdges && !st.edgeCount) return true;
    if (opts.requireCalls && !st.callCount) return true;
    return false;
  }

  async function fetchIndexStatus(ctxInfo, kind) {
    const method = kind === 'graph' ? 'graph.status' : 'codebase.status';
    return invokeIndexCore(ctxInfo, method, {}, 45000);
  }

  function attachIndexJob(jobsMap, rootKey, runner) {
    const job = { settled: false, error: null, promise: null };
    job.promise = (async () => {
      try {
        return await runner();
      } catch (e) {
        job.error = e;
        throw e;
      } finally {
        job.settled = true;
      }
    })();
    jobsMap.set(rootKey, job);
    // 后台 job 可能无人 await；吞掉 unhandledRejection，调用方仍可 await job.promise
    void job.promise.catch(() => {});
    return job;
  }

  /**
   * 后台 job / 内部监督共用：status 轮询到就绪；勿对 RPC 客户端做 60min 阻塞。
   */
  async function pollIndexUntilReady(ctxInfo, opts = {}) {
    const kind = opts.kind === 'graph' ? 'graph' : 'codebase';
    const wallMs =
      opts.wallMs != null && Number(opts.wallMs) > 0 ? Number(opts.wallMs) : INDEX_JOB_WALL_MS;
    const intervalMs =
      opts.intervalMs != null && Number(opts.intervalMs) > 0 ? Number(opts.intervalMs) : 1000;
    const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : null;
    const signal = opts.signal || null;
    const failCode = kind === 'graph' ? 'GRAPH_INDEX_FAILED' : 'INDEX_FAILED';
    const timeoutCode = kind === 'graph' ? 'GRAPH_INDEX_TIMEOUT' : 'INDEX_TIMEOUT';
    const timeoutLabel = kind === 'graph' ? '结构索引' : '代码库索引';
    const formatProgress =
      kind === 'graph' ? formatGraphIndexProgress : formatCodebaseIndexProgress;

    const throwIfAborted = () => {
      if (signal && signal.aborted) {
        const e = new Error('已取消');
        e.code = 'ABORTED';
        throw e;
      }
    };

    const deadline = Date.now() + wallMs;
    while (Date.now() < deadline) {
      throwIfAborted();
      const st = await fetchIndexStatus(ctxInfo, kind);
      if (onProgress) onProgress(st, formatProgress(st));
      if (st && st.lastError && !st.indexing) {
        const e = new Error(String(st.lastError));
        e.code = failCode;
        throw e;
      }
      if (st && st.indexed && !st.indexing) {
        if (kind === 'graph') {
          scheduleGraphLspEnrich(ctxInfo, { reason: 'index_ready' });
        }
        return st;
      }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
    const e = new Error(`${timeoutLabel}超时（>${Math.round(wallMs / 60000)} 分钟）`);
    e.code = timeoutCode;
    throw e;
  }

  /**
   * 结构索引就绪后异步用 LSP（或远程 rg）补全调用边；失败静默，不挡索引。
   */
  function scheduleGraphLspEnrich(ctxInfo, opts = {}) {
    if (!ctxInfo || !ctxInfo.rootKey) return null;
    const key = String(ctxInfo.rootKey);
    const existing = graphLspEnrichJobs.get(key);
    const now = Date.now();
    if (existing && !existing.settled) return existing;
    if (
      existing &&
      existing.settled &&
      now - (existing.lastAt || 0) < GRAPH_LSP_ENRICH_COOLDOWN_MS &&
      opts.force !== true
    ) {
      return existing;
    }
    const job = { settled: false, promise: null, lastAt: now, indexedAt: 0 };
    job.promise = (async () => {
      try {
        const r = await runGraphLspEnrich(ctxInfo, {
          limit: opts.limit != null ? Number(opts.limit) : 20,
          timeoutMs: opts.timeoutMs != null ? Number(opts.timeoutMs) : 12000,
          wallMs: opts.wallMs != null ? Number(opts.wallMs) : 45000
        });
        job.indexedAt = Number(r && r.indexedAt) || 0;
        return r;
      } catch (err) {
        job.error = err;
        return { ok: false, error: err && err.message ? String(err.message) : String(err) };
      } finally {
        job.settled = true;
        job.lastAt = Date.now();
      }
    })();
    graphLspEnrichJobs.set(key, job);
    return job;
  }

  async function runGraphLspEnrich(ctxInfo, opts = {}) {
    const limit = Math.max(4, Math.min(40, Number(opts.limit) || 20));
    const perSymbolMs = Math.max(3000, Math.min(20000, Number(opts.timeoutMs) || 12000));
    const wallMs = Math.max(10000, Math.min(120000, Number(opts.wallMs) || 45000));
    const st = await invokeIndexCore(ctxInfo, 'graph.status', {}, 20000);
    if (!st || !st.indexed) {
      return { ok: false, error: 'graph_not_indexed', enriched: 0, attempted: 0 };
    }
    let hub = [];
    try {
      const map = await invokeIndexCore(ctxInfo, 'graph.repo_map', { limit }, 30000);
      hub = Array.isArray(map && map.hubSymbols) ? map.hubSymbols : [];
    } catch {
      hub = [];
    }
    const symbols = hub
      .filter((s) => s && s.name && (s.kind === 'function' || s.kind === 'method' || s.kind === 'class'))
      .slice(0, limit);
    const started = Date.now();
    let attempted = 0;
    let enriched = 0;
    let ingestedTotal = 0;
    const errors = [];
    for (const symbol of symbols) {
      if (Date.now() - started > wallMs) break;
      attempted += 1;
      try {
        const one = await resolveGraphSymbolCallersAndIngest(ctxInfo, symbol, {
          persist: true,
          timeoutMs: perSymbolMs
        });
        if (one && one.ok) {
          enriched += 1;
          ingestedTotal += Number(one.ingested) || 0;
        } else if (one && one.error) {
          errors.push(String(one.error));
        }
      } catch (err) {
        errors.push(err && err.message ? String(err.message) : String(err));
      }
    }
    return {
      ok: true,
      indexed: true,
      attempted,
      enriched,
      ingested: ingestedTotal,
      indexedAt: Number(st.indexedAt) || 0,
      errors: errors.slice(0, 5)
    };
  }

  /**
   * 与 graph.lsp_resolve 共用：解析 callers 并可选写入 graph_calls。
   */
  async function resolveGraphSymbolCallersAndIngest(ctxInfo, symbol, opts = {}) {
    if (!symbol || !symbol.name) {
      return { ok: false, error: 'symbol_required', sites: [], ingested: 0 };
    }
    const persist = opts.persist !== false;
    const timeoutMs = opts.timeoutMs;

    if (ctxInfo.kind === 'remote') {
      let sites = [];
      let mode = 'graph_static';
      let server = 'remote-graph';
      let language = 'mixed';
      try {
        const callers = await invokeIndexCore(ctxInfo, 'graph.callers', {
          name: symbol.name,
          path: symbol.path,
          symbolId: symbol.id
        });
        if (callers && Array.isArray(callers.sites) && callers.sites.length) {
          sites = callers.sites.map((s) => ({
            callerPath: s.callerPath,
            callerSymbol: s.callerSymbol || '',
            calleeName: symbol.name,
            line: s.line,
            confidence: s.confidence != null ? s.confidence : 1
          }));
          mode = 'graph_callers';
        }
      } catch {
        // fallback to rg
      }
      if (!sites.length) {
        const resolved = await resolveRemoteGraphCallers(ctxInfo, symbol, timeoutMs);
        if (!resolved.ok) {
          return {
            ok: false,
            error: resolved.error || 'remote_lsp_resolve_failed',
            symbol,
            sites: [],
            mode: resolved.mode,
            ingested: 0
          };
        }
        sites = resolved.sites || [];
        mode = resolved.mode;
        server = resolved.server;
        language = resolved.language;
      }
      let ingested = 0;
      if (persist && sites.length) {
        const ingest = await invokeIndexCore(ctxInfo, 'graph.ingest_lsp_callers', {
          calleeSymbolId: symbol.id,
          calleeName: symbol.name,
          sites: sites.map((s) => ({
            callerPath: s.callerPath,
            line: s.line,
            callerSymbol: s.callerSymbol || undefined
          }))
        });
        ingested = ingest.ingested || 0;
      }
      return { ok: true, indexed: true, mode, server, language, symbol, sites, ingested };
    }

    if (!lspDiagnostics || typeof lspDiagnostics.resolveSymbolCallers !== 'function') {
      return { ok: false, error: 'LSP 未启用', sites: [], ingested: 0 };
    }

    const absPath = path.isAbsolute(symbol.path)
      ? path.normalize(symbol.path)
      : path.join(ctxInfo.rootKey, symbol.path);
    const lsp = await lspDiagnostics.resolveSymbolCallers({
      workspaceRoot: ctxInfo.rootKey,
      absPath,
      line: Number(symbol.startLine || 1),
      name: symbol.name,
      timeoutMs: timeoutMs != null ? Number(timeoutMs) : undefined
    });
    if (!lsp.ok) {
      return {
        ok: false,
        error: lsp.error || 'lsp_resolve_failed',
        symbol,
        sites: [],
        mode: lsp.mode,
        ingested: 0
      };
    }

    let ingested = 0;
    if (persist && lsp.sites && lsp.sites.length) {
      const ingest = await invokeIndexCore(ctxInfo, 'graph.ingest_lsp_callers', {
        workspaceRoot: ctxInfo.rootKey,
        calleeSymbolId: symbol.id,
        calleeName: symbol.name,
        sites: lsp.sites.map((s) => ({
          callerPath: s.callerPath,
          line: s.line,
          callerSymbol: s.callerSymbol || undefined
        }))
      });
      ingested = ingest.ingested || 0;
    }

    const sites = (lsp.sites || []).map((s) => ({
      callerPath: s.callerPath,
      callerSymbol: s.callerSymbol || '',
      calleeName: symbol.name,
      line: s.line,
      confidence: 1
    }));

    return {
      ok: true,
      indexed: true,
      mode: lsp.mode,
      server: lsp.server,
      language: lsp.language,
      symbol,
      sites,
      ingested
    };
  }

  /**
   * 启动索引（去重）；RPC 立即返回；后台 job 仅监督就绪。
   * @param {'codebase'|'graph'} kind
   */
  async function startIndexForContext(kind, ctxInfo, opts = {}) {
    const isGraph = kind === 'graph';
    const jobsMap = isGraph ? graphIndexJobs : codebaseIndexJobs;
    const startMethod = isGraph ? 'graph.index.start' : 'codebase.index.start';
    const syncMethod = isGraph ? 'graph.index' : 'codebase.index';
    const rootKey = ctxInfo.rootKey;

    const existing = jobsMap.get(rootKey);
    if (existing && !existing.settled) {
      const st = await fetchIndexStatus(ctxInfo, kind);
      return { started: false, alreadyRunning: true, job: existing, ...st };
    }

    const force = !!opts.force;
    const skipIfReady = opts.skipIfReady !== false;

    let startResult;
    try {
      startResult = await invokeIndexCore(ctxInfo, startMethod, { force, skipIfReady }, 60000);
    } catch (err) {
      const msg = err && err.message ? String(err.message) : String(err);
      const code = err && err.code ? String(err.code) : '';
      const missing =
        code === 'REMOTE_INDEX_UNSUPPORTED' ||
        /unknown method|Method not found|不支持的方法/i.test(msg);
      if (!missing) throw err;
      const syncParams = isGraph
        ? { force: true, embedSymbols: false }
        : { force: true };
      const job = attachIndexJob(jobsMap, rootKey, () =>
        invokeIndexCore(ctxInfo, syncMethod, syncParams, INDEX_JOB_WALL_MS)
      );
      return { started: true, alreadyRunning: false, indexing: true, indexed: false, job };
    }

    if (startResult && (startResult.started || startResult.alreadyRunning || startResult.indexing)) {
      const job = attachIndexJob(jobsMap, rootKey, () =>
        pollIndexUntilReady(ctxInfo, { kind })
      );
      return { ...startResult, job };
    }

    return { ...startResult, started: false, alreadyRunning: false };
  }

  async function startGraphIndexForContext(ctxInfo, opts = {}) {
    return startIndexForContext('graph', ctxInfo, opts);
  }

  function assertGraphIndexReady(st, opts = {}) {
    if (st && st.indexing) {
      const e = new Error('结构索引创建中，请稍后再试');
      e.code = 'GRAPH_INDEXING_IN_PROGRESS';
      throw e;
    }
    if (graphNeedsFullIndex(st, opts)) {
      const e = new Error('结构索引尚未就绪，请稍后再试或使用 grep/读文件');
      e.code = 'GRAPH_INDEX_REQUIRED';
      throw e;
    }
  }

  function escapeRegExp(value) {
    return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function parseRemoteGrepLine(line) {
    const m = /^(.+?):(\d+):(?:(\d+):)?(.*)$/.exec(String(line || ''));
    if (!m) return null;
    const rel = m[1].replace(/\\/g, '/').replace(/^\.\//, '');
    if (!rel || rel.startsWith('../') || !isGraphFilePath(rel)) return null;
    return {
      callerPath: rel,
      line: Number(m[2]) || 1,
      text: m[4] || ''
    };
  }

  async function execRemoteGrepForCallers(ctxInfo, script, timeoutMs) {
    const execTimeout = timeoutMs != null ? Number(timeoutMs) : 30000;
    const agentInfo = getRemoteAgentInfo();
    if (agentInfo) {
      try {
        const client = getRemoteAgentClient(agentInfo);
        const r = await client.call(
          'host.exec',
          {
            command: script,
            cwd: ctxInfo.remotePath,
            timeoutMs: execTimeout
          },
          execTimeout + 5000
        );
        return { ...r, mode: 'remote_agent_exec', server: 'remote-rg' };
      } catch {
        // fall through to SSH
      }
    }
    if (!isSshConnectedForCall() || typeof resolveSshManager()?.exec !== 'function') {
      return null;
    }
    if (!perms.shellExec) {
      return null;
    }
    try {
      const r = await requireSshForCall().exec(script, ctxInfo.remotePath, execTimeout, { bashScript: true });
      return { ...r, mode: 'ssh_rg', server: 'remote-rg' };
    } catch {
      return null;
    }
  }

  async function resolveRemoteGraphCallers(ctxInfo, symbol, timeoutMs) {
    const name = String(symbol?.name || '').trim();
    if (!name) {
      return { ok: false, error: 'symbol_name_required', mode: 'ssh_rg', sites: [] };
    }
    const regex = `\\b${escapeRegExp(name)}\\s*\\(`;
    const script = [
      'if command -v rg >/dev/null 2>&1; then',
      `  rg -n --column --no-heading --color never -S -g '!node_modules/**' -g '!vendor/**' -g '!dist/**' -g '!build/**' -g '!target/**' -g '!coverage/**' -g '!*.min.js' ${shellQuoteSingle(regex)} . || true`,
      'else',
      `  grep -RInF --exclude-dir=.git --exclude-dir=node_modules --exclude-dir=vendor --exclude-dir=dist --exclude-dir=build --exclude-dir=target --exclude-dir=coverage ${shellQuoteSingle(name)} . || true`,
      'fi'
    ].join('\n');
    const r = await execRemoteGrepForCallers(ctxInfo, script, timeoutMs);
    if (!r) {
      return {
        ok: false,
        error: isSshConnectedForCall() ? 'shell_exec_disabled' : 'remote_exec_unavailable',
        mode: 'ssh_rg',
        sites: []
      };
    }
    if (r && r.code != null && r.code !== 0 && !r.stdout) {
      return {
        ok: false,
        error: r.stderr || `remote_rg_exit_${r.code}`,
        mode: 'ssh_rg',
        sites: []
      };
    }
    const defPath = String(symbol.path || '').replace(/\\/g, '/');
    const defLine = Number(symbol.startLine || 0);
    const seen = new Set();
    const sites = [];
    for (const rawLine of String(r?.stdout || '').split(/\r?\n/)) {
      const hit = parseRemoteGrepLine(rawLine);
      if (!hit) continue;
      if (defPath && hit.callerPath === defPath && defLine && hit.line === defLine) continue;
      const key = `${hit.callerPath}:${hit.line}`;
      if (seen.has(key)) continue;
      seen.add(key);
      sites.push({
        callerPath: hit.callerPath,
        callerSymbol: '',
        calleeName: name,
        line: hit.line,
        confidence: 0.95
      });
      if (sites.length >= 200) break;
    }
    return {
      ok: true,
      mode: r.mode || 'ssh_rg',
      server: r.server || 'remote-rg',
      language: 'mixed',
      sites
    };
  }

  function codebaseHasSearchableIndex(st) {
    return !!(st && st.indexed && Number(st.chunkCount) > 0);
  }

  function formatCodebaseIndexProgress(st) {
    if (!st) return '正在建立代码索引…';
    const phase = String(st.phase || '').trim();
    const phaseLabel =
      phase === 'walking'
        ? '扫描文件'
        : phase === 'chunking'
          ? '切分代码'
          : phase === 'embedding'
            ? '生成向量'
            : phase === 'finishing'
              ? '写入索引'
              : phase === 'error'
                ? '索引失败'
                : '建立索引';
    const done = Number(st.filesDone) || 0;
    const total = Number(st.filesTotal) || 0;
    const chunks = Number(st.chunkCount) || 0;
    const vectors = Number(st.vectorCount) || 0;
    const parts = [phaseLabel];
    if (total > 0) parts.push(`${done}/${total} 文件`);
    else if (done > 0) parts.push(`${done} 文件`);
    if (chunks > 0) parts.push(`${chunks} chunk`);
    if (vectors > 0) parts.push(`${vectors} 向量`);
    return parts.join(' · ');
  }

  /**
   * 启动全量索引（去重）；不在调用处同步阻塞到建完。
   */
  async function startCodebaseIndexForContext(ctxInfo, opts = {}) {
    return startIndexForContext('codebase', ctxInfo, opts);
  }

  async function readAllowedTextFile(filePath, encoding, readOpts = {}) {
    const resolved = normalizeFilePathInput(filePath, cwdForCall());
    const safe = assertAllowedPath(resolved, readRootsForCall());
    const enc = encoding === 'base64' ? null : encoding || 'utf8';
    const { offset, maxBytes } = normalizeReadParams(readOpts);
    const st = await fs.stat(safe);
    const readLen = Math.min(maxBytes, Math.max(0, st.size - offset));
    if (readLen <= 0) {
      return {
        data: '',
        encoding: enc === null ? 'base64' : enc,
        path: safe,
        size: st.size,
        offset,
        truncated: offset < st.size
      };
    }
    const fh = await fs.open(safe, 'r');
    try {
      const buf = Buffer.alloc(readLen);
      const { bytesRead } = await fh.read(buf, 0, readLen, offset);
      const slice = buf.subarray(0, bytesRead);
      if (enc === null) {
        return {
          data: slice.toString('base64'),
          encoding: 'base64',
          path: safe,
          size: st.size,
          offset,
          truncated: offset + bytesRead < st.size
        };
      }
      return {
        data: slice.toString(enc),
        encoding: enc,
        path: safe,
        size: st.size,
        offset,
        truncated: offset + bytesRead < st.size
      };
    } finally {
      await fh.close();
    }
  }

  async function listAllowedArtifactFiles(dirPath, limit) {
    const baseInput = dirPath || defaultCwd;
    const resolved = normalizeFilePathInput(baseInput, defaultCwd);
    const base = assertAllowedPath(resolved, Array.from(new Set([...roots, ...writable])));
    const max = Math.min(500, Math.max(1, Number(limit) || 200));
    const skipDirs = new Set([
      '.git',
      '.agents',
      '.codex',
      'node_modules',
      '__pycache__',
      '.venv',
      'venv',
      'dist',
      'build'
    ]);
    const out = [];
    const stack = [{ dir: base, depth: 0 }];
    while (stack.length && out.length < max) {
      const cur = stack.pop();
      let entries = [];
      try {
        entries = await fs.readdir(cur.dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const ent of entries) {
        if (out.length >= max) break;
        if (!ent || !ent.name || ent.name.startsWith('~$')) continue;
        const full = path.join(cur.dir, ent.name);
        if (ent.isDirectory()) {
          if (cur.depth < 2 && !skipDirs.has(ent.name)) {
            stack.push({ dir: full, depth: cur.depth + 1 });
          }
          continue;
        }
        if (!ent.isFile()) continue;
        let st;
        try {
          st = await fs.stat(full);
        } catch {
          continue;
        }
        out.push({
          path: full,
          relativePath: path.relative(base, full) || ent.name,
          size: st.size,
          mtimeMs: st.mtimeMs
        });
      }
    }
    out.sort((a, b) => Number(b.mtimeMs || 0) - Number(a.mtimeMs || 0));
    return { base, files: out.slice(0, max) };
  }


  const extractedHandlers = createExtractedHandlers({
    perms,
    requireRustCore,
    projectMemoryScope,
    sqlSvc,
    assertHostEnabled,
    assertSqlEnabled,
    assertWebFetchEnabled,
    webFetch,
    ctx,
    plugins,
    syncRemoteIndexCoreConfig,
    waitRemoteIndexCoreReady,
    resolveCodebaseContext,
    healRemoteAgentTransport:
      typeof ctx.healRemoteAgentTransport === 'function' ? ctx.healRemoteAgentTransport : null,
    REMOTE_INDEX_PREP_TIMEOUT_MS,
    invokeIndexCore,
    startCodebaseIndexForContext,
    codebaseHasSearchableIndex,
    startGraphIndexForContext,
    scheduleGraphLspEnrich,
    getActiveEmbeddingConfig,
    assertGraphIndexReady,
    runGraphLspEnrich,
    resolveGraphSymbolCallersAndIngest,
    getRemoteFs,
    resolveHostSidecarLocalPath,
    sidecarReadOpts,
    readSidecarFileAt,
    readAllowedTextFile,
    listAllowedArtifactFiles,
    lspDiagnostics,
    normalizeFilePathInput,
    cwdForCall,
    assertAllowedPath,
    readRootsForCall,
    isSshConnectedForCall,
    resolveSshManager,
    requireSshForCall,
    defaultCwd,
    getWorkspaceGitDiffContext,
    getWorkspaceGitChangedAbsPaths,
    currentSshWorkspaceRoot,
    writeRootsForCall,
    invokeRustCore,
    captureUndoWrite,
    graphIncremental,
    codebaseIncremental,
    summarizeLineDiff,
    runEditFile,
    listSidecarDirAt,
    getRemoteAgentInfo,
    getRemoteAgentClient,
    grepViaRemoteExec,
    grepWorkspace,
    globViaRemoteExec,
    globWorkspace,
    validateShellCommand,
    resolveCallWorkspaceTarget,
    normalizeRemotePath,
    runShellDetached,
    runShell,
    getActiveCallSessionId,
    probeHostEnvironment,
    openExternalUrl,
    printImage,
    assertBrowserEnabled,
    resolveBrowserNavigateUrl,
    parseRemotePreviewTarget,
    sshTargetKey,
    portForwardManager,
    browser,
    roots,
    writable,
    turnUndo,
    getActiveRunWorkspaceRoot,
    captureRemoteGitWorkingBaseline,
    captureGitWorkingBaseline,
    mergeBaselineFilesInto,
    isGitRepo,
    workspaceRootForUndo,
    normalizeUndoTouchPaths,
    captureUndoCheckpointSnapshot,
    restoreUndoFilesConcurrent,
    runWithCallContext,
    undoRestoreCallContext
  });

  const handlers = {
    ...extractedHandlers,
    ...playbookHandlers,
    ...wikiHandlers
  };

  setRemoteAgentInvalidateListener(resetRemoteIndexCoreCache);

  return { handlers, runWithWorkspaceRoot, runWithCallContext };
}

module.exports = { createRpcHandlers, assertAllowedPath };
