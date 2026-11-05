'use strict';

/**
 * 「目标条」与「目标」面板的渲染契约（`src/renderer/renderer-goal-panel.js`）。
 *
 * 守的三件事：
 *   1. 两个面只吃 Main 给的视图（`session-goal.toPanelView`），自己不算进度、不判完成 ——
 *      这里断言的是「视图字段到 DOM 的映射」，不是业务结论；
 *   2. 检查状态是**三态**：通过 / 未通过 / 从没跑过（`⬜`）。把「没跑过」画成失败，
 *      会让人以为模型跑挂了；
 *   3. 目标收尾后不再给「继续」：没有可推进的东西了。
 *
 * 用 `new Function` + 极简 DOM 桩（与 `renderer-tool-artifact-path.test.cjs` 同一手法）：
 * 这个模块是浏览器脚本，没有 module.exports；为了几个渲染分支去装 jsdom 不值得。
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const DIR = path.join(__dirname, '..', '..', 'src', 'renderer');

function makeEl() {
  return {
    hidden: false,
    textContent: '',
    innerHTML: '',
    dataset: {},
    _attrs: {},
    setAttribute(name, value) {
      this._attrs[name] = String(value);
    },
    getAttribute(name) {
      return this._attrs[name];
    },
    addEventListener() {}
  };
}

const ELEMENT_IDS = [
  'goal-bar',
  'goal-bar-toggle',
  'goal-bar-mark',
  'goal-bar-objective',
  'goal-bar-round',
  'goal-bar-fact',
  'goal-bar-continue',
  'goal-bar-stop',
  'goal-bar-facts',
  'goal-panel-body',
  'goal-panel-meta',
  'goal-panel-clear',
  'goal-panel-continue',
  'goal-panel-stop',
  'goal-panel-refresh'
];

/** 与 index.html 一致：这些元素出生就带 `hidden`（桩必须同起点，否则测的是桩不是页面） */
const INITIALLY_HIDDEN = [
  'goal-bar',
  'goal-bar-continue',
  'goal-bar-stop',
  'goal-bar-facts',
  'goal-panel-clear',
  'goal-panel-continue',
  'goal-panel-stop'
];

function loadModule(overrides = {}) {
  const els = new Map(
    ELEMENT_IDS.map((id) => [id, Object.assign(makeEl(), { hidden: INITIALLY_HIDDEN.includes(id) })])
  );
  const document = {
    getElementById: (id) => els.get(id) || null,
    createElement: () => makeEl(),
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {},
    body: makeEl(),
    documentElement: makeEl()
  };
  const window = { diecloud: {} };
  const source = fs.readFileSync(path.join(DIR, 'renderer-goal-panel.js'), 'utf8');
  const factory = new Function(
    'window',
    'document',
    'currentSessionId',
    'sessionActiveRuns',
    'stopAgentRun',
    'setInterval',
    'clearInterval',
    'setTimeout',
    `${source}
     return { renderGoalBar, renderGoalPanel, toggleGoalBarFacts, refreshGoalPanel };`
  );
  const api = factory(
    window,
    document,
    overrides.currentSessionId !== undefined ? overrides.currentSessionId : 's1',
    overrides.sessionActiveRuns || new Map(),
    () => {},
    // 心跳用桩（真定时器会把 jest worker 挂住）；setTimeout 要真的排程 ——
    // 「取数中途又来一拍」的补拍就靠它，桩成 no-op 会把这个行为测成没发生。
    () => 1,
    () => {},
    (fn, ms) => setTimeout(fn, ms)
  );
  return { ...api, els, window };
}

function sampleView(extra = {}) {
  return {
    objective: '让 npm test 全绿',
    status: 'active',
    outcome: null,
    attempt: 3,
    maxAttempts: 12,
    unverified: false,
    checks: [
      { id: 'unit', command: 'npm test', runs: 2, ok: true, note: 'pass', exitCode: 0, at: '2026-01-01T00:00:00.000Z', round: 3 },
      { id: 'lint', command: 'npm run lint', runs: 1, ok: false, note: 'fail', exitCode: 2, at: '2026-01-01T00:00:00.000Z', round: 3 },
      { id: 'e2e', command: 'npm run e2e', runs: 1, ok: false, note: 'blocked', exitCode: null, at: '2026-01-01T00:00:00.000Z', round: 3 },
      { id: 'build', command: 'npm run build', runs: 0, ok: null, note: '', exitCode: null, at: null, round: 0 }
    ],
    todos: [{ text: '改实现', done: true }, { text: '补测试', done: false }],
    todosDone: 1,
    todosTotal: 2,
    // 4 条声明检查里 1 条通过 → 进度条按验收算（清单勾选只作参考）
    checksPassed: 1,
    checksTotal: 4,
    progress: 0.25,
    progressFrom: 'checks',
    evidence: [
      { at: '2026-01-01T00:00:00.000Z', round: 2, command: 'npm test', ok: false, exitCode: 1, note: '' },
      { at: '2026-01-01T00:00:00.000Z', round: 3, command: 'npm test', ok: true, exitCode: 0, note: '' }
    ],
    lastFact: { command: 'npm test', ok: true, exitCode: 0, at: '2026-01-01T00:00:00.000Z', tail: 'ok' },
    ...extra
  };
}

