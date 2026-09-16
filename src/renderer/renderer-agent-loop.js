/* global window, document, $, settings, gwState, gatewayCall, currentSessionId, messages, sessionActiveRuns, chatInput, chatForm, composerSendBtn, pendingAttachments, getSessionAbortSignal, isSending, lastAgentDisplayedTrace, chatAutoFollow, chatList, getPendingResumeCheckpoint, clearPendingResumeCheckpoint, getPendingWorktreeApply, currentAgentRunId, currentAgentPlaceholderEl, resetCompactionStateSafe, applySessionWorkspace, bindCurrentSessionWorkspace, updateWorkspaceLabel, invalidateWorkspaceArtifacts, refreshSkillsCatalog, buildSkillsPrompt, buildMcpPrompt, buildAgentTools, getComposerAgentMode, resolveComposerModelForSend, modelSupportsMultimodal, attachmentNeedsVision, getTextModelId, getCustomModelApiConfig, getVisionApiConfig, formatModelFooterLabel, pickAnyModelForContext, buildExploreTools, buildShellTools, buildBuildTools, getPlannerBestOfN, sessionListTitle, appendUserTurn, appendBubble, renderAssistantBubbleContent, renderChatFromMessages, finalizeAssistantBubble, switchSession, createNewSession, loadChatFromGateway, finalizeUserTurnFooter, scrollChat, packUserMessageMeta, packAssistantMeta, unpackAssistantMeta, unpackUserMessageContentToBottom, chatCompletionWithToolsViaRust, isRustAgentLoopEnabled, isRustPlannerEnabled, runPlannerPipelineViaMain, fetchChatCompletion, emitAgentRunEvent, AGENT_RUN_EVENT_TYPES, loopApi, applyContextCompaction, estimateContextTokensFallback, estimateMessagesTokensViaMain, getEffectiveInputBudget, getContextWindowTokens, getMaxOutputTokens, getContextReserveTokens, lastComposerContextEstimate, reportTokensToMain, clearAgentContinueState, setPlannerParallelWorkersActive, setAgentExecutionContext, buildAgentBridge, compactPlainText, captureTurnBatchCheckpoint, withdrawUserTurn, markTurnWorktreeOnly, getCurrentUndoTurnId, showAgentToast, formatToolArgsBrief, summarizeToolResult, TRACE_DESKTOP_THOUGHT_CHARS, shouldBlockRepeatToolCall, recordToolCallFingerprint, repeatToolBlockMessage, CTX_LIMITS, showTrayBalloon, toastPreviewText, focusChatInput, refreshHistoryList, cloneAttachmentSnapshot, cloneTraceForMobile, finishSessionActiveRun, syncComposerForActiveSession, isCurrentSessionSending, isChatNearBottom, updateLastTurnFloat, renderAttachmentChips, revokeAttachmentPreview, processAttachmentsForSend, isImageAttachment, packAssistantMeta, buildPersistedAssistantContent, normalizeAssistantReplyForStorage, buildAgentStateSnapshot, createTraceRunId, saveAgentRunState, saveAssistantTraceRecord, saveAgentPlanState, persistStoppedAssistant, unpackUserMessageContent, unpackAssistantMeta, splitPersistedAssistantTrace, handleWorktreeApplyAfterRun, startMemoryMaintenanceTimers, tryDetectResumeCheckpoint, humanizeModelId, agentApi, cleanupStaleSessionRun, formatAgentApiError, isUserAbortError, buildAgentsMdContext, buildDieyunMdSystemBlock, getAgentsMdMode, ensureAgentsMd, loadAgentsMdRecord, getSessionChangeRowsForAgent, trackArtifactsFromTrace, scheduleUnifiedKnowledgeMaintenance, stashKnowledgeMaintenanceContext, flushKnowledgeMaintenanceAfterPlan, hasKnowledgeMaintenanceContext, clearKnowledgeMaintenanceContext, scheduleBackgroundKnowledgeFallback, capText, buildCoreAgentRules, formatSystemTimeChunk, fetchCodebaseContext, fetchProjectMemoryContext, fetchPlaybookContext, buildOpenFilesContext, getContextFilePathsForAgent, extractCodebasePathsFromBlock, fetchProjectMemoryContext, buildAgentStatePrompt, buildSystemMessage, beginTurnUndo, finalizeTurnUndo, capturePlanApplyForUndo, collectCompletionEvidence, applyReadinessNote, getTraceWriteFilePaths, fetchWorkspaceVerifyDiagnostics, COMPLETION_REPAIR_ATTEMPT_LIMIT, buildSessionChatHistoryBlock, buildCompletionMessages, createAgentRunEvent, dispatchAgentRunEvent, emitAgentProgress, collapseChatThinkingTraces, resetTraceAutoCollapseState, estimateTextTokens, tracePrefs, getComposerLongHorizon, buildAgentSegmentContinuePartial, LONG_HORIZON_MAX_SEGMENTS, cancelActiveAgentBackends, dieyunI18n, maybeEnforceWorktreeCleanupPolicy, scheduleWorktreePolicyCleanup, beginPlanWorktreeTracking, schedulePlanWorktreeChangesRefresh, openWorktreeReviewAfterPlan, maybeSaveRunningTraceCheckpoint, invalidateSessionMessageCache, resolveSessionWorkspacePathSync, reconcileSessionLiveRunUi */
'use strict';

