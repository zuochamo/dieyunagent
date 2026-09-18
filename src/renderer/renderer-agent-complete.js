/* global sessionActiveRuns, currentSessionId, messages, loopApi, settings, gwState, showAgentToast, finalizeAssistantBubble, settleAssistantBubbleAfterLoop, finalizeUserTurnFooter, renderAssistantBubbleContent, resolveRunPlaceholder, runAgentCompletion, getSessionAbortSignal, createAgentAbortError, throwIfAgentAborted, waitForAgentAbortable, isUserAbortError, formatAgentApiError, compactPlainText, compactTraceForReviewer, runReviewerValidation, applyReadinessNote, getTraceWriteFilePaths, fetchWorkspaceVerifyDiagnostics, COMPLETION_REPAIR_ATTEMPT_LIMIT, LONG_HORIZON_MAX_SEGMENTS, capturePlanApplyForUndo, handleWorktreeApplyAfterRun, beginPlanWorktreeTracking, schedulePlanWorktreeChangesRefresh, openWorktreeReviewAfterPlan, maybeEnforceWorktreeCleanupPolicy, scheduleWorktreePolicyCleanup, markTurnWorktreeOnly, getCurrentUndoTurnId, finalizeUndoForUserTurn, saveAgentPlanState, saveAgentRunState, saveAssistantTraceRecord, persistStoppedAssistant, buildAgentStateSnapshot, stepsFromAgentPlan, trackArtifactsFromTrace, scheduleUnifiedKnowledgeMaintenance, stashKnowledgeMaintenanceContext, flushKnowledgeMaintenanceAfterPlan, hasKnowledgeMaintenanceContext, clearKnowledgeMaintenanceContext, scheduleBackgroundKnowledgeFallback, emitAgentRunEvent, AGENT_RUN_EVENT_TYPES, finishSessionActiveRun, syncComposerForActiveSession, noteComposerSessionUsage, reportTokensToMain, clearAgentContinueState, setAgentContinueState, setPlannerParallelWorkersActive, setAgentExecutionContext, invalidateSessionMessageCache, refreshHistoryList, scrollChat, collapseChatThinkingTraces, packAssistantMeta, buildPersistedAssistantContent, persistAssistantTranscriptText, extractBookPrefixMessages, reprojectContinueLoopMessages, refreshTurnRideFromArchive, normalizeAssistantReplyForStorage, unpackAssistantMeta, splitPersistedAssistantTrace, humanizeModelId, formatModelFooterLabel, getTextModelId, composerModeLabel, buildStoppedFooterMeta, buildFallbackTurnMeta, resolveUserMsgCreatedAt, withdrawUserTurn, appendBubble, agentApi, captureTurnBatchCheckpoint, getPendingWorktreeApply, clearPendingResumeCheckpoint, tryDetectResumeCheckpoint, maybeSaveRunningTraceCheckpoint, createTraceRunId, getComposerLongHorizon, buildAgentSegmentContinuePartial, getAgentToolCallLimit, getAgentMaxRounds, clearComposerQueuePause, getAgentLimits, scaleLimitForLongHorizon */
'use strict';

function buildAgentRunOptsForContinue(fc) {
  return {
    apiConfig: fc.apiConfig,
    modelRoute: fc.modelRoute,
    sessionId: fc.runSessionId,
    userText: fc.fullText,
    userContent: fc.userContent,
    hasImages: fc.hasImages,
    visionModel: fc.visionModel,
    visionApiConfig: fc.visionApiConfig,
    sysContent: fc.sysContent,
    turnRide: fc.turnRide,
    bookPrefixMessages: fc.bookPrefixMessages,
    longHorizon: !!fc.longHorizon
  };
}

