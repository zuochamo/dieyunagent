/* global window, document, $, escapeHtml, settings, gwState, gatewayCall, tracePrefs, trackArtifactsFromTrace, clearArtifacts, renderArtifactsList, refreshContextProgress, scheduleContextProgressRefresh, getTextModelId, revokeAttachmentPreview, renderAttachmentChips, tryDetectResumeCheckpoint, showAgentToast, rollbackTurnFiles, prepareTurnForWithdraw, invalidateWorkspaceArtifacts, initMermaidRender, getCurrentUndoTurnId, AGENT_RUN_EVENT_TYPES, createAgentRunEvent, normalizeAgentRunEvent, agentRunEventFromTrace, applyAgentRunEventToLive, cloneTrace, resetActiveRunContextUiState, isActiveSessionSwitch, currentSessionId, maybeSaveRunningTraceCheckpoint, beginArtifactsUiBatch, endArtifactsUiBatch, beginLiveWriteSyncSuppress, endLiveWriteSyncSuppress, syncLiveWriteFromTrace, clearLiveWrite, splitPersistedAssistantTrace, parseTraceFromPersisted, unpackAssistantMeta, forceArtifactsUiRefreshAfterBatch, getAgentLimits, getSessionChangeRowsForAgent, renderChangesPane, collapseChatThinkingTraces, scrollChatToBottom, renderAssistantBubbleContent, getActiveLiveWrite, applyLiveWriteFileListMarks, dismissToolActivityFloat, initToolActivityFloat, maybeLoadOlderChatMessages, saveSessionMessageCache, getSessionCacheHasMore, getComposerQueue, chatAutoFollow, chatList, followChatStreamGrowth, isChatNearBottom, isSessionMessageCacheStale, loadChatFromGateway, finishAgentPrepPhase, sessionActiveRuns */
'use strict';


function resetChatStreamScrollBaseline() {
  const el = document.getElementById('chat-list');
  if (el) delete el.dataset.streamScrollHeight;
}

/** 流式正文增高时按增量跟随，避免 scrollHeight 硬跳 */
function followChatStreamGrowth() {
  if (streamScrollRaf) return;
  streamScrollRaf = requestAnimationFrame(() => {
    streamScrollRaf = null;
    const el = document.getElementById('chat-list');
    if (!el) return;
    const nearBottom =
      (typeof getChatAutoFollow === 'function' ? getChatAutoFollow() : true) || isChatNearBottom(el);
    const nextH = el.scrollHeight;
    const prevRecorded = Number(el.dataset.streamScrollHeight);
    const hasBaseline = Number.isFinite(prevRecorded) && prevRecorded > 0;

    if (!hasBaseline) {
      if (nearBottom) el.scrollTop = Math.max(0, nextH - el.clientHeight);
      el.dataset.streamScrollHeight = String(nextH);
      if (nearBottom) setChatAutoFollow(true);
      updateLastTurnFloat();
      return;
    }

    const delta = nextH - prevRecorded;
    if (delta > 0) {
      if (nearBottom) el.scrollTop += delta;
    } else if (delta < 0) {
      const maxTop = Math.max(0, nextH - el.clientHeight);
      el.scrollTop = nearBottom ? maxTop : Math.min(el.scrollTop, maxTop);
    } else if (nearBottom) {
      el.scrollTop = Math.max(0, nextH - el.clientHeight);
    }
    el.dataset.streamScrollHeight = String(nextH);
    if (nearBottom) setChatAutoFollow(true);
    updateLastTurnFloat();
  });
}

function scheduleStreamingChatFollow() {
  followChatStreamGrowth();
  requestAnimationFrame(() => {
    requestAnimationFrame(() => followChatStreamGrowth());
  });
}

function isThinkingLayoutSizeProperty(name) {
  return name === 'grid-template-rows' || name === 'max-height';
}

function isThinkingLayoutTransitionTarget(target) {
  return !!(
    target instanceof Element &&
    target.closest(
      '.msg-thinking-outer, .msg-thinking-step, .msg-thinking-round-details, .msg-thinking-round, .msg-thinking-beat'
    )
  );
}

function pinStreamingChatToBottom() {
  const el = document.getElementById('chat-list');
  if (!el) return;
  if (typeof getChatAutoFollow === 'function' && !getChatAutoFollow()) return;
  el.scrollTop = Math.max(0, el.scrollHeight - el.clientHeight);
  el.dataset.streamScrollHeight = String(el.scrollHeight);
  updateLastTurnFloat();
}

