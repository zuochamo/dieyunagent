/* global sessionActiveRuns, currentSessionId, loopApi, settings, gwState, chatCompletionWithToolsViaRust, isDieyunCoreReady, runPlannerPipelineViaMain, fetchChatCompletion, emitAgentRunEvent, AGENT_RUN_EVENT_TYPES, getSessionAbortSignal, throwIfAgentAborted, waitForAgentAbortable, createAgentAbortError, renderAssistantBubbleContent, getPlannerBestOfN, applyContextCompaction, noteContextCompaction, getEffectiveInputBudget, getAgentToolCallLimit, getAgentMaxRounds, getComposerLongHorizon, LONG_HORIZON_MAX_SEGMENTS, buildAgentSegmentContinuePartial, pauseAgentForToolLimit, pauseAgentForNetworkDisconnect, shouldPauseForNetworkDisconnect, clearAgentContinueState, setAgentContinueState, showAgentToast, formatToolArgsBrief, summarizeToolResult, reprojectContinueLoopMessages, refreshTurnRideFromArchive */
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
  if (typeof setAgentExecutionContext === 'function') {
    const contextTierId =
      typeof resolveContextTierId === 'function'
        ? resolveContextTierId({ sessionId: runSessionId })
        : 'default';
    setAgentExecutionContext({
      runId: checkpointRunId,
      worktreePath: runOpts.worktreePath || null,
      workspacePath: runWorkspacePath,
      sessionId: runSessionId,
      undoTurnId: runUndoTurnId,
      contextTierId
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
    const mergedTrace =
      runOpts.readinessRetry && baseTrace.length
        ? Array.isArray(trace)
          ? trace
          : []
        : mergeRetryTrace(baseTrace, trace);
    setSessionLastTrace(runSessionId, mergedTrace);
    updateSessionRunProgress(runSessionId, mergedTrace, streamContent, { runId: checkpointRunId });
    if (plan && typeof window.syncPlanPreviewFromPlan === 'function') {
      const planVisible = String(runSessionId) === String(currentSessionId || '');
      if (planVisible) window.syncPlanPreviewFromPlan(plan);
    }
    const artifactVisible = String(runSessionId) === String(currentSessionId || '');
    const rowCountBefore =
      typeof getSessionChangeRowsForAgent === 'function'
        ? getSessionChangeRowsForAgent(runSessionId).length
        : 0;
    if (typeof trackArtifactsFromTrace === 'function') {
      trackArtifactsFromTrace(mergedTrace, { sessionId: runSessionId });
    }
    if (typeof syncLiveWriteFromTrace === 'function') {
      void syncLiveWriteFromTrace(mergedTrace, { sessionId: runSessionId });
    }
    const rowCountAfter =
      typeof getSessionChangeRowsForAgent === 'function'
        ? getSessionChangeRowsForAgent(runSessionId).length
        : 0;
    if (artifactVisible && typeof renderChangesPane === 'function') {
      renderChangesPane(rowCountAfter !== rowCountBefore ? undefined : { soft: true });
    }
    if (artifactVisible && typeof window.schedulePlanWorktreeChangesRefresh === 'function') {
      window.schedulePlanWorktreeChangesRefresh();
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
  const longHorizon =
    runOpts.longHorizon != null
      ? !!runOpts.longHorizon
      : typeof getComposerLongHorizon === 'function' && getComposerLongHorizon();
  const maxSegments =
    typeof LONG_HORIZON_MAX_SEGMENTS === 'number' ? LONG_HORIZON_MAX_SEGMENTS : 20;
  let segmentIndex = 0;
  let continueFrom = runOpts.continueFrom || null;

  try {
    while (true) {
      throwIfAgentAborted(runOpts.signal);
      const toolOpts = {
        signal: runOpts.signal,
        onProgress: progress,
        apiConfig: runOpts.apiConfig,
        sessionId: runSessionId,
        runWorkspaceRoot: runWorkspacePath || undefined,
        undoTurnId: runUndoTurnId || undefined,
        taskTier: runOpts.taskTier || null,
        longHorizon: !!longHorizon
      };
      if (continueFrom && continueFrom.body) {
        continueFrom = await reprojectContinueFromBody(
          continueFrom,
          payload,
          runOpts,
          runSessionId
        );
        toolOpts.body = continueFrom.body;
        toolOpts.trace = continueFrom.trace;
        toolOpts.tokensUsed = continueFrom.tokensUsed;
        toolOpts.tokenUsage = continueFrom.tokenUsage;
        toolOpts.toolCallsUsed = 0;
        toolOpts.toolFingerprintHistory = continueFrom.toolFingerprintHistory;
      }

      let result;
      const resumeCheckpoint =
        segmentIndex === 0 && runOpts.allowPlannerResume
          ? getPendingResumeCheckpoint(runSessionId)
          : null;
      if (segmentIndex === 0) clearPendingResumeCheckpoint(runSessionId);
      throwIfAgentAborted(runOpts.signal);

      const usePlanner =
        !runOpts.suppressPlanner &&
        (runOpts.forcePlanner || !!resumeCheckpoint);
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
              visionModel: runOpts.visionModel,
              visionApiConfig: runOpts.visionApiConfig,
              sysContent: runOpts.sysContent,
              chatHistoryBlock: runOpts.chatHistoryBlock || '',
              tools,
              apiConfig: runOpts.apiConfig,
              model: payload?.model,
              resumeFromRunId: resumeCheckpoint?.runId || null,
              plannerBestOfN: typeof getPlannerBestOfN === 'function' ? getPlannerBestOfN() : 0,
              longHorizon: !!longHorizon
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
            readinessRetry: !!runOpts.readinessRetry,
            runId: checkpointRunId,
            hasImages: !!runOpts.hasImages,
            taskTier: runOpts.taskTier || null,
            ...(runOpts.readinessRetry && baseTrace.length ? { trace: baseTrace } : {})
          }),
          runOpts.signal
        );
      }

      if (result && result.hitRoundLimit) {
        if (baseTrace.length && Array.isArray(result.trace) && !runOpts.readinessRetry) {
          result = { ...result, trace: mergeRetryTrace(baseTrace, result.trace) };
        }
        // Plan 子 loop 已在 rust-planner-runner 内续段；此处仅 Agent 模式做外层续跑。
        const canAutoContinue = longHorizon && !usePlanner && segmentIndex + 1 < maxSegments;
        if (canAutoContinue) {
          segmentIndex += 1;
          if (typeof showAgentToast === 'function') {
            showAgentToast('长程续段', `正在启动第 ${segmentIndex + 1} 段…`, { variant: 'info' });
          }
          if (typeof buildAgentSegmentContinuePartial === 'function') {
            continueFrom = buildAgentSegmentContinuePartial(result);
          } else {
            continueFrom = {
              body: result.body,
              trace: result.trace,
              content: result.content,
              tokensUsed: result.tokensUsed,
              toolFingerprintHistory: result.toolFingerprintHistory
            };
          }
          renderAssistantBubbleContent(placeholderEl, {
            content: result.content || '',
            trace: result.trace || [],
            loading: true,
            hitRoundLimit: false
          });
          continue;
        }
        return { done: false, needContinue: true, result, segmentLimitReached: longHorizon && segmentIndex + 1 >= maxSegments };
      }

      clearAgentContinueState(runSessionId);
      if (baseTrace.length && Array.isArray(result?.trace) && !runOpts.readinessRetry) {
        result = { ...result, trace: mergeRetryTrace(baseTrace, result.trace) };
      }
      return { done: true, result, segmentsUsed: segmentIndex + 1 };
    }
  } finally {
    if (typeof clearAgentExecutionContext === 'function') clearAgentExecutionContext(runSessionId);
  }
}
