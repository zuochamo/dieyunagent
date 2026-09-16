'use strict';

const LLM_RECONNECT_SHORT_ATTEMPTS = 3;
const LLM_RECONNECT_SHORT_BASE_MS = 800;
/** 单次采样重试次数（不含首次）。可用 LLM_RECONNECT_MAX_RETRIES 覆盖。 */
const LLM_RECONNECT_MAX_RETRIES = Number(process.env.LLM_RECONNECT_MAX_RETRIES) || 3;
/** 单次退避上限（对齐 Pi Retry-After cap）。 */
const LLM_RECONNECT_MAX_DELAY_MS = 60 * 1000;
/**
 * 未显式传 maxWaitMs 时的墙钟上限兜底（0 = 走次数模式）。
 * 生产路径由 agent-limits.llmReconnectMaxWaitMs 显式传入，见 resolveAgentLoopSpec。
 */
const LLM_RECONNECT_MAX_WAIT_MS = Number(process.env.LLM_RECONNECT_MAX_WAIT_MS) || 0;
const LLM_RECONNECT_LONG_BASE_MS = 3000;
const LLM_RECONNECT_LONG_MAX_INTERVAL_MS = 60000;

function createAbortError(message = '已停止') {
  const err = new Error(message);
  err.name = 'AbortError';
  return err;
}

/** 可被 AbortSignal 立即打断的 sleep（停止优先） */
function sleepMs(ms, signal) {
  const wait = Math.max(0, Number(ms) || 0);
  if (!signal) {
    return new Promise((r) => setTimeout(r, wait));
  }
  if (signal.aborted) {
    return Promise.reject(createAbortError());
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    let poll = null;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    }, wait);
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(createAbortError());
    };
    const cleanup = () => {
      clearTimeout(timer);
      if (poll) clearInterval(poll);
      if (typeof signal.removeEventListener === 'function') {
        signal.removeEventListener('abort', onAbort);
      }
    };
    if (typeof signal.addEventListener === 'function') {
      signal.addEventListener('abort', onAbort, { once: true });
    } else {
      poll = setInterval(() => {
        if (signal.aborted) onAbort();
      }, 50);
    }
  });
}

/** 与 abort 竞态：停止时立刻 reject，不等待原 promise；可选 onAbort 触发底层取消 */
function raceAbortable(promise, signal, onAbort) {
  const task = Promise.resolve(promise);
  const fireOnAbort = () => {
    if (typeof onAbort !== 'function') return;
    try {
      onAbort();
    } catch {
      // ignore
    }
  };
  if (!signal) return task;
  if (signal.aborted) {
    fireOnAbort();
    return Promise.reject(createAbortError());
  }
  if (typeof signal.addEventListener !== 'function') {
    let timer = null;
    const abortPromise = new Promise((_, reject) => {
      timer = setInterval(() => {
        if (signal.aborted) {
          clearInterval(timer);
          fireOnAbort();
          reject(createAbortError());
        }
      }, 50);
    });
    task.catch(() => {});
    return Promise.race([task, abortPromise]).finally(() => {
      if (timer) clearInterval(timer);
    });
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const onAbortEvt = () => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbortEvt);
      fireOnAbort();
      reject(createAbortError());
    };
    signal.addEventListener('abort', onAbortEvt, { once: true });
    task.then(
      (value) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbortEvt);
        resolve(value);
      },
      (err) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbortEvt);
        reject(err);
      }
    );
  });
}

function isAbortError(err) {
  for (let cur = err; cur; cur = cur.cause) {
    if (!cur) break;
    if (cur.name === 'AbortError' || cur.code === 'ABORT_ERR') return true;
    const msg = String(cur.message || '').toLowerCase();
    if (msg === 'aborted' || msg === '已停止' || msg.includes('已停止')) return true;
  }
  return false;
}

function parseHttpStatus(err) {
  if (!err) return 0;
  const code = Number(err.statusCode);
  if (Number.isFinite(code) && code > 0) return code;
  const m = String(err.message || err).match(/\bHTTP\s+(\d{3})\b/i);
  return m ? Number(m[1]) : 0;
}

function isNonRetryableLlmError(err) {
  if (!err) return false;
  const msg = String(err.message || err).toLowerCase();
  const status = parseHttpStatus(err);
  if (status === 400 || status === 401 || status === 403) return true;
  if (
    /quota|billing|insufficient_quota|usage.?limit|额度|余额不足/.test(msg) &&
    status === 429
  ) {
    return true;
  }
  if (/content.?policy|content_policy|内容审核|风险规则/.test(msg)) return true;
  if (/context.?length|maximum context|too many tokens|prompt is too long|token.?limit/.test(msg)) {
    return true;
  }
  return false;
}

function isContextOverflowError(err) {
  if (!err || isAbortError(err)) return false;
  const msg = String(err.message || err).toLowerCase();
  return /context.?length|context_length|maximum context|prompt is too long|too many tokens|max.?context|input length|exceeds the maximum length/.test(
    msg
  );
}

