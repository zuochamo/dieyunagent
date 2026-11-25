/* global document, currentSessionId, sessionActiveRuns, isIsolatedCardEntry, isolatedCardRunning, fillIsolatedCardBody, openSidePanel */
'use strict';

/**
 * 右侧面板「轨迹」页（`data-side-tab="subagents"`，页签原名「子代理」）：
 * **本次运行的全部子代理 + 选中那个的完整思考过程**。
 *
 * 页头两个子标签：「子代理」（下面这套，现在的功能）/「轨迹图」（还没设计，只有占位说明，
 * 见文件末尾 `setTracePaneMode`）。别把子标签当成第二个页签体系 —— 侧栏页签仍归
 * `renderer-side-panel.js`，这里只切本页内部的两块内容。
 *
 * 版面分上下两块（一块的判据是「一次只看一个」）：
 * - 上：本次运行派发过的每个子代理一个标签（`role="tab"`）。标签左侧是状态灯 ——
 *   还在跑是脉冲蓝点、已完成是常亮绿点；标签文字是子代理身份（`entry.phase`）。
 * - 下：点中那个子代理的全文（思考 + 工具），标题行给全名、并发标记、轮数/步数。
 * 以前是一列可折叠卡片，4 个并发时每个子代理的正文都摊在下面，整页要滚很久；
 * 现在标签区最多占 38% 高度，正文区吃满剩下的高度并自己滚。
 *
 * 单一来源：这里不新增事件通道、不新增落库、不另存一份数据。
 * 卡片条目与正文都来自思考区（`isIsolatedCardEntry` 判据 + `fillIsolatedCardBody` 渲染），
 * 差别只在外层容器：聊天区卡片是固定 10 行的滚动盒，面板是不限高的全文视图。
 *
 * 数据只覆盖「当前这次运行」（产品决定，历史回合的详情不在本页范围）：
 * - 运行中：`sessionActiveRuns.get(sessionId).trace` 里的 isolated 卡片条目；
 * - run 结束后：`sessionActiveRuns` 会被删除，所以本模块留存最后一次快照
 *   （Map<sessionId, snapshot>，只存引用不拷贝），切会话再切回来仍能看到这次运行，
 *   下一次运行开始即覆盖。这是「面板要能看刚结束的这次运行」的最低成本实现，
 *   不需要动 live-run 生命周期，也不需要读库。
 *
 * 刷新：主路径是事件驱动（`dispatchAgentRunEvent` 每次渲染后调
 * `scheduleSubagentPanelRefresh`，200ms 防抖 + 可见性守卫）；心跳只兜
 * 「事件没来但数据该变」的窗口（例如切会话回来），面板不可见即自停。
 * 点标签是同步路径：用户点一下必须立刻换正文，不走防抖。
 */

const SUBAGENT_PANEL_REFRESH_DEBOUNCE_MS = 200;
const SUBAGENT_PANEL_POLL_MS = 3000;
/** 快照只需要「当前会话 + 最近切过的几个会话」，超限按插入顺序淘汰 */
const SUBAGENT_PANEL_SNAPSHOT_LIMIT = 8;
const SUBAGENT_PANEL_HIGHLIGHT_MS = 1200;

/** @type {Map<string, { runId: string, cards: object[], running: boolean }>} */
const subagentPanelSnapshots = new Map();
/**
 * 每个会话当前选中的子代理（`subagentId`）。
 * 面板不另存数据，但「看谁」是用户的选择，必须跨重绘留住 ——
 * 否则流式刷新一拍就把视图弹回默认那个，用户根本读不完。
 */
const subagentPanelSelection = new Map();
/** 每个会话最近一次呈现的 runId：用来发现"换了一轮"，好把上一轮的选择清掉 */
const subagentPanelRunSeen = new Map();

/**
 * `subagentId` 由每次运行新建的 namer 生成（`sa-<kind>-1`），跨轮会重复；
 * 而选择态是按 id 记的 —— 不清就会"上一轮选中的卡片，这一轮同位置的直接顶上来"。
 */
function syncSubagentSelectionForRun(sid, runId) {
  if (subagentPanelRunSeen.get(sid) === runId) return;
  subagentPanelRunSeen.set(sid, runId);
  subagentPanelSelection.delete(sid);
}

let subagentPanelTimer = null;
let subagentPanelPollTimer = null;
let subagentPanelHighlightTimer = null;