function pauseAgentForToolLimit(run, fc) {
  if (run.segmentLimitReached && typeof showAgentToast === 'function') {
    const cap =
      typeof LONG_HORIZON_MAX_SEGMENTS === 'number' ? LONG_HORIZON_MAX_SEGMENTS : 20;
    showAgentToast('续段上限', `已达 ${cap} 段自动续跑上限，请点击继续或拆分任务`, {
      variant: 'info'
    });
  }
  if (run.result?.body) {
    setAgentContinueState({
      sessionId: fc.runSessionId,
      placeholder: fc.placeholder,
      payload: fc.payload,
      agentTools: fc.agentTools,
      runOpts: buildAgentRunOptsForContinue(fc),
      partialResult: run.result,
      reason: 'tool_limit',
      limitInfo: {
        mode: fc.agentMode === 'explore' ? 'Explore' : fc.agentMode === 'plan' ? 'Plan' : 'Agent',
        toolCallsUsed: run.result?.toolCallsUsed,
        maxToolCalls: getAgentToolCallLimit(),
        maxRounds: getAgentMaxRounds()
      },
      workspacePath: sessionActiveRuns.get(fc.runSessionId)?.workspacePath || null,
      fc
    });
  } else if (typeof clearAgentContinueState === 'function') {
    clearAgentContinueState(fc.runSessionId);
  }
  finalizeAssistantBubble(fc.runSessionId, fc.placeholder, {
    content: run.result.content || '',
    trace: run.result.trace || [],
    hitRoundLimit: true
  });
  emitAgentRunEvent(fc.runSessionId, AGENT_RUN_EVENT_TYPES.ROUND_LIMIT, {
    trace: run.result.trace || [],
    streamContent: run.result.content || '',
    hitRoundLimit: true,
    requestId: fc.agentServiceRequestId || null
  });
  if (fc.turnMeta && fc.userMsgIndex >= 0) {
    if (
      typeof canMutateViewMessages !== 'function' ||
      canMutateViewMessages(fc.runSessionId)
    ) {
      messages[fc.userMsgIndex].meta = fc.turnMeta;
    }
  }
}

function isGatewayTransportDisconnectError(err) {
  const msg = String((err && err.message) || err || '');
  return /Gateway\s*(未就绪|已断开)|WebSocket\s*已关闭|连接已关闭/.test(msg);
}

function shouldPauseForNetworkDisconnect(err, fc) {
  if (err?.partialResult?.body && err.networkDisconnect) return true;
  if (!isGatewayTransportDisconnectError(err)) return false;
  const live = fc && sessionActiveRuns.get(fc.runSessionId);
  return !!(
    live &&
    fc.payload &&
    ((Array.isArray(live.trace) && live.trace.length) || live.streamContent)
  );
}

async function pauseAgentForNetworkDisconnect(fc, err) {
  let partial = err.partialResult;
  if (!partial?.body) {
    const live = sessionActiveRuns.get(fc.runSessionId);
    if (!live || !fc.payload) return false;
    partial = {
      content: live.streamContent || '',
      trace: live.trace || [],
      body: fc.payload,
      toolFingerprintHistory: [],
      tokensUsed: 0,
      tokenUsage: null,
      runId: live.runId || fc.agentRunId || null
    };
  }
  if (!partial?.body) return false;
  const fromGateway = isGatewayTransportDisconnectError(err);
  showAgentToast(
    fromGateway ? 'Gateway 连接中断' : '模型连接中断',
    '可点击「继续」或发送「继续」从断点恢复',
    { variant: 'warn' }
  );
  setAgentContinueState({
    sessionId: fc.runSessionId,
    placeholder: fc.placeholder,
    payload: fc.payload,
    agentTools: fc.agentTools,
    runOpts: buildAgentRunOptsForContinue(fc),
    partialResult: partial,
    fc,
    reason: 'network',
    runId: partial.runId || fc.agentRunId || null
  });
  finalizeAssistantBubble(fc.runSessionId, fc.placeholder, {
    content: partial.content || '连接中断，已保存当前进度。',
    trace: partial.trace || [],
    hitRoundLimit: true
  });
  emitAgentRunEvent(fc.runSessionId, AGENT_RUN_EVENT_TYPES.ROUND_LIMIT, {
    trace: partial.trace || [],
    streamContent: partial.content || '',
    hitRoundLimit: true,
    networkDisconnect: true,
    requestId: fc.agentServiceRequestId || null
  });
  if (fc.turnMeta && fc.userMsgIndex >= 0) {
    if (
      typeof canMutateViewMessages !== 'function' ||
      canMutateViewMessages(fc.runSessionId)
    ) {
      messages[fc.userMsgIndex].meta = fc.turnMeta;
    }
  }
  const userMessageId =
    typeof fc.ensureUserLocalMsgId === 'function'
      ? await fc.ensureUserLocalMsgId().catch(() => null)
      : null;
  await persistNetworkPausedTurn({
    sessionId: fc.runSessionId,
    runId: partial.runId || fc.agentRunId || null,
    partial,
    userMessageId
  });
  return true;
}

