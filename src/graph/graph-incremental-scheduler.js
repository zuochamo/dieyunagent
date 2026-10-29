'use strict';

const path = require('path');
const { loadModelSettings } = require('../model-settings');
const { isGraphSourcePath, isUnderWorkspaceRoot } = require('../index/source-files');

/**
 * 去抖窗口必须**大于 watcher 的事件延迟**，否则同一次保存会被算成两次。
 *
 * 一次保存有两个来源都会调 `notifyFileSaved`：
 * 1. `handlers/fs.js` 里工具写完主动上报（即时）；
 * 2. `gateway/server.js` 的 `createWorkspaceIndexWatcher`（`fs.watch`，外部改动也要覆盖，延迟实测约 3s）。
 *
 * 两者都保留是必要的（远程/未 watch 时工具上报是唯一来源，外部编辑器改动只有 watcher 看得到），
 * 但 800ms 窗口合并不上，实测 `main.log` 里 `(save)` 成对出现且间隔卡在 3.2s / 1.2s 双峰 ——
 * 等于每次保存把整图增量跑两遍。3500ms 让第二来源落进同一窗口，代价是索引晚 3.5s 启动，
 * 而它本来就是后台任务。
 */
const DEFAULT_DEBOUNCE_MS = 3500;
const WORKSPACE_OPEN_DEBOUNCE_MS = 1500;
const RETRY_DELAY_MS = 2000;
const CODEBASE_BUSY_RETRY_MS = 5000;
/** 与 codebase 侧同构：`!indexed` 时每工作区 10 分钟一条日志，避免「静默不跑」无从判断。 */
const NOT_INDEXED_LOG_THROTTLE_MS = 10 * 60 * 1000;

/**
 * Debounced background graph.index (force=false) after saves / workspace open.
 *
 * @param {{
 *   userDataPath: string,
 *   getWorkspaceRoot: () => string | null,
 *   isRemoteWorkspace: () => boolean,
 *   invokeRustCore: (method: string, params: object, timeoutMs?: number) => Promise<object | null>,
 *   log?: (msg: string) => void,
 *   debounceMs?: number,
 * }} opts
 */
function createGraphIncrementalScheduler(opts) {
  const debounceMs = opts.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const log = typeof opts.log === 'function' ? opts.log : () => {};
  /** @type {Map<string, ReturnType<typeof setTimeout>>} */
  const timers = new Map();
  /** @type {Set<string>} */
  const queuedAfterBusy = new Set();
  /** @type {Map<string, number>} 最近一次「未建初始结构索引」跳过日志的时间（节流用） */
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
    return settings.graphAutoIncremental !== false;
  }

  async function isCodebaseIndexing(workspaceRoot) {
    try {
      const st = await opts.invokeRustCore('codebase.status', { workspaceRoot }, 15000);
      return !!(st && st.indexing);
    } catch {
      return false;
    }
  }

  async function runIncremental(workspaceRoot, reason) {
    if (!workspaceRoot) return;
    if (!isAutoEnabled()) return;

    try {
      if (await isCodebaseIndexing(workspaceRoot)) {
        queuedAfterBusy.add(workspaceRoot);
        schedule(workspaceRoot, CODEBASE_BUSY_RETRY_MS, reason);
        return;
      }

      const st = await opts.invokeRustCore('graph.status', { workspaceRoot }, 30000);
      if (!st || !st.indexed) {
        logSkipThrottled(
          workspaceRoot,
          `[graph] incremental index idle: 尚未建立结构索引，增量不代建（${workspaceRoot}）`
        );
        return;
      }
      if (st.indexing) {
        queuedAfterBusy.add(workspaceRoot);
        schedule(workspaceRoot, RETRY_DELAY_MS, reason);
        return;
      }

      // 用 index.start 后台增量，避免同步 graph.index 堵死 stdio
      const result = await opts.invokeRustCore(
        'graph.index.start',
        { workspaceRoot, force: false, skipIfReady: false },
        60000
      );
      if (!result) {
        log(`[graph] incremental index skipped: start returned empty`);
        return;
      }
      // 带上 root：多工作区并行时，「两条 (save) 相隔 1.5s」到底是重复触发还是两个工作区，
      // 靠这一行就能判断（此前只有 reason，无法区分）。
      log(`[graph] incremental index started (${reason || 'save'}) root=${workspaceRoot}`);
    } catch (err) {
      log(`[graph] incremental index skipped: ${err && (err.message || err)}`);
    } finally {
      if (queuedAfterBusy.has(workspaceRoot)) {
        queuedAfterBusy.delete(workspaceRoot);
      }
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

  function resolveWorkspaceRoot(override) {
    const raw =
      override != null && String(override).trim()
        ? String(override).trim()
        : opts.getWorkspaceRoot();
    if (!raw) return null;
    return path.resolve(raw);
  }

  function notifyFileSaved(absPath, workspaceRootOverride) {
    const root = resolveWorkspaceRoot(workspaceRootOverride);
    if (!root) return;
    if (!workspaceRootOverride && opts.isRemoteWorkspace()) return;
    if (!isGraphSourcePath(absPath)) return;
    if (!isUnderWorkspaceRoot(absPath, root)) return;
    schedule(root, debounceMs, 'save');
  }

  function notifyWorkspaceOpened(workspaceRootOverride) {
    const root = resolveWorkspaceRoot(workspaceRootOverride);
    if (!root) return;
    if (!workspaceRootOverride && opts.isRemoteWorkspace()) return;
    schedule(root, WORKSPACE_OPEN_DEBOUNCE_MS, 'workspace');
  }

  return {
    notifyFileSaved,
    notifyWorkspaceOpened
  };
}

module.exports = {
  createGraphIncrementalScheduler
};
