/* global sessionActiveRuns, currentSessionId, getAgentContinueState, clearAgentContinueState, setComposerSendingState, runAgentCompletion, completeAgentRunAfterSuccess, resolveRunPlaceholder, renderAssistantBubbleContent, finalizeAssistantBubble, finalizeUserTurnFooter, finalizeUndoForUserTurn, isUserAbortError, formatAgentApiError, buildStoppedFooterMeta, finishSessionActiveRun, syncComposerForActiveSession, emitAgentRunEvent, AGENT_RUN_EVENT_TYPES, showAgentToast, createAgentAbortError, pauseComposerQueueAfterUserStop, resolveFailedDisplayTrace, persistFailedAssistantTurn, persistStoppedAssistant, resolveStoppedDisplayTrace, cloneTraceForMobile, shouldPauseForNetworkDisconnect, pauseAgentForNetworkDisconnect, isCurrentSessionSending, dismissAgentContinueRows */
'use strict';

async function resumeAgentToolLoop() {
  const state = getAgentContinueState(currentSessionId);
  if (!state || !state.fc) {
    showAgentToast('无法继续', '没有可恢复的任务');
    return;
  }
  if (state.sessionId !== currentSessionId) {
    showAgentToast('无法继续', '请在本会话中点击继续');
    return;
  }
  if (isCurrentSessionSending()) return;

  const fc = { ...state.fc, placeholder: state.placeholder };
  const runSessionId = fc.runSessionId;
  clearAgentContinueState(runSessionId);

  const resumeWorkspace = state.workspacePath || null;
  if (isRemoteSessionWorkspacePath(resumeWorkspace)) {
    await syncSessionRemoteLease(runSessionId, resumeWorkspace, true);
  }
  const resumeRunId = state.runId || state.partialResult?.runId || '';
  sessionActiveRuns.set(runSessionId, {
    runId: resumeRunId,
    trace: state.partialResult?.trace || [],
    placeholderEl: fc.placeholder,
    agentServiceRequestId: fc.agentServiceRequestId || '',
    streamContent: state.partialResult?.content || '',
    abortController: new AbortController(),
    gatewayRunId: null,
    workspacePath: resumeWorkspace,
    undoTurnId: fc.undoTurnId || fc.turnMeta?.undoTurnId || null,
    agentRunMode: state.runOpts && state.runOpts.forcePlanner ? 'plan' : 'agent'
  });
  const resumeAbortController = sessionActiveRuns.get(runSessionId).abortController;
  refreshHistoryList().catch(() => {});

  const placeholder = resolveRunPlaceholder(runSessionId, fc.placeholder) || fc.placeholder;
  fc.placeholder = placeholder;
  if (placeholder) {
    placeholder.classList.add('loading');
    placeholder.classList.remove('error');
    if (typeof dismissAgentContinueRows === 'function') dismissAgentContinueRows(placeholder);
  }
  syncComposerForActiveSession();
  const resumeUndoTurnId =
    fc.undoTurnId ||
    fc.turnMeta?.undoTurnId ||
    (typeof getUndoTurnIdForSession === 'function' ? getUndoTurnIdForSession(runSessionId) : null);
  const cp = resumeUndoTurnId ? { undoTurnId: resumeUndoTurnId, checkpointRestore: true } : null;
  renderAssistantBubbleContent(placeholder, {
    content: state.partialResult?.content || '',
    trace: state.partialResult?.trace || [],
    loading: true,
    undoTurnId: cp?.undoTurnId || null,
    checkpointRestore: !!cp
  });

  try {
    const run = await runAgentCompletion(fc.payload, fc.agentTools, placeholder, {
      ...state.runOpts,
      signal: resumeAbortController.signal,
      continueFrom: state.partialResult,
      undoTurnId: resumeUndoTurnId || undefined,
      sessionId: runSessionId
    });
    if (!run.done) {
      pauseAgentForToolLimit(run, fc);
      return;
    }
    await completeAgentRunAfterSuccess(run, fc);
  } catch (err) {
    if (err.name === 'AbortError' || isUserAbortError(err)) {
      if (typeof pauseComposerQueueAfterUserStop === 'function') {
        pauseComposerQueueAfterUserStop(runSessionId);
      }
      const liveRun = sessionActiveRuns.get(runSessionId);
      const stoppedTrace =
        typeof resolveStoppedDisplayTrace === 'function'
          ? resolveStoppedDisplayTrace(
              err.trace || liveRun?.trace || getLastAgentDisplayedTrace(runSessionId) || []
            )
          : normalizeStoppedTrace(
              err.trace || liveRun?.trace || getLastAgentDisplayedTrace(runSessionId) || []
            );
      if (liveRun) liveRun.traceCheckpointClosed = true;
      finalizeAssistantBubble(runSessionId, placeholder, {
        content: '已停止生成。',
        trace: stoppedTrace,
        stopped: true
      });
      emitAgentRunEvent(runSessionId, AGENT_RUN_EVENT_TYPES.STOPPED, {
        trace: stoppedTrace,
        streamContent: '已停止生成。',
        stopped: true,
        requestId: fc.agentServiceRequestId || null
      });
      await finalizeUndoForUserTurn(
        fc.userMsgIndex,
        fc.undoTurnId ||
          fc.turnMeta?.undoTurnId ||
          messages[fc.userMsgIndex]?.meta?.undoTurnId ||
          null,
        runSessionId
      );
      const stoppedFooterMeta = {
        ...(fc.turnMeta || {}),
        ...(messages[fc.userMsgIndex]?.meta || {})
      };
      await persistStoppedAssistant(stoppedTrace, '已停止生成。', stoppedFooterMeta, {
        runId: liveRun?.runId || null,
        sessionId: runSessionId,
        userMsgIndex: fc.userMsgIndex,
        userMessageId: await fc.ensureUserLocalMsgId()
      });
      if (fc.userMsgIndex >= 0) {
        finalizeUserTurnFooter(fc.userTurn, fc.userMsgIndex, stoppedFooterMeta);
      }
      fc.notifyAgentServiceDone({
        status: 'stopped',
        sessionId: runSessionId,
        summary: '已停止生成。',
        trace: cloneTraceForMobile(stoppedTrace || [])
      });
    } else {
      if (shouldPauseForNetworkDisconnect(err, fc) && (await pauseAgentForNetworkDisconnect(fc, err))) {
        return;
      }
      const liveRun = sessionActiveRuns.get(runSessionId);
      const failedTrace =
        typeof resolveFailedDisplayTrace === 'function'
          ? resolveFailedDisplayTrace(err, liveRun, runSessionId)
          : err.trace || liveRun?.lastDisplayedTrace || liveRun?.trace || [];
      finalizeAssistantBubble(runSessionId, placeholder, {
        content: `调用失败：${formatAgentApiError(err)}`,
        trace: failedTrace,
        error: true
      });
      const failedFooterMeta = {
        ...(fc.turnMeta || {}),
        ...(messages[fc.userMsgIndex]?.meta || {})
      };
      await persistFailedAssistantTurn({
        sessionId: runSessionId,
        runId: liveRun?.runId || fc.agentRunId || null,
        trace: failedTrace,
        err,
        turnMeta: failedFooterMeta,
        userMsgIndex: fc.userMsgIndex,
        userMessageId: await fc.ensureUserLocalMsgId()
      });
      if (fc.userMsgIndex >= 0) {
        finalizeUserTurnFooter(fc.userTurn, fc.userMsgIndex, failedFooterMeta);
      }
      fc.notifyAgentServiceDone({
        status: 'failed',
        sessionId: runSessionId,
        error: err.message || String(err),
        trace: cloneTraceForMobile(failedTrace || [])
      });
    }
  } finally {
    try {
      await autoCloseBrowserAfterAgentRun(runSessionId);
    } catch {
      /* ignore */
    }
    finishSessionActiveRun(runSessionId, resumeRunId || fc.agentRunId || null);
    refreshHistoryList().catch(() => {});
    syncComposerForActiveSession();
    focusChatInput();
  }
}