/** 「子代理」页可见性守卫：与上下文 / 代码索引面板同构，收起动画期间也算不可见 */
function isSubagentsPaneActive() {
  const panel = document.getElementById('artifacts-panel');
  if (!panel || panel.hidden || panel.classList.contains('is-panel-closing')) return false;
  const pane = document.querySelector('.side-panel-pane[data-side-pane="subagents"]');
  return !!(pane && !pane.hidden);
}

function subagentSnapshotKey(sessionId) {
  return String(sessionId || currentSessionId || '').trim();
}

function trimSubagentSnapshots(keepKey) {
  while (subagentPanelSnapshots.size > SUBAGENT_PANEL_SNAPSHOT_LIMIT) {
    let evicted = false;
    for (const key of subagentPanelSnapshots.keys()) {
      if (key === keepKey) continue;
      subagentPanelSnapshots.delete(key);
      subagentPanelRunSeen.delete(key);
      subagentPanelSelection.delete(key);
      evicted = true;
      break;
    }
    if (!evicted) break;
  }
}

/** trace → 子代理卡片条目（`isolated && rounds`，判据由思考区单一来源提供） */
function filterIsolatedCards(trace) {
  const rows = Array.isArray(trace) ? trace : [];
  const isCard = typeof isIsolatedCardEntry === 'function' ? isIsolatedCardEntry : () => false;
  return rows.filter((entry) => !!isCard(entry));
}

/**
 * 读当前会话这次运行的子代理卡片。
 * 有 live 就以 live 为准（哪怕本轮没有子代理 —— 否则上一轮的卡片会冒充本轮）；
 * 没有 live（run 已收尾）就回落到最后一次快照。
 */
function readSubagentPanelSnapshot() {
  const sid = subagentSnapshotKey();
  if (!sid) return { runId: '', cards: [], running: false };
  const live =
    typeof sessionActiveRuns !== 'undefined' && sessionActiveRuns
      ? sessionActiveRuns.get(sid)
      : null;
  if (live) {
    const snap = {
      runId: String(live.runId || ''),
      cards: filterIsolatedCards(live.trace),
      // 轨迹图要的是**完整** trace（主线 + 子 Agent）：与卡片同源，不另存一份数据
      trace: Array.isArray(live.trace) ? live.trace : [],
      running: !live.finished
    };
    subagentPanelSnapshots.set(sid, snap);
    trimSubagentSnapshots(sid);
    syncSubagentSelectionForRun(sid, snap.runId);
    return snap;
  }
  // run 收尾后 sessionActiveRuns 会删掉条目：留下的快照一律按「已结束」呈现，
  // 否则面板会永远停在「运行中」。
  const stored = subagentPanelSnapshots.get(sid);
  if (!stored) return { runId: '', cards: [], running: false };
  syncSubagentSelectionForRun(sid, stored.runId);
  return { ...stored, running: false };
}

/** 单个子代理是否还在跑（判据与聊天区卡片、状态灯同一份） */
function subagentEntryRunning(entry) {
  return typeof isolatedCardRunning === 'function' && !!isolatedCardRunning(entry);
}

function subagentCardStepCount(entry) {
  const rounds = Array.isArray(entry && entry.rounds) ? entry.rounds : [];
  return rounds.reduce((n, r) => n + ((r && r.tools) || []).length, 0);
}

/**
 * 状态文案。`runningHint`（可选）是调用方的权威判定：面板知道「整轮还活着且这张没标 done」，
 * 而 `isolatedCardRunning(entry)` 在 planner worker 卡片上会漏判（没有 runDone 的两轮之间）。
 */
function subagentCardStatusLabel(entry, running, runningHint) {
  const rounds = Array.isArray(entry && entry.rounds) ? entry.rounds : [];
  const steps = subagentCardStepCount(entry);
  const isRunning =
    typeof runningHint === 'boolean'
      ? runningHint
      : !!(running && subagentEntryRunning(entry));
  if (isRunning) {
    return '运行中…';
  }
  const parts = [`已完成`];
  if (rounds.length > 1) parts.push(`${rounds.length} 轮`);
  if (steps) parts.push(`${steps} 步`);
  return parts.join(' · ');
}

/**
 * 当前该看哪个子代理（**唯一判定**）：用户选过且那张还在 → 保持不动；
 * 否则默认看「还在跑」的那个（派发完最想盯的就是它），没有在跑的退回第一个。
 * 每次重绘都会经过这里，所以新派发的子代理不会把用户的视图抢走。
 */
function resolveSubagentSelection(cards, sid, running) {
  const list = (Array.isArray(cards) ? cards : []).filter((e) => e && e.subagentId);
  if (!list.length) {
    subagentPanelSelection.delete(sid);
    return '';
  }
  const saved = subagentPanelSelection.get(sid);
  if (saved && list.some((e) => String(e.subagentId) === saved)) return saved;
  const active = running ? list.find((e) => subagentEntryRunning(e)) : null;
  const pick = String((active || list[0]).subagentId);
  subagentPanelSelection.set(sid, pick);
  return pick;
}

