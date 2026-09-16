/* global window, document, $, escapeHtml, settings, gwState, gatewayCall, tracePrefs, trackArtifactsFromTrace, clearArtifacts, renderArtifactsList, refreshContextProgress, scheduleContextProgressRefresh, getTextModelId, revokeAttachmentPreview, renderAttachmentChips, tryDetectResumeCheckpoint, showAgentToast, rollbackTurnFiles, prepareTurnForWithdraw, invalidateWorkspaceArtifacts, initMermaidRender, getCurrentUndoTurnId, AGENT_RUN_EVENT_TYPES, createAgentRunEvent, normalizeAgentRunEvent, agentRunEventFromTrace, applyAgentRunEventToLive, cloneTrace, resetActiveRunContextUiState, maybeAutoCollapseChatOnTraceGrowth, isActiveSessionSwitch, currentSessionId, maybeSaveRunningTraceCheckpoint, beginArtifactsUiBatch, endArtifactsUiBatch, beginLiveWriteSyncSuppress, endLiveWriteSyncSuppress, syncLiveWriteFromTrace, clearLiveWrite, splitPersistedAssistantTrace, parseTraceFromPersisted, unpackAssistantMeta, forceArtifactsUiRefreshAfterBatch, getAgentLimits, getSessionChangeRowsForAgent, renderChangesPane, collapseChatThinkingTraces, scrollChatToBottom, renderAssistantBubbleContent, getActiveLiveWrite, applyLiveWriteFileListMarks, dismissToolActivityFloat, initToolActivityFloat, maybeLoadOlderChatMessages, saveSessionMessageCache, getSessionCacheHasMore, getComposerQueue, chatAutoFollow, chatList, followChatStreamGrowth, isChatNearBottom, isSessionMessageCacheStale, loadChatFromGateway, finishAgentPrepPhase, sessionActiveRuns */
'use strict';

function findAssistantLoadingBubble(sessionId) {
  if (!chatList) return null;
  const sid = String(sessionId || currentSessionId || '').trim();
  if (!sid) return null;
  const esc = sid.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return chatList.querySelector(`.msg.assistant.loading[data-run-session-id="${esc}"]`);
}

/** 清除真正残留的运行状态；会话切换会拆掉 DOM，但不能据此删除仍在执行的 run。 */
function cleanupStaleSessionRun(sessionId) {
  const live = sessionActiveRuns.get(sessionId);
  if (!live) return;
  if (live.finished) {
    sessionActiveRuns.delete(sessionId);
    return;
  }
  if (live.placeholderEl?.isConnected) return;
  if (String(sessionId || '') !== String(currentSessionId || '')) return;
  if (findAssistantLoadingBubble(sessionId)) return;
  const hasLiveEvidence =
    !!live.runId ||
    !!live.agentServiceRequestId ||
    !!live.streamContent ||
    (Array.isArray(live.trace) && live.trace.length > 0);
  if (hasLiveEvidence) return;
  sessionActiveRuns.delete(sessionId);
}

function removeStrayAssistantLoadingBubbles(keepEl) {
  if (!chatList) return;
  for (const node of chatList.querySelectorAll('.msg.assistant.loading')) {
    if (node !== keepEl) node.remove();
  }
}

/** 运行中气泡可能因 DOM 重建与闭包引用脱节，始终以 session 登记 + DOM 兜底 */
function resolveRunPlaceholder(sessionId, fallbackEl) {
  const live = sessionActiveRuns.get(sessionId);
  const registered = live?.placeholderEl;
  if (registered?.isConnected) return registered;
  const dom = findAssistantLoadingBubble(sessionId);
  if (dom) {
    if (live) live.placeholderEl = dom;
    return dom;
  }
  return fallbackEl?.isConnected ? fallbackEl : null;
}