const loopApi = window.diecloud || {};

function emitAgentRunEvent(sessionId, type, fields = {}) {
  if (typeof dispatchAgentRunEvent !== 'function' || typeof createAgentRunEvent !== 'function') {
    return null;
  }
  return dispatchAgentRunEvent(
    sessionId,
    createAgentRunEvent(type, { sessionId, ...fields })
  );
}

function recordAgentPrepTrace(sessionId, thought, fields = {}) {
  const live = sessionActiveRuns.get(sessionId);
  if (live && live.inPrepPhase) return null;
  const text = String(thought || '准备中…');
  const prepTrace = [{ round: 1, thought: text, tools: [] }];
  if (live && !live.finished) {
    live.trace = prepTrace;
    live.streamContent = '';
    if (live.runId) {
      maybeSaveRunningTraceCheckpoint(live, {
        runId: live.runId,
        sessionId,
        trace: prepTrace,
        streamContent: ''
      });
    }
  }
  emitAgentRunEvent(sessionId, AGENT_RUN_EVENT_TYPES.PREP, {
    trace: prepTrace,
    streamContent: '',
    phase: text,
    ...fields
  });
  return prepTrace;
}

function stripMultimodalFromPrepared(prepared) {
  if (!prepared || !prepared.hasImages) return prepared;
  const text =
    prepared.textForStorage ||
    (Array.isArray(prepared.content)
      ? prepared.content
          .filter((p) => p && p.type === 'text')
          .map((p) => String(p.text || ''))
          .join('\n')
      : String(prepared.content || ''));
  return {
    content: text,
    hasImages: false,
    textForStorage: text
  };
}

function extractPreparedImageParts(prepared) {
  const parts = Array.isArray(prepared?.content) ? prepared.content : [];
  return parts
    .filter((part) => part && part.type === 'image_url' && (part.image_url?.url || part.url))
    .map((part) => ({
      type: 'image_url',
      image_url: { url: String(part.image_url?.url || part.url) }
    }));
}

