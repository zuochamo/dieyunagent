/* global window, document, gatewayCall, gwState, escapeHtml, artifactRpcParams, renderChangesPaneDiffPreview, showAgentToast, getSidePanelTab, CSS */
'use strict';

/**
 * 侧栏「源码管理」独立页：git 工作区状态 + 单文件 diff + 暂存/取消暂存/丢弃/提交，
 * 以及「历史」模式的提交时间线（泳道图 + 展开文件 + 提交内 diff）。
 *
 * 独立 pane 而不是寄生在「变更」页里：变更页自己已经承载本会话变更 / Plan 待审 / Plan 预览
 * 三种视图，再塞一种就得在两处渲染路径之间互相让路（实时写入预览、侧栏切换、增量 patch
 * 各要加判断）。独立之后这些判断全部不需要，pane 之间靠 side-panel 的 tab 切换天然互斥。
 *
 * 历史时间线复用同一 pane 的双模式容器（更改 / 历史），共用工作区目标、连接重试与
 * summary。泳道布局在 Gateway 侧（scm.log 的 lanes 字段）算好，前端只做纯绘制；
 * 分页续算靠把上一页的 active 传回（resume），泳道跨页不断线。
 *
 * 远端/本地差异全部在 Gateway 侧消化（src/git/git-target.js），前端不区分工作区类型。
 */

/** 启动期会话恢复时 Gateway 可能还没握手完，短暂自愈重试而不是把「未连接」当终态 */
const SCM_CONNECT_RETRY_MS = 1000;
const SCM_CONNECT_RETRY_LIMIT = 30;
/** 实时写入完成后的跟随刷新：多次写入合并成一次 git status */
const SCM_FOLLOW_REFRESH_MS = 600;
/** 提交历史每页条数（与服务端 MAX_LOG_PAGE 对齐的常规值） */
const SCM_LOG_PAGE = 50;
/** 泳道 SVG：一列泳道的像素宽 / 一条提交行的像素高 */
const SCM_LANE_W = 14;
const SCM_ROW_H = 46;

const SCM_GROUPS = [
  { id: 'conflicted', title: '冲突', hint: '解决后暂存即标记为已解决', groupAction: null },
  { id: 'staged', title: '已暂存', hint: '', groupAction: 'unstage' },
  { id: 'unstaged', title: '未暂存', hint: '', groupAction: 'stage' },
  { id: 'untracked', title: '未跟踪', hint: '', groupAction: 'stage' }
];

const scmPaneState = {
  mode: 'changes',
  status: null,
  error: '',
  loading: false,
  busy: false,
  active: null,
  paintedKey: '',
  followTimer: null,
  retryTimer: null,
  connectRetries: 0,
  // 历史模式
  log: null,
  logLoading: false,
  logError: '',
  expandedSha: '',
  commitFiles: null,
  commitFilesLoading: false,
  commitFileActive: null,
  commitPaintedKey: ''
};

function scmElements() {
  return {
    list: document.getElementById('scm-file-list'),
    view: document.getElementById('scm-file-view'),
    summary: document.getElementById('scm-summary')
  };
}

function scmHistoryElements() {
  return {
    pane: document.querySelector('.side-panel-pane[data-side-pane="scm"]'),
    historyList: document.getElementById('scm-history-list'),
    commitView: document.getElementById('scm-commit-view'),
    commitDiff: document.getElementById('scm-commit-diff'),
    commitFilebar: document.getElementById('scm-commit-filebar')
  };
}

function setHistoryEmpty(text) {
  const { historyList } = scmHistoryElements();
  if (historyList) historyList.innerHTML = `<div class="artifacts-empty">${escapeHtml(text)}</div>`;
}

/* ------------------------------------------------------------------ *
 * RPC
 * ------------------------------------------------------------------ */

async function scmRpc(method, params) {
  if (!gwState || !gwState.authed) throw new Error('Gateway 未连接');
  const rpcParams =
    typeof artifactRpcParams === 'function'
      ? await artifactRpcParams(params || {})
      : { ...(params || {}) };
  return gatewayCall(method, rpcParams);
}

function scmToast(message, isError) {
  if (typeof showAgentToast === 'function') {
    showAgentToast(message, isError ? { kind: 'error' } : undefined);
    return;
  }
  if (isError) console.warn('[dieyun:scm]', message);
}

/* ------------------------------------------------------------------ *
 * 渲染
 * ------------------------------------------------------------------ */

function setScmEmpty(el, text) {
  if (el) el.innerHTML = `<div class="artifacts-empty">${escapeHtml(text)}</div>`;
}

