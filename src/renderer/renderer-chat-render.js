/* global window, document, $, escapeHtml, settings, gwState, gatewayCall, tracePrefs, trackArtifactsFromTrace, clearArtifacts, renderArtifactsList, refreshContextProgress, scheduleContextProgressRefresh, getTextModelId, revokeAttachmentPreview, renderAttachmentChips, tryDetectResumeCheckpoint, showAgentToast, rollbackTurnFiles, prepareTurnForWithdraw, invalidateWorkspaceArtifacts, initMermaidRender, getCurrentUndoTurnId, AGENT_RUN_EVENT_TYPES, createAgentRunEvent, normalizeAgentRunEvent, agentRunEventFromTrace, applyAgentRunEventToLive, cloneTrace, resetActiveRunContextUiState, isActiveSessionSwitch, currentSessionId, maybeSaveRunningTraceCheckpoint, beginArtifactsUiBatch, endArtifactsUiBatch, splitPersistedAssistantTrace, parseTraceFromPersisted, unpackAssistantMeta, forceArtifactsUiRefreshAfterBatch, getAgentLimits, getSessionChangeRowsForAgent, renderChangesPane, collapseChatThinkingTraces, scrollChatToBottom, renderAssistantBubbleContent, dismissToolActivityFloat, initToolActivityFloat, maybeLoadOlderChatMessages, renderChatHistoryEdge, prependOlderMessagesIncrementally, holdChatScrollAfterPrepend, layoutChatNav, chatUserScrollSeq, saveSessionMessageCache, getSessionCacheHasMore, getComposerQueue, chatAutoFollow, chatList, followChatStreamGrowth, isChatNearBottom, isSessionMessageCacheStale, loadChatFromGateway, finishAgentPrepPhase, sessionActiveRuns, pinChatToBottom, lastAssistantBubble, startChatFollowSettle, stopChatFollowSettle, isChatFollowSettling, initChatNav, motionMs, isThinkingDampedFlow, updateLastTurnFloat, refreshGoalPanelIfVisible */
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
    // 阻尼跟随时「还没到位」要继续续帧，否则视口会在半路停住
    const settling = pinStreamingChatToBottom();
    if (settling || Date.now() < chatBottomFollowHoldUntil) {
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
  // 折叠只由 grid-template-rows 驱动（见 styles.css .msg-thinking-outer），
  // 不再有 max-height 过渡。
  return name === 'grid-template-rows';
}

function isThinkingLayoutTransitionTarget(target) {
  return !!(
    target instanceof Element &&
    target.closest(
      '.msg-thinking-outer, .msg-thinking-step, .msg-thinking-round-details, .msg-thinking-round, .msg-thinking-beat'
    )
  );
}

/**
 * 无极阻尼（设置 → 主题 → 无极阻尼）：贴底不再一帧钉死，而是每帧朝目标阻尼逼近 ——
 * 新一行的高度增长被视口连续吸收（瀑布式下淌），不再「整行跳一下」。
 * 时间常数按帧间隔算（120Hz / 60Hz 手感一致），追到 1px 内落回精确贴底。
 * 返回 true 表示这一帧还没到位，调度器据此继续续帧。
 */
var chatDampLastTs = 0;

function dampedChatFollowStep() {
  const el = chatList || document.getElementById('chat-list');
  if (!el) return false;
  const maxScroll = Math.max(0, el.scrollHeight - el.clientHeight);
  const delta = maxScroll - el.scrollTop;
  const now = Date.now();
  const dt = chatDampLastTs ? Math.min(64, Math.max(8, now - chatDampLastTs)) : 16;
  chatDampLastTs = now;
  // 1px 内直接落位：亚像素取整会让「每帧推进 0.1px」变成永远追不到
  if (maxScroll <= 0 || Math.abs(delta) <= 1) {
    el.scrollTop = maxScroll;
    chatDampLastTs = 0;
    updateLastTurnFloat();
    return false;
  }
  const before = el.scrollTop;
  el.scrollTop = before + delta * (1 - Math.exp(-dt / SCROLL_DAMP_TAU_MS));
  if (el.scrollTop === before) {
    // 写不进去（被夹住或取整成 0）：落位收摊，绝不留一条空转的帧链
    el.scrollTop = maxScroll;
    chatDampLastTs = 0;
    updateLastTurnFloat();
    return false;
  }
  // 追帧期间不碰浮条/按钮的显隐：那两颗 UI 读的是 chatAutoFollow（跨帧稳定的用户意图），
  // 逐帧翻转的中间态只会让它们一闪一闪。
  return true;
}