/**
 * 采集浏览器侧验收证据：只有 trace 里用过 browser_* 工具才查询，避免误报。
 * console error / 未捕获异常 / 5xx 或请求级失败 → errorCount（触发验收提示）；
 * 4xx 只作上下文不单独触发（favicon、统计接口等常见噪声）。
 */
async function collectBrowserEvidenceForRun(trace, opts = {}) {
  let used = false;
  for (const entry of trace || []) {
    for (const tool of entry.tools || []) {
      if (String(tool?.name || '').trim().startsWith('browser_')) {
        used = true;
        break;
      }
    }
    if (used) break;
  }
  if (!used || !gwState.authed || typeof gatewayCall !== 'function') return null;

  const out = { errorCount: 0, errors: [], consoleErrorCount: 0, networkErrorCount: 0 };
  const scope = { sessionId: opts.sessionId || undefined };

  try {
    const con = await gatewayCall('browser.console', {
      action: 'list',
      errorsOnly: true,
      limit: 20,
      ...scope
    });
    const rows = con && Array.isArray(con.entries) ? con.entries : [];
    out.consoleErrorCount = rows.length;
    out.errors.push(
      ...rows
        .slice(-5)
        .map((e) => `[${e.source || 'console'}] ${String(e.text || '').trim()}`.slice(0, 160))
    );
  } catch {
    /* 浏览器服务不可用时忽略 */
  }

  try {
    const net = await gatewayCall('browser.network', {
      action: 'list',
      errorsOnly: true,
      limit: 20,
      ...scope
    });
    const rows = net && Array.isArray(net.entries) ? net.entries : [];
    const hard = rows.filter((e) => Number(e.status) >= 500 || !e.status);
    out.networkErrorCount = hard.length;
    out.errors.push(
      ...hard
        .slice(-5)
        .map((e) =>
          `${e.method || 'GET'} ${String(e.url || '').slice(0, 100)} → ${e.status || e.error || 'failed'}`.slice(
            0,
            160
          )
        )
    );
  } catch {
    /* ignore */
  }

  out.errorCount = out.consoleErrorCount + out.networkErrorCount;
  return out;
}

async function collectCompletionDiagnosticsForRun(trace, sessionChanges, opts = {}) {
  if (typeof getTraceWriteFilePaths !== 'function' || typeof fetchWorkspaceVerifyDiagnostics !== 'function') {
    return null;
  }
  const paths = [...new Set(getTraceWriteFilePaths(trace || []))].slice(0, 6);
  if (!paths.length) return null;

  const diagnostics = await fetchWorkspaceVerifyDiagnostics(paths, {
    timeoutMs: 8000,
    sessionId: opts.sessionId,
    workspaceRoot: opts.workspaceRoot || opts.workspacePath || null
  });
  if (!diagnostics) return null;

  if (Array.isArray(trace)) {
    trace.push({
      round: trace.length + 1,
      phase: '完成验收',
      thought: diagnostics.hasErrors
        ? '静态检查发现 error，已作为完成验收证据。'
        : '静态检查通过，已作为完成验收证据。',
      tools: [
        {
          name: 'workspace.diagnostics',
          argsBrief: paths.join(', '),
          summary: diagnostics.hasErrors ? '发现 error 级诊断' : '静态检查通过',
          result: diagnostics.text || '',
          failed: !!diagnostics.hasErrors,
          toolArgs: { files: paths }
        }
      ]
    });
  }

  return diagnostics;
}

function mergeRetryTrace(baseTrace, retryTrace) {
  const base = Array.isArray(baseTrace) ? baseTrace : [];
  const next = Array.isArray(retryTrace) ? retryTrace : [];
  if (!base.length) return next;
  const offset = base.length;
  return base.concat(
    next.map((entry, idx) => ({
      ...entry,
      round: offset + idx + 1
    }))
  );
}