function scheduleScmConnectRetry() {
  if (scmPaneState.connectRetries >= SCM_CONNECT_RETRY_LIMIT) return;
  scmPaneState.connectRetries += 1;
  if (scmPaneState.retryTimer) clearTimeout(scmPaneState.retryTimer);
  scmPaneState.retryTimer = setTimeout(() => {
    scmPaneState.retryTimer = null;
    if (getSidePanelTab() !== 'scm') return;
    void renderScmPaneAsync();
  }, SCM_CONNECT_RETRY_MS);
}

/**
 * 跟随刷新：Agent 正在写文件时不必每次都拉 git status，合并到一次。
 * 只在源码管理页且处于更改模式时生效，避免在别的页白跑 RPC；
 * 历史时间线不受工作区写入影响，不需要跟随。
 */
function scheduleScmRefresh() {
  if (typeof getSidePanelTab === 'function' && getSidePanelTab() !== 'scm') return;
  if (scmPaneState.mode !== 'changes') return;
  if (scmPaneState.followTimer) clearTimeout(scmPaneState.followTimer);
  scmPaneState.followTimer = setTimeout(() => {
    scmPaneState.followTimer = null;
    void renderScmPaneAsync();
  }, SCM_FOLLOW_REFRESH_MS);
}

function renderScmPane() {
  void renderScmPaneAsync();
}

async function renderScmPaneAsync() {
  const { list, view, summary } = scmElements();
  if (!list) return;
  if (scmPaneState.loading) return;

  if (!gwState || !gwState.authed) {
    setScmEmpty(list, '等待 Gateway 连接…');
    setScmEmpty(view, '连接后自动加载工作区状态');
    setHistoryEmpty('等待 Gateway 连接…');
    if (summary) summary.textContent = '等待连接';
    scheduleScmConnectRetry();
    return;
  }
  scmPaneState.connectRetries = 0;

  scmPaneState.loading = true;
  if (summary) summary.textContent = '读取 git 状态…';

  let status = null;
  try {
    status = await scmRpc('scm.status', {});
    scmPaneState.error = '';
  } catch (err) {
    scmPaneState.error = String((err && err.message) || err);
  } finally {
    scmPaneState.loading = false;
  }

  scmPaneState.status = status;

  if (scmPaneState.error) {
    setScmEmpty(list, `无法读取 git 状态：${scmPaneState.error}`);
    setScmEmpty(view, '请确认工作区已打开、SSH 已连接');
    setHistoryEmpty(`无法读取 git 状态：${scmPaneState.error}`);
    if (summary) summary.textContent = '不可用';
    syncScmFileBar();
    syncScmCommitUi();
    return;
  }

  if (!status || status.ok === false) {
    setScmEmpty(list, '无法读取 git 状态');
    setScmEmpty(view, '选择文件查看 diff');
    setHistoryEmpty('无法读取 git 状态');
    if (summary) summary.textContent = '不可用';
    syncScmFileBar();
    syncScmCommitUi();
    return;
  }

  if (!status.isRepo) {
    setScmEmpty(list, '当前工作区不是 git 仓库');
    setScmEmpty(view, 'git 仓库才能使用源码管理');
    setHistoryEmpty('当前工作区不是 git 仓库，没有历史');
    if (summary) summary.textContent = '非 git 仓库';
    scmPaneState.active = null;
    scmPaneState.paintedKey = '';
    scmPaneState.log = null;
    syncScmFileBar();
    syncScmCommitUi();
    return;
  }

  if (summary) summary.textContent = scmSummaryText(status);

  if (scmPaneState.mode === 'history') {
    // 未出生分支（还没有任何提交）不值得发 log 请求
    if (status.unborn) {
      scmPaneState.log = { commits: [], done: true, active: [] };
      scmPaneState.logError = '';
      renderScmHistory();
      return;
    }
    if (!scmPaneState.log) void loadScmLog({ reset: true });
    else renderScmHistory();
    return;
  }

  renderScmList(list, status);
  syncScmCommitUi();

  const rows = scmFlatRows(status);
  if (!rows.length) {
    if (view) view.innerHTML = '';
    scmPaneState.active = null;
    scmPaneState.paintedKey = '';
    syncScmFileBar();
    return;
  }

  const activeKey = scmPaneState.active ? scmEntryKey(scmPaneState.active) : '';
  const next = rows.find((r) => scmEntryKey(r) === activeKey) || rows[0];
  const rowEl = scmFindRow(list, next);
  if (rowEl) rowEl.classList.add('active');

  // 同一个文件已经画好：只静默换成最新内容，不再打回「加载 diff…」造成闪烁
  void openScmDiff(next, { quiet: scmEntryKey(next) === scmPaneState.paintedKey });
}

