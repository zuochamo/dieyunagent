'use strict';

/**
 * Renderer-only mutate queue（无 CommonJS，由 index.html 的 <script> 加载）。
 *
 * ⚠️ 与 `src/agent/mutate-queue.js` 是**同语义的两份实现**：
 * - 主进程那份是**权威串行点**（写类工具真正在 Main 执行）；
 * - 这份只保证「Renderer 的发包顺序」，并给「工作区忙」提示提供本地计数。
 *
 * 两处都必须有 stall 看门狗：2026-10-23 的事故里，一个永不 settle 的 `host_exec`
 * 把队列钉死，之后同 workspace 所有写类工具永久排队。队列实现只要没有超时，
 * 无论在主进程还是渲染层都会以同样方式停摆。
 *
 * 语义：超时只**开闸放行后续**，不终止原调用（取消由 delegate-batch 的 abort 契约负责）。
 */

/**
 * 停滞开闸阈值只有一个来源：agent-bundle 注册的 `agent-limits`（`window.getAgentLimit`）。
 * 这里以前另抄了一份 `12 * 60 * 1000`，改设置页对渲染层队列毫无影响。
 */
function resolveMutateStallMs(override) {
  const explicit = Number(override);
  const api = typeof window !== 'undefined' ? window : null;
  const ms = Number(
    explicit > 0 ? explicit : api && typeof api.getAgentLimit === 'function' ? api.getAgentLimit('toolStallMs') : 0
  );
  if (!(ms > 0)) {
    throw new Error('agent-limits 未加载：renderer-mutate-queue 需要 window.getAgentLimit');
  }
  return Math.max(1000, ms);
}

/** @type {Map<string, { gate: {promise: Promise<void>, resolve: Function}, tail: Promise<void>, pending: number, holders: Set<string>, active: object|null }>} */
const mutateQueues = new Map();

function normalizeWorkspaceMutateKey(workspaceKey) {
  const key = String(workspaceKey || '__global__').trim();
  return key || '__global__';
}

function createMutateGate() {
  let resolve = () => {};
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function getMutateQueue(workspaceKey) {
  const key = normalizeWorkspaceMutateKey(workspaceKey);
  if (!mutateQueues.has(key)) {
    const gate = createMutateGate();
    gate.resolve(); // 队首不等待任何人
    mutateQueues.set(key, { gate, tail: gate.promise, pending: 0, holders: new Set(), active: null });
  }
  return mutateQueues.get(key);
}

/**
 * @param {() => Promise<any>} fn
 * @param {string} workspaceKey
 * @param {string} [holderId]
 * @param {{ tool?: string, stallMs?: number }} [opts]
 */
function runExclusive(fn, workspaceKey, holderId, opts = {}) {
  const key = normalizeWorkspaceMutateKey(workspaceKey);
  const q = getMutateQueue(key);
  const holder = holderId != null && String(holderId).trim() ? String(holderId).trim() : '';
  const stallMs = resolveMutateStallMs(opts.stallMs);

  const prev = q.gate;
  const mine = createMutateGate();
  q.gate = mine;
  q.tail = mine.promise;
  q.pending += 1;
  if (holder) q.holders.add(holder);

  let meta = null;
  let watchdog = null;
  let opened = false;
  let accounted = false;

  const openGate = () => {
    if (opened) return;
    opened = true;
    mine.resolve();
  };
  const settleAccounting = () => {
    if (accounted) return;
    accounted = true;
    q.pending = Math.max(0, q.pending - 1);
    if (holder) q.holders.delete(holder);
    if (q.active === meta) q.active = null;
  };

  return prev.promise.then(async () => {
    meta = {
      tool: String(opts.tool || ''),
      sessionId: String(holder || ''),
      startedAt: Date.now()
    };
    q.active = meta;
    // 只在拿到执行权之后计时：排队时长不算 stalled
    watchdog = setTimeout(() => {
      openGate();
      settleAccounting();
      try {
        console.warn(
          `[mutate-queue] STALL workspace=${key} tool=${meta.tool || '?'} ` +
            `runningMs=${Date.now() - meta.startedAt} pending=${q.pending} — 已放行后续写类工具（原调用继续执行、未终止）`
        );
      } catch {
        // ignore
      }
    }, stallMs);
    try {
      return await fn();
    } finally {
      if (watchdog) clearTimeout(watchdog);
      openGate();
      settleAccounting();
    }
  });
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

window.MutateQueue = {
  normalizeWorkspaceMutateKey,
  getMutateQueue,
  runExclusive,
  getWorkspaceMutatePending,
  isWorkspaceMutateBusy,
  listWorkspaceMutateHolders
};
