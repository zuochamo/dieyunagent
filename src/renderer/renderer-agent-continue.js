/* global window, fetch, settings, gwState, gatewayCall, showAgentToast, executeAgentTool, formatToolArgsBrief, summarizeToolResult, TRACE_DESKTOP_THOUGHT_CHARS, getEffectiveInputBudget, getContextWindowTokens, getMaxOutputTokens, getContextReserveTokens, resolveComposerModelForSend, getCustomModelApiConfig, captureTurnBatchCheckpoint, isMutatingAgentTool, currentSessionId, shouldBlockRepeatToolCall, recordToolCallFingerprint, repeatToolBlockMessage, noteContextCompaction, noteComposerSessionUsage, resolveComposerUsageSessionId, streamChatCompletion, fetchChatCompletion, upsertSynthesisTraceRound, getComposerLongHorizon, getCurrentUndoTurnId, getUndoTurnIdForSession, supplierDisplayName, normalizeAgentToolName, syncLiveWriteFromTrace, compactDiffForTrace, getAgentLimits, trackArtifactsFromTrace, resolveSessionWorkspacePath, isWeakAssistantReply, AgentRoundText, formatModelFooterLabel, humanizeModelId, scaleLimitForLongHorizon, dismissAgentContinueRows, maybeShowProposeToolPreview */
'use strict';

var agentApi = window.diecloud || {};
var usageStats = typeof LlmUsageStats !== 'undefined' ? LlmUsageStats : null;

/** @type {Map<string, object>} */
var agentContinueStates = new Map();

function resolveContinueSessionId(sessionId) {
  const sid = sessionId != null ? String(sessionId).trim() : '';
  if (sid) return sid;
  if (typeof currentSessionId !== 'undefined' && currentSessionId) {
    return String(currentSessionId);
  }
  return '';
}
/** 连续 LLM 失败次数（成功后清零） */
var llmConsecutiveFailures = 0;
var STREAM_ROUND_MAX_ATTEMPTS = () =>
  (typeof getAgentLimits === 'function' ? getAgentLimits().streamRoundMaxAttempts : 3) || 3;
var LLM_RETRY_BASE_MS = () =>
  (typeof getAgentLimits === 'function' ? getAgentLimits().llmRetryBaseMs : 800) || 800;
var LLM_RECONNECT_MAX_DELAY_MS = 60 * 1000;
var LONG_HORIZON_MAX_SEGMENTS = 20;
var SEGMENT_CONTINUE_USER_MSG =
  '[系统] 本段工具轮次已达上限，请在同一会话中继续未完成任务，勿重复已完成的步骤。';

function runIsLongHorizon(options) {
  if (options && options.longHorizon != null) return !!options.longHorizon;
  return typeof getComposerLongHorizon === 'function' && getComposerLongHorizon();
}

function scaleRunLimit(key, value, options) {
  if (typeof scaleLimitForLongHorizon === 'function') {
    return scaleLimitForLongHorizon(key, value, runIsLongHorizon(options));
  }
  return value;
}

var activeAgentBackendCancels = new Map();

function registerActiveAgentBackendCancel(kind, cancelToken, cancelFn, sessionId) {
  const token = String(cancelToken || '').trim();
  if (!token || typeof cancelFn !== 'function') return () => {};
  const sid = String(sessionId || '').trim();
  const key = sid ? `${sid}:${kind}:${token}` : `${kind}:${token}`;
  // 勿做成一次性：waitForAgentAbortable 竞态后孤儿续跑可能复用同一 token，需能再次 cancel
  activeAgentBackendCancels.set(key, {
    kind,
    cancelToken: token,
    sessionId: sid,
    cancel(reason = '用户停止') {
      return Promise.resolve().then(() => cancelFn(reason));
    }
  });
  return () => {
    activeAgentBackendCancels.delete(key);
  };
}

function cancelActiveAgentBackends(reason = '用户停止') {
  const entries = Array.from(activeAgentBackendCancels.values());
  for (const entry of entries) {
    entry.cancel(reason).catch(() => {});
  }
  return entries.length;
}

function cancelActiveAgentBackendsForSession(sessionId, reason = '用户停止') {
  const sid = String(sessionId || '').trim();
  if (!sid) return cancelActiveAgentBackends(reason);
  const prefix = `${sid}:`;
  let count = 0;
  for (const [key, entry] of activeAgentBackendCancels.entries()) {
    if (key.startsWith(prefix)) {
      entry.cancel(reason).catch(() => {});
      count += 1;
    }
  }
  return count;
}

if (typeof window !== 'undefined') {
  window.cancelActiveAgentBackends = cancelActiveAgentBackends;
  window.cancelActiveAgentBackendsForSession = cancelActiveAgentBackendsForSession;
}