function scmSummaryText(status) {
  const head = scmHeadText(status);
  const counts = status.groups || {};
  const parts = [];
  if (counts.staged && counts.staged.length) parts.push(`已暂存 ${counts.staged.length}`);
  if (counts.unstaged && counts.unstaged.length) parts.push(`未暂存 ${counts.unstaged.length}`);
  if (counts.untracked && counts.untracked.length) parts.push(`未跟踪 ${counts.untracked.length}`);
  if (counts.conflicted && counts.conflicted.length) parts.push(`冲突 ${counts.conflicted.length}`);
  return `${head} · ${parts.length ? parts.join(' · ') : '干净'}`;
}

function scmHeadText(status) {
  if (!status) return '';
  const branch = status.branch || (status.detached ? 'HEAD' : '(no branch)');
  const bits = [branch];
  if (status.ahead) bits.push(`↑${status.ahead}`);
  if (status.behind) bits.push(`↓${status.behind}`);
  if (status.untrackedTruncated) bits.push('未跟踪已截断');
  return bits.join(' ');
}

function scmFlatRows(status) {
  const groups = (status && status.groups) || {};
  const out = [];
  for (const def of SCM_GROUPS) {
    for (const row of groups[def.id] || []) out.push(row);
  }
  return out;
}

function scmEntryKey(entry) {
  return entry ? `${entry.group}::${entry.path}` : '';
}

function scmFindRow(list, entry) {
  if (!list || !entry) return null;
  for (const el of list.querySelectorAll('.scm-file-item')) {
    if (
      el.getAttribute('data-scm-group') === entry.group &&
      el.getAttribute('data-scm-path') === entry.path
    ) {
      return el;
    }
  }
  return null;
}

function scmRowDiffText(entry) {
  if (!entry || entry.untracked || entry.added == null) return '';
  const added = Number(entry.added) || 0;
  const removed = Number(entry.removed) || 0;
  if (!added && !removed) return '';
  return `+${added} -${removed}`;
}

function scmRowStatusLetter(entry) {
  if (!entry) return 'M';
  return entry.untracked ? '?' : String(entry.status || 'M').toUpperCase();
}

function scmCreateActionBtn(action, title, glyph, entry) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'scm-file-action';
  btn.setAttribute('data-scm-action', action);
  btn.title = title;
  btn.setAttribute('aria-label', title);
  btn.textContent = glyph;
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    void runScmRowAction(action, entry);
  });
  return btn;
}

function scmCreateRow(entry) {
  const row = document.createElement('div');
  row.className = 'artifacts-file-item scm-file-item';
  row.setAttribute('data-scm-path', entry.path);
  row.setAttribute('data-scm-group', entry.group);
  row.title = entry.origPath ? `${entry.origPath} → ${entry.path}` : entry.path;

  const status = document.createElement('span');
  const letter = scmRowStatusLetter(entry);
  status.className = 'scm-file-status';
  status.setAttribute('data-status', letter);
  status.textContent = letter;
  status.title = entry.statusLabel || '';

  const name = document.createElement('span');
  name.className = 'artifacts-file-name';
  name.textContent = entry.path;
  name.title = row.title;

  const diff = document.createElement('span');
  diff.className = 'artifacts-file-diff';
  diff.textContent = scmRowDiffText(entry);

  const actions = document.createElement('span');
  actions.className = 'scm-file-actions';
  if (entry.group === 'conflicted') {
    actions.appendChild(scmCreateActionBtn('stage', '标记为已解决（暂存）', '+', entry));
  } else if (entry.group === 'staged') {
    actions.appendChild(scmCreateActionBtn('unstage', '取消暂存', '−', entry));
  } else {
    actions.appendChild(scmCreateActionBtn('stage', '暂存', '+', entry));
  }
  if (entry.group !== 'conflicted') {
    actions.appendChild(scmCreateActionBtn('discard', '丢弃该文件的改动', '↺', entry));
  }

  row.append(status, name, diff, actions);
  row.addEventListener('click', () => {
    const list = document.getElementById('scm-file-list');
    if (list) list.querySelectorAll('.scm-file-item').forEach((el) => el.classList.remove('active'));
    row.classList.add('active');
    void openScmDiff(entry);
  });
  return row;
}

function scmCreateGroupHead(def, rows) {
  const head = document.createElement('div');
  head.className = 'scm-group-head';
  head.setAttribute('data-scm-group-head', def.id);

  const title = document.createElement('span');
  title.className = 'scm-group-title';
  title.textContent = def.title;

  const count = document.createElement('span');
  count.className = 'scm-group-count';
  count.textContent = String(rows.length);

  head.append(title, count);

  if (def.groupAction) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ghost-btn scm-group-action';
    btn.textContent = def.groupAction === 'stage' ? '全部暂存' : '全部取消暂存';
    btn.title = btn.textContent;
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const paths = rows.map((r) => r.path);
      if (def.groupAction === 'stage') void scmStagePaths(paths);
      else void scmUnstagePaths(paths);
    });
    head.appendChild(btn);
  } else if (def.hint) {
    const hint = document.createElement('span');
    hint.className = 'scm-group-hint';
    hint.textContent = def.hint;
    head.appendChild(hint);
  }

  return head;
}

