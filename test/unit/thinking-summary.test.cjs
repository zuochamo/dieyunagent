'use strict';
/**
 * 聊天区「子 Agent 过程卡片」的折叠摘要（`src/renderer/renderer-thinking-trace-dom.js`）。
 *
 * 只守一条产品决定：**卡片标题是稳定的身份牌** ——
 * 「类型 + 序号」+「运行中… / 已完成 · N 步」，**不拼最新思考预览**。
 * 为什么值得单测：那行预览每个 token 都在变（一次 32 步的子 Agent 会把标题改写上百次），
 * 一旦有人「顺手把 preview 加回来」，卡片标题会重新变成一条不停跳动的长句 —— 肉眼难查、回归代价高。
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = path.join(
  __dirname,
  '..',
  '..',
  'src',
  'renderer',
  'renderer-thinking-trace-dom.js'
);

function load(options = {}) {
  const source = fs.readFileSync(SRC, 'utf8');
  const factory = new Function(
    'tracePrefs',
    'isolatedCardRunning',
    `${source}
     return { thinkingRoundSummaryParts: thinkingRoundSummaryParts };`
  );
  return factory(
    { showReasoning: options.showReasoning !== false },
    (e) => !!(e && e.runDone === false)
  );
}

function card(rounds, extra = {}) {
  return {
    isolated: true,
    subagentId: 'sa-explore-1',
    phase: '勘察子 Agent #1',
    // 故意放一段「看起来像标题」的思考原文：它不该出现在摘要里
    thought: 'Confirmed: the session worktree is at OLD state 7239f8c — it still has wallet.go',
    rounds,
    ...extra
  };
}

describe('子 Agent 卡片摘要：只报身份与状态', () => {
  test('已完成：类型 + 序号 + 步数，不含思考预览', () => {
    const api = load();
    const entry = card(
      [
        { round: 1, tools: [{ name: 'grep' }, { name: 'fs_read_file' }] },
        { round: 2, tools: [{ name: 'host_exec' }] }
      ],
      { runDone: true }
    );
    const parts = api.thinkingRoundSummaryParts(entry, 0, [entry]);
    assert.equal(parts.name, '勘察子 Agent #1');
    assert.equal(parts.primary, '', '思考预览不进标题（它每个 token 都在变）');
    assert.equal(parts.suffix, '已完成 · 3 步');
    assert.equal(parts.combined, '勘察子 Agent #1 · 已完成 · 3 步');
  });

  test('运行中：状态位替代步数', () => {
    const api = load();
    const entry = card([{ round: 1, tools: [{ name: 'grep' }] }], { runDone: false });
    const parts = api.thinkingRoundSummaryParts(entry, 0, [entry]);
    assert.equal(parts.combined, '勘察子 Agent #1 · 运行中…');
  });

  test('一次工具都没调过时只说「已完成」', () => {
    const api = load();
    const entry = card([{ round: 1, tools: [] }], { runDone: true });
    assert.equal(api.thinkingRoundSummaryParts(entry, 0, [entry]).combined, '勘察子 Agent #1 · 已完成');
  });
});