function finalizeAssistantBubble(sessionId, fallbackEl, opts) {
  const { content, hitRoundLimit, error, stopped } = opts;
  let trace = opts.trace || [];
  if (
    stopped &&
    typeof resolveStoppedDisplayTrace === 'function' &&
    typeof isPrepOnlyTrace === 'function' &&
    isPrepOnlyTrace(trace)
  ) {
    trace = [];
  }
  const live = sessionActiveRuns.get(sessionId);
  if (live) live.finished = true;
  if (stopped && !trace.length && live) {
    live.trace = [];
    if (typeof finishAgentPrepPhase === 'function') finishAgentPrepPhase(sessionId);
  }

  const el = resolveRunPlaceholder(sessionId, fallbackEl);
  if (!el) return null;
  if (live) live.placeholderEl = el;

  el.classList.remove('loading');
  if (error) el.classList.add('error');
  else el.classList.remove('error');
  const cp = checkpointRestoreOptsForLastTurn();
  renderAssistantBubbleContent(el, {
    content: content || '',
    trace,
    hitRoundLimit: !!hitRoundLimit,
    loading: false,
    stopped: !!stopped,
    undoTurnId: cp?.undoTurnId || null,
    checkpointRestore: !!cp
  });
  removeStrayAssistantLoadingBubbles(el);
  if (typeof collapseChatThinkingTraces === 'function') {
    collapseChatThinkingTraces({
      keepLoadingBubble: false,
      exceptBubble: stopped && trace.length ? el : null
    });
  }
  scrollChatToBottom({ force: true });
  return el;
}

/** 循环已返回、验收仍在跑：先把气泡收成已完成，避免长时间停在「生成回答中」。不标记 run finished，以便验收提示写回同一轮。 */
function settleAssistantBubbleAfterLoop(sessionId, fallbackEl, opts) {
  const live = sessionActiveRuns.get(sessionId);
  if (live) {
    live.loopReturned = true;
    live.streamContent = opts?.content || live.streamContent || '';
    if (Array.isArray(opts?.trace)) live.trace = opts.trace;
  }
  const el = resolveRunPlaceholder(sessionId, fallbackEl);
  if (!el) return null;
  el.classList.remove('loading');
  renderAssistantBubbleContent(el, {
    content: opts?.content || '',
    trace: opts?.trace || [],
    hitRoundLimit: !!opts?.hitRoundLimit,
    loading: false
  });
  if (typeof collapseChatThinkingTraces === 'function') {
    collapseChatThinkingTraces({
      keepLoadingBubble: false,
      exceptBubble: null
    });
  }
  if (typeof scrollChatToBottom === 'function') {
    scrollChatToBottom({ force: true });
  }
  return el;
}

function attachLiveRunBubble(sessionId, opts = {}) {
  const live = sessionActiveRuns.get(sessionId);
  if (!live || live.finished) return;

  let ph = live.placeholderEl;
  if (opts.force || !ph?.isConnected) {
    live.placeholderEl = null;
    ph = null;
  }
  if (!ph) {
    ph = findAssistantLoadingBubble(sessionId);
  }
  if (!ph) {
    ph = appendBubble('assistant', live.streamContent || '', {
      loading: !live.loopReturned,
      trace: live.trace || [],
      sessionId
    });
  }
  if (ph && sessionId) ph.dataset.runSessionId = String(sessionId);
  live.placeholderEl = ph;
  if (opts.force && ph) {
    delete ph.dataset.thinkingTraceSig;
    if (typeof resetThinkingUiState === 'function') resetThinkingUiState(ph);
  }
  const cp = checkpointRestoreOptsForLastTurn();
  if (live.loopReturned) ph.classList.remove('loading');
  renderAssistantBubbleContent(ph, {
    content: live.streamContent || '',
    trace: live.trace || [],
    hitRoundLimit: false,
    loading: !live.loopReturned,
    undoTurnId: cp?.undoTurnId || null,
    checkpointRestore: !!cp
  });
}

function reconcileSessionLiveRunUi(sessionId) {
  const sid = String(sessionId || '');
  if (!sid || sid !== String(currentSessionId || '')) return;

  const live = sessionActiveRuns.get(sid);
  if (!live || live.finished) return;

  const ph = resolveRunPlaceholder(sid, live.placeholderEl);
  const disconnected = !ph?.isConnected;
  live.pendingUiSync = false;

  if (live.streamContent && typeof finishAgentPrepPhase === 'function') {
    finishAgentPrepPhase(sid);
  }

  if (disconnected) {
    attachLiveRunBubble(sid, { force: true });
  } else if (ph) {
    live.placeholderEl = ph;
    const event =
      live.lastEvent ||
      (typeof createAgentRunEvent === 'function'
        ? createAgentRunEvent(AGENT_RUN_EVENT_TYPES.TRACE, {
            sessionId: sid,
            trace: live.trace || [],
            streamContent: live.streamContent || ''
          })
        : null);
    if (event) renderLiveRunFromEvent(sid, live, event);
  } else {
    attachLiveRunBubble(sid, { force: true });
  }

  if (typeof scheduleContextProgressRefresh === 'function') {
    scheduleContextProgressRefresh();
  } else if (typeof refreshContextProgress === 'function') {
    refreshContextProgress();
  }
  if (live.streamContent && typeof followChatStreamGrowth === 'function') {
    followChatStreamGrowth();
  } else if (typeof scrollChatToBottom === 'function') {
    scrollChatToBottom({ force: false });
  }
}