function renderScmList(list, status) {
  const groups = (status && status.groups) || {};
  list.innerHTML = '';
  for (const def of SCM_GROUPS) {
    const rows = groups[def.id] || [];
    if (!rows.length) continue;
    list.appendChild(scmCreateGroupHead(def, rows));
    for (const entry of rows) list.appendChild(scmCreateRow(entry));
  }
}

function syncScmFileBar() {
  const bar = document.getElementById('scm-filebar');
  if (!bar) return;
  const entry = scmPaneState.active;
  if (!entry) {
    bar.hidden = true;
    return;
  }
  bar.hidden = false;
  const pathEl = document.getElementById('scm-filebar-path');
  if (pathEl) {
    pathEl.textContent = entry.path;
    pathEl.title = entry.path;
  }
  const metaEl = document.getElementById('scm-filebar-meta');
  if (metaEl) metaEl.textContent = String(entry.statusLabel || '');
}

/* ------------------------------------------------------------------ *
 * diff
 * ------------------------------------------------------------------ */

/**
 * @param {object} entry scm.status 里的行
 * @param {{ quiet?: boolean }} [opts] quiet = 同一文件已画好，静默换成最新内容
 */
async function openScmDiff(entry, opts) {
  const view = document.getElementById('scm-file-view');
  if (!view || !entry) return;
  const quiet = !!(opts && opts.quiet);
  const key = scmEntryKey(entry);

  scmPaneState.active = {
    group: entry.group,
    path: entry.path,
    status: entry.status,
    statusLabel: entry.statusLabel,
    untracked: entry.untracked
  };
  scmPaneState.paintedKey = key;
  syncScmFileBar();
  if (!quiet) view.innerHTML = '<div class="artifacts-empty">加载 diff…</div>';

  let diff = null;
  try {
    diff = await scmRpc('scm.file_diff', {
      path: entry.path,
      group: entry.group,
      status: entry.status
    });
  } catch (err) {
    setScmEmpty(view, `无法加载 diff：${String((err && err.message) || err)}`);
    return;
  }

  // 拉取期间用户可能已经点了别的文件，丢弃过期结果
  if (scmPaneState.paintedKey !== key) return;

  if (!diff || diff.ok === false) {
    setScmEmpty(view, (diff && diff.error) || '无法加载 diff');
    return;
  }
  if (diff.binary) {
    setScmEmpty(view, '二进制文件，不展示文本 diff');
    return;
  }
  if (typeof renderChangesPaneDiffPreview !== 'function') {
    setScmEmpty(view, diff.patch || '无 diff 内容');
    return;
  }

  await renderChangesPaneDiffPreview(
    view,
    {
      path: entry.path,
      diff: {
        beforeText: diff.beforeText || '',
        afterText: diff.afterText || '',
        added: Number(diff.added) || 0,
        removed: Number(diff.removed) || 0,
        created: !!diff.created
      }
    },
    // 源码管理页自带标题栏与操作区，隐藏 diff 自带的路径/徽标头
    { hideDiffHead: true }
  );
}

/* ------------------------------------------------------------------ *
 * 历史模式：提交时间线（泳道图）
 * ------------------------------------------------------------------ */


function setScmMode(mode) {
  if (mode !== 'changes' && mode !== 'history') return;
  if (scmPaneState.mode === mode) return;
  scmPaneState.mode = mode;

  const { pane } = scmHistoryElements();
  if (pane) pane.setAttribute('data-scm-mode', mode);
  document.querySelectorAll('[data-scm-mode-btn]').forEach((btn) => {
    const on = btn.getAttribute('data-scm-mode-btn') === mode;
    btn.classList.toggle('active', on);
    btn.setAttribute('aria-selected', on ? 'true' : 'false');
  });
  const changesWrap = document.getElementById('scm-changes-wrap');
  const historyWrap = document.getElementById('scm-history-wrap');
  if (changesWrap) changesWrap.hidden = mode !== 'changes';
  if (historyWrap) historyWrap.hidden = mode !== 'history';

  if (mode === 'history') {
    const status = scmPaneState.status;
    if (status && status.isRepo && status.unborn) {
      scmPaneState.log = { commits: [], done: true, active: [] };
      scmPaneState.logError = '';
      renderScmHistory();
    } else if (!scmPaneState.log) {
      void loadScmLog({ reset: true });
    } else {
      renderScmHistory();
    }
  }
  syncScmCommitUi();
  syncScmFileBar();
}

