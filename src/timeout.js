'use strict';

/**
 * 「等一个 promise 至多 N 毫秒」—— **全仓单一来源**。
 *
 * 以前有六份各自手写的实现（`agent/system-prompt-prep`、`agent/tool-bridge-main`、
 * `browser/service`、`gateway/sandbox-approvals`、`lsp/navigate-service`、`mcp/runtime-manager`），
 * 形状几乎一样，语义分两类，其中两份还漏了 `clearTimeout`。超时语义属于**失败语义**，
 * 分散的代价是「同一类等待，有的抛错有的返回 null，有的定时器泄漏」，排查时最难看出。
 *
 * 两种模式就是仓库里真实存在的两种语义，不是新开关：
 * - `'reject'`（默认）：超时抛错，可带 `code`；原 promise 的失败照常上抛。
 * - `'null'`：超时与失败都 resolve(null) —— 给「这一步拿不到就算了」的可选增强步骤用。
 *
 * `ms` 非正数 / 非有限 = **不设超时**：`'reject'` 模式原样返回 promise（失败照常上抛），
 * `'null'` 模式吞掉失败返回 null。调用方不需要再各写一段 `if (!Number.isFinite(ms))` 兜底。
 *
 * @template T
 * @param {Promise<T>|T} promise
 * @param {number} ms
 * @param {{ mode?: 'reject'|'null', message?: string|((ms: number) => string), code?: string }} [opts]
 * @returns {Promise<T|null>}
 */
function withTimeout(promise, ms, opts = {}) {
  const mode = opts.mode === 'null' ? 'null' : 'reject';
  const wait = Number(ms);
  const swallow = (p) => Promise.resolve(p).then(() => null, () => null);

  if (!Number.isFinite(wait) || wait <= 0) {
    return mode === 'null' ? swallow(promise) : Promise.resolve(promise);
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      if (mode === 'null') {
        resolve(null);
        return;
      }
      const text = typeof opts.message === 'function' ? opts.message(wait) : opts.message;
      const err = new Error(text || `等待超时（${wait}ms）`);
      if (opts.code) err.code = opts.code;
      reject(err);
    }, wait);
    Promise.resolve(promise).then(
      (value) => finish(resolve, value),
      (err) => (mode === 'null' ? finish(resolve, null) : finish(reject, err))
    );
  });
}

module.exports = { withTimeout };