function startThinkingTransitionPin() {
  thinkingTransitionPinUntil = Date.now() + THINKING_COLLAPSE_FOLLOW_MS;
  if (thinkingTransitionPinRaf) return;
  const tick = () => {
    thinkingTransitionPinRaf = null;
    if (typeof getChatAutoFollow === 'function' && !getChatAutoFollow()) {
      thinkingTransitionPinUntil = 0;
      return;
    }
    if (typeof isCurrentSessionSending === 'function' && !isCurrentSessionSending()) {
      thinkingTransitionPinUntil = 0;
      return;
    }
    pinStreamingChatToBottom();
    if (Date.now() < thinkingTransitionPinUntil) {
      thinkingTransitionPinRaf = requestAnimationFrame(tick);
    }
  };
  thinkingTransitionPinRaf = requestAnimationFrame(tick);
}

/** 流式中改 <details open> 会把 summary 滚进视口；跟底时改完立刻钉回底部 */
function setStreamingDetailsOpen(el, nextOpen) {
  if (!el) return false;
  const want = !!nextOpen;
  if (el.open === want) return false;
  const follow = typeof getChatAutoFollow === 'function' ? getChatAutoFollow() !== false : true;
  if (follow) beginSessionScrollCaptureSuppression();
  el.open = want;
  if (follow) {
    startThinkingTransitionPin();
    pinStreamingChatToBottom();
    endSessionScrollCaptureSuppression();
  }
  return true;
}

function onThinkingLayoutTransitionStart(ev) {
  if (typeof isCurrentSessionSending === 'function' && !isCurrentSessionSending()) return;
  const chat = document.getElementById('chat-list');
  if (!chat || !isThinkingLayoutTransitionTarget(ev.target) || !chat.contains(ev.target)) return;
  if (ev.propertyName && !isThinkingLayoutSizeProperty(ev.propertyName)) return;
  if (typeof getChatAutoFollow === 'function' && !getChatAutoFollow()) return;
  startThinkingTransitionPin();
}

function onThinkingLayoutTransitionEnd(ev) {
  if (typeof isCurrentSessionSending === 'function' && !isCurrentSessionSending()) return;
  const chat = document.getElementById('chat-list');
  if (!chat || !isThinkingLayoutTransitionTarget(ev.target) || !chat.contains(ev.target)) return;
  if (ev.propertyName && !isThinkingLayoutSizeProperty(ev.propertyName)) return;
  if (typeof getChatAutoFollow === 'function' && !getChatAutoFollow()) return;
  if (thinkingTransitionFollowTimer) clearTimeout(thinkingTransitionFollowTimer);
  thinkingTransitionFollowTimer = setTimeout(() => {
    thinkingTransitionFollowTimer = null;
    pinStreamingChatToBottom();
  }, 32);
}

function scrollChatToBottomNow(opts = {}) {
  const el = document.getElementById('chat-list');
  if (!el) return;
  const force = opts === true || opts.force === true;
  if (!force && !(typeof getChatAutoFollow === 'function' ? getChatAutoFollow() : true) && !isChatNearBottom(el)) {
    requestAnimationFrame(() => updateLastTurnFloat());
    return;
  }
  requestAnimationFrame(() => {
    el.scrollTop = el.scrollHeight;
        setChatAutoFollow(true);
    captureSessionScrollPosition(currentSessionId, { force: true });
    updateLastTurnFloat();
  });
}

function scrollChatToBottom(opts = {}) {
  const force = opts === true || opts.force === true;
  if (force) {
    scrollChatForcePending = true;
    if (scrollChatTimer) {
      clearTimeout(scrollChatTimer);
      scrollChatTimer = null;
    }
    scrollChatToBottomNow({ force: true });
    scrollChatForcePending = false;
    return;
  }
  if (scrollChatTimer) return;
  scrollChatTimer = setTimeout(() => {
    scrollChatTimer = null;
    const pendingForce = scrollChatForcePending;
    scrollChatForcePending = false;
    scrollChatToBottomNow({ force: pendingForce });
  }, SCROLL_CHAT_THROTTLE_MS);
}

