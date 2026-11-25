'use strict';

/**
 * 「目标」面板的渲染契约（`src/renderer/renderer-goal-panel.js`）。
 *
 * 守的三件事：
 *   1. 只吃 Main 给的视图（`session-goal.toPanelView`），自己不算进度、不判完成 ——
 *      这里断言的是「视图字段到 DOM 的映射」，不是业务结论；
 *   2. 检查状态是**四态**：通过 / 未通过 / 没跑成 / 从没跑过（`⬜`）。把「没跑过」画成失败，
 *      会让人以为模型跑挂了；
 *   3. 目标收尾后不再给「继续」：没有可推进的东西了。
 *
 * 气泡区上方的「目标条」已删除（`#goal-bar` 及其样式/渲染），这里只管侧栏这一页。
 *
 * 用 `new Function` + 极简 DOM 桩（与 `renderer-tool-artifact-path.test.cjs` 同一手法）：
 * 这个模块是浏览器脚本，没有 module.exports；为了几个渲染分支去装 jsdom 不值得。
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadRendererFmt } = require('./lib/load-renderer-fmt.cjs');

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
  'goal-panel-body',
  'goal-panel-meta',
  'goal-panel-clear',
  'goal-panel-continue',
  'goal-panel-stop',
  'goal-panel-refresh'
];

/** 与 index.html 一致：这些元素出生就带 `hidden`（桩必须同起点，否则测的是桩不是页面） */
const INITIALLY_HIDDEN = ['goal-panel-clear', 'goal-panel-continue', 'goal-panel-stop'];

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
    'fmtMonthDayClock',
    `${source}
     return { renderGoalPanel, refreshGoalPanel, refreshGoalPanelIfVisible };`
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
    (fn, ms) => setTimeout(fn, ms),
    // 时间文案的唯一来源是 renderer-utils.js（面板不再自带一份实现），这里注入真的那一份
    loadRendererFmt().fmtMonthDayClock
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

test('检查聚合：「没跑过」是未验证，「没跑成」不是「没通过」', () => {
  const mod = loadModule();
  mod.renderGoalPanel(sampleView(), '');
  const html = mod.els.get('goal-panel-body').innerHTML;
  assert.match(html, /npm test/);
  assert.match(html, /✅/);
  assert.match(html, /❌/);
  // 沙箱拒绝 / 超时要单独标出来，否则会被读成「模型改坏了」
  assert.match(html, /⚠/);
  assert.match(html, /未执行（沙箱或审批拒绝）/);
  assert.match(html, /还没跑过/);
  // 清单与事实流水也在同一页，不用再去看别处
  assert.match(html, /推进清单（1\/2）/);
  assert.match(html, /第 3 轮/);
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

test('按钮只在对的时候出现：跑动中给停止，停下且未收尾给继续', () => {
  const running = new Map([['s1', { runId: 'r1' }]]);
  const modRunning = loadModule({ sessionActiveRuns: running });
  modRunning.renderGoalPanel(sampleView(), '');
  assert.equal(modRunning.els.get('goal-panel-stop').hidden, false);
  assert.equal(modRunning.els.get('goal-panel-continue').hidden, true);

  const modIdle = loadModule();
  modIdle.renderGoalPanel(sampleView({ status: 'paused' }), '');
  assert.equal(modIdle.els.get('goal-panel-stop').hidden, true);
  assert.equal(modIdle.els.get('goal-panel-continue').hidden, false);

  // 登记的 run 已 finished（还没被清掉）：不能再显示「停止」——那按钮按了没反应
  const modFinished = loadModule({ sessionActiveRuns: new Map([['s1', { runId: 'r1', finished: true }]]) });
  modFinished.renderGoalPanel(sampleView({ status: 'paused' }), '');
  assert.equal(modFinished.els.get('goal-panel-stop').hidden, true);
  assert.equal(modFinished.els.get('goal-panel-continue').hidden, false);

  // 收尾过的目标没有「继续」可言
  modIdle.renderGoalPanel(sampleView({ outcome: 'complete' }), '');
  assert.equal(modIdle.els.get('goal-panel-continue').hidden, true);
});

test('取视图失败写在面板上（面板可见时才取数，没有「静默拍」）', async () => {
  const mod = loadModule();
  mod.renderGoalPanel(sampleView(), '');
  mod.window.diecloud.sessionGoalPanel = async () => {
    throw new Error('gateway down');
  };
  await mod.refreshGoalPanel();
  assert.equal(mod.els.get('goal-panel-meta').textContent, '本会话暂无目标');
  assert.match(mod.els.get('goal-panel-body').innerHTML, /目标读取失败/);
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
  assert.equal(mod.els.get('goal-panel-meta').textContent, '进行中 · 第 3/12 轮');
});

/**
 * 2026-11-07 现场：面板头写着「已完成 · 第 1/12 轮 · 验收通过 1/1」，而窗口里早就在做别的需求。
 * 收尾的目标不许再报轮次（那数字是预算，读起来像「还在跑」）；收尾之后又有人说话，
 * 就只是**历史目标** —— 面板要说清「之后对话已继续」。
 */
test('收尾的目标不再报轮次；之后又有人说话就按「历史目标」画', () => {
  const mod = loadModule();
  const closed = { outcome: 'complete', completedAt: '2026-11-06T14:11:58.000Z', superseded: false };

  mod.renderGoalPanel(sampleView(closed), '');
  assert.match(mod.els.get('goal-panel-meta').textContent, /^已完成 · 收尾于 \d\d-\d\d \d\d:\d\d$/);
  assert.doesNotMatch(mod.els.get('goal-panel-meta').textContent, /轮/);

  mod.renderGoalPanel(sampleView({ ...closed, superseded: true }), '');
  const meta = mod.els.get('goal-panel-meta').textContent;
  assert.match(meta, /^历史目标 · 已完成 · 收尾于/);
  assert.match(meta, /之后对话已继续/);
});

test('面板不在前台时，重绘补的那一拍不打 IPC（可见时才取数）', async () => {
  const mod = loadModule();
  let calls = 0;
  mod.window.diecloud.sessionGoalPanel = async () => {
    calls += 1;
    return { ok: true, goal: sampleView() };
  };
  // 面板收起：`finalizeChatRenderAfterMessages` 调的就是这个入口
  mod.refreshGoalPanelIfVisible();
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(calls, 0, '面板不可见时不该为一次重绘打本地 RPC');
  // 直接调 refreshGoalPanel（打开面板 / 手动刷新走的路径）仍然照常取数
  await mod.refreshGoalPanel();
  assert.equal(calls, 1);
  assert.equal(mod.els.get('goal-panel-meta').textContent, '进行中 · 第 3/12 轮');
});
