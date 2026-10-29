'use strict';

const path = require('path');
const { loadModelSettings } = require('../model-settings');
const { isCodebaseSourcePath, isUnderWorkspaceRoot } = require('./source-files');
const { isRemoteWorkspacePath } = require('../workspace/target');

/**
 * 与 `graph-incremental-scheduler.js` 同构：一次保存有「工具主动上报 + watcher」两个来源，
 * 窗口必须大于 watcher 延迟（实测约 3s），否则同一笔改动会把增量索引跑两遍。
 */
const DEFAULT_DEBOUNCE_MS = 3500;
const WORKSPACE_OPEN_DEBOUNCE_MS = 1500;
/**
 * `!indexed` / `vectorCount === 0` 都是正常状态，不是故障：
 * 增量只维护**已经有向量**的索引。没有向量时 chunk 表对检索毫无贡献（R2 之后连 FTS 也没有），
 * 因此「保持新鲜」没有意义 —— 等真正需要向量时一次建库即可。
 * 原来的实现静默 return，日志里只剩 graph 一侧在跑，容易被误判成「codebase 增量坏了」，
 * 所以每个工作区 10 分钟记一条，既能诊断又不会刷屏。
 */
const NOT_INDEXED_LOG_THROTTLE_MS = 10 * 60 * 1000;

/**
 * Debounced background codebase.index (force=false, mtime 增量) after saves / workspace open.
 *
 * **只处理本地工作区**：增量跑的是本地 dieyun-core，输入必须是本地目录。远程工作区的索引
 * 由远端 agent 自己维护，本地这一侧连 `fs.watch` 都不该挂（判定在 `resolveWorkspaceRoot`，
 * 见那里的注释）。
 *
 * @param {{
 *   userDataPath: string,
 *   getWorkspaceRoot: () => string | null,
 *   invokeRustCore: (method: string, params: object, timeoutMs?: number) => Promise<object | null>,
 *   log?: (msg: string) => void,
 *   debounceMs?: number,
 * }} opts
 */