/** 布局稳定后滚到最新回答；队列下一项发送前 await，避免回答还在视口外 */
async function ensureChatScrollAfterLayout(opts = {}) {
  const force = opts.force !== false;
  const revealAnswer = opts.revealAnswer === true;
  // 最小化 / 后台时 rAF 会被 Chromium 挂起，不能无限 await，否则任务收尾与队列 flush 卡住
  const backgrounded =
    typeof document !== 'undefined' &&
    (document.hidden || document.visibilityState === 'hidden');
  if (!backgrounded) {
    await Promise.race([
      new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
      new Promise((resolve) => setTimeout(resolve, 80))
    ]);
  }
  const el = document.getElementById('chat-list');
  if (!el) return;
  if (revealAnswer) {
    const answers = el.querySelectorAll('.msg.assistant .msg-answer:not(.msg-answer-pending)');
    const target = answers.length ? answers[answers.length - 1] : null;
    if (target) {
      try {
        target.scrollIntoView({ block: 'end', behavior: 'auto' });
      } catch {
        scrollChatToBottomNow({ force: true });
      }
      setChatAutoFollow(isChatNearBottom(el));
      captureSessionScrollPosition(currentSessionId, { force: true });
      updateLastTurnFloat();
      return;
    }
  }
  scrollChatToBottomNow({ force });
}

/** trace 存在跟踪库（meta.traceRunId）的消息，等待异步拉取期间先占一行位，避免思考区「消失→出现」跳变 */
function attachThinkingHydratePlaceholder(bubble) {
  if (!bubble || bubble.querySelector(':scope > .msg-thinking-outer')) return;
  const ph = document.createElement('details');
  ph.className = 'msg-thinking-outer msg-thinking-hydrating';
  const summary = document.createElement('summary');
  summary.className = 'msg-thinking-outer-summary';
  summary.textContent = '思考过程（加载中…）';
  ph.appendChild(summary);
  bubble.insertBefore(ph, bubble.firstChild);
}

function removeThinkingHydratePlaceholder(bubble) {
  if (!bubble) return;
  bubble.querySelector(':scope > .msg-thinking-outer.msg-thinking-hydrating')?.remove();
}

async function hydrateAssistantTraceFromStore(bubble, meta, storedContent, checkpointOpts, sessionAtRender) {
  if (!bubble || !meta?.traceRunId || !gwState.authed) {
    removeThinkingHydratePlaceholder(bubble);
    return;
  }
  const sessionId = sessionAtRender || currentSessionId;
  try {
    const row = await gatewayCall('agent.trace_get', {
      runId: meta.traceRunId,
      sessionId
    });
    if (sessionId !== currentSessionId || !bubble.isConnected) {
      removeThinkingHydratePlaceholder(bubble);
      return;
    }
    if (!row || !row.trace || !row.trace.length) {
      removeThinkingHydratePlaceholder(bubble);
      return;
    }
    trackArtifactsFromTrace(row.trace);
    const answer = bubble.querySelector('.msg-answer');
    const content =
      storedContent ||
      (answer && answer.dataset && answer.dataset.rawContent) ||
      (answer ? answer.textContent : bubble.textContent || '');
    const cp = checkpointOpts || null;
    renderAssistantBubbleContent(bubble, {
      content,
      trace: row.trace,
      hitRoundLimit: false,
      loading: false,
      undoTurnId: cp?.undoTurnId || null,
      checkpointRestore: !!cp
    });
    const saved = sessionScrollPositions.get(String(sessionId));
    if (saved && !saved.atBottom) {
      restoreSessionScrollPosition(sessionId, { immediate: true });
    }
  } catch (e) {
    removeThinkingHydratePlaceholder(bubble);
    console.warn(e);
  }
}

function shouldAbortChatRender(switchGen) {
  return switchGen != null && typeof isActiveSessionSwitch === 'function' && !isActiveSessionSwitch(switchGen);
}

