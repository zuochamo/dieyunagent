/* global window, document, $, setComposerSendingState, updateLastTurnFloat, flushComposerQueue, updateComposerQueueUi, getAgentContinueState, currentSessionId, isSessionSwitchInFlight, isComposerQueuePaused */
'use strict';

const SESSION_STORAGE_KEY = 'diecloud.active.session.v1';
const LEGACY_SESSION = 'default';

function getCurrentSessionId() {
  try {
    const id = window.localStorage.getItem(SESSION_STORAGE_KEY);
    if (id) return id;
  } catch {
    // ignore
  }
  return LEGACY_SESSION;
}

function setCurrentSessionId(id) {
  try {
    window.localStorage.setItem(SESSION_STORAGE_KEY, id);
  } catch {
    // ignore
  }
}

function setMessagesOwnerSessionId(sessionId) {
  messagesOwnerSessionId = sessionId != null && String(sessionId).trim()
    ? String(sessionId).trim()
    : null;
}

function getMessagesOwnerSessionId() {
  return messagesOwnerSessionId;
}

function messagesBelongToSession(sessionId) {
  const sid = sessionId != null ? String(sessionId).trim() : '';
  return !!(sid && messagesOwnerSessionId && sid === String(messagesOwnerSessionId));
}

/** 仅当全局 messages 归属该会话时可就地改写（快速切历史时防串 meta/id） */
function canMutateViewMessages(sessionId) {
  const sid = sessionId != null ? String(sessionId).trim() : '';
  if (!sid) return false;
  if (String(currentSessionId || '') !== sid) return false;
  return messagesBelongToSession(sid);
}

if (typeof window !== 'undefined') {
  window.setMessagesOwnerSessionId = setMessagesOwnerSessionId;
  window.getMessagesOwnerSessionId = getMessagesOwnerSessionId;
  window.messagesBelongToSession = messagesBelongToSession;
  window.canMutateViewMessages = canMutateViewMessages;
}

let currentSessionId = getCurrentSessionId();
/** 全局 messages 数组当前归属的会话；切换中途未加载完成时可能与 currentSessionId 不一致 */
let messagesOwnerSessionId = currentSessionId ? String(currentSessionId) : null;
let isSending = false;
/** @type {Map<string, { originalName: string, path: string, size: number }[]>} */
const sessionPendingAttachments = new Map();

function getPendingAttachments(sessionId) {
  const sid = String(sessionId ?? currentSessionId ?? '');
  if (!sid) return [];
  if (!sessionPendingAttachments.has(sid)) sessionPendingAttachments.set(sid, []);
  return sessionPendingAttachments.get(sid);
}

function clearSessionPendingAttachments(sessionId) {
  const sid = String(sessionId ?? currentSessionId ?? '');
  if (!sid) return;
  const list = getPendingAttachments(sid);
  if (typeof revokeAttachmentPreview === 'function') {
    for (const att of list) revokeAttachmentPreview(att);
  }
  list.length = 0;
}

function cleanupSessionScopedComposerState(sessionId) {
  const sid = String(sessionId || '').trim();
  if (!sid) return;
  clearSessionPendingAttachments(sid);
  sessionPendingAttachments.delete(sid);
  if (typeof cleanupSessionContinueState === 'function') cleanupSessionContinueState(sid);
  if (typeof cleanupSessionComposerAgentMode === 'function') cleanupSessionComposerAgentMode(sid);
  if (typeof cleanupSessionComposerModelPick === 'function') cleanupSessionComposerModelPick(sid);
  if (typeof clearSessionCompactionSnapshot === 'function') clearSessionCompactionSnapshot(sid);
}

const chatList = $('chat-list');
const chatForm = $('chat-form');
const chatInput = $('chat-input');
const composerSendBtn = $('composer-send-btn');
const composerBox = $('composer-box');
const agentMain = document.querySelector('.agent-main');

const messages = []; // [{role, content}]

const CHAT_AUTO_SCROLL_THRESHOLD = 72;

function readChatAutoFollowLive() {
  if (typeof chatList !== 'undefined' && chatList && typeof isChatNearBottom === 'function') {
    return isChatNearBottom(chatList);
  }
  if (typeof getChatAutoFollow === 'function') return getChatAutoFollow();
  return true;
}

if (typeof window !== 'undefined') {
  window.__readChatAutoFollowLive = readChatAutoFollowLive;
}

/** @type {Map<string, { trace: object[], placeholderEl: HTMLElement | null, finished?: boolean, abortController?: AbortController | null, gatewayRunId?: string | null }>} */
const sessionActiveRuns = new Map();

/** 完成收尾期间禁止自动 flush 队列，避免任务 1 的 DONE/await 间隙提前启动任务 2 */
const sessionQueueFlushHold = new Set();

function holdComposerQueueFlush(sessionId) {
  const sid = String(sessionId || '');
  if (sid) sessionQueueFlushHold.add(sid);
}

function releaseComposerQueueFlush(sessionId) {
  const sid = String(sessionId || '');
  if (sid) sessionQueueFlushHold.delete(sid);
}

