/* global window, document, $, escapeHtml, gwState, gatewayCall, resetCompactionStateSafe, applySessionWorkspace, updateWorkspaceLabel, invalidateWorkspaceArtifacts, renderAttachmentChips, revokeAttachmentPreview, pendingAttachments, handleWorktreeApplyAfterRun, syncComposerForActiveSession, onComposerSessionActivated, invalidateComposerQueueSession, renderChatFromMessages, renderChatFromMessagesYielding, focusChatInput, loadChatFromGateway, refreshHistoryList, disconnectSshIfConnected, ensureLocalGatewayReady, clearAgentContinueState, restoreKnowledgeMaintenanceContext, cancelBackgroundKnowledgeFallback, saveComposerAgentMode, bumpSessionSwitchGeneration, isActiveSessionSwitch, cleanupStaleSessionRun, syncBrowserBounds, showAgentToast, sessionSwitchGeneration, captureSessionScrollPosition, withSessionScrollCaptureSuppressed, recoverInterruptedAssistantTurn, tryDetectResumeCheckpoint, anyActiveRunUsesRemote, unpackUserMessageContent, dismissToolActivityFloat, reconcileSessionLiveRunUi, saveSessionMessageCache, getSessionMessageCache, applyMessagesFromCache, gatewayRowsToMessages, invalidateSessionMessageCache, isSessionMessageCacheStale, clearSessionMessageCacheStale, getSessionCacheHasMore, setSessionCacheHasMore, CHAT_INITIAL_LOAD_LIMIT, CHAT_LOAD_MORE_LIMIT, teardownArtifactsMonacoEditor, cancelArtifactContentLoads, activateLiveWriteForView, sessionActiveRuns, currentSessionId, messages, setMessagesOwnerSessionId, messagesBelongToSession, beginComposerPrepProgress, setComposerPrepProgress, finishComposerPrepProgress, activateSessionViewState, switchSessionArtifacts, isSidePanelOpen, getSidePanelTab, refreshArtifactsDirectory, renderArtifactsList, renderChangesPane, openSidePanel, setSidePanelTab, isWorkspaceArtifactsCacheReady, flatFolderIconSvg, t, resolveSessionWorkspacePathSync, rememberSessionWorkspacePath, hasSessionWorkspacePathCache */
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

const SESSIONS_LIST_RETRY_ATTEMPTS = 3;
const SESSIONS_LIST_RETRY_DELAY_MS = 1500;
const SESSIONS_LIST_STALE_RETRY_MS = 12000;

let historyListRefreshInflight = null;
/** @type {ReturnType<typeof setTimeout> | null} */
let historyListStaleRetryTimer = null;

function historyListHasRows() {
  const list = $('history-list');
  return !!list?.querySelector('.history-row');
}

function clearHistoryListStaleRetry() {
  if (historyListStaleRetryTimer) {
    clearTimeout(historyListStaleRetryTimer);
    historyListStaleRetryTimer = null;
  }
}

