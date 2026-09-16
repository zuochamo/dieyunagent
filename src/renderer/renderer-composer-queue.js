/* global document, $, currentSessionId, isSessionSending, isCurrentSessionSending, sendMessage, cloneAttachmentSnapshot, renderAttachmentChips, chatInput, showAgentToast, getAgentContinueState, resumeAgentToolLoop, messages, messagesOwnerSessionId, ensureChatScrollAfterLayout, shouldAutoFlushComposerQueue, getPendingAttachments, focusChatInput, refreshContextProgress, activateComposerAgentModeForSession, activateComposerModelForSession, isSessionSwitchInFlight, stopAgentRun, holdComposerQueueFlush, releaseComposerQueueFlush */
'use strict';

/**
 * @typedef {{
 *   id: string,
 *   text: string,
 *   attachments: object[],
 *   enqueuedAt: number,
 *   updatedAt: number,
 *   rev: number
 * }} ComposerQueueItem
 */

/** @type {Map<string, ComposerQueueItem[]>} */
const composerQueues = new Map();
let flushingComposerQueue = false;
let composerQueueSendNowBusy = false;
/** 立即发送打断当前轮时，abort 收尾不要把队列打成暂停 */
const composerQueueSkipPause = new Set();
const COMPOSER_QUEUE_STORAGE_KEY = 'dieyun.composer-queue.v1';
const COMPOSER_QUEUE_PAUSE_STORAGE_KEY = 'dieyun.composer-queue-pause.v1';
const EMPTY_QUEUE_TEXT = '请根据附件内容协助我。';
const COMPOSER_QUEUE_IDLE_WAIT_MS = 30000;

/** @type {Map<string, { reason: string, at: number }>} */
const composerQueuePauses = new Map();

/**
 * @type {null | {
 *   sessionId: string,
 *   id: string,
 *   rev: number,
 *   composerDraftBefore: { text: string, attachments: object[] }
 * }}
 */
let composerQueueEditing = null;

function sidOf(sessionId) {
  return String(sessionId || currentSessionId || '');
}

function activeSid() {
  return String(currentSessionId || '');
}