function isComposerQueueFlushHeld(sessionId) {
  return sessionQueueFlushHold.has(String(sessionId || ''));
}

/** live.runId 与事件 runId 均存在且不一致时视为过期事件 */
function isStaleSessionRunEvent(live, eventOrRunId) {
  if (!live || !live.runId) return false;
  const eventRunId =
    eventOrRunId && typeof eventOrRunId === 'object'
      ? eventOrRunId.runId
      : eventOrRunId;
  if (eventRunId == null || eventRunId === '') return false;
  return String(live.runId) !== String(eventRunId);
}

function getSessionLastTrace(sessionId) {
  const live = sessionActiveRuns.get(String(sessionId || ''));
  if (live && Array.isArray(live.lastDisplayedTrace)) return live.lastDisplayedTrace;
  return [];
}

function setSessionLastTrace(sessionId, trace) {
  const sid = String(sessionId || '');
  if (!sid) return;
  const live = sessionActiveRuns.get(sid);
  const copy = Array.isArray(trace) ? trace.slice() : [];
  if (live) live.lastDisplayedTrace = copy;
}

function getLastAgentDisplayedTrace(sessionId) {
  const sid = sessionId != null ? String(sessionId) : String(currentSessionId || '');
  const fromRun = getSessionLastTrace(sid);
  if (fromRun.length) return fromRun;
  return [];
}
/** 会话切换代际：新点击会递增，过期的 load/render 结果应丢弃 */
let sessionSwitchGeneration = 0;

function bumpSessionSwitchGeneration() {
  sessionSwitchGeneration += 1;
  return sessionSwitchGeneration;
}

function isActiveSessionSwitch(gen) {
  // 启动 / Agent 恢复等未走路由切换时，不传 gen，应始终允许渲染
  if (gen == null) return true;
  return gen === sessionSwitchGeneration;
}

function isCurrentSessionSending() {
  const live = sessionActiveRuns.get(currentSessionId);
  return !!(live && !live.finished);
}

function getSessionAbortController(sessionId) {
  return sessionActiveRuns.get(String(sessionId || ''))?.abortController || null;
}

function getSessionAbortSignal(sessionId) {
  return getSessionAbortController(sessionId)?.signal;
}

function isSessionSending(sessionId) {
  const live = sessionActiveRuns.get(String(sessionId || ''));
  return !!(live && !live.finished);
}

function shouldAutoFlushComposerQueue(sessionId) {
  const sid = String(sessionId || currentSessionId || '');
  if (isComposerQueueFlushHeld(sid)) return false;
  if (typeof isComposerQueuePaused === 'function' && isComposerQueuePaused(sid)) return false;
  if (typeof isSessionSending === 'function' && isSessionSending(sid)) return false;
  if (typeof getAgentContinueState === 'function') {
    const cs = getAgentContinueState(sid || currentSessionId);
    if (cs) return false;
  }
  return true;
}

function syncComposerForActiveSession() {
  const switching =
    typeof isSessionSwitchInFlight === 'function' && isSessionSwitchInFlight();
  const sending = isCurrentSessionSending();
  setComposerSendingState(sending);
  // 输入框不做 disabled/readOnly 锁定：切换中不阻塞打字（disabled 会丢焦点、丢草稿）。
  // 能否发送由 sendMessage 入口 gateSendMessage 的 isSessionSwitchInFlight 单点判定。
  if (typeof updateComposerQueueUi === 'function') updateComposerQueueUi();
  updateLastTurnFloat();
  const sid = String(currentSessionId || '');
  if (
    !switching &&
    !sending &&
    shouldAutoFlushComposerQueue(sid) &&
    typeof flushComposerQueue === 'function'
  ) {
    void flushComposerQueue(sid);
  }
}

/** 输入框顶边细进度条（启动 / 切换对话共用） */
const composerPrepProgress = {
  hideTimer: null,
  raf: null,
  displayPct: 0,
  targetPct: 0,
  lastTs: 0,
  active: false
};
const COMPOSER_PREP_PCT_PER_MS = 0.085;

function getComposerPrepProgressEls() {
  if (typeof document === 'undefined') return { el: null, fill: null };
  return {
    el: document.getElementById('boot-chat-progress'),
    fill: document.getElementById('boot-chat-progress-fill')
  };
}

function applyComposerPrepFill(pct) {
  const { fill } = getComposerPrepProgressEls();
  if (!fill) return;
  const p = Math.max(0, Math.min(100, pct));
  fill.style.transform = p <= 0 ? 'scaleX(0)' : `scaleX(${Math.max(0.04, p / 100)})`;
  fill.style.opacity = p <= 0 ? '0' : '1';
}

