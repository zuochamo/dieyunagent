'use strict';

const path = require('path');
const { createCoreBridge } = require('../src/core-bridge');
const { resolveDieyunCoreBinary } = require('../src/core-bridge-path');
const { buildCompactionPrompts } = require('../src/agent/compaction-rust-bridge');

async function main() {
  const bin = resolveDieyunCoreBinary();
  if (!bin) {
    console.error('SKIP: dieyun-core binary not found (npm run pack:dieyun-core)');
    process.exit(0);
  }

  const bridge = createCoreBridge({ binaryPath: bin, log: () => {} });
  await bridge.start();

  const userA = '请修复登录 bug';
  const userB = '顺便加单元测试';
  const messages = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: userA },
    {
      role: 'assistant',
      content: '先看代码',
      tool_calls: [{ id: '1', type: 'function', function: { name: 'read', arguments: '{}' } }]
    },
    { role: 'tool', tool_call_id: '1', content: 'file contents...' },
    { role: 'user', content: userB },
    { role: 'assistant', content: 'recent tail reply' }
  ];

  for (let i = 0; i < 12; i++) {
    messages.push({
      role: 'assistant',
      content: 'x'.repeat(800),
      tool_calls: [{ id: `t${i}`, type: 'function', function: { name: 'grep', arguments: '{}' } }]
    });
    messages.push({ role: 'tool', tool_call_id: `t${i}`, content: 'y'.repeat(800) });
  }

  const prep = await bridge.invoke(
    'compaction.prepare',
    {
      messages,
      tokenBudget: 400,
      triggerRatio: 0.5,
      coolDownRounds: 0,
      force: true,
      compactionRoundCount: 0,
      prompts: buildCompactionPrompts()
    },
    30000
  );

  const need = prep.needLlm || prep.need_llm;
  if (!need) {
    console.error('FAIL: expected compaction.prepare to request LLM fold');
    process.exit(1);
  }

  const applied = await bridge.invoke(
    'compaction.apply',
    {
      messages,
      summaryJson: {
        summary: 'folded assistant work',
        userGoal: 'from summary only'
      },
      foldedIndices: need.foldedIndices || need.folded_indices || [],
      prompts: buildCompactionPrompts()
    },
    30000
  );

  if (!applied.compacted) {
    console.error('FAIL: expected compaction.apply to compact');
    process.exit(1);
  }

  const out = (applied.messages || []).map((m) => m.content).join('\n');
  if (!out.includes(userA) || !out.includes(userB)) {
    console.error('FAIL: user messages missing after compaction');
    process.exit(1);
  }
  const folded = need.foldedTranscript || need.folded_transcript || '';
  if (folded.includes(userA)) {
    console.error('FAIL: folded transcript should not contain user text');
    process.exit(1);
  }
  if (!out.includes('【对话摘要')) {
    console.error('FAIL: digest block missing');
    process.exit(1);
  }

  await bridge.stop();
  console.log('OK: user turns pinned, assistant folded (Rust compaction.prepare/apply)');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
