/* global window, fetch, settings, gwState, gatewayCall, showAgentToast, executeAgentTool, formatToolArgsBrief, summarizeToolResult, TRACE_DESKTOP_THOUGHT_CHARS, getEffectiveInputBudget, getContextWindowTokens, getMaxOutputTokens, getContextReserveTokens, getModelRuntimeValues, resolveComposerModelForSend, getCustomModelApiConfig, captureTurnBatchCheckpoint, isMutatingAgentTool, currentSessionId, noteContextCompaction, noteComposerSessionUsage, resolveComposerUsageSessionId, streamChatCompletion, fetchChatCompletion, upsertSynthesisTraceRound, getCurrentUndoTurnId, getUndoTurnIdForSession, supplierDisplayName, normalizeAgentToolName, compactDiffForTrace, getAgentLimits, trackArtifactsFromTrace, resolveSessionWorkspacePath, isWeakAssistantReply, AgentRoundText, formatModelFooterLabel, humanizeModelId, dismissAgentContinueRows, maybeShowProposeToolPreview, resumeAgentToolLoop, getPendingResumeCheckpoint, sendMessage */
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
/** 「继续」= 再给同样额度：这条合成用户消息是「撞上段上限后接着跑」的唯一入口。 */
var SEGMENT_CONTINUE_USER_MSG =
  '[系统] 本段工具轮次已达上限，请在同一会话中继续未完成任务，勿重复已完成的步骤。';

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

/**
 * 展示层剥掉模型误输出的 tool_call XML —— **唯一实现**在 `src/llm-tool-call-fallback.js`
 * （`stripToolCallMarkup`，经 agent-bundle 暴露成 `window.stripToolCallMarkup`）。
 *
 * 这里以前抄了一份，注释还写着「须与 llm-tool-call-fallback.js 同步」；那份抄件漏了
 * 「裸 `<calls>`」与「DSML 半角竖线 / 带空格」两种归一，于是同一条回复 Main 侧剥净、
 * 气泡里却漏出工具标记（2026-11-19 那次事故的形态）。
 */
function stripVisibleToolCallMarkup(text) {
  const fn = typeof window !== 'undefined' ? window.stripToolCallMarkup : null;
  if (typeof fn !== 'function') {
    throw new Error('agent-bundle 未加载：需要 window.stripToolCallMarkup（llm-tool-call-fallback）');
  }
  return fn(text);
}

/**
 * 每段工具调用上限 / 轮次上限：唯一来源是「编码参数 → 模型与段预算」里**当前会话档位**的值
 * （getModelRuntimeValues 会按会话模型解析档位；default 档另镜像进扁平 settings）。
 * 这里不再自带 min 5 / 600 / 96 的兜底 —— 区间由 model-runtime-schema 统一 clamp。
 */
function getAgentToolCallLimit() {
  return getModelRuntimeValues().agentToolCallLimit;
}

function getAgentMaxRounds() {
  return getModelRuntimeValues().agentMaxRounds;
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

/** planner 断点续跑时，写进对话里的那句用户话（**展示用的固定文案**，不是路由判据）。 */
const RESUME_TURN_LABEL = '继续上次任务';

/**
 * 「继续上次被打断的任务」的**唯一触发入口**（AGENTS 原则 3：续跑不看用户打了什么字）。
 *
 * 三个入口共用：思考区那颗「继续」、Composer 空提交、以及 External 频道/手机端的显式续跑。
 * 判据全是状态：这个会话有没有 tool-loop continue 状态、有没有 planner 断点
 * （`tryDetectResumeCheckpoint` 从 Rust 的 checkpoint 表里探到的 running 行）。
 * 都没有就返回 false —— 调用方当普通输入处理。
 *
 * @returns {boolean} 是否已接管（接管 = 已发起续跑，调用方不要再走普通发送）
 */
function requestResumeInterruptedTurn(sessionId) {
  const sid = String(sessionId || (typeof currentSessionId !== 'undefined' ? currentSessionId : '') || '');
  if (!sid) return false;
  const continueState = getAgentContinueState(sid);
  if (continueState && String(continueState.sessionId || '') === sid) {
    void resumeAgentToolLoop();
    return true;
  }
  if (
    typeof getPendingResumeCheckpoint === 'function' &&
    getPendingResumeCheckpoint(sid) &&
    typeof sendMessage === 'function'
  ) {
    // planner 断点：走一次带 resumeInterrupted 的发送，由 gateSendMessage 消费断点
    void sendMessage(RESUME_TURN_LABEL, { resumeInterrupted: true }).catch((err) => {
      if (typeof showAgentToast === 'function') {
        showAgentToast('无法继续', String((err && err.message) || err), { variant: 'warn' });
      }
    });
    return true;
  }
  return false;
}
