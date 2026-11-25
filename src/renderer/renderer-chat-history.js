/* global window, document, $, escapeHtml, gwState, gatewayCall, resetCompactionStateSafe, applySessionWorkspace, updateWorkspaceLabel, invalidateWorkspaceArtifacts, renderAttachmentChips, revokeAttachmentPreview, pendingAttachments, handleWorktreeApplyAfterRun, syncComposerForActiveSession, onComposerSessionActivated, invalidateComposerQueueSession, renderChatFromMessages, renderChatFromMessagesYielding, prependOlderMessagesIncrementally, holdChatScrollAfterPrepend, focusChatInput, loadChatFromGateway, refreshHistoryList, ensureLocalGatewayReady, clearAgentContinueState, loadComposerModelPickForSession, saveComposerModelPick, bumpSessionSwitchGeneration, isActiveSessionSwitch, cleanupStaleSessionRun, syncBrowserBounds, showAgentToast, sessionSwitchGeneration, captureSessionScrollPosition, clearSessionScrollPosition, withSessionScrollCaptureSuppressed, recoverInterruptedAssistantTurn, tryDetectResumeCheckpoint, anyActiveRunUsesRemote, unpackUserMessageContent, dismissToolActivityFloat, reconcileSessionLiveRunUi, restorePendingWorktreeRowFromState, saveSessionMessageCache, getSessionMessageCache, applyMessagesFromCache, gatewayRowsToMessages, invalidateSessionMessageCache, isSessionSending, isSessionMessageCacheStale, clearSessionMessageCacheStale, markSessionCacheDiverged, isSessionCacheDiverged, clearSessionCacheDiverged, getSessionCacheHasMore, setSessionCacheHasMore, CHAT_INITIAL_LOAD_LIMIT, CHAT_LOAD_MORE_LIMIT, CHAT_TURN_ALIGN_FETCH, CHAT_TURN_ALIGN_MAX_ROWS, teardownArtifactsMonacoEditor, cancelArtifactContentLoads, sessionActiveRuns, currentSessionId, messages, setMessagesOwnerSessionId, messagesBelongToSession, beginComposerPrepProgress, setComposerPrepProgress, finishComposerPrepProgress, activateSessionViewState, switchSessionArtifacts, isSidePanelOpen, getSidePanelTab, refreshArtifactsDirectory, renderArtifactsList, renderChangesPane, openSidePanel, setSidePanelTab, isWorkspaceArtifactsCacheReady, flatFolderIconSvg, t, uiText, resolveSessionWorkspacePathSync, sessionIsPeerChat, peerLinkForSession, peerNameForId, rememberSessionWorkspacePath, hasSessionWorkspacePathCache, MESSAGE_META_PREFIX, unpackMessageMeta, triggerIconSvg */
'use strict';

const historyApi = window.diecloud || {};

function markHistoryActive(sessionId) {
  const list = $('history-list');
  if (!list) return;
  for (const row of list.querySelectorAll('.history-row')) {
    row.classList.toggle('active', row.dataset.sessionId === sessionId);
  }
}

