/* global window, document, $, escapeHtml, settings, gwState, gatewayCall, tracePrefs, trackArtifactsFromTrace, clearArtifacts, renderArtifactsList, refreshContextProgress, scheduleContextProgressRefresh, getTextModelId, revokeAttachmentPreview, renderAttachmentChips, tryDetectResumeCheckpoint, showAgentToast, rollbackTurnFiles, prepareTurnForWithdraw, invalidateWorkspaceArtifacts, initMermaidRender, getCurrentUndoTurnId, AGENT_RUN_EVENT_TYPES, createAgentRunEvent, normalizeAgentRunEvent, agentRunEventFromTrace, applyAgentRunEventToLive, cloneTrace, resetActiveRunContextUiState, maybeAutoCollapseChatOnTraceGrowth, isActiveSessionSwitch, currentSessionId, maybeSaveRunningTraceCheckpoint, beginArtifactsUiBatch, endArtifactsUiBatch, beginLiveWriteSyncSuppress, endLiveWriteSyncSuppress, syncLiveWriteFromTrace, clearLiveWrite, splitPersistedAssistantTrace, parseTraceFromPersisted, unpackAssistantMeta, forceArtifactsUiRefreshAfterBatch, getAgentLimits, getSessionChangeRowsForAgent, renderChangesPane, collapseChatThinkingTraces, scrollChatToBottom, renderAssistantBubbleContent, getActiveLiveWrite, applyLiveWriteFileListMarks, dismissToolActivityFloat, initToolActivityFloat, maybeLoadOlderChatMessages, saveSessionMessageCache, getSessionCacheHasMore, getComposerQueue, chatAutoFollow, chatList, followChatStreamGrowth, isChatNearBottom, isSessionMessageCacheStale, loadChatFromGateway, finishAgentPrepPhase, sessionActiveRuns */
'use strict';

var chatRenderApi = window.diecloud || {};

/** @type {Map<string, { scrollTop: number, distanceFromBottom: number, atBottom: boolean }>} */
var sessionScrollPositions = new Map();
var sessionScrollSaveTimer = null;
var sessionScrollSaveSessionId = null;
var sessionScrollCaptureSuppressDepth = 0;
var chatRenderHiddenDepth = 0;
var chatRenderPrevVisibility = '';
var chatRenderFadeTimer = null;
var chatUserScrollIntent = false;
/** Yield to the event loop every N messages during session switch render. */
var CHAT_HISTORY_RENDER_YIELD_EVERY = 24;
var DEFER_TRACE_YIELD_EVERY = 6;

/** @type {{ bubble: HTMLElement, content: string, trace: object[], thinkingRaw: string|null, undoTurnId: string|null, checkpointRestore: boolean }[]} */
var deferredThinkingJobs = [];
var deferredThinkingFlushGen = 0;

function clearDeferredThinkingJobs() {
  deferredThinkingJobs = [];
  deferredThinkingFlushGen += 1;
}

function queueDeferredThinkingJob(job) {
  if (!job || !job.bubble) return;
  deferredThinkingJobs.push(job);
}

