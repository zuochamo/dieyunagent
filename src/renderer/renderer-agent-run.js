/* global sessionActiveRuns, currentSessionId, loopApi, settings, gwState, chatCompletionWithToolsViaRust, isDieyunCoreReady, runPlannerPipelineViaMain, fetchChatCompletion, emitAgentRunEvent, AGENT_RUN_EVENT_TYPES, getSessionAbortSignal, throwIfAgentAborted, waitForAgentAbortable, createAgentAbortError, renderAssistantBubbleContent, getPlannerBestOfN, applyContextCompaction, noteContextCompaction, getEffectiveInputBudget, getAgentToolCallLimit, getAgentMaxRounds, pauseAgentForToolLimit, pauseAgentForNetworkDisconnect, shouldPauseForNetworkDisconnect, clearAgentContinueState, setAgentContinueState, showAgentToast, formatToolArgsBrief, summarizeToolResult, reprojectContinueLoopMessages, refreshTurnRideFromArchive, scheduleArtifactsUiRefresh, schedulePlanWorktreeChangesRefresh, renderChangesPane, trackArtifactsFromTrace, maybeSaveRunningTraceCheckpoint, setSessionLastTrace, setAgentExecutionContext, createTraceRunId, updateSessionRunProgress, mergeTraceSegments, getSessionChangeRowsForAgent */
'use strict';

async function reprojectContinueFromBody(continueFrom, payload, runOpts, runSessionId) {
  if (!continueFrom || !continueFrom.body || !Array.isArray(continueFrom.body.messages)) {
    return continueFrom;
  }
  if (typeof reprojectContinueLoopMessages !== 'function') return continueFrom;
  let ride = runOpts.turnRide || '';
  if (typeof refreshTurnRideFromArchive === 'function') {
    ride = await refreshTurnRideFromArchive(ride, runSessionId);
  }
  const prefix =
    Array.isArray(runOpts.bookPrefixMessages) && runOpts.bookPrefixMessages.length
      ? runOpts.bookPrefixMessages
      : Array.isArray(payload && payload.messages)
        ? payload.messages
        : [];
  const projected = reprojectContinueLoopMessages({
    prefixMessages: prefix,
    liveLoopMessages: continueFrom.body.messages,
    turnRide: ride
  });
  return {
    ...continueFrom,
    body: { ...continueFrom.body, messages: projected }
  };
}

