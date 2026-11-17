/* global sessionActiveRuns, currentSessionId, messages, loopApi, settings, gwState, showAgentToast, finalizeAssistantBubble, settleAssistantBubbleAfterLoop, finalizeUserTurnFooter, renderAssistantBubbleContent, resolveRunPlaceholder, runAgentCompletion, getSessionAbortSignal, createAgentAbortError, throwIfAgentAborted, waitForAgentAbortable, isUserAbortError, formatAgentApiError, compactPlainText, applyReadinessNote, capturePlanApplyForUndo, handleWorktreeApplyAfterRun, beginPlanWorktreeTracking, schedulePlanWorktreeChangesRefresh, openWorktreeReviewAfterPlan, maybeEnforceWorktreeCleanupPolicy, scheduleWorktreePolicyCleanup, markTurnWorktreeOnly, getCurrentUndoTurnId, finalizeUndoForUserTurn, saveAgentPlanState, saveAgentRunState, saveAssistantTraceRecord, persistStoppedAssistant, buildAgentStateSnapshot, stepsFromAgentPlan, trackArtifactsFromTrace, emitAgentRunEvent, AGENT_RUN_EVENT_TYPES, finishSessionActiveRun, syncComposerForActiveSession, noteComposerSessionUsage, reportTokensToMain, clearAgentContinueState, setAgentContinueState, setPlannerParallelWorkersActive, setAgentExecutionContext, invalidateSessionMessageCache, refreshHistoryList, scrollChat, collapseChatThinkingTraces, packAssistantMeta, buildPersistedAssistantContent, persistAssistantTranscriptText, extractBookPrefixMessages, reprojectContinueLoopMessages, refreshTurnRideFromArchive, normalizeAssistantReplyForStorage, unpackAssistantMeta, splitPersistedAssistantTrace, humanizeModelId, formatModelFooterLabel, getTextModelId, buildStoppedFooterMeta, buildFallbackTurnMeta, resolveUserMsgCreatedAt, withdrawUserTurn, appendBubble, agentApi, captureTurnBatchCheckpoint, getPendingWorktreeApply, clearPendingResumeCheckpoint, tryDetectResumeCheckpoint, maybeSaveRunningTraceCheckpoint, createTraceRunId, getAgentToolCallLimit, getAgentMaxRounds, clearComposerQueuePause, getAgentLimits, AgentRoundText */
'use strict';

function buildAgentRunOptsForContinue(fc) {
  return {
    apiConfig: fc.apiConfig,
    modelRoute: fc.modelRoute,
    sessionId: fc.runSessionId,
    userText: fc.fullText,
    userContent: fc.userContent,
    hasImages: fc.hasImages,
    sysContent: fc.sysContent,
    turnRide: fc.turnRide,
    bookPrefixMessages: fc.bookPrefixMessages
  };
}

function pauseAgentForToolLimit(run, fc) {
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
  // 层级标注：能走到这里说明请求级自动重连（llm_reconnect_wait，文案含剩余时长）
  // 已经耗尽，与第一层「仍在自动重试」区分开，用户才不会对着同一次故障误判当前层级。
  const reconnectExhausted = err?.code === 'LLM_RECONNECT_EXHAUSTED';
  showAgentToast(
    fromGateway ? 'Gateway 连接中断' : reconnectExhausted ? '模型自动重连已耗尽' : '模型连接中断',
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
 * 分段收尾：把本段 trace 接到已有前缀后面，轮次号连续。
 * （原 `mergeRetryTrace`：完成验收自动重试已删除，这里只剩「续段拼接」一个用途。）
 */
function mergeTraceSegments(baseTrace, segmentTrace) {
  const base = Array.isArray(baseTrace) ? baseTrace : [];
  const next = Array.isArray(segmentTrace) ? segmentTrace : [];
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
    // 完成验收的判定在 Main（证据 = 循环账本 trace + Gateway 的静态诊断/浏览器证据）。
    // Renderer 只消费结论、渲染 note：不判定、不重采证据、不自动续跑。
    const readiness =
      run.result && run.result.readiness && typeof run.result.readiness === 'object'
        ? run.result.readiness
        : null;
    if (readiness && readiness.ok === false) {
      finalReadiness = { ...readiness, shouldRetry: false, surfaceToUser: true };
    }
    // 独立 Reviewer 的判定已在 Main 收尾时合流进 `run.result.readiness`（`turn-reviewer-run.js`
    // + `mergeReviewerIntoReadiness`）：Renderer 不再发请求、不判「谁优先」。
    //
    // **只有 Reviewer 的否决才翻交付闸门**（托盘「任务未完成」/`completionStatus`）：证据判定
    // （浏览器错误、验证命令非零退出…）按 `completion-readiness.js` 的定位只提示、不挡交付，
    // 否则日常开发里「跑了个会失败的测试」就会把托盘翻成未完成。
    if (readiness && readiness.ok === false && readiness.reason === 'reviewer_validation_failed') {
      completionGatePassed = false;
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
    meta: {
      isPlanRun,
      reviewAccepted,
      completionGatePassed,
      completionStatus,
      agentStatus: agentTerminalStatus,
      // 验收结论的可追溯字段（正文里已带 note；这里只留原因码，便于排查与手机端）
      readinessReason: finalReadiness ? finalReadiness.reason || null : null
    }
  });
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
  // 本轮真思考：与 content 分列落库（messages.reasoning），只作上行回传真值来源，
  // 不并进 content、不进历史重建的正文（REASONING-ISOLATION §3.5 / D1）。
  // 提取单一来源 agent-round-text.reasoningTextFromTrace；bundle 未重建时不落 reasoning。
  const persistedReasoning =
    typeof AgentRoundText !== 'undefined' && typeof AgentRoundText.reasoningTextFromTrace === 'function'
      ? AgentRoundText.reasoningTextFromTrace(trace)
      : '';

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
          content: persisted,
          ...(persistedReasoning ? { reasoning: persistedReasoning } : {})
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
        fc.undoTurnId || fc.turnMeta?.undoTurnId || null
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
            content: persisted,
            ...(persistedReasoning ? { reasoning: persistedReasoning } : {})
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
      transientTrace: trace || [],
      ...(persistedReasoning ? { reasoning: persistedReasoning } : {})
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
            content: persisted,
            ...(persistedReasoning ? { reasoning: persistedReasoning } : {})
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
          content: persisted,
          ...(persistedReasoning ? { reasoning: persistedReasoning } : {})
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
        fc.undoTurnId || fc.turnMeta?.undoTurnId || null
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