/** 面板头部的「几个 · 什么状态」；空列表就整块留白（不出「—」「0 个」这种噪音） */
function subagentPanelMetaText(cards, running) {
  const list = Array.isArray(cards) ? cards : [];
  if (!list.length) return '';
  const runningN = running ? list.filter((entry) => subagentEntryRunning(entry)).length : 0;
  return runningN
    ? `${list.length} 个 · ${runningN} 运行中`
    : `${list.length} 个 · 已结束`;
}

function syncSubagentPanelMeta(cards, running) {
  const meta = document.getElementById('subagent-panel-meta');
  if (!meta) return;
  const text = subagentPanelMetaText(cards, running);
  if (meta.textContent !== text) meta.textContent = text;
  // 空串时整个元素收起来：它旁边就是页头那排子标签，留个空位会多一段死间距
  if (meta.hidden !== !text) meta.hidden = !text;
}

function findSubagentTab(tabs, subagentId) {
  if (!tabs) return null;
  const id = String(subagentId || '');
  const rows = tabs.querySelectorAll(':scope > .subagent-panel-tab');
  for (const el of rows) {
    if (el.dataset.subagentId === id) return el;
  }
  return null;
}

/** 一个标签的外壳（状态灯 + 身份文字）；点击 = 换下方正文 */
function mountSubagentTab(tabs, subagentId) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'subagent-panel-tab';
  btn.dataset.subagentId = String(subagentId || '');
  btn.setAttribute('role', 'tab');
  const dot = document.createElement('span');
  dot.className = 'subagent-panel-tab-dot';
  const label = document.createElement('span');
  label.className = 'subagent-panel-tab-label';
  btn.append(dot, label);
  btn.addEventListener('click', () => selectSubagentTab(btn.dataset.subagentId || ''));
  tabs.appendChild(btn);
  return btn;
}

/** 这张卡片在本次运行里算不算「还在工作」（标签灯 / 状态行 / 正文跟随的唯一判定） */
function subagentCardWorking(entry, running) {
  if (running && entry && entry.runDone !== true) return true;
  return subagentEntryRunning(entry);
}

function syncSubagentTab(btn, entry, running, active) {
  const isRunning = subagentCardWorking(entry, running);
  const text = String((entry && entry.phase) || '子 Agent');
  const label = btn.querySelector(':scope > .subagent-panel-tab-label');
  if (label && label.textContent !== text) label.textContent = text;
  const dot = btn.querySelector(':scope > .subagent-panel-tab-dot');
  if (dot) {
    const state = isRunning ? 'running' : 'done';
    if (dot.dataset.state !== state) dot.dataset.state = state;
  }
  btn.classList.toggle('is-running', isRunning);
  btn.classList.toggle('is-active', !!active);
  btn.setAttribute('aria-selected', active ? 'true' : 'false');
  const title = `${text} · ${subagentCardStatusLabel(entry, running, isRunning)}`;
  if (btn.title !== title) btn.title = title;
}

/**
 * 重绘标签区。按 subagentId 复用节点（与思考区卡片同一套增量思路）：
 * 流式刷新一拍就重绘一次，整块重建会打断键盘焦点，也会让刚点下的标签闪一下。
 * 不重排顺序 —— 子代理只会往后追加，重排等于给"点了一半的标签"换位置。
 */
function renderSubagentTabs(tabs, cards, running, selectedId) {
  const seen = new Set();
  cards.forEach((entry) => {
    const subagentId = String((entry && entry.subagentId) || '');
    if (!subagentId) return;
    seen.add(subagentId);
    const btn = findSubagentTab(tabs, subagentId) || mountSubagentTab(tabs, subagentId);
    syncSubagentTab(btn, entry, running, subagentId === selectedId);
  });
  tabs.querySelectorAll(':scope > .subagent-panel-tab').forEach((el) => {
    if (!seen.has(el.dataset.subagentId || '')) el.remove();
  });
}

/**
 * 重绘下方正文：标题行（全名 / 并发标记 / 状态）+ 全文。
 * 正文由 `fillIsolatedCardBody` 增量填充（同一份 rounds），换人时整块清空 ——
 * 轮次键（data-subround）会撞，复用节点会把上一个人的思考留在下面。
 *
 * 「这张还在跑吗」在本页用**整轮状态兜底**：`snap.running && entry.runDone !== true`
 * 就算在跑。只看 `isolatedCardRunning(entry)` 会漏 —— planner 派出的 worker 卡片没有
 * `runDone`，两轮之间（思考已到、工具还没发）三条判据全不成立，会被误判成已结束，
 * 正文就恰好在最该跟随的时刻停住（用户看到的就是「不会滚动」）。
 */