function scheduleDeferredThinkingFlush(switchGen, sessionId, opts = {}) {
  const jobs = deferredThinkingJobs;
  deferredThinkingJobs = [];
  const flushGen = ++deferredThinkingFlushGen;
  const hiddenToken = opts.hiddenToken || null;
  const transition = opts.transition === true;
  // flush 完成前聊天区保持隐藏，避免「无思考区 → 思考区突然出现」闪变
  let revealed = false;
  const reveal = () => {
    if (revealed || !hiddenToken) return;
    revealed = true;
    endHiddenChatRender(hiddenToken, { transition });
  };
  if (!jobs.length) {
    reveal();
    return;
  }
  const sid = String(sessionId || '');
  const run = async () => {
    try {
      for (let i = 0; i < jobs.length; i++) {
        if (flushGen !== deferredThinkingFlushGen) return;
        if (shouldAbortChatRender(switchGen)) return;
        if (sid && String(currentSessionId) !== sid) return;
        const job = jobs[i];
        if (!job.bubble || !job.bubble.isConnected) continue;
        let trace = Array.isArray(job.trace) ? job.trace : [];
        if (!trace.length && job.thinkingRaw && typeof parseTraceFromPersisted === 'function') {
          trace = parseTraceFromPersisted(job.thinkingRaw) || [];
        }
        if (!trace.length) continue;
        if (typeof trackArtifactsFromTrace === 'function') {
          trackArtifactsFromTrace(trace, { sessionId: sid });
        }
        if (typeof renderAssistantBubbleContent === 'function') {
          renderAssistantBubbleContent(job.bubble, {
            content: job.content || '',
            trace,
            hitRoundLimit: false,
            loading: false,
            undoTurnId: job.undoTurnId || null,
            checkpointRestore: !!job.checkpointRestore
          });
        }
        if ((i + 1) % DEFER_TRACE_YIELD_EVERY === 0) {
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
      }
      if (flushGen !== deferredThinkingFlushGen) return;
      if (shouldAbortChatRender(switchGen)) return;
      if (sid && String(currentSessionId) !== sid) return;
      const saved = sessionScrollPositions.get(sid);
      if (saved && !saved.atBottom) {
        restoreSessionScrollPosition(sid, { immediate: true });
      }
      updateLastTurnFloat();
      if (typeof forceArtifactsUiRefreshAfterBatch === 'function') {
        forceArtifactsUiRefreshAfterBatch();
      } else if (typeof renderArtifactsList === 'function' && !$('artifacts-panel')?.hidden) {
        renderArtifactsList({ skipRefresh: true });
      }
      syncLiveWriteFromLastRenderedMessage();
    } finally {
      // 无论正常完成还是被新渲染中止，都必须归还隐藏 token，否则聊天区永久不可见
      reveal();
    }
  };
  const start = () => {
    void run();
  };
  if (typeof requestAnimationFrame === 'function' && !(document && document.hidden)) {
    requestAnimationFrame(start);
  } else {
    setTimeout(start, 0);
  }
}

function beginSessionScrollCaptureSuppression() {
  sessionScrollCaptureSuppressDepth += 1;
}

function endSessionScrollCaptureSuppression() {
  setTimeout(() => {
    sessionScrollCaptureSuppressDepth = Math.max(0, sessionScrollCaptureSuppressDepth - 1);
  }, 120);
}

function withSessionScrollCaptureSuppressed(fn) {
  beginSessionScrollCaptureSuppression();
  try {
    return fn();
  } finally {
    endSessionScrollCaptureSuppression();
  }
}

function isSessionScrollCaptureSuppressed() {
  return sessionScrollCaptureSuppressDepth > 0;
}

function clearChatSessionTransitionClasses() {
  if (!chatList) return;
  chatList.classList.remove('chat-session-fade-out', 'chat-session-fade-in');
}

function playChatSessionFadeIn() {
  if (!chatList || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
  if (chatRenderFadeTimer) clearTimeout(chatRenderFadeTimer);
  clearChatSessionTransitionClasses();
  void chatList.offsetWidth;
  chatList.classList.add('chat-session-fade-in');
  chatRenderFadeTimer = setTimeout(() => {
    chatRenderFadeTimer = null;
    chatList.classList.remove('chat-session-fade-in');
  }, 160);
}

function beginHiddenChatRender(shouldHide) {
  if (!shouldHide || !chatList) return false;
  if (chatRenderHiddenDepth === 0) {
    chatRenderPrevVisibility = chatList.style.visibility || '';
    clearChatSessionTransitionClasses();
    chatList.style.visibility = 'hidden';
  }
  chatRenderHiddenDepth += 1;
  return true;
}

function endHiddenChatRender(token, opts = {}) {
  if (!token || !chatList) return;
  chatRenderHiddenDepth = Math.max(0, chatRenderHiddenDepth - 1);
  if (chatRenderHiddenDepth === 0) {
    chatList.style.visibility = chatRenderPrevVisibility;
    chatRenderPrevVisibility = '';
    if (opts.transition) playChatSessionFadeIn();
  }
}

function captureSessionScrollPosition(sessionId, opts = {}) {
  if (!chatList || sessionId == null || sessionId === '') return;
  if (!opts.force && isSessionScrollCaptureSuppressed()) return;
  const el = chatList;
  if (!el.scrollHeight) return;
  const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
  const atBottom = distanceFromBottom <= CHAT_AUTO_SCROLL_THRESHOLD;
  sessionScrollPositions.set(String(sessionId), {
    scrollTop: Math.max(0, el.scrollTop),
    distanceFromBottom: atBottom ? 0 : Math.max(0, distanceFromBottom),
    atBottom
  });
}

function scheduleSessionScrollSave(sessionId) {
  if (isSessionScrollCaptureSuppressed()) return;
  if (sessionScrollSaveTimer) clearTimeout(sessionScrollSaveTimer);
  sessionScrollSaveSessionId = sessionId || currentSessionId;
  sessionScrollSaveTimer = setTimeout(() => {
    sessionScrollSaveTimer = null;
    captureSessionScrollPosition(sessionScrollSaveSessionId);
    sessionScrollSaveSessionId = null;
  }, 150);
}

function restoreSessionScrollPosition(sessionId, opts = {}) {
  if (!chatList) return;
  const key = String(sessionId || currentSessionId);
  const saved = sessionScrollPositions.get(key);
  beginSessionScrollCaptureSuppression();
  const apply = () => {
    try {
      if (!chatList || String(currentSessionId) !== key) return;
      const maxTop = Math.max(0, chatList.scrollHeight - chatList.clientHeight);
      if (!saved) {
        chatList.scrollTop = maxTop;
        setChatAutoFollow(true);
      } else if (saved.atBottom) {
        chatList.scrollTop = maxTop;
        setChatAutoFollow(true);
      } else {
        const top = Number.isFinite(Number(saved.scrollTop))
          ? Number(saved.scrollTop)
          : chatList.scrollHeight - chatList.clientHeight - saved.distanceFromBottom;
        chatList.scrollTop = Math.max(0, Math.min(maxTop, top));
        setChatAutoFollow(isChatNearBottom(chatList));
      }
      updateLastTurnFloat();
    } finally {
      endSessionScrollCaptureSuppression();
    }
  };
  if (opts.immediate) {
    apply();
  } else {
    requestAnimationFrame(() => requestAnimationFrame(apply));
  }
}

function updateLastTurnFloat() {
  const floatEl = $('last-turn-float');
  const textEl = $('last-turn-float-user');
  if (!floatEl || !textEl || !chatList) return;
  if (!isCurrentSessionSending()) {
    floatEl.hidden = true;
    return;
  }
  const turns = chatList.querySelectorAll('.msg-turn');
  const lastTurn = turns.length ? turns[turns.length - 1] : null;
  const userBubble = lastTurn ? lastTurn.querySelector('.msg.user') : null;
  if (!lastTurn || !userBubble) {
    floatEl.hidden = true;
    return;
  }
  const chatRect = chatList.getBoundingClientRect();
  const turnRect = lastTurn.getBoundingClientRect();
  const pushedAbove = turnRect.bottom < chatRect.top + 8;
  floatEl.hidden = !pushedAbove;
  if (pushedAbove) {
    const text = (userBubble.textContent || '').replace(/\s+/g, ' ').trim();
    textEl.textContent = text || '当前问题';
  }
}

function isChatNearBottom(el, threshold = CHAT_AUTO_SCROLL_THRESHOLD) {
  if (!el) return true;
  return el.scrollHeight - el.scrollTop - el.clientHeight <= threshold;
}

function markChatUserScrollIntent() {
  chatUserScrollIntent = true;
}

function updateChatAutoFollowFromScroll() {
  if (!chatList) return;
  if (isSessionScrollCaptureSuppressed()) {
    updateLastTurnFloat();
    return;
  }
  const sending = typeof isCurrentSessionSending === 'function' && isCurrentSessionSending();
  if (sending && !chatUserScrollIntent) {
    updateLastTurnFloat();
    return;
  }
  if (chatUserScrollIntent) chatUserScrollIntent = false;
  setChatAutoFollow(isChatNearBottom(chatList));
  updateLastTurnFloat();
  scheduleSessionScrollSave(currentSessionId);
  if (chatList.scrollTop <= 96 && typeof maybeLoadOlderChatMessages === 'function') {
    void maybeLoadOlderChatMessages();
  }
}

function bindChatUserScrollIntent(el) {
  if (!el || el.dataset.chatUserScrollIntent === '1') return;
  el.dataset.chatUserScrollIntent = '1';
  el.addEventListener('wheel', markChatUserScrollIntent, { passive: true });
  el.addEventListener('touchmove', markChatUserScrollIntent, { passive: true });
  el.addEventListener(
    'pointerdown',
    (e) => {
      if (e.offsetX >= el.clientWidth || e.offsetY >= el.clientHeight) markChatUserScrollIntent();
    },
    { passive: true }
  );
  el.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === 'PageUp' || e.key === 'PageDown' || e.key === 'Home' || e.key === 'End' || e.key === ' ') {
      markChatUserScrollIntent();
    }
  });
}