function appendRenderedMessageAtIndex(i, opts) {
  const forceScroll = opts.forceScroll !== false;
  const skipScroll = opts.skipScroll === true;
  const sessionAtRender = opts.sessionAtRender || currentSessionId;
  const deferTrace = opts.deferTrace === true;
  const m = messages[i];
  if (m.role === 'user') {
    const { content, meta: packedMeta } = unpackUserMessageContent(m.content);
    const display =
      m.displayContent ||
      packedMeta?.inputText ||
      content ||
      '(附件)';
    const userMeta = resolveUserFooterMeta(m, i);
    const attachments = userMeta.attachments || packedMeta?.attachments || [];
    const next = messages[i + 1];
    const turnDone = next && next.role === 'assistant';
    if (turnDone) {
      const footerMeta = userMeta;
      const copyText = resolveUserTurnCopyText(m, footerMeta);
      appendUserTurn(display, {
        forceScroll,
        skipScroll,
        attachments,
        footer: buildMsgTurnFooter(footerMeta, {
          canWithdraw: canWithdrawUserTurn(i),
          msgIndex: i,
          copyText
        })
      });
    } else {
      appendUserTurn(display, { forceScroll, skipScroll, attachments });
    }
    return;
  }
  if (m.role !== 'assistant') return;
  const { content: raw, meta } = unpackAssistantMeta(m.content);
  const split = splitPersistedAssistantTrace(raw, deferTrace ? { skipParse: true } : undefined);
  const inlineTrace = split.trace || [];
  const transientTrace = Array.isArray(m.transientTrace) ? m.transientTrace : [];
  const trace = inlineTrace.length ? inlineTrace : transientTrace;
  if (!deferTrace && trace.length) trackArtifactsFromTrace(trace);
  const cp = resolveCheckpointRestoreForAssistant(i);
  const hasDeferredThinking = !!(deferTrace && (split.thinkingRaw || trace.length));
  const bubble = appendBubble('assistant', split.content, {
    trace: deferTrace ? [] : trace,
    structured: hasDeferredThinking || (!!meta?.traceRunId && !trace.length && !split.thinkingRaw),
    forceScroll,
    skipScroll,
    undoTurnId: cp?.undoTurnId || null,
    checkpointRestore: !!cp
  });
  if (hasDeferredThinking) {
    queueDeferredThinkingJob({
      bubble,
      content: split.content,
      trace,
      thinkingRaw: split.thinkingRaw || null,
      undoTurnId: cp?.undoTurnId || null,
      checkpointRestore: !!cp
    });
  } else if (!trace.length && meta?.traceRunId) {
    attachThinkingHydratePlaceholder(bubble);
    hydrateAssistantTraceFromStore(bubble, meta, split.content, cp, sessionAtRender);
  }
}

function finalizeChatRenderAfterMessages(opts = {}) {
  const forceScroll = opts.forceScroll !== false;
  const sessionId = opts.sessionId != null ? String(opts.sessionId) : String(currentSessionId);
  if (sessionActiveRuns.has(sessionId)) {
    const live = sessionActiveRuns.get(sessionId);
    if (live && !live.finished) {
      const connected = resolveRunPlaceholder(sessionId, live.placeholderEl)?.isConnected;
      attachLiveRunBubble(sessionId, { force: !connected });
    }
  }
  refreshContextProgress();
  if (typeof isArtifactsUiBatching === 'function' && isArtifactsUiBatching()) {
    // 批量渲染结束后统一刷新产物区
  } else if (!$('artifacts-panel')?.hidden) {
    const live =
      typeof getActiveLiveWrite === 'function' ? getActiveLiveWrite() : null;
    if (live && live.status === 'writing') {
      if (typeof applyLiveWriteFileListMarks === 'function') applyLiveWriteFileListMarks();
    } else {
      renderArtifactsList({ skipRefresh: true });
    }
  }
  if (forceScroll) {
    scrollChatToBottom({ force: true });
  } else {
    restoreSessionScrollPosition(sessionId, { immediate: true });
  }
  updateLastTurnFloat();
}

function syncLiveWriteFromLastRenderedMessage() {
  if (typeof syncLiveWriteFromTrace !== 'function') return;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m || m.role !== 'assistant') continue;
    const { content: raw } = unpackAssistantMeta(m.content);
    const split = splitPersistedAssistantTrace(raw);
    const trace = split.trace || (Array.isArray(m.transientTrace) ? m.transientTrace : []);
    if (trace.length) {
      void syncLiveWriteFromTrace(trace, {
        sessionId: typeof currentSessionId !== 'undefined' ? currentSessionId : undefined
      });
      return;
    }
  }
  const hasSessionChanges =
    typeof getSessionChangeRowsForAgent === 'function' && getSessionChangeRowsForAgent().length > 0;
  if (hasSessionChanges) {
    if (typeof window.patchChangesPane === 'function') window.patchChangesPane();
    else if (typeof renderChangesPane === 'function') renderChangesPane();
    return;
  }
  if (typeof clearLiveWrite === 'function') clearLiveWrite();
}

function beginChatHistoryArtifactsBatch() {
  if (typeof beginArtifactsUiBatch === 'function') beginArtifactsUiBatch();
  if (typeof beginLiveWriteSyncSuppress === 'function') beginLiveWriteSyncSuppress();
}

function endChatHistoryArtifactsBatch() {
  if (typeof forceArtifactsUiRefreshAfterBatch === 'function') forceArtifactsUiRefreshAfterBatch();
  if (typeof endLiveWriteSyncSuppress === 'function') endLiveWriteSyncSuppress();
  if (typeof endArtifactsUiBatch === 'function') endArtifactsUiBatch();
  syncLiveWriteFromLastRenderedMessage();
}

