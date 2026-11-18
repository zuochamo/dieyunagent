'use strict';

const {
  runWithLlmReconnectRetry,
  isTransientLlmError,
  isContextOverflowError,
  resolveRetryWaitMs,
  LLM_TRANSPORT_CODE,
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

/** 瞬时判定必须认「网络信号」，不能认「只要是 TypeError」（本地代码缺陷同为 TypeError） */
function testTransientErrorShape() {
  const netErr = new TypeError('fetch failed');
  netErr.cause = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
  assert(isTransientLlmError(netErr), 'fetch failed + ECONNREFUSED is transient');

  const undiciErr = new TypeError('fetch failed');
  undiciErr.cause = Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' });
  assert(isTransientLlmError(undiciErr), 'undici socket code is transient');

  assert(isTransientLlmError(new TypeError('Failed to fetch')), 'browser failed to fetch is transient');

  const timeoutErr = new TypeError('fetch failed');
  timeoutErr.cause = Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT' });
  assert(isTransientLlmError(timeoutErr), 'ETIMEDOUT is transient');

  assert(isTransientLlmError({ message: 'socket hang up' }), 'socket hang up is transient');

  assert(
    !isTransientLlmError(new TypeError('cannot read properties of undefined')),
    'local TypeError must fail fast, not retry for 30min'
  );
  assert(!isTransientLlmError(Object.assign(new Error('bad handler'), { code: 'ERR_INVALID_ARG_TYPE' })), 'arg error not transient');

  const aborted = new Error('已停止');
  aborted.name = 'AbortError';
  assert(!isTransientLlmError(aborted), 'abort is never transient');
}

/**
 * 结构化传输码：core 把「连不上 / 被掐断 / 超时 / 响应体中断」标成 `LLM_TRANSPORT`。
 *
 * 这条钉的是 2026-11-18 的现场：网关重启掐断在途请求，reqwest 只说
 * `error sending request for url (...)`，词表一条都不匹配 → 可重连的瞬断被判成永久失败。
 */
function testTransportCodeIsTransient() {
  assert(LLM_TRANSPORT_CODE === 'LLM_TRANSPORT', `传输码值是两端共享的常量，实际 ${LLM_TRANSPORT_CODE}`);

  const transport = Object.assign(
    new Error(
      '模型接口传输失败（connect）：error sending request for url (http://192.168.31.62:5018/v1/chat/completions) ← connection refused'
    ),
    { code: LLM_TRANSPORT_CODE }
  );
  assert(isTransientLlmError(transport), 'LLM_TRANSPORT 必须可重连');

  // 只靠文案（穿过 IPC 丢了 code）也必须认——这句是我们自己写的
  assert(isTransientLlmError({ message: transport.message }), '传输失败文案本身可重连');

  // 重连耗尽后由 rust-loop-runner 加的前缀：IPC 只搬 message，这是唯一剩下的信号
  assert(
    isTransientLlmError({ message: `已自动重连 3 次仍未恢复：${transport.message}` }),
    '已自动重连标记要认'
  );

  // 业务性失败不能被误判：上游 400 / 鉴权 / 配额走的是 LLM_API
  assert(
    !isTransientLlmError(Object.assign(new Error('HTTP 401 invalid api key'), { code: 'LLM_API' })),
    'LLM_API 鉴权失败不可重连'
  );
  // 已经耗尽的重连错误不许再进重连循环（否则就成了无限重试）
  assert(
    !isTransientLlmError(Object.assign(new Error('已自动重连 3 次仍未恢复'), { code: 'LLM_RECONNECT_EXHAUSTED' })),
    'LLM_RECONNECT_EXHAUSTED 不再重连'
  );
}

/** 传输码真的会触发重试：前两次失败，第三次成功。 */
async function testTransportCodeIsRetried() {
  let n = 0;
  const result = await runWithLlmReconnectRetry(
    async () => {
      n += 1;
      if (n < 3) {
        throw Object.assign(new Error('模型接口传输失败（connect）：error sending request for url (http://x/v1)'), {
          code: LLM_TRANSPORT_CODE
        });
      }
      return 'ok';
    },
    { maxRetries: 3, baseDelayMs: 200, maxDelayMs: 200 }
  );
  assert(result === 'ok', '第三次应成功');
  assert(n === 3, `应尝试 3 次，实际 ${n}`);
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
  testTransientErrorShape();
  testTransportCodeIsTransient();
  await testTransportCodeIsRetried();
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