async function buildPlannerVisionSupplement(prepared, opts = {}) {
  const imageParts = extractPreparedImageParts(prepared).slice(0, 4);
  if (!imageParts.length || typeof fetchChatCompletion !== 'function') return '';
  const apiConfig = opts.visionApiConfig || getVisionApiConfig();
  const visionPick = typeof pickCustomVisionModel === 'function' ? pickCustomVisionModel() : null;
  const model = String(
    opts.visionModel || visionPick?.model || apiConfig?.model || ''
  ).trim();
  if (!model || !apiConfig?.baseUrl) return '';
  try {
    const text = await fetchChatCompletion({
      model,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text:
                '请用中文详细识别这些图片，重点提取用户任务所需的信息、界面文字、错误提示、表格/代码/路径、可见状态。只输出图片内容摘要。'
            },
            ...imageParts
          ]
        }
      ],
      temperature: 0.1,
      max_tokens: Math.min(1600, getMaxOutputTokens ? getMaxOutputTokens() : 1600),
      apiConfig,
      signal: opts.signal
    });
    return String(text || '').trim();
  } catch (err) {
    console.warn('planner vision supplement failed', err);
    return '';
  }
}

function createTraceRunId() {
  if (window.crypto && typeof window.crypto.randomUUID === 'function') {
    return `trace-${window.crypto.randomUUID()}`;
  }
  return `trace-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

async function finalizeUndoForUserTurn(userMsgIndex, undoTurnId, sessionId) {
  if (!undoTurnId) return;
  const sid = sessionId || currentSessionId;
  await finalizeTurnUndo(undoTurnId, sid);
  // 仅当前正在看的会话才改内存 messages；后台完成只失效缓存，切回时再拉
  if (String(sid || '') !== String(currentSessionId || '')) {
    if (typeof invalidateSessionMessageCache === 'function') {
      invalidateSessionMessageCache(sid);
    }
    return;
  }
  if (userMsgIndex >= 0 && messages[userMsgIndex]) {
    const meta = messages[userMsgIndex].meta || {};
    meta.undoTurnId = undoTurnId;
    meta.undoFinalized = true;
    messages[userMsgIndex].meta = meta;
  }
}

function composerModeLabel(sessionId) {
  const mode =
    typeof getComposerAgentMode === 'function' ? getComposerAgentMode(sessionId) : 'agent';
  const base = mode === 'plan' ? 'Plan' : mode === 'explore' ? 'Explore' : 'Agent';
  if (typeof getComposerLongHorizon === 'function' && getComposerLongHorizon()) {
    return `${base} · 长程`;
  }
  return base;
}

function compactPlainText(text, max = 200) {
  return String(text || '')
    .replace(/```[\s\S]*?```/g, '[代码块]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function buildAgentStateSnapshot({ reply, trace, plan, results, review, status }) {
  const todos = Array.isArray(plan?.todos) ? plan.todos.map((t) => String(t || '').trim()).filter(Boolean) : [];
  const subtasks = Array.isArray(plan?.subtasks) ? plan.subtasks : [];
  const resultList = Array.isArray(results) ? results : [];
  const completedSubtasks = resultList
    .filter((r) => !r.error)
    .map((r) => {
      const st = subtasks.find((s) => String(s.id) === String(r.id));
      return compactPlainText(st?.title || r.id || r.output, 80);
    })
    .filter(Boolean)
    .slice(0, 8);
  const failedSubtasks = resultList
    .filter((r) => r.error)
    .map((r) => compactPlainText(r.id || r.error, 80))
    .filter(Boolean)
    .slice(0, 5);
  const pendingTodos = todos
    .filter((t) => !completedSubtasks.some((c) => c && t.includes(c)))
    .slice(completedSubtasks.length ? Math.min(completedSubtasks.length, todos.length) : 0, 8);
  const tracePhases = (trace || [])
    .map((entry) => compactPlainText(entry.phase || entry.thought, 60))
    .filter(Boolean)
    .slice(-5);
  const summary = compactPlainText(
    plan?.planSummary || review?.notes || reply || tracePhases.join(' / '),
    200
  );
  return {
    summary,
    snapshot: {
      taskStage:
        status === 'stopped' ? '暂停' : status === 'failed' ? '失败' : failedSubtasks.length ? '验证' : '完成',
      planSummary: compactPlainText(plan?.planSummary || '', 160),
      completedSubtasks,
      pendingItems: failedSubtasks.length ? failedSubtasks : pendingTodos,
      importantConstraints: [],
      lastTracePhases: tracePhases
    }
  };
}

function stepsFromAgentPlan(plan, results) {
  const resultMap = new Map((Array.isArray(results) ? results : []).map((r) => [String(r.id), r]));
  return (Array.isArray(plan?.subtasks) ? plan.subtasks : []).map((st, index) => {
    const r = resultMap.get(String(st.id));
    return {
      ...st,
      stepNumber: index + 1,
      status: r ? (r.error ? 'failed' : 'completed') : 'pending',
      result: r || null
    };
  });
}

async function saveAgentPlanState({ runId, sessionId, plan, results, summary, stateSnapshot, status }) {
  if (!gwState.authed || !runId || !sessionId || !plan) return null;
  try {
    return await gatewayCall('agent.plan_save', {
      runId,
      sessionId,
      version: 1,
      status: status || 'completed',
      summary,
      plan,
      steps: stepsFromAgentPlan(plan, results),
      stateSnapshot
    });
  } catch (e) {
    console.warn(e);
    return null;
  }
}



const PLANNER_BEST_OF_N_KEY = 'dieyun.planner.bestOfN.v1';

function getPlannerBestOfN() {
  try {
    const raw = localStorage.getItem(PLANNER_BEST_OF_N_KEY);
    if (raw === '0' || raw === 'off' || raw === 'false') return 0;
    const n = Number(raw);
    if (n >= 2 && n <= 3) return n;
  } catch {
    // ignore
  }
  return 0;
}



function hasActiveSessionRun(sessionId) {
  const live = sessionActiveRuns.get(String(sessionId || ''));
  return !!(live && !live.finished);
}

function anyActiveRunUsesSsh() {
  return anyActiveRunUsesRemote();
}

function anyActiveRunUsesRemote() {
  for (const run of sessionActiveRuns.values()) {
    const ws = run && run.workspacePath;
    if (ws && /^ssh:/i.test(String(ws))) return true;
  }
  return false;
}

function currentSessionHasActiveRemoteRun() {
  return sessionRunUsesRemote(currentSessionId);
}

function sessionRunUsesRemote(sessionId) {
  const sid = String(sessionId || '');
  if (!sid) return false;
  const live = sessionActiveRuns.get(sid);
  if (!live || live.finished) return false;
  return isRemoteSessionWorkspacePath(live.workspacePath);
}

function isRemoteSessionWorkspacePath(ws) {
  const s = String(ws || '');
  return /^ssh:/i.test(s);
}

async function syncSessionRemoteLease(sessionId, workspacePath, active) {
  const api = window.diecloud;
  if (!api?.setSessionRemoteLease || !isRemoteSessionWorkspacePath(workspacePath)) return;
  try {
    await api.setSessionRemoteLease({ sessionId, active: !!active, workspacePath });
  } catch (e) {
    console.warn(e);
  }
}

if (typeof window !== 'undefined') {
  window.anyActiveRunUsesSsh = anyActiveRunUsesSsh;
  window.anyActiveRunUsesRemote = anyActiveRunUsesRemote;
  window.sessionRunUsesRemote = sessionRunUsesRemote;
  window.currentSessionHasActiveRemoteRun = currentSessionHasActiveRemoteRun;
}

/** 续跑 / 工作记忆：只看状态机与 checkpoint，禁用自然语言意图词表 */
function hasAgentContinueCheckpoint(sessionId) {
  if (typeof getAgentContinueState === 'function' && getAgentContinueState(sessionId)) return true;
  if (typeof getPendingResumeCheckpoint === 'function' && getPendingResumeCheckpoint(sessionId)) return true;
  return false;
}

async function closeStaleAgentRunForSession(sessionId, _userQuery) {
  if (!gwState.authed || !sessionId) return;
  if (hasActiveSessionRun(sessionId)) return;
  try {
    const state = await gatewayCall('agent.state_get', { sessionId });
    if (!state?.runId || state.status !== 'running') return;
    await saveAgentRunState({
      runId: state.runId,
      sessionId,
      status: 'interrupted',
      summary: state.summary || '任务被新消息中断',
      stateSnapshot: state.stateSnapshot || null
    });
    clearPendingResumeCheckpoint(sessionId);
  } catch (e) {
    console.warn(e);
  }
}



async function openAgentServiceSession(sessionId) {
  if (!sessionId) {
    await createNewSession();
    return currentSessionId;
  }
  if (sessionId !== currentSessionId && typeof switchSession === 'function') {
    await switchSession(sessionId);
    return currentSessionId;
  }
  await applySessionWorkspace(sessionId, { skipDefaultEditor: true });
  await loadChatFromGateway(null, sessionId);
  if (typeof reconcileSessionLiveRunUi === 'function') {
    reconcileSessionLiveRunUi(sessionId);
  }
  await refreshHistoryList();
  syncComposerForActiveSession();
  return currentSessionId;
}

async function handleAgentServiceSubmitTask(task) {
  const requestId = task && task.requestId ? String(task.requestId) : '';
  const text = task && task.text ? String(task.text) : '';
  if (!text.trim()) {
    if (requestId && loopApi.agentServiceTaskRejected) {
      loopApi.agentServiceTaskRejected({ requestId, error: '任务内容为空' });
    }
    return;
  }
  if (task?.sessionId && sessionActiveRuns.has(String(task.sessionId))) {
    if (requestId && loopApi.agentServiceTaskRejected) {
      loopApi.agentServiceTaskRejected({
        requestId,
        sessionId: String(task.sessionId),
        error: '该会话已有任务在执行'
      });
    }
    return;
  }
  try {
    const sessionId = await openAgentServiceSession(task.sessionId || '');
    if (sessionActiveRuns.has(sessionId)) {
      if (requestId && loopApi.agentServiceTaskRejected) {
        loopApi.agentServiceTaskRejected({
          requestId,
          sessionId,
          error: '该会话已有任务在执行'
        });
      }
      return;
    }
    if (requestId && loopApi.agentServiceTaskAccepted) {
      loopApi.agentServiceTaskAccepted({ requestId, sessionId });
    }
    await sendMessage(text, {
      source: task.source || 'agent-service',
      agentServiceRequestId: requestId
    });
  } catch (err) {
    if (requestId && loopApi.agentServiceTaskRejected) {
      loopApi.agentServiceTaskRejected({
        requestId,
        sessionId: task && task.sessionId ? task.sessionId : currentSessionId,
        error: err.message || String(err)
      });
    }
  }
}

function initAgentLoopUI() {
  startMemoryMaintenanceTimers();
  window.addEventListener('dieyun:skills-enabled-change', () => {
    invalidateSystemMessageCache();
  });
  window.addEventListener('dieyun:context-tier-change', () => {
    invalidateSystemMessageCache();
    refreshContextProgress();
  });
  window.addEventListener('dieyun:model-runtime-change', () => {
    invalidateSystemMessageCache();
    refreshContextProgress();
  });
  if (loopApi.onAgentServiceSubmitTask) {
    loopApi.onAgentServiceSubmitTask((task) => {
      handleAgentServiceSubmitTask(task).catch((err) => console.warn(err));
    });
  }
  if (loopApi.onAgentServiceCancelTask) {
    loopApi.onAgentServiceCancelTask((payload) => {
      const sessionId = payload && payload.sessionId ? String(payload.sessionId) : '';
      if (sessionId && sessionActiveRuns.has(sessionId)) {
        stopAgentRun(sessionId);
      }
    });
  }
}