async function completeAgentRunAfterSuccess(run, fc) {
  const rawReply = run.result?.content || '';
  const trace = Array.isArray(run.result?.trace) ? run.result.trace : [];
  const runSessionId = fc.runSessionId;
  const completingRunId = fc.agentRunId || run.result?.runId || null;
  if (typeof holdComposerQueueFlush === 'function') holdComposerQueueFlush(runSessionId);
  try {
  const artifactVisible = String(runSessionId) === String(currentSessionId || '');
  const reviewAccepted = !!(run.result?.review?.accepted);
  const isPlanRun = !!(run.result?.plan);
  const agentTerminalStatus = 'final';
  let completionGatePassed = true;
  let finalReadiness = null;
  let reply = normalizeAssistantReplyForStorage(rawReply, trace);
  if (
    String(runSessionId) === String(currentSessionId || '') &&
    typeof settleAssistantBubbleAfterLoop === 'function'
  ) {
    settleAssistantBubbleAfterLoop(runSessionId, fc.placeholder, {
      content: reply,
      trace
    });
  }
  const planWorktreeRun = !!(run.result?.deferWorktreeCleanup && run.result?.runId);
  const planTraceFallback =
    typeof window.shouldPlanUseTraceDiffFallback === 'function' &&
    window.shouldPlanUseTraceDiffFallback();
  {
    if (typeof trackArtifactsFromTrace === 'function' && (!planWorktreeRun || planTraceFallback)) {
      trackArtifactsFromTrace(trace || [], { sessionId: runSessionId });
    }
    if (run.result?.plan && typeof window.syncPlanPreviewFromPlan === 'function') {
      if (artifactVisible) {
        const hasTraceRows =
          typeof getSessionChangeRowsForAgent === 'function' &&
          getSessionChangeRowsForAgent(runSessionId).length > 0;
        const traceFallback =
          typeof window.shouldPlanUseTraceDiffFallback === 'function' &&
          window.shouldPlanUseTraceDiffFallback();
        if (traceFallback && hasTraceRows && typeof window.clearPlanPreviewState === 'function') {
          window.clearPlanPreviewState();
        } else {
          window.syncPlanPreviewFromPlan(run.result.plan);
        }
      }
    }
    if (artifactVisible) {
      if (typeof window.patchChangesPane === 'function') window.patchChangesPane();
      else if (typeof renderChangesPane === 'function') renderChangesPane();
    }
    const sessionChanges =
      typeof getSessionChangeRowsForAgent === 'function'
        ? getSessionChangeRowsForAgent(runSessionId)
        : [];
    const runWs =
      (typeof sessionActiveRuns !== 'undefined' &&
        sessionActiveRuns.get(runSessionId)?.workspacePath) ||
      null;
    const diagnostics = await collectCompletionDiagnosticsForRun(trace, sessionChanges, {
      sessionId: runSessionId,
      workspaceRoot: runWs
    });
    const browserEvidence = await collectBrowserEvidenceForRun(trace, { sessionId: runSessionId });
    if (typeof verifyAgentCompletionReadiness === 'function') {
      const ruleGate = verifyAgentCompletionReadiness(rawReply, trace, sessionChanges, {
        userText: fc.fullText,
        mode: fc.agentMode || 'agent',
        diagnostics,
        browser: browserEvidence,
        retryAttempt: fc.readinessRetryAttempt || 0,
        readinessRetryAttempt: fc.readinessRetryAttempt || 0,
        taskTier: fc.taskTier || null
      });
      if (!ruleGate.ok && !ruleGate.skipped) {
        finalReadiness = { ...ruleGate, shouldRetry: false, surfaceToUser: true };
      }
    }
    if (completionGatePassed && typeof runReviewerValidation === 'function') {
      const reviewer = await runReviewerValidation(run, fc, {
        sessionChanges,
        diagnostics,
        trace,
        browser: browserEvidence
      });
      if (reviewer && !reviewer.ok) {
        completionGatePassed = false;
        finalReadiness = { ...reviewer, shouldRetry: false, surfaceToUser: true };
      }
    }
    if (typeof applyReadinessNote === 'function') {
      reply = applyReadinessNote(reply, finalReadiness);
    }
  }
  const deferWorktree = !!(run.result?.deferWorktreeCleanup && run.result?.runId);
  let worktreePreviewForDialog = null;
  if (deferWorktree && run.result?.runId && loopApi.worktreePreviewRun) {
    try {
      worktreePreviewForDialog = await loopApi.worktreePreviewRun(run.result.runId);
    } catch {
      worktreePreviewForDialog = null;
    }
  }
  const hasWorktreeChanges = !!(
    worktreePreviewForDialog?.ok && worktreePreviewForDialog?.changes?.length
  );
  // await 后再判：切会话后勿弹 worktree / 勿写前台 messages
  let viewingRunSession = String(runSessionId) === String(currentSessionId || '');
  let backgroundDone = !viewingRunSession;
  const needsWorktreeDialog =
    completionGatePassed && deferWorktree && viewingRunSession && (reviewAccepted || hasWorktreeChanges);
  const completionStatus = !completionGatePassed
    ? agentTerminalStatus === 'ask_user'
      ? 'awaiting_user'
      : 'blocked'
    : deferWorktree && (reviewAccepted || hasWorktreeChanges)
      ? 'pending_apply'
      : 'completed';
  emitAgentRunEvent(runSessionId, AGENT_RUN_EVENT_TYPES.DONE, {
    trace: trace || [],
    streamContent: reply,
    summary: compactPlainText(reply, 200),
    runId: completingRunId || run.result?.runId || null,
    requestId: fc.agentServiceRequestId || null,
    meta: { isPlanRun, reviewAccepted, completionGatePassed, completionStatus, agentStatus: agentTerminalStatus }
  });
  if (gwState.authed) {
    void gatewayCall('plugins.hooks.agent_turn_end', {
      sessionId: runSessionId,
      ok: completionGatePassed,
      isPlanRun,
      reviewAccepted,
      summary: compactPlainText(reply, 400),
      runId: run.result?.runId || null
    }).catch(() => {});
  }
  /** @type {object | null} */
  let knowledgeBase = null;

  {
    let consolidationWorkspace = null;
    const liveWs = sessionActiveRuns.get(runSessionId)?.workspacePath;
    if (liveWs) {
      consolidationWorkspace = String(liveWs);
    } else if (typeof resolveSessionWorkspacePath === 'function') {
      try {
        consolidationWorkspace = await resolveSessionWorkspacePath(runSessionId);
      } catch {
        consolidationWorkspace = null;
      }
    }
    if (!consolidationWorkspace && String(runSessionId) === String(currentSessionId || '') && loopApi.getWorkspace) {
      try {
        const ws = await loopApi.getWorkspace();
        consolidationWorkspace = ws && ws.workspacePath ? ws.workspacePath : null;
      } catch {
        // ignore
      }
    }
    const sessionChanges =
      consolidationWorkspace && typeof getSessionChangeRowsForAgent === 'function'
        ? getSessionChangeRowsForAgent(runSessionId)
        : [];
    let agentsMdSnapshot = '';
    if (consolidationWorkspace && typeof getAgentsMdMode === 'function' && getAgentsMdMode() !== 'off') {
      try {
        if (typeof ensureAgentsMd === 'function') await ensureAgentsMd(consolidationWorkspace);
        if (typeof loadAgentsMdRecord === 'function') {
          const rec = await loadAgentsMdRecord(consolidationWorkspace);
          agentsMdSnapshot = String(rec?.content || '').slice(0, 12000);
        }
      } catch {
        agentsMdSnapshot = '';
      }
    }
    knowledgeBase = {
      reason: completionGatePassed ? 'task_completed' : 'task_not_completed',
      memorySource: 'auto_consolidation',
      source: completionGatePassed
        ? isPlanRun && reviewAccepted
          ? 'plan-completed'
          : 'task-completed'
        : completionStatus,
      userText: fc.fullText,
      assistantText: reply,
      trace,
      changes: sessionChanges,
      sessionId: runSessionId,
      workspacePath: consolidationWorkspace,
      agentsMdSnapshot,
      model: fc.composerModel,
      apiConfig: fc.apiConfig,
      plan: run.result?.plan,
      review: run.result?.review,
      reviewAccepted,
      isPlanRun,
      delayMs: 15000
    };

    const skipKnowledge = !completionGatePassed || (isPlanRun && !reviewAccepted);
    const traceWriteEvidence = (trace || []).some((entry) =>
      (entry.tools || []).some((t) => {
        if (t && t.pending) return false;
        const n = String((t && t.name) || '').toLowerCase();
        return /write|edit|str_replace|apply_patch|search_replace/.test(n);
      })
    );
    if (
      deferWorktree &&
      (!completionGatePassed ||
        (isPlanRun && !reviewAccepted && !hasWorktreeChanges && !traceWriteEvidence)) &&
      loopApi.worktreeCleanupRun
    ) {
      loopApi.worktreeCleanupRun(run.result.runId).catch(() => scheduleWorktreePolicyCleanup());
      if (typeof clearKnowledgeMaintenanceContext === 'function') {
        clearKnowledgeMaintenanceContext(runSessionId);
      }
    } else if (!skipKnowledge) {
      if (completionGatePassed && deferWorktree && reviewAccepted && consolidationWorkspace) {
        stashKnowledgeMaintenanceContext(knowledgeBase);
        if (backgroundDone && typeof scheduleBackgroundKnowledgeFallback === 'function') {
          scheduleBackgroundKnowledgeFallback(runSessionId);
        }
      } else {
        scheduleUnifiedKnowledgeMaintenance(knowledgeBase);
      }
    }
  }
  const state = buildAgentStateSnapshot({
    reply,
    trace,
    plan: run.result?.plan,
    results: run.result?.results,
    review: run.result?.review,
    status: completionStatus
  });
  const agentRunId = completingRunId || fc.agentRunId || run.result?.runId || createTraceRunId();
  const traceRunId = trace && trace.length ? agentRunId : null;

  const liveForCompletion = sessionActiveRuns.get(runSessionId);
  const liveBelongsToThisRun =
    !!liveForCompletion &&
    !(
      typeof isStaleSessionRunEvent === 'function' &&
      isStaleSessionRunEvent(liveForCompletion, agentRunId)
    );
  if (liveBelongsToThisRun) {
    liveForCompletion.traceCheckpointClosed = true;
    liveForCompletion.trace = trace || [];
    pushAgentServiceProgress(liveForCompletion, runSessionId, trace || [], true);
  }
  if (!needsWorktreeDialog && liveBelongsToThisRun) {
    finishSessionActiveRun(runSessionId, agentRunId);
  } else if (!needsWorktreeDialog && !liveForCompletion) {
    finishSessionActiveRun(runSessionId, agentRunId);
  }

  await finalizeUndoForUserTurn(
    fc.userMsgIndex,
    fc.undoTurnId || fc.turnMeta?.undoTurnId,
    runSessionId
  );

  // 知识沉淀等 await 之后再判，避免写到正在看的其它会话
  viewingRunSession = String(runSessionId) === String(currentSessionId || '');
  backgroundDone = !viewingRunSession;

  const userMeta =
    viewingRunSession && fc.userMsgIndex >= 0 ? messages[fc.userMsgIndex]?.meta || {} : {};
  const baseTurnMeta = {
    ...(fc.turnMeta || {}),
    ...userMeta,
    modeLabel: userMeta.modeLabel || fc.turnMeta?.modeLabel || composerModeLabel(),
    modelLabel:
      userMeta.modelLabel ||
      fc.turnMeta?.modelLabel ||
      formatModelFooterLabel(fc.composerModel || getTextModelId(settings)),
    modelId: userMeta.modelId || fc.composerModel || fc.turnMeta?.modelId || getTextModelId(settings),
    ts:
      userMeta.ts ||
      fc.turnMeta?.ts ||
      (viewingRunSession && fc.userMsgIndex >= 0
        ? messages[fc.userMsgIndex]?.created_at
        : Date.now())
  };
  const assistantMeta = traceRunId ? { ...baseTurnMeta, traceRunId } : baseTurnMeta;
  const persistedBody = buildPersistedAssistantContent(
    persistAssistantTranscriptText(reply, trace)
  );
  const persisted = packAssistantMeta(persistedBody, assistantMeta);

  const userLocalMsgId = await fc.ensureUserLocalMsgId();

  if (backgroundDone) {
    showTrayBalloon(completionGatePassed ? '后台任务已完成' : '后台任务未完成', toastPreviewText(reply));
    if (typeof invalidateSessionMessageCache === 'function') {
      invalidateSessionMessageCache(runSessionId);
    }
    if (gwState.authed) {
      try {
        const ins = await gatewayCall('memory.message_append', {
          sessionId: runSessionId,
          role: 'assistant',
          content: persisted
        });
        await saveAgentRunState({
          runId: agentRunId,
          sessionId: runSessionId,
          assistantMessageId: ins?.localMsgId,
          userMessageId: userLocalMsgId,
          status: completionStatus,
          summary: state.summary,
          stateSnapshot: state.snapshot
        });
        await saveAssistantTraceRecord({
          runId: traceRunId,
          sessionId: runSessionId,
          messageId: ins?.localMsgId,
          userMessageId: userLocalMsgId,
          trace,
          summary: state.summary,
          stateSnapshot: state.snapshot
        });
        await saveAgentPlanState({
          runId: agentRunId,
          sessionId: runSessionId,
          plan: run.result?.plan,
          results: run.result?.results,
          summary: state.summary,
          stateSnapshot: state.snapshot,
          status: completionStatus
        });
        refreshHistoryList();
      } catch (e) {
        console.warn(e);
      }
    }
    if (completionGatePassed && deferWorktree && reviewAccepted) {
      await openWorktreeReviewAfterPlan(
        run.result.runId,
        runSessionId,
        fc.undoTurnId || fc.turnMeta?.undoTurnId || null,
        knowledgeBase
      );
    }
  } else {
    // 再确认一次：前面若又 await 过，可能已切走
    if (String(runSessionId) !== String(currentSessionId || '')) {
      if (typeof invalidateSessionMessageCache === 'function') {
        invalidateSessionMessageCache(runSessionId);
      }
      showTrayBalloon(completionGatePassed ? '后台任务已完成' : '后台任务未完成', toastPreviewText(reply));
      if (gwState.authed) {
        try {
          const ins = await gatewayCall('memory.message_append', {
            sessionId: runSessionId,
            role: 'assistant',
            content: persisted
          });
          await saveAgentRunState({
            runId: agentRunId,
            sessionId: runSessionId,
            assistantMessageId: ins?.localMsgId,
            userMessageId: userLocalMsgId,
            status: completionStatus,
            summary: state.summary,
            stateSnapshot: state.snapshot
          });
          await saveAssistantTraceRecord({
            runId: traceRunId,
            sessionId: runSessionId,
            messageId: ins?.localMsgId,
            userMessageId: userLocalMsgId,
            trace,
            summary: state.summary,
            stateSnapshot: state.snapshot
          });
          await saveAgentPlanState({
            runId: agentRunId,
            sessionId: runSessionId,
            plan: run.result?.plan,
            results: run.result?.results,
            summary: state.summary,
            stateSnapshot: state.snapshot,
            status: completionStatus
          });
          refreshHistoryList();
        } catch (e) {
          console.warn(e);
        }
      }
    } else {
    const assistantMsg = {
      role: 'assistant',
      content: persisted,
      transientTrace: trace || []
    };
    messages.push(assistantMsg);
    const liveBeforeRender = sessionActiveRuns.get(runSessionId);
    if (
      liveBeforeRender &&
      !(
        typeof isStaleSessionRunEvent === 'function' &&
        isStaleSessionRunEvent(liveBeforeRender, agentRunId)
      )
    ) {
      liveBeforeRender.finished = true;
      liveBeforeRender.streamContent = reply;
      liveBeforeRender.trace = trace || [];
    }
    if (typeof renderChatFromMessagesYielding === 'function') {
      await renderChatFromMessagesYielding({ forceScroll: true, sessionId: runSessionId });
    } else {
      renderChatFromMessages({ forceScroll: true, sessionId: runSessionId });
    }
    if (String(runSessionId) !== String(currentSessionId || '')) {
      if (typeof invalidateSessionMessageCache === 'function') {
        invalidateSessionMessageCache(runSessionId);
      }
      showTrayBalloon(completionGatePassed ? '后台任务已完成' : '后台任务未完成', toastPreviewText(reply));
      if (gwState.authed) {
        try {
          const ins = await gatewayCall('memory.message_append', {
            sessionId: runSessionId,
            role: 'assistant',
            content: persisted
          });
          if (ins?.localMsgId) {
            assistantMsg.localMsgId = ins.localMsgId;
            assistantMsg.id = ins.localMsgId;
          }
          await saveAgentRunState({
            runId: agentRunId,
            sessionId: runSessionId,
            assistantMessageId: ins?.localMsgId,
            userMessageId: userLocalMsgId,
            status: completionStatus,
            summary: state.summary,
            stateSnapshot: state.snapshot
          });
          await saveAssistantTraceRecord({
            runId: traceRunId,
            sessionId: runSessionId,
            messageId: ins?.localMsgId,
            userMessageId: userLocalMsgId,
            trace,
            summary: state.summary,
            stateSnapshot: state.snapshot
          });
          await saveAgentPlanState({
            runId: agentRunId,
            sessionId: runSessionId,
            plan: run.result?.plan,
            results: run.result?.results,
            summary: state.summary,
            stateSnapshot: state.snapshot,
            status: completionStatus
          });
          refreshHistoryList();
        } catch (e) {
          console.warn(e);
        }
      }
    } else {
    refreshContextProgress();
    const userTurnEl = chatList.querySelector('.msg-turn:last-of-type');
    const footerMeta = {
      ...(fc.turnMeta || {}),
      ...(messages[fc.userMsgIndex]?.meta || {})
    };
    finalizeUserTurnFooter(userTurnEl, fc.userMsgIndex, footerMeta);
    if (typeof ensureChatScrollAfterLayout === 'function') {
      await ensureChatScrollAfterLayout({ force: true, revealAnswer: true });
    } else {
      scrollChatToBottom({ force: true });
    }
    showTrayBalloon(completionGatePassed ? '任务已完成' : '任务未完成', toastPreviewText(reply));
    if (gwState.authed) {
      try {
        const ins = await gatewayCall('memory.message_append', {
          sessionId: runSessionId,
          role: 'assistant',
          content: persisted
        });
        if (ins?.localMsgId) {
          assistantMsg.localMsgId = ins.localMsgId;
          assistantMsg.id = ins.localMsgId;
        }
        await saveAgentRunState({
          runId: agentRunId,
          sessionId: runSessionId,
          assistantMessageId: ins?.localMsgId,
          userMessageId: userLocalMsgId,
          status: completionStatus,
          summary: state.summary,
          stateSnapshot: state.snapshot
        });
        await saveAssistantTraceRecord({
          runId: traceRunId,
          sessionId: runSessionId,
          messageId: ins?.localMsgId,
          userMessageId: userLocalMsgId,
          trace,
          summary: state.summary,
          stateSnapshot: state.snapshot
        });
        await saveAgentPlanState({
          runId: agentRunId,
          sessionId: runSessionId,
          plan: run.result?.plan,
          results: run.result?.results,
          summary: state.summary,
          stateSnapshot: state.snapshot,
          status: completionStatus
        });
        refreshHistoryList();
      } catch (e) {
        console.warn(e);
      }
    }
    if (needsWorktreeDialog && String(runSessionId) === String(currentSessionId || '')) {
      await openWorktreeReviewAfterPlan(
        run.result.runId,
        runSessionId,
        fc.undoTurnId || fc.turnMeta?.undoTurnId || null,
        knowledgeBase
      );
      const liveAfterWorktree = sessionActiveRuns.get(runSessionId);
      if (
        !liveAfterWorktree ||
        !(
          typeof isStaleSessionRunEvent === 'function' &&
          isStaleSessionRunEvent(liveAfterWorktree, agentRunId)
        )
      ) {
        finishSessionActiveRun(runSessionId, agentRunId);
      }
      if (fc.userMsgIndex >= 0 && String(runSessionId) === String(currentSessionId || '')) {
        const userTurnEl2 = chatList.querySelector('.msg-turn:last-of-type');
        const footerMeta2 = {
          ...(fc.turnMeta || {}),
          ...(messages[fc.userMsgIndex]?.meta || {})
        };
        finalizeUserTurnFooter(userTurnEl2, fc.userMsgIndex, footerMeta2);
      }
      if (String(runSessionId) === String(currentSessionId || '')) {
        syncComposerForActiveSession();
      }
    }
    } // end still viewing after render
    } // end still-viewing foreground branch
  }
  fc.notifyAgentServiceDone({
    status: completionStatus,
    sessionId: runSessionId,
    runId: agentRunId,
    summary: state.summary,
    trace: cloneTraceForMobile(trace || [])
  });
  } finally {
    if (typeof clearComposerQueuePause === 'function') {
      clearComposerQueuePause(runSessionId);
    }
    if (typeof releaseComposerQueueFlush === 'function') {
      releaseComposerQueueFlush(runSessionId);
    }
    // hold 解除后立刻尝试 flush；避免只在 hold 期间 sync 导致队列空转
    if (
      String(runSessionId) === String(currentSessionId || '') &&
      typeof syncComposerForActiveSession === 'function'
    ) {
      syncComposerForActiveSession();
    }
  }
}
