/* global document, CSS, currentSessionId, sessionActiveRuns, isIsolatedCardEntry, isolatedCardRunning, fillIsolatedCardBody, openSidePanel */
'use strict';

/**
 * 右侧面板「子代理」页：**本次运行的子 Agent 完整思考过程**。
 *
 * 单一来源：这里不新增事件通道、不新增落库、不另存一份数据。
 * 卡片正文直接由思考区同一套渲染原语 `fillIsolatedCardBody` 填充（同一份 `rounds`），
 * 差别只在外层容器：卡片是固定 10 行的滚动盒，面板是不限高的全文视图。
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
 */

const SUBAGENT_PANEL_REFRESH_DEBOUNCE_MS = 200;
const SUBAGENT_PANEL_POLL_MS = 3000;
/** 快照只需要「当前会话 + 最近切过的几个会话」，超限按插入顺序淘汰 */
const SUBAGENT_PANEL_SNAPSHOT_LIMIT = 8;
const SUBAGENT_PANEL_HIGHLIGHT_MS = 1200;

/** @type {Map<string, { runId: string, cards: object[], running: boolean }>} */
const subagentPanelSnapshots = new Map();
/** 用户手动收起的卡片（按 subagentId，重绘不丢） */
const subagentPanelCollapsed = new Set();
/** 每个会话最近一次呈现的 runId：用来发现"换了一轮"，好把上一轮的收起态清掉 */
const subagentPanelRunSeen = new Map();

/**
 * `subagentId` 由每次运行新建的 namer 生成（`sa-<kind>-1`），跨轮会重复；
 * 而收起态是按 id 记的 —— 不清就会"上一轮收起的卡片，这一轮同位置的默认收起"。
 */
function syncSubagentCollapsedForRun(sid, runId) {
  if (subagentPanelRunSeen.get(sid) === runId) return;
  subagentPanelRunSeen.set(sid, runId);
  if (subagentPanelCollapsed.size) subagentPanelCollapsed.clear();
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
      running: !live.finished
    };
    subagentPanelSnapshots.set(sid, snap);
    trimSubagentSnapshots(sid);
    syncSubagentCollapsedForRun(sid, snap.runId);
    return snap;
  }
  // run 收尾后 sessionActiveRuns 会删掉条目：留下的快照一律按「已结束」呈现，
  // 否则面板会永远停在「运行中」。
  const stored = subagentPanelSnapshots.get(sid);
  if (!stored) return { runId: '', cards: [], running: false };
  syncSubagentCollapsedForRun(sid, stored.runId);
  return { ...stored, running: false };
}

function subagentCardStepCount(entry) {
  const rounds = Array.isArray(entry && entry.rounds) ? entry.rounds : [];
  return rounds.reduce((n, r) => n + ((r && r.tools) || []).length, 0);
}

function subagentCardStatusLabel(entry, running) {
  const rounds = Array.isArray(entry && entry.rounds) ? entry.rounds : [];
  const steps = subagentCardStepCount(entry);
  if (running && typeof isolatedCardRunning === 'function' && isolatedCardRunning(entry)) {
    return '运行中…';
  }
  const parts = [`已完成`];
  if (rounds.length > 1) parts.push(`${rounds.length} 轮`);
  if (steps) parts.push(`${steps} 步`);
  return parts.join(' · ');
}

function buildSubagentPanelEmpty(text, hint) {
  const wrap = document.createElement('div');
  wrap.className = 'subagent-panel-empty';
  const title = document.createElement('div');
  title.className = 'subagent-panel-empty-title';
  title.textContent = text;
  wrap.appendChild(title);
  if (hint) {
    const hintEl = document.createElement('div');
    hintEl.className = 'subagent-panel-empty-hint';
    hintEl.textContent = hint;
    wrap.appendChild(hintEl);
  }
  return wrap;
}

/** 一张卡片的外壳（标题 + 状态 + 折叠）；正文交给 fillIsolatedCardBody */
function mountSubagentPanelCard(entry) {
  const subagentId = String((entry && entry.subagentId) || '');
  const details = document.createElement('details');
  details.className = 'subagent-panel-card';
  details.dataset.subagentId = subagentId;
  details.open = !subagentPanelCollapsed.has(subagentId);
  details.addEventListener('toggle', () => {
    if (details.open) subagentPanelCollapsed.delete(subagentId);
    else subagentPanelCollapsed.add(subagentId);
  });

  const summary = document.createElement('summary');
  summary.className = 'subagent-panel-card-head';
  const title = document.createElement('span');
  title.className = 'subagent-panel-card-title';
  title.textContent = String(entry.phase || '子 Agent');
  summary.appendChild(title);
  if (entry.parallel) {
    const badge = document.createElement('span');
    badge.className = 'subagent-panel-card-badge';
    badge.textContent = '并发';
    summary.appendChild(badge);
  }
  const status = document.createElement('span');
  status.className = 'subagent-panel-card-status';
  summary.appendChild(status);
  details.appendChild(summary);

  const body = document.createElement('div');
  body.className = 'subagent-panel-card-body';
  details.appendChild(body);
  return details;
}