/**
 * 提交历史分页加载。追加页把上一页的 active 传回（resume），
 * Gateway 侧续算泳道，跨页的分支线才能对得上。
 */
async function loadScmLog(opts) {
  const reset = !!(opts && opts.reset);
  if (scmPaneState.logLoading) return;
  if (!reset) {
    if (!scmPaneState.log || scmPaneState.log.done) return;
    if (typeof getSidePanelTab === 'function' && getSidePanelTab() !== 'scm') return;
  }
  scmPaneState.logLoading = true;
  if (reset) setHistoryEmpty('加载提交历史…');
  else renderScmHistory();

  const skip = reset || !scmPaneState.log ? 0 : scmPaneState.log.commits.length;
  const resume = reset || !scmPaneState.log ? [] : scmPaneState.log.active;
  try {
    const r = await scmRpc('scm.log', { limit: SCM_LOG_PAGE, skip, resume });
    // 拉取期间用户切回更改模式：结果照存不重画，切回来自然续上
    if (!r || r.ok === false) throw new Error((r && r.error) || '无法读取提交历史');
    const prev = reset ? [] : scmPaneState.log.commits;
    scmPaneState.log = {
      commits: prev.concat(r.commits || []),
      active: r.active || [],
      done: !!r.done
    };
    scmPaneState.logError = '';
  } catch (err) {
    scmPaneState.logError = String((err && err.message) || err);
  } finally {
    scmPaneState.logLoading = false;
  }
  if (scmPaneState.mode === 'history') renderScmHistory();
}

function onScmHistoryScroll() {
  if (scmPaneState.mode !== 'history') return;
  const { historyList } = scmHistoryElements();
  if (!historyList || scmPaneState.logLoading) return;
  if (!scmPaneState.log || scmPaneState.log.done) return;
  if (historyList.scrollTop + historyList.clientHeight < historyList.scrollHeight - 160) return;
  void loadScmLog({ reset: false });
}

/**
 * 泳道 SVG。数据由 Gateway 的 layoutCommitLanes 算好：
 *   - inRails：从本行上方进来的垂线（含节点所在列）；
 *   - edges：从节点引出的父线，from==to 是直行（垂线已画，跳过）；
 *   - appears：窗口/分页边界新长出来的线，不画上半段进入线。
 */
function scmLaneSvg(commit) {
  const columns = Math.max(Number(commit.columns) || 1, 1);
  const width = columns * SCM_LANE_W;
  const cy = SCM_ROW_H / 2;
  const x = (lane) => lane * SCM_LANE_W + SCM_LANE_W / 2;
  const parts = [];
  const nodeLane = Number(commit.lane) || 0;

  for (const rail of commit.inRails || []) {
    const top = commit.appears && rail === nodeLane ? cy : 0;
    parts.push(`<line x1="${x(rail)}" y1="${top}" x2="${x(rail)}" y2="${SCM_ROW_H}"/>`);
  }
  for (const e of commit.edges || []) {
    if (e.from === e.to) continue;
    const mid = cy + (SCM_ROW_H / 2 - cy) / 2 + cy / 2;
    parts.push(
      `<path d="M ${x(e.from)} ${cy} C ${x(e.from)} ${mid}, ${x(e.to)} ${mid}, ${x(e.to)} ${SCM_ROW_H}"/>`
    );
  }
  const isHead = !!(commit.refs && commit.refs.head);
  if (isHead) {
    parts.push(`<circle class="scm-lane-node-ring" cx="${x(nodeLane)}" cy="${cy}" r="7"/>`);
  }
  parts.push(`<circle class="scm-lane-node" cx="${x(nodeLane)}" cy="${cy}" r="3.5"/>`);

  return `<svg class="scm-lane-svg" width="${width}" height="${SCM_ROW_H}" viewBox="0 0 ${width} ${SCM_ROW_H}" aria-hidden="true">${parts.join('')}</svg>`;
}

function scmRefBadges(commit) {
  const refs = commit.refs || {};
  const badges = [];
  if (refs.head) badges.push({ kind: 'head', name: refs.head });
  for (const b of refs.branches || []) {
    if (b !== refs.head) badges.push({ kind: 'branch', name: b });
  }
  for (const r of refs.remotes || []) badges.push({ kind: 'remote', name: r });
  for (const t of refs.tags || []) badges.push({ kind: 'tag', name: t });
  return badges
    .map((b) => `<span class="scm-ref-badge" data-kind="${b.kind}">${escapeHtml(b.name)}</span>`)
    .join('');
}