var historyListRefreshTimer = null;
function scheduleHistoryListRefresh() {
  if (historyListRefreshTimer) return;
  historyListRefreshTimer = setTimeout(() => {
    historyListRefreshTimer = null;
    if (typeof refreshHistoryList === 'function') {
      refreshHistoryList().catch(() => {});
    }
  }, 350);
}

function renderLiveRunFromEvent(sessionId, live, event) {
  if (sessionId !== currentSessionId) return;
  const el = resolveRunPlaceholder(sessionId, live.placeholderEl);
  if (!el) {
    attachLiveRunBubble(sessionId);
    return;
  }
  live.placeholderEl = el;
  const cp = checkpointRestoreOptsForLastTurn();
  const stopped = event && event.type === AGENT_RUN_EVENT_TYPES.STOPPED;
  let trace = live.trace || [];
  if (stopped && typeof isPrepOnlyTrace === 'function' && isPrepOnlyTrace(trace)) {
    trace = [];
    live.trace = [];
  }
  renderAssistantBubbleContent(el, {
    content: live.streamContent || '',
    trace,
    hitRoundLimit: false,
    loading: !live.finished,
    stopped,
    undoTurnId: cp?.undoTurnId || null,
    checkpointRestore: !!cp
  });
  if (!live.finished && ((typeof getChatAutoFollow === 'function' ? getChatAutoFollow() : true) || isChatNearBottom(chatList))) {
    // 准备区是整块撑高，增量 follow 跟不上 1s 展开动画；PREP 直接强制贴底
    if (event && event.type === AGENT_RUN_EVENT_TYPES.PREP) {
      scrollChatToBottom({ force: true });
    } else {
      followChatStreamGrowth();
    }
  }
}

function dispatchAgentRunEvent(sessionId, rawEvent) {
  const event =
    typeof normalizeAgentRunEvent === 'function'
      ? normalizeAgentRunEvent(rawEvent)
      : rawEvent;
  if (!event || !sessionId) return event;

  const live = sessionActiveRuns.get(sessionId);
  if (!live || live.finished) return event;
  if (typeof isStaleSessionRunEvent === 'function' && isStaleSessionRunEvent(live, event)) {
    return event;
  }

  if (typeof applyAgentRunEventToLive === 'function') {
    applyAgentRunEventToLive(live, event);
  } else {
    if (Array.isArray(event.trace)) live.trace = event.trace;
    if (typeof event.streamContent === 'string') live.streamContent = event.streamContent;
  }

  const isBackground = sessionId !== currentSessionId;
  if (isBackground && !live.finished) {
    live.pendingUiSync = true;
  }

  if (
    event.type === AGENT_RUN_EVENT_TYPES.TRACE ||
    event.type === AGENT_RUN_EVENT_TYPES.STREAM ||
    event.type === AGENT_RUN_EVENT_TYPES.PREP ||
    event.type === AGENT_RUN_EVENT_TYPES.TOOL ||
    event.type === AGENT_RUN_EVENT_TYPES.ROUND_LIMIT
  ) {
    pushAgentServiceProgress(live, sessionId, live.trace || event.trace || [], false, event);
    if (typeof maybeSaveRunningTraceCheckpoint === 'function' && live.runId) {
      maybeSaveRunningTraceCheckpoint(live, {
        runId: live.runId,
        sessionId,
        trace: live.trace || event.trace || [],
        streamContent: live.streamContent || event.streamContent || ''
      });
    }
  }
  if (
    event.type === AGENT_RUN_EVENT_TYPES.DONE ||
    event.type === AGENT_RUN_EVENT_TYPES.ERROR ||
    event.type === AGENT_RUN_EVENT_TYPES.STOPPED
  ) {
    pushAgentServiceProgress(live, sessionId, live.trace || event.trace || [], true, event);
    pushAgentServiceCompletion(live, sessionId, event);
  }
  renderLiveRunFromEvent(sessionId, live, event);
  if (
    event.type === AGENT_RUN_EVENT_TYPES.TRACE ||
    event.type === AGENT_RUN_EVENT_TYPES.STREAM ||
    event.type === AGENT_RUN_EVENT_TYPES.TOOL ||
    event.type === AGENT_RUN_EVENT_TYPES.PREP ||
    event.type === AGENT_RUN_EVENT_TYPES.RUN_START
  ) {
    scheduleHistoryListRefresh();
  }
  if (
    sessionId === currentSessionId &&
    !live.finished &&
    typeof scheduleContextProgressRefresh === 'function' &&
    (event.type === AGENT_RUN_EVENT_TYPES.TRACE ||
      event.type === AGENT_RUN_EVENT_TYPES.STREAM ||
      event.type === AGENT_RUN_EVENT_TYPES.TOOL ||
      event.type === AGENT_RUN_EVENT_TYPES.PREP ||
      event.type === AGENT_RUN_EVENT_TYPES.RUN_START)
  ) {
    scheduleContextProgressRefresh();
  }
  return event;
}

