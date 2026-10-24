'use strict';
/**
 * 子 Agent 追问续用（src/agent/subagent-runner.js 的 continueFrom）。
 *
 * 守的语义：
 * 1. 普通 run 留存上下文（child.messages），追问带 continueFrom → 在原 messages 后追加
 *    followup user 轮（不是重发原始提示词），返回 continuedFrom；
 * 2. continueFrom 不存在 / 已被 LRU 淘汰 → 结构化错误，不抛异常；
 * 3. retention=0 → 不留存，追问一律 NOT_FOUND；
 * 4. 深度与只读工具集不变（追问轮仍拿 Explore 白名单）。
 */
const assert = require('node:assert/strict');
const { createSubagentRunner, buildFollowupPrompt } = require('../../src/agent/subagent-runner');

const READONLY_TOOLS = [
  { type: 'function', function: { name: 'fs_read_file', parameters: {} } },
  { type: 'function', function: { name: 'grep', parameters: {} } }
];

function makeRunner(runChildLoop, limits) {
  return createSubagentRunner({
    runChildLoop,
    allTools: READONLY_TOOLS,
    limits: Object.assign(
      {
        subagentMaxDepth: 1,
        subagentMaxConcurrent: 3,
        subagentMaxPerRun: 8,
        subagentMaxRounds: 4,
        subagentMaxToolCalls: 8,
        subagentSummaryMaxChars: 2400,
        subagentFollowupRetention: 8
      },
      limits || {}
    )
  });
}

test('追问沿用原上下文，追加 followup 轮', async () => {
  const seen = [];
  const runner = makeRunner(async (req) => {
    seen.push(req);
    return {
      content: `第 ${seen.length} 次结论`,
      messages: [...req.messages, { role: 'assistant', content: `第 ${seen.length} 次结论` }]
    };
  });

  const first = await runner.run({ task: '查鉴权入口' });
  assert.equal(first.ok, true);
  const firstId = first.subagentId;

  const second = await runner.run({ task: '谁调用了它？', continueFrom: firstId });
  assert.equal(second.ok, true);
  assert.equal(second.continuedFrom, firstId);

  // 第 2 次请求 = 第 1 次的完整 messages + 追问 user 轮
  assert.equal(seen.length, 2);
  assert.equal(seen[0].messages.length, 1);
  assert.equal(seen[1].messages.length, 3, '原 user + 原 assistant + 追问 user');
  const lastMsg = seen[1].messages[seen[1].messages.length - 1];
  assert.equal(lastMsg.role, 'user');
  assert.ok(lastMsg.content.includes('同一调研的追问'), '追问提示词标明延续语义');
  assert.ok(lastMsg.content.includes('查鉴权入口'));
  assert.ok(lastMsg.content.includes('谁调用了它？'));
  // 追问仍是只读白名单 + 同预算
  assert.equal(seen[1].tools.length, READONLY_TOOLS.length);
  assert.equal(seen[1].maxRounds, 4);

  // 追问后留存指向新 id（链式续问）
  const third = await runner.run({ task: '再确认一处', continueFrom: second.subagentId });
  assert.equal(third.ok, true);
  assert.equal(seen[2].messages.length, 5);
});

test('continueFrom 无效 → 结构化错误不抛异常', async () => {
  const runner = makeRunner(async () => ({ content: 'ok', messages: [] }));
  const r = await runner.run({ task: 'x', continueFrom: 'ghost' });
  assert.equal(r.errorCode, 'SUBAGENT_FOLLOWUP_NOT_FOUND');
  assert.ok(String(r.error).includes('ghost'));
});

test('retention=0 关闭追问；LRU 淘汰旧 id', async () => {
  const runner0 = makeRunner(async (req) => ({
    content: 'ok',
    messages: [...req.messages, { role: 'assistant', content: 'ok' }]
  }), { subagentFollowupRetention: 0 });
  const a = await runner0.run({ task: 'x' });
  const r0 = await runner0.run({ task: 'y', continueFrom: a.subagentId });
  assert.equal(r0.errorCode, 'SUBAGENT_FOLLOWUP_NOT_FOUND');

  const runner2 = makeRunner(async (req) => ({
    content: 'ok',
    messages: [...req.messages, { role: 'assistant', content: 'ok' }]
  }), { subagentFollowupRetention: 1 });
  const p1 = await runner2.run({ task: '一' });
  await runner2.run({ task: '二' }); // 挤掉 p1（LRU=1）
  const evicted = await runner2.run({ task: '三', continueFrom: p1.subagentId });
  assert.equal(evicted.errorCode, 'SUBAGENT_FOLLOWUP_NOT_FOUND');
});

test('buildFollowupPrompt 带 hints 与不重查指令', () => {
  const text = buildFollowupPrompt('原任务A', '新问题B', ['线索1']);
  assert.ok(text.includes('原任务A') && text.includes('新问题B'));
  assert.ok(text.includes('线索1'));
  assert.ok(text.includes('不要重查'));
});
