'use strict';

const fs = require('fs/promises');
const path = require('path');
const {
  runShell,
  runShellDetached,
  listProcessHandles,
  takeSettledReports,
  killProcessHandle,
  readProcessOutput,
  openExternalUrl,
  normalizeFilePathInput,
  printImage
} = require('./host-control');
const webTools = require('./web');
const { assertAllowedPath } = require('./path-policy');
const { decideFsWrite } = require('./sandbox-policy');
const { validateShellCommand } = require('./exec-policy');
const { resolveBrowserNavigateUrl, parseRemotePreviewTarget } = require('../browser/url-policy');
const { createRemoteFsAdapter } = require('./remote-fs');
const { createRemoteAgentFsAdapter } = require('./remote-agent-fs');
const { AsyncLocalStorage } = require('async_hooks');
const { buildSshUri, normalizeRemotePath, parseWorkspaceInput, isSameSshTarget, workspacePathForSession, sshTargetKey, isRemoteWorkspacePath } = require('../workspace/target');
const { remoteAgentInfoKey, remoteIndexCacheKey } = require('../workspace/workspace-cache-keys');
const { resolveIndexRoot } = require('../remote/index-root');
const { resolveIndexVectorsIntent } = require('../model-settings');
const { isGraphSourcePath } = require('../index/source-files');
const { normalizeReadParams, ABSOLUTE_READ_MAX_BYTES } = require('./fs-read-limits');
const { runEditFile } = require('./fs-edit-file');
const {
  scanRecentArtifactFiles,
  createLocalScanIo,
  DEFAULT_ARTIFACT_SCAN_LIMIT
} = require('./artifact-scan');
const { grepWorkspace, globWorkspace, TYPE_EXT } = require('./rg-search');
const {
  getRemoteAgentClient,
  setRemoteAgentInvalidateListener,
  isDisconnectError,
  isRemoteAgentUsable
} = require('./remote-agent-client');
const { shellQuoteSingle, resolveRemotePath, remoteAllowedRoots } = require('../ssh/remote-path');
const { encodeWorktreeContent, WORKTREE_SNAPSHOT_MAX_BYTES } = require('../git/git-target');
const { captureRemoteGitWorkingBaseline } = require('../git/remote-baseline-capture');
const { captureGitWorkingBaseline, mergeBaselineFilesInto } = require('../git/baseline-capture');
const { isGitRepo } = require('../git/worktree-service');
const { getWorkspaceGitDiffContext, getWorkspaceGitChangedAbsPaths } = require('../git/diff-context');
const { resolveHostSidecarLocalPath } = require('../agent/host-sidecar');
// 护栏数字单一来源（AGENTS.md §5）：diff 全文阈值只改 agent-limits。
const { AGENT_LIMITS_DEFAULTS } = require('../agent/agent-limits');

const { createExtractedHandlers } = require('./handlers');
const { resolveCoreRpcTimeoutMs } = require('../core-rpc-timeouts');
const { buildLlmHeadersFromConfig } = require('../agent/llm-request');
const { prepareLineDiff } = require('./line-diff-stats');

function assertHostEnabled(ctx) {
  if (!ctx.permissions.hostControl) {
    const err = new Error('本机控制未启用');
    err.code = 'HOST_DISABLED';
    throw err;
  }
}

const DIFF_FULL_TEXT_CAP = AGENT_LIMITS_DEFAULTS.diffFullTextCap;