function scmCreateHistoryRow(commit) {
  const row = document.createElement('div');
  row.className = 'scm-history-row';
  row.setAttribute('data-scm-sha', commit.sha);
  if (commit.sha === scmPaneState.expandedSha) row.classList.add('expanded');

  const lane = document.createElement('span');
  lane.className = 'scm-history-lane';
  lane.innerHTML = scmLaneSvg(commit);

  const main = document.createElement('span');
  main.className = 'scm-history-main';

  const subject = document.createElement('span');
  subject.className = 'scm-history-subject';
  subject.textContent = commit.subject || '(无提交信息)';
  subject.title = commit.subject || '';

  const meta = document.createElement('span');
  meta.className = 'scm-history-meta';
  meta.innerHTML =
    `<span class="scm-history-sha">${escapeHtml(commit.shortSha || '')}</span>` +
    scmRefBadges(commit) +
    `<span class="scm-history-time">${escapeHtml(String(commit.author || ''))} · ${escapeHtml(fmtRelAgo(Number(commit.time) * 1000, { fallback: 'date' }))}</span>`;

  main.append(subject, meta);
  row.append(lane, main);
  row.addEventListener('click', () => {
    void toggleScmCommit(commit);
  });
  return row;
}

function scmCreateCommitFileRow(commit, file) {
  const row = document.createElement('div');
  row.className = 'scm-commit-file';
  row.setAttribute('data-scm-file', file.path);
  if (
    scmPaneState.commitFileActive &&
    scmPaneState.commitFileActive.sha === commit.sha &&
    scmPaneState.commitFileActive.path === file.path
  ) {
    row.classList.add('active');
  }
  row.title = file.origPath ? `${file.origPath} → ${file.path}` : file.path;

  const status = document.createElement('span');
  status.className = 'scm-file-status';
  status.setAttribute('data-status', String(file.status || 'M').toUpperCase());
  status.textContent = String(file.status || 'M').toUpperCase();
  status.title = file.statusLabel || '';

  const name = document.createElement('span');
  name.className = 'scm-commit-file-name';
  name.textContent = file.path;

  const stat = document.createElement('span');
  stat.className = 'artifacts-file-diff';
  const added = Number(file.added) || 0;
  const removed = Number(file.removed) || 0;
  if (added || removed) stat.textContent = `+${added} -${removed}`;

  row.append(status, name, stat);
  row.addEventListener('click', (e) => {
    e.stopPropagation();
    void openScmCommitDiff(commit, file);
  });
  return row;
}

function scmCreateCommitFilesBlock(commit) {
  const block = document.createElement('div');
  block.className = 'scm-commit-files';
  block.setAttribute('data-scm-files-for', commit.sha);

  if (scmPaneState.commitFilesLoading) {
    block.innerHTML = '<div class="artifacts-empty">加载提交文件…</div>';
    return block;
  }
  const files = scmPaneState.commitFiles || [];
  if (!files.length) {
    // merge 提交常无独立变更，明确说明而不是空列表
    block.innerHTML = '<div class="artifacts-empty">该提交没有独立的文件变更（merge 或空提交）</div>';
    return block;
  }
  for (const file of files) block.appendChild(scmCreateCommitFileRow(commit, file));
  return block;
}

function renderScmHistory() {
  const { historyList } = scmHistoryElements();
  if (!historyList) return;

  if (scmPaneState.logError) {
    setHistoryEmpty(`无法读取提交历史：${scmPaneState.logError}`);
    return;
  }
  const log = scmPaneState.log;
  if (!log) {
    setHistoryEmpty('加载提交历史…');
    return;
  }
  if (!log.commits.length) {
    setHistoryEmpty('暂无提交');
    return;
  }

  historyList.innerHTML = '';
  const frag = document.createDocumentFragment();
  for (const commit of log.commits) {
    frag.appendChild(scmCreateHistoryRow(commit));
    if (commit.sha === scmPaneState.expandedSha) {
      frag.appendChild(scmCreateCommitFilesBlock(commit));
    }
  }
  if (!log.done && scmPaneState.logLoading) {
    const more = document.createElement('div');
    more.className = 'scm-history-more';
    more.textContent = '加载更多提交…';
    frag.appendChild(more);
  }
  historyList.appendChild(frag);
}

