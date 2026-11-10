'use strict';

/**
 * 交互闸门（embedding 预算感知）的回归测试。
 *
 * 背景（现场）：自建 embedding 端点单请求 34–44s 且**完全串行**，而 prep 每轮都调
 * `memory.long_recall` / 技能召回 / 工具召回。调用方 10s 超时只掐等待者，那条 HTTP
 * 仍在端点队列里排队，下一轮再排一条 ⇒ 队列永不排空，同队列的 `codebase.search`
 * 跟着超时（`agent:prep-system-prompt` 整轮失败）。
 *
 * 契约（两侧同语义，Rust 见 crates/dieyun-core/src/embedding/mod.rs）：
 *   1. 交互调用在「最近一次成功往返 > 预算」时**不发请求**，抛 code=EMBEDDING_TOO_SLOW；
 *   2. 后台调用（批量文档 / 写库 / 重建向量）不受闸门影响；
 *   3. 查询向量命中缓存时也不受闸门影响（缓存一秒都不用等）；
 *   4. 换了端点要重新量，不能被上一个端点的成绩连坐。
 */

const assert = require('assert');
const { createEmbeddingClient } = require('../src/codebase/embedding-client');
const { AGENT_LIMITS_DEFAULTS } = require('../src/agent/agent-limits');

const DIMS = 64;
const vector = () => Array.from({ length: DIMS }, (_, i) => (i % 7) / 10);

let fetchCalls = 0;
let fetchDelayMs = 0;

// 假端点：与真实响应同形状（OpenAI 兼容 data[].embedding），可注入延迟；
// 按请求体里的 input 条数回同样多条向量（批量路径要能对上）
globalThis.fetch = async (_url, init) => {
  fetchCalls += 1;
  if (fetchDelayMs > 0) await new Promise((r) => setTimeout(r, fetchDelayMs));
  let count = 1;
  try {
    const body = JSON.parse(String((init && init.body) || '{}'));
    if (Array.isArray(body.input)) count = body.input.length;
    else if (Array.isArray(body.texts)) count = body.texts.length;
  } catch {
    count = 1;
  }
  return {
    ok: true,
    status: 200,
    text: async () =>
      JSON.stringify({
        data: Array.from({ length: count }, (_, i) => ({ index: i, embedding: vector() }))
      })
  };
};

function client(overrides = {}) {
  return createEmbeddingClient({
    baseUrl: overrides.baseUrl || 'http://gate.local/v1',
    model: 'gate-model',
    dimensions: DIMS,
    ...overrides
  });
}

async function slowEndpointTripsTheGateButNotBackgroundCalls() {
  fetchCalls = 0;
  fetchDelayMs = 25;
  // 预算压到 5ms，让一次 25ms 的假往返必然「超预算」（不依赖真实端点）
  const c = client({ baseUrl: 'http://gate-slow.local/v1', interactiveBudgetMs: 5 });

  // 第一次交互调用必须先**允许发出**（没量过就不许判慢，否则语义通道永远打不开）
  const first = await c.embedInteractive('第一次查询');
  assert.ok(Array.isArray(first) && first[0].length === DIMS, '第一条查询要能拿到向量');
  assert.strictEqual(fetchCalls, 1, '第一条查询应当真的发出去了');

  // 量到 25ms > 5ms 之后：交互调用不再发请求
  const before = fetchCalls;
  let code = '';
  try {
    await c.embedInteractive('第二条查询');
    assert.fail('超预算后交互调用不该成功');
  } catch (err) {
    code = err && err.code;
  }
  assert.strictEqual(code, 'EMBEDDING_TOO_SLOW', '超预算要回 EMBEDDING_TOO_SLOW 让调用方降级');
  assert.strictEqual(fetchCalls, before, '闸门必须在发请求**之前**生效（不能只是等完再报错）');

  // 后台调用（批量文档 / 写库）照旧：它们等得起，且算出来的是长期资产
  await c.embed(['文档一', '文档二']);
  assert.strictEqual(fetchCalls, before + 1, '后台批量调用不受交互闸门影响');
}