function renderSubagentDetail(detail, cards, running, selectedId) {
  const entry =
    cards.find((e) => String((e && e.subagentId) || '') === selectedId) || cards[0] || null;
  if (!entry) return;
  const isRunning = subagentCardWorking(entry, running);
  const text = String(entry.phase || '子 Agent');
  const titleEl = document.getElementById('subagent-panel-detail-title');
  if (titleEl) {
    if (titleEl.textContent !== text) titleEl.textContent = text;
    if (titleEl.title !== text) titleEl.title = text;
  }
  const badge = document.getElementById('subagent-panel-detail-badge');
  if (badge) badge.hidden = !entry.parallel;
  const status = document.getElementById('subagent-panel-detail-status');
  if (status) {
    const label = subagentCardStatusLabel(entry, running, isRunning);
    if (status.textContent !== label) status.textContent = label;
  }
  const body = document.getElementById('subagent-panel-detail-body');
  if (!body) return;
  const subagentId = String(entry.subagentId || '');
  if (body.dataset.subagentId !== subagentId) {
    // 换人 = 换一份正文：清空节点（轮次键会撞）＋ 重置贴底跟随意图
    // —— 上一张「用户已上翻」的让位态、以及还没跑完的阻尼帧链，都不许带到这一张上。
    if (typeof stopIsolatedCardFollow === 'function') stopIsolatedCardFollow(body);
    body.replaceChildren();
    body.dataset.subagentId = subagentId;
    delete body.dataset.cardFollowYield;
    delete body.dataset.cardFollowing;
    body.scrollTop = 0;
  }
  // forceReasoning：面板是用户显式打开的「看思考」视图，不该被聊天区的显示开关关成空壳。
  // runningHint：把本页的整轮权威判定交给正文，跟随才不会在两轮之间停住。
  fillIsolatedCardBody(body, entry, { forceReasoning: true, runningHint: isRunning });
}

function renderSubagentPanel({ force = false } = {}) {
  if (!force && !isSubagentsPaneActive()) return;
  // 轨迹图模式下每次刷新都重画图（数据同源、判定在 trace-graph 纯函数里）
  if (tracePaneMode === 'graph') {
    renderTraceGraphPane();
    return;
  }
  const tabs = document.getElementById('subagent-panel-tabs');
  const detail = document.getElementById('subagent-panel-detail');
  if (!tabs || !detail) return;

  const snap = readSubagentPanelSnapshot();
  const cards = Array.isArray(snap.cards) ? snap.cards : [];
  syncSubagentPanelMeta(cards, snap.running);

  const empty = document.getElementById('subagent-panel-empty');
  if (empty) empty.hidden = cards.length > 0;
  tabs.hidden = !cards.length;
  detail.hidden = !cards.length;
  if (!cards.length) {
    tabs.replaceChildren();
    return;
  }

  const selectedId = resolveSubagentSelection(cards, subagentSnapshotKey(), snap.running);
  renderSubagentTabs(tabs, cards, snap.running, selectedId);
  renderSubagentDetail(detail, cards, snap.running, selectedId);
}

function scheduleSubagentPanelRefresh() {
  if (!isSubagentsPaneActive()) return;
  if (subagentPanelTimer) return;
  subagentPanelTimer = setTimeout(() => {
    subagentPanelTimer = null;
    renderSubagentPanel();
  }, SUBAGENT_PANEL_REFRESH_DEBOUNCE_MS);
}

function stopSubagentPanelPoll() {
  if (!subagentPanelPollTimer) return;
  clearInterval(subagentPanelPollTimer);
  subagentPanelPollTimer = null;
}

function startSubagentPanelPoll() {
  if (subagentPanelPollTimer) return;
  subagentPanelPollTimer = setInterval(() => {
    if (!isSubagentsPaneActive()) {
      stopSubagentPanelPoll();
      return;
    }
    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
    renderSubagentPanel({ force: true });
  }, SUBAGENT_PANEL_POLL_MS);
}

/** 面板可见 → 首刷 + 启心跳。唯一入口，由 setSidePanelTab 调用（与 context / codebase 面板同构） */
function onSubagentsPanelShown() {
  const panel = document.getElementById('artifacts-panel');
  renderSubagentPanel();
  if (panel && !panel.hidden) startSubagentPanelPoll();
}

