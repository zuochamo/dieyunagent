'use strict';

const assert = require('assert');
const { createLiveLoopTraceTracker } = require('../src/agent/rust-planner-runner');

function testParallelMeta() {
  const updates = [];
  const tracker = createLiveLoopTraceTracker(
    { worker: 'A', taskId: 'A1', subagentId: 'exec-a-1', parallel: true },
    {
      onUpdate: (entries) => updates.push(entries)
    }
  );
  tracker.handlePhase('start', {});
  tracker.handlePhase('llm_delta', { round: 0, reasoning: '分析代码结构' });
  tracker.handlePhase('llm_response', { round: 0, toolCalls: 1 });
  tracker.handlePhase('need_delegate', {
    delegates: [{ id: 'tc1', name: 'Read', arguments: { path: 'foo.js' } }]
  });
  tracker.handlePhase('delegate_result', {
    id: 'tc1',
    name: 'Read',
    result: { content: 'ok' }
  });

  assert.ok(updates.length >= 3);
  const last = updates[updates.length - 1];
  assert.strictEqual(last.length, 1);
  assert.strictEqual(last[0].phase, '执行器 A · A1');
  assert.strictEqual(last[0].isolated, true);
  assert.strictEqual(last[0].parallel, true);
  assert.strictEqual(last[0].subagentId, 'exec-a-1');
  assert.match(last[0].thought, /分析代码结构/);
  assert.strictEqual(last[0].tools.length, 1);
  assert.strictEqual(last[0].tools[0].pending, false);
  assert.strictEqual(last[0].tools[0].name, 'Read');
  console.log('testParallelMeta OK');
}

testParallelMeta();
console.log('All planner live trace tests passed');
