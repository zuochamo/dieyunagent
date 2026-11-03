'use strict';

const path = require('path');
const { loadModelSettings } = require('../model-settings');
const { isUnderWorkspaceRoot } = require('./source-files');
const { isRemoteWorkspacePath } = require('../workspace/target');

/**
 * 去抖窗口必须**大于 watcher 的事件延迟**，否则同一次保存会被算成两次。
 *
 * 一次保存有两个来源都会调 `notifyFileSaved`：
 * 1. `handlers/fs.js` 里工具写完主动上报（即时）；
 * 2. `gateway/server.js` 的 `createWorkspaceIndexWatcher`（`fs.watch`，外部改动也要覆盖，延迟实测约 3s）。
 *
 * 两者都保留是必要的（远程/未 watch 时工具上报是唯一来源，外部编辑器改动只有 watcher 看得到），
 * 但 800ms 窗口合并不上，实测 `main.log` 里 `(save)` 成对出现且间隔卡在 3.2s / 1.2s 双峰 ——
 * 等于每次保存把整份增量跑两遍。3500ms 让第二来源落进同一窗口，代价是索引晚 3.5s 启动，
 * 而它本来就是后台任务。**代码索引与结构索引共用这一个窗口**：两个调度器同源同因，
 * 分开写就会出现「改一边忘另一边」。
 */
const DEFAULT_DEBOUNCE_MS = 3500;
const WORKSPACE_OPEN_DEBOUNCE_MS = 1500;
/**
 * `!indexed`（以及 codebase 侧的 `vectorCount === 0`）都是正常状态，不是故障。
 * 原来的实现静默 return，日志里什么都不剩，容易被误判成「增量坏了」，
 * 所以每个工作区 10 分钟记一条：既能诊断又不会刷屏。
 */
const NOT_INDEXED_LOG_THROTTLE_MS = 10 * 60 * 1000;

/**
 * 增量索引调度器工厂 —— **去抖、节流、远程工作区判定、定时器回收只在这里实现一次**。
 *
 * 两个调用方（`index/codebase-incremental-scheduler.js` 与 `graph/graph-incremental-scheduler.js`）
 * 此前各写了一份逐字相同的骨架：同名的 `timers` / `notIndexedLoggedAt` / `schedule`
 * / `resolveWorkspaceRoot` / `notifyFileSaved` / `notifyWorkspaceOpened`，只有「开关名、
 * 状态判定、启动哪个 RPC」三处不同。骨架重复的代价是「去抖窗口/远程判定/清理」这类
 * 共性缺陷要修两遍（历史上 3500ms 窗口就是只改了一边）。
 *
 * 因此这里只保留**机制**，把差异收进策略对象的三个方法：
 * - `isAutoEnabled(settings)`：读哪个开关、默认开还是关（graph 默认开、codebase 默认关）；
 * - `isSourcePath(abs)`：哪些文件值得触发（两份 source-files 口径各自成表）；
 * - `decide(ctx)`：查状态后给出「跳过 / 稍后重试 / 现在启动哪个 RPC」。
 *
 * @param {{
 *   tag: 'graph'|'codebase',
 *   userDataPath: string,
 *   getWorkspaceRoot: () => string | null,
 *   invokeRustCore: (method: string, params: object, timeoutMs?: number) => Promise<object | null>,
 *   log?: (msg: string) => void,
 *   debounceMs?: number,
 *   trackSavedAt?: boolean,
 *   isAutoEnabled: (settings: object) => boolean,
 *   isSourcePath: (absPath: string) => boolean,
 *   decide: (ctx: {
 *     workspaceRoot: string,
 *     reason: string,
 *     invokeRustCore: (method: string, params: object, timeoutMs?: number) => Promise<object | null>,
 *     log: (msg: string) => void,
 *     logSkipThrottled: (msg: string) => void,
 *   }) => Promise<null | { action: 'retry', delayMs: number } | { action: 'run', method: string, params: object, timeoutMs?: number }>,
 * }} opts
 */
function createIncrementalScheduler(opts) {
  const tag = opts.tag;
  const debounceMs = opts.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const log = typeof opts.log === 'function' ? opts.log : () => {};
  /** @type {Map<string, ReturnType<typeof setTimeout>>} */
  const timers = new Map();
  /** @type {Map<string, number>} 最近一次「保存触发了刷新意图」的时间（仅 trackSavedAt） */
  const lastSavedAt = new Map();
  /** @type {Map<string, number>} 最近一次「跳过」日志的时间（节流用） */
  const skippedLoggedAt = new Map();

  function logSkipThrottled(workspaceRoot, msg) {
    const now = Date.now();
    const prev = skippedLoggedAt.get(workspaceRoot) || 0;
    if (prev && now - prev < NOT_INDEXED_LOG_THROTTLE_MS) return;
    skippedLoggedAt.set(workspaceRoot, now);
    log(msg);
  }

  function isAutoEnabled() {
    return !!opts.isAutoEnabled(loadModelSettings(opts.userDataPath));
  }

  async function runIncremental(workspaceRoot, reason) {
    if (!workspaceRoot) return;
    if (!isAutoEnabled()) return;

    try {
      const verdict = await opts.decide({
        workspaceRoot,
        reason,
        invokeRustCore: opts.invokeRustCore,
        log,
        logSkipThrottled: (msg) => logSkipThrottled(workspaceRoot, msg)
      });
      if (!verdict) return;
      if (verdict.action === 'retry') {
        schedule(workspaceRoot, verdict.delayMs, reason);
        return;
      }
      // 用 *.index.start 后台增量，避免同步 *.index 堵死 dieyun-core stdio。
      const result = await opts.invokeRustCore(verdict.method, verdict.params, verdict.timeoutMs);
      if (!result) {
        log(`[${tag}] incremental index skipped: start returned empty`);
        return;
      }
      // 带上 root：多工作区并行时，「两条 (save) 相隔 1.5s」到底是重复触发还是两个工作区，
      // 靠这一行就能判断（此前只有 reason，无法区分）。
      log(`[${tag}] incremental index started (${reason || 'save'}) root=${workspaceRoot}`);
    } catch (err) {
      log(`[${tag}] incremental index skipped: ${err && (err.message || err)}`);
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
   * `*.status` 只剩 "status unavailable" —— 全是噪声，还挡住真正的诊断信号。
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
    if (!opts.isSourcePath(absPath)) return;
    if (!isUnderWorkspaceRoot(absPath, root)) return;
    if (opts.trackSavedAt) lastSavedAt.set(root, Date.now());
    schedule(root, debounceMs, 'save');
  }

  function notifyWorkspaceOpened(workspaceRootOverride) {
    const root = resolveWorkspaceRoot(workspaceRootOverride);
    if (!root) return;
    schedule(root, WORKSPACE_OPEN_DEBOUNCE_MS, 'workspace');
  }

  /** 供 status / prep 判断「刚保存过、索引可能还没跟上」（仅 trackSavedAt 的调用方需要）。 */
  function getRefreshState(workspaceRootOverride) {
    const root = resolveWorkspaceRoot(workspaceRootOverride);
    if (!root) return null;
    return {
      pending: timers.has(root),
      lastSavedAt: lastSavedAt.get(root) || 0
    };
  }

  const api = { notifyFileSaved, notifyWorkspaceOpened };
  if (opts.trackSavedAt) api.getRefreshState = getRefreshState;
  return api;
}

module.exports = {
  createIncrementalScheduler,
  DEFAULT_DEBOUNCE_MS,
  WORKSPACE_OPEN_DEBOUNCE_MS
};
