'use strict';
/**
 * 右侧面板「子代理」页的判定逻辑（`src/renderer/renderer-subagent-panel.js`）。
 *
 * 该文件是纯浏览器脚本（`<script>` 直接加载，无 module.exports），这里用 `new Function`
 * 造最小环境把函数取出来断言。守的是「这次运行」的语义：
 * 1. 只认思考区同一份判据筛出的子代理卡片（`isolated && rounds`）；
 * 2. 有 live 就以 live 为准 —— 本轮没有子代理时不能拿上一轮的卡片冒充；
 * 3. live 消失（run 收尾）后保留最后一次快照，且状态必须是「已结束」；
 * 4. 快照按会话隔离；
 * 5. 标题状态 / 头部摘要文案。
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = path.join(__dirname, '..', '..', 'src', 'renderer', 'renderer-subagent-panel.js');

const isCard = (e) => !!(e && e.isolated && Array.isArray(e.rounds));
const isRunning = (e) => !!(e && e.runDone === false);

function load(options = {}) {
  const holder = {
    sessionId: options.currentSessionId || 's1',
    toString() {
      return holder.sessionId;
    }
  };
  const sessionActiveRuns = options.sessionActiveRuns || new Map();
  const source = fs.readFileSync(SRC, 'utf8');
  const factory = new Function(
    'document',
    'CSS',
    'currentSessionId',
    'sessionActiveRuns',
    'isIsolatedCardEntry',
    'isolatedCardRunning',
    'fillIsolatedCardBody',
    'openSidePanel',
    `${source}
     return {
       filterIsolatedCards: filterIsolatedCards,
       readSubagentPanelSnapshot: readSubagentPanelSnapshot,
       subagentPanelMetaText: subagentPanelMetaText,
       subagentCardStatusLabel: subagentCardStatusLabel,
       snapshots: subagentPanelSnapshots
     };`
  );
  const api = factory(
    { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [] },
    { escape: (s) => s },
    holder,
    sessionActiveRuns,
    isCard,
    isRunning,
    () => {},
    () => {}
  );
  api.sessionHolder = holder;
  return api;
}

function card(id, rounds = [], extra = {}) {
  return { isolated: true, subagentId: id, phase: `调研 #${id}`, rounds, ...extra };
}

describe('子代理面板：卡片筛选', () => {
  test('只留 isolated 且带 rounds 的条目', () => {
    const api = load();
    const trace = [
      { round: 1, thought: '普通轮次', tools: [] },
      card('sa-1', [{ round: 1, thought: 't', tools: [] }]),
      { isolated: true, subagentId: 'no-rounds' },
      null
    ];
    assert.deepEqual(
      api.filterIsolatedCards(trace).map((e) => e.subagentId),
      ['sa-1']
    );
    assert.deepEqual(api.filterIsolatedCards(null), []);
  });
});

describe('子代理面板：状态文案', () => {
  test('运行中 / 已完成（轮数 + 步数）', () => {
    const api = load();
    const running = card('a', [{ round: 1, thought: 't', tools: [] }], { runDone: false });
    assert.equal(api.subagentCardStatusLabel(running, true), '运行中…');

    const done = card('b', [
      { round: 1, thought: 't', tools: [{ name: 'read' }, { name: 'grep' }] },
      { round: 2, thought: 't', tools: [{ name: 'read' }] }
    ], { runDone: true });
    assert.equal(api.subagentCardStatusLabel(done, true), '已完成 · 2 轮 · 3 步');

    const single = card('c', [{ round: 1, thought: 't', tools: [] }], { runDone: true });
    assert.equal(api.subagentCardStatusLabel(single, true), '已完成');
  });

  test('头部摘要三态', () => {
    const api = load();
    assert.equal(api.subagentPanelMetaText([], false), '—');
    assert.equal(
      api.subagentPanelMetaText([card('a', [{ round: 1, tools: [] }], { runDone: true })], true),
      '1 个 · 已结束'
    );
    assert.equal(
      api.subagentPanelMetaText(
        [
          card('a', [{ round: 1, tools: [] }], { runDone: false }),
          card('b', [{ round: 1, tools: [] }], { runDone: true })
        ],
        true
      ),
      '2 个 · 1 运行中'
    );
  });
});

describe('子代理面板：本次运行的快照语义', () => {
  test('运行中以 live 为准', () => {
    const runs = new Map([
      ['s1', { runId: 'run-1', trace: [{ round: 1 }, card('sa-1', [{ round: 1, tools: [] }])] }]
    ]);
    const api = load({ sessionActiveRuns: runs });
    const snap = api.readSubagentPanelSnapshot();
    assert.equal(snap.runId, 'run-1');
    assert.equal(snap.running, true);
    assert.deepEqual(snap.cards.map((e) => e.subagentId), ['sa-1']);
  });

  test('新一轮没有子代理时不留上一轮的卡片', () => {
    const runs = new Map([
      ['s1', { runId: 'run-1', trace: [card('sa-1', [{ round: 1, tools: [] }])] }]
    ]);
    const api = load({ sessionActiveRuns: runs });
    assert.equal(api.readSubagentPanelSnapshot().cards.length, 1);

    runs.set('s1', { runId: 'run-2', trace: [{ round: 1, thought: '没有子代理' }] });
    const next = api.readSubagentPanelSnapshot();
    assert.equal(next.runId, 'run-2');
    assert.deepEqual(next.cards, []);
  });

  test('run 收尾后保留最后一次快照，并标记已结束', () => {
    const runs = new Map([
      ['s1', { runId: 'run-1', trace: [card('sa-1', [{ round: 1, tools: [] }], { runDone: true })] }]
    ]);
    const api = load({ sessionActiveRuns: runs });
    const during = api.readSubagentPanelSnapshot();
    assert.equal(during.running, true);

    runs.delete('s1');
    const after = api.readSubagentPanelSnapshot();
    assert.equal(after.running, false, 'live 消失后不能继续显示「运行中」');
    assert.deepEqual(after.cards.map((e) => e.subagentId), ['sa-1']);
    assert.equal(api.subagentCardStatusLabel(after.cards[0], after.running), '已完成');
  });

  test('快照按会话隔离', () => {
    const runs = new Map([
      ['s1', { runId: 'run-1', trace: [card('sa-1', [{ round: 1, tools: [] }])] }]
    ]);
    const api = load({ sessionActiveRuns: runs, currentSessionId: 's1' });
    assert.equal(api.readSubagentPanelSnapshot().cards.length, 1);
    runs.delete('s1');

    // run 收尾后仍看得到这次运行
    assert.equal(api.readSubagentPanelSnapshot().cards.length, 1);
    assert.equal(api.snapshots.size, 1);

    // 换到另一个会话：读不到 s1 的快照
    api.sessionHolder.sessionId = 's2';
    assert.deepEqual(api.readSubagentPanelSnapshot().cards, []);
  });
});
