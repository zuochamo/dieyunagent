/* global window, fetch, settings, gwState, gatewayCall, showAgentToast, executeAgentTool, formatToolArgsBrief, summarizeToolResult, TRACE_DESKTOP_THOUGHT_CHARS, getEffectiveInputBudget, getContextWindowTokens, getMaxOutputTokens, getContextReserveTokens, resolveComposerModelForSend, getCustomModelApiConfig, captureTurnBatchCheckpoint, isMutatingAgentTool, currentSessionId, shouldBlockRepeatToolCall, recordToolCallFingerprint, repeatToolBlockMessage, noteContextCompaction, noteComposerSessionUsage, resolveComposerUsageSessionId, streamChatCompletion, fetchChatCompletion, upsertSynthesisTraceRound, getComposerLongHorizon, getCurrentUndoTurnId, getUndoTurnIdForSession, supplierDisplayName, normalizeAgentToolName, syncLiveWriteFromTrace, compactDiffForTrace, getAgentLimits, trackArtifactsFromTrace, resolveSessionWorkspacePath, isWeakAssistantReply, AgentRoundText, formatModelFooterLabel, humanizeModelId, scaleLimitForLongHorizon, dismissAgentContinueRows, maybeShowProposeToolPreview, agentApi */
'use strict';

if (typeof window !== 'undefined') {
  window.cleanupSessionContinueState = cleanupSessionContinueState;
  window.formatCompactionProgressNote = formatCompactionProgressNote;
  window.shortenCompactionLlmMessage = shortenCompactionLlmMessage;
  window.LONG_HORIZON_MAX_SEGMENTS = LONG_HORIZON_MAX_SEGMENTS;
  window.buildAgentSegmentContinuePartial = buildAgentSegmentContinuePartial;
  if (agentApi.onCompactionProgress) {
    agentApi.onCompactionProgress((payload) => {
      const note = applyCompactionProgressToThinking(payload);
      if (!note || typeof window === 'undefined') return;
      try {
        window.dispatchEvent(
          new CustomEvent('dieyun:compaction-progress', { detail: { ...(payload || {}), note } })
        );
      } catch {
        // ignore
      }
    });
  }
}
