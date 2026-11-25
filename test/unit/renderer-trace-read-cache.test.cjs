'use strict';

/**
 * 思考区回放缓存（`trace-store.js` 的 `<trace-read-cache>` 段）回归。
 *
 * 现场：切会话时每条历史回合各取一次**整份** trace（首屏最多 32 次 RPC，实测单会话
 * 1–3MB），此前没有任何记忆 —— 切回来还要重拉一遍、再整块重绘气泡。
 *
 * 这里锁六条不变式：
 * 1. 同一 runId 在途只发一次请求；
 * 2. 命中后不再发请求（切走再切回来 = peek 命中，0 次 RPC）；
 * 3. 写穿失效：trace 落库后作废该 runId（缓存不许留半截 trace）；
 * 4. 失败 / 空 trace 不写缓存（要能重试）；体积超上限按最久未用先丢；
 * 5. 展示态（`shape: 'display'`）与完整态（`full`）分档缓存，互不污染；
 * 6. 升级（展开某轮 / 某个 diff）只取一次，之后连「展示态」请求也直接复用完整行。
 *
 * 浏览器脚本没有 module.exports，按 `<trace-read-cache>` 标记摘出那一段来验
 * （手法同 `renderer-chat-window-on-leave.test.cjs`）。
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SOURCE = fs.readFileSync(
  path.join(__dirname, '..', '..', 'src', 'renderer', 'agent', 'trace-store.js'),
  'utf8'
);

const BEGIN = '/* <trace-read-cache> */';
const END = '/* </trace-read-cache> */';

function extractBlock(src) {
  const start = src.indexOf(BEGIN);
  const end = src.indexOf(END);
  assert.ok(start >= 0 && end > start, '没找到 <trace-read-cache> 标记段');
  return src.slice(start + BEGIN.length, end);
}

const BLOCK = extractBlock(SOURCE);

/** 每次新建一份模块作用域（Map 是新的），并注入 gatewayCall / getAgentLimits / console 桩。 */
function createCache({ maxMb = 12, fetchImpl } = {}) {
  const calls = [];
  const gatewayCall = (method, params) => {
    calls.push({ method, params });
    if (fetchImpl) return fetchImpl(method, params);
    return Promise.resolve({ runId: params.runId, trace: [{ round: 1, thought: '想一想', tools: [] }] });
  };
  const getAgentLimits = () => ({ rendererTraceCacheMaxMb: maxMb });
  const factory = new Function(
    'gatewayCall',
    'getAgentLimits',
    'console',
    `${BLOCK}
     return { peekAgentTraceRead, readAgentTraceRecord, upgradeAgentTraceRecord,
              invalidateAgentTraceRead, agentTraceReadCacheMaxChars };`
  );
  const api = factory(gatewayCall, getAgentLimits, { warn() {} });
  return { ...api, calls };
}

const DISPLAY = { shape: 'display' };

test('同一 runId 在途只发一次请求（并发回放不放大）', async () => {
  const cache = createCache();
  const [a, b, c] = await Promise.all([
    cache.readAgentTraceRecord('trace-1', DISPLAY),
    cache.readAgentTraceRecord('trace-1', DISPLAY),
    cache.readAgentTraceRecord('trace-1', DISPLAY)
  ]);
  assert.equal(cache.calls.length, 1, '三次并发只该发一次 agent.trace_get');
  assert.equal(a.trace.length, 1);
  assert.equal(a, b);
  assert.equal(b, c);
});

test('回放默认要展示态：请求带 shape=display', async () => {
  const cache = createCache();
  await cache.readAgentTraceRecord('trace-1', DISPLAY);
  assert.deepEqual(cache.calls[0].params, { runId: 'trace-1', shape: 'display' });
  // 完整态（缺失 shape）不带这个字段
  const other = createCache();
  await other.readAgentTraceRecord('trace-2');
  assert.deepEqual(other.calls[0].params, { runId: 'trace-2' });
});

test('命中后不再发请求：切走再切回来（peek）等于 0 次 RPC', async () => {
  const cache = createCache();
  await cache.readAgentTraceRecord('trace-1', DISPLAY);
  assert.equal(cache.calls.length, 1);
  const hit = cache.peekAgentTraceRead('trace-1', DISPLAY);
  assert.ok(hit && hit.trace.length === 1);
  await cache.readAgentTraceRecord('trace-1', DISPLAY);
  assert.equal(cache.calls.length, 1, '命中后不该再打一次 RPC');
});

