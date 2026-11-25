'use strict';

/**
 * 思考区回放缓存（`trace-store.js` 的 `<trace-read-cache>` 段）回归。
 *
 * 现场：切会话时每条历史回合各取一次**整份** trace（首屏最多 32 次 RPC，实测单会话
 * 1–3MB），此前没有任何记忆 —— 切回来还要重拉一遍、再整块重绘气泡。
 *
 * 这里锁四条不变式：
 * 1. 同一 runId 在途只发一次请求；
 * 2. 命中后不再发请求（切走再切回来 = peek 命中，0 次 RPC）；
 * 3. 写穿失效：trace 落库后作废该 runId（缓存不许留半截 trace）；
 * 4. 失败 / 空 trace 不写缓存（要能重试）；体积超上限按最久未用先丢。
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

/** 每次新建一份模块作用域（Map 是新的），并注入 gatewayCall / getAgentLimits 桩。 */
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
     return { peekAgentTraceRead, readAgentTraceRecord, invalidateAgentTraceRead,
              agentTraceReadCacheMaxChars };`
  );
  const api = factory(gatewayCall, getAgentLimits, { warn() {} });
  return { ...api, calls };
}

test('同一 runId 在途只发一次请求（并发回放不放大）', async () => {
  const cache = createCache();
  const [a, b, c] = await Promise.all([
    cache.readAgentTraceRecord('trace-1'),
    cache.readAgentTraceRecord('trace-1'),
    cache.readAgentTraceRecord('trace-1')
  ]);
  assert.equal(cache.calls.length, 1, '三次并发只该发一次 agent.trace_get');
  assert.equal(a.trace.length, 1);
  assert.equal(a, b);
  assert.equal(b, c);
});

test('命中后不再发请求：切走再切回来（peek）等于 0 次 RPC', async () => {
  const cache = createCache();
  await cache.readAgentTraceRecord('trace-1');
  assert.equal(cache.calls.length, 1);
  // 切走 → DOM 全被换掉 → 切回来重新渲染同一条消息：同步 peek 直接命中
  const hit = cache.peekAgentTraceRead('trace-1');
  assert.ok(hit && hit.trace.length === 1);
  await cache.readAgentTraceRecord('trace-1');
  assert.equal(cache.calls.length, 1, '命中后不该再打一次 RPC');
});

test('写穿失效：落库后作废，下一次回放重新读', async () => {
  const cache = createCache();
  await cache.readAgentTraceRecord('trace-1');
  assert.equal(cache.peekAgentTraceRead('trace-1').trace.length, 1);
  cache.invalidateAgentTraceRead('trace-1');
  assert.equal(cache.peekAgentTraceRead('trace-1'), null, '失效后不许再命中');
  await cache.readAgentTraceRecord('trace-1');
  assert.equal(cache.calls.length, 2, '失效后应重读一次');
});

test('失败不写缓存（要能重试），且返回 null 而不是抛', async () => {
  let attempt = 0;
  const cache = createCache({
    fetchImpl: () => {
      attempt += 1;
      return attempt === 1 ? Promise.reject(new Error('core busy')) : Promise.resolve({ trace: [{ round: 1 }] });
    }
  });
  const first = await cache.readAgentTraceRecord('trace-9');
  assert.equal(first, null);
  assert.equal(cache.peekAgentTraceRead('trace-9'), null, '失败的结果不许进缓存');
  const second = await cache.readAgentTraceRecord('trace-9');
  assert.equal(cache.calls.length, 2, '第二次应该重试');
  assert.ok(second && second.trace.length === 1);
});

test('空 trace / 无行不写缓存（不占预算，也不挡住后来的真实内容）', async () => {
  const cache = createCache({ fetchImpl: () => Promise.resolve({ runId: 'trace-x', trace: [] }) });
  await cache.readAgentTraceRecord('trace-x');
  assert.equal(cache.peekAgentTraceRead('trace-x'), null);
  await cache.readAgentTraceRecord('trace-x');
  assert.equal(cache.calls.length, 2, '空 trace 不该被当作命中');

  const missing = createCache({ fetchImpl: () => Promise.resolve(null) });
  await missing.readAgentTraceRecord('trace-y');
  assert.equal(missing.peekAgentTraceRead('trace-y'), null);
});

test('按体积淘汰：超上限先丢最久未用的，且至少留最后一条', async () => {
  // 上限 2KB（约 2048 字符）；每行 trace 约 1KB 字符
  const big = 'x'.repeat(1000);
  const cache = createCache({
    maxMb: 2 / 1024,
    fetchImpl: (_m, p) => Promise.resolve({ runId: p.runId, trace: [{ thought: big }] })
  });
  assert.ok(cache.agentTraceReadCacheMaxChars() <= 2100);
  await cache.readAgentTraceRecord('trace-a');
  await cache.readAgentTraceRecord('trace-b');
  await cache.readAgentTraceRecord('trace-c'); // 塞进来后应把最老的 a 挤掉
  assert.equal(cache.peekAgentTraceRead('trace-a'), null, '最久未用的该被淘汰');
  assert.ok(cache.peekAgentTraceRead('trace-c'), '刚用过的必须留着');

  // 单条就超预算时仍保留它（不能让这一次回放没数据可用）
  const one = createCache({ maxMb: 1 / 1024, fetchImpl: (_m, p) => Promise.resolve({ runId: p.runId, trace: [{ thought: big }] }) });
  await one.readAgentTraceRecord('trace-huge');
  assert.ok(one.peekAgentTraceRead('trace-huge'), '单条超预算也要留一条');
});