function createCodebaseIncrementalScheduler(opts) {
  const debounceMs = opts.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const log = typeof opts.log === 'function' ? opts.log : () => {};
  /** @type {Map<string, ReturnType<typeof setTimeout>>} */
  const timers = new Map();
  /** @type {Map<string, number>} 最近一次「保存触发了刷新意图」的时间 */
  const lastSavedAt = new Map();
  /** @type {Map<string, number>} 最近一次「未建初始索引」跳过日志的时间（节流用） */
  const notIndexedLoggedAt = new Map();

  function logSkipThrottled(key, msg) {
    const now = Date.now();
    const prev = notIndexedLoggedAt.get(key) || 0;
    if (prev && now - prev < NOT_INDEXED_LOG_THROTTLE_MS) return;
    notIndexedLoggedAt.set(key, now);
    log(msg);
  }

  function isAutoEnabled() {
    const settings = loadModelSettings(opts.userDataPath);
    return settings.codebaseAutoIncremental === true;
  }

  async function runIncremental(workspaceRoot, reason) {
    if (!workspaceRoot) return;
    if (!isAutoEnabled()) return;

    try {
      const st = await opts.invokeRustCore('codebase.status', { workspaceRoot }, 15000);
      if (!st) {
        log(`[codebase] incremental index skipped: status unavailable`);
        return;
      }
      if (!st.indexed) {
        logSkipThrottled(
          workspaceRoot,
          `[codebase] incremental index idle: 尚未建立初始索引，增量不代建（${workspaceRoot}）` +
            '——恢复方式是先在「代码索引」面板建立一次（或在「设置 → 权限」打开自动增量）'
        );
        return;
      }
      if (!(Number(st.vectorCount) > 0)) {
        logSkipThrottled(
          workspaceRoot,
          `[codebase] incremental index idle: 该工作区没有向量，先不维护新鲜度（${workspaceRoot}）` +
            '——需要语义检索时在面板建一次向量，之后增量才会接管'
        );
        return;
      }
      // 索引正在跑时不再排队重试：保存是高频事件，重试风暴比「这次不增量」更贵。
      // 下一次保存/打开工作区自然会再触发一次。
      if (st.indexing) {
        logSkipThrottled(
          workspaceRoot,
          `[codebase] incremental index skipped: 索引正在运行，本次保存不排队（${workspaceRoot}）`
        );
        return;
      }

      // 用 index.start 后台增量，避免同步 codebase.index 堵死 dieyun-core stdio。
      //
      // `vectors: true` 是**沿用这个工作区已有的向量意图**（上面已经确认过 `vectorCount > 0`
      // 才走到这里）：增量会按文件删掉旧 chunk，连它们的向量一起没了；不跟着补，改过的文件
      // 从此只能靠子串召回，向量覆盖率只会一路往下掉 —— 而这行日志承诺的正是「增量接管」。
      // 端点后来被关掉时退回不带向量（增量照跑，向量留原样），否则每次保存都会撞
      // EMBEDDING_NOT_CONFIGURED，连 chunk 新鲜度也一起丢掉。
      const wantVectors = Number(st.vectorCount) > 0 && st.embeddingEnabled !== false;
      const result = await opts.invokeRustCore(
        'codebase.index.start',
        { workspaceRoot, force: false, skipIfReady: false, vectors: wantVectors },
        60000
      );
      if (!result) {
        log(`[codebase] incremental index skipped: start returned empty`);
        return;
      }
      log(`[codebase] incremental index started (${reason || 'save'}) root=${workspaceRoot}`);
    } catch (err) {
      log(`[codebase] incremental index skipped: ${err && (err.message || err)}`);
    }
  }

  function schedule(workspaceRoot, delayMs, reason) {
    if (!workspaceRoot) return;
    const key = path.resolve(workspaceRoot);
    const prev = timers.get(key);
    if (prev) clearTimeout(prev);
    timers.set(
      key,
      setTimeout(() => {
        timers.delete(key);
        void runIncremental(key, reason);
      }, delayMs ?? debounceMs)
    );
  }

  /**
   * 增量索引只认本地路径 —— 这一条必须在这里判，不能靠调用方记着别传远程。
   *
   * 调用方传进来的 root 有两种来源：watcher/工具上报（本地）与 RPC 的 `workspaceRoot`
   * 原值（远端会话时是 `ssh://…`）。后者若漏进来，`path.resolve` 会把 URI 变成一个
   * 根本不存在的本地目录（实测 `E:\…\ssh:user@host:\path`），于是 `fs.watch` 只剩 ENOENT、
   * `codebase.status` 只剩 "status unavailable" —— 全是噪声，还挡住真正的诊断信号。
   */
  function resolveWorkspaceRoot(override) {
    const raw =
      override != null && String(override).trim()
        ? String(override).trim()
        : opts.getWorkspaceRoot();
    if (!raw) return null;
    if (isRemoteWorkspacePath(raw)) return null;
    return path.resolve(raw);
  }

  function notifyFileSaved(absPath, workspaceRootOverride) {
    const root = resolveWorkspaceRoot(workspaceRootOverride);
    if (!root) return;
    if (!isCodebaseSourcePath(absPath)) return;
    if (!isUnderWorkspaceRoot(absPath, root)) return;
    lastSavedAt.set(root, Date.now());
    schedule(root, debounceMs, 'save');
  }

  function notifyWorkspaceOpened(workspaceRootOverride) {
    const root = resolveWorkspaceRoot(workspaceRootOverride);
    if (!root) return;
    schedule(root, WORKSPACE_OPEN_DEBOUNCE_MS, 'workspace');
  }

  /**
   * 供 status / prep 判断「刚保存过、索引可能还没跟上」。
   * pending 为防抖窗口内（索引尚未启动），lastSavedAt 用于判断新鲜度。
   */
  function getRefreshState(workspaceRootOverride) {
    const root = resolveWorkspaceRoot(workspaceRootOverride);
    if (!root) return null;
    return {
      pending: timers.has(root),
      lastSavedAt: lastSavedAt.get(root) || 0
    };
  }

  return {
    notifyFileSaved,
    notifyWorkspaceOpened,
    getRefreshState
  };
}

module.exports = {
  createCodebaseIncrementalScheduler
};