test('展示态与完整态分档：升级单独取一次，之后展示态请求直接复用完整行', async () => {
  const cache = createCache();
  await cache.readAgentTraceRecord('trace-1', DISPLAY);
  assert.equal(cache.calls.length, 1);

  const full = await cache.upgradeAgentTraceRecord('trace-1');
  assert.equal(cache.calls.length, 2, '升级要单独取一次完整行');
  assert.deepEqual(cache.calls[1].params, { runId: 'trace-1' }, '完整态不带 shape');
  assert.ok(full && full.trace.length === 1);

  // 升级后同一个 runId 再要展示态：手上是完整行（超集），不该再发请求
  const again = await cache.readAgentTraceRecord('trace-1', DISPLAY);
  assert.equal(cache.calls.length, 2);
  assert.equal(again, full);

  // 升级本身也只取一次
  await cache.upgradeAgentTraceRecord('trace-1');
  assert.equal(cache.calls.length, 2);
});

test('写穿失效：落库后作废（两档一起清），下一次回放重新读', async () => {
  const cache = createCache();
  await cache.readAgentTraceRecord('trace-1', DISPLAY);
  await cache.upgradeAgentTraceRecord('trace-1');
  assert.ok(cache.peekAgentTraceRead('trace-1', DISPLAY));
  assert.ok(cache.peekAgentTraceRead('trace-1'));
  cache.invalidateAgentTraceRead('trace-1');
  assert.equal(cache.peekAgentTraceRead('trace-1', DISPLAY), null, '失效后不许再命中');
  assert.equal(cache.peekAgentTraceRead('trace-1'), null, '完整档也要作废');
  await cache.readAgentTraceRecord('trace-1', DISPLAY);
  assert.equal(cache.calls.length, 3, '失效后应重读一次');
});

test('失败不写缓存（要能重试），且返回 null 而不是抛', async () => {
  let attempt = 0;
  const cache = createCache({
    fetchImpl: () => {
      attempt += 1;
      return attempt === 1 ? Promise.reject(new Error('core busy')) : Promise.resolve({ trace: [{ round: 1 }] });
    }
  });
  const first = await cache.readAgentTraceRecord('trace-9', DISPLAY);
  assert.equal(first, null);
  assert.equal(cache.peekAgentTraceRead('trace-9', DISPLAY), null, '失败的结果不许进缓存');
  const second = await cache.readAgentTraceRecord('trace-9', DISPLAY);
  assert.equal(cache.calls.length, 2, '第二次应该重试');
  assert.ok(second && second.trace.length === 1);
});

test('空 trace / 无行不写缓存（不占预算，也不挡住后来的真实内容）', async () => {
  const cache = createCache({ fetchImpl: () => Promise.resolve({ runId: 'trace-x', trace: [] }) });
  await cache.readAgentTraceRecord('trace-x', DISPLAY);
  assert.equal(cache.peekAgentTraceRead('trace-x', DISPLAY), null);
  await cache.readAgentTraceRecord('trace-x', DISPLAY);
  assert.equal(cache.calls.length, 2, '空 trace 不该被当作命中');

  const missing = createCache({ fetchImpl: () => Promise.resolve(null) });
  await missing.readAgentTraceRecord('trace-y', DISPLAY);
  assert.equal(missing.peekAgentTraceRead('trace-y', DISPLAY), null);
});

test('按体积淘汰：超上限先丢最久未用的，且至少留最后一条', async () => {
  const big = 'x'.repeat(1000);
  const cache = createCache({
    maxMb: 2 / 1024,
    fetchImpl: (_m, p) => Promise.resolve({ runId: p.runId, trace: [{ thought: big }] })
  });
  assert.ok(cache.agentTraceReadCacheMaxChars() <= 2100);
  await cache.readAgentTraceRecord('trace-a', DISPLAY);
  await cache.readAgentTraceRecord('trace-b', DISPLAY);
  await cache.readAgentTraceRecord('trace-c', DISPLAY);
  assert.equal(cache.peekAgentTraceRead('trace-a', DISPLAY), null, '最久未用的该被淘汰');
  assert.ok(cache.peekAgentTraceRead('trace-c', DISPLAY), '刚用过的必须留着');

  const one = createCache({
    maxMb: 1 / 1024,
    fetchImpl: (_m, p) => Promise.resolve({ runId: p.runId, trace: [{ thought: big }] })
  });
  await one.readAgentTraceRecord('trace-huge', DISPLAY);
  assert.ok(one.peekAgentTraceRead('trace-huge', DISPLAY), '单条超预算也要留一条');
});
