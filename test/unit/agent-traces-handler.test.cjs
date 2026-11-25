'use strict';

/**
 * `agent.trace_get` / `agent.traces_get` 的展示态整形（网关层）。
 *
 * 回放思考区时渲染层要 `shape:'display'`：裁掉界面从不读的字段、思考全文只留开头一截，
 * 展开时再换完整态。**默认 full** —— 要落库 / 参与判定的调用方（例如
 * `recoverInterruptedAssistantTurn` 会把取到的 trace 写回账本）绝不能拿到裁过的行。
 *
 * 这里锁三件事：
 * 1. 不传 shape / 传 full → 原样返回（逐字节相同，不重建对象）；
 * 2. `shape:'display'` → 逐行套同一份整形（`src/agent/trace-display.js`）；
 * 3. `shape` 只属于展示层：不得透传给 core（core 的入参只有 runIds / runId / messageId）。
 */

const assert = require('node:assert/strict');
const path = require('node:path');

const { createAgentHandlers } = require(
  path.join(__dirname, '..', '..', 'src', 'gateway', 'handlers', 'agent.js')
);
const { getAgentLimits } = require(path.join(__dirname, '..', '..', 'src', 'agent', 'agent-limits.js'));

const HEAD = getAgentLimits().traceDisplayThoughtHeadChars;

function makeRow(runId) {
  return {
    id: 1,
    runId,
    sessionId: 's1',
    messageId: 7,
    phase: 'assistant',
    createdAt: 1,
    trace: [
      {
        round: 1,
        phase: 'tool',
        thought: '短版',
        fullThought: 'F'.repeat(HEAD * 2),
        tools: [
          {
            name: 'fs_edit_file',
            argsBrief: 'src/a.js',
            summary: '写入完成 +12 -3',
            toolArgs: { filePath: 'src/a.js', content: 'x'.repeat(50) },
            args: { filePath: 'src/a.js' },
            result: { ok: true },
            diff: { created: false, added: 12, removed: 3, beforeText: 'B', afterText: 'A', beforeSnippet: 'snip' }
          }
        ]
      }
    ]
  };
}

function makeHandlers(payloadByMethod) {
  const calls = [];
  const requireRustCore = (method, params) => {
    calls.push({ method, params });
    return Promise.resolve(payloadByMethod[method]);
  };
  return { handlers: createAgentHandlers({ requireRustCore }), calls };
}

test('批量读：shape=display 时逐行整形，且 shape 不透传给 core', async () => {
  const rows = { 'trace-1': makeRow('trace-1'), 'trace-2': makeRow('trace-2') };
  const { handlers, calls } = makeHandlers({ 'agent.traces_get': { rows } });

  const out = await handlers['agent.traces_get']({ runIds: ['trace-1', 'trace-2'], shape: 'display' });

  assert.deepEqual(calls, [{ method: 'agent.traces_get', params: { runIds: ['trace-1', 'trace-2'] } }]);
  const tool = out.rows['trace-1'].trace[0].tools[0];
  assert.equal(tool.result, undefined, '界面从不读的 result 不该搬');
  assert.equal(tool.args, undefined);
  assert.deepEqual(tool.toolArgs, { filePath: 'src/a.js' });
  assert.equal(tool.diff.beforeText, '', 'diff 正文裁成空串');
  assert.equal(tool.diff.textTrimmed, true);
  assert.equal(tool.summary, '写入完成 +12 -3', '摘要字段必须留着');
  assert.equal(out.rows['trace-1'].trace[0].fullThought.length, HEAD, '思考只留开头一截');
  assert.equal(out.rows['trace-1'].trace[0].fullThoughtTruncated, true);
  assert.ok(out.rows['trace-2'], '每一行都整形（不是只第一行）');
});

test('批量读：不传 shape（默认 full）→ 原样返回，一个字段都不动', async () => {
  const rows = { 'trace-1': makeRow('trace-1') };
  const { handlers } = makeHandlers({ 'agent.traces_get': { rows } });
  const out = await handlers['agent.traces_get']({ runIds: ['trace-1'] });
  assert.equal(out.rows['trace-1'], rows['trace-1'], '必须是同一个对象（未重建）');
  assert.equal(out.rows['trace-1'].trace[0].fullThought.length, HEAD * 2);
  assert.ok(out.rows['trace-1'].trace[0].tools[0].result, '完整态要保留 result');
});

test('单条读：同样只在 display 时整形', async () => {
  const row = makeRow('trace-9');
  const { handlers, calls } = makeHandlers({ 'agent.trace_get': row });
  const shaped = await handlers['agent.trace_get']({ runId: 'trace-9', shape: 'display' });
  assert.deepEqual(calls, [{ method: 'agent.trace_get', params: { runId: 'trace-9', messageId: undefined } }]);
  assert.equal(shaped.trace[0].tools[0].result, undefined);

  const plain = await handlers['agent.trace_get']({ runId: 'trace-9' });
  assert.equal(plain, row, '不传 shape 时原样返回（落库 / 判定类调用方靠这个）');
});

test('批量读：core 回空 / 缺字段时不炸', async () => {
  const { handlers } = makeHandlers({ 'agent.traces_get': { rows: {} } });
  const out = await handlers['agent.traces_get']({ runIds: ['a', 'b'], shape: 'display' });
  assert.deepEqual(out.rows, {});

  const { handlers: h2 } = makeHandlers({ 'agent.traces_get': null });
  assert.equal(await h2['agent.traces_get']({ runIds: ['a'], shape: 'display' }), null);
});
