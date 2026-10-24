'use strict';

/**
 * 写类工具（`MUTATING_TOOLS`）的 workspace 级串行队列。
 *
 * **为什么必须有 stall 看门狗（2026-10-23 事故）**：
 * 队列项依次挂在前一项的 promise 上，原本没有任何超时。一个永不 settle 的写类工具
 * （`host_exec` 卡在交互式命令、打印对话框等）会把队尾钉死，于是**同一 workspace 之后
 * 所有写类工具永久排队**，而读类工具与 Gateway 照常工作 —— 表现就是「应用还活着，
 * 但 agent 一动不动」，磁盘上没有一行错误日志。那天 17:00 / 17:20 两个定时计划各只发出
 * 第一轮请求（工具是 `host_exec`）就挂了两小时，直到手动停止。
 *
 * **实现要点：闸门（gate）而不是 Promise 链**。
 * 若后来者直接 `await 前一项的 promise`，看门狗放行也救不了**已经排好队**的那些项
 * （它们的 await 对象就是那个永不 resolve 的 promise）。所以每项持有自己的闸门，后来者等
 * 闸门；stall 时只 resolve 当前闸门 ⇒ 排在后面的立刻拿到执行权。
 *
 * **语义**：超时只**开闸放行后续**，不 kill、不 reject 原调用 —— 取消语义属于
 * `delegate-batch` 的 abort 契约，两者混在一起会让「停止」变成「误杀」。
 *
 * 刻意不做：不做全局并发上限、不做优先级、不持久化队列状态。
 */

/** 超过这个时间仍未 settle 就开闸。必须大于 host_exec 的硬上限 600s，否则会误判正常长命令。 */
const DEFAULT_STALL_MS = 12 * 60 * 1000;
const MIN_STALL_MS = 1000;

/** 日志出口由 Main 注入（electron-log）；未注入时静默，避免模块级 console 噪音。 */
let logHook = () => {};

function setMutateQueueLog(fn) {
  logHook = typeof fn === 'function' ? fn : () => {};
}

function createGate() {
  let resolve = () => {};
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/**
 * @typedef {{ promise: Promise<void>, resolve: () => void }} Gate
 * @typedef {{ gate: Gate, tail: Promise<void>, pending: number, holders: Set<string>,
 *   active: { tool: string, sessionId: string, startedAt: number } | null }} MutateQueue
 * @type {Map<string, MutateQueue>}
 */
const mutateQueues = new Map();

function normalizeWorkspaceMutateKey(workspaceKey) {
  const key = String(workspaceKey || '__global__').trim();
  return key || '__global__';
}

function getMutateQueue(workspaceKey) {
  const key = normalizeWorkspaceMutateKey(workspaceKey);
  if (!mutateQueues.has(key)) {
    const gate = createGate();
    gate.resolve(); // 队首不等待任何人
    mutateQueues.set(key, { gate, tail: gate.promise, pending: 0, holders: new Set(), active: null });
  }
  return mutateQueues.get(key);
}

/**
 * @param {() => Promise<any>} fn
 * @param {string} workspaceKey
 * @param {string} [holderId]
 * @param {{ tool?: string, sessionId?: string, stallMs?: number }} [opts]
 */
function runExclusive(fn, workspaceKey, holderId, opts = {}) {
  const key = normalizeWorkspaceMutateKey(workspaceKey);
  const q = getMutateQueue(key);
  const holder = holderId != null && String(holderId).trim() ? String(holderId).trim() : '';
  const stallMs = Math.max(MIN_STALL_MS, Number(opts.stallMs) || DEFAULT_STALL_MS);

  const prev = q.gate;
  const mine = createGate();
  q.gate = mine;
  q.tail = mine.promise;
  q.pending += 1;
  if (holder) q.holders.add(holder);

  /** @type {{ tool: string, sessionId: string, startedAt: number } | null} */
  let meta = null;
  let watchdog = null;
  let opened = false;
  let accounted = false;

  const openGate = () => {
    if (opened) return;
    opened = true;
    mine.resolve();
  };

  // 开闸与计数必须分开：stall 后原调用仍在跑，但它已不在队列里排队了，
  // 否则 renderer 的「工作区忙」会永远为真。
  const settleAccounting = () => {
    if (accounted) return;
    accounted = true;
    q.pending = Math.max(0, q.pending - 1);
    if (holder) q.holders.delete(holder);
    if (q.active === meta) q.active = null;
  };

  const run = prev.promise.then(async () => {
    meta = {
      tool: String(opts.tool || ''),
      sessionId: String(opts.sessionId || holder || ''),
      startedAt: Date.now()
    };
    q.active = meta;
    // 看门狗只在「真正拿到执行权」之后开始计时：排队时长不算 stalled，
    // 否则前面一个慢调用会把后面所有排队项一起判死。
    watchdog = setTimeout(() => {
      openGate();
      settleAccounting();
      logHook(
        `MUTATE_QUEUE_STALL workspace=${key} tool=${meta.tool || '?'} session=${meta.sessionId || '-'} ` +
          `runningMs=${Date.now() - meta.startedAt} pending=${q.pending} — 已放行后续写类工具（原调用继续执行、未终止）`
      );
    }, stallMs);
    if (watchdog && typeof watchdog.unref === 'function') watchdog.unref();
    try {
      return await fn();
    } finally {
      if (watchdog) clearTimeout(watchdog);
      openGate();
      settleAccounting();
    }
  });

  return run;
}

function getWorkspaceMutatePending(workspaceKey) {
  const q = mutateQueues.get(normalizeWorkspaceMutateKey(workspaceKey));
  return q ? q.pending : 0;
}

function isWorkspaceMutateBusy(workspaceKey, excludeHolderId) {
  const q = mutateQueues.get(normalizeWorkspaceMutateKey(workspaceKey));
  if (!q || q.pending <= 0) return false;
  const exclude =
    excludeHolderId != null && String(excludeHolderId).trim()
      ? String(excludeHolderId).trim()
      : '';
  if (!exclude) return true;
  if (q.holders.size === 0) return q.pending > 0;
  for (const holder of q.holders) {
    if (holder !== exclude) return true;
  }
  return q.pending > 1;
}

function listWorkspaceMutateHolders(workspaceKey) {
  const q = mutateQueues.get(normalizeWorkspaceMutateKey(workspaceKey));
  return q ? [...q.holders] : [];
}

/** 诊断快照：谁在跑、还在等几个。stall 日志之外唯一能看见队列内部的地方。 */
function getWorkspaceMutateSnapshot(workspaceKey) {
  const q = mutateQueues.get(normalizeWorkspaceMutateKey(workspaceKey));
  if (!q) return { pending: 0, holders: [], active: null };
  return {
    pending: q.pending,
    holders: [...q.holders],
    active: q.active ? { ...q.active, runningMs: Date.now() - q.active.startedAt } : null
  };
}

module.exports = {
  DEFAULT_STALL_MS,
  normalizeWorkspaceMutateKey,
  getMutateQueue,
  runExclusive,
  setMutateQueueLog,
  getWorkspaceMutatePending,
  isWorkspaceMutateBusy,
  listWorkspaceMutateHolders,
  getWorkspaceMutateSnapshot
};
