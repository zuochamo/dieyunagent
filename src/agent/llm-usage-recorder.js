'use strict';

/**
 * LLM 用量出口（**唯一**一处）：一次模型调用的 usage 只在这里被广播一次。
 *
 * 两种消费方式并存，语义不同：
 * - `setLlmUsageRecorder`：**单槽**，给「本进程的主账本」（桌面端活动统计）用；
 * - `onLlmUsage`：**旁听**，给需要同时看用量的附加读者（`src/alive` 的疲劳/负载采样）。
 *
 * 为什么旁听要进这个文件：它是 usage 的唯一出口。谁想读用量都从这里挂，
 * 不然就得在调用点再播一份（那才是第二个真相）。
 *
 * @type {((usage: object, model?: string) => void) | null}
 */
let recorder = null;

/** @type {Set<(usage: object, model?: string) => void>} */
const listeners = new Set();

function setLlmUsageRecorder(fn) {
  recorder = typeof fn === 'function' ? fn : null;
}

/**
 * 旁听用量。返回退订函数（调用方 stop 时必须调用，否则进程里会残留闭包）。
 * @param {(usage: object, model?: string) => void} fn
 * @returns {() => void}
 */
function onLlmUsage(fn) {
  if (typeof fn !== 'function') return () => {};
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function recordLlmUsage(usage, model) {
  if (!usage || (!recorder && listeners.size === 0)) return;
  if (typeof recorder === 'function') {
    try {
      recorder(usage, model);
    } catch {
      // ignore
    }
  }
  for (const fn of listeners) {
    try {
      fn(usage, model);
    } catch {
      // 旁听者失败不能影响主账本
    }
  }
}

module.exports = { setLlmUsageRecorder, onLlmUsage, recordLlmUsage };
