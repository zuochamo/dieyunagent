/* global window, document, $, escapeHtml, settings, gwState, gatewayCall, tracePrefs, trackArtifactsFromTrace, clearArtifacts, renderArtifactsList, refreshContextProgress, scheduleContextProgressRefresh, getTextModelId, revokeAttachmentPreview, renderAttachmentChips, tryDetectResumeCheckpoint, showAgentToast, rollbackTurnFiles, prepareTurnForWithdraw, invalidateWorkspaceArtifacts, initMermaidRender, getCurrentUndoTurnId, AGENT_RUN_EVENT_TYPES, createAgentRunEvent, normalizeAgentRunEvent, agentRunEventFromTrace, applyAgentRunEventToLive, cloneTrace, resetActiveRunContextUiState, isActiveSessionSwitch, currentSessionId, maybeSaveRunningTraceCheckpoint, beginArtifactsUiBatch, endArtifactsUiBatch, splitPersistedAssistantTrace, parseTraceFromPersisted, unpackAssistantMeta, forceArtifactsUiRefreshAfterBatch, getAgentLimits, getSessionChangeRowsForAgent, renderChangesPane, collapseChatThinkingTraces, scrollChatToBottom, renderAssistantBubbleContent, dismissToolActivityFloat, initToolActivityFloat, maybeLoadOlderChatMessages, saveSessionMessageCache, getSessionCacheHasMore, getComposerQueue, chatAutoFollow, chatList, followChatStreamGrowth, isChatNearBottom, isSessionMessageCacheStale, loadChatFromGateway, finishAgentPrepPhase, sessionActiveRuns, pinChatToBottom, lastAssistantBubble, startChatFollowSettle, stopChatFollowSettle, isChatFollowSettling, initChatNav */
'use strict';


/**
 * 「贴底」的唯一调度器：同一帧最多写一次 scrollTop，策略唯一（绝对贴底）。
 *
 * 这里曾有三套策略抢同一个 scrollTop —— 流式正文按增量 delta 跟随、思考区展开/折叠
 * 过渡期自建一条 rAF 链每帧 pin、以及 renderer-thinking-trace 里一个裸 rAF 无条件刷
 * 「上次 scrollHeight」基线。基线被互相覆盖后增量跟随的前提就不成立：视口在底部附近
 * 反复回缩再前进，滚动条 thumb 因此表现为频繁跳动。
 * 现在所有触发源只提交一次请求，由这里合并、并按需在过渡窗口内续期。
 */
var chatBottomFollowRaf = null;
var chatBottomFollowHoldUntil = 0;

/**
 * @param {number} holdMs 需要逐帧跟随的时长（思考区展开/折叠期间高度逐帧变化）
 */
function requestChatBottomFollow(holdMs = 0) {
  if (holdMs > 0) {
    chatBottomFollowHoldUntil = Math.max(chatBottomFollowHoldUntil, Date.now() + holdMs);
  }
  if (chatBottomFollowRaf) return;
  const tick = () => {
    chatBottomFollowRaf = null;
    pinStreamingChatToBottom();
    if (Date.now() < chatBottomFollowHoldUntil) {
      chatBottomFollowRaf = requestAnimationFrame(tick);
    }
  };
  chatBottomFollowRaf = requestAnimationFrame(tick);
}

function followChatStreamGrowth() {
  requestChatBottomFollow();
}

function scheduleStreamingChatFollow() {
  requestChatBottomFollow();
  // 字体 / 图片 / mermaid 可能让高度再晚一帧才落位，补一次请求
  requestAnimationFrame(() => requestChatBottomFollow());
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
  if (typeof getChatAutoFollow === 'function' && !getChatAutoFollow()) return;
  pinChatToBottom();
}

/**
 * 思考区展开/折叠过渡期间保持贴底：过渡期内高度逐帧变化，
 * 由唯一调度器续期，不再自建第二条 rAF 链（两条链会在同一帧各写一次 scrollTop）。
 */
