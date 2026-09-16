/* global CTX_LIMITS, getAgentLimits */
'use strict';

function applyAgentLimitsToRuntime(opts = {}) {
  const L = typeof getAgentLimits === 'function' ? getAgentLimits(opts) : {};
  if (typeof CTX_LIMITS !== 'undefined' && CTX_LIMITS) {
    if (L.ctxAgentToolCallLimit != null) CTX_LIMITS.AGENT_TOOL_CALL_LIMIT = L.ctxAgentToolCallLimit;
    if (L.toolResultMaxJson != null) CTX_LIMITS.TOOL_RESULT_MAX_JSON = L.toolResultMaxJson;
    if (L.codebaseSnippetMax != null) CTX_LIMITS.CODEBASE_SNIPPET_MAX = L.codebaseSnippetMax;
    if (L.codebaseAutoLimit != null) CTX_LIMITS.CODEBASE_AUTO_LIMIT = L.codebaseAutoLimit;
    if (L.openFilesMax != null) CTX_LIMITS.OPEN_FILES_MAX = L.openFilesMax;
    if (L.filePreviewMaxChars != null) CTX_LIMITS.FILE_PREVIEW_MAX_CHARS = L.filePreviewMaxChars;
    if (L.completionHistoryMaxChars != null) CTX_LIMITS.COMPLETION_HISTORY_MAX_CHARS = L.completionHistoryMaxChars;
    if (L.completionMessageMaxChars != null) CTX_LIMITS.COMPLETION_MESSAGE_MAX_CHARS = L.completionMessageMaxChars;
    if (L.completionLastUserMaxChars != null) CTX_LIMITS.COMPLETION_LAST_USER_MAX_CHARS = L.completionLastUserMaxChars;
    if (L.completionTurnRideMaxChars != null) CTX_LIMITS.COMPLETION_TURN_RIDE_MAX_CHARS = L.completionTurnRideMaxChars;
    if (L.completionRecentTurns != null) CTX_LIMITS.COMPLETION_RECENT_TURNS = L.completionRecentTurns;
    if (L.completionFoldedMaxChars != null) CTX_LIMITS.COMPLETION_FOLDED_MAX_CHARS = L.completionFoldedMaxChars;
    if (L.llmRequestMaxChars != null) CTX_LIMITS.LLM_REQUEST_MAX_CHARS = L.llmRequestMaxChars;
    if (L.lspDiagMaxChars != null) CTX_LIMITS.LSP_DIAG_MAX_CHARS = L.lspDiagMaxChars;
    if (L.lspDiagMaxFiles != null) CTX_LIMITS.LSP_DIAG_MAX_FILES = L.lspDiagMaxFiles;
    if (L.lspDiagTimeoutMs != null) CTX_LIMITS.LSP_DIAG_TIMEOUT_MS = L.lspDiagTimeoutMs;
  }
}

window.applyAgentLimitsToRuntime = applyAgentLimitsToRuntime;

/** 推迟到当前脚本/bundle 同步执行完毕再 boot。
 * 打包后 function 会被提升，但 composer 的 const Map 仍在 TDZ；
 * 若此处同步调用 getAgentLimits → resolveContextTierId → resolveComposerModelPickForSend，
 * 会报 Cannot access 'sessionComposerModelPicks' before initialization。
 * 开发模式分文件时 composer 尚未加载，该分支不会踩到。
 */
function bootAgentLimitsRuntime() {
  if (typeof getAgentLimits !== 'function') return;
  applyAgentLimitsToRuntime();
  window.addEventListener('dieyun:agent-limits-change', () => applyAgentLimitsToRuntime());
  window.addEventListener('dieyun:context-tier-change', () => applyAgentLimitsToRuntime());
}

queueMicrotask(bootAgentLimitsRuntime);