function syncSubagentPanelCard(details, entry, running) {
  const status = details.querySelector(':scope > .subagent-panel-card-head > .subagent-panel-card-status');
  const label = subagentCardStatusLabel(entry, running);
  if (status && status.textContent !== label) status.textContent = label;
  details.classList.toggle('is-running', !!(running && isolatedCardRunning(entry)));
  const body = details.querySelector(':scope > .subagent-panel-card-body');
  if (!body) return;
  // 全文渲染：forceReasoning（面板是显式的「看思考」视图）+ noFollowTail（不限高，无需跟随）
  fillIsolatedCardBody(body, entry, { forceReasoning: true, noFollowTail: true });
}

/** 面板头部的「几个 · 什么状态」；空列表不出「0 个」这种噪音 */
function subagentPanelMetaText(cards, running) {
  const list = Array.isArray(cards) ? cards : [];
  if (!list.length) return '—';
  const runningN = running
    ? list.filter((entry) => typeof isolatedCardRunning === 'function' && isolatedCardRunning(entry))
        .length
    : 0;
  return runningN
    ? `${list.length} 个 · ${runningN} 运行中`
    : `${list.length} 个 · 已结束`;
}

function syncSubagentPanelMeta(cards, running) {
  const meta = document.getElementById('subagent-panel-meta');
  if (!meta) return;
  const text = subagentPanelMetaText(cards, running);
  if (meta.textContent !== text) meta.textContent = text;
}

/**
 * 重绘面板。按 subagentId 复用节点（与思考区卡片同一套增量思路），
 * 所以流式刷新时不会整块重建、也不会打断用户滚动或折叠。
 */
function renderSubagentPanel({ force = false } = {}) {
  if (!force && !isSubagentsPaneActive()) return;
  const list = document.getElementById('subagent-panel-list');
  if (!list) return;

  const snap = readSubagentPanelSnapshot();
  const cards = Array.isArray(snap.cards) ? snap.cards : [];
  syncSubagentPanelMeta(cards, snap.running);

  if (!cards.length) {
    list.replaceChildren(
      buildSubagentPanelEmpty(
        '本次运行没有子代理',
        '协调者派发子 Agent 后，它们的完整思考过程会出现在这里'
      )
    );
    return;
  }

  const scrollTop = list.scrollTop;
  // 贴在底部就跟最新一轮（与卡片内滚动同一套语义），用户上翻看历史时不抢位置
  const followTail = list.scrollHeight - list.scrollTop - list.clientHeight < 24;
  const seen = new Set();
  cards.forEach((entry) => {
    const subagentId = String((entry && entry.subagentId) || '');
    if (!subagentId) return;
    seen.add(subagentId);
    const esc = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(subagentId) : subagentId;
    let details = list.querySelector(`:scope > .subagent-panel-card[data-subagent-id="${esc}"]`);
    if (!details) {
      details = mountSubagentPanelCard(entry);
      list.appendChild(details);
    }
    // 复用的节点也要对齐折叠态：「详情」入口会先把该 id 从 collapsed 里移除再重绘
    const wantOpen = !subagentPanelCollapsed.has(subagentId);
    if (details.open !== wantOpen) details.open = wantOpen;
    syncSubagentPanelCard(details, entry, snap.running);
  });
  list.querySelectorAll(':scope > .subagent-panel-card').forEach((el) => {
    if (!seen.has(el.dataset.subagentId || '')) el.remove();
  });
  list.querySelectorAll(':scope > .subagent-panel-empty').forEach((el) => el.remove());
  list.scrollTop = followTail ? list.scrollHeight : scrollTop;
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

function highlightSubagentCard(subagentId) {
  const list = document.getElementById('subagent-panel-list');
  if (!list) return;
  const esc = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(subagentId) : subagentId;
  const card = list.querySelector(`:scope > .subagent-panel-card[data-subagent-id="${esc}"]`);
  if (!card) return;
  card.classList.add('is-highlight');
  card.scrollIntoView({ block: 'nearest' });
  if (subagentPanelHighlightTimer) clearTimeout(subagentPanelHighlightTimer);
  subagentPanelHighlightTimer = setTimeout(() => {
    subagentPanelHighlightTimer = null;
    card.classList.remove('is-highlight');
  }, SUBAGENT_PANEL_HIGHLIGHT_MS);
}

/**
 * 卡片标题行「详情」的落点：打开右侧面板「子代理」页并定位到这张卡片。
 * 面板本来就展示本次运行的全部子代理，所以这里只做「打开 + 展开 + 高亮」，
 * 不引入「当前选中项」这类状态。
 */
function openSubagentPanelDetail(subagentId) {
  const id = String(subagentId || '');
  if (!id) return;
  subagentPanelCollapsed.delete(id);
  if (typeof openSidePanel === 'function') openSidePanel({ tab: 'subagents' });
  renderSubagentPanel({ force: true });
  highlightSubagentCard(id);
}