async function runAgentCompletion(payload, tools, placeholderEl, runOpts = {}) {
  const runSessionId = String(runOpts.sessionId || '').trim();
  if (!runSessionId) {
    throw new Error('runAgentCompletion 需要 sessionId');
  }
  throwIfAgentAborted(runOpts.signal);
  const baseTrace = Array.isArray(runOpts.baseTrace) ? runOpts.baseTrace.slice() : [];
  setSessionLastTrace(runSessionId, baseTrace);
  const live = sessionActiveRuns.get(runSessionId);
  if (live) live.placeholderEl = placeholderEl;
  const checkpointRunId = runOpts.runId || live?.runId || createTraceRunId();
  const runWorkspacePath = live?.workspacePath || null;
  const runUndoTurnId = runOpts.undoTurnId || live?.undoTurnId || null;
  // 本轮 contextTierId 单一来源：既给执行上下文，也随 planner payload 下传
  // （rust-planner-runner 用它解析 loopSpec，避免 planner 子循环落 'default' 档）。
  const runContextTierId =
    typeof resolveContextTierId === 'function'
      ? resolveContextTierId({ sessionId: runSessionId })
      : 'default';
  if (typeof setAgentExecutionContext === 'function') {
    setAgentExecutionContext({
      runId: checkpointRunId,
      worktreePath: runOpts.worktreePath || null,
      workspacePath: runWorkspacePath,
      sessionId: runSessionId,
      undoTurnId: runUndoTurnId,
      contextTierId: runContextTierId
    });
    // 禁止按会话改写全局 CTX_LIMITS：并行 run 会互相覆盖 snippet/工具上限
  }
  if (live && !live.runId) live.runId = checkpointRunId;
  const progress = (trace, streamContent, plan) => {
    const liveNow = sessionActiveRuns.get(runSessionId);
    if (!liveNow || liveNow.finished) return;
    if (
      typeof isStaleSessionRunEvent === 'function' &&
      isStaleSessionRunEvent(liveNow, checkpointRunId)
    ) {
      return;
    }
    const mergedTrace = mergeTraceSegments(baseTrace, trace);
    setSessionLastTrace(runSessionId, mergedTrace);
    updateSessionRunProgress(runSessionId, mergedTrace, streamContent, { runId: checkpointRunId });
    if (plan && typeof window.syncPlanPreviewFromPlan === 'function') {
      const planVisible = String(runSessionId) === String(currentSessionId || '');
      if (planVisible) window.syncPlanPreviewFromPlan(plan);
    }
    const artifactVisible = String(runSessionId) === String(currentSessionId || '');
    if (typeof trackArtifactsFromTrace === 'function') {
      trackArtifactsFromTrace(mergedTrace, { sessionId: runSessionId });
    }
    // 产物/变更面板刷新统一走节流调度器：思考流只排 light，避免每次 progress
    // 都 renderChangesPane + 强制 list_dir，把主线程和 Gateway 占满。
    if (artifactVisible && typeof scheduleArtifactsUiRefresh === 'function') {
      scheduleArtifactsUiRefresh('light');
    }
    if (typeof schedulePlanWorktreeChangesRefresh === 'function') {
      schedulePlanWorktreeChangesRefresh();
    }
    const progressLive = sessionActiveRuns.get(runSessionId);
    maybeSaveRunningTraceCheckpoint(progressLive, {
      runId: checkpointRunId,
      sessionId: runSessionId,
      trace: mergedTrace,
      streamContent,
      ensureUserLocalMsgId: runOpts.ensureUserLocalMsgId
    });
  };
  let continueFrom = runOpts.continueFrom || null;

  try {
    throwIfAgentAborted(runOpts.signal);
    const toolOpts = {
      signal: runOpts.signal,
      onProgress: progress,
      apiConfig: runOpts.apiConfig,
      modelRoute: runOpts.modelRoute,
      sessionId: runSessionId,
      runWorkspaceRoot: runWorkspacePath || undefined,
      undoTurnId: runUndoTurnId || undefined,
      taskTier: runOpts.taskTier || null,
      // 请求快照的审计事实：只有这次刚拼出来的 messages 才有折叠事实，
      // 续跑（continueFrom）的 messages 来自循环账本，因此显式置空。
      contextAudit: runOpts.contextAudit || null
    };
    if (continueFrom && continueFrom.body) {
      continueFrom = await reprojectContinueFromBody(
        continueFrom,
        payload,
        runOpts,
        runSessionId
      );
      toolOpts.body = continueFrom.body;
      toolOpts.contextAudit = null;
      toolOpts.trace = continueFrom.trace;
      toolOpts.tokensUsed = continueFrom.tokensUsed;
      toolOpts.tokenUsage = continueFrom.tokenUsage;
      toolOpts.toolCallsUsed = 0;
      toolOpts.toolFingerprintHistory = continueFrom.toolFingerprintHistory;
    }

    let result;
    const resumeCheckpoint = runOpts.allowPlannerResume
      ? getPendingResumeCheckpoint(runSessionId)
      : null;
    clearPendingResumeCheckpoint(runSessionId);
    throwIfAgentAborted(runOpts.signal);

    const usePlanner =
      !runOpts.suppressPlanner && (runOpts.forcePlanner || !!resumeCheckpoint);
    if (usePlanner) {
      throwIfAgentAborted(runOpts.signal);
      if (typeof runPlannerPipelineViaMain !== 'function') {
        throw new Error('Rust Planner IPC 不可用');
      }
      if (typeof isDieyunCoreReady === 'function' && !isDieyunCoreReady()) {
        throw new Error('Plan 模式需要 dieyun-core（请运行 npm run pack:dieyun-core 并重启）');
      }
      if (typeof beginPlanWorktreeTracking === 'function') {
        beginPlanWorktreeTracking(null, runSessionId);
      }
      result = await waitForAgentAbortable(
        runPlannerPipelineViaMain(
          {
            userText: runOpts.userText,
            userContent: runOpts.userContent,
            hasImages: !!runOpts.hasImages,
            sysContent: runOpts.sysContent,
            chatHistoryBlock: runOpts.chatHistoryBlock || '',
            tools,
            apiConfig: runOpts.apiConfig,
            model: payload?.model,
            contextTierId: runContextTierId,
            resumeFromRunId: resumeCheckpoint?.runId || null,
            plannerBestOfN: typeof getPlannerBestOfN === 'function' ? getPlannerBestOfN() : 0
          },
          { signal: runOpts.signal, onProgress: progress, sessionId: runSessionId }
        ),
        runOpts.signal
      );
    } else {
      throwIfAgentAborted(runOpts.signal);
      if (typeof isDieyunCoreReady === 'function' && !isDieyunCoreReady()) {
        throw new Error('需要 dieyun-core sidecar（npm run pack:dieyun-core）');
      }
      if (typeof chatCompletionWithToolsViaRust !== 'function') {
        throw new Error('Rust agent loop IPC 不可用');
      }
      result = await waitForAgentAbortable(
        chatCompletionWithToolsViaRust(payload, tools, {
          ...toolOpts,
          runId: checkpointRunId,
          hasImages: !!runOpts.hasImages,
          taskTier: runOpts.taskTier || null
        }),
        runOpts.signal
      );
    }

    // 撞上用尽（轮次 / 工具段）就交回用户：「继续」= 再给同样额度。
    // 单轮内不再自动续跑；无人值守的连续推进归目标型长任务。
    //
    // 会话目标（`goal.cont`，判定在 Main 的 `decideContinuation`）语义不同：这一轮是**正常结束**的，
    // 只是目标还没收尾，所以要「再开一轮」而不是「续这一段」。两件事必须分开：
    //   - hitRoundLimit 且没有目标在推 → 段内额度用尽，停车等用户点「继续」；
    //   - 目标还没收尾 → 本轮正文照常交付，交付完再开一轮（新轮才有新系统提示与新预算）。
    // Renderer 只读布尔值，不出现 attempt / maxAttempts / stop 这些概念。
    const goalContinue = !!(result && result.goal && result.goal.cont);
    if (result && result.hitRoundLimit && !goalContinue) {
      if (baseTrace.length && Array.isArray(result.trace)) {
        result = { ...result, trace: mergeTraceSegments(baseTrace, result.trace) };
      }
      return { done: false, needContinue: true, result };
    }

    clearAgentContinueState(runSessionId);
    if (baseTrace.length && Array.isArray(result?.trace)) {
      result = { ...result, trace: mergeTraceSegments(baseTrace, result.trace) };
    }
    if (goalContinue) result = { ...result, goalContinue: true };
    return { done: true, result };
  } finally {
    if (typeof clearAgentExecutionContext === 'function') clearAgentExecutionContext(runSessionId);
  }
}