function onSubagentsPanelHidden() {
  stopSubagentPanelPoll();
  if (subagentPanelTimer) {
    clearTimeout(subagentPanelTimer);
    subagentPanelTimer = null;
  }
}

/** 用户点了某个标签：立刻换正文（不走防抖），并把选择记在会话上 */
function selectSubagentTab(subagentId) {
  const id = String(subagentId || '');
  if (!id) return;
  subagentPanelSelection.set(subagentSnapshotKey(), id);
  renderSubagentPanel({ force: true });
}

function highlightSubagentTab(subagentId) {
  const btn = findSubagentTab(document.getElementById('subagent-panel-tabs'), subagentId);
  if (!btn) return;
  btn.classList.add('is-highlight');
  btn.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  if (subagentPanelHighlightTimer) clearTimeout(subagentPanelHighlightTimer);
  subagentPanelHighlightTimer = setTimeout(() => {
    subagentPanelHighlightTimer = null;
    btn.classList.remove('is-highlight');
  }, SUBAGENT_PANEL_HIGHLIGHT_MS);
}

/**
 * 聊天区卡片标题行「详情」的落点：打开右侧面板「子代理」页，选中这个子代理。
 * 面板本来就展示本次运行的全部子代理，所以这里只做「打开 + 选中 + 闪一下」，
 * 不引入第二套状态。
 */
function openSubagentPanelDetail(subagentId) {
  const id = String(subagentId || '');
  if (!id) return;
  subagentPanelSelection.set(subagentSnapshotKey(), id);
  if (typeof openSidePanel === 'function') openSidePanel({ tab: 'subagents' });
  // 页签刚被打开时首刷走 onSubagentsPanelShown，这条同步路径再刷一次把选中与正文落定
  selectSubagentTab(id);
  highlightSubagentTab(id);
}

/* ------------------------------------------------------------------ *
 * 页头子标签：子代理 / 轨迹图
 *
 * 两个标签只是「同一页里换一块内容」（与源码管理的「更改 / 历史」同一套 .pane-switch 皮肤，
 * 行为各管各的：这里用 `data-trace-mode-btn`）。子代理 = 本文件下面那套渲染；
 * 轨迹图 = 还没设计，切过去只显示一句占位说明 —— 所以这里**没有**数据通道，
 * 将来设计出来再往 `#trace-graph-wrap` 里加渲染，别为占位先造一套状态机。
 * ------------------------------------------------------------------ */

/** 可选视图（顺序即页头按钮顺序） */
const TRACE_PANE_MODES = ['subagents', 'graph'];
let tracePaneMode = 'subagents';

function setTracePaneMode(mode) {
  if (!TRACE_PANE_MODES.includes(mode)) return;
  tracePaneMode = mode;
  document.querySelectorAll('[data-trace-mode-btn]').forEach((btn) => {
    const on = btn.getAttribute('data-trace-mode-btn') === mode;
    btn.classList.toggle('active', on);
    btn.setAttribute('aria-selected', on ? 'true' : 'false');
  });
  const subagentsWrap = document.getElementById('trace-subagents-wrap');
  const graphWrap = document.getElementById('trace-graph-wrap');
  if (subagentsWrap) subagentsWrap.hidden = mode !== 'subagents';
  if (graphWrap) graphWrap.hidden = mode !== 'graph';
  // 切到轨迹图就地渲染一次：等价于「立刻看一眼现在长什么样」，不用等下一个事件
  if (mode === 'graph') renderTraceGraphPane();
  else renderSubagentPanel({ force: true });
}

/**
 * 轨迹图渲染入口（数据与「子代理」页同一份快照：`readSubagentPanelSnapshot`）。
 *
 * 面板不可见时不渲染（与其它面板同一条可见性守卫），免得后台白画整张图。
 */
function renderTraceGraphPane() {
  if (!isSubagentsPaneActive()) return;
  const mount = document.getElementById('trace-graph-mount');
  if (!mount) return;
  if (typeof window.renderTraceGraph !== 'function') return;
  window.renderTraceGraph(mount, readSubagentPanelSnapshot());
}

/** 绑定页头两个子标签（唯一入口，由 initSidePanel 调一次；与 initScmPane 同构） */
function initSubagentPaneModes() {
  document.querySelectorAll('[data-trace-mode-btn]').forEach((btn) => {
    btn.addEventListener('click', () => {
      setTracePaneMode(btn.getAttribute('data-trace-mode-btn') || 'subagents');
    });
  });
  setTracePaneMode(tracePaneMode);
}