async function fastEndpointKeepsSemanticChannelOpen() {
  fetchCalls = 0;
  fetchDelayMs = 1;
  const c = client({ baseUrl: 'http://gate-fast.local/v1', interactiveBudgetMs: 2000 });
  await c.embedInteractive('查询一');
  await c.embedInteractive('查询二');
  assert.strictEqual(fetchCalls, 2, '快端点下交互调用照常发请求');
}

async function cachedQuerySkipsTheGate() {
  fetchCalls = 0;
  fetchDelayMs = 25;
  const c = client({ baseUrl: 'http://gate-cache.local/v1', interactiveBudgetMs: 5 });
  await c.embedInteractive('同一条查询'); // 先量出「慢」
  const before = fetchCalls;
  // 同一句文本命中查询缓存（TTL 内），不该被闸门拦下，也不该再打端点
  const again = await c.embedInteractive('同一条查询');
  assert.ok(Array.isArray(again) && again[0].length === DIMS, '缓存命中的查询向量必须直接可用');
  assert.strictEqual(fetchCalls, before, '缓存命中不该再发请求');
}

async function otherEndpointIsMeasuredSeparately() {
  fetchCalls = 0;
  fetchDelayMs = 25;
  const slow = client({ baseUrl: 'http://gate-a.local/v1', interactiveBudgetMs: 5 });
  await slow.embedInteractive('量一次慢端点');
  // 同进程换到另一个端点：旧成绩不适用，必须重新量（否则用户换快端点后语义通道一直关着）
  const other = client({ baseUrl: 'http://gate-b.local/v1', interactiveBudgetMs: 5 });
  const before = fetchCalls;
  const out = await other.embedInteractive('新端点的第一条查询');
  assert.ok(Array.isArray(out) && out[0].length === DIMS, '换端点后第一条必须允许发出');
  assert.strictEqual(fetchCalls, before + 1, '换端点必须重新量');
}

async function batchCallDoesNotPoisonTheMeasurement() {
  // 后台批量（建库/写入）一次塞多条，耗时天然长几倍；它不能被当成「查询延迟」，
  // 否则跑一次建库就能把健康端点判成慢端点，白白关掉语义召回。
  fetchCalls = 0;
  fetchDelayMs = 25;
  const c = client({ baseUrl: 'http://gate-batch.local/v1', interactiveBudgetMs: 5 });
  const docs = await c.embed(['文档一', '文档二', '文档三']);
  assert.strictEqual(docs.length, 3, '批量调用要拿到与输入等量的向量');
  const before = fetchCalls;
  const out = await c.embedInteractive('批量之后的查询');
  assert.ok(Array.isArray(out) && out[0].length === DIMS, '批量耗时不该把端点判成慢');
  assert.strictEqual(fetchCalls, before + 1, '批量调用不记账 → 交互查询照常发出');
}

async function defaultBudgetComesFromAgentLimits() {
  const budget = Number(AGENT_LIMITS_DEFAULTS.interactiveEmbedBudgetMs);
  assert.ok(Number.isFinite(budget) && budget > 0, 'agent-limits 必须给出交互预算');
  // 未覆盖时不应该因为我们传错了默认值而误判（快端点必须照常工作）
  fetchCalls = 0;
  fetchDelayMs = 1;
  const c = client({ baseUrl: 'http://gate-default.local/v1' });
  await c.embedInteractive('默认预算下的查询');
  assert.strictEqual(fetchCalls, 1);
}

(async () => {
  await slowEndpointTripsTheGateButNotBackgroundCalls();
  await fastEndpointKeepsSemanticChannelOpen();
  await cachedQuerySkipsTheGate();
  await otherEndpointIsMeasuredSeparately();
  await batchCallDoesNotPoisonTheMeasurement();
  await defaultBudgetComesFromAgentLimits();
  console.log('test-embedding-budget.cjs ok');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