test('没有目标：目标条与展开区都收起', () => {
  const mod = loadModule();
  mod.renderGoalBar(sampleView());
  mod.renderGoalBar(null);
  assert.equal(mod.els.get('goal-bar').hidden, true);
  assert.equal(mod.els.get('goal-bar-facts').hidden, true);
  assert.equal(mod.els.get('goal-bar-toggle').getAttribute('aria-expanded'), 'false');
});

test('有目标：一行说清「目标 · 第几轮 · 最近一条事实」', () => {
  const mod = loadModule();
  mod.renderGoalBar(sampleView());
  const bar = mod.els.get('goal-bar');
  assert.equal(bar.hidden, false);
  assert.equal(bar.dataset.state, 'active');
  assert.equal(mod.els.get('goal-bar-objective').textContent, '让 npm test 全绿');
  assert.equal(mod.els.get('goal-bar-round').textContent, '第 3/12 轮');
  assert.equal(mod.els.get('goal-bar-fact').textContent, 'npm test → exit 0');
  assert.equal(mod.els.get('goal-bar-fact').dataset.state, 'ok');

  // 停着的目标：状态词进同一行；没有事实时也不留空
  mod.renderGoalBar(
    sampleView({ status: 'stalled', lastFact: null, evidence: [] })
  );
  assert.equal(mod.els.get('goal-bar-round').textContent, '第 3/12 轮 · 预算用尽');
  assert.equal(mod.els.get('goal-bar-fact').textContent, '还没有检查事实');
  assert.equal(mod.els.get('goal-bar-fact').dataset.state, 'none');
});

test('按钮只在对的时候出现：跑动中给停止，停下且未收尾给继续', () => {
  const running = new Map([['s1', { runId: 'r1' }]]);
  const modRunning = loadModule({ sessionActiveRuns: running });
  modRunning.renderGoalBar(sampleView());
  assert.equal(modRunning.els.get('goal-bar-stop').hidden, false);
  assert.equal(modRunning.els.get('goal-bar-continue').hidden, true);

  const modIdle = loadModule();
  modIdle.renderGoalBar(sampleView({ status: 'paused' }));
  assert.equal(modIdle.els.get('goal-bar-stop').hidden, true);
  assert.equal(modIdle.els.get('goal-bar-continue').hidden, false);

  // 登记的 run 已 finished（还没被清掉）：不能再显示「停止」——那按钮按了没反应
  const modFinished = loadModule({ sessionActiveRuns: new Map([['s1', { runId: 'r1', finished: true }]]) });
  modFinished.renderGoalBar(sampleView({ status: 'paused' }));
  assert.equal(modFinished.els.get('goal-bar-stop').hidden, true);
  assert.equal(modFinished.els.get('goal-bar-continue').hidden, false);

  // 收尾过的目标没有「继续」可言（框外面板同理）
  modIdle.renderGoalBar(sampleView({ outcome: 'complete' }));
  assert.equal(modIdle.els.get('goal-bar-continue').hidden, true);
  assert.equal(modIdle.els.get('goal-bar-mark').textContent, '✔');
  modIdle.renderGoalPanel(sampleView({ outcome: 'complete' }));
  assert.equal(modIdle.els.get('goal-panel-continue').hidden, true);
});

test('展开区按检查聚合事实，且「没跑过」是未验证而不是失败', async () => {
  const mod = loadModule();
  // 走真实取数路径：视图进模块内部状态（展开时用它补内容）
  mod.window.diecloud.sessionGoalPanel = async () => ({ ok: true, goal: sampleView() });
  await mod.refreshGoalPanel();
  assert.equal(mod.els.get('goal-bar').hidden, false);
  assert.equal(mod.els.get('goal-bar-facts').hidden, true);
  mod.toggleGoalBarFacts();
  const facts = mod.els.get('goal-bar-facts');
  assert.equal(facts.hidden, false);
  assert.equal(mod.els.get('goal-bar-toggle').getAttribute('aria-expanded'), 'true');
  assert.match(facts.innerHTML, /npm test/);
  assert.match(facts.innerHTML, /跑过 2 次/);
  assert.match(facts.innerHTML, /✅/);
  assert.match(facts.innerHTML, /❌/);
  // 「没跑成」不是「没通过」：沙箱拒绝/超时要单独标出来，否则会被读成「模型改坏了」
  assert.match(facts.innerHTML, /⚠/);
  assert.match(facts.innerHTML, /未执行（沙箱或审批拒绝）/);
  assert.match(facts.innerHTML, /还没跑过/);
  // 清单与事实流水也在同一处展开，不用再去看侧栏
  assert.match(facts.innerHTML, /推进清单（1\/2）/);
  assert.match(facts.innerHTML, /第 3 轮/);

  // 再点一次收起
  mod.toggleGoalBarFacts();
  assert.equal(mod.els.get('goal-bar-facts').hidden, true);
});

