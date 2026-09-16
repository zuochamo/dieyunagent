'use strict';

const {
  runWithLlmReconnectRetry,
  isTransientLlmError,
  isContextOverflowError,
  resolveRetryWaitMs,
  LLM_RECONNECT_MAX_RETRIES
} = require('../src/llm-reconnect-retry');

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed');
}

async function testRetryBudget() {
  let n = 0;
  try {
    await runWithLlmReconnectRetry(
      async () => {
        n += 1;
        const err = new Error('HTTP 502');
        err.statusCode = 502;
        throw err;
      },
      { maxRetries: 3, baseDelayMs: 1, maxDelayMs: 2 }
    );
    throw new Error('expected exhaust');
  } catch (err) {
    assert(err.code === 'LLM_RECONNECT_EXHAUSTED', 'exhausted code');
  }
  assert(n === 4, `1 try + 3 retries, got ${n}`);
}

/** 时间驱动：设了墙钟后次数上限不再生效，一直重试到墙钟耗尽 */
async function testTimeBudgetIgnoresRetryCap() {
  let n = 0;
  const t0 = Date.now();
  try {
    await runWithLlmReconnectRetry(
      async () => {
        n += 1;
        const err = new Error('HTTP 502');
        err.statusCode = 502;
        throw err;
      },
      // 预算须大于最短退避（resolveRetryWaitMs 下限 200ms）；默认 maxRetries 只有 3
      { maxWaitMs: 1200, baseDelayMs: 10, maxDelayMs: 20 }
    );
    throw new Error('expected exhaust');
  } catch (err) {
    assert(err.code === 'LLM_RECONNECT_EXHAUSTED', 'time budget exhaust code');
  }
  assert(n >= 5, `time budget ignores retry cap, got ${n}`);
  const wall = Date.now() - t0;
  assert(wall >= 600, `time budget keeps retrying across wall clock, got ${wall}ms`);
}

/** 预算放不下一次退避时立刻收工，不空等 */
async function testTinyBudgetDoesNotIdle() {
  const t0 = Date.now();
  let n = 0;
  try {
    await runWithLlmReconnectRetry(
      async () => {
        n += 1;
        const err = new Error('HTTP 502');
        err.statusCode = 502;
        throw err;
      },
      { maxWaitMs: 150, baseDelayMs: 10, maxDelayMs: 20 }
    );
    throw new Error('expected exhaust');
  } catch (err) {
    assert(err.code === 'LLM_RECONNECT_EXHAUSTED', 'tiny budget exhaust code');
  }
  assert(n === 1, `tiny budget stops immediately, got ${n}`);
  const wall = Date.now() - t0;
  assert(wall < 200, `tiny budget must not idle out the budget, got ${wall}ms`);
}

/** 时间驱动不得放宽「非瞬时错误不重试」：配额/鉴权必须立刻抛 */
async function testTimeBudgetHonorsNonRetryable() {
  let n = 0;
  try {
    await runWithLlmReconnectRetry(
      async () => {
        n += 1;
        const err = new Error('HTTP 429 insufficient_quota');
        err.statusCode = 429;
        throw err;
      },
      { maxWaitMs: 5000, baseDelayMs: 10, maxDelayMs: 20 }
    );
    throw new Error('expected throw');
  } catch (err) {
    assert(err.code !== 'LLM_RECONNECT_EXHAUSTED', 'quota is not reconnect exhaust');
  }
  assert(n === 1, `quota not retried even with time budget, got ${n}`);
}

async function testQuotaNotRetried() {
  let n = 0;
  try {
    await runWithLlmReconnectRetry(async () => {
      n += 1;
      const err = new Error('HTTP 429 insufficient_quota');
      err.statusCode = 429;
      throw err;
    });
    throw new Error('expected throw');
  } catch (err) {
    assert(err.code !== 'LLM_RECONNECT_EXHAUSTED', 'quota is not reconnect exhaust');
  }
  assert(n === 1, 'quota not retried');
  assert(isTransientLlmError({ message: 'HTTP 429 rate_limit_exceeded', statusCode: 429 }), '429 retryable');
  assert(!isTransientLlmError({ message: 'HTTP 429 insufficient_quota', statusCode: 429 }), 'quota not transient');
}

function testOverflowAndWait() {
  assert(isContextOverflowError({ message: 'prompt is too long' }), 'overflow detect');
  assert(isContextOverflowError({ message: 'HTTP 400 context_length_exceeded' }), 'context_length');
  assert(
    isContextOverflowError({
      message:
        'HTTP 400 {"code":"LITELLM_ERROR","message":"Input length 1971687 exceeds the maximum length 1048566."}'
    }),
    'litellm input length'
  );
  assert(!isContextOverflowError({ message: 'HTTP 400 invalid token' }), 'plain token 400 is not overflow');
  assert(!isContextOverflowError({ message: 'HTTP 502' }), '502 not overflow');
  assert(resolveRetryWaitMs(1, 2000, 60000) === 2000, 'first wait');
  assert(resolveRetryWaitMs(3, 2000, 60000) === 8000, 'third wait');
  assert(LLM_RECONNECT_MAX_RETRIES === 3, 'default retries');
}

async function main() {
  testOverflowAndWait();
  await testRetryBudget();
  await testTimeBudgetIgnoresRetryCap();
  await testTinyBudgetDoesNotIdle();
  await testTimeBudgetHonorsNonRetryable();
  await testQuotaNotRetried();
  console.log('test-llm-reconnect-retry.cjs ok');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
