/* global unpackUserMessageContent, unpackAssistantMeta, splitPersistedAssistantTrace, buildToolTraceFallbackReply, compactPlainText, messages, buildSessionChatHistoryFromMessages, buildCompletionMessagesFromHistory, assistantTextFromMessage, persistableAssistantText, formatCompactionArchiveBlock, mergeCompactionBlockIntoTurnRide, reprojectContinueLoopMessages, gwState, gatewayCall, CTX_LIMITS */
'use strict';

function getSessionContextHelpers() {
  return {
    unpackAssistantMeta,
    splitPersistedAssistantTrace,
    // 账本正文只认 content + 工具事实兜底；思考不参与正文投影（D1），故不再注入思考兜底回调。
    toolFallback: buildToolTraceFallbackReply,
    compactPlainText,
    unpackUserContent(raw) {
      return String(unpackUserMessageContent(raw).content || '').trim();
    }
  };
}

function assistantTextForContext(m) {
  return assistantTextFromMessage(m, getSessionContextHelpers());
}

function persistAssistantTranscriptText(reply, trace) {
  return persistableAssistantText(reply, trace, getSessionContextHelpers());
}

async function refreshTurnRideFromArchive(turnRide, sessionId) {
  const sid = String(sessionId || '').trim();
  const ride = String(turnRide || '');
  if (!sid || !gwState || !gwState.authed || typeof gatewayCall !== 'function') return ride;
  if (typeof formatCompactionArchiveBlock !== 'function') return ride;
  try {
    const rows = await gatewayCall('memory.compaction_recent', { sessionId: sid, limit: 1 });
    const block = formatCompactionArchiveBlock(rows);
    return typeof mergeCompactionBlockIntoTurnRide === 'function'
      ? mergeCompactionBlockIntoTurnRide(ride, block)
      : ride;
  } catch {
    return ride;
  }
}

function reprojectContinuePayloadMessages(prefixMessages, liveLoopMessages, turnRide) {
  if (typeof reprojectContinueLoopMessages !== 'function') {
    return Array.isArray(liveLoopMessages) ? liveLoopMessages.slice() : [];
  }
  return reprojectContinueLoopMessages({
    prefixMessages,
    liveLoopMessages,
    turnRide
  });
}

function buildSessionChatHistoryBlock(opts = {}) {
  const list = Array.isArray(opts.messages) ? opts.messages : messages;
  return buildSessionChatHistoryFromMessages(list, opts, getSessionContextHelpers());
}

function completionCapOpts(audit) {
  const L = typeof CTX_LIMITS !== 'undefined' && CTX_LIMITS ? CTX_LIMITS : {};
  /** @type {Record<string, any>} */
  const caps = {
    historyMaxChars: L.COMPLETION_HISTORY_MAX_CHARS,
    messageMaxChars: L.COMPLETION_MESSAGE_MAX_CHARS,
    lastUserMaxChars: L.COMPLETION_LAST_USER_MAX_CHARS,
    turnRideMaxChars: L.COMPLETION_TURN_RIDE_MAX_CHARS,
    requestMaxChars: L.LLM_REQUEST_MAX_CHARS,
    recentTurns: L.COMPLETION_RECENT_TURNS,
    foldedMaxChars: L.COMPLETION_FOLDED_MAX_CHARS,
    toolResultMaxChars: L.TOOL_RESULT_MAX_JSON
  };
  // 审计出参（可选）：折叠/裁剪发生在这一层，Main 无法重算，只能由这里把事实带出去。
  if (audit && typeof audit === 'object') caps.audit = audit;
  return caps;
}

/**
 * @param {object} [audit] 可选：把「折叠了几条 / 丢了几个」写进这个对象（见 request-snapshot）
 */
function buildCompletionMessages(sysContent, prepared, includeImages, turnRide, historyMessages, audit) {
  const list = Array.isArray(historyMessages) ? historyMessages : messages;
  const caps = completionCapOpts(audit);
  if (audit) {
    audit.sysStableChars = typeof sysContent === 'string' ? sysContent.length : 0;
    audit.turnRideChars = typeof turnRide === 'string' ? turnRide.length : 0;
    audit.historyMessages = list.length;
  }
  return buildCompletionMessagesFromHistory(
    list,
    sysContent,
    prepared,
    includeImages,
    getSessionContextHelpers(),
    turnRide,
    caps
  );
}

if (typeof window !== 'undefined') {
  window.getSessionContextHelpers = getSessionContextHelpers;
  window.assistantTextForContext = assistantTextForContext;
  window.persistAssistantTranscriptText = persistAssistantTranscriptText;
  window.refreshTurnRideFromArchive = refreshTurnRideFromArchive;
  window.reprojectContinuePayloadMessages = reprojectContinuePayloadMessages;
  window.buildSessionChatHistoryBlock = buildSessionChatHistoryBlock;
  window.buildCompletionMessages = buildCompletionMessages;
}
