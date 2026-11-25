'use strict';

/**
 * 思考区「内联 diff」的惰性生成（2026-11-25）。
 *
 * 现场：切会话回放时每个 edit 工具行的 diff 正文都被**预先** `buildThinkingInlineDiffHtml`
 * + `innerHTML` 建一遍，而整轮结束后这条 `<details>` 是收起的 —— 收起时一个字都看不见。
 * 它又正好是单条 trace 里最大的一块（`tool.diff` 的 beforeText/afterText 占 0.9–1.5MB），
 * 一屏 32 轮里几十个 edit 行 = 一堆白做的 LCS + DOM。
 *
 * 不变式（也是行为契约）：
 * 1. 收起时**不**生成正文（一次都不调 buildThinkingInlineDiffHtml）；
 * 2. 首次展开那一刻生成一次，内容与旧实现完全一致（同一个 builder、同一个 diff 对象）；
 * 3. 反复开合不重复生成；
 * 4. `open` 在创建时就已经为真（运行中 + `tracePrefs.expandEdit`）→ 立即生成，跟旧行为一致。
 *
 * 浏览器脚本没有 module.exports，用 `new Function` 摘函数 + 最小 DOM 替身来验
 * （手法同 `renderer-chat-window-on-leave.test.cjs`）。
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SOURCE = fs.readFileSync(
  path.join(__dirname, '..', '..', 'src', 'renderer', 'renderer-thinking-trace-dom.js'),
  'utf8'
);

function extractFn(src, name) {
  const start = src.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `没找到 function ${name}`);
  const end = src.indexOf('\n}', start);
  assert.ok(end > start, `function ${name} 没闭合`);
  return src.slice(start, end + 2);
}

/** 够用的 DOM 替身：只要 createElement / className / dataset / appendChild / innerHTML / toggle */
function makeElement(tag) {
  return {
    tagName: tag,
    className: '',
    textContent: '',
    dataset: {},
    open: false,
    children: [],
    listeners: {},
    htmlSets: 0,
    _html: '',
    appendChild(child) {
      this.children.push(child);
      return child;
    },
    addEventListener(ev, fn) {
      (this.listeners[ev] = this.listeners[ev] || []).push(fn);
    },
    dispatch(ev) {
      for (const fn of this.listeners[ev] || []) fn({ type: ev });
    },
    set innerHTML(v) {
      this.htmlSets += 1;
      this._html = String(v);
    },
    get innerHTML() {
      return this._html;
    }
  };
}

const documentStub = { createElement: (tag) => makeElement(tag) };

const build = new Function(
  'document',
  'tracePrefs',
  'isEditToolName',
  'toolDiffHasBody',
  'buildThinkingInlineDiffHtml',
  'requestTraceUpgrade',
  `${extractFn(SOURCE, 'appendInlineToolDiff')}
   return appendInlineToolDiff;`
);

const DIFF = { created: false, added: 12, removed: 3, beforeText: 'a\nb', afterText: 'a\nB' };

function run({
  expandEdit = true,
  roundComplete = true,
  built = () => '<div class="diff-line">x</div>',
  diff = DIFF,
  upgrade = null
} = {}) {
  const parent = makeElement('div');
  let builds = 0;
  const upgrades = [];
  const fn = build(
    documentStub,
    { expandEdit },
    (name) => name === 'fs_edit_file',
    () => true,
    (d) => {
      builds += 1;
      return built(d);
    },
    (hostEl, onTrace) => {
      upgrades.push({ hostEl, hasCallback: typeof onTrace === 'function' });
      if (typeof upgrade === 'function') return upgrade(onTrace);
      return true;
    }
  );
  const tool = { name: 'fs_edit_file', diff };
  fn(parent, tool, { roundComplete, entryIndex: 0, toolIndex: 0 });
  const details = parent.children[0];
  const body = details.children.find((c) => String(c.className).includes('msg-tool-inline-diff-body'));
  return { parent, details, body, tool, builds: () => builds, upgrades };
}

test('收起状态不生成 diff 正文（一次都不 build）', () => {
  const r = run({ expandEdit: true, roundComplete: true });
  assert.ok(r.details, '应该建出 details');
  assert.equal(r.details.open, false);
  assert.equal(r.builds(), 0, '收起时不该调 buildThinkingInlineDiffHtml');
  assert.equal(r.body.htmlSets, 0, '收起时不该写 innerHTML');
  assert.ok(r.body.className.includes('agent-scroll'), '惰性生成不能改变原有的 class');
});

