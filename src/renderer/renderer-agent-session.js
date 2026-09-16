/* global unpackUserMessageContent, unpackAssistantMeta, splitPersistedAssistantTrace, buildToolTraceFallbackReply, buildTraceThoughtFallbackReply, compactPlainText, messages, buildSessionChatHistoryFromMessages, buildCompletionMessagesFromHistory, assistantTextFromMessage, persistableAssistantText, formatCompactionArchiveBlock, mergeCompactionBlockIntoTurnRide, reprojectContinueLoopMessages, gwState, gatewayCall, CTX_LIMITS */
'use strict';

function getSessionContextHelpers() {
  return {
    unpackAssistantMeta,
    splitPersistedAssistantTrace,
    toolFallback: buildToolTraceFallbackReply,
    thoughtFallback: buildTraceThoughtFallbackReply,
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

function completionCapOpts() {
  const L = typeof CTX_LIMITS !== 'undefined' && CTX_LIMITS ? CTX_LIMITS : {};
  return {
    historyMaxChars: L.COMPLETION_HISTORY_MAX_CHARS,
    messageMaxChars: L.COMPLETION_MESSAGE_MAX_CHARS,
    lastUserMaxChars: L.COMPLETION_LAST_USER_MAX_CHARS,
    turnRideMaxChars: L.COMPLETION_TURN_RIDE_MAX_CHARS,
    requestMaxChars: L.LLM_REQUEST_MAX_CHARS,
    recentTurns: L.COMPLETION_RECENT_TURNS,
    foldedMaxChars: L.COMPLETION_FOLDED_MAX_CHARS,
    toolResultMaxChars: L.TOOL_RESULT_MAX_JSON
  };
}

function buildCompletionMessages(sysContent, prepared, includeImages, turnRide, historyMessages) {
  const list = Array.isArray(historyMessages) ? historyMessages : messages;
  return buildCompletionMessagesFromHistory(
    list,
    sysContent,
    prepared,
    includeImages,
    getSessionContextHelpers(),
    turnRide,
    completionCapOpts()
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