function startThinkingTransitionPin() {
  requestChatBottomFollow(THINKING_COLLAPSE_FOLLOW_MS);
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
  requestChatBottomFollow();
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
    pinChatToBottom();
    setChatAutoFollow(true);
    captureSessionScrollPosition(currentSessionId, { force: true });
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
    const anchor = lastAssistantBubble();
    if (anchor) {
      // 回答此刻的高度可能还没到位（mermaid / 图片异步落位），
      // 所以不做一次性 scrollIntoView 测量，改为钉底 + 布局驱动的跟底窗口。
      pinChatToBottom();
      setChatAutoFollow(true);
      captureSessionScrollPosition(currentSessionId, { force: true });
      startChatFollowSettle({ anchor });
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
    // 补齐思考区后正文会重排；最新回合还可能异步长高（mermaid / 图片），教给跟底窗口收尾
    if (bubble === lastAssistantBubble() && (!saved || saved.atBottom)) {
      if (typeof startChatFollowSettle === 'function') startChatFollowSettle({ anchor: bubble });
    }
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
    const footer = turnDone
      ? buildMsgTurnFooter(userMeta, {
          canWithdraw: canWithdrawUserTurn(i),
          msgIndex: i,
          copyText: resolveUserTurnCopyText(m, userMeta)
        })
      : null;
    // 非人类触发的一轮（定时计划 / 目标续跑）：归因只在 user 行的 meta 里，
    // 命中就渲染成触发条 —— 否则回放/交接时这轮会看起来像用户自己打的字。
    const trigger = packedMeta?.trigger || null;
    if (trigger) {
      const ts = Date.parse(trigger.at) || Number(m.created_at) || 0;
      appendTriggerNotice(display, { trigger, ts, footer, forceScroll, skipScroll });
      return;
    }
    appendUserTurn(display, { forceScroll, skipScroll, attachments, ...(footer ? { footer } : {}) });
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
    renderArtifactsList({ skipRefresh: true });
  }
  if (forceScroll) {
    scrollChatToBottom({ force: true });
  } else {
    restoreSessionScrollPosition(sessionId, { immediate: true });
  }
  updateLastTurnFloat();
}

/** 历史渲染批次收尾：面板「变更」页按需重绘（不再驱动 live-write，也不自动打开侧栏） */
function refreshChangesPaneAfterRender() {
  const hasSessionChanges =
    typeof getSessionChangeRowsForAgent === 'function' && getSessionChangeRowsForAgent().length > 0;
  if (!hasSessionChanges) return;
  if (typeof window.patchChangesPane === 'function') window.patchChangesPane();
  else if (typeof renderChangesPane === 'function') renderChangesPane();
}

function beginChatHistoryArtifactsBatch() {
  if (typeof beginArtifactsUiBatch === 'function') beginArtifactsUiBatch();
}

function endChatHistoryArtifactsBatch() {
  if (typeof forceArtifactsUiRefreshAfterBatch === 'function') forceArtifactsUiRefreshAfterBatch();
  if (typeof endArtifactsUiBatch === 'function') endArtifactsUiBatch();
  refreshChangesPaneAfterRender();
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
  if (typeof initChatNav === 'function') initChatNav();
  if (typeof initMermaidRender === 'function') initMermaidRender();
}

window.captureSessionScrollPosition = captureSessionScrollPosition;
window.restoreSessionScrollPosition = restoreSessionScrollPosition;
window.withSessionScrollCaptureSuppressed = withSessionScrollCaptureSuppressed;
window.ensureChatScrollAfterLayout = ensureChatScrollAfterLayout;
window.scheduleStreamingChatFollow = scheduleStreamingChatFollow;
window.setStreamingDetailsOpen = setStreamingDetailsOpen;
window.startThinkingTransitionPin = startThinkingTransitionPin;
window.reconcileSessionLiveRunUi = reconcileSessionLiveRunUi;