test('首次展开那一刻生成一次，内容走同一个 builder', () => {
  const r = run();
  r.details.open = true;
  r.details.dispatch('toggle');
  assert.equal(r.builds(), 1);
  assert.equal(r.body.htmlSets, 1);
  assert.ok(r.body.innerHTML.includes('diff-line'));
});

test('反复开合不重复生成', () => {
  const r = run();
  r.details.open = true;
  r.details.dispatch('toggle');
  r.details.open = false;
  r.details.dispatch('toggle');
  r.details.open = true;
  r.details.dispatch('toggle');
  assert.equal(r.builds(), 1, 'body 只该 build 一次');
  assert.equal(r.body.htmlSets, 1);
});

test('创建时就 open（运行中 + expandEdit）→ 立即生成，与旧行为一致', () => {
  const r = run({ expandEdit: true, roundComplete: false });
  assert.equal(r.details.open, true);
  assert.equal(r.builds(), 1);
  assert.equal(r.body.htmlSets, 1);
});

test('没有 diff 体（非 edit 工具 / 无 beforeText）→ 整段不建', () => {
  const parent = makeElement('div');
  const fn = build(documentStub, { expandEdit: true }, () => false, () => true, () => 'x', () => true);
  fn(parent, { name: 'host_exec', diff: DIFF }, { roundComplete: true });
  assert.equal(parent.children.length, 0, '非 edit 工具不该建 diff 节点');
});

// ---- 展示态（回放时 diff 正文被裁掉，展开才取完整态）----

const TRIMMED = { created: false, added: 12, removed: 3, beforeText: '', afterText: '', textTrimmed: true };

test('展示态的 diff：收起不取，展开先给「加载中」再去取完整态', async () => {
  let captured = null;
  const r = run({
    diff: TRIMMED,
    built: () => '<div class="diff-line">full</div>',
    upgrade: (onTrace) => {
      captured = onTrace;
      return true;
    }
  });
  assert.equal(r.upgrades.length, 0, '收起时不该发起升级');

  r.details.open = true;
  r.details.dispatch('toggle');
  assert.equal(r.upgrades.length, 1, '展开这一下才升级');
  assert.ok(r.body.innerHTML.includes('正在加载完整 diff'), '先给可见的加载提示');

  // 完整态回来（同一位置的那个工具行）
  captured([{ tools: [{ name: 'fs_edit_file', diff: { ...DIFF } }] }]);
  await Promise.resolve();
  assert.ok(r.body.innerHTML.includes('full'), '拿到完整 diff 后按它生成正文');
  assert.equal(r.tool.diff.beforeText, 'a\nb', '缓存里的工具对象也要补成完整态');
  assert.equal(r.body.dataset.diffPending, undefined);
});

test('展示态升级拿不到 runId（不是回放来的）→ 给一句可读提示，不崩', () => {
  const r = run({
    diff: TRIMMED,
    upgrade: () => false // requestTraceUpgrade 返回 false：这条气泡没有 runId
  });
  r.details.open = true;
  r.details.dispatch('toggle');
  assert.ok(r.body.innerHTML.includes('重新打开'), '要给出可执行的提示');
});

// ---- 升级入口本身：runId 从最近的 .msg 上取 ----

const upgradeBuild = new Function(
  'upgradeAgentTraceRecord',
  'console',
  `${extractFn(SOURCE, 'requestTraceUpgrade')}
   return requestTraceUpgrade;`
);

test('requestTraceUpgrade：按气泡上的 traceRunId 升级，并把完整 trace 交给回调', async () => {
  const calls = [];
  let received = null;
  const fn = upgradeBuild(
    (runId) => {
      calls.push(runId);
      return Promise.resolve({ trace: [{ round: 1, fullThought: '全文' }] });
    },
    { warn() {} }
  );
  const hostEl = { closest: (sel) => (sel === '.msg' ? { dataset: { traceRunId: 'trace-7' } } : null) };
  const started = fn(hostEl, (trace) => {
    received = trace;
  });
  assert.equal(started, true);
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(calls, ['trace-7']);
  assert.ok(received && received[0].fullThought === '全文');
});

test('requestTraceUpgrade：气泡上没有 runId（内联 trace，不是回放）→ 不升级也不报错', () => {
  let called = 0;
  const fn = upgradeBuild(
    () => {
      called += 1;
      return Promise.resolve(null);
    },
    { warn() {} }
  );
  const started = fn({ closest: () => ({ dataset: {} }) }, () => {});
  assert.equal(started, false);
  assert.equal(called, 0);
});