/** @returns {boolean} 是否还需要继续续帧（只有阻尼跟随时可能为 true） */
function pinStreamingChatToBottom() {
  if (typeof getChatAutoFollow === 'function' && !getChatAutoFollow()) return false;
  if (typeof isThinkingDampedFlow === 'function' && isThinkingDampedFlow()) {
    return dampedChatFollowStep();
  }
  pinChatToBottom();
  return false;
}

/**
 * 思考区展开/折叠过渡期间保持贴底：过渡期内高度逐帧变化，
 * 由唯一调度器续期，不再自建第二条 rAF 链（两条链会在同一帧各写一次 scrollTop）。
 */
function startThinkingTransitionPin() {
  // 逐帧跟随的时长与 CSS 折叠时长同源（--motion-slow），再留一帧余量收尾
  requestChatBottomFollow(motionMs('--motion-slow') + 40);
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
  const split = splitPersistedAssistantTrace(raw);
  const inlineTrace = split.trace || [];
  const transientTrace = Array.isArray(m.transientTrace) ? m.transientTrace : [];
  const trace = inlineTrace.length ? inlineTrace : transientTrace;
  if (trace.length) trackArtifactsFromTrace(trace);
  const cp = resolveCheckpointRestoreForAssistant(i);
  // 思考区与正文**同一次渲染**落地：此前把「手里已有 trace」的那几条推迟到一帧后的
  // flush 里补画，而 flush 被下一次切换（代际变化）打断就整批丢掉 —— 表现正是
  // 「正文在、思考区连占位都没有，切回来一下又有了」。账号里能补画的只有
  // `meta.traceRunId` 那条通路（它自带占位），所以这里不再有「稍后补」这个中间态。
  const bubble = appendBubble('assistant', split.content, {
    trace,
    structured: !!meta?.traceRunId && !trace.length && !split.thinkingRaw,
    forceScroll,
    skipScroll,
    undoTurnId: cp?.undoTurnId || null,
    checkpointRestore: !!cp
  });
  if (!trace.length && meta?.traceRunId) {
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
  // 「目标」面板与气泡区同属「这个会话长什么样」：切会话 / 重绘后要按新会话重取一次。
  // 面板不在前台时不必打这次 IPC（`goalPanelVisible` 在 `renderer-goal-panel.js` 里是
  // 可见性的唯一来源；可见时本来就有 2s 心跳）。
  if (typeof refreshGoalPanelIfVisible === 'function') refreshGoalPanelIfVisible();
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

/**
 * 只把「更早的一页」画上去，不重画整段对话 —— 往上翻一页之所以丝滑，全靠这一步。
 *
 * 整屏重渲染的代价是：先隐藏整块、清空、把每条消息（Markdown / 图 / mermaid / 朗读条）
 * 重新建一遍，最后再补滚动位置 —— 用户看到的就是「闪一下 + 跳一下」。这里只渲染新增的
 * 那几条，插到原来第一条消息前面：已有节点一个都不动，不需要隐藏。
 *
 * 位置不在这里算：插完之后由 `holdChatScrollAfterPrepend` 按「插入前的位置 + 长出来的高度」
 * 连钉几帧（图和 mermaid 会随后继续长高），这一份逻辑只负责 DOM。
 * 渲染仍走 `appendRenderedMessageAtIndex`（气泡的唯一画法），所以不会和整屏渲染长歪。
 * @param {string} sessionId 当前会话
 * @param {number} olderCount 刚拼进 `messages` 开头的新条数
 * @returns {{ anchor: Element, portTopBefore: number, inserted: Element[] } | null} 成功时交出锚点
 *   （第一条旧消息）、它插入前在滚动区里的相对位置，以及刚插进去的那些节点；null 表示退回整屏重渲染
 */
function prependOlderMessagesIncrementally(sessionId, olderCount) {
  if (!chatList || !(olderCount > 0)) return null;
  const anchor = chatList.querySelector(':scope > .msg-turn, :scope > .msg, :scope > .msg-trigger');
  // 一条已有消息都没有（空会话 / 占位符）：没有可比对的锚点，交给整屏重渲染
  if (!anchor) return null;
  // 锚点在「滚动区」里的相对位置：插入之后要让它待回同一个地方
  const portTopBefore = anchor.getBoundingClientRect().top - chatList.getBoundingClientRect().top;
  // 新行先从尾部画出来（appendRenderedMessageAtIndex 只往列表末尾追加），随后再整体搬到锚点前面
  const tailBefore = chatList.lastElementChild;
  beginChatHistoryArtifactsBatch();
  try {
    for (let i = 0; i < olderCount; i++) {
      appendRenderedMessageAtIndex(i, {
        forceScroll: false,
        skipScroll: true,
        sessionAtRender: sessionId
      });
    }
  } catch (e) {
    // 中途画不出来就撤销这一批：别把半截内容留在列表尾部，交给整屏重渲染
    let stray = tailBefore ? tailBefore.nextSibling : chatList.firstChild;
    while (stray) {
      const next = stray.nextSibling;
      stray.remove();
      stray = next;
    }
    console.warn('增量插入失败，退回整屏重渲染:', e);
    return null;
  } finally {
    endChatHistoryArtifactsBatch();
  }
  let node = tailBefore ? tailBefore.nextSibling : chatList.firstChild;
  if (!node) return null;
  const inserted = [];
  while (node) {
    const next = node.nextSibling;
    chatList.insertBefore(node, anchor);
    inserted.push(node);
    node = next;
  }
  // 刻度带：内容变长了，位置与高亮要立刻按新布局重量一次（刻度本身不重建，见 renderer-chat-nav.js）
  if (typeof layoutChatNav === 'function') layoutChatNav();
  return { anchor, portTopBefore, inserted };
}

/**
 * 往上插了一页之后，把阅读位置按住 —— 只纠偏，不设绝对位置。
 *
 * 为什么不是算一次就完：聊天区关掉了浏览器自带的 scroll anchoring（`overflow-anchor: none`，
 * 流式高度震荡要用），而新插进来的图 / mermaid / 迟到的思考区（`hydrateAssistantTraceFromStore`）
 * 会在随后几百毫秒里继续长高 —— 长在视野上方就会把内容顶下去。
 *
 * 所以这一小段时间里只做一件事：**看锚点相对滚动区的位置有没有漂**，漂多少就补多少。
 * 漂移是相对量，量出来是 0 就什么都不写 —— 绝不会像"算一个绝对目标"那样把视野钉到某个位置上去。
 *
 * 谁动了滚动，只认 `chatUserScrollSeq`（用户滚动的唯一来源）：
 *   - **用户自己滚的** → 认下他的位置，目标跟着挪，绝不拽回；
 *   - **别人动的**（例如别处一次 `restoreSessionScrollPosition` 把位置还原成 0）→ 按漂移纠回来。
 * 纠完顺手把「记着的阅读位置」也同步一次，免得后面的还原又照着旧位置把视野拉走。
 * @param {{ anchor?: Element | null, portTopBefore?: number,
 *   inserted?: Element[] }} base 锚点、它在滚动区里的原始位置、刚插入的节点
 */
function holdChatScrollAfterPrepend(base) {
  const anchor = base && base.anchor;
  if (!chatList || !anchor || !Number.isFinite(base.portTopBefore)) return;
  const inPort = () => anchor.getBoundingClientRect().top - chatList.getBoundingClientRect().top;
  let want = base.portTopBefore;
  let applied = chatList.scrollTop;
  let userSeq = typeof chatUserScrollSeq === 'number' ? chatUserScrollSeq : 0;
  const correct = () => {
    if (!chatList || !anchor.isConnected) return;
    const current = chatList.scrollTop;
    if (Math.abs(current - applied) >= 1) {
      if ((typeof chatUserScrollSeq === 'number' ? chatUserScrollSeq : 0) !== userSeq) {
        // 用户自己滚的：目标跟着挪（下面的漂移随后就是 0，等于什么都不写）
        want -= current - applied;
        userSeq = chatUserScrollSeq;
      }
      applied = current;
    }
    const drift = inPort() - want;
    if (Math.abs(drift) >= 1) {
      chatList.scrollTop += drift;
      applied = chatList.scrollTop;
      if (typeof captureSessionScrollPosition === 'function') {
        captureSessionScrollPosition(currentSessionId, { force: true });
      }
    }
  };
  correct();
  // 约 1.2s（60fps）：够覆盖思考区补水、mermaid 落位这几拍，之后就不再多管
  let framesLeft = 72;
  const tick = () => {
    correct();
    framesLeft -= 1;
    if (framesLeft > 0 && typeof requestAnimationFrame === 'function') requestAnimationFrame(tick);
  };
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(tick);
  // 事件驱动的另一条线：刚插进去的那几条用 ResizeObserver 盯着 —— 异步长高的回调发生在
  // **绘制之前**，比每帧采样更不容易漏拍；这段时间过了就撤掉观察。
  const inserted = Array.isArray(base.inserted) ? base.inserted : [];
  if (typeof ResizeObserver === 'function' && inserted.length) {
    let observer = null;
    try {
      observer = new ResizeObserver(() => {
        correct();
      });
      for (const el of inserted) observer.observe(el);
    } catch {
      observer = null;
    }
    if (observer && typeof setTimeout === 'function') {
      setTimeout(() => {
        if (observer) {
          observer.disconnect();
          observer = null;
        }
      }, 1500);
    }
  }
}

async function renderChatFromMessagesYielding(opts = {}) {
  const switchGen = opts.switchGen;
  const forceScroll = opts.forceScroll !== false;
  const transition = opts.transition === true;
  const sessionAtRender = opts.sessionId != null ? String(opts.sessionId) : String(currentSessionId);
  if (!chatList) return false;
  if (shouldAbortChatRender(switchGen)) return false;
  if (sessionAtRender !== String(currentSessionId)) return false;

  beginSessionScrollCaptureSuppression();
  const hiddenToken = beginHiddenChatRender(!forceScroll);
  beginChatHistoryArtifactsBatch();
  let painted = false;
  try {
    if (typeof revokeAnswerFigureBlobs === 'function') revokeAnswerFigureBlobs(chatList);
    chatList.innerHTML = '';
    clearArtifacts();
    if (!messages.length) {
      finalizeChatRenderAfterMessages({ forceScroll, sessionId: sessionAtRender });
      focusChatInput();
      painted = true;
      return true;
    }

    const historyEdge = typeof renderChatHistoryEdge === 'function' ? renderChatHistoryEdge() : null;
    if (historyEdge) chatList.append(historyEdge);

    for (let i = 0; i < messages.length; i++) {
      if (shouldAbortChatRender(switchGen)) return false;
      if (sessionAtRender !== String(currentSessionId)) return false;
      appendRenderedMessageAtIndex(i, {
        forceScroll,
        skipScroll: !forceScroll,
        sessionAtRender
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
    endHiddenChatRender(hiddenToken, { transition });
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
    if (typeof revokeAnswerFigureBlobs === 'function') revokeAnswerFigureBlobs(chatList);
    chatList.innerHTML = '';
    clearArtifacts();
    if (!messages.length) {
      finalizeChatRenderAfterMessages({ forceScroll, sessionId });
      focusChatInput();
      return;
    }
    const historyEdge = typeof renderChatHistoryEdge === 'function' ? renderChatHistoryEdge() : null;
    if (historyEdge) chatList.append(historyEdge);
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
