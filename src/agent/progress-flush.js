'use strict';

/**
 * 流式进度的**唯一合批形态**：只保留最新一份 payload，按最小间隔 / 动画帧边界投递一次。
 *
 * 为什么必须只有一份实现：core 逐 SSE chunk 推增量（`agent.delta` 只带本片），宿主把它累积成
 * 「本轮累计正文」后，若每个 chunk 都过一次 IPC，搬运字节与事件数都随回答长度走 —— 单轮总代价
 * 是 O(正文²)。以前 Main（planner 的 `progress`）、Renderer（planner / 主循环各一份）、计划
 * （`mcp-plans-boot` 的 trace 队列）各写了一套 `pending + timer + rAF + 结构签名` 状态机，
 * 数字也各不相同（160 / 120），漂移是迟早的事。这里把状态机收成一处，数字仍只在
 * `agent-limits.js`（`agentProgressFlushMs`）。
 *
 * 语义：
 * - `push(payload)` **只覆盖**待投递的那一份，不排队（进度天然可以丢中间帧）；
 * - `signature(payload)` 变了 = 结构事件（换轮次 / 出现新工具 / 收尾）→ 按最小间隔投递；
 *   不变 = 纯流式文本 → 给了 `requestFrame` 就贴下一帧（出字要顺滑），没给就同样按最小间隔；
 * - `flushNow()` 立即投递挂起的那一份 —— 结构事件必须先把它冲出去，**顺序不能反**；
 * - `cancel()` 丢掉挂起的那一份（用户停止 / 换会话）。
 *
 * 纯函数式依赖注入（`now` / `setTimer` / `requestFrame`）：Main 用 `setTimeout`，
 * Renderer 用 `requestAnimationFrame`，两边共用同一份判定逻辑与同一份「结构 vs 文本」口径。
 */

/**
 * @typedef {object} ProgressFlush
 * @property {(payload: any) => void} push 覆盖式入队最新一份
 * @property {() => void} flushNow 立即投递挂起的那一份（没有挂起则什么都不做）
 * @property {() => void} cancel 丢掉挂起的那一份并清掉已排的定时器/帧
 * @property {boolean} hasPending 是否还有未投递的 payload
 */

/**
 * @param {{
 *   minIntervalMs?: number,
 *   flush: (payload: any) => void,
 *   signature?: (payload: any) => string,
 *   now?: () => number,
 *   setTimer?: (fn: () => void, ms: number) => any,
 *   clearTimer?: (handle: any) => void,
 *   requestFrame?: ((fn: () => void) => any) | null,
 *   cancelFrame?: ((handle: any) => void) | null
 * }} options
 * @returns {ProgressFlush}
 */
function createProgressFlush(options = {}) {
  const flush = options.flush;
  if (typeof flush !== 'function') {
    throw new TypeError('createProgressFlush: 需要 flush 回调');
  }
  const minIntervalMs = Math.max(0, Number(options.minIntervalMs) || 0);
  const signature = typeof options.signature === 'function' ? options.signature : () => '';
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const setTimer =
    typeof options.setTimer === 'function' ? options.setTimer : (fn, ms) => setTimeout(fn, ms);
  const clearTimer =
    typeof options.clearTimer === 'function' ? options.clearTimer : (handle) => clearTimeout(handle);
  const requestFrame = typeof options.requestFrame === 'function' ? options.requestFrame : null;
  const cancelFrame = typeof options.cancelFrame === 'function' ? options.cancelFrame : null;

  /** @type {any} */
  let pending = null;
  let hasPending = false;
  /** @type {any} */
  let timer = null;
  /** @type {any} */
  let frame = null;
  let lastFlushAt = 0;
  /** 上一份投递出去的结构签名：`null` = 还没投递过（第一份一律按结构事件处理） */
  /** @type {string|null} */
  let lastSignature = null;

  function clearScheduled() {
    if (timer) {
      clearTimer(timer);
      timer = null;
    }
    if (frame) {
      if (cancelFrame) cancelFrame(frame);
      frame = null;
    }
  }

  function deliver() {
    clearScheduled();
    if (!hasPending) return;
    const payload = pending;
    pending = null;
    hasPending = false;
    lastFlushAt = now();
    flush(payload);
  }

  /** 距「可再次投递」还差多久：结构事件不能比最小间隔更密 */
  function delayUntilNext() {
    return Math.max(0, minIntervalMs - (now() - lastFlushAt));
  }

  function scheduleAt(delay) {
    if (timer) return;
    timer = setTimer(() => {
      timer = null;
      if (!requestFrame) {
        deliver();
        return;
      }
      // 定时器只把「最早可投递时刻」推到下一帧：既不早于最小间隔，也不与渲染帧抢同一拍
      if (frame) return;
      frame = requestFrame(() => {
        frame = null;
        deliver();
      });
    }, delay);
  }

  function push(payload) {
    pending = payload;
    hasPending = true;
    const rawSig = signature(payload);
    const sig = rawSig == null ? '' : String(rawSig);
    const firstEver = lastSignature === null;
    const structural = firstEver || sig !== lastSignature;
    lastSignature = sig;

    if (firstEver) {
      // 第一份不等间隔：它往往就是「首字」或这一轮的第一张卡片，多等一拍等于白加首字延迟
      deliver();
      return;
    }

    if (!structural && requestFrame) {
      // 纯流式文本：贴帧就行，不再叠加最小间隔的延迟（出字要顺滑，不要一顿一顿）
      if (!frame) {
        frame = requestFrame(() => {
          frame = null;
          deliver();
        });
      }
      return;
    }

    if (structural && frame) {
      // 结构变了：帧回调里的那一份已被新 payload 覆盖，取消帧、改走最小间隔
      if (cancelFrame) cancelFrame(frame);
      frame = null;
    }
    scheduleAt(delayUntilNext());
  }

  return {
    push,
    flushNow: deliver,
    cancel() {
      pending = null;
      hasPending = false;
      clearScheduled();
    },
    get hasPending() {
      return hasPending;
    }
  };
}

module.exports = { createProgressFlush };
