/* global window, document, $, escapeHtml, settings, gwState, gatewayCall, tracePrefs, clearArtifacts, refreshContextProgress, scheduleContextProgressRefresh, getTextModelId, revokeAttachmentPreview, renderAttachmentChips, tryDetectResumeCheckpoint, showAgentToast, rollbackTurnFiles, prepareTurnForWithdraw, invalidateWorkspaceArtifacts, initMermaidRender, getCurrentUndoTurnId, AGENT_RUN_EVENT_TYPES, createAgentRunEvent, normalizeAgentRunEvent, agentRunEventFromTrace, applyAgentRunEventToLive, cloneTrace, resetActiveRunContextUiState, isActiveSessionSwitch, currentSessionId, maybeSaveRunningTraceCheckpoint, beginArtifactsUiBatch, endArtifactsUiBatch, splitPersistedAssistantTrace, unpackAssistantMeta, getAgentLimits, getSessionChangeRowsForAgent, renderChangesPane, collapseChatThinkingTraces, scrollChatToBottom, dismissToolActivityFloat, initToolActivityFloat, maybeLoadOlderChatMessages, saveSessionMessageCache, getSessionCacheHasMore, getComposerQueue, chatAutoFollow, chatList, followChatStreamGrowth, isChatNearBottom, isSessionMessageCacheStale, loadChatFromGateway, finishAgentPrepPhase, sessionActiveRuns */
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
/**
 * 用户「自己动了滚动」的序号：唯一判定点 `markChatUserScrollIntent` 每次 +1。
 * 朗读跟随只认这个序号 —— 程序自己滚出来的 scroll 事件不算用户接管，
 * 也不去数第二遍 wheel / touch / key（另写一份判定就会有第二套口径）。
 */
var chatUserScrollSeq = 0;
/** 收尾跟底窗口：观察最新气泡，捕获 mermaid / 图片解码等异步落位带来的高度变化 */
var chatFollowSettleObserver = null;
var chatFollowSettleAnchorEl = null;
var chatFollowSettleDeadlineTimer = null;
var CHAT_FOLLOW_SETTLE_MAX_MS = 5000;
/** Yield to the event loop every N messages during session switch render. */
var CHAT_HISTORY_RENDER_YIELD_EVERY = 24;

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

/**
 * 丢掉某个会话记着的阅读位置。
 *
 * 窗口被重置回首屏那一段时用它：旧位置指向的是一段已经不在窗口里的内容，
 * 留着只会让下次进来跳到中间，而不是落在这段窗口的底部。
 */