test('面板：没有目标时是空态文案，有目标时给出轮次与状态词', () => {
  const mod = loadModule();
  mod.renderGoalPanel(null, '');
  assert.match(mod.els.get('goal-panel-body').innerHTML, /还没有目标/);
  assert.equal(mod.els.get('goal-panel-meta').textContent, '本会话暂无目标');
  assert.equal(mod.els.get('goal-panel-clear').hidden, true);

  mod.renderGoalPanel(sampleView(), '');
  assert.equal(mod.els.get('goal-panel-meta').textContent, '进行中 · 第 3/12 轮');
  assert.equal(mod.els.get('goal-panel-clear').hidden, false);
  assert.match(mod.els.get('goal-panel-body').innerHTML, /验收命令（退出码 0 = 通过）/);
  assert.match(mod.els.get('goal-panel-body').innerHTML, /跑过 2 次/);
});

test('进度条文案跟着来源走：验收（客观）→ 清单（模型自述）→ 状态词', () => {
  const mod = loadModule();
  // 有声明检查：说的是「验收通过几条」，不是勾了几项清单
  mod.renderGoalPanel(sampleView(), '');
  let html = mod.els.get('goal-panel-body').innerHTML;
  assert.match(html, /验收通过 1\/4/);
  assert.doesNotMatch(html, /清单 1\/2 项/);

  // 没有声明检查（未验证模式）：退回清单勾选比例
  mod.renderGoalPanel(sampleView({ checks: [], checksPassed: 0, checksTotal: 0, progressFrom: 'todos', progress: 0.5 }), '');
  html = mod.els.get('goal-panel-body').innerHTML;
  assert.match(html, /清单 1\/2 项/);
  assert.match(html, /未声明检查（未验证模式/);

  // 两样都没有：只说状态词，不编造百分比
  mod.renderGoalPanel(sampleView({ checks: [], todos: [], todosDone: 0, todosTotal: 0, progressFrom: 'outcome', progress: 0 }), '');
  html = mod.els.get('goal-panel-body').innerHTML;
  assert.match(html, /进行中/);
  assert.doesNotMatch(html, /验收通过/);

  // 最近一条事实是红的：声明检查可能全绿，但 goal_finish 仍会被打回 —— 文案必须说出这个事实，
  // 否则界面就成了「进度 100% + 收尾被打回」的自相矛盾
  mod.renderGoalPanel(
    sampleView({
      lastFact: { command: 'npm run e2e', ok: false, exitCode: 2, at: '2026-01-01T00:00:00.000Z', tail: '' }
    }),
    ''
  );
  html = mod.els.get('goal-panel-body').innerHTML;
  assert.match(html, /验收通过 1\/4 · 最近一次检查未通过/);
});

test('取视图失败不影响面板渲染，也不把失败当「没有目标」传播给目标条', async () => {
  const mod = loadModule();
  mod.renderGoalPanel(sampleView(), '');
  mod.window.diecloud.sessionGoalPanel = async () => {
    throw new Error('gateway down');
  };
  await mod.refreshGoalPanel({ silent: true });
  // 静默拍失败：不把后台失败糊到用户脸上（面板文案与目标条都不改写）
  assert.equal(mod.els.get('goal-panel-meta').textContent, '进行中 · 第 3/12 轮');
  assert.equal(mod.els.get('goal-bar').hidden, true);
});

test('取数中途又来一拍不会丢：取完补一拍（切会话正是撞在这里）', async () => {
  const mod = loadModule();
  let calls = 0;
  let release = null;
  mod.window.diecloud.sessionGoalPanel = async () => {
    calls += 1;
    if (calls === 1) await new Promise((r) => (release = r));
    return { ok: true, goal: sampleView() };
  };
  const first = mod.refreshGoalPanel();
  const second = mod.refreshGoalPanel(); // 被 in-flight 挡下 → 记一笔待补
  await second;
  assert.equal(calls, 1);
  release();
  await first;
  // 让补拍（setTimeout 0）跑完
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(calls, 2);
  assert.equal(mod.els.get('goal-bar').hidden, false);
});