/** 展开提交：收起则直接重画；展开时拉取文件列表并自动打开第一个文件的 diff */
async function toggleScmCommit(commit) {
  if (scmPaneState.expandedSha === commit.sha) {
    scmPaneState.expandedSha = '';
    scmPaneState.commitFiles = null;
    scmPaneState.commitFileActive = null;
    renderScmHistory();
    return;
  }
  scmPaneState.expandedSha = commit.sha;
  scmPaneState.commitFiles = null;
  scmPaneState.commitFileActive = null;
  scmPaneState.commitFilesLoading = true;
  renderScmHistory();

  let firstFile = null;
  try {
    const r = await scmRpc('scm.commit_files', { sha: commit.sha });
    if (scmPaneState.expandedSha !== commit.sha) return;
    if (!r || r.ok === false) throw new Error((r && r.error) || '无法读取提交文件');
    scmPaneState.commitFiles = r.files || [];
    firstFile = scmPaneState.commitFiles[0] || null;
  } catch (err) {
    scmPaneState.commitFiles = [];
    scmToast(`读取提交文件失败：${String((err && err.message) || err)}`, true);
  } finally {
    scmPaneState.commitFilesLoading = false;
  }
  if (scmPaneState.expandedSha !== commit.sha) return;
  renderScmHistory();
  if (firstFile) void openScmCommitDiff(commit, firstFile);
}

async function openScmCommitDiff(commit, file) {
  const { commitDiff, commitFilebar } = scmHistoryElements();
  if (!commitDiff || !file) return;
  const key = `${commit.sha}::${file.path}`;
  scmPaneState.commitFileActive = { sha: commit.sha, path: file.path };
  scmPaneState.commitPaintedKey = key;

  if (commitFilebar) {
    commitFilebar.hidden = false;
    const pathEl = document.getElementById('scm-commit-filebar-path');
    const metaEl = document.getElementById('scm-commit-filebar-meta');
    const shownPath = file.origPath ? `${file.origPath} → ${file.path}` : file.path;
    if (pathEl) {
      pathEl.textContent = shownPath;
      pathEl.title = shownPath;
    }
    if (metaEl) {
      const added = Number(file.added) || 0;
      const removed = Number(file.removed) || 0;
      const stat = added || removed ? ` · +${added} -${removed}` : '';
      metaEl.textContent = `${file.statusLabel || ''}${stat}`;
    }
  }
  // 子行高亮直接改 DOM，不值得为高亮全量重画列表
  const { historyList } = scmHistoryElements();
  if (historyList) {
    historyList.querySelectorAll('.scm-commit-file.active').forEach((el) => el.classList.remove('active'));
    historyList
      .querySelectorAll(`.scm-commit-file[data-scm-file="${CSS.escape(file.path)}"]`)
      .forEach((el) => el.classList.add('active'));
  }

  commitDiff.innerHTML = '<div class="artifacts-empty">加载 diff…</div>';

  let diff = null;
  try {
    diff = await scmRpc('scm.commit_diff', { sha: commit.sha, path: file.path });
  } catch (err) {
    if (scmPaneState.commitPaintedKey === key) {
      commitDiff.innerHTML = `<div class="artifacts-empty">无法加载 diff：${escapeHtml(String((err && err.message) || err))}</div>`;
    }
    return;
  }
  if (scmPaneState.commitPaintedKey !== key) return;

  if (!diff || diff.ok === false) {
    commitDiff.innerHTML = `<div class="artifacts-empty">${escapeHtml((diff && diff.error) || '无法加载 diff')}</div>`;
    return;
  }
  if (diff.binary) {
    commitDiff.innerHTML = '<div class="artifacts-empty">二进制文件，不展示文本 diff</div>';
    return;
  }
  if (typeof renderChangesPaneDiffPreview !== 'function') {
    commitDiff.textContent = diff.patch || '无 diff 内容';
    return;
  }

  await renderChangesPaneDiffPreview(
    commitDiff,
    {
      path: file.path,
      diff: {
        beforeText: diff.beforeText || '',
        afterText: diff.afterText || '',
        added: Number(diff.added) || 0,
        removed: Number(diff.removed) || 0,
        created: !!diff.created
      }
    },
    { hideDiffHead: true }
  );
}

/* ------------------------------------------------------------------ *
 * 动作
 * ------------------------------------------------------------------ */

async function withScmBusy(fn) {
  if (scmPaneState.busy) return undefined;
  scmPaneState.busy = true;
  try {
    return await fn();
  } finally {
    scmPaneState.busy = false;
  }
}

async function scmStagePaths(paths) {
  return withScmBusy(async () => {
    try {
      const r = await scmRpc('scm.stage', { paths });
      if (!r || r.ok === false) throw new Error((r && r.error) || '暂存失败');
    } catch (err) {
      scmToast(`暂存失败：${String((err && err.message) || err)}`, true);
    }
    await renderScmPaneAsync();
  });
}