function scheduleHistoryListStaleRetry() {
  if (historyListStaleRetryTimer) return;
  historyListStaleRetryTimer = setTimeout(() => {
    historyListStaleRetryTimer = null;
    void refreshHistoryList({ softFail: true });
  }, SESSIONS_LIST_STALE_RETRY_MS);
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

async function fetchSessionsListWithRetry(params = {}) {
  const listParams = {
    limit: 50,
    archived: false,
    ...params
  };
  let lastErr = null;
  for (let attempt = 1; attempt <= SESSIONS_LIST_RETRY_ATTEMPTS; attempt += 1) {
    try {
      return await gatewayCall('memory.sessions_list', listParams);
    } catch (err) {
      lastErr = err;
      if (attempt < SESSIONS_LIST_RETRY_ATTEMPTS) {
        await delay(SESSIONS_LIST_RETRY_DELAY_MS * attempt);
      }
    }
  }
  throw lastErr || new Error('memory.sessions_list 失败');
}

/**
 * 启动自愈：localStorage 的 session 若已删/为 legacy `default`，切到历史里最近一条。
 * @returns {Promise<string>} 校正后的 currentSessionId
 */
async function healActiveSessionFromHistory() {
  if (!gwState || !gwState.authed) return String(currentSessionId || '');
  let sessions = [];
  try {
    sessions = (await fetchSessionsListWithRetry({ archived: false })) || [];
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
    const path = String((s && s.workspacePath) || '').trim();
    const key = historyWorkspaceKey(path);
    let g = index.get(key);
    if (!g) {
      g = { key, path, sessions: [] };
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

/** 就地更新一行历史（复用节点，不重建 DOM）。 */
function updateHistorySessionRow(row, s) {
  const sid = String(s.id);
  const active = sid === String(currentSessionId || '');
  const live = sessionActiveRuns.get(s.id);
  const thinking = !!(live && !live.finished);
  const isBackgroundRun = thinking && !active;

  row.className = `history-row${active ? ' active' : ''}${thinking ? ' thinking' : ''}${isBackgroundRun ? ' background-run' : ''}`;
  row.dataset.sessionId = sid;
  const rowWs = s && s.workspacePath != null ? String(s.workspacePath) : '';
  row.dataset.workspacePath = rowWs;
  if (typeof rememberSessionWorkspacePath === 'function') {
    rememberSessionWorkspacePath(s.id, rowWs);
  }

  const titleEl = row.querySelector('.history-item-title');
  if (titleEl) {
    const next = sessionListTitle(s);
    if (titleEl.textContent !== next) titleEl.textContent = next;
  }
  const metaEl = row.querySelector('.history-item-meta');
  if (metaEl) {
    const next = formatHistoryTime(s.updatedAt);
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
  const title = document.createElement('span');
  title.className = 'history-item-title';
  const meta = document.createElement('span');
  meta.className = 'history-item-meta';
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

  const btn = wrap.querySelector('.history-folder-toggle');
  if (btn) {
    btn.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    btn.title =
      group.path || (typeof t === 'function' ? t('history_folder_unbound') : '未绑定工作区');
    const icon = btn.querySelector('.history-folder-icon');
    if (icon) {
      const svg = typeof flatFolderIconSvg === 'function' ? flatFolderIconSvg(14) : '';
      if (historyFolderIconCache.get(icon) !== svg) {
        icon.innerHTML = svg;
        historyFolderIconCache.set(icon, svg);
      }
    }
    const name = btn.querySelector('.history-folder-name');
    if (name) {
      const label = historyWorkspaceLabel(group.path);
      if (name.textContent !== label) name.textContent = label;
    }
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
    const newTitle =
      typeof t === 'function' ? t('new_chat_in_folder') : '在此工作空间新建对话';
    if (newBtn.title !== newTitle) newBtn.title = newTitle;
    if (newBtn.getAttribute('aria-label') !== newTitle) {
      newBtn.setAttribute('aria-label', newTitle);
    }
  }
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

    const containsCurrent = group.sessions.some((s) => String(s.id) === currentSid);
    const expanded = isHistoryFolderExpanded(
      group.key,
      folderUi,
      containsCurrent || groups.length === 1
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

  let rendered = false;
  if (typeof renderChatFromMessagesYielding === 'function') {
    rendered = await renderChatFromMessagesYielding({
      switchGen,
      sessionId,
      forceScroll: false,
      transition: guarded,
      deferTrace: true
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

async function maybeLoadOlderChatMessages() {
  if (loadingOlderChatMessages || !chatList || !gwState.authed) return;
  const sessionId = String(currentSessionId || '');
  if (!sessionId || chatList.scrollTop > 96) return;
  if (chatList.scrollHeight <= chatList.clientHeight + 96) return;
  if (!getSessionCacheHasMore(sessionId)) return;
  const oldest = messages[0];
  const beforeId =
    oldest?.id != null
      ? Number(oldest.id)
      : oldest?.localMsgId != null
        ? Number(oldest.localMsgId)
        : NaN;
  if (!Number.isFinite(beforeId)) return;

  loadingOlderChatMessages = true;
  const prevHeight = chatList.scrollHeight;
  const prevTop = chatList.scrollTop;
  try {
    const rows = await gatewayCallHistoryWithTimeout('memory.messages_older', {
      sessionId,
      beforeId,
      limit: CHAT_LOAD_MORE_LIMIT
    });
    if (sessionId !== String(currentSessionId || '')) return;
    if (!rows || !rows.length) {
      setSessionCacheHasMore(sessionId, false);
      return;
    }
    const older = gatewayRowsToMessages(rows);
    if (!older.length) {
      setSessionCacheHasMore(sessionId, false);
      return;
    }
    messages.unshift(...older);
    const hasMore = rows.length >= CHAT_LOAD_MORE_LIMIT;
    setSessionCacheHasMore(sessionId, hasMore);
    saveSessionMessageCache(sessionId, messages, { hasMore });
    if (typeof renderChatFromMessagesYielding === 'function') {
      await renderChatFromMessagesYielding({ forceScroll: false, sessionId });
    } else {
      renderChatFromMessages({ forceScroll: false, sessionId });
    }
    chatList.scrollTop = chatList.scrollHeight - prevHeight + prevTop;
  } catch (e) {
    console.warn('加载更早消息失败:', e);
  } finally {
    loadingOlderChatMessages = false;
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

function extractInputTextFromMetaPrefix(raw) {
  const s = String(raw || '').trim();
  if (!s.startsWith('【叠云meta】')) return '';
  const jsonPart = s.slice('【叠云meta】'.length).split('\n')[0].trim();
  if (!jsonPart.startsWith('{')) return '';
  try {
    const meta = JSON.parse(jsonPart);
    const inputText = meta && meta.inputText != null ? String(meta.inputText).trim() : '';
    return inputText;
  } catch {
    return '';
  }
}

function stripMessageMetaForTitle(raw) {
  const s = String(raw || '').trim();
  const m = s.match(/^【叠云meta】(\{[\s\S]*?\})\n([\s\S]*)$/);
  if (m) {
    const body = String(m[2] || '').trim();
    if (body) return body;
    return extractInputTextFromMetaPrefix(s);
  }
  if (s.startsWith('【叠云meta】')) {
    const fromMeta = extractInputTextFromMetaPrefix(s);
    if (fromMeta) return fromMeta;
    return '';
  }
  return s;
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
    if (/^\[计划 ·.+\]$/.test(line)) continue;
    if (line.includes('定时触发')) continue;
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
    storedRaw && !storedRaw.startsWith('【叠云meta】') && storedRaw !== '新对话' && storedRaw !== '对话'
      ? storedRaw
      : '';
  if (stored) return formatSessionTitleSlice(stored);
  const preview = titleFromPreview(s && s.preview) || stripMessageMetaForTitle(s && s.preview);
  if (!preview) return '对话';
  return formatSessionTitleSlice(preview) || '对话';
}

function formatHistoryTime(ts) {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '';
  const now = Date.now();
  const diff = Math.max(0, now - d.getTime());
  const min = Math.round(diff / 60000);
  if (min < 1) return typeof t === 'function' ? t('history_time_now') : '刚刚';
  if (min < 60) return `${min}m`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h`;
  const day = Math.round(hr / 24);
  if (day < 7) return `${day}d`;
  const today = new Date();
  if (d.getFullYear() === today.getFullYear()) {
    return d.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
  }
  return d.toLocaleDateString('zh-CN', { year: 'numeric', month: 'numeric', day: 'numeric' });
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
      const sessions = await fetchSessionsListWithRetry();
      clearHistoryListStaleRetry();
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
      if (typeof refreshWorkspaceMutateHint === 'function') {
        refreshWorkspaceMutateHint(window.activeViewSessionWorkspacePath, currentSessionId);
      }
    } catch (err) {
      console.warn('历史对话加载失败:', err);
      if (softFail && historyListHasRows()) {
        setHistoryListStaleHint(true);
        scheduleHistoryListStaleRetry();
        return;
      }
      if (!historyListHasRows()) {
        list.innerHTML =
          '<div class="history-empty">后台较忙，正在重试加载…</div>';
        scheduleHistoryListStaleRetry();
      }
    } finally {
      historyListRefreshInflight = null;
    }
  })();

  return historyListRefreshInflight;
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
      const sessions = await fetchSessionsListWithRetry({ limit: 1, archived: false });
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
      const sessions = await fetchSessionsListWithRetry({ limit: 1, archived: false });
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
      // 仅当全局 messages 确属离开的会话时才写入缓存，避免 A→B→C 把 A 的消息毒进 B 的 cache
      if (
        prevSessionId &&
        messages.length &&
        typeof messagesBelongToSession === 'function' &&
        messagesBelongToSession(prevSessionId)
      ) {
        saveSessionMessageCache(prevSessionId, messages, {
          hasMore: getSessionCacheHasMore(prevSessionId)
        });
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
      if (typeof activateLiveWriteForView === 'function') {
        activateLiveWriteForView(target);
      }
      if (typeof onComposerSessionActivated === 'function') onComposerSessionActivated(target);
      // 只清离开会话的压缩状态，勿清目标会话（可能仍在后台跑）
      if (prevSessionId) resetCompactionStateSafe(prevSessionId);
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
      if (typeof cancelBackgroundKnowledgeFallback === 'function') {
        cancelBackgroundKnowledgeFallback(target);
      }
      if (pendingWt.knowledgeBase && typeof restoreKnowledgeMaintenanceContext === 'function') {
        restoreKnowledgeMaintenanceContext(pendingWt.knowledgeBase);
      }
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
              switchGen,
              deferTrace: true
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
  if (tab === 'wiki' && typeof onWikiPanelShown === 'function') {
    onWikiPanelShown();
    return;
  }
  if (tab === 'codebase' && typeof onCodebasePanelShown === 'function') {
    onCodebasePanelShown();
    return;
  }
  if (tab === 'graph' && typeof onGraphPanelShown === 'function') {
    onGraphPanelShown();
    return;
  }
  if (tab === 'context' && typeof refreshContextProgress === 'function') {
    refreshContextProgress();
    return;
  }
  if (tab === 'terminal' && typeof ensureTerminalSession === 'function') {
    void ensureTerminalSession(false, sessionId);
  }
}

async function createNewSession(workspacePath) {
  if (!gwState.authed) return;
  sessionCreateInFlight = true;
  try {
    // 与 switchSession 共用代际，避免与进行中的历史切换交错
    bumpSessionSwitchGeneration();
    pendingSwitchTarget = null;
    pendingSwitchGen = null;
    if (currentSessionId) captureSessionScrollPosition(currentSessionId, { force: true });
    if (
      currentSessionId &&
      messages.length &&
      typeof messagesBelongToSession === 'function' &&
      messagesBelongToSession(currentSessionId)
    ) {
      saveSessionMessageCache(currentSessionId, messages, {
        hasMore: getSessionCacheHasMore(currentSessionId)
      });
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
      if (typeof anyActiveRunUsesRemote !== 'function' || !anyActiveRunUsesRemote()) {
        await disconnectSshIfConnected();
      }
      if (
        historyApi.setWorkspace &&
        (typeof anyActiveRunUsesRemote !== 'function' || !anyActiveRunUsesRemote())
      ) {
        await historyApi.setWorkspace(null);
        updateWorkspaceLabel({ workspacePath: null });
        invalidateWorkspaceArtifacts();
      } else {
        if (typeof window !== 'undefined') window.activeViewSessionWorkspacePath = null;
        if (typeof window !== 'undefined') window.activeViewSessionWorkspaceKind = null;
        updateWorkspaceLabel({ workspacePath: null });
        invalidateWorkspaceArtifacts();
      }
    }
    const s = await gatewayCall('memory.session_create', {
      workspacePath: keepWorkspace ? inheritWs : null
    });
    currentSessionId = s.id;
    setCurrentSessionId(s.id);
    if (typeof activateLiveWriteForView === 'function') {
      activateLiveWriteForView(s.id);
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
    if (typeof saveComposerAgentMode === 'function') {
      saveComposerAgentMode('agent', s.id);
    }
    resetCompactionStateSafe();
    renderAttachmentChips();
    void refreshHistoryList();
    if (typeof syncComposerForActiveSession === 'function') syncComposerForActiveSession();
    focusChatInput();
  } catch (err) {
    console.warn(err);
  } finally {
    sessionCreateInFlight = false;
  }
}

/** @returns {Promise<boolean>} */
async function loadChatFromGateway(switchGen, targetSessionId, opts = {}) {
  if (!gwState.authed) return false;
  const sessionId = String(targetSessionId || currentSessionId);
  const guarded = switchGen != null;
  let forceRefresh = !!(opts && opts.forceRefresh);
  const live = sessionActiveRuns.get(sessionId);
  const activeRun = !!(live && !live.finished);
  const cacheStale =
    typeof isSessionMessageCacheStale === 'function' && isSessionMessageCacheStale(sessionId);
  let cached = getSessionMessageCache(sessionId);
  if (cacheStale) {
    forceRefresh = true;
  } else if (activeRun && cached) {
    // Keep locally saved turn (user msg) while run continues; live bubble reconciled after render.
    forceRefresh = false;
  } else if (activeRun && !cached) {
    forceRefresh = true;
  }
  if (forceRefresh) cached = null;
  try {
    if (!forceRefresh && cached) {
      if (guarded && !isActiveSessionSwitch(switchGen)) return false;
      if (sessionId !== currentSessionId) return false;
      messages.length = 0;
      messages.push(...cached.messages);
      if (typeof setMessagesOwnerSessionId === 'function') {
        setMessagesOwnerSessionId(sessionId);
      }
      return renderLoadedSessionMessages(switchGen, sessionId, guarded);
    }

    const rows = await gatewayCallHistoryWithTimeout('memory.messages_recent', {
      sessionId,
      limit: CHAT_INITIAL_LOAD_LIMIT
    });
    if (guarded && !isActiveSessionSwitch(switchGen)) return false;
    if (sessionId !== currentSessionId) return false;

    messages.length = 0;
    messages.push(...gatewayRowsToMessages(rows));
    if (typeof setMessagesOwnerSessionId === 'function') {
      setMessagesOwnerSessionId(sessionId);
    }
    const hasMore = rows.length >= CHAT_INITIAL_LOAD_LIMIT;
    saveSessionMessageCache(sessionId, messages, { hasMore });
    if (typeof clearSessionMessageCacheStale === 'function') {
      clearSessionMessageCacheStale(sessionId);
    }

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

  const chatNewBtn = $('chat-new');
  if (chatNewBtn) {
    // 顶部「新对话」默认不绑定工作空间；文件夹入口的 + 才显式传入 path
    chatNewBtn.addEventListener('click', () => createNewSession(null));
  }
}

window.switchSession = switchSession;
window.loadChatFromGateway = loadChatFromGateway;
window.healActiveSessionFromHistory = healActiveSessionFromHistory;
window.showChatLoadError = showChatLoadError;
window.maybeLoadOlderChatMessages = maybeLoadOlderChatMessages;