function summarizeLineDiff(beforeText, afterText) {
  // 切分与公共前后缀裁剪各只做一次：片段窗口与 +/- 徽标共用同一份结果
  const { before, after, start, beforeEnd, afterEnd, added, removed } = prepareLineDiff(
    beforeText,
    afterText
  );
  const beforeSnippet = before.slice(start, beforeEnd + 1).join('\n');
  const afterSnippet = after.slice(start, afterEnd + 1).join('\n');
  const beforeFull = beforeText == null ? '' : String(beforeText);
  const afterFull = String(afterText || '');
  const includeFullText =
    beforeFull.length <= DIFF_FULL_TEXT_CAP && afterFull.length <= DIFF_FULL_TEXT_CAP;
  // added/removed 走真实逐行 LCS（与 diff 图形同一口径）；
  // 掐头去尾只用于截取变更片段，未变更的中间行不再计入删除
  return {
    added,
    removed,
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
 *   getEmbeddingConfig?: () => object
 *   browser?: import('../browser/service').createBrowserService extends (...args: any[]) => infer R ? R : never | null
 *   computer?: ReturnType<import('../computer/service').createComputerService> | null
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
  const browser = ctx.browser || null;
  const computer = ctx.computer || null;
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
      // 不要用 `[]` 顶替「目录不存在」：空数组在 list_dir 语义里等于「目录是空的」，
      // 模型会据此判「产物没生成」并重新生成一遍。明确报错才可诊断。
      if (err && err.code === 'ENOENT') {
        const e = new Error(
          `目录不存在: ${absPath}（tool-output / terminals 在首次产生大输出或终端会话后才会创建）`
        );
        e.code = 'FS_LIST_FAILED';
        e.path = absPath;
        throw e;
      }
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

  /** 本会话里用户批准过写的目录（档位判定的结果要能被白名单看见，否则批准了还是写不进去）。 */
  function sandboxGrantedWriteRoots() {
    const sandbox = ctx.sandbox;
    if (!sandbox || typeof sandbox.grantedWriteRoots !== 'function') return [];
    return sandbox.grantedWriteRoots(getActiveCallSessionId());
  }

  function writeRootsForCall() {
    return Array.from(new Set([...writable, ...extraLocalRunRoots(), ...sandboxGrantedWriteRoots()]));
  }

  /**
   * 沙箱档位对**文件写操作**的判定（工作区外 → 问一次；read-only → 一律问一次）。
   *
   * 放在这里的原因：`writeRootsForCall()` 是「能写哪儿」的唯一出口，档位判定必须紧挨着它，
   * 否则新加的写 handler 会只受白名单约束、绕过档位。撤销栈回滚（undo apply）刻意不经过这里：
   * 它是用户显式要求的回退，不该再被问一次。
   *
   * @param {string} absPath
   * @param {string} tool
   */
  async function assertSandboxWritable(absPath, tool) {
    const sandbox = ctx.sandbox;
    if (!sandbox) {
      // fail-closed：沙箱没装配好时不能把"检查不到"当成"允许写"
      const e = new Error('沙箱未就绪，已拒绝写入（请重启应用；装配问题不该变成静默放行）');
      e.code = 'SANDBOX_UNAVAILABLE';
      e.retryable = false;
      throw e;
    }
    const decision = decideFsWrite(absPath, sandbox.context());
    const blocked = await sandbox.guard(decision, {
      tool,
      sessionId: getActiveCallSessionId(),
      path: absPath
    });
    if (!blocked) return;
    const e = new Error(blocked.error);
    e.code = blocked.errorCode;
    e.sandboxMode = blocked.sandboxMode;
    e.retryable = false;
    throw e;
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
    return `${head}，请检查 ~/.dieyun/remote-agent/logs/ 下对应该项目的 agent-*.log`;
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

  /** 远程工作区：仅允许项目内 dieyun-core；不回落本机建库 */
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
      // 单一句：调用/上下文里请求的根，与这条 daemon 连接用 `hello{workspace}` 声明的根，
      // 必须是同一个（那份连接上的 `index.sqlite` 只属于它）。旧实现直接把 ctxInfo.remotePath
      // 写进 payload、把调用方的 workspaceRoot 静默覆盖掉，于是「索引建在 A、查的是 B」
      // 谁也看不出来。这里改成显式比对，错了就报 WORKSPACE_SCOPE_MISMATCH。
      const resolved = resolveIndexRoot({
        explicitRoot: params.workspaceRoot != null ? params.workspaceRoot : ctxInfo.remotePath,
        scopeRoot: info.workspaceRoot || ctxInfo.remotePath,
        label: String(method),
        scopeLabel: '远端 Agent 连接声明的根'
      });
      return client.call(
        method,
        {
          ...params,
          workspaceRoot: resolved.root
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
          // 与本地 _syncRustCoreConfig 同一份字段：缺 headers/authMode 时，远程嵌入请求
          // 只能靠 apiKey 硬拼，自定义头（代理 / 会话头）在远端全部丢失。
          embedding: {
            disabled: !!embedding.disabled,
            baseUrl: embedding.baseUrl || '',
            apiKey: embedding.apiKey || '',
            model: embedding.model || '',
            dimensions: Number(embedding.dimensions) || 1024,
            headers: buildLlmHeadersFromConfig(embedding),
            authMode: String(embedding.authMode || '').trim()
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
      // 走异步 fs：这里在 captureUndoCheckpointSnapshot 里按 8 路并发跑，
      // 同步读会把整批「假并发」压回主线程串行，一次回滚审查要卡住界面。
      let st;
      try {
        st = await fs.stat(safe);
      } catch {
        // 不存在（existsSync 为 false）时原实现直接给 before:null
        return { before: null, encoding: enc, remote: false };
      }
      if (!st.isFile()) {
        return { before: null, encoding: enc, remote: false };
      }
      const buf = await fs.readFile(safe);
      if (buf.length > WORKTREE_SNAPSHOT_MAX_BYTES) {
        return {
          before: meta && meta.before != null ? String(meta.before) : null,
          encoding: meta && meta.encoding === 'base64' ? 'base64' : 'utf8',
          remote: false
        };
      }
      // 二进制判定 / 编码落档统一走 git-target（与回合基线、Plan 回写快照同口径）
      return { ...encodeWorktreeContent(buf), remote: false };
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
        try {
          const st = await fs.stat(safe);
          if (st.isDirectory()) await fs.rm(safe, { recursive: true, force: true });
          else await fs.unlink(safe);
        } catch (err) {
          // 已经不在了：撤回目标不存在不算失败（原来 existsSync 为 false 时同样静默返回）
          if (!err || err.code !== 'ENOENT') throw err;
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

  /**
   * glob → 系统 grep 的 --include 片段。
   * GNU grep 的 --include 只按 basename 匹配，`src/**\/*.js` 这类带目录的 glob 会 0 命中，
   * 所以额外把「无通配符的目录前缀」提出来当搜索目标。
   */
  function grepGlobParts(glob) {
    const g = String(glob || '')
      .replace(/\\/g, '/')
      .trim();
    if (!g) return { include: '', dirHint: '' };
    const segs = g.split('/').filter((s) => s && s !== '.');
    if (!segs.length) return { include: '', dirHint: '' };
    const dirSegs = segs.slice(0, -1);
    const dirHint =
      dirSegs.length && !dirSegs.some((s) => /[*?[\]]/.test(s)) ? dirSegs.join('/') : '';
    return { include: segs[segs.length - 1], dirHint };
  }

  /**
   * 远程 grep。与本地 fs.grep 对齐：优先 ripgrep（-F/-i/-g/-t/-U/-A/-B 语义同源），
   * 远端没有 rg 时才退系统 grep（-F | -E | BRE + --include）。
   * 关键：不再用 2>/dev/null 吞错，并用 PIPESTATUS 取回管道首位命令的退出码——
   * 「无命中（1）」与「命令根本没跑起来（127/2）」必须分开，否则一律报成「0 命中」。
   */
  async function grepViaRemoteExec(cwd, opts) {
    const o = opts || {};
    const n = Math.min(200, Math.max(1, Number(o.maxResults) || 50));
    // 与 rg-search.resolveGrepContext 同规则：context 是双向快捷方式，before/after 显式给出时覆盖它
    const clampCtx = (v) => {
      const num = Number(v);
      return Number.isFinite(num) && num > 0 ? Math.min(10, Math.floor(num)) : 0;
    };
    const ctxBoth = clampCtx(o.context);
    const before = o.beforeContext != null ? clampCtx(o.beforeContext) : ctxBoth;
    const after = o.afterContext != null ? clampCtx(o.afterContext) : ctxBoth;
    const pattern = String(o.pattern || '');
    if (!pattern) return null;
    if (!isSshConnectedForCall()) return null;
    const countOnly = o.count === true;
    const multiline = o.multiline === true;
    const glob = o.glob ? String(o.glob) : '';
    const typeFilter = o.type ? String(o.type).trim().toLowerCase() : '';
    // regex 未显式给出 → 保持 BRE：read_symbol / lsp 的远程降级依赖 BRE（\b、\|）写法；
    // fs.grep 总会传布尔值，正好与本地 -F / rust regex 语义对齐。
    const dialect = o.regex === true ? 'ere' : o.regex === false ? 'literal' : 'bre';
    const timeoutMs = Math.max(5000, Math.min(120000, Number(o.timeoutMs) || 60000));
    const sshCall = requireSshForCall();
    const pat = shellQuoteSingle(pattern);

    // path 限定：read_symbol 的兜底定位需要只搜某个文件，避免全库扫。
    // 远程也复用同一套边界校验，并且仍然下发相对路径（返回的 path 保持相对工作区）。
    let target = '.';
    if (o.path) {
      try {
        // 与 fs / host.exec 共用同一套远程根。
        // 注意：设置页的「完全放开路径限制」是**本地**档位，远端不认这个开关（daemon 只按
        // 工作空间 + HOME + /tmp 校验）。桌面端若在这里放宽，就会出现「SFTP 能写、RPC 写不了」
        // 或「grep 能搜、read 报越界」这种同一开关下两个答案的局面。
        const roots = remoteAllowedRoots(cwd, sshCall.getHomeDir ? sshCall.getHomeDir() : '');
        const abs = resolveRemotePath(String(o.path), roots, cwd);
        target = shellQuoteSingle(path.posix.relative(cwd, abs) || '.');
      } catch (err) {
        return {
          ok: false,
          errorCode: (err && err.code) || 'PATH_OUTSIDE',
          error: (err && err.message) || 'path 必须在工作空间内'
        };
      }
    }

    const runRemote = async (cmd) => {
      try {
        const r = await sshCall.exec(cmd, cwd, timeoutMs);
        return r || { code: -1, stdout: '', stderr: '' };
      } catch (err) {
        return { code: -1, stdout: '', stderr: (err && err.message) || String(err) };
      }
    };
    // exec 走 bash -lc：管道退出码会被 head 顶掉，用 PIPESTATUS[0] 拿回 grep/rg 自己的状态
    const withExit = (cmd) => `${cmd}; exit \${PIPESTATUS[0]}`;
    // head 上限按「每个命中最多带 1+before+after 行」放大：
    // 否则 -A/-B 的上下文行会吃掉配额，maxResults 实际只能返回零头。
    const headN = Math.max(1, n * (1 + before + after));

    // ——— rg（首选，与本地语义一致） ———
    const rgParts = [
      'rg',
      '--no-config',
      '--no-heading',
      '--no-column',
      '--line-number',
      '--color=never',
      '--max-filesize',
      '1M'
    ];
    for (const g of ['!node_modules/**', '!.git/**', '!dist/**', '!target/**']) {
      rgParts.push('--glob', shellQuoteSingle(g));
    }
    if (dialect !== 'ere') rgParts.push('-F');
    if (o.caseInsensitive) rgParts.push('-i');
    if (glob) rgParts.push('-g', shellQuoteSingle(glob));
    if (typeFilter) rgParts.push('-t', shellQuoteSingle(typeFilter));
    if (multiline) rgParts.push('-U', '--multiline-dotall');
    if (countOnly) rgParts.push('--count-matches');
    else {
      if (before > 0) rgParts.push('-B', String(before));
      if (after > 0) rgParts.push('-A', String(after));
    }
    rgParts.push('--', pat, target);
    const rgCmd = `${rgParts.join(' ')} | head -n ${countOnly ? 400 : headN}`;

    // ——— 系统 grep（远端无 rg 时的兜底） ———
    const grepParts = ['grep', '-RIn'];
    if (dialect === 'literal') grepParts.push('-F');
    else if (dialect === 'ere') grepParts.push('-E');
    if (o.caseInsensitive) grepParts.push('-i');
    for (const d of ['.git', 'node_modules', 'dist', 'target']) {
      grepParts.push(`--exclude-dir=${shellQuoteSingle(d)}`);
    }
    let grepTarget = target;
    if (glob) {
      const { include, dirHint } = grepGlobParts(glob);
      if (include) grepParts.push(`--include=${shellQuoteSingle(include)}`);
      if (!o.path && dirHint) grepTarget = shellQuoteSingle(dirHint);
    }
    if (typeFilter && TYPE_EXT[typeFilter]) {
      for (const ext of TYPE_EXT[typeFilter]) {
        grepParts.push(`--include=${shellQuoteSingle(`*${ext}`)}`);
      }
    }
    if (countOnly) grepParts.push('-c');
    else {
      grepParts.push('-m', String(n));
      if (before > 0) grepParts.push('-B', String(before));
      if (after > 0) grepParts.push('-A', String(after));
    }
    const grepCmd = `${grepParts.join(' ')} -- ${pat} ${grepTarget} | head -n ${
      countOnly ? 400 : headN
    }`;

    let usedRg = false;
    let r = null;
    if (dialect !== 'bre') {
      r = await runRemote(withExit(rgCmd));
      const rgMissing =
        r.code === 127 ||
        /command not found|: not found|No such file or directory/i.test(String(r.stderr || ''));
      usedRg = !rgMissing;
    }
    if (!usedRg) {
      if (multiline) {
        return {
          ok: false,
          errorCode: 'MULTILINE_UNSUPPORTED_REMOTE',
          error:
            '远端没有 ripgrep，跨行（multiline）搜索不可用：请去掉 multiline，改用 grep 定位 + fs_read_file 读上下文'
        };
      }
      r = await runRemote(withExit(grepCmd));
    }

    const backend = usedRg ? 'remote_rg' : 'remote_grep';
    const raw = String(r.stdout || '');
    const stderrText = String(r.stderr || '').trim();
    // 真失败（命令缺失 / 参数错 / cwd 不存在）不能伪装成「0 命中」，否则排查成本极高。
    // 退出码 >1 = 命令确实报错；另外认几个「命令没跑起来」的 stderr 特征
    // （exec 的 `cd <cwd> &&` 失败会让退出码停在 1，只能靠 stderr 认出来）。
    const cmdErrorRe = /command not found|unrecognized option|invalid option|usage:|No such file or directory|not a directory/i;
    if (!raw.trim() && (r.code > 1 || cmdErrorRe.test(stderrText))) {
      return {
        ok: false,
        errorCode: 'REMOTE_GREP_FAILED',
        error: `远程 ${usedRg ? 'rg' : 'grep'} 没有返回结果且命令报错（exit ${r.code}）：${
          stderrText.slice(0, 300) || '无 stderr'
        }`
      };
    }

    if (countOnly) {
      let total = 0;
      for (const line of raw.split(/\r?\n/)) {
        const m = line.trim().match(/:(\d+)$/);
        if (m) total += Number(m[1]) || 0;
      }
      return {
        ok: true,
        matches: [],
        count: total,
        truncated: false,
        source: backend,
        countOnly: true
      };
    }

    const matches = parseClassicGrepLines(raw, n, { before, after });
    return { ok: true, matches, truncated: matches.length >= n, source: backend };
  }

  async function globViaRemoteExec(cwd, opts) {
    const o = opts || {};
    const n = Math.min(400, Math.max(1, Number(o.maxResults) || 80));
    // 默认仍是 60s（旧调用点语义不变）；workspace.resolve_path 会传入更紧的预算，
    // 否则一次 glob 就能吃掉「路径解析」整个 10s 上限。
    const timeoutMs = Math.max(3000, Math.min(60000, Number(o.timeoutMs) || 60000));
    const pat = shellQuoteSingle(String(o.pattern || ''));
    const cmd = `rg --files --no-config --glob '!node_modules/**' --glob '!.git/**' -g ${pat} 2>/dev/null | head -n ${n}`;
    let r = null;
    try {
      if (isSshConnectedForCall()) {
        r = await requireSshForCall().exec(cmd, cwd, timeoutMs);
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

  /**
   * 远端文件系统适配器（**唯一出口**）：调用方只看这个方法，不关心底下是哪种传输。
   *
   *  - 远端 Agent 在（P2 的 SSH `direct-streamlocal` 通道）→ 走 RPC：写路径与远端自己的
   *    `fs.write_file` 合一，diff 与增量索引都在远端算（不再「整读一遍 + 写完补通知」）；
   *  - 没装 Agent 的会话（`sshBackend === 'sftp'`）→ 走 SFTP：仍要能读写文件。
   *
   * 两个实现是同一个接口（`remote-fs.js` / `remote-agent-fs.js`），所以「用哪个」只在这里判断一次。
   */
  function getRemoteFs() {
    const target = resolveCallWorkspaceTarget();
    if (!target) return null;
    if (target.kind !== 'ssh') return null;
    const sshCall = requireSshForCall();
    const st = sshCall.status();
    // 兜底根 <HOME>/.dieyun/workspace：与本地默认 workspace 对称，保证远程也有一个
    // 「工作空间之外但稳定可写」的落脚点（截图/临时产物）。HOME 由 ssh 层连接时缓存。
    const homeDir = typeof sshCall.getHomeDir === 'function' ? sshCall.getHomeDir() : '';
    const targetDesc = {
      kind: 'ssh',
      host: st.host,
      port: st.port,
      username: st.username,
      remotePath: target.remotePath
    };
    const opts = {
      // 远端根只由**一份规则**决定（`remoteAllowedRoots`）：工作空间 + 远端 HOME + /tmp。
      // 设置页的「完全放开路径限制」是本地档位，远端 daemon 不认它 —— 桌面端在这里放宽
      // 只会让 SFTP 传输放宽、RPC 传输仍被 daemon 拒（同一操作两个答案），所以两边都不放宽。
      roots: remoteAllowedRoots(target.remotePath, homeDir)
    };
    const agentInfo = getRemoteAgentInfo();
    if (isRemoteAgentUsable(agentInfo)) {
      return createRemoteAgentFsAdapter(agentInfo, targetDesc, opts);
    }
    return createRemoteFsAdapter(sshCall, targetDesc, opts);
  }

  function resolveCodebaseContext(workspaceRoot) {
    const target = resolveCallWorkspaceTarget();
    if (target && target.kind === 'ssh') {
      if (!isSshConnectedForCall()) {
        const e = new Error('SSH 未连接，无法索引或检索远程 Codebase');
        e.code = 'SSH_NOT_CONNECTED';
        throw e;
      }
      // 显式根与作用域根在这里合一：以前这一步把 `workspaceRoot` 直接丢掉，
      // 于是「调用方要 A、实际索引 B」从来不会报错（见 src/remote/index-root.js）。
      const resolved = resolveIndexRoot({
        explicitRoot: workspaceRoot,
        scopeRoot: target.remotePath,
        label: 'Codebase',
        scopeLabel: '本次调用的会话作用域根'
      });
      return {
        kind: 'remote',
        rootKey: buildSshUri({ ...target, remotePath: resolved.root }),
        remotePath: resolved.root,
        rootSource: resolved.source
      };
    }
    const input =
      workspaceRoot || (target && target.kind === 'local' ? target.path : null) || cwdForCall();
    if (!input) {
      const e = new Error('未选择工作空间');
      e.code = 'WORKSPACE_REQUIRED';
      throw e;
    }
    // 远端 URI 只认上面那条「本次调用解析到了 SSH 目标」的路。落到这里说明作用域里
    // 没有远端目标，此时 path.resolve 只会得到 `E:\...\ssh:user@host:\path` 这种永远
    // 不存在的键：索引面板会把它当成真工作区，于是恒显示「未建立 / 0 / 从未构建」，
    // 而 agent 侧其实在远端正常的库里检索。宁可报错，不许静默查一个假目标。
    if (isRemoteWorkspacePath(input)) {
      const e = new Error(
        `远端工作区缺少可用的 SSH 作用域，无法索引/检索：${String(input).slice(0, 160)}`
      );
      e.code = 'REMOTE_TARGET_UNRESOLVED';
      e.retryable = false;
      e.suggestedFix =
        '不要重试；调用方需带上会话作用域（sessionId + runWorkspaceRoot），或先连接远端 Agent。';
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

  /** computer 工具总开关：hostControl 之下再要 osControl（默认开，设置页可关掉）。 */
  function assertOsControlEnabled() {
    assertHostEnabled(ctx);
    if (!perms.osControl) {
      const e = new Error('电脑控制未启用：请在 设置 → 权限 打开「启用电脑控制」');
      e.code = 'OS_CONTROL_DISABLED';
      e.retryable = false;
      e.suggestedFix = '不要重试；告知用户到设置页开启电脑控制后再继续。';
      throw e;
    }
    if (!computer) {
      const e = new Error('电脑控制服务未初始化');
      e.code = 'COMPUTER_UNAVAILABLE';
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
    const st = await invokeIndexCore(ctxInfo, 'graph.status', {}, 45000);
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
      // core 自己都说「没在索引」⇒ 内存里那条记录是残留（进程内不会自己清），丢掉它继续起新的。
      // 否则一次卡死的构建会把「重建」挡到进程重启为止（2026-11-09 真机踩到：
      // `alreadyRunning: true` 但 core 早就停了、索引是空的）。
      if (st && st.indexing === false) {
        existing.settled = true;
        jobsMap.delete(rootKey);
      } else {
        return { started: false, alreadyRunning: true, job: existing, ...st };
      }
    }

    const force = !!opts.force;
    const skipIfReady = opts.skipIfReady !== false;
    // 向量（codebase）与调用图（graph）都是显式 opt-in；codebase 的**缺省**来自持久意图
    // `indexSemanticSearch`（设置 →「代码索引语义检索」）。以前这里写死 `!!opts.vectors`，
    // 而 prep/agent 路径从来不传这个参数 → 无论用户怎么想，索引里永远 0 向量。
    const vectors = isGraph ? undefined : resolveIndexVectorsIntent(ctx.userDataPath, opts.vectors);
    // 建向量前把 embedding 端点配置推到**这次调用要用的那条连接**上。
    //
    // 远端 daemon 每个工作区一份 core host（乙案：每个会话一个 worktree）。新工作区的 host
    // 冷启动时没有任何配置，而 `invokeIndexCore` 只看「core 已就绪」缓存、命中就跳过 configure，
    // 于是建向量必然回 `EMBEDDING_NOT_CONFIGURED`（真机实测：手动调一次 index.remote_sync_configure
    // 后同一工作区立刻 embeddingEnabled=true）。configure 是幂等的一句话，不是重试层。
    if (!isGraph && vectors && ctxInfo.kind === 'remote') {
      await syncRemoteIndexCoreConfig();
    }
    const calls = isGraph ? !!opts.calls : undefined;
    const startParams = isGraph ? { force, skipIfReady, calls } : { force, skipIfReady, vectors };

    let startResult;
    try {
      startResult = await invokeIndexCore(ctxInfo, startMethod, startParams, 60000);
    } catch (err) {
      const msg = err && err.message ? String(err.message) : String(err);
      const code = err && err.code ? String(err.code) : '';
      const missing =
        code === 'REMOTE_INDEX_UNSUPPORTED' ||
        /unknown method|Method not found|不支持的方法/i.test(msg);
      if (!missing) throw err;
      const syncParams = { force: true };
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
    if (!rel || rel.startsWith('../') || !isGraphSourcePath(rel)) return null;
    return {
      callerPath: rel,
      line: Number(m[2]) || 1,
      text: m[4] || ''
    };
  }

  /**
   * 远程搜索调用方的传输选择。
   *
   * 三种返回值必须分清，不许糊成一种：
   *   - `null`            ：这条通道走不通（没连、没权限）→ 调用方可以退到下一层；
   *   - `{ error }`       ：命令真跑了但失败（超时 / 非零退出）→ 原样上报，不许当「没匹配」；
   *   - `{ code, stdout }`：命令跑完，按 rg/grep 语义（0/1 都是「成功查询」）。
   */
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
      } catch (err) {
        // 带 code 的是「远端执行失败」，换个传输重跑一遍只会重复同样的失败
        if (err && err.code) {
          return {
            error: String(err.code),
            message: String((err && err.message) || err),
            mode: 'remote_agent_exec'
          };
        }
        // 没 code：隧道没起来，退到 SSH
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
    } catch (err) {
      return {
        error: String((err && err.code) || 'SSH_EXEC_FAILED'),
        message: String((err && err.message) || err),
        mode: 'ssh_rg'
      };
    }
  }

  async function resolveRemoteGraphCallers(ctxInfo, symbol, timeoutMs) {
    const name = String(symbol?.name || '').trim();
    if (!name) {
      return { ok: false, error: 'symbol_name_required', mode: 'ssh_rg', sites: [] };
    }
    const regex = `\\b${escapeRegExp(name)}\\s*\\(`;
    // rg / grep 的退出码是有语义的：0=有匹配，1=没匹配，≥2=真出错（找不到路径、权限、
    // 二进制损坏…）。以前每条命令都挂 `|| true`，把三者压成同一个 0，于是下面那条
    // 「非 0 就报错」的分支永远走不到 —— 「搜不到调用方」和「搜索根本没跑成」长得一样。
    const script = [
      'if command -v rg >/dev/null 2>&1; then',
      `  rg -n --column --no-heading --color never -S -g '!node_modules/**' -g '!vendor/**' -g '!dist/**' -g '!build/**' -g '!target/**' -g '!coverage/**' -g '!*.min.js' ${shellQuoteSingle(regex)} .`,
      '  rc=$?',
      'else',
      `  grep -RInF --exclude-dir=.git --exclude-dir=node_modules --exclude-dir=vendor --exclude-dir=dist --exclude-dir=build --exclude-dir=target --exclude-dir=coverage ${shellQuoteSingle(name)} .`,
      '  rc=$?',
      'fi',
      'case $rc in 0) exit 0 ;; 1) exit 0 ;; *) exit $rc ;; esac'
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
    if (r.error) {
      return {
        ok: false,
        error: r.message || r.error,
        code: r.error,
        mode: r.mode,
        sites: []
      };
    }
    if (r.code != null && Number(r.code) !== 0) {
      return {
        ok: false,
        error: r.stderr || `remote_rg_exit_${r.code}`,
        code: `REMOTE_RG_EXIT_${Number(r.code)}`,
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

  /**
   * 工作区里「按 mtime 窗口」的文件清单（产物区用）。
   *
   * 遍历、深度与排除表都在 artifact-scan.js（本地 / SFTP / 远程 Agent 共用同一份），
   * 这里只负责「把外部路径钉进白名单」这一层。
   */
  async function listAllowedArtifactFiles(dirPath, limit, opts) {
    const baseInput = dirPath || defaultCwd;
    const resolved = normalizeFilePathInput(baseInput, defaultCwd);
    const base = assertAllowedPath(resolved, Array.from(new Set([...roots, ...writable])));
    return scanRecentArtifactFiles(createLocalScanIo(), {
      base,
      sinceMs: opts && opts.sinceMs,
      limit: limit || DEFAULT_ARTIFACT_SCAN_LIMIT,
      maxDepth: opts && opts.maxDepth
    });
  }


  const extractedHandlers = createExtractedHandlers({
    perms,
    requireRustCore,
    assertHostEnabled,
    assertWebFetchEnabled,
    webTools,
    ctx,
    syncRemoteIndexCoreConfig,
    waitRemoteIndexCoreReady,
    resolveCodebaseContext,
    healRemoteAgentTransport:
      typeof ctx.healRemoteAgentTransport === 'function' ? ctx.healRemoteAgentTransport : null,
    REMOTE_INDEX_PREP_TIMEOUT_MS,
    invokeIndexCore,
    startCodebaseIndexForContext,
    // 同一条判定既给 start 路径（内部）也给老 daemon 的同步路径（handler）用
    resolveIndexVectors: (explicit) => resolveIndexVectorsIntent(ctx.userDataPath, explicit),
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
    assertSandboxWritable,
    sandbox: ctx.sandbox || null,
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
    listProcessHandles,
    takeSettledReports,
    killProcessHandle,
    readProcessOutput,
    getActiveCallSessionId,
    openExternalUrl,
    printImage,
    assertBrowserEnabled,
    assertOsControlEnabled,
    resolveBrowserNavigateUrl,
    parseRemotePreviewTarget,
    sshTargetKey,
    portForwardManager,
    browser,
    computer,
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
    ...extractedHandlers
  };

  setRemoteAgentInvalidateListener(resetRemoteIndexCoreCache);

  return { handlers, runWithWorkspaceRoot, runWithCallContext };
}

module.exports = { createRpcHandlers, assertAllowedPath };