function initChatScrollFollow() {
  if (chatList) {
    chatList.addEventListener('scroll', updateChatAutoFollowFromScroll, { passive: true });
    bindChatUserScrollIntent(chatList);
    if (chatList.dataset.thinkingTransitionFollow !== '1') {
      chatList.dataset.thinkingTransitionFollow = '1';
      chatList.addEventListener('transitionstart', onThinkingLayoutTransitionStart);
      chatList.addEventListener('transitionend', onThinkingLayoutTransitionEnd);
    }
  }
  initMsgTurnFooterActions();
}

function initMsgTurnFooterActions() {
  if (!chatList || chatList.dataset.turnFooterActions === '1') return;
  chatList.dataset.turnFooterActions = '1';

  chatList.addEventListener(
    'pointerdown',
    (e) => {
      const btn = e.target.closest?.('.msg-action-btn');
      if (!btn || !chatList.contains(btn)) return;
      const turn = btn.closest('.msg-turn');
      if (turn) turn.classList.add('is-footer-active');
    },
    true
  );

  chatList.addEventListener('pointerleave', (e) => {
    const turn = e.target.closest?.('.msg-turn');
    if (!turn || !chatList.contains(turn)) return;
    const related = e.relatedTarget;
    if (related && turn.contains(related)) return;
    window.setTimeout(() => {
      if (turn.matches(':hover') || turn.querySelector('.msg-action-btn:focus-visible')) return;
      turn.classList.remove('is-footer-active');
    }, 180);
  });
}