function updateSessionRunProgress(sessionId, trace, streamContent, extra) {
  const live = sessionActiveRuns.get(sessionId);
  const progressExtra = extra && typeof extra === 'object' ? { ...extra } : {};
  if (progressExtra.runId == null && live?.runId) progressExtra.runId = live.runId;
  if (
    live &&
    typeof isStaleSessionRunEvent === 'function' &&
    isStaleSessionRunEvent(live, progressExtra)
  ) {
    return;
  }
  if (
    live &&
    live.inPrepPhase &&
    trace &&
    (typeof isPrepOnlyTrace !== 'function' || !isPrepOnlyTrace(trace))
  ) {
    if (typeof agentPrepStepDone === 'function') agentPrepStepDone(sessionId, 'llm');
    if (typeof finishAgentPrepPhase === 'function') finishAgentPrepPhase(sessionId);
  }
  const event =
    typeof agentRunEventFromTrace === 'function'
      ? agentRunEventFromTrace(sessionId, trace, streamContent, progressExtra)
      : {
          type: 'trace',
          sessionId,
          runId: progressExtra.runId || null,
          trace,
          streamContent: streamContent || '',
          at: Date.now()
        };
  dispatchAgentRunEvent(sessionId, event);
  if (sessionId === currentSessionId && Array.isArray(trace) && typeof maybeAutoCollapseChatOnTraceGrowth === 'function') {
    maybeAutoCollapseChatOnTraceGrowth(trace.length);
  }
}

function cloneTraceForMobile(trace) {
  if (typeof cloneTrace === 'function') return cloneTrace(trace);
  return (trace || []).map((entry) => ({
    ...entry,
    tools: Array.isArray(entry.tools) ? entry.tools.map((tool) => ({ ...tool })) : []
  }));
}

function mobileTraceStructureSig(trace) {
  if (!Array.isArray(trace) || !trace.length) return '';
  const last = trace[trace.length - 1] || {};
  const tools = Array.isArray(last.tools) ? last.tools : [];
  const toolSig = tools
    .map((t) => `${t.id || ''}:${t.pending ? 1 : 0}:${t.failed ? 1 : 0}:${String(t.summary || '').length}`)
    .join(';');
  return [
    trace.length,
    toolSig,
    String(last.thought || '').length,
    String(last.fullThought || '').length,
    last.phase || '',
    Array.isArray(last.prepSteps)
      ? last.prepSteps.map((s) => `${s.id}:${s.status}`).join(',')
      : '',
    Array.isArray(last.bootSteps)
      ? last.bootSteps.map((s) => `${s.id}:${s.status}`).join(',')
      : ''
  ].join('#');
}

function mobileTracePushIntervalMs(live, trace, runEvent) {
  const rows = Array.isArray(trace) ? trace : [];
  const roundCount = rows.length;
  const prevCount = Number(live.lastMobileTraceRoundCount) || 0;
  const last = roundCount ? rows[roundCount - 1] : null;
  const pendingTools =
    last && Array.isArray(last.tools) ? last.tools.some((tool) => tool && tool.pending) : false;
  const sameRound = roundCount > 0 && prevCount === roundCount;
  const hasStream = !!(live.streamContent || runEvent?.streamContent);
  if (
    sameRound &&
    (hasStream || !pendingTools) &&
    typeof MOBILE_TRACE_STREAM_INTERVAL_MS === 'number'
  ) {
    return MOBILE_TRACE_STREAM_INTERVAL_MS;
  }
  return MOBILE_TRACE_PUSH_INTERVAL_MS;
}

