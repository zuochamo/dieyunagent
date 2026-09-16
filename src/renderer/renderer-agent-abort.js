/* global sessionActiveRuns, currentSessionId, loopApi, cancelActiveAgentBackendsForSession, finishAgentPrepPhase, renderAssistantBubbleContent, showAgentToast, messages, composerModeLabel, formatModelFooterLabel, getTextModelId, settings */
'use strict';

function stopAgentRun(sessionId) {
  const sid = String(sessionId || currentSessionId || '');
  if (!sid) return;
  const live = sessionActiveRuns.get(sid);
  if (live?.stopRequested) {
    if (live.abortController && !live.abortController.signal.aborted) {
      live.abortController.abort();
    }
    if (typeof cancelActiveAgentBackendsForSession === 'function') {
      cancelActiveAgentBackendsForSession(sid, '用户停止');
    }
    return;
  }
  if (live) live.stopRequested = true;
  if (typeof finishAgentPrepPhase === 'function') finishAgentPrepPhase(sid);
  if (typeof cancelActiveAgentBackendsForSession === 'function') {
    cancelActiveAgentBackendsForSession(sid, '用户停止');
  }
  if (live?.gatewayRunId && loopApi.agentRunCancel) {
    loopApi.agentRunCancel(live.gatewayRunId, '用户停止').catch(() => {});
    live.gatewayRunId = null;
  }
  if (live?.abortController && !live.abortController.signal.aborted) {
    live.abortController.abort();
  }
  if (live?.placeholderEl) {
    live.placeholderEl.classList.add('loading');
    renderAssistantBubbleContent(live.placeholderEl, {
      content: '',
      trace: live.trace || [],
      hitRoundLimit: false,
      loading: true
    });
  }
  if (typeof showAgentToast === 'function') {
    showAgentToast('正在停止', '已发送停止信号', { variant: 'info' });
  }
}

function createAgentAbortError() {
  const err = new Error('已停止');
  err.name = 'AbortError';
  err.code = 'ABORT_ERR';
  return err;
}

function throwIfAgentAborted(signal) {
  if (signal?.aborted) throw createAgentAbortError();
}

function resolveUserMsgCreatedAt(userMsgIndex) {
  if (userMsgIndex < 0) return Date.now();
  return messages[userMsgIndex]?.created_at || Date.now();
}

function buildFallbackTurnMeta(userMsgIndex, turnWithdrawMeta) {
  const existingMeta = userMsgIndex >= 0 ? messages[userMsgIndex]?.meta : null;
  return {
    modeLabel: composerModeLabel(),
    modelLabel: formatModelFooterLabel(getTextModelId(settings)),
    modelId: getTextModelId(settings),
    ts: resolveUserMsgCreatedAt(userMsgIndex),
    inputText: turnWithdrawMeta?.inputText,
    attachments: turnWithdrawMeta?.attachments,
    undoTurnId: turnWithdrawMeta?.undoTurnId || existingMeta?.undoTurnId || null,
    longHorizon: !!turnWithdrawMeta?.longHorizon
  };
}

function buildStoppedFooterMeta(userMsgIndex, turnMeta, turnWithdrawMeta) {
  const base =
    turnMeta ||
    (userMsgIndex >= 0 && typeof buildFallbackTurnMeta === 'function'
      ? buildFallbackTurnMeta(userMsgIndex, turnWithdrawMeta)
      : {});
  const userMeta = userMsgIndex >= 0 ? messages[userMsgIndex]?.meta || {} : {};
  return {
    ...base,
    ...(turnWithdrawMeta || {}),
    ...userMeta,
    inputText: turnWithdrawMeta?.inputText ?? base.inputText ?? userMeta.inputText,
    attachments: turnWithdrawMeta?.attachments ?? base.attachments ?? userMeta.attachments,
    undoTurnId:
      turnWithdrawMeta?.undoTurnId || base.undoTurnId || userMeta.undoTurnId || null,
    longHorizon: !!(turnWithdrawMeta?.longHorizon ?? base.longHorizon ?? userMeta.longHorizon)
  };
}

function waitForAgentAbortable(promise, signal, onAbort) {
  if (!signal) return promise;
  if (signal.aborted) {
    if (typeof onAbort === 'function') {
      try {
        onAbort();
      } catch {
        // ignore
      }
    }
    return Promise.reject(createAgentAbortError());
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      signal.removeEventListener('abort', onAbortEvt);
    };
    const onAbortEvt = () => {
      if (settled) return;
      settled = true;
      cleanup();
      if (typeof onAbort === 'function') {
        try {
          onAbort();
        } catch {
          // ignore
        }
      }
      reject(createAgentAbortError());
    };
    signal.addEventListener('abort', onAbortEvt, { once: true });
    Promise.resolve(promise).then(
      (value) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      },
      (err) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(err);
      }
    );
  });
}
