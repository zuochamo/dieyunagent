/* global sessionActiveRuns, currentSessionId, messages, loopApi, settings, gwState, showAgentToast, finalizeAssistantBubble, settleAssistantBubbleAfterLoop, finalizeUserTurnFooter, renderAssistantBubbleContent, resolveRunPlaceholder, runAgentCompletion, getSessionAbortSignal, createAgentAbortError, throwIfAgentAborted, waitForAgentAbortable, isUserAbortError, formatAgentApiError, compactPlainText, applyReadinessNote, capturePlanApplyForUndo, handleWorktreeApplyAfterRun, beginPlanWorktreeTracking, schedulePlanWorktreeChangesRefresh, openWorktreeReviewAfterPlan, maybeEnforceWorktreeCleanupPolicy, scheduleWorktreePolicyCleanup, markTurnWorktreeOnly, getCurrentUndoTurnId, finalizeUndoForUserTurn, saveAgentPlanState, saveAgentRunState, saveAssistantTraceRecord, persistStoppedAssistant, buildAgentStateSnapshot, stepsFromAgentPlan, trackArtifactsFromTrace, emitAgentRunEvent, AGENT_RUN_EVENT_TYPES, finishSessionActiveRun, syncComposerForActiveSession, noteComposerSessionUsage, reportTokensToMain, clearAgentContinueState, setAgentContinueState, setAgentExecutionContext, invalidateSessionMessageCache, refreshHistoryList, scrollChat, collapseChatThinkingTraces, packAssistantMeta, buildPersistedAssistantContent, persistAssistantTranscriptText, extractBookPrefixMessages, reprojectContinueLoopMessages, refreshTurnRideFromArchive, normalizeAssistantReplyForStorage, unpackAssistantMeta, splitPersistedAssistantTrace, humanizeModelId, formatModelFooterLabel, getTextModelId, buildStoppedFooterMeta, buildFallbackTurnMeta, resolveUserMsgCreatedAt, withdrawUserTurn, appendBubble, agentApi, captureTurnBatchCheckpoint, getPendingWorktreeApply, setPendingResumeCheckpoint, clearPendingResumeCheckpoint, tryDetectResumeCheckpoint, maybeSaveRunningTraceCheckpoint, createTraceRunId, getAgentToolCallLimit, getAgentMaxRounds, clearComposerQueuePause, getAgentLimits, AgentRoundText */
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

/**
 * 命中轮次 / 工具段上限：**停车，等用户点「继续」**。
 *
 * 三条事实必须同时成立（2026-11-19 之前三条全错）：
 * 1. **正文不许被吞**：plan 的结果对象没有 `body`，以前走 else 分支把续跑状态清空 ⇒ 气泡空白
 *    （渲染层还额外在 `hitRoundLimit` 时不画正文）+ 没有「继续」行 + 已经产出的正文不落库。
 * 2. **续跑入口要能点**：聊天段用 `setAgentContinueState`；plan 用断点（`setPendingResumeCheckpoint`），
 *    两条入口都由「继续」行与空提交驱动（`sendMessage('', {resumeInterrupted:true})`）。
 * 3. **必须落终态**：不写就会在 `agent_runs` 留一行 `running`，下次进会话被
 *    `recoverInterruptedAssistantTurn` 当成「程序重启/连接断开」再补一条伪中断消息。
 *    这里复用既有落库单一来源 `persistStoppedAssistant`（消息 + trace + 终态同一次写）。
 */