async function scmUnstagePaths(paths) {
  return withScmBusy(async () => {
    try {
      const r = await scmRpc('scm.unstage', { paths });
      if (!r || r.ok === false) throw new Error((r && r.error) || '取消暂存失败');
    } catch (err) {
      scmToast(`取消暂存失败：${String((err && err.message) || err)}`, true);
    }
    await renderScmPaneAsync();
  });
}

async function scmDiscardEntry(entry) {
  if (!entry) return undefined;
  const what = entry.group === 'untracked' ? '删除该未跟踪文件' : '丢弃该文件的未提交改动';
  if (!window.confirm(`${what}？\n\n${entry.path}\n\n此操作不可撤销。`)) return undefined;
  return withScmBusy(async () => {
    try {
      const r = await scmRpc('scm.discard', {
        // origPath 让「已暂存的重命名」能被完整撤销（旧名回归），而不只是删掉新名字
        entries: [{ path: entry.path, group: entry.group, origPath: entry.origPath || '' }],
        deleteUntracked: true
      });
      const failed = (r && r.failed) || [];
      if (!r || r.ok === false) {
        const first = failed[0];
        throw new Error((first && first.error) || (r && r.error) || '丢弃失败');
      }
    } catch (err) {
      scmToast(`丢弃失败：${String((err && err.message) || err)}`, true);
    }
    await renderScmPaneAsync();
  });
}

async function runScmRowAction(action, entry) {
  if (action === 'stage') return scmStagePaths([entry.path]);
  if (action === 'unstage') return scmUnstagePaths([entry.path]);
  if (action === 'discard') return scmDiscardEntry(entry);
  return undefined;
}

function syncScmCommitUi() {
  const box = document.getElementById('scm-commit-box');
  const btn = document.getElementById('scm-commit-btn');
  const hint = document.getElementById('scm-commit-hint');
  const input = document.getElementById('scm-commit-message');
  const status = scmPaneState.status;
  const isRepo = !!(status && status.isRepo);
  const changesMode = scmPaneState.mode === 'changes';
  // 非 git 仓库 / 历史模式收起提交区（历史里没有「提交未暂存改动」的语义）
  if (box) box.hidden = !isRepo || !changesMode;
  // 提交按钮已移到面板头部，不再随提交框隐藏，需要单独同步
  if (btn) btn.hidden = !isRepo || !changesMode;

  const stagedCount = status && status.groups ? (status.groups.staged || []).length : 0;
  const hasMessage = !!(input && String(input.value || '').trim());
  if (btn) btn.disabled = scmPaneState.busy || !hasMessage;
  if (!hint) return;
  if (!isRepo || !stagedCount) hint.textContent = '';
  else hint.textContent = `已暂存 ${stagedCount} 个文件`;
}

async function scmCommitCurrent() {
  const input = document.getElementById('scm-commit-message');
  const message = input ? String(input.value || '').trim() : '';
  if (!message) {
    scmToast('请先填写提交信息', true);
    return;
  }
  return withScmBusy(async () => {
    syncScmCommitUi();
    try {
      const r = await scmRpc('scm.commit', { message });
      if (!r || r.ok === false) throw new Error((r && r.error) || '提交失败');
      if (input) input.value = '';
      scmToast(`已提交 ${r.sha || ''}`.trim());
    } catch (err) {
      scmToast(`提交失败：${String((err && err.message) || err)}`, true);
    }
    await renderScmPaneAsync();
    syncScmCommitUi();
  });
}

/* ------------------------------------------------------------------ *
 * 初始化
 * ------------------------------------------------------------------ */

function initScmPane() {
  const refreshBtn = document.getElementById('scm-refresh');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', () => {
      // 历史模式的刷新 = 整段重拉；保留展开态，展开的提交还在就还展开
      if (scmPaneState.mode === 'history') scmPaneState.log = null;
      void renderScmPaneAsync();
    });
  }

  const commitBtn = document.getElementById('scm-commit-btn');
  if (commitBtn) {
    commitBtn.addEventListener('click', () => {
      void scmCommitCurrent();
    });
  }

  const input = document.getElementById('scm-commit-message');
  if (input) {
    input.addEventListener('input', syncScmCommitUi);
    input.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        void scmCommitCurrent();
      }
    });
  }

  document.querySelectorAll('[data-scm-mode-btn]').forEach((btn) => {
    btn.addEventListener('click', () => {
      setScmMode(btn.getAttribute('data-scm-mode-btn'));
    });
  });

  const historyList = document.getElementById('scm-history-list');
  if (historyList) {
    historyList.addEventListener('scroll', () => {
      onScmHistoryScroll();
    });
  }
}

if (typeof window !== 'undefined') {
  window.renderScmPane = renderScmPane;
  window.scheduleScmRefresh = scheduleScmRefresh;
  window.initScmPane = initScmPane;
  window.setScmMode = setScmMode;
}