function clearSessionScrollPosition(sessionId) {
  const key = String(sessionId || '');
  if (key) sessionScrollPositions.delete(key);
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
  // 切会话前先掐掉进行中的平滑回底：它的 900ms 兜底定时器到点会无条件 pinChatToBottom，
  // 把刚还原好位置的新会话再钉到底部（浮条也会被 pending 压制着不出现）。
  cancelChatScrollToBottom();
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
        // 落点即底部：后续异步落位（mermaid / 图片）继续跟
        if (typeof startChatFollowSettle === 'function') startChatFollowSettle();
      } else if (saved.atBottom) {
        chatList.scrollTop = maxTop;
        setChatAutoFollow(true);
        if (typeof startChatFollowSettle === 'function') startChatFollowSettle();
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
  updateChatScrollBottomBtn();
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

/** 平滑回底进行中：期间浮条恒隐藏，否则滚动途中「仍在半路」会把浮条立刻闪回来 */
var chatScrollToBottomPending = false;
var chatScrollBottomSettleTimer = null;

/**
 * 「滑到底部」浮条显隐的唯一判定：不在底部就出现，点击后平滑回底并消失。
 * 跟着流式跑的时候（chatAutoFollow）根本不需要这颗按钮 —— 视口本来就归我们管，
 * 阻尼追帧造成的「暂时不在底部」是动画中间态，不能当成「用户离开了底部」。
 * 判定用 chatAutoFollow（跨帧稳定的用户意图）而不是任何逐帧翻转的中间量：
 * 逐帧状态位会让浮条/按钮按 delta 节奏一闪一闪。
 */
function updateChatScrollBottomBtn() {
  const btn = $('chat-scroll-bottom');
  if (!btn) return;
  const el = chatList || document.getElementById('chat-list');
  const hide =
    !el ||
    chatScrollToBottomPending ||
    (typeof getChatAutoFollow === 'function' && getChatAutoFollow()) ||
    isChatNearBottom(el);
  // 幂等写入：本函数在流式跟底时每帧都会走到，避免重复写同一个属性
  if (btn.hidden !== hide) btn.hidden = hide;
}

/**
 * 放弃进行中的平滑回底（切会话 / 列表重建时用）。
 * 只清状态，不钉底 —— 与 `finishChatScrollToBottom` 的区别就在这。
 */
function cancelChatScrollToBottom() {
  if (!chatScrollToBottomPending) return false;
  chatScrollToBottomPending = false;
  if (chatScrollBottomSettleTimer) {
    clearTimeout(chatScrollBottomSettleTimer);
    chatScrollBottomSettleTimer = null;
  }
  detachChatScrollEndListener();
  updateChatScrollBottomBtn();
  return true;
}

function finishChatScrollToBottom() {
  if (!chatScrollToBottomPending) return;
  chatScrollToBottomPending = false;
  if (chatScrollBottomSettleTimer) {
    clearTimeout(chatScrollBottomSettleTimer);
    chatScrollBottomSettleTimer = null;
  }
  detachChatScrollEndListener();
  // 平滑期间内容可能继续长高：收尾用唯一钉底原语补一次绝对贴底
  pinChatToBottom();
  updateChatScrollBottomBtn();
}

/** 上一次平滑回底挂的 scrollend 监听（具名才能摘：匿名 once 在取消路径上永远摘不掉）。 */
let chatScrollEndTarget = null;

function detachChatScrollEndListener() {
  if (!chatScrollEndTarget) return;
  try {
    chatScrollEndTarget.removeEventListener('scrollend', finishChatScrollToBottom);
  } catch {
    /* ignore */
  }
  chatScrollEndTarget = null;
}

function scrollChatToBottomSmooth() {
  const el = chatList || document.getElementById('chat-list');
  if (!el) return;
  chatScrollToBottomPending = true;
  updateChatScrollBottomBtn();
  setChatAutoFollow(true);
  const target = Math.max(0, el.scrollHeight - el.clientHeight);
  if (target - el.scrollTop <= 1) {
    finishChatScrollToBottom();
    return;
  }
  el.scrollTo({ top: target, behavior: 'smooth' });
  if (chatScrollBottomSettleTimer) clearTimeout(chatScrollBottomSettleTimer);
  detachChatScrollEndListener();
  chatScrollEndTarget = el;
  el.addEventListener('scrollend', finishChatScrollToBottom, { once: true });
  // 兜底：极长距离或不支持 scrollend 时，到点直接收尾
  chatScrollBottomSettleTimer = setTimeout(finishChatScrollToBottom, 900);
}

function initChatScrollBottomBtn() {
  const btn = $('chat-scroll-bottom');
  if (!btn || btn.dataset.scrollBottomBound === '1') return;
  btn.dataset.scrollBottomBound = '1';
  btn.addEventListener('click', scrollChatToBottomSmooth);
}

/** 唯一「钉底」原语：写 scrollTop、同步流式跟随基线、刷新「回到底部」浮标 */
function pinChatToBottom() {
  const el = chatList || document.getElementById('chat-list');
  if (!el) return false;
  el.scrollTop = Math.max(0, el.scrollHeight - el.clientHeight);
  updateLastTurnFloat();
  return true;
}

/** 最新助手气泡（assistant 直接挂在 #chat-list 下） */
function lastAssistantBubble() {
  const el = chatList || document.getElementById('chat-list');
  if (!el) return null;
  const bubbles = el.querySelectorAll(':scope > .msg.assistant');
  return bubbles.length ? bubbles[bubbles.length - 1] : null;
}

function isChatFollowSettling() {
  return !!chatFollowSettleObserver;
}

/**
 * 收尾跟底窗口：回答的最终高度（mermaid、图片解码、字体）常常在
 * `ensureChatScrollAfterLayout` 之后才落位，一次性滚动会停在半路。
 * 这里观察最新气泡，内容每次变高就重钉，直到窗口到期 / 回合被重绘 / 用户接管。
 */
function startChatFollowSettle(opts = {}) {
  stopChatFollowSettle({ capture: false });
  if (typeof ResizeObserver !== 'function') return;
  const anchor = opts.anchor || lastAssistantBubble();
  if (!anchor) return;
  const maxMs = Number(opts.maxMs) > 0 ? Number(opts.maxMs) : CHAT_FOLLOW_SETTLE_MAX_MS;
  chatFollowSettleAnchorEl = anchor;
  chatFollowSettleObserver = new ResizeObserver(() => nudgeChatFollowSettle());
  chatFollowSettleObserver.observe(anchor);
  chatFollowSettleDeadlineTimer = setTimeout(() => {
    chatFollowSettleDeadlineTimer = null;
    stopChatFollowSettle();
  }, maxMs);
}

function stopChatFollowSettle(opts = {}) {
  if (chatFollowSettleDeadlineTimer) {
    clearTimeout(chatFollowSettleDeadlineTimer);
    chatFollowSettleDeadlineTimer = null;
  }
  if (chatFollowSettleObserver) {
    chatFollowSettleObserver.disconnect();
    chatFollowSettleObserver = null;
  }
  chatFollowSettleAnchorEl = null;
  if (opts.capture !== false) captureSessionScrollPosition(currentSessionId, { force: true });
}

/** 跟底窗口内唯一判定：锚点失效或用户接管就收摊，否则重钉 */
function nudgeChatFollowSettle() {
  if (!chatFollowSettleObserver) return;
  const anchor = chatFollowSettleAnchorEl;
  if (!anchor || !anchor.isConnected || anchor !== lastAssistantBubble()) {
    stopChatFollowSettle();
    return;
  }
  if (typeof getChatAutoFollow === 'function' && !getChatAutoFollow()) {
    stopChatFollowSettle({ capture: false });
    return;
  }
  pinChatToBottom();
}

function markChatUserScrollIntent() {
  chatUserScrollIntent = true;
  chatUserScrollSeq += 1;
}

function updateChatAutoFollowFromScroll() {
  if (!chatList) return;
  updateChatScrollBottomBtn();
  if (isSessionScrollCaptureSuppressed()) {
    updateLastTurnFloat();
    return;
  }
  const sending = typeof isCurrentSessionSending === 'function' && isCurrentSessionSending();
  if (sending && !chatUserScrollIntent) {
    updateLastTurnFloat();
    return;
  }
  if (chatUserScrollIntent) {
    chatUserScrollIntent = false;
    // 用户主动接管滚动：立刻结束收尾跟底，别把视口抢回来
    if (isChatFollowSettling()) stopChatFollowSettle({ capture: false });
  } else if (isChatFollowSettling()) {
    // 跟底窗口里的滚动是我们自己钉出来的（正文还在长高），不代表用户接管，
    // 也不该据此把 autoFollow 判成 false —— 否则后续长高就再也钉不回去。
    updateLastTurnFloat();
    return;
  }
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

/** 朗读视野跟随的三个状态：idle（没在朗读）/ undecided（还没判起点）/ follow / off（已让位） */
var chatReadingFollowMode = 'idle';
/** 本次朗读开始时的用户滚动序号（`chatUserScrollSeq` 一变就是用户接管了） */
var chatReadingFollowSeq = 0;

/** 一段朗读开始：重新判「起点在不在视野里」（`playTtsText` 与本函数成对）。 */
function beginChatReadingFollow() {
  chatReadingFollowMode = 'undecided';
  chatReadingFollowSeq = chatUserScrollSeq;
}

/** 一段朗读结束：回到 idle，之后迟到的 range 不再动视口。 */
function endChatReadingFollow() {
  chatReadingFollowMode = 'idle';
}

/**
 * 朗读（TTS）念到哪一句时的视野跟随：把**正在念的这一句**带进视野，判定只有这一处
 * （`renderer-tts.js` 只交出 range，不自己算几何）。三条边界：
 *
 * 1. **起点必须在视野里。** 起点在视野外（典型：自动朗读一条长回复，而视口停在这条回复的
 *    末尾）说明用户在看别处 —— 整段一次都不跟随。否则第一块合成回来那一拍，
 *    视口会从用户眼前被搬到回复开头。
 * 2. **用户接管就永久让位。** `chatUserScrollSeq` 一变（wheel / 触摸 / 键盘 / 拖滚动条，
 *    唯一来源 `markChatUserScrollIntent`），这一段朗读不再碰视口：用户滚到哪就停在哪。
 *    朗读自己滚出来的 scroll 事件不改变这个序号（那是程序在滚，不是用户在滚）。
 * 3. **只往下带、不回拽。** 念到视野上方时立刻收摊（用户已经看下面去了），否则每念一句
 *    都会把视口抢回正在念的位置 —— 这正是「下滑内容时朗读抢视野」的成因。
 *
 * 为什么不让调用方每次自己判断「这一句可不可见」：可见与否不是用户意图，状态必须在整段
 * 朗读里连续（一次判断会得出「看不见就居中」，那就又变回每句抢一次）。
 *
 * @param {Range|null} range 正在念的这一句在 DOM 上的范围
 */
function followChatReadingRange(range) {
  if (chatReadingFollowMode !== 'undecided' && chatReadingFollowMode !== 'follow') return;
  const host = chatList || document.getElementById('chat-list');
  if (!host || typeof host.getBoundingClientRect !== 'function') return;
  if (!range || typeof range.getBoundingClientRect !== 'function') return;
  if (chatUserScrollSeq !== chatReadingFollowSeq) {
    chatReadingFollowMode = 'off';
    return;
  }
  const rect = range.getBoundingClientRect();
  if (!rect.height && !rect.width) return;
  const box = host.getBoundingClientRect();
  // 半句露在边缘就算「看得见」：跟随的边界取松，宁可不动也不要把视口挪一格
  const above = rect.bottom <= box.top + 8;
  const below = rect.top >= box.bottom - 8;
  const inView = !above && !below;
  if (chatReadingFollowMode === 'undecided') {
    chatReadingFollowMode = inView ? 'follow' : 'off';
    return;
  }
  if (inView) return;
  if (above) {
    // 念到视野上方：用户已经看下面去了，这一段从此不再碰视口
    chatReadingFollowMode = 'off';
    return;
  }
  const delta = rect.top - box.top - box.height / 2 + rect.height / 2;
  try {
    host.scrollTo({ top: Math.max(0, host.scrollTop + delta), behavior: 'smooth' });
  } catch {
    // ignore：老滚动容器 / 元素已失效
  }
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
  initChatScrollBottomBtn();
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