function tickComposerPrepProgress(ts) {
  composerPrepProgress.raf = null;
  const { el, fill } = getComposerPrepProgressEls();
  if (!el || !fill) return;
  if (!composerPrepProgress.lastTs) composerPrepProgress.lastTs = ts;
  const dt = Math.min(48, Math.max(0, ts - composerPrepProgress.lastTs));
  composerPrepProgress.lastTs = ts;
  const diff = composerPrepProgress.targetPct - composerPrepProgress.displayPct;
  if (Math.abs(diff) < 0.2) {
    composerPrepProgress.displayPct = composerPrepProgress.targetPct;
    applyComposerPrepFill(composerPrepProgress.displayPct);
    return;
  }
  const step = Math.sign(diff) * Math.min(Math.abs(diff), COMPOSER_PREP_PCT_PER_MS * dt);
  composerPrepProgress.displayPct += step;
  applyComposerPrepFill(composerPrepProgress.displayPct);
  composerPrepProgress.raf = requestAnimationFrame(tickComposerPrepProgress);
}

function beginComposerPrepProgress(label) {
  const { el, fill } = getComposerPrepProgressEls();
  if (!el || !fill) return;
  if (composerPrepProgress.hideTimer) {
    clearTimeout(composerPrepProgress.hideTimer);
    composerPrepProgress.hideTimer = null;
  }
  if (composerPrepProgress.raf) {
    cancelAnimationFrame(composerPrepProgress.raf);
    composerPrepProgress.raf = null;
  }
  composerPrepProgress.active = true;
  composerPrepProgress.displayPct = 0;
  composerPrepProgress.targetPct = 0;
  composerPrepProgress.lastTs = 0;
  el.classList.remove('is-idle', 'is-done');
  el.setAttribute('aria-busy', 'true');
  if (label) el.setAttribute('aria-label', String(label));
  applyComposerPrepFill(0);
}

function setComposerPrepProgress(pct) {
  const { el, fill } = getComposerPrepProgressEls();
  if (!el || !fill) return;
  if (!composerPrepProgress.active) beginComposerPrepProgress();
  const p = Math.max(0, Math.min(100, Number(pct) || 0));
  el.classList.remove('is-idle', 'is-done');
  el.setAttribute('aria-busy', 'true');
  composerPrepProgress.targetPct = Math.max(composerPrepProgress.targetPct, p);
  if (!composerPrepProgress.raf) {
    composerPrepProgress.lastTs = 0;
    composerPrepProgress.raf = requestAnimationFrame(tickComposerPrepProgress);
  }
}

function finishComposerPrepProgress() {
  const { el, fill } = getComposerPrepProgressEls();
  if (!el || !fill) return;
  composerPrepProgress.active = false;
  composerPrepProgress.targetPct = 100;
  composerPrepProgress.displayPct = 100;
  if (composerPrepProgress.raf) {
    cancelAnimationFrame(composerPrepProgress.raf);
    composerPrepProgress.raf = null;
  }
  applyComposerPrepFill(100);
  el.setAttribute('aria-busy', 'false');
  el.classList.add('is-done');
  if (composerPrepProgress.hideTimer) clearTimeout(composerPrepProgress.hideTimer);
  composerPrepProgress.hideTimer = setTimeout(() => {
    el.classList.remove('is-done');
    el.classList.add('is-idle');
    composerPrepProgress.displayPct = 0;
    composerPrepProgress.targetPct = 0;
    applyComposerPrepFill(0);
    el.setAttribute('aria-label', '正在加载对话');
  }, 320);
}

function resetComposerPrepProgress() {
  const { el, fill } = getComposerPrepProgressEls();
  if (composerPrepProgress.hideTimer) {
    clearTimeout(composerPrepProgress.hideTimer);
    composerPrepProgress.hideTimer = null;
  }
  if (composerPrepProgress.raf) {
    cancelAnimationFrame(composerPrepProgress.raf);
    composerPrepProgress.raf = null;
  }
  composerPrepProgress.active = false;
  composerPrepProgress.displayPct = 0;
  composerPrepProgress.targetPct = 0;
  composerPrepProgress.lastTs = 0;
  if (!el || !fill) return;
  el.classList.remove('is-done');
  el.classList.add('is-idle');
  el.setAttribute('aria-busy', 'false');
  el.setAttribute('aria-label', '正在加载对话');
  applyComposerPrepFill(0);
}

if (typeof window !== 'undefined') {
  window.getPendingAttachments = getPendingAttachments;
  window.clearSessionPendingAttachments = clearSessionPendingAttachments;
  window.cleanupSessionScopedComposerState = cleanupSessionScopedComposerState;
  window.getLastAgentDisplayedTrace = getLastAgentDisplayedTrace;
  window.setSessionLastTrace = setSessionLastTrace;
  window.holdComposerQueueFlush = holdComposerQueueFlush;
  window.releaseComposerQueueFlush = releaseComposerQueueFlush;
  window.isComposerQueueFlushHeld = isComposerQueueFlushHeld;
  window.isStaleSessionRunEvent = isStaleSessionRunEvent;
  window.beginComposerPrepProgress = beginComposerPrepProgress;
  window.setComposerPrepProgress = setComposerPrepProgress;
  window.finishComposerPrepProgress = finishComposerPrepProgress;
  window.resetComposerPrepProgress = resetComposerPrepProgress;
}