async function renderChatFromMessagesYielding(opts = {}) {
  const switchGen = opts.switchGen;
  const forceScroll = opts.forceScroll !== false;
  const transition = opts.transition === true;
  const deferTrace = opts.deferTrace === true;
  const sessionAtRender = opts.sessionId != null ? String(opts.sessionId) : String(currentSessionId);
  if (!chatList) return false;
  if (shouldAbortChatRender(switchGen)) return false;
  if (sessionAtRender !== String(currentSessionId)) return false;

  beginSessionScrollCaptureSuppression();
  const hiddenToken = beginHiddenChatRender(!forceScroll);
  beginChatHistoryArtifactsBatch();
  let painted = false;
  try {
    clearDeferredThinkingJobs();
    chatList.innerHTML = '';
    clearArtifacts();
    if (!messages.length) {
      finalizeChatRenderAfterMessages({ forceScroll, sessionId: sessionAtRender });
      focusChatInput();
      painted = true;
      return true;
    }

    for (let i = 0; i < messages.length; i++) {
      if (shouldAbortChatRender(switchGen)) return false;
      if (sessionAtRender !== String(currentSessionId)) return false;
      appendRenderedMessageAtIndex(i, {
        forceScroll,
        skipScroll: !forceScroll,
        sessionAtRender,
        deferTrace
      });
      if ((i + 1) % CHAT_HISTORY_RENDER_YIELD_EVERY === 0) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    }

    if (shouldAbortChatRender(switchGen)) return false;
    if (sessionAtRender !== String(currentSessionId)) return false;
    finalizeChatRenderAfterMessages({ forceScroll, sessionId: sessionAtRender });
    painted = !chatList.querySelector('.chat-loading-placeholder');
    return painted;
  } finally {
    endChatHistoryArtifactsBatch();
    endSessionScrollCaptureSuppression();
    if (
      deferTrace &&
      painted &&
      !shouldAbortChatRender(switchGen) &&
      sessionAtRender === String(currentSessionId)
    ) {
      // 思考区延迟补齐：聊天区保持隐藏，由 flush 完成后统一显示，避免闪变
      scheduleDeferredThinkingFlush(switchGen, sessionAtRender, { hiddenToken, transition });
    } else {
      clearDeferredThinkingJobs();
      endHiddenChatRender(hiddenToken, { transition });
    }
  }
}

function renderChatFromMessages(opts = {}) {
  const forceScroll = opts.forceScroll !== false;
  const transition = opts.transition === true;
  const sessionId = opts.sessionId != null ? String(opts.sessionId) : String(currentSessionId);
  if (!chatList) return;
  if (sessionId !== String(currentSessionId || '')) return;
  beginSessionScrollCaptureSuppression();
  const hiddenToken = beginHiddenChatRender(!forceScroll);
  beginChatHistoryArtifactsBatch();
  try {
    chatList.innerHTML = '';
    clearArtifacts();
    if (!messages.length) {
      finalizeChatRenderAfterMessages({ forceScroll, sessionId });
      focusChatInput();
      return;
    }
    for (let i = 0; i < messages.length; i++) {
      appendRenderedMessageAtIndex(i, { forceScroll, skipScroll: !forceScroll, sessionAtRender: sessionId });
    }
    finalizeChatRenderAfterMessages({ forceScroll, sessionId });
  } finally {
    endChatHistoryArtifactsBatch();
    endHiddenChatRender(hiddenToken, { transition });
    endSessionScrollCaptureSuppression();
  }
}

function initChatRenderUI() {
  initChatScrollFollow();
  if (typeof initMermaidRender === 'function') initMermaidRender();
}

window.captureSessionScrollPosition = captureSessionScrollPosition;
window.restoreSessionScrollPosition = restoreSessionScrollPosition;
window.withSessionScrollCaptureSuppressed = withSessionScrollCaptureSuppressed;
window.ensureChatScrollAfterLayout = ensureChatScrollAfterLayout;
window.resetChatStreamScrollBaseline = resetChatStreamScrollBaseline;
window.scheduleStreamingChatFollow = scheduleStreamingChatFollow;
window.setStreamingDetailsOpen = setStreamingDetailsOpen;
window.startThinkingTransitionPin = startThinkingTransitionPin;
window.reconcileSessionLiveRunUi = reconcileSessionLiveRunUi;