function buildSegmentContinueMessages(messages, partialContent) {
  const msgs = Array.isArray(messages) ? messages.slice() : [];
  const partial = String(partialContent || '').trim();
  if (partial) {
    const last = msgs[msgs.length - 1];
    const lastContent =
      last && last.role === 'assistant'
        ? typeof last.content === 'string'
          ? last.content.trim()
          : ''
        : '';
    if (lastContent !== partial) {
      msgs.push({ role: 'assistant', content: partial });
    }
  }
  msgs.push({ role: 'user', content: SEGMENT_CONTINUE_USER_MSG });
  return msgs;
}

function stripVisibleAgentStatus(text) {
  if (typeof AgentRoundText !== 'undefined' && typeof AgentRoundText.stripAgentStatusLine === 'function') {
    return AgentRoundText.stripAgentStatusLine(text);
  }
  return String(text || '').trim();
}

function sanitizeTraceThought(text, previousTexts) {
  if (typeof AgentRoundText !== 'undefined' && typeof AgentRoundText.sanitizeAgentThoughtText === 'function') {
    return AgentRoundText.sanitizeAgentThoughtText(text, previousTexts);
  }
  return String(text || '');
}

function buildAgentSegmentContinuePartial(result) {
  const body = result.body ? { ...result.body } : {};
  return {
    body,
    trace: result.trace,
    content: result.content,
    tokensUsed: result.tokensUsed,
    tokenUsage: result.tokenUsage,
    toolFingerprintHistory: result.toolFingerprintHistory || []
  };
}

/** 展示层剥掉模型误输出的 tool_call XML（须与 src/llm-tool-call-fallback.js 同步） */
function stripVisibleToolCallMarkup(text) {
  const normalized = String(text || '')
    .replace(/<\uff5cDSML\uff5c/gi, '<')
    .replace(/<\/\uff5cDSML\uff5c/gi, '</')
    .replace(/<tool[\s_]+calls>/gi, '<tool_calls>')
    .replace(/<\/tool[\s_]+calls>/gi, '</tool_calls>')
    .replace(/<tool[\s_]+call>/gi, '<tool_call>')
    .replace(/<\/tool[\s_]+call>/gi, '</tool_call>')
    .replace(/<\/function\s*>/gi, '')
    .replace(/<function\s*>/gi, '');
  return normalized
    .replace(/<tool_calls>[\s\S]*?(?=<tool_calls>|$)/gi, '')
    .replace(/<\/tool_calls>/gi, '')
    .replace(/<invoke\s+name="[^"]+"[^>]*>[\s\S]*?(?=<invoke\s+name=|<\/tool_calls>|$)/gi, '')
    .replace(/<\/invoke>/gi, '')
    .replace(/<invoke\s+name="[^"]+"[^>]*\/?>/gi, '')
    .replace(/<tool_call>[\s\S]*?(?=<tool_call>|$)/gi, '')
    .replace(/<\/tool_call>/gi, '')
    .replace(/<function=[^>\n/]+>\s*/gi, '')
    .replace(/<parameter\s+name="[^"]+"[^>]*>[\s\S]*?<\/parameter>/gi, '')
    .replace(/<parameter\s+name="[^"]+"[^>]*\/\s*>/gi, '')
    .replace(/<parameter=[^>\n/]+>[\s\S]*?<\/parameter>/gi, '')
    .replace(/<parameter=[^>\n/]+>[\s\S]*?(?=<parameter=|<function=|<tool_call>|<invoke|<\/tool_calls>|$)/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function getAgentToolCallLimit() {
  if (typeof settings !== 'undefined' && settings) {
    const n = Number(settings.agentToolCallLimit);
    if (Number.isFinite(n) && n > 0) {
      return Math.min(600, Math.max(5, Math.floor(n)));
    }
  }
  return typeof CTX_LIMITS !== 'undefined' && CTX_LIMITS.AGENT_TOOL_CALL_LIMIT
    ? CTX_LIMITS.AGENT_TOOL_CALL_LIMIT
    : 300;
}

function getAgentMaxRounds() {
  if (typeof settings !== 'undefined' && settings) {
    const n = Number(settings.agentMaxRounds);
    if (Number.isFinite(n) && n > 0) {
      return Math.min(600, Math.max(5, Math.floor(n)));
    }
  }
  return 96;
}

function getAgentContinueState(sessionId) {
  const sid = resolveContinueSessionId(sessionId);
  return sid ? agentContinueStates.get(sid) || null : null;
}

function clearAgentContinueState(sessionId) {
  const sid = resolveContinueSessionId(sessionId);
  if (!sid) {
    agentContinueStates.clear();
  } else {
    agentContinueStates.delete(sid);
  }
  if (typeof dismissAgentContinueRows === 'function') dismissAgentContinueRows();
}

function setAgentContinueState(state) {
  if (!state || !state.sessionId) return;
  agentContinueStates.set(String(state.sessionId), state);
}

function cleanupSessionContinueState(sessionId) {
  if (!sessionId) return;
  agentContinueStates.delete(String(sessionId));
}