function pushAgentServiceProgress(live, sessionId, trace, immediate, runEvent) {
  if (!live || !chatRenderApi.agentServiceTaskProgress) return;
  const send = () => {
    const snapshot = live.trace || trace || [];
    const streamContent = live.streamContent || runEvent?.streamContent || '';
    const structureSig = mobileTraceStructureSig(snapshot);
    const streamOnly =
      !!streamContent &&
      structureSig &&
      structureSig === live.lastMobileTraceStructureSig &&
      Array.isArray(snapshot) &&
      snapshot.length > 0;
    live.lastMobileProgressAt = Date.now();
    live.pendingMobileProgressTimer = null;
    live.lastMobileTraceRoundCount = Array.isArray(snapshot) ? snapshot.length : 0;
    live.lastMobileTraceStructureSig = structureSig;
    chatRenderApi.agentServiceTaskProgress({
      requestId: live.agentServiceRequestId || '',
      sessionId,
      trace: streamOnly ? null : cloneTraceForMobile(snapshot),
      streamContent,
      runEvent: runEvent || live.lastEvent || null
    });
  };
  if (immediate) {
    if (live.pendingMobileProgressTimer) {
      clearTimeout(live.pendingMobileProgressTimer);
      live.pendingMobileProgressTimer = null;
    }
    send();
    return;
  }
  const intervalMs = mobileTracePushIntervalMs(live, live.trace || trace || [], runEvent);
  const elapsed = Date.now() - (live.lastMobileProgressAt || 0);
  if (elapsed >= intervalMs) {
    send();
    return;
  }
  if (!live.pendingMobileProgressTimer) {
    live.pendingMobileProgressTimer = setTimeout(send, intervalMs - elapsed);
  }
}

function pushAgentServiceCompletion(live, sessionId, event) {
  if (!live || live.agentServiceRequestId || !chatRenderApi.agentServiceTaskCompleted) return;
  const snapshot = live.trace || event?.trace || [];
  const status =
    event?.type === AGENT_RUN_EVENT_TYPES.ERROR
      ? 'failed'
      : event?.type === AGENT_RUN_EVENT_TYPES.STOPPED
        ? 'stopped'
        : 'completed';
  chatRenderApi.agentServiceTaskCompleted({
    requestId: '',
    sessionId,
    status,
    runId: event?.runId || live.runId || null,
    summary: event?.summary || event?.streamContent || '',
    error: event?.error || '',
    trace: cloneTraceForMobile(snapshot),
    runEvent: event || live.lastEvent || null
  });
}

/** 只结束本轮。live 已是下一轮（有 runId 且与本轮不符 / 本轮 id 为空但槽位已有 id）时跳过。 */
function shouldFinishSessionActiveRun(live, runId) {
  if (!live) return true;
  const liveId = live.runId != null ? String(live.runId) : '';
  const wantId = runId != null ? String(runId) : '';
  if (!wantId) return !liveId;
  if (!liveId) return true;
  return liveId === wantId;
}

function finishSessionActiveRun(sessionId, runId) {
  const live = sessionActiveRuns.get(sessionId);
  if (!shouldFinishSessionActiveRun(live, runId)) return;
  if (live?.pendingMobileProgressTimer) {
    clearTimeout(live.pendingMobileProgressTimer);
    live.pendingMobileProgressTimer = null;
  }
  const sid = String(sessionId || '');
  const queuePending =
    typeof getComposerQueue === 'function' && getComposerQueue(sid).length > 0;
  const wp = live?.workspacePath;
  if (wp && chatRenderApi.setSessionRemoteLease && !queuePending) {
    const s = String(wp);
    if (/^ssh:/i.test(s)) {
      void chatRenderApi.setSessionRemoteLease({ sessionId, active: false, workspacePath: wp }).catch(() => {});
    }
  }
  sessionActiveRuns.delete(sessionId);
  if (sid === String(currentSessionId) && typeof resetActiveRunContextUiState === 'function') {
    resetActiveRunContextUiState(sid);
  }
}