function newComposerQueueItemId() {
  return `cq-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function cloneQueueAttachments(list) {
  return typeof cloneAttachmentSnapshot === 'function'
    ? cloneAttachmentSnapshot(list || [])
    : (list || []).slice();
}

function toast(title, detail, opts) {
  if (typeof showAgentToast === 'function') showAgentToast(title, detail || '', opts || {});
}

function bumpItem(item) {
  item.updatedAt = Date.now();
  item.rev = (Number(item.rev) || 0) + 1;
}

/** @param {object} raw @returns {ComposerQueueItem} */
function normalizeComposerQueueItem(raw) {
  const now = Date.now();
  const enqueuedAt = Number(raw && raw.enqueuedAt) || now;
  return {
    id:
      raw && raw.id != null && String(raw.id).trim()
        ? String(raw.id).trim()
        : newComposerQueueItemId(),
    text: String((raw && raw.text) || '').trim() || EMPTY_QUEUE_TEXT,
    attachments: cloneQueueAttachments(raw && raw.attachments),
    enqueuedAt,
    updatedAt: Number(raw && raw.updatedAt) || enqueuedAt,
    rev: Math.max(0, Number(raw && raw.rev) || 0)
  };
}

function normalizeComposerQueueList(items) {
  return Array.isArray(items) ? items.map((item) => normalizeComposerQueueItem(item || {})) : [];
}

function readComposerQueuesFromStorage() {
  if (typeof window === 'undefined' || !window.localStorage) return {};
  try {
    const raw = JSON.parse(window.localStorage.getItem(COMPOSER_QUEUE_STORAGE_KEY) || '{}');
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
}

function persistComposerQueuePauses() {
  if (typeof window === 'undefined' || !window.localStorage) return;
  const obj = {};
  for (const [sid, pause] of composerQueuePauses.entries()) {
    if (pause) obj[sid] = pause;
  }
  try {
    window.localStorage.setItem(COMPOSER_QUEUE_PAUSE_STORAGE_KEY, JSON.stringify(obj));
  } catch {
    /* quota / private mode */
  }
}

function hydrateComposerQueuePausesFromStorage() {
  if (typeof window === 'undefined' || !window.localStorage) return;
  try {
    const raw = JSON.parse(window.localStorage.getItem(COMPOSER_QUEUE_PAUSE_STORAGE_KEY) || '{}');
    if (!raw || typeof raw !== 'object') return;
    for (const [sid, pause] of Object.entries(raw)) {
      const items = composerQueues.get(String(sid));
      if (!sid || !items || !items.length) continue;
      composerQueuePauses.set(String(sid), {
        reason: String((pause && pause.reason) || 'user_stop'),
        at: Number(pause && pause.at) || Date.now()
      });
    }
  } catch {
    /* ignore */
  }
}

function isComposerQueuePaused(sessionId) {
  return composerQueuePauses.has(sidOf(sessionId));
}

function clearComposerQueuePause(sessionId) {
  const sid = sidOf(sessionId);
  if (!composerQueuePauses.has(sid)) return false;
  composerQueuePauses.delete(sid);
  persistComposerQueuePauses();
  if (sid === activeSid()) updateComposerQueueUi();
  return true;
}

function pauseComposerQueueAfterUserStop(sessionId) {
  const sid = sidOf(sessionId);
  if (composerQueueSkipPause.has(sid)) return false;
  if (!getComposerQueue(sid).length) return false;
  composerQueuePauses.set(sid, { reason: 'user_stop', at: Date.now() });
  persistComposerQueuePauses();
  if (sid === activeSid()) updateComposerQueueUi();
  return true;
}

function sendNextComposerQueueItem(sessionId) {
  const sid = sidOf(sessionId);
  if (sid !== activeSid()) {
    toast('无法发送', '请先切回该会话', { variant: 'warn' });
    return false;
  }
  if (typeof isSessionSending === 'function' && isSessionSending(sid)) {
    toast('无法发送', '当前仍有任务在执行', { variant: 'warn' });
    return false;
  }
  if (!getComposerQueue(sid).length) return false;
  clearComposerQueuePause(sid);
  void flushComposerQueue(sid);
  return true;
}

function takeComposerQueueItem(sessionId, id) {
  const sid = sidOf(sessionId);
  const { queue, index, item } = findComposerQueueItem(sid, id);
  if (!item || index < 0) return { item: null, index: -1 };
  queue.splice(index, 1);
  persistComposerQueues();
  dropQueueIfEmpty(sid);
  if (sid === activeSid()) updateComposerQueueUi();
  return { item, index };
}

function insertComposerQueueItem(sessionId, item, atIndex) {
  if (!item) return false;
  const sid = sidOf(sessionId);
  const queue = getComposerQueue(sid);
  const dest = Math.max(
    0,
    Math.min(queue.length, Number.isFinite(Number(atIndex)) ? Number(atIndex) : queue.length)
  );
  queue.splice(dest, 0, normalizeComposerQueueItem(item));
  persistComposerQueues();
  if (sid === activeSid()) updateComposerQueueUi();
  return true;
}

function waitForComposerQueueSessionIdle(sessionId, timeoutMs) {
  const sid = sidOf(sessionId);
  const limit = Number(timeoutMs) > 0 ? Number(timeoutMs) : COMPOSER_QUEUE_IDLE_WAIT_MS;
  const started = Date.now();
  return new Promise((resolve) => {
    const tick = () => {
      const sending = typeof isSessionSending === 'function' && isSessionSending(sid);
      if (!sending && !flushingComposerQueue) {
        resolve(true);
        return;
      }
      if (Date.now() - started >= limit) {
        resolve(false);
        return;
      }
      setTimeout(tick, 40);
    };
    tick();
  });
}

async function sendComposerQueueItemNow(sessionId, id) {
  const sid = sidOf(sessionId);
  if (composerQueueSendNowBusy) return false;
  if (sid !== activeSid()) {
    toast('无法发送', '请先切回该会话', { variant: 'warn' });
    return false;
  }
  if (typeof isSessionSwitchInFlight === 'function' && isSessionSwitchInFlight()) {
    toast('无法发送', '正在切换对话', { variant: 'warn' });
    return false;
  }
  if (editingIdFor(sid) === String(id || '')) {
    toast('无法发送', '请先保存或取消编辑', { variant: 'warn' });
    return false;
  }
  const { item, index } = takeComposerQueueItem(sid, id);
  if (!item) {
    toast('无法发送', '队列项已不存在', { variant: 'warn' });
    return false;
  }

  composerQueueSendNowBusy = true;
  if (sid === activeSid()) updateComposerQueueUi();
  clearComposerQueuePause(sid);
  composerQueueSkipPause.add(sid);
  if (typeof holdComposerQueueFlush === 'function') holdComposerQueueFlush(sid);

  const restore = () => insertComposerQueueItem(sid, item, index);

  try {
    const sending = typeof isSessionSending === 'function' && isSessionSending(sid);
    if (sending || flushingComposerQueue) {
      if (typeof stopAgentRun === 'function') stopAgentRun(sid);
      const idle = await waitForComposerQueueSessionIdle(sid, COMPOSER_QUEUE_IDLE_WAIT_MS);
      if (!idle) {
        restore();
        toast('无法发送', '等待当前任务停止超时', { variant: 'warn' });
        return false;
      }
    }
    composerQueueSkipPause.delete(sid);
    if (sid !== activeSid()) {
      restore();
      toast('无法发送', '发送过程中已切换会话', { variant: 'warn' });
      return false;
    }
    if (typeof isSessionSwitchInFlight === 'function' && isSessionSwitchInFlight()) {
      restore();
      toast('无法发送', '正在切换对话', { variant: 'warn' });
      return false;
    }
    const started = await sendMessage(item.text, {
      fromQueue: true,
      attachments: item.attachments || [],
      sessionId: sid
    });
    if (started === false) {
      restore();
      return false;
    }
    return true;
  } catch (err) {
    restore();
    toast('队列发送失败', err && err.message ? err.message : String(err), { variant: 'error' });
    return false;
  } finally {
    composerQueueSkipPause.delete(sid);
    if (typeof releaseComposerQueueFlush === 'function') releaseComposerQueueFlush(sid);
    composerQueueSendNowBusy = false;
    if (sid === activeSid()) updateComposerQueueUi();
    const stillSending = typeof isSessionSending === 'function' && isSessionSending(sid);
    if (sid === activeSid() && !stillSending) {
      void flushComposerQueue(sid);
    }
  }
}

function persistComposerQueues() {
  if (typeof window === 'undefined' || !window.localStorage) return;
  const obj = {};
  for (const [sid, items] of composerQueues.entries()) {
    if (items && items.length) obj[sid] = items;
  }
  try {
    window.localStorage.setItem(COMPOSER_QUEUE_STORAGE_KEY, JSON.stringify(obj));
  } catch {
    /* quota / private mode */
  }
}

function hydrateComposerQueuesFromStorage() {
  const stored = readComposerQueuesFromStorage();
  let dirty = false;
  for (const [sid, items] of Object.entries(stored)) {
    if (!Array.isArray(items) || !items.length) continue;
    const normalized = normalizeComposerQueueList(items);
    dirty =
      dirty ||
      normalized.some((item, i) => !items[i]?.id || items[i].id !== item.id || items[i].rev == null);
    composerQueues.set(String(sid), normalized);
  }
  if (dirty) persistComposerQueues();
}

function getComposerQueue(sessionId) {
  const sid = sidOf(sessionId);
  if (!composerQueues.has(sid)) composerQueues.set(sid, []);
  return composerQueues.get(sid);
}

function findComposerQueueItem(sessionId, id) {
  const queue = getComposerQueue(sessionId);
  const index = queue.findIndex((item) => item && item.id === String(id || ''));
  return { queue, index, item: index >= 0 ? queue[index] : null };
}

function isEditingComposerQueueItem(sessionId) {
  if (!composerQueueEditing) return false;
  if (sessionId == null) return true;
  return composerQueueEditing.sessionId === String(sessionId || '');
}

function getComposerQueueEditing() {
  return composerQueueEditing;
}

function editingIdFor(sid) {
  return composerQueueEditing && composerQueueEditing.sessionId === sid
    ? composerQueueEditing.id
    : null;
}

function snapshotComposerDraft() {
  return {
    text: chatInput ? String(chatInput.value || '') : '',
    attachments:
      typeof getPendingAttachments === 'function'
        ? cloneQueueAttachments(getPendingAttachments())
        : []
  };
}

function restoreComposerDraft(draft) {
  if (chatInput) chatInput.value = draft && draft.text != null ? String(draft.text) : '';
  const list = typeof getPendingAttachments === 'function' ? getPendingAttachments() : null;
  if (list) {
    list.length = 0;
    for (const att of cloneQueueAttachments((draft && draft.attachments) || [])) list.push(att);
    if (typeof renderAttachmentChips === 'function') renderAttachmentChips();
  }
  if (typeof refreshContextProgress === 'function') refreshContextProgress();
}

/** 结束编辑槽；restoreDraft=true 时恢复进入编辑前的输入区 */
function clearEditingSlot({ restoreDraft = false, silent = true } = {}) {
  const editing = composerQueueEditing;
  if (!editing) return false;
  const draft = editing.composerDraftBefore;
  composerQueueEditing = null;
  if (restoreDraft && editing.sessionId === activeSid()) {
    restoreComposerDraft(draft || { text: '', attachments: [] });
  }
  if (!silent) toast('已取消编辑', '', { variant: 'info', duration: 2000 });
  return true;
}

function focusComposerInput() {
  if (typeof focusChatInput === 'function') focusChatInput();
  else if (chatInput) chatInput.focus();
}

function truncateQueuePreview(text, max = 120) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t) return '（空消息）';
  return t.length <= max ? t : `${t.slice(0, max)}…`;
}

const COMPOSER_QUEUE_SEND_NOW_ICON =
  '<svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true"><path fill="currentColor" d="M3.4 20.6l17.2-8.6L3.4 3.4v6.8L14 12 3.4 13.8v6.8z"/></svg>';

function makeQueueBtn(className, title, label, onClick, disabled) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = className;
  btn.title = title;
  btn.setAttribute('aria-label', title);
  if (typeof label === 'string' && label.startsWith('<')) btn.innerHTML = label;
  else btn.textContent = label;
  btn.disabled = !!disabled;
  btn.addEventListener('click', onClick);
  return btn;
}

function updateComposerQueueEditBar() {
  const bar = $('composer-queue-edit-bar');
  if (!bar) return;
  const editing = composerQueueEditing;
  const active = !!editing && editing.sessionId === activeSid();
  bar.hidden = !active;
  if (!active) return;
  const label = bar.querySelector('.composer-queue-edit-label');
  if (!label) return;
  const { index } = findComposerQueueItem(editing.sessionId, editing.id);
  label.textContent = index >= 0 ? `编辑队列第 ${index + 1} 条` : '编辑队列消息';
}

function updateComposerQueueUi() {
  const box = $('composer-queue');
  const listEl = $('composer-queue-list');
  const countEl = $('composer-queue-count');
  if (!box) return;

  const sid = activeSid();
  const items = getComposerQueue(sid);
  const editingId = editingIdFor(sid);
  const paused = isComposerQueuePaused(sid);
  const hintEl = box.querySelector('.composer-queue-hint');
  const titleEl = box.querySelector('.composer-queue-title');
  const sendNextBtn = $('composer-queue-send-next');

  // 重建队列会移除当前聚焦的按钮，焦点会掉到 body、输入框看似丢光标
  const hadQueueFocus = !!(listEl && listEl.contains(document.activeElement));
  if (titleEl) titleEl.textContent = paused ? '条待发送 · 已暂停' : '条待发送';
  if (hintEl) {
    hintEl.textContent = editingId
      ? '编辑中 · Enter 保存回队列'
      : paused
        ? '当前任务已停止，不会自动发出'
        : 'Enter 入队 · 发送键在运行中为停止';
  }
  updateComposerQueueEditBar();

  if (!items.length) {
    box.hidden = true;
    box.classList.remove('is-paused');
    if (listEl) listEl.replaceChildren();
    if (countEl) countEl.textContent = '';
    if (sendNextBtn) sendNextBtn.hidden = true;
    if (hadQueueFocus) focusComposerInput();
    return;
  }

  box.hidden = false;
  box.classList.toggle('is-paused', paused);
  if (countEl) countEl.textContent = String(items.length);
  const clearBtn = $('composer-queue-clear');
  if (clearBtn) clearBtn.hidden = false;
  if (sendNextBtn) sendNextBtn.hidden = !paused;
  if (!listEl) return;

  listEl.replaceChildren();
  items.forEach((item, index) => {
    const isEditing = !!(editingId && item.id === editingId);
    const row = document.createElement('div');
    row.className = 'composer-queue-item' + (isEditing ? ' is-editing' : '');
    row.dataset.queueId = item.id;

    const textEl = document.createElement('span');
    textEl.className = 'composer-queue-item-text';
    textEl.textContent = (isEditing ? '✎ ' : '') + truncateQueuePreview(item.text);
    textEl.title = String(item.text || '').trim();
    textEl.addEventListener('dblclick', () => beginEditComposerQueueItem(sid, item.id));

    const meta = document.createElement('span');
    meta.className = 'composer-queue-item-meta';
    const attachN = (item.attachments || []).length;
    meta.textContent = attachN ? `📎 ${attachN}` : '';

    const actions = document.createElement('span');
    actions.className = 'composer-queue-item-actions';
    actions.append(
      makeQueueBtn(
        'composer-queue-item-move',
        '上移',
        '↑',
        () => reorderComposerQueueItem(sid, item.id, index - 1),
        index === 0 || isEditing
      ),
      makeQueueBtn(
        'composer-queue-item-move',
        '下移',
        '↓',
        () => reorderComposerQueueItem(sid, item.id, index + 1),
        index >= items.length - 1 || isEditing
      ),
      makeQueueBtn(
        'composer-queue-item-edit',
        isEditing ? '正在编辑' : '编辑',
        '✎',
        () => beginEditComposerQueueItem(sid, item.id),
        isEditing
      ),
      makeQueueBtn(
        'composer-queue-item-send-now',
        '立即发送：将停止当前任务并发送这条',
        COMPOSER_QUEUE_SEND_NOW_ICON,
        () => {
          void sendComposerQueueItemNow(sid, item.id);
        },
        isEditing || composerQueueSendNowBusy
      ),
      makeQueueBtn('composer-queue-item-remove', '移出队列', '×', () =>
        removeComposerQueueItem(sid, item.id)
      )
    );

    row.append(textEl, meta, actions);
    listEl.appendChild(row);
  });
  if (hadQueueFocus) focusComposerInput();
}

function dropQueueIfEmpty(sid) {
  if (getComposerQueue(sid).length) return;
  composerQueues.delete(sid);
  if (composerQueuePauses.has(sid)) {
    composerQueuePauses.delete(sid);
    persistComposerQueuePauses();
  }
}

function updateComposerQueueItem(sessionId, id, patch) {
  const { item } = findComposerQueueItem(sessionId, id);
  if (!item) return false;
  if (patch && patch.text != null) {
    item.text = String(patch.text).trim() || EMPTY_QUEUE_TEXT;
  }
  if (patch && patch.attachments) {
    item.attachments = cloneQueueAttachments(patch.attachments);
  }
  bumpItem(item);
  persistComposerQueues();
  updateComposerQueueUi();
  return true;
}

function beginEditComposerQueueItem(sessionId, id) {
  const sid = sidOf(sessionId);
  if (sid !== activeSid()) {
    toast('无法编辑', '请先切回该会话', { variant: 'warn' });
    return false;
  }
  const { item } = findComposerQueueItem(sid, id);
  if (!item) {
    toast('无法编辑', '队列项已不存在', { variant: 'warn' });
    return false;
  }
  if (composerQueueEditing?.sessionId === sid && composerQueueEditing.id === item.id) {
    updateComposerQueueUi();
    focusComposerInput();
    return true;
  }
  if (composerQueueEditing) clearEditingSlot({ restoreDraft: true, silent: true });

  composerQueueEditing = {
    sessionId: sid,
    id: item.id,
    rev: item.rev,
    composerDraftBefore: snapshotComposerDraft()
  };
  restoreComposerDraft({ text: item.text, attachments: item.attachments });
  updateComposerQueueUi();
  focusComposerInput();
  return true;
}

function commitEditComposerQueueItem() {
  const editing = composerQueueEditing;
  if (!editing) return false;
  if (editing.sessionId !== activeSid()) {
    composerQueueEditing = null;
    updateComposerQueueEditBar();
    return false;
  }
  const { item } = findComposerQueueItem(editing.sessionId, editing.id);
  if (!item) {
    composerQueueEditing = null;
    restoreComposerDraft({ text: '', attachments: [] });
    updateComposerQueueUi();
    toast('保存失败', '队列项已不存在', { variant: 'warn' });
    return false;
  }
  if (item.rev !== editing.rev) {
    composerQueueEditing = null;
    restoreComposerDraft(editing.composerDraftBefore);
    updateComposerQueueUi();
    toast('保存失败', '队列项已变更，请重新编辑', { variant: 'warn' });
    return false;
  }

  const draft = snapshotComposerDraft();
  const text = String(draft.text || '').trim();
  if (!text && !(draft.attachments || []).length) {
    toast('无法保存', '内容不能为空', { variant: 'warn' });
    return false;
  }

  item.text = text || EMPTY_QUEUE_TEXT;
  item.attachments = draft.attachments;
  bumpItem(item);
  composerQueueEditing = null;
  restoreComposerDraft({ text: '', attachments: [] });
  persistComposerQueues();
  updateComposerQueueUi();
  toast('已写回队列', '', { variant: 'info', duration: 2200 });
  return true;
}

function cancelEditComposerQueueItem(opts = {}) {
  const ok = clearEditingSlot({ restoreDraft: true, silent: !!opts.silent });
  if (ok) updateComposerQueueUi();
  return ok;
}

function removeComposerQueueItem(sessionId, idOrIndex) {
  const sid = sidOf(sessionId);
  const q = getComposerQueue(sid);
  const index =
    typeof idOrIndex === 'number'
      ? idOrIndex
      : q.findIndex((item) => item && item.id === String(idOrIndex || ''));
  if (index < 0 || index >= q.length) return;
  const removed = q[index];
  q.splice(index, 1);
  if (composerQueueEditing?.sessionId === sid && removed && composerQueueEditing.id === removed.id) {
    clearEditingSlot({ restoreDraft: true, silent: true });
  }
  dropQueueIfEmpty(sid);
  persistComposerQueues();
  updateComposerQueueUi();
}

function reorderComposerQueueItem(sessionId, id, toIndex) {
  const sid = sidOf(sessionId);
  if (editingIdFor(sid) === String(id || '')) return false;
  const { item, index, queue } = findComposerQueueItem(sid, id);
  if (!item || index < 0) return false;
  const dest = Math.max(0, Math.min(queue.length - 1, Number(toIndex)));
  if (!Number.isFinite(dest) || dest === index) return false;
  queue.splice(index, 1);
  queue.splice(dest, 0, item);
  persistComposerQueues();
  updateComposerQueueUi();
  return true;
}

function clearComposerQueue(sessionId) {
  const sid = sidOf(sessionId);
  if (composerQueueEditing?.sessionId === sid) {
    clearEditingSlot({ restoreDraft: sid === activeSid(), silent: true });
  }
  composerQueues.delete(sid);
  composerQueuePauses.delete(sid);
  persistComposerQueuePauses();
  persistComposerQueues();
  updateComposerQueueUi();
}

function invalidateComposerQueueSession(sessionId) {
  const sid = String(sessionId || '').trim();
  if (!sid) return;
  if (composerQueueEditing?.sessionId === sid) composerQueueEditing = null;
  composerQueues.delete(sid);
  composerQueuePauses.delete(sid);
  persistComposerQueuePauses();
  persistComposerQueues();
  if (sid === activeSid()) updateComposerQueueUi();
}

function onComposerSessionActivated(sessionId) {
  const sid = sidOf(sessionId);
  if (composerQueueEditing && composerQueueEditing.sessionId !== sid) {
    // 切走：丢弃编辑槽（输入区已是新会话内容，勿 restore 旧草稿到新会话）
    composerQueueEditing = null;
  }
  if (typeof activateComposerAgentModeForSession === 'function') {
    activateComposerAgentModeForSession(sid);
  }
  if (typeof activateComposerModelForSession === 'function') {
    activateComposerModelForSession(sid);
  }
  if (sid && !composerQueues.has(sid)) {
    const stored = readComposerQueuesFromStorage();
    if (Array.isArray(stored[sid]) && stored[sid].length) {
      composerQueues.set(sid, normalizeComposerQueueList(stored[sid]));
    }
  }
  updateComposerQueueUi();
  if (typeof renderAttachmentChips === 'function') renderAttachmentChips();
}

hydrateComposerQueuesFromStorage();
hydrateComposerQueuePausesFromStorage();

function enqueueComposerMessage(text, attachments) {
  const sid = activeSid();
  const now = Date.now();
  const q = getComposerQueue(sid);
  q.push(
    normalizeComposerQueueItem({
      text: String(text || '').trim() || EMPTY_QUEUE_TEXT,
      attachments: cloneQueueAttachments(attachments || []),
      enqueuedAt: now,
      updatedAt: now,
      rev: 0
    })
  );
  persistComposerQueues();
  updateComposerQueueUi();
  toast('已加入队列', `${q.length} 条待发送 · 当前任务结束后自动发送`, {
    variant: 'info',
    duration: 3200
  });
  return q.length;
}

function canFlushComposerQueueSession(sessionId) {
  const sid = sidOf(sessionId);
  if (sid !== activeSid()) return false;
  if (composerQueueEditing?.sessionId === sid) return false;
  if (typeof shouldAutoFlushComposerQueue === 'function') {
    return shouldAutoFlushComposerQueue(sid);
  }
  if (typeof isSessionSending === 'function' && isSessionSending(sid)) return false;
  if (typeof getAgentContinueState === 'function' && getAgentContinueState(sid)) return false;
  return true;
}

async function flushComposerQueue(sessionId) {
  if (flushingComposerQueue) return;
  const sid = sidOf(sessionId);
  if (!canFlushComposerQueueSession(sid) || !getComposerQueue(sid).length) return;

  flushingComposerQueue = true;
  let softFailStreak = 0;
  try {
    while (getComposerQueue(sid).length) {
      if (!canFlushComposerQueueSession(sid)) break;
      if (typeof isSessionSending === 'function' && isSessionSending(sid)) break;
      if (
        typeof isSessionSwitchInFlight === 'function' &&
        isSessionSwitchInFlight()
      ) {
        break;
      }

      let item = null;
      const requeueItem = () => {
        if (!item) return;
        getComposerQueue(sid).unshift(normalizeComposerQueueItem(item));
        persistComposerQueues();
        updateComposerQueueUi();
      };

      try {
        const head = getComposerQueue(sid)[0];
        if (head && editingIdFor(sid) === head.id) break;
        item = normalizeComposerQueueItem(getComposerQueue(sid).shift() || {});
        updateComposerQueueUi();
        if (sid !== activeSid()) {
          requeueItem();
          break;
        }
        if (typeof ensureChatScrollAfterLayout === 'function') {
          await ensureChatScrollAfterLayout({ force: true, revealAnswer: true });
        }
        const msgLenBefore =
          typeof messages !== 'undefined' && Array.isArray(messages) ? messages.length : 0;
        const ownerBefore =
          typeof messagesOwnerSessionId !== 'undefined' ? String(messagesOwnerSessionId || '') : '';
        await sendMessage(item.text, {
          fromQueue: true,
          attachments: item.attachments || [],
          sessionId: sid
        });
        if (sid !== activeSid()) break;
        if (
          typeof isSessionSwitchInFlight === 'function' &&
          isSessionSwitchInFlight()
        ) {
          requeueItem();
          break;
        }

        const startedRun = typeof isSessionSending === 'function' && isSessionSending(sid);
        const ownerOk =
          !ownerBefore ||
          ownerBefore === sid ||
          (typeof messagesOwnerSessionId !== 'undefined' &&
            String(messagesOwnerSessionId || '') === sid);
        const msgAdded =
          ownerOk &&
          typeof messages !== 'undefined' &&
          Array.isArray(messages) &&
          messages.length > msgLenBefore;
        if (!startedRun && !msgAdded) {
          softFailStreak += 1;
          requeueItem();
          if (softFailStreak >= 3) {
            toast('队列暂停', '连续未能发送，请检查模型配置后重试', {
              variant: 'warn',
              duration: 4000
            });
            break;
          }
          break;
        }
        softFailStreak = 0;
      } catch (err) {
        console.warn('composer queue flush', err);
        requeueItem();
        toast('队列发送失败', err.message || String(err), { variant: 'error' });
        break;
      }
    }
    dropQueueIfEmpty(sid);
    persistComposerQueues();
    updateComposerQueueUi();
  } finally {
    flushingComposerQueue = false;
    if (
      getComposerQueue(sid).length &&
      softFailStreak < 3 &&
      canFlushComposerQueueSession(sid) &&
      !(typeof isSessionSending === 'function' && isSessionSending(sid)) &&
      !(typeof isSessionSwitchInFlight === 'function' && isSessionSwitchInFlight())
    ) {
      queueMicrotask(() => {
        void flushComposerQueue(sid);
      });
    }
  }
}

async function trySubmitComposerWhileBusy(text, attachments) {
  if (isEditingComposerQueueItem(currentSessionId)) {
    commitEditComposerQueueItem();
    return true;
  }
  const trimmed = String(text || '').trim().toLowerCase();
  if (trimmed === '继续' || trimmed === 'continue' || trimmed === 'resume') {
    const pendingContinue =
      typeof getAgentContinueState === 'function' ? getAgentContinueState(currentSessionId) : null;
    if (pendingContinue && pendingContinue.sessionId === currentSessionId) {
      if (chatInput) chatInput.value = '';
      await resumeAgentToolLoop();
      return true;
    }
  }
  if (!String(text || '').trim() && !(attachments || []).length) return true;
  enqueueComposerMessage(text, attachments);
  return true;
}

function initComposerQueueUI() {
  const clearBtn = $('composer-queue-clear');
  if (clearBtn) {
    clearBtn.addEventListener('click', () => {
      clearComposerQueue(currentSessionId);
      toast('队列已清空', '', { variant: 'info', duration: 2400 });
    });
  }
  const sendNextBtn = $('composer-queue-send-next');
  if (sendNextBtn) {
    sendNextBtn.addEventListener('click', () => {
      sendNextComposerQueueItem(currentSessionId);
    });
  }
  const saveBtn = $('composer-queue-edit-save');
  if (saveBtn) saveBtn.addEventListener('click', () => commitEditComposerQueueItem());
  const cancelBtn = $('composer-queue-edit-cancel');
  if (cancelBtn) cancelBtn.addEventListener('click', () => cancelEditComposerQueueItem());
  updateComposerQueueUi();
}

window.pauseComposerQueueAfterUserStop = pauseComposerQueueAfterUserStop;
window.clearComposerQueuePause = clearComposerQueuePause;
window.isComposerQueuePaused = isComposerQueuePaused;
window.sendNextComposerQueueItem = sendNextComposerQueueItem;
window.sendComposerQueueItemNow = sendComposerQueueItemNow;
window.getComposerQueue = getComposerQueue;
window.updateComposerQueueUi = updateComposerQueueUi;
window.enqueueComposerMessage = enqueueComposerMessage;
window.flushComposerQueue = flushComposerQueue;
window.clearComposerQueue = clearComposerQueue;
window.invalidateComposerQueueSession = invalidateComposerQueueSession;
window.onComposerSessionActivated = onComposerSessionActivated;
window.trySubmitComposerWhileBusy = trySubmitComposerWhileBusy;
window.initComposerQueueUI = initComposerQueueUI;
window.updateComposerQueueItem = updateComposerQueueItem;
window.beginEditComposerQueueItem = beginEditComposerQueueItem;
window.commitEditComposerQueueItem = commitEditComposerQueueItem;
window.cancelEditComposerQueueItem = cancelEditComposerQueueItem;
window.removeComposerQueueItem = removeComposerQueueItem;
window.reorderComposerQueueItem = reorderComposerQueueItem;
window.isEditingComposerQueueItem = isEditingComposerQueueItem;