async function pauseAgentForToolLimit(run, fc) {
  const sessionId = fc.runSessionId;
  const result = run.result || {};
  const answer = String(result.content || '').trim();
  const trace = result.trace || [];
  const limitDetail = (() => {
    const used = Number(result.toolCallsUsed);
    const maxTools = Number(getAgentToolCallLimit());
    const maxRounds = Number(getAgentMaxRounds());
    const parts = [];
    if (Number.isFinite(used) && Number.isFinite(maxTools) && maxTools > 0) {
      parts.push(`工具 ${Math.min(used, maxTools)}/${maxTools}`);
    }
    if (Number.isFinite(maxRounds) && maxRounds > 0) parts.push(`最多 ${maxRounds} 轮`);
    return parts.length ? `（${parts.join('，')}）` : '';
  })();
  const pauseNote = `本段预算用完${limitDetail}，已在断点处停下；点「继续」或直接回车接着跑。`;

  // ① 续跑入口：聊天段 vs plan 断点，二者只留一条，别让两个按钮打架
  const plannerResumeRunId = !result.body && result.runId ? String(result.runId) : '';
  if (result.body) {
    setAgentContinueState({
      sessionId,
      placeholder: fc.placeholder,
      payload: fc.payload,
      agentTools: fc.agentTools,
      runOpts: buildAgentRunOptsForContinue(fc),
      partialResult: result,
      reason: 'tool_limit',
      limitInfo: {
        toolCallsUsed: result.toolCallsUsed,
        maxToolCalls: getAgentToolCallLimit(),
        maxRounds: getAgentMaxRounds()
      },
      workspacePath: sessionActiveRuns.get(sessionId)?.workspacePath || null,
      fc
    });
  } else if (plannerResumeRunId && typeof setPendingResumeCheckpoint === 'function') {
    // plan 的断点由 Main 侧 checkpoint 承载（`checkpointSave(coordinatorRunId, …)`），
    // 这里只把「哪个 runId 可以在断点续跑」告诉 UI；续跑走同一个入口。
    setPendingResumeCheckpoint(
      {
        runId: plannerResumeRunId,
        planSummary: String(result.plan?.planSummary || result.plan?.summary || ''),
        sessionId
      },
      sessionId
    );
    if (typeof clearAgentContinueState === 'function') clearAgentContinueState(sessionId);
  } else if (typeof clearAgentContinueState === 'function') {
    clearAgentContinueState(sessionId);
  }

  // ② 气泡：正文照常显示（渲染层只在 `hitRoundLimit` 时补「继续」行，不再藏正文）
  finalizeAssistantBubble(sessionId, fc.placeholder, {
    content: answer,
    trace,
    hitRoundLimit: true
  });
  {
    // 关掉在途的「运行中 checkpoint」写入：否则 ~2.5s 一次的那条 trace_save 会在我们写完
    // 终态之后落库，把 status 翻回 running（Rust 侧终态白名单已改成「非 running 即终态」，
    // 这里是第二道：别再产生那条写入）。
    const live = sessionActiveRuns.get(sessionId);
    if (live) {
      live.traceCheckpointClosed = true;
      live.trace = trace;
    }
  }
  emitAgentRunEvent(sessionId, AGENT_RUN_EVENT_TYPES.ROUND_LIMIT, {
    trace,
    streamContent: answer,
    hitRoundLimit: true,
    requestId: fc.agentServiceRequestId || null
  });
  if (fc.turnMeta && fc.userMsgIndex >= 0) {
    if (
      typeof canMutateViewMessages !== 'function' ||
      canMutateViewMessages(sessionId)
    ) {
      messages[fc.userMsgIndex].meta = fc.turnMeta;
    }
  }

  // ③ 落库（消息 + trace + 终态一次写；status=stopped = 本轮停下了，可从断点继续）
  if (gwState.authed && sessionId && typeof persistStoppedAssistant === 'function') {
    try {
      const runId = fc.agentRunId || sessionActiveRuns.get(sessionId)?.runId || null;
      const replyText = answer ? `${answer}\n\n——（${pauseNote}）` : `（${pauseNote}）`;
      const userMessageId =
        typeof fc.ensureUserLocalMsgId === 'function'
          ? await fc.ensureUserLocalMsgId().catch(() => null)
          : null;
      await persistStoppedAssistant(trace, replyText, fc.turnMeta || null, {
        runId,
        sessionId,
        userMsgIndex: fc.userMsgIndex,
        userMessageId
      });
    } catch (e) {
      console.warn(e);
    }
  }

  // ④ 外部提交（手机 / 频道 / 内网对端）必须收到终态，否则 Main 的 activeRequests 永远挂着：
  //    pause 路径以前什么都不发，ROUND_LIMIT 事件又被「live.finished 早退」挡掉。
  if (typeof fc.notifyAgentServiceDone === 'function') {
    try {
      fc.notifyAgentServiceDone({
        status: 'awaiting_user',
        sessionId,
        runId: fc.agentRunId || null,
        summary: pauseNote,
        trace: Array.isArray(trace) ? trace : []
      });
    } catch {
      // 通知失败不影响交付
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
        // 这里**不吞** append 的异常：写库失败时下面那几行（尤其 `saveAgentRunState` 的
        // `status: completionStatus`）必须一并不执行。否则库里这轮是「终态但没有 assistant
        // 消息」，而 `recoverInterruptedAssistantTurn` 只捞 `status === 'running'` 的轮次 ——
        // 这条话就再也补不回来了。抛出去只让本轮停在 running，界面上的气泡照旧留着。
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