function shouldAnimateChatSwitch() {
  return !!chatList && !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let chatSwitchVisualToken = 0;

async function showChatLoadingPlaceholder(_hint, opts = {}) {
  if (!chatList) return;
  const token = opts.token || ++chatSwitchVisualToken;
  if (opts.transition && shouldAnimateChatSwitch()) {
    chatList.classList.remove('chat-session-fade-in');
    chatList.classList.add('chat-session-fade-out');
    await delay(85);
    if (token !== chatSwitchVisualToken) return false;
  }
  const render = () => {
    chatList.innerHTML = '<div class="history-empty chat-loading-placeholder" aria-hidden="true"></div>';
  };
  if (typeof withSessionScrollCaptureSuppressed === 'function') {
    withSessionScrollCaptureSuppressed(render);
  } else {
    render();
  }
  chatList.classList.remove('chat-session-fade-out');
  return true;
}

function isChatLoadingPlaceholder() {
  return !!chatList?.querySelector('.chat-loading-placeholder');
}

function showChatLoadError(message) {
  if (!chatList) return;
  chatList.innerHTML = `<div class="history-empty">${escapeHtml(message || '对话加载失败')}</div>`;
}

function gatewayCallHistoryWithTimeout(method, params, ms = 45000) {
  let timer = null;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${method} 超时`)), ms);
  });
  return Promise.race([gatewayCall(method, params), timeoutPromise]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/** @type {string | null} */
let pendingSwitchTarget = null;
/** @type {number | null} */
let pendingSwitchGen = null;
let switchSessionRunnerActive = false;
let sessionCreateInFlight = false;
let loadingOlderChatMessages = false;
/** 正在取更早历史的那个会话：`loadingOlderChatMessages` 是全局单飞，切了会话就不能拿它当本会话的状态。 */
let loadingOlderSessionId = '';
/**
 * 更早历史加载失败的原因（sessionId → 错误文案）。
 *
 * 失败只由显式点击清空：自动加载在失败之后必须停手（否则每次贴顶滚动都会重试一次，
 * 而界面上什么都看不出来），且失败绝不能显示成「已到会话开头」—— 那是两件事。
 */
const chatOlderLoadErrors = new Map();
/**
 * 「这个窗口确实取到了会话开头」的会话（只在真读过库、确认取尽时记）。
 *
 * 不能拿 `hasMore === false` 顶替：`hasMore` 存在会话消息缓存里，缓存被作废
 * （后台追加 / 一轮跑完）时它会一起消失，而视图里那 100 条仍然是个尾部窗口 ——
 * 那时候宣布「已到会话开头」就是假话。取不了页就干脆不显示这一行。
 */
const chatOlderExhaustedSessions = new Set();

function isSessionSwitchInFlight() {
  return pendingSwitchTarget != null || switchSessionRunnerActive || sessionCreateInFlight;
}

function getPendingSwitchTarget() {
  return pendingSwitchTarget;
}

if (typeof window !== 'undefined') {
  window.isSessionSwitchInFlight = isSessionSwitchInFlight;
  window.getPendingSwitchTarget = getPendingSwitchTarget;
}

let historyListRefreshInflight = null;

function historyListHasRows() {
  const list = $('history-list');
  return !!list?.querySelector('.history-row');
}

function setHistoryListStaleHint(show) {
  const list = $('history-list');
  if (!list) return;
  let hint = list.querySelector('.history-list-stale-hint');
  if (!show) {
    hint?.remove();
    list.classList.remove('history-list-stale');
    return;
  }
  list.classList.add('history-list-stale');
  if (!hint) {
    hint = document.createElement('div');
    hint.className = 'history-list-stale-hint';
    hint.textContent = '列表刷新较慢，显示上次结果';
    list.prepend(hint);
  }
}

/**
 * 会话列表只发一次请求：失败就把网关给的 `errorCode`/`message` 说出来。
 *
 * 这里曾有一层「3 次 × 1.5s 重试 + 12s 无限重试」，代价是把 `errorCode` 丢掉、
 * 把「core 未就绪 / SQLite 锁 / RPC 契约错误」统一显示成「后台较忙，正在重试加载…」，
 * 用户和日志都拿不到真实原因。启动期的短等已由 `ensureLocalGatewayReady()` 与
 * `renderer-gateway.js#withStartupGrace` 负责，渲染层不再自带重试。
 */
async function fetchSessionsList(params = {}) {
  return gatewayCall('memory.sessions_list', {
    limit: 50,
    archived: false,
    ...params
  });
}

/** 把一次失败说清楚：`errorCode` 有就带，没有就用 message。 */
function describeGatewayFailure(err) {
  const code = String((err && (err.code || err.errorCode)) || '').trim();
  const msg = String((err && err.message) || '未知错误').trim();
  return code ? `${code}：${msg}` : msg;
}

/**
 * 启动自愈：localStorage 的 session 若已删/为 legacy `default`，切到历史里最近一条。
 * @returns {Promise<string>} 校正后的 currentSessionId
 */
async function healActiveSessionFromHistory() {
  if (!gwState || !gwState.authed) return String(currentSessionId || '');
  let sessions = [];
  try {
    sessions = (await fetchSessionsList({ archived: false })) || [];
  } catch (err) {
    console.warn('启动会话校正失败:', err);
    return String(currentSessionId || '');
  }
  const cur = String(currentSessionId || '');
  if (sessions.some((s) => s && String(s.id) === cur)) return cur;
  if (sessions.length) {
    const next = String(sessions[0].id);
    currentSessionId = next;
    setCurrentSessionId(next);
    return next;
  }
  return cur;
}

const HISTORY_FOLDER_UI_KEY = 'dieyun.historyFolders.v1';

/**
 * 「Bot 对话」这一层的分组键：对端会话不是项目对话，单独一层（见 `groupSessionsByWorkspace`）。
 * 用 `peer://` 前缀保证它与任何真实路径键（`historyWorkspaceKey` 产出的小写路径 / `ssh:`）不相撞。
 */
const PEER_HISTORY_GROUP_KEY = 'peer://sessions';

function historyWorkspaceKey(path) {
  const p = String(path || '').trim();
  if (!p) return '';
  if (/^ssh:/i.test(p)) return p.replace(/[\\/]+$/, '');
  return p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

function historyWorkspaceLabel(path) {
  if (!path) {
    return typeof t === 'function' ? t('history_folder_unbound') : '未绑定工作区';
  }
  const raw = String(path).replace(/[\\/]+$/, '');
  const parts = raw.split(/[\\/]/).filter(Boolean);
  let name = parts[parts.length - 1] || raw;
  try {
    name = decodeURIComponent(name);
  } catch {
    // keep
  }
  return name;
}

function groupSessionsByWorkspace(sessions) {
  const groups = [];
  const index = new Map();
  for (const s of sessions || []) {
    // 对端会话（与某台 agent 的对话）**不按工作区归堆**：它不是某个项目的对话，
    // 建的时候 `workspacePath` 就是 null（见 `peer/coordinator.js#createSessionForPeer`），
    // 按路径分组只会把它埋进折叠的「未绑定工作区」；被视图工作区绑走过的那些则会
    // 藏进别人的项目文件夹里，长得像一次普通任务 —— 两种都等于「左侧看不到」。
    const peer = typeof sessionIsPeerChat === 'function' && sessionIsPeerChat(s && s.id);
    // 按「项目」分组，不按会话副本：远端会话的 workspacePath 是它自己那份 worktree
    // （…/.dieyun/worktrees/sess-xxx/main）。按原值分组会让同一项目的每个会话
    // 各自变成一个名为 main 的文件夹；项目身份由 Main 侧给出（workspaceProjectPath）。
    const path = peer ? '' : String((s && (s.workspaceProjectPath || s.workspacePath)) || '').trim();
    const key = peer ? PEER_HISTORY_GROUP_KEY : historyWorkspaceKey(path);
    let g = index.get(key);
    if (!g) {
      g = { key, path, peer, sessions: [] };
      index.set(key, g);
      groups.push(g);
    }
    g.sessions.push(s);
  }
  return groups;
}

function loadHistoryFolderUi() {
  const ui = { collapsed: new Set(), expanded: new Set(), order: [] };
  try {
    const raw = window.localStorage.getItem(HISTORY_FOLDER_UI_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    if (parsed && Array.isArray(parsed.collapsed)) {
      for (const k of parsed.collapsed) ui.collapsed.add(String(k));
    }
    if (parsed && Array.isArray(parsed.expanded)) {
      for (const k of parsed.expanded) ui.expanded.add(String(k));
    }
    if (parsed && Array.isArray(parsed.order)) {
      ui.order = parsed.order.map((k) => String(k));
    }
  } catch {
    // ignore
  }
  return ui;
}

function saveHistoryFolderUi(ui) {
  try {
    window.localStorage.setItem(
      HISTORY_FOLDER_UI_KEY,
      JSON.stringify({
        collapsed: [...(ui.collapsed || [])],
        expanded: [...(ui.expanded || [])],
        order: Array.isArray(ui.order) ? ui.order.map((k) => String(k)) : []
      })
    );
  } catch {
    // ignore
  }
}

/** Keep folder order stable; append newly seen workspaces; unbound stays last. */
function syncHistoryFolderOrder(groups, ui) {
  const present = new Set((groups || []).map((g) => String(g.key)));
  const next = [];
  const seen = new Set();
  for (const k of ui.order || []) {
    const key = String(k);
    if (!present.has(key) || seen.has(key)) continue;
    next.push(key);
    seen.add(key);
  }
  for (const g of groups || []) {
    const key = String(g.key);
    if (seen.has(key)) continue;
    next.push(key);
    seen.add(key);
  }
  const unboundIdx = next.indexOf('');
  if (unboundIdx >= 0 && unboundIdx !== next.length - 1) {
    next.splice(unboundIdx, 1);
    next.push('');
  }
  ui.order = next;
  return next;
}

function sortHistoryFolderGroups(groups, order) {
  const rank = new Map((order || []).map((k, i) => [String(k), i]));
  groups.sort((a, b) => {
    const ka = String(a.key);
    const kb = String(b.key);
    if (!ka && kb) return 1;
    if (ka && !kb) return -1;
    const ra = rank.has(ka) ? rank.get(ka) : order.length;
    const rb = rank.has(kb) ? rank.get(kb) : order.length;
    return ra - rb;
  });
}

function isHistoryFolderExpanded(key, ui, defaultOpen) {
  const state = ui || loadHistoryFolderUi();
  if (state.collapsed.has(key)) return false;
  if (state.expanded.has(key)) return true;
  if (defaultOpen) return true;
  const activePath =
    typeof window !== 'undefined' ? String(window.activeViewSessionWorkspacePath || '').trim() : '';
  if (key && historyWorkspaceKey(activePath) === key) return true;
  return false;
}

function toggleHistoryFolder(key) {
  const list = $('history-list');
  if (!list) return;
  const encoded = encodeURIComponent(key);
  let currentlyExpanded = false;
  for (const group of list.querySelectorAll('.history-folder-group')) {
    if (group.dataset.workspaceKey !== encoded) continue;
    currentlyExpanded = !group.classList.contains('is-collapsed');
    break;
  }
  const next = !currentlyExpanded;
  const ui = loadHistoryFolderUi();
  if (next) {
    ui.collapsed.delete(key);
    ui.expanded.add(key);
  } else {
    ui.expanded.delete(key);
    ui.collapsed.add(key);
  }
  saveHistoryFolderUi(ui);
  for (const group of list.querySelectorAll('.history-folder-group')) {
    if (group.dataset.workspaceKey !== encoded) continue;
    group.classList.toggle('is-collapsed', !next);
    const btn = group.querySelector('.history-folder-toggle');
    if (btn) btn.setAttribute('aria-expanded', next ? 'true' : 'false');
  }
}

/**
 * 局部同步「思考中」指示器与归档/删除按钮。
 * 复用已有节点，避免重建思考环时 CSS 动画被打回 0° 产生抽动。
 */
function syncHistoryRowActions(actions, thinking, isBackgroundRun) {
  if (!actions) return;
  const label = isBackgroundRun ? '后台运行中' : '思考中';
  const indicator = actions.querySelector('.history-thinking');
  if (thinking) {
    for (const btn of actions.querySelectorAll('.history-act')) btn.remove();
    let el = indicator;
    if (!el) {
      el = document.createElement('div');
      el.className = 'history-thinking';
      el.setAttribute('role', 'status');
      el.innerHTML = '<span class="history-thinking-spinner" aria-hidden="true"></span>';
      actions.appendChild(el);
    }
    if (el.title !== label) el.title = label;
    if (el.getAttribute('aria-label') !== label) el.setAttribute('aria-label', label);
    return;
  }
  if (indicator) indicator.remove();
  if (actions.querySelector('.history-act')) return;
  const handoff = document.createElement('button');
  handoff.type = 'button';
  handoff.className = 'history-act history-act-handoff';
  handoff.title = '生成交接（供新会话继续）';
  handoff.textContent = '⇄';
  actions.appendChild(handoff);

  const arch = document.createElement('button');
  arch.type = 'button';
  arch.className = 'history-act';
  arch.title = '归档';
  arch.textContent = '⊟';
  actions.appendChild(arch);

  const del = document.createElement('button');
  del.type = 'button';
  del.className = 'history-act history-act-danger';
  del.title = '删除';
  del.textContent = '×';
  actions.appendChild(del);
}

const historyRowIconCache = new WeakMap();

/**
 * 会话行前置图标：**只看结构信号** —— 首条 user 行 meta 的 `trigger.kind`
 * （Rust `memory.sessions_list` 投影成 `triggerKind`），不扫标题、不猜正文。
 *
 * 图标本身复用触发条的同一份 kind → SVG（`renderer-chat-bubbles.js#triggerIconSvg`）：
 * 侧栏一眼能分出「定时任务会话」「心跳会话」与「自己聊的会话」，且不会与触发条漂移。
 * 槽位恒定存在（没人触发就空着），否则同组里有没有图标会让标题起始位置参差。
 */
function syncHistoryRowIcon(iconEl, triggerKind) {
  if (!iconEl) return;
  const svg = typeof triggerIconSvg === 'function' ? triggerIconSvg(triggerKind) : '';
  if (historyRowIconCache.get(iconEl) === svg) return;
  historyRowIconCache.set(iconEl, svg);
  iconEl.innerHTML = svg;
}

/**
 * 会话行标题：对端会话前面挂上「对方叫什么」。
 *
 * 标题本身会被 AI 总结覆盖（`sessions.title_source = 'ai'`，如「DIEYUN11来信问候」），
 * 一台一台看还行，同一个「Bot 对话」层里并排就没法分辨是谁。名字来自 links 缓存
 * （`peerNameForId`），不是从标题里抠的；标题里本来就带名字时不重复挂。
 */
function historyRowTitle(s, peerId) {
  const base = sessionListTitle(s);
  if (!peerId) return base;
  const name = typeof peerNameForId === 'function' ? String(peerNameForId(peerId) || '') : '';
  if (!name || name === peerId || base.includes(name)) return base;
  return `${name} · ${base}`;
}

/** 就地更新一行历史（复用节点，不重建 DOM）。 */
function updateHistorySessionRow(row, s) {
  const sid = String(s.id);
  const active = sid === String(currentSessionId || '');
  const live = sessionActiveRuns.get(s.id);
  const thinking = !!(live && !live.finished);
  const isBackgroundRun = thinking && !active;
  const peerId = typeof sessionIsPeerChat === 'function' && sessionIsPeerChat(sid)
    ? String(typeof peerLinkForSession === 'function' ? peerLinkForSession(sid) : '')
    : '';

  row.className = `history-row${active ? ' active' : ''}${thinking ? ' thinking' : ''}${isBackgroundRun ? ' background-run' : ''}${peerId ? ' is-peer-session' : ''}`;
  row.dataset.sessionId = sid;
  if (peerId) row.dataset.peerId = peerId;
  else delete row.dataset.peerId;
  const rowWs = s && s.workspacePath != null ? String(s.workspacePath) : '';
  row.dataset.workspacePath = rowWs;
  if (typeof rememberSessionWorkspacePath === 'function') {
    rememberSessionWorkspacePath(s.id, rowWs);
  }

  // 对端会话用 bot 图标（同 `triggerIconSvg` 的一份表）：一眼看出「这不是项目对话」
  syncHistoryRowIcon(row.querySelector('.history-item-icon'), peerId ? 'peer' : s.triggerKind);
  const mainEl = row.querySelector('.history-item-main');
  if (mainEl) {
    // 悬浮就能看到「这是跟谁在说话」——也保住了标题被 AI 改名后丢掉的身份
    mainEl.title = peerId
      ? (typeof uiText === 'function' ? uiText('history_peer_hover', '与 %s 的对话') : '与 %s 的对话').replace(
          '%s',
          typeof peerNameForId === 'function' ? peerNameForId(peerId) : peerId
        )
      : '';
  }
  const titleEl = row.querySelector('.history-item-title');
  if (titleEl) {
    const next = historyRowTitle(s, peerId);
    if (titleEl.textContent !== next) titleEl.textContent = next;
  }
  const metaEl = row.querySelector('.history-item-meta');
  if (metaEl) {
    const next = fmtRelShort(s.updatedAt);
    if (metaEl.textContent !== next) metaEl.textContent = next;
  }
  syncHistoryRowActions(row.querySelector('.history-actions'), thinking, isBackgroundRun);
  return row;
}

function createHistorySessionRow(s) {
  const row = document.createElement('div');
  row.className = 'history-row';
  row.dataset.sessionId = String(s.id);

  const main = document.createElement('button');
  main.type = 'button';
  main.className = 'history-item-main';
  const icon = document.createElement('span');
  icon.className = 'history-item-icon';
  icon.setAttribute('aria-hidden', 'true');
  const title = document.createElement('span');
  title.className = 'history-item-title';
  const meta = document.createElement('span');
  meta.className = 'history-item-meta';
  main.appendChild(icon);
  main.appendChild(title);
  main.appendChild(meta);

  const actions = document.createElement('div');
  actions.className = 'history-actions';

  row.appendChild(main);
  row.appendChild(actions);
  return updateHistorySessionRow(row, s);
}

const historyFolderIconCache = new WeakMap();

function createHistoryFolderGroupEl() {
  const wrap = document.createElement('div');
  wrap.className = 'history-folder-group';

  const folderRow = document.createElement('div');
  folderRow.className = 'history-folder';

  const folderBtn = document.createElement('button');
  folderBtn.type = 'button';
  folderBtn.className = 'history-folder-toggle';
  const icon = document.createElement('span');
  icon.className = 'history-folder-icon';
  const name = document.createElement('span');
  name.className = 'history-folder-name';
  folderBtn.appendChild(icon);
  folderBtn.appendChild(name);

  const folderRemove = document.createElement('button');
  folderRemove.type = 'button';
  folderRemove.className = 'history-folder-remove';
  folderRemove.textContent = '×';

  const folderNew = document.createElement('button');
  folderNew.type = 'button';
  folderNew.className = 'history-folder-new';
  folderNew.textContent = '+';

  const folderActs = document.createElement('div');
  folderActs.className = 'history-folder-actions';
  folderActs.appendChild(folderRemove);
  folderActs.appendChild(folderNew);

  folderRow.appendChild(folderBtn);
  folderRow.appendChild(folderActs);

  const items = document.createElement('div');
  items.className = 'history-folder-items';

  wrap.appendChild(folderRow);
  wrap.appendChild(items);
  return wrap;
}

function updateHistoryFolderGroupEl(wrap, group, expanded) {
  wrap.dataset.workspaceKey = encodeURIComponent(group.key);
  wrap.dataset.workspacePath = group.path || '';
  wrap.classList.toggle('is-collapsed', !expanded);
  wrap.classList.toggle('history-folder-peer', !!group.peer);

  const label = group.peer
    ? typeof uiText === 'function'
      ? uiText('history_folder_peer', 'Bot 对话')
      : 'Bot 对话'
    : historyWorkspaceLabel(group.path);

  const btn = wrap.querySelector('.history-folder-toggle');
  if (btn) {
    btn.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    btn.title = group.peer
      ? label
      : group.path || (typeof t === 'function' ? t('history_folder_unbound') : '未绑定工作区');
    const icon = btn.querySelector('.history-folder-icon');
    if (icon) {
      const svg = typeof flatFolderIconSvg === 'function' ? flatFolderIconSvg(14) : '';
      if (historyFolderIconCache.get(icon) !== svg) {
        icon.innerHTML = svg;
        historyFolderIconCache.set(icon, svg);
      }
    }
    const name = btn.querySelector('.history-folder-name');
    if (name && name.textContent !== label) name.textContent = label;
  }

  const removeBtn = wrap.querySelector('.history-folder-remove');
  if (removeBtn) {
    const removeTitle = typeof t === 'function' ? t('remove_folder') : '移除此工作空间';
    if (removeBtn.title !== removeTitle) removeBtn.title = removeTitle;
    if (removeBtn.getAttribute('aria-label') !== removeTitle) {
      removeBtn.setAttribute('aria-label', removeTitle);
    }
  }
  const newBtn = wrap.querySelector('.history-folder-new');
  if (newBtn) {
    // 「在此工作空间新建对话」在 Bot 这一层没有意义：对端会话由 Bot 面板开，
    // 这里按下去只会得到一条没绑对端的普通新对话（看着像「跟 bot 新建对话」）
    newBtn.hidden = !!group.peer;
    const newTitle =
      typeof t === 'function' ? t('new_chat_in_folder') : '在此工作空间新建对话';
    if (newBtn.title !== newTitle) newBtn.title = newTitle;
    if (newBtn.getAttribute('aria-label') !== newTitle) {
      newBtn.setAttribute('aria-label', newTitle);
    }
  }
}

/**
 * 一层文件夹默认展开吗（用户自己的折叠/展开记录仍然优先，见 `isHistoryFolderExpanded`）。
 *
 * 「Bot 对话」默认展开：那层里的东西用户根本没地方去别处找 —— 收起来就等于没有
 * （这正是它原来被埋进「未绑定工作区」时的问题）。
 */
function historyFolderDefaultOpen(group, groups, currentSid) {
  if (!group) return false;
  if (group.peer) return true;
  if ((groups || []).length === 1) return true;
  const sid = String(currentSid || '');
  return (group.sessions || []).some((s) => s && String(s.id) === sid);
}

/**
 * Keyed 局部更新：按 workspaceKey / sessionId 复用现有节点，仅增删差异。
 * 避免整表 replaceChildren 导致「思考中」小环动画每次刷新被打回 0°（抽动）。
 */
function renderHistorySessionRows(sessions) {
  const list = $('history-list');
  if (!list) return;
  const groups = groupSessionsByWorkspace(sessions);
  const folderUi = loadHistoryFolderUi();
  const folderOrder = syncHistoryFolderOrder(groups, folderUi);
  saveHistoryFolderUi(folderUi);
  sortHistoryFolderGroups(groups, folderOrder);
  const currentSid = String(currentSessionId || '');

  const groupEls = new Map();
  const rowElsByGroup = new Map();
  for (const wrap of list.querySelectorAll(':scope > .history-folder-group')) {
    const key = String(wrap.dataset.workspaceKey || '');
    groupEls.set(key, wrap);
    const rows = new Map();
    for (const row of wrap.querySelectorAll('.history-folder-items > .history-row')) {
      rows.set(String(row.dataset.sessionId || ''), row);
    }
    rowElsByGroup.set(key, rows);
  }
  // 与旧的 replaceChildren 行为一致：清掉分组以外的直接子节点（陈旧提示等）
  for (const child of [...list.children]) {
    if (!child.classList.contains('history-folder-group')) child.remove();
  }

  const keptGroups = new Set();
  let cursor = list.firstChild;
  for (const group of groups) {
    const encodedKey = encodeURIComponent(group.key);
    keptGroups.add(encodedKey);
    let wrap = groupEls.get(encodedKey);
    if (!wrap) {
      wrap = createHistoryFolderGroupEl();
      groupEls.set(encodedKey, wrap);
      rowElsByGroup.set(encodedKey, new Map());
    }

    const expanded = isHistoryFolderExpanded(
      group.key,
      folderUi,
      historyFolderDefaultOpen(group, groups, currentSid)
    );
    updateHistoryFolderGroupEl(wrap, group, expanded);

    const items = wrap.querySelector('.history-folder-items');
    const rowEls = rowElsByGroup.get(encodedKey);
    const keptRows = new Set();
    let rowCursor = items.firstChild;
    for (const s of group.sessions) {
      const sid = String(s.id);
      keptRows.add(sid);
      let row = rowEls.get(sid);
      if (row) {
        updateHistorySessionRow(row, s);
      } else {
        row = createHistorySessionRow(s);
        rowEls.set(sid, row);
      }
      if (row !== rowCursor) {
        items.insertBefore(row, rowCursor);
      } else {
        rowCursor = rowCursor.nextSibling;
      }
    }
    for (const [sid, row] of rowEls) {
      if (!keptRows.has(sid)) {
        row.remove();
        rowEls.delete(sid);
      }
    }

    if (wrap !== cursor) {
      list.insertBefore(wrap, cursor);
    } else {
      cursor = cursor.nextSibling;
    }
  }

  for (const [key, wrap] of groupEls) {
    if (!keptGroups.has(key)) wrap.remove();
  }
}

async function renderLoadedSessionMessages(switchGen, sessionId, guarded) {
  if (typeof recoverInterruptedAssistantTurn === 'function') {
    try {
      await recoverInterruptedAssistantTurn(sessionId);
    } catch (e) {
      console.warn('恢复中断思考失败:', e);
    }
  }
  if (typeof tryDetectResumeCheckpoint === 'function') {
    void tryDetectResumeCheckpoint(sessionId);
  }
  // 「待应用的 plan 产出」恢复：`agent_runs.status === 'pending_apply'` 是库里的持久事实，
  // 但面板行只活在进程内 Map —— 不按状态补回来，重启后这份产出就再也找不到「应用」按钮了。
  if (typeof restorePendingWorktreeRowFromState === 'function') {
    try {
      await restorePendingWorktreeRowFromState(sessionId);
    } catch (e) {
      console.warn('恢复待应用变更失败:', e);
    }
  }

  let rendered = false;
  if (typeof renderChatFromMessagesYielding === 'function') {
    rendered = await renderChatFromMessagesYielding({
      switchGen,
      sessionId,
      forceScroll: false,
      transition: guarded
    });
  }
  if (!rendered) {
    renderChatFromMessages({ forceScroll: false, sessionId, transition: guarded });
    rendered = !!chatList && !chatList.querySelector('.chat-loading-placeholder');
  }
  if (guarded && !isActiveSessionSwitch(switchGen)) return false;
  if (sessionId !== currentSessionId) return false;
  if (!rendered) return false;
  focusChatInput();
  return true;
}

/**
 * 聊天区顶部那一行「更早历史」的唯一状态来源（按钮文案 / 失败重试 / 已到开头的判定）。
 *
 * `start` 需要两个事实同时成立：这个窗口**确实取到了会话开头**（`chatOlderExhaustedSessions`），
 * 且窗口曾经填满过首页 —— 本来就只有几条的短对话从开头就全显示出来了，顶上不该多一行。
 * @param {string} sessionId
 * @returns {'loading' | 'error' | 'more' | 'start' | 'none'}
 */
function chatHistoryEdgeMode(sessionId) {
  const sid = String(sessionId || '');
  if (!sid || !gwState.authed) return 'none';
  if (loadingOlderChatMessages && loadingOlderSessionId === sid) return 'loading';
  if (chatOlderLoadErrors.has(sid)) return 'error';
  if (getSessionCacheHasMore(sid)) return 'more';
  if (chatOlderExhaustedSessions.has(sid) && messages.length >= CHAT_INITIAL_LOAD_LIMIT) return 'start';
  return 'none';
}

/**
 * 顶部那行「更早历史」：`more`/`error` 是可点的按钮，`loading` 是禁用的按钮，
 * `start` 是一句静态说明，`none` 不生成节点。整屏重渲染时随 `chatList.innerHTML = ''`
 * 一起重建；只有状态变化才走 `syncChatHistoryEdgeNode`（原地替换，不重渲染对话）。
 * @returns {HTMLElement | null}
 */
function renderChatHistoryEdge() {
  const mode = chatHistoryEdgeMode(currentSessionId);
  if (mode === 'none') return null;
  const row = document.createElement('div');
  row.className = 'chat-history-edge';
  row.dataset.mode = mode;
  if (mode === 'start') {
    const label = document.createElement('span');
    label.className = 'chat-history-edge-label';
    label.textContent = uiText('chat_history_start', '已到会话开头');
    row.append(label);
    return row;
  }
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'chat-history-edge-btn';
  if (mode === 'loading') {
    // 转圈比「文案换了」更早被看见：等待时先有动静，再谈位置
    const spinner = document.createElement('span');
    spinner.className = 'chat-history-edge-spinner';
    spinner.setAttribute('aria-hidden', 'true');
    btn.append(spinner);
  }
  btn.append(
    document.createTextNode(
      mode === 'loading'
        ? uiText('chat_history_loading_older', '正在加载…')
        : mode === 'error'
          ? uiText('chat_history_retry_older', '重新加载')
          : uiText('chat_history_load_older', '加载更早')
    )
  );
  btn.disabled = mode === 'loading';
  if (mode === 'error') {
    const reason = chatOlderLoadErrors.get(String(currentSessionId));
    btn.title = reason
      ? `${uiText('chat_history_load_failed', '历史加载失败，点此重试')}（${reason}）`
      : uiText('chat_history_load_failed', '历史加载失败，点此重试');
  }
  btn.addEventListener('click', () => {
    void retryOlderChatMessages().catch((e) => console.warn('加载更早消息失败:', e));
  });
  row.append(btn);
  return row;
}

/** 状态变了就地换掉那一行（正在加载 → 重新加载 / 加载更早 / 已到会话开头），不重渲染整段对话。 */
function syncChatHistoryEdgeNode() {
  if (!chatList) return;
  const existing = chatList.querySelector(':scope > .chat-history-edge');
  const next = renderChatHistoryEdge();
  if (existing) {
    if (!next) {
      existing.remove();
      return;
    }
    // 内容没变就别换节点：换掉会让正在按「重新加载」的焦点丢失，也会扰动滚动锚点
    if (existing.dataset.mode === next.dataset.mode && existing.textContent === next.textContent) return;
    existing.replaceWith(next);
    return;
  }
  if (next && messages.length && !chatList.querySelector('.chat-loading-placeholder')) {
    chatList.prepend(next);
  }
}

/**
 * 把窗口头对齐到「轮次开头」—— 一页不能切在某一轮中间。
 *
 * 判据只有一条：窗口第一条必须是用户消息。界面上「一轮」就是一颗用户气泡带出的
 * `.msg-turn`（`renderer-chat-bubbles.js`），而用户消息正是账本里那一轮的开口，所以
 * 「头是 user 行」= 「头是轮次开头」，不需要另造一份轮次表。
 *
 * 往前取到的那一批**只从其中最近的一条用户消息开始接**（多出来的更早行一律不要），
 * 这样补的那几条就是「这一轮的开头」，而不是顺手把一整批也塞进窗口。
 * 取到的那批里一条用户消息都没有时才继续往前；一轮里塞满几百条工具消息时最多再多拉
 * `CHAT_TURN_ALIGN_MAX_ROWS` 条，拉满就接受这个不齐的头。
 * @param {string} sessionId
 * @param {Array<object>} rows 已取到的这一页（旧 → 新）
 * @param {object} [opts]
 * @param {number} [opts.fetchSize] 每次往前问多少条（默认 `CHAT_TURN_ALIGN_FETCH`，与一页宽度无关）
 * @param {boolean} [opts.exhausted] 这一页是否已经取到了会话开头
 * @param {(beforeId: number, limit: number) => Promise<Array<object>>} [opts.fetch]
 *   取更早一页的实现；缺省走 `memory.messages_older`，单测从这里注入
 * @returns {Promise<{ rows: Array<object>, exhausted: boolean }>}
 */
async function alignRowsToTurnStart(sessionId, rows, opts = {}) {
  const fetchSize = Math.max(1, Number(opts.fetchSize) || CHAT_TURN_ALIGN_FETCH);
  const fetchOlder =
    typeof opts.fetch === 'function'
      ? opts.fetch
      : (beforeId, limit) =>
          gatewayCallHistoryWithTimeout('memory.messages_older', {
            sessionId,
            beforeId,
            limit
          });
  let out = Array.isArray(rows) ? rows.slice() : [];
  let exhausted = opts.exhausted === true;
  let pulled = 0;
  for (;;) {
    if (exhausted || !out.length || out[0].role === 'user') break;
    const headId = Number(out[0].id);
    if (!Number.isFinite(headId)) break;
    if (pulled + fetchSize > CHAT_TURN_ALIGN_MAX_ROWS) break;
    const batch = await fetchOlder(headId, fetchSize);
    if (!Array.isArray(batch) || !batch.length) {
      exhausted = true;
      break;
    }
    pulled += batch.length;
    if (batch.length < fetchSize) exhausted = true;
    // 这一批里最后一条用户消息 = 最近的轮次开头：从它开始接，比它更早的不要
    let startIdx = -1;
    for (let i = batch.length - 1; i >= 0; i -= 1) {
      if (batch[i].role === 'user') {
        startIdx = i;
        break;
      }
    }
    if (startIdx >= 0) {
      out = batch.slice(startIdx).concat(out);
      break;
    }
    out = batch.concat(out);
  }
  return { rows: out, exhausted };
}

/** 失败后的显式重试：清掉上次的失败标记，再走同一个分页入口（自动路径在失败态下不会自己重试）。 */
async function retryOlderChatMessages() {
  const sessionId = String(currentSessionId || '');
  if (!sessionId) return;
  chatOlderLoadErrors.delete(sessionId);
  syncChatHistoryEdgeNode();
  await maybeLoadOlderChatMessages({ force: true });
  syncChatHistoryEdgeNode();
}

async function maybeLoadOlderChatMessages(opts = {}) {
  if (loadingOlderChatMessages || !chatList || !gwState.authed) return;
  const sessionId = String(currentSessionId || '');
  if (!sessionId) return;
  const force = opts.force === true;
  // 自动路径只在「还有更早的」时才动手；显式重试不认这个标记 —— 它可能已经被缓存作废顺手抹掉，
  // 认它就等于让「重新加载」变成一颗点了没反应的死按钮。
  if (!force && !getSessionCacheHasMore(sessionId)) return;
  // 顶部按钮是显式入口，不受滚动位置限制；自动路径只在贴顶且内容已超出视口时才取，
  // 并且失败之后不再自己重试 —— 要么用户点「重新加载」，要么就停在那里。
  if (!force) {
    if (chatList.scrollTop > 96) return;
    if (chatList.scrollHeight <= chatList.clientHeight + 96) return;
    if (chatOlderLoadErrors.has(sessionId)) return;
  }
  const oldest = messages[0];
  const beforeId =
    oldest?.id != null
      ? Number(oldest.id)
      : oldest?.localMsgId != null
        ? Number(oldest.localMsgId)
        : NaN;
  if (!Number.isFinite(beforeId)) return;

  loadingOlderChatMessages = true;
  loadingOlderSessionId = sessionId;
  syncChatHistoryEdgeNode();
  try {
    const page = await gatewayCallHistoryWithTimeout('memory.messages_older', {
      sessionId,
      beforeId,
      limit: CHAT_LOAD_MORE_LIMIT
    });
    if (sessionId !== String(currentSessionId || '')) return;
    chatOlderLoadErrors.delete(sessionId);
    if (!page || !page.length) {
      setSessionCacheHasMore(sessionId, false);
      chatOlderExhaustedSessions.add(sessionId);
      return;
    }
    const aligned = await alignRowsToTurnStart(sessionId, page, {
      fetchSize: CHAT_TURN_ALIGN_FETCH,
      exhausted: page.length < CHAT_LOAD_MORE_LIMIT
    });
    if (sessionId !== String(currentSessionId || '')) return;
    if (aligned.exhausted) chatOlderExhaustedSessions.add(sessionId);
    else chatOlderExhaustedSessions.delete(sessionId);
    const older = gatewayRowsToMessages(aligned.rows);
    if (!older.length) {
      setSessionCacheHasMore(sessionId, false);
      chatOlderExhaustedSessions.add(sessionId);
      return;
    }
    const hasMore = !aligned.exhausted;
    messages.unshift(...older);
    setSessionCacheHasMore(sessionId, hasMore);
    saveSessionMessageCache(sessionId, messages, { hasMore });
    // 动 DOM 之前记下位置与高度：增量插入用锚点纠偏，整屏重渲染退路才用得上这两个数
    const scrollBase = {
      top: chatList.scrollTop,
      height: chatList.scrollHeight
    };
    // 能只画新增的那几条就别整屏重画：整屏重渲染会「闪一下 + 跳一下」，增量插入不会
    const prepended =
      typeof prependOlderMessagesIncrementally === 'function'
        ? prependOlderMessagesIncrementally(sessionId, older.length)
        : null;
    if (prepended) {
      // 位置交给它一处负责：只按「锚点漂了多少」纠偏，绝不设绝对位置
      if (typeof holdChatScrollAfterPrepend === 'function') {
        holdChatScrollAfterPrepend({
          anchor: prepended.anchor,
          portTopBefore: prepended.portTopBefore,
          inserted: prepended.inserted
        });
      }
    } else {
      if (typeof renderChatFromMessagesYielding === 'function') {
        await renderChatFromMessagesYielding({ forceScroll: false, sessionId });
      } else {
        renderChatFromMessages({ forceScroll: false, sessionId });
      }
      // 整屏重渲染没有锚点可用：按插入前后的整体高度差把位置推回去
      chatList.scrollTop = scrollBase.top + Math.max(0, chatList.scrollHeight - scrollBase.height);
    }
  } catch (e) {
    console.warn('加载更早消息失败:', e);
    chatOlderLoadErrors.set(sessionId, String((e && e.message) || e || ''));
  } finally {
    loadingOlderChatMessages = false;
    loadingOlderSessionId = '';
    syncChatHistoryEdgeNode();
  }
}

async function drainSwitchSessionQueue() {
  if (switchSessionRunnerActive) return;
  switchSessionRunnerActive = true;
  try {
    while (pendingSwitchTarget != null) {
      const target = pendingSwitchTarget;
      const switchGen = pendingSwitchGen;
      pendingSwitchTarget = null;
      pendingSwitchGen = null;
      if (target == null || switchGen == null) continue;
      await performSwitchSession(target, switchGen);
    }
  } finally {
    switchSessionRunnerActive = false;
    if (pendingSwitchTarget != null) {
      void drainSwitchSessionQueue();
    } else if (typeof syncComposerForActiveSession === 'function') {
      syncComposerForActiveSession();
    }
  }
}

/**
 * 会话标题用：剥离落库 meta 前缀，正文为空时回退到 meta.inputText。
 *
 * 计划/定时触发那一轮的抬头（`[计划 · 名字]` + `<时间> · 定时触发`）是本仓自己拼的
 * （`src/plans/plan-run-turn.js`），同一事实在 meta 的 `trigger` 里——所以**优先读 meta**：
 * 有计划名就拿计划名当标题，不再靠「哪一行含『定时触发』」猜抬头
 * （那会把用户正文里恰好提到这几个词的句子也跳过）。
 */
function stripMessageMetaForTitle(raw) {
  const s = String(raw || '').trim();
  const { content, meta } = unpackMessageMeta(s);
  if (meta) {
    const planName =
      meta && meta.trigger && typeof meta.trigger === 'object'
        ? String(meta.trigger.planName || '').trim()
        : '';
    if (planName) return planName;
    const body = String(content || '').trim();
    if (body) return body;
    return meta.inputText != null ? String(meta.inputText).trim() : '';
  }
  // 无 meta：整段即正文；但「前缀存在却解析失败」不能把原始 meta 当标题暴露。
  return s.startsWith(MESSAGE_META_PREFIX) ? '' : s;
}

function formatSessionTitleSlice(text) {
  const line =
    String(text || '')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find(Boolean) || String(text || '');
  const normalized = line.replace(/\s+/g, ' ');
  const sentence = normalized.match(/^[^。！？.!?\n]+[。！？.!?]?/)?.[0] || normalized;
  return (sentence.trim() || normalized).slice(0, 48);
}

function titleFromPreview(preview) {
  const text = stripMessageMetaForTitle(preview);
  if (!text) return '';
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (const line of lines) {
    // 只跳本仓自己的抬头格式（精确首尾），不做词面猜测
    if (/^\[计划 · .+\]$/.test(line)) continue;
    if (line.endsWith(' · 定时触发') || line.endsWith(' · 目标续跑')) continue;
    // 内网对端来信的抬头也是本仓拼的（`src/peer/coordinator.js#inboundText` / `handleReply`）：
    // 不跳的话，「Bot 对话」那一行的标题会是「【内网 Agent 来信 · DIEYUN11】」这种信头
    if (/^【内网 Agent 来信 · .+】$/.test(line)) continue;
    if (/^来源 peerId：/.test(line)) continue;
    if (/^【.+ 的回复】$/.test(line)) continue;
    const normalized = line.replace(/\s+/g, ' ');
    const sentence = normalized.match(/^[^。！？.!?\n]+[。！？.!?]?/)?.[0] || normalized;
    const slice = (sentence.trim() || normalized).slice(0, 48);
    if (slice) return slice;
  }
  return text.replace(/\s+/g, ' ').slice(0, 48);
}

function sessionListTitle(s) {
  const storedRaw = stripMessageMetaForTitle(s && s.title);
  const stored =
    storedRaw && !storedRaw.startsWith(MESSAGE_META_PREFIX) && storedRaw !== '新对话' && storedRaw !== '对话'
      ? storedRaw
      : '';
  if (stored) return formatSessionTitleSlice(stored);
  const preview = titleFromPreview(s && s.preview) || stripMessageMetaForTitle(s && s.preview);
  if (!preview) return '对话';
  return formatSessionTitleSlice(preview) || '对话';
}

async function refreshHistoryList(opts = {}) {
  const list = $('history-list');
  if (!list) return;

  if (historyListRefreshInflight) {
    return historyListRefreshInflight;
  }

  const hadRows = historyListHasRows();
  const softFail = !!opts.softFail || hadRows;

  historyListRefreshInflight = (async () => {
    try {
      if (typeof ensureLocalGatewayReady === 'function') {
        await ensureLocalGatewayReady();
      } else if (!gwState.authed) {
        return;
      }
      const sessions = await fetchSessionsList();
      setHistoryListStaleHint(false);

      if (!sessions || !sessions.length) {
        list.replaceChildren();
        const empty = document.createElement('div');
        empty.className = 'history-empty';
        empty.textContent = '暂无历史';
        list.appendChild(empty);
        return;
      }
      renderHistorySessionRows(sessions);
    } catch (err) {
      console.warn('历史对话加载失败:', err);
      if (softFail && historyListHasRows()) {
        // 已有列表：留着上次结果，并把失败写在提示条里（不再自动重试）
        setHistoryListStaleHint(true);
        return;
      }
      if (!historyListHasRows()) {
        const detail = describeGatewayFailure(err);
        const empty = document.createElement('div');
        empty.className = 'history-empty';
        empty.textContent = `历史对话加载失败（${detail}）`;
        list.replaceChildren(empty);
      }
    } finally {
      historyListRefreshInflight = null;
    }
  })();

  return historyListRefreshInflight;
}

/**
 * 后台在 Main 里跑完一轮（企业微信频道 / 生命感心跳等）：让界面追上那一条会话。
 *
 * 为什么需要：这些轮次不经过 Renderer、也不推流，消息只落进同一个账本。若你**正开着**
 * 那条会话，界面一动不动 —— 只能切走再切回才看得见（"企业微信那边答完了、这边还没刷出来"
 * 就是这么来的）。这里做的事只有两件：把该会话的消息缓存作废；如果**正开着它**且没有别的
 * 轮在跑，就地重读一次。不切换当前会话、不抢滚动位置（重读走会话加载那条老路，位置由它恢复）。
 *
 * 频道（`channels:sessions-changed`）与心跳（`alive:ran`）共用这一份：两边要的语义完全一样，
 * 各写一份只会慢慢分叉。
 *
 * @param {string} sessionId 后台跑完的那条会话
 */
async function refreshSessionAfterBackgroundTurn(sessionId) {
  const sid = String(sessionId || '');
  if (!sid) return;
  if (typeof invalidateSessionMessageCache === 'function') invalidateSessionMessageCache(sid);
  void refreshHistoryList({ softFail: true });
  if (String(currentSessionId || '') !== sid) return;
  // 这一轮正在由 Renderer 自己驱动（用户在这条会话里打字）：别插一脚
  if (typeof isSessionSending === 'function' && isSessionSending(sid)) return;
  if (typeof loadChatFromGateway !== 'function') return;
  try {
    await loadChatFromGateway(null, sid, { forceRefresh: true });
  } catch {
    // 刷新失败只影响「看不看得到最新一轮」，不提示、不打断
  }
}

/** 会话 → 待注入交接来源（「继续上次」一次性信号，首轮发送即消费） */
const pendingHandoffBySession = new Map();

function setPendingSessionHandoff(sessionId, fromSessionId) {
  const sid = String(sessionId || '').trim();
  if (sid && fromSessionId) pendingHandoffBySession.set(sid, String(fromSessionId));
}

function consumePendingSessionHandoff(sessionId) {
  const sid = String(sessionId || '').trim();
  if (!sid) return null;
  const from = pendingHandoffBySession.get(sid) || null;
  pendingHandoffBySession.delete(sid);
  return from;
}

/** 只读探测（不消费）：系统提示缓存键要看「本轮是否带交接」，消费仍归 consumePendingSessionHandoff */
function peekPendingSessionHandoff(sessionId) {
  const sid = String(sessionId || '').trim();
  return sid ? pendingHandoffBySession.get(sid) || null : null;
}

/** 历史行「⇄」：为该会话生成交接（Main 单轮 LLM → memory.handoff_save） */
async function generateHandoffForSession(sessionId, btn) {
  if (!gwState.authed) return;
  const diecloud = typeof window !== 'undefined' ? window.diecloud : null;
  if (!diecloud || typeof diecloud.sessionHandoffGenerate !== 'function') {
    window.alert('当前版本不支持会话交接');
    return;
  }
  if (btn) {
    btn.disabled = true;
    btn.textContent = '…';
  }
  try {
    const r = await diecloud.sessionHandoffGenerate({ sessionId });
    if (btn) {
      btn.textContent = '✓';
      window.setTimeout(() => {
        btn.textContent = '⇄';
        btn.disabled = false;
      }, 2000);
    }
    return r;
  } catch (e) {
    if (btn) {
      btn.textContent = '⇄';
      btn.disabled = false;
    }
    window.alert(`交接生成失败：${(e && e.message) || e}`);
    return null;
  }
}

/**
 * 顶部「+」菜单：一个按键两件事（新对话 / 继续上次交接）。
 * 有可继续的交接才弹菜单，没有就直接新建 —— 空菜单不如没有菜单。
 */
const newChatMenuState = { open: false };
/** 打开菜单时现取的那份交接；点「继续上次」直接用它，不再二次查询 */
let newChatMenuHandoff = null;
/** 开菜单/新建之间有一次交接查询，连点两次会各建一个会话 —— 用它在查询窗口内挡重复点击 */
let newChatMenuBusy = false;

function setNewChatMenuOpen(open) {
  newChatMenuState.open = !!open;
  const menu = $('history-new-menu');
  const btn = $('chat-new');
  if (menu) menu.hidden = !newChatMenuState.open;
  if (btn) btn.setAttribute('aria-expanded', newChatMenuState.open ? 'true' : 'false');
  if (!newChatMenuState.open) newChatMenuHandoff = null;
}

/** 把交接写进菜单第二项：副标题「来自「<会话标题>」· <时间>」；没有交接就整项隐藏 */
function renderNewChatHandoffItem(latest) {
  const item = $('history-continue-item');
  const sub = $('history-continue-sub');
  if (!item) return;
  item.hidden = !latest;
  if (!latest || !sub) return;
  const title = String(latest.title || '').trim();
  const when = fmtRelShort(Number(latest.createdAt) || 0);
  const fromText = title
    ? (typeof t === 'function' ? t('continue_last_from').replace('%s', title) : `来自「${title}」`)
    : '';
  sub.textContent = [fromText, when].filter(Boolean).join(' · ');
}

/** 最近一份交接（排除当前会话）；读不到按「没有交接」处理 —— 菜单是增强，不能挡新建 */
async function fetchLatestHandoff() {
  try {
    const latest = await gatewayCall('memory.handoff_latest', {
      excludeSessionId: String(currentSessionId || '') || null
    });
    return latest && latest.payload ? latest : null;
  } catch (e) {
    console.warn('读取会话交接失败:', e);
    return null;
  }
}

/**
 * 顶部「+」里的「新对话」：永远开一条**不挂工作空间**的对话（落到默认 ~/.dieyun/workspace）。
 * 必须显式传 null —— 传 undefined 会继承当前视图的工作空间。只「不写绑定字段」还不够：
 * 未绑定会话的视图/工具目标本来就跟随当前视图，视图还挂着那个工作空间时新对话照样在用它，
 * 等于又绑上了；null 分支会连视图工作空间一起清掉（有远端在跑时不动）。
 * 要在某个工作空间里开新对话，用历史分组行上的 +（显式传该分组的 path）。
 */
function startUnboundNewChat() {
  return createNewSession(null);
}

/** 「继续上次」的取回入口（取最近交接 → 新建会话）；无交接时给出可执行提示 */
async function openNewChatMenu() {
  if (!gwState.authed || newChatMenuBusy) return;
  newChatMenuBusy = true;
  try {
    const latest = await fetchLatestHandoff();
    if (!latest) {
      setNewChatMenuOpen(false);
      await startUnboundNewChat();
      return;
    }
    newChatMenuHandoff = latest;
    renderNewChatHandoffItem(latest);
    setNewChatMenuOpen(true);
  } finally {
    newChatMenuBusy = false;
  }
}

/** 领走一份交接（`memory.handoff_take`：Rust 侧读出来即删）。
 *  领不到返回 null —— 调用方**不许**再建会话；这条就是防连点 / 多窗口重复建空会话的唯一闸门。 */
async function takeSessionHandoff(sessionId) {
  try {
    const row = await gatewayCall('memory.handoff_take', { sessionId });
    return row && row.sessionId ? row : null;
  } catch (e) {
    console.warn('领取会话交接失败:', e);
    return null;
  }
}

/** 会话没建起来时的回滚：把刚领走的交接原样写回去（`handoff_save` 是覆盖写）。 */
async function restoreSessionHandoff(taken) {
  try {
    await gatewayCall('memory.handoff_save', {
      sessionId: String((taken && taken.sessionId) || ''),
      title: String((taken && taken.title) || ''),
      payload: String((taken && taken.payload) || '')
    });
  } catch (e) {
    console.warn('交接放回失败:', e);
  }
}

/**
 * 用一份交接新建会话，首轮自动注入【上个会话交接】。
 *
 * 交接是**一次性资源**：先领走（`memory.handoff_take` 读出即删）再建会话，
 * 领不到就什么都不做。领到但会话没建起来要把交接放回去，别把用户的交接吃掉。
 * 点击必须有回声（toast）—— 只写 console 的失败在界面上等于「点了没反应」。
 */
async function continueFromHandoff(latest) {
  const fromId = String((latest && latest.sessionId) || '').trim();
  if (!fromId) return;
  const taken = await takeSessionHandoff(fromId);
  if (!taken) {
    showAgentToast('这份交接已经不在了', '可能已被别的窗口领走；刷新后点「+」看还有没有可继续的交接。', {
      variant: 'warn'
    });
    return;
  }
  // 交接自带来源工作区（memory.handoff_* 已剥到仓库根）：跨项目「继续上次」必须挂到
  // 交接讲的仓库，而不是用户当前视图的工作区；没有记录才沿用当前视图。
  const handoffWs = String(taken.workspacePath || '').trim();
  const newSessionId = await createNewSession(handoffWs || undefined);
  if (!newSessionId) {
    await restoreSessionHandoff(taken);
    showAgentToast('接手失败', '新会话没建起来，交接已放回；可再试一次或看主进程日志。', {
      variant: 'warn'
    });
    return;
  }
  // 模型也跟着交接走：交接可能来自别的会话，新会话要用**来源会话**的模型，而不是
  // 当前视图会话的模型（createNewSession 默认继承的是当前会话）。
  if (
    typeof loadComposerModelPickForSession === 'function' &&
    typeof saveComposerModelPick === 'function'
  ) {
    saveComposerModelPick(loadComposerModelPickForSession(fromId), newSessionId);
  }
  setPendingSessionHandoff(newSessionId, fromId);
  const fromTitle = String(taken.title || '').trim();
  showAgentToast(
    fromTitle ? `已接手「${fromTitle}」` : '已接手上一份交接',
    '这一轮发出去的第一条会自动带上交接（一次性，用过即删）。',
    { variant: 'info' }
  );
}

/** 「继续上次」的取回入口（取最近交接 → 新建会话）；无交接时给出可执行提示 */
async function continueFromLastSession() {
  if (!gwState.authed) return;
  const latest = await fetchLatestHandoff();
  if (!latest) {
    window.alert('没有可用的会话交接（先在历史记录里对某个会话点 ⇄ 生成交接）');
    return;
  }
  await continueFromHandoff(latest);
}

async function archiveSession(sessionId, archived) {
  if (!gwState.authed) return;
  try {
    await gatewayCall('memory.session_archive', { sessionId, archived });
    if (sessionId === currentSessionId && archived) {
      await createNewSession();
    }
    await refreshHistoryList();
  } catch (err) {
    console.warn(err);
  }
}

async function purgeSessionRecords(sessionId) {
  const sid = String(sessionId || '');
  if (!sid) return;
  await gatewayCall('memory.session_delete', { sessionId: sid });
  invalidateSessionMessageCache(sid);
  if (typeof invalidateComposerQueueSession === 'function') {
    invalidateComposerQueueSession(sid);
  }
  if (typeof cleanupSessionScopedComposerState === 'function') {
    cleanupSessionScopedComposerState(sid);
  }
  if (typeof cleanupSessionViewState === 'function') cleanupSessionViewState(sid);
  if (typeof cleanupSessionArtifacts === 'function') cleanupSessionArtifacts(sid);
  // 撤回快照是整份落盘（undo-sessions/<sid>.json + 内容块目录）：会话删了还留着就是死账，
  // 实测本机攒到 17GB / 389 个文件（issue/2026-11-07-smoothness-investigation.md）。
  if (typeof clearSessionUndo === 'function') clearSessionUndo(sid);
  if (window.diecloud?.terminalStop) {
    await window.diecloud.terminalStop({ sessionId: sid }).catch(() => {});
  }
}

async function deleteSession(sessionId) {
  if (!gwState.authed) return;
  if (!window.confirm('确定删除这条对话？此操作不可恢复。')) return;
  try {
    await purgeSessionRecords(sessionId);
    if (sessionId === currentSessionId) {
      const sessions = await fetchSessionsList({ limit: 1, archived: false });
      if (sessions && sessions.length) {
        await switchSession(sessions[0].id);
      } else {
        await createNewSession();
      }
    }
    await refreshHistoryList();
    setTimeout(() => focusChatInput(), 0);
  } catch (err) {
    console.warn(err);
  }
}

async function removeHistoryFolder(groupEl) {
  if (!gwState.authed || !groupEl) return;
  const ids = [...groupEl.querySelectorAll('.history-row[data-session-id]')].map(
    (row) => row.dataset.sessionId
  );
  if (!ids.length) return;
  const label =
    groupEl.querySelector('.history-folder-name')?.textContent?.trim() ||
    (typeof t === 'function' ? t('history_folder_unbound') : '未绑定工作区');
  const confirmText =
    typeof t === 'function'
      ? t('remove_folder_confirm').replace('%s', label).replace('%d', String(ids.length))
      : `确定移除「${label}」及其下的 ${ids.length} 条对话？此操作不可恢复。`;
  if (!window.confirm(confirmText)) return;
  const currentSid = String(currentSessionId || '');
  const hadCurrent = ids.includes(currentSid);
  try {
    for (const id of ids) {
      try {
        await purgeSessionRecords(id);
      } catch (err) {
        console.warn(err);
      }
    }
    const key =
      groupEl.dataset.workspaceKey != null ? decodeURIComponent(groupEl.dataset.workspaceKey) : '';
    const ui = loadHistoryFolderUi();
    ui.order = (ui.order || []).filter((k) => String(k) !== String(key));
    ui.collapsed.delete(key);
    ui.expanded.delete(key);
    saveHistoryFolderUi(ui);
    if (hadCurrent) {
      const sessions = await fetchSessionsList({ limit: 1, archived: false });
      if (sessions && sessions.length) {
        await switchSession(sessions[0].id);
      } else {
        await createNewSession();
      }
    }
    await refreshHistoryList();
    setTimeout(() => focusChatInput(), 0);
  } catch (err) {
    console.warn(err);
  }
}

function sessionHasPaintableCache(sessionId) {
  const sid = String(sessionId || '');
  if (!sid) return false;
  if (typeof isSessionMessageCacheStale === 'function' && isSessionMessageCacheStale(sid)) {
    return false;
  }
  const cached = typeof getSessionMessageCache === 'function' ? getSessionMessageCache(sid) : null;
  return !!(cached && cached.messages && cached.messages.length);
}

function switchSession(sessionId) {
  if (!sessionId) return Promise.resolve();
  const target = String(sessionId);
  if (currentSessionId && target !== String(currentSessionId)) {
    captureSessionScrollPosition(currentSessionId, { force: true });
    // 换会话就停朗读：音频属于上一段对话，跟着切走会「串台」
    if (typeof stopTtsPlayback === 'function') stopTtsPlayback();
  }
  const switchGen = bumpSessionSwitchGeneration();
  pendingSwitchTarget = target;
  pendingSwitchGen = switchGen;
  markHistoryActive(target);
  if (typeof syncComposerForActiveSession === 'function') syncComposerForActiveSession();
  const visualToken = ++chatSwitchVisualToken;
  const hasCache = sessionHasPaintableCache(target);
  // Cache hit: skip fade, but still swap to placeholder so old bubbles cannot linger
  // under the new currentSessionId (visual 串台).
  return showChatLoadingPlaceholder(null, {
    transition: !hasCache,
    token: visualToken
  }).then(() => {
    if (visualToken !== chatSwitchVisualToken) return;
    return drainSwitchSessionQueue();
  });
}

/**
 * 离开一个会话时，把它的窗口按需留在缓存里。
 *
 * 规矩只有一条 —— **还停在首屏那一段才留**。翻过更早历史的会话直接丢：切回来重新读最近
 * 32 条，回到首屏的样子（阅读位置一起丢，否则下次进来会跳进一段已经不在窗口里的内容）。
 * 没翻过的会话照旧进缓存，频繁来回切换不用回源。
 * @param {string} sessionId 正在离开的会话
 */
function rememberSessionWindowOnLeave(sessionId) {
  const sid = String(sessionId || '');
  if (!sid || !messages.length) return;
  if (typeof messagesBelongToSession === 'function' && !messagesBelongToSession(sid)) return;
  if (messages.length > CHAT_INITIAL_LOAD_LIMIT) {
    invalidateSessionMessageCache(sid);
    if (typeof clearSessionScrollPosition === 'function') clearSessionScrollPosition(sid);
    return;
  }
  saveSessionMessageCache(sid, messages, { hasMore: getSessionCacheHasMore(sid) });
}

async function performSwitchSession(sessionId, switchGen) {
  const target = String(sessionId);
  const prevSessionId = currentSessionId;
  const sameSession = target === prevSessionId;
  const showProgress = !sameSession;
  let progressOwned = false;

  try {
    if (showProgress && typeof beginComposerPrepProgress === 'function') {
      beginComposerPrepProgress('正在切换对话');
      progressOwned = true;
      if (typeof setComposerPrepProgress === 'function') setComposerPrepProgress(8);
    }

    if (!sameSession) {
      // 仅当全局 messages 确属离开的会话时才处理，避免 A→B→C 把 A 的消息毒进 B 的 cache
      if (prevSessionId && messages.length && typeof messagesBelongToSession === 'function' &&
        messagesBelongToSession(prevSessionId)) {
        rememberSessionWindowOnLeave(prevSessionId);
      }
      if (typeof cleanupStaleSessionRun === 'function') cleanupStaleSessionRun(prevSessionId);
      if (typeof cancelArtifactContentLoads === 'function') cancelArtifactContentLoads();
      const prevWs =
        typeof window !== 'undefined' && window.activeViewSessionWorkspacePath
          ? String(window.activeViewSessionWorkspacePath).trim()
          : typeof resolveSessionWorkspacePathSync === 'function'
            ? String(resolveSessionWorkspacePathSync(prevSessionId) || '').trim()
            : '';
      const nextWs =
        typeof resolveSessionWorkspacePathSync === 'function'
          ? String(resolveSessionWorkspacePathSync(target) || '').trim()
          : '';
      const sameWorkspace = !!(prevWs && nextWs && prevWs === nextWs);
      if (!sameWorkspace && typeof teardownArtifactsMonacoEditor === 'function') {
        await teardownArtifactsMonacoEditor();
      }
      // Session-scoped gateway context. SSH stays connected across conversation
      // switches; only explicit disconnect / idle eviction / app quit tears them down.
      if (!isActiveSessionSwitch(switchGen)) return;

      if (typeof setComposerPrepProgress === 'function') setComposerPrepProgress(18);
      // 侧栏先切 tab，但跳过内容渲染：等 applySessionWorkspace 落地后再刷文件列表
      if (typeof activateSessionViewState === 'function') {
        activateSessionViewState(prevSessionId, target, { skipRender: true });
      }
      if (typeof switchSessionArtifacts === 'function') {
        switchSessionArtifacts(prevSessionId, target, { skipRender: true });
      }
      currentSessionId = target;
      setCurrentSessionId(target);
      if (typeof onComposerSessionActivated === 'function') onComposerSessionActivated(target);
      if (typeof setComposerPrepProgress === 'function') setComposerPrepProgress(28);
    }

    if (typeof syncBrowserBounds === 'function') syncBrowserBounds();

    const knownWs =
      typeof resolveSessionWorkspacePathSync === 'function'
        ? resolveSessionWorkspacePathSync(target)
        : null;
    const workspaceReady = applySessionWorkspace(target, {
      skipDefaultEditor: true,
      switchGen,
      ...(knownWs ? { knownWorkspacePath: knownWs } : {})
    }).then((r) => {
      if (progressOwned && typeof setComposerPrepProgress === 'function') setComposerPrepProgress(52);
      return r;
    });
    const chatReady = loadChatFromGateway(switchGen, target).then((r) => {
      if (progressOwned && typeof setComposerPrepProgress === 'function') setComposerPrepProgress(68);
      return r;
    });
    const loaded = await chatReady;
    if (!isActiveSessionSwitch(switchGen)) return;

    if (!loaded) {
      await workspaceReady.catch(() => {});
      showChatLoadError('对话加载失败，请重试');
      if (!sameSession && prevSessionId && prevSessionId !== target) {
        if (!isActiveSessionSwitch(switchGen)) return;
        currentSessionId = prevSessionId;
        setCurrentSessionId(prevSessionId);
        markHistoryActive(prevSessionId);
        if (!isActiveSessionSwitch(switchGen)) return;
        await applySessionWorkspace(prevSessionId, {
          skipDefaultEditor: true,
          switchGen
        }).catch(() => {});
        if (!isActiveSessionSwitch(switchGen)) return;
        await settleSessionSidePanelAfterSwitch(prevSessionId, switchGen).catch(() => {});
        if (!isActiveSessionSwitch(switchGen)) return;
        await loadChatFromGateway(switchGen, prevSessionId).catch(() => {});
        if (!isActiveSessionSwitch(switchGen)) return;
        syncComposerForActiveSession();
      } else if (typeof messages !== 'undefined') {
        messages.length = 0;
        if (typeof setMessagesOwnerSessionId === 'function') {
          setMessagesOwnerSessionId(target);
        }
        if (typeof renderChatFromMessages === 'function') renderChatFromMessages();
      }
      return;
    }

    syncComposerForActiveSession();
    if (typeof reconcileSessionLiveRunUi === 'function') {
      reconcileSessionLiveRunUi(target);
    }
    if (typeof cleanupStaleSessionRun === 'function') cleanupStaleSessionRun(target);

    const pendingWt =
      typeof window.getPendingWorktreeApply === 'function' ? window.getPendingWorktreeApply() : null;
    if (pendingWt?.sessionId === target && pendingWt.runId) {
      // 归纳的 pending 上下文在 Main（与窗口/会话无关），切回来只需要把侧栏拉起来
      if (typeof openSidePanel === 'function') openSidePanel({ tab: 'changes' });
      if (typeof setSidePanelTab === 'function') setSidePanelTab('changes');
      if (typeof renderChangesPane === 'function') renderChangesPane();
    }
    if (progressOwned && typeof setComposerPrepProgress === 'function') {
      setComposerPrepProgress(90);
    }
    // 正文已画出；工作区绑完前保持切换中，避免对上一会话 SSH/cwd 发工具。
    let wsInfo = null;
    try {
      wsInfo = await workspaceReady;
    } catch (e) {
      console.warn('切换后工作区绑定失败:', e);
    }
    if (!isActiveSessionSwitch(switchGen)) return;
    await settleSessionSidePanelAfterSwitch(target, switchGen, {
      sameWorkspace: !!(wsInfo && wsInfo.sameWorkspace)
    }).catch((e) => {
      console.warn('切换后侧栏刷新失败:', e);
    });
    if (!isActiveSessionSwitch(switchGen)) return;
    focusChatInput();
  } catch (err) {
    console.warn('切换会话失败:', err);
    if (isActiveSessionSwitch(switchGen)) {
      showChatLoadError('对话加载失败，请重试');
      if (typeof showAgentToast === 'function') {
        showAgentToast('切换对话失败', err.message || String(err), { variant: 'error' });
      }
    }
  } finally {
    if (!isActiveSessionSwitch(switchGen)) {
      // 被更新的切换抢占：进度条由新切换接管，勿 finish 以免闪断
      return;
    }
    if (isChatLoadingPlaceholder()) {
      try {
        if (messages.length) {
          if (typeof renderChatFromMessagesYielding === 'function') {
            await renderChatFromMessagesYielding({
              forceScroll: false,
              sessionId: target,
              switchGen
            });
          } else {
            renderChatFromMessages({ forceScroll: false, sessionId: target });
          }
        } else {
          showChatLoadError('该对话暂无消息');
        }
      } catch (e) {
        console.warn(e);
        showChatLoadError('对话渲染失败，请重试');
      }
    }
    if (progressOwned && typeof setComposerPrepProgress === 'function') {
      setComposerPrepProgress(100);
    }
    if (progressOwned && typeof finishComposerPrepProgress === 'function') {
      finishComposerPrepProgress();
    }
    setTimeout(() => refreshHistoryList().catch(() => {}), 0);
  }
}

/** 工作区绑定完成后再刷侧栏，避免文件列表用上一会话路径渲染 */
async function settleSessionSidePanelAfterSwitch(sessionId, switchGen, opts = {}) {
  if (typeof isSidePanelOpen !== 'function' || !isSidePanelOpen()) return;
  if (
    switchGen != null &&
    typeof isActiveSessionSwitch === 'function' &&
    !isActiveSessionSwitch(switchGen)
  ) {
    return;
  }
  if (sessionId && String(currentSessionId || '') !== String(sessionId)) return;

  const tab =
    typeof getSidePanelTab === 'function'
      ? getSidePanelTab()
      : typeof window.getSidePanelTab === 'function'
        ? window.getSidePanelTab()
        : 'files';
  if (tab === 'files') {
    const cacheReady =
      typeof isWorkspaceArtifactsCacheReady === 'function' && isWorkspaceArtifactsCacheReady();
    if (opts.sameWorkspace && cacheReady) {
      if (typeof renderArtifactsList === 'function') {
        renderArtifactsList({ skipRefresh: true, force: true });
      }
      return;
    }
    let expected =
      typeof window !== 'undefined' && window.activeViewSessionWorkspacePath
        ? window.activeViewSessionWorkspacePath
        : null;
    if (!expected && typeof resolveSessionWorkspacePath === 'function') {
      try {
        expected = await resolveSessionWorkspacePath(sessionId);
      } catch {
        expected = null;
      }
    }
    if (
      switchGen != null &&
      typeof isActiveSessionSwitch === 'function' &&
      !isActiveSessionSwitch(switchGen)
    ) {
      return;
    }
    if (sessionId && String(currentSessionId || '') !== String(sessionId)) return;

    if (typeof refreshArtifactsDirectory === 'function') {
      await refreshArtifactsDirectory(true, {
        expectedRoot: expected || undefined,
        sessionId
      }).catch(() => {});
    }
    if (
      switchGen != null &&
      typeof isActiveSessionSwitch === 'function' &&
      !isActiveSessionSwitch(switchGen)
    ) {
      return;
    }
    if (sessionId && String(currentSessionId || '') !== String(sessionId)) return;
    if (typeof renderArtifactsList === 'function') {
      // force：禁止 live-write 补丁短路，必须按新工作区整表重绘
      renderArtifactsList({ skipRefresh: true, force: true });
    }
    return;
  }
  if (tab === 'changes') {
    if (typeof renderChangesPane === 'function') renderChangesPane();
    return;
  }
  // 产物区按会话隔离：切会话后 sessionArtifacts 已换成新会话的桶，必须整表重绘
  if (tab === 'artifacts') {
    if (typeof renderProductsPanel === 'function') renderProductsPanel({ force: true });
    return;
  }
  // 代码片段索引与结构索引合并在同一个「索引」页签里
  if (tab === 'index' && typeof onIndexPanelShown === 'function') {
    onIndexPanelShown();
    return;
  }
  // 与 setSidePanelTab 同源：压缩统计是「按会话」口径，切会话后必须重拉（onContextPanelShown
  // 内含 force 加载），否则新会话的面板上还挂着上一个会话的压缩次数。
  if (tab === 'context' && typeof onContextPanelShown === 'function') {
    onContextPanelShown();
    return;
  }
  if (tab === 'terminal' && typeof ensureTerminalSession === 'function') {
    void ensureTerminalSession(false, sessionId);
  }
}

/**
 * 新建对话（「新对话」按钮与 session_new 工具共用的唯一流程）。
 * @param {string|undefined|null} workspacePath undefined = 继承当前工作空间；null/'' = 不挂工作空间
 * @param {{ title?: string }} [opts]
 */
/** 新建会话；**返回新会话 id，失败返回 null**（交接接手要靠它判断该不该把交接放回去） */
async function createNewSession(workspacePath, opts = {}) {
  if (!gwState.authed) return null;
  sessionCreateInFlight = true;
  try {
    // 与 switchSession 共用代际，避免与进行中的历史切换交错
    bumpSessionSwitchGeneration();
    pendingSwitchTarget = null;
    pendingSwitchGen = null;
    if (currentSessionId) captureSessionScrollPosition(currentSessionId, { force: true });
    if (currentSessionId && messages.length && typeof messagesBelongToSession === 'function' &&
      messagesBelongToSession(currentSessionId)) {
      rememberSessionWindowOnLeave(currentSessionId);
    }
    if (typeof cancelArtifactContentLoads === 'function') cancelArtifactContentLoads();
    let inheritWs = '';
    if (workspacePath === undefined) {
      inheritWs =
        (typeof window !== 'undefined' && window.activeViewSessionWorkspacePath
          ? String(window.activeViewSessionWorkspacePath).trim()
          : '') ||
        (typeof resolveSessionWorkspacePathSync === 'function' && currentSessionId
          ? String(resolveSessionWorkspacePathSync(currentSessionId) || '').trim()
          : '');
    } else {
      inheritWs = String(workspacePath || '').trim();
    }
    const keepWorkspace = !!inheritWs;
    const prevWs =
      typeof window !== 'undefined' && window.activeViewSessionWorkspacePath
        ? String(window.activeViewSessionWorkspacePath).trim()
        : '';
    const sameWorkspace = keepWorkspace && inheritWs === prevWs;
    if (!sameWorkspace && typeof teardownArtifactsMonacoEditor === 'function') {
      await teardownArtifactsMonacoEditor();
    }
    if (!keepWorkspace) {
      // 只清目标，不断 SSH：工作区由「会话绑定 + 路径 kind」路由（getEffectiveWorkspaceTarget /
      // getRemoteFs），清掉视图与全局目标后无绑定会话本来就落到默认本地工作区。
      // 断开是按端点拆的（停远端 daemon、清端口转发、invalidate 客户端），等于替同主机上
      // 别的会话一起杀连接，也与 switchSession「SSH 不随会话切换拆除」的约定相矛盾。
      if (
        historyApi.setWorkspace &&
        (typeof anyActiveRunUsesRemote !== 'function' || !anyActiveRunUsesRemote())
      ) {
        await historyApi.setWorkspace(null);
        updateWorkspaceLabel({ workspacePath: null });
        invalidateWorkspaceArtifacts();
      } else {
        // 视图路径 / kind 由 updateWorkspaceLabel 一并清（它同时落「视图属于哪个会话」）
        updateWorkspaceLabel({ workspacePath: null });
        invalidateWorkspaceArtifacts();
      }
    }
    // 派生出的新对话沿用来源会话的模型选择（交接 / 新对话默认就是「同一个模型」），
    // 不让它悄悄回到全局上次选择。模型选择的唯一来源仍是 composer 的 per-session pick。
    const inheritModelFrom = String(
      (typeof currentSessionId !== 'undefined' && currentSessionId) || ''
    ).trim();
    const inheritModelPick =
      inheritModelFrom && typeof loadComposerModelPickForSession === 'function'
        ? loadComposerModelPickForSession(inheritModelFrom)
        : null;
    const s = await gatewayCall('memory.session_create', {
      workspacePath: keepWorkspace ? inheritWs : null,
      title: opts && opts.title ? String(opts.title) : undefined
    });
    currentSessionId = s.id;
    setCurrentSessionId(s.id);
    if (inheritModelPick && typeof saveComposerModelPick === 'function') {
      saveComposerModelPick(inheritModelPick, s.id);
    }
    messages.length = 0;
    if (typeof setMessagesOwnerSessionId === 'function') {
      setMessagesOwnerSessionId(s.id);
    }
    if (typeof renderChatFromMessages === 'function') {
      renderChatFromMessages();
    }
    if (typeof activateSessionViewState === 'function') {
      activateSessionViewState(null, s.id);
    }
    if (typeof onComposerSessionActivated === 'function') onComposerSessionActivated(s.id);
    if (typeof applySessionWorkspace === 'function') {
      await applySessionWorkspace(s.id, {
        skipDefaultEditor: true,
        knownWorkspacePath: keepWorkspace ? inheritWs : null
      });
    }
    renderAttachmentChips();
    void refreshHistoryList();
    if (typeof syncComposerForActiveSession === 'function') syncComposerForActiveSession();
    focusChatInput();
    return s.id;
  } catch (err) {
    console.warn(err);
    return null;
  } finally {
    sessionCreateInFlight = false;
  }
}

/**
 * 这次加载用「回源」还是「沿用缓存」——**唯一判据**（`loadChatFromGateway` 只照它执行）。
 *
 * 为什么需要 `cache-diverged` 这个中间态：跑动中不能用库里的行（库里没有刚推入的
 * 这一步 user 行、也没有流式正文），所以调用方即使显式要求回源也只能先沿用缓存；
 * 但那一瞬间库里**已经有**了对端来信 / 回复（`renderer-peer.js` 的 forced reload 就是为它来的）。
 * 直接丢掉这个信号 = 「库里有、视图里没有」一直粘到下次切会话：
 * 典型的现场是「我明明发了一句话，它却从对话里消失了」（2026-11-13）。
 * 所以这里只记录「本轮结束后必须补一次真回源」（`isSessionCacheDiverged`）。
 *
 * @param {{ forceRefresh?: boolean, activeRun?: boolean, cacheStale?: boolean, cached?: boolean, diverged?: boolean }} input
 * @returns {'fresh'|'cache'|'cache-diverged'}
 */
function resolveChatLoadMode(input) {
  const i = input || {};
  // 已经记过「上一轮欠一次回源」：这次必须真读库
  if (i.cacheStale || i.diverged) return 'fresh';
  if (!i.cached) return 'fresh';
  if (i.activeRun) return i.forceRefresh ? 'cache-diverged' : 'cache';
  return 'cache';
}

/** @returns {Promise<boolean>} */
async function loadChatFromGateway(switchGen, targetSessionId, opts = {}) {
  if (!gwState.authed) return false;
  const sessionId = String(targetSessionId || currentSessionId);
  const guarded = switchGen != null;
  const forceRefresh = !!(opts && opts.forceRefresh);
  const live = sessionActiveRuns.get(sessionId);
  const activeRun = !!(live && !live.finished);
  const cacheStale =
    typeof isSessionMessageCacheStale === 'function' && isSessionMessageCacheStale(sessionId);
  const diverged =
    typeof isSessionCacheDiverged === 'function' && isSessionCacheDiverged(sessionId);
  let cached = getSessionMessageCache(sessionId);
  const mode = resolveChatLoadMode({ forceRefresh, activeRun, cacheStale, cached: !!cached, diverged });
  if (mode === 'cache-diverged' && typeof markSessionCacheDiverged === 'function') {
    markSessionCacheDiverged(sessionId);
  }
  if (mode === 'fresh') cached = null;
  try {
    if (mode !== 'fresh' && cached) {
      if (guarded && !isActiveSessionSwitch(switchGen)) return false;
      if (sessionId !== currentSessionId) return false;
      messages.length = 0;
      messages.push(...cached.messages);
      if (typeof setMessagesOwnerSessionId === 'function') {
        setMessagesOwnerSessionId(sessionId);
      }
      return renderLoadedSessionMessages(switchGen, sessionId, guarded);
    }

    const tailPage = await gatewayCallHistoryWithTimeout('memory.messages_recent', {
      sessionId,
      limit: CHAT_INITIAL_LOAD_LIMIT
    });
    if (guarded && !isActiveSessionSwitch(switchGen)) return false;
    if (sessionId !== currentSessionId) return false;

    // 首屏也照样只露最近一段，但那段必须从某一轮的开头开始：头落在轮中间就往前补到用户消息。
    // 补的那几次按「上翻一页」的宽度取（不是首屏的 32），否则对齐一轮长对话要来回问十几次。
    if (tailPage != null && !Array.isArray(tailPage)) {
      // 非空又不是数组：契约坏了，按加载失败处理（别静默当空对话）
      throw new Error('memory.messages_recent 返回了非数组');
    }
    const tailRows = Array.isArray(tailPage) ? tailPage : [];
    const aligned = await alignRowsToTurnStart(sessionId, tailRows, {
      fetchSize: CHAT_TURN_ALIGN_FETCH,
      exhausted: tailRows.length < CHAT_INITIAL_LOAD_LIMIT
    });
    if (guarded && !isActiveSessionSwitch(switchGen)) return false;
    if (sessionId !== currentSessionId) return false;
    if (aligned.exhausted) chatOlderExhaustedSessions.add(sessionId);
    else chatOlderExhaustedSessions.delete(sessionId);

    messages.length = 0;
    messages.push(...gatewayRowsToMessages(aligned.rows));
    if (typeof setMessagesOwnerSessionId === 'function') {
      setMessagesOwnerSessionId(sessionId);
    }
    const hasMore = !aligned.exhausted;
    saveSessionMessageCache(sessionId, messages, { hasMore });
    if (typeof clearSessionMessageCacheStale === 'function') {
      clearSessionMessageCacheStale(sessionId);
    }
    // 这一次真的读了库：欠的那次回源已经还上
    if (typeof clearSessionCacheDiverged === 'function') {
      clearSessionCacheDiverged(sessionId);
    }
    // 整段重读了：上一次「加载更早」的失败已经过时，别让顶部一直挂着「重新加载」
    chatOlderLoadErrors.delete(sessionId);

    return renderLoadedSessionMessages(switchGen, sessionId, guarded);
  } catch (err) {
    console.warn('加载对话失败:', err);
    return false;
  }
}

function initChatHistoryUI() {
  const list = $('history-list');
  if (list) {
    list.addEventListener('click', (e) => {
      const folderRemove = e.target.closest?.('.history-folder-remove');
      if (folderRemove) {
        e.preventDefault();
        e.stopPropagation();
        const group = folderRemove.closest('.history-folder-group');
        if (group) void removeHistoryFolder(group);
        return;
      }
      const folderNew = e.target.closest?.('.history-folder-new');
      if (folderNew) {
        e.preventDefault();
        e.stopPropagation();
        const group = folderNew.closest('.history-folder-group');
        const path = group && group.dataset.workspacePath != null ? group.dataset.workspacePath : '';
        void createNewSession(path);
        return;
      }
      const folderBtn = e.target.closest?.('.history-folder-toggle');
      if (folderBtn) {
        e.preventDefault();
        e.stopPropagation();
        const group = folderBtn.closest('.history-folder-group');
        if (!group || group.dataset.workspaceKey == null) return;
        toggleHistoryFolder(decodeURIComponent(group.dataset.workspaceKey));
        return;
      }
      const act = e.target.closest?.('.history-act');
      if (act) {
        e.preventDefault();
        e.stopPropagation();
        const row = act.closest('.history-row');
        const sid = row?.dataset?.sessionId;
        if (!sid) return;
        if (act.classList.contains('history-act-danger')) {
          void deleteSession(sid);
        } else if (act.classList.contains('history-act-handoff')) {
          void generateHandoffForSession(sid, act);
        } else {
          void archiveSession(sid, true);
        }
        return;
      }
      const main = e.target.closest?.('.history-item-main');
      if (!main) return;
      const row = main.closest('.history-row');
      const sid = row?.dataset?.sessionId;
      if (sid) switchSession(sid);
    });
  }

  const newChatWrap = $('history-new-wrap');
  const chatNewBtn = $('chat-new');
  const newChatMenu = $('history-new-menu');
  if (chatNewBtn) {
    // 顶部「+」同时承担「新对话」与「继续上次交接」：有交接才弹菜单，没有就直接新建。
    // 「新对话」的「永不绑定工作空间」规则只在 startUnboundNewChat() 一处实现。
    chatNewBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (newChatMenuState.open) {
        setNewChatMenuOpen(false);
        return;
      }
      void openNewChatMenu();
    });
  }
  if (newChatMenu) {
    newChatMenu.addEventListener('click', (e) => {
      const item = e.target.closest?.('[data-history-new]');
      if (!item) return;
      const action = item.getAttribute('data-history-new');
      const latest = newChatMenuHandoff;
      setNewChatMenuOpen(false);
      if (action === 'continue' && latest) void continueFromHandoff(latest);
      else void startUnboundNewChat();
    });
    document.addEventListener('click', (e) => {
      if (!newChatMenuState.open) return;
      if (newChatWrap && !newChatWrap.contains(e.target)) setNewChatMenuOpen(false);
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && newChatMenuState.open) setNewChatMenuOpen(false);
    });
  }

  // 会话标题由 Main 在轮末异步总结（agent/session-title.js）。生成完只做一件事：
  // 刷一次列表 —— 标题存在 sessions.title 里，刷新即可见，不需要 Renderer 记状态。
  if (typeof historyApi.onAgentSessionTitle === 'function') {
    historyApi.onAgentSessionTitle(() => {
      void refreshHistoryList({ softFail: true });
    });
  }

  // 外部频道（企业微信等）在 Main 里后台跑完一轮：会话写进的是同一份账本，
  // 标题与工作空间分组都能从 sessions 行推导，所以这里也只做一件事 —— 刷列表。
  // 在**正开着那条会话**时还要把消息也补上（见 refreshSessionAfterBackgroundTurn）。
  if (typeof historyApi.onChannelsSessionsChanged === 'function') {
    historyApi.onChannelsSessionsChanged((payload) => {
      void refreshSessionAfterBackgroundTurn(payload && payload.sessionId);
    });
  }
}

window.switchSession = switchSession;
window.setPendingSessionHandoff = setPendingSessionHandoff;
window.consumePendingSessionHandoff = consumePendingSessionHandoff;
window.peekPendingSessionHandoff = peekPendingSessionHandoff;
window.continueFromLastSession = continueFromLastSession;
window.refreshSessionAfterBackgroundTurn = refreshSessionAfterBackgroundTurn;
window.loadChatFromGateway = loadChatFromGateway;
window.healActiveSessionFromHistory = healActiveSessionFromHistory;
window.showChatLoadError = showChatLoadError;
window.maybeLoadOlderChatMessages = maybeLoadOlderChatMessages;
window.renderChatHistoryEdge = renderChatHistoryEdge;
window.retryOlderChatMessages = retryOlderChatMessages;