function isTransientLlmError(err) {
  if (!err || isAbortError(err)) return false;
  if (err.code === 'LLM_RECONNECT_EXHAUSTED') return false;
  if (isNonRetryableLlmError(err)) return false;
  const msg = String(err.message || err).toLowerCase();
  const status = parseHttpStatus(err);
  if (status === 429 || status === 502 || status === 503 || status === 504) return true;
  return (
    err instanceof TypeError ||
    msg.includes('network error') ||
    msg.includes('failed to fetch') ||
    msg.includes('network request failed') ||
    msg.includes('socket hang up') ||
    msg.includes('econnreset') ||
    msg.includes('connection reset') ||
    msg.includes('connection aborted') ||
    msg.includes('connection_error') ||
    msg.includes('etimedout') ||
    msg.includes('timedout') ||
    msg.includes('first_token') ||
    msg.includes('enotfound') ||
    msg.includes('getaddrinfo') ||
    /\bhttp\s+(429|502|503|504)\b/.test(msg)
  );
}

function resolveRetryWaitMs(retryAttempt, baseDelayMs, maxDelayMs) {
  const base = Math.max(200, Number(baseDelayMs) || LLM_RECONNECT_SHORT_BASE_MS);
  const cap = Math.max(base, Number(maxDelayMs) || LLM_RECONNECT_MAX_DELAY_MS);
  const raw = base * Math.pow(2, Math.max(0, retryAttempt - 1));
  return Math.min(cap, raw);
}

/**
 * 单次采样瞬时错误重试。
 * - `maxWaitMs > 0`：**时间驱动** —— 不设次数上限，重连到成功或墙钟耗尽为止；
 * - `maxWaitMs = 0`：**次数驱动** —— 最多 `maxRetries` 次退避（2^n * base）。
 * 两种模式下停止信号都可立即打断等待；非瞬时错误一律不重试。
 */
async function runWithLlmReconnectRetry(runOnce, opts = {}) {
  const {
    signal,
    onWait,
    isTransient = isTransientLlmError,
    maxRetries = LLM_RECONNECT_MAX_RETRIES,
    baseDelayMs = LLM_RECONNECT_SHORT_BASE_MS,
    maxDelayMs = LLM_RECONNECT_MAX_DELAY_MS,
    maxWaitMs = LLM_RECONNECT_MAX_WAIT_MS
  } = opts;
  const startedAt = Date.now();
  const retryCap = Math.max(0, Number(maxRetries) || 0);
  const timeBudgetMs = Number(maxWaitMs) > 0 ? Number(maxWaitMs) : 0;
  let retryAttempt = 0;
  let lastErr;

  for (;;) {
    if (signal?.aborted) {
      throw createAbortError();
    }
    // 时间驱动：首次必试，之后墙钟耗尽即停（不受次数上限约束）
    if (retryAttempt > 0 && timeBudgetMs > 0 && Date.now() - startedAt >= timeBudgetMs) {
      break;
    }
    try {
      return await runOnce();
    } catch (err) {
      lastErr = err;
      if (isAbortError(err)) throw err;
      if (!isTransient(err)) throw err;
      retryAttempt += 1;
      if (timeBudgetMs > 0) {
        if (Date.now() - startedAt >= timeBudgetMs) break;
      } else if (retryAttempt > retryCap) {
        break;
      }
      const elapsed = Date.now() - startedAt;
      const waitMs = resolveRetryWaitMs(retryAttempt, baseDelayMs, maxDelayMs);
      // 时间驱动：剩余时间已放不下下一次退避，就不要再空等→直接收工，
      // 避免出现「提示即将重试、实际却等到耗尽仍失败」的观感
      if (timeBudgetMs > 0 && timeBudgetMs - elapsed <= waitMs) break;
      if (typeof onWait === 'function') {
        await onWait({
          attempt: retryAttempt,
          waitMs,
          error: err,
          elapsedMs: elapsed,
          // 时间驱动下 0 表示「次数不限」，展示层应改用 remainingMs
          maxRetries: timeBudgetMs > 0 ? 0 : retryCap,
          maxWaitMs: timeBudgetMs,
          remainingMs: timeBudgetMs > 0 ? Math.max(0, timeBudgetMs - elapsed) : 0
        });
      }
      await sleepMs(waitMs, signal);
    }
  }

  const exhausted = lastErr instanceof Error ? lastErr : new Error(String(lastErr || 'LLM 重连超时'));
  exhausted.code = 'LLM_RECONNECT_EXHAUSTED';
  throw exhausted;
}

module.exports = {
  runWithLlmReconnectRetry,
  isTransientLlmError,
  isNonRetryableLlmError,
  isContextOverflowError,
  isAbortError,
  createAbortError,
  sleepMs,
  raceAbortable,
  resolveRetryWaitMs,
  LLM_RECONNECT_MAX_WAIT_MS,
  LLM_RECONNECT_MAX_RETRIES,
  LLM_RECONNECT_SHORT_ATTEMPTS,
  LLM_RECONNECT_MAX_DELAY_MS
};
