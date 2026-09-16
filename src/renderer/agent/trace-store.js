/* global window, gwState, gatewayCall, currentSessionId, messages, sessionActiveRuns, formatTracePlain, buildAgentStateSnapshot, createTraceRunId, packAssistantMeta, buildPersistedAssistantContent, persistAssistantTranscriptText, refreshHistoryList, showAgentToast, formatAgentApiError, isCurrentSessionSending, isSessionSending, unpackAssistantMeta, DieyunNamespaces, withSessionRpcScope */
'use strict';

const traceStoreLoopApi = window.diecloud || {};
const TRACE_CHECKPOINT_INTERVAL_MS = 2500;

/** @type {Map<string, { runId: string, planSummary: string, sessionId?: string }>} */
const pendingResumeCheckpoints = new Map();

function resumeCheckpointSessionKey(sessionId) {
  const sid =
    sessionId != null && String(sessionId).trim()
      ? String(sessionId).trim()
      : String(currentSessionId || '').trim();
  return sid;
}

function getPendingResumeCheckpoint(sessionId) {
  const key = resumeCheckpointSessionKey(sessionId);
  if (!key) return null;
  return pendingResumeCheckpoints.get(key) || null;
}

function setPendingResumeCheckpoint(value, sessionId) {
  const key = resumeCheckpointSessionKey(sessionId || (value && value.sessionId));
  if (!key) return;
  if (!value) {
    pendingResumeCheckpoints.delete(key);
    return;
  }
  pendingResumeCheckpoints.set(key, value);
}

function clearPendingResumeCheckpoint(sessionId) {
  const key = resumeCheckpointSessionKey(sessionId);
  if (key) pendingResumeCheckpoints.delete(key);
}

async function saveAgentRunState({ runId, sessionId, userMessageId, assistantMessageId, status, summary, stateSnapshot }) {
  if (!gwState.authed || !runId || !sessionId) return null;
  try {
    return await gatewayCall('agent.run_upsert', {
      id: runId,
      sessionId,
      userMessageId,
      assistantMessageId,
      status: status || 'completed',
      summary,
      stateSnapshot
    });
  } catch (e) {
    console.warn(e);
    return null;
  }
}

async function saveAssistantTraceRecord({ runId, sessionId, messageId, userMessageId, trace, status, summary, stateSnapshot }) {
  if (!gwState.authed || !runId || !trace || !trace.length) return null;
  try {
    return await gatewayCall('agent.trace_save', {
      runId,
      sessionId,
      messageId,
      userMessageId,
      trace,
      traceText: formatTracePlain(trace),
      phase: 'assistant',
      status: status || 'completed',
      summary,
      stateSnapshot
    });
  } catch (e) {
    console.warn(e);
    return null;
  }
}

function buildTraceCheckpointSignature(trace, streamContent) {
  const rows = Array.isArray(trace) ? trace : [];
  const last = rows.length ? rows[rows.length - 1] : null;
  const toolCount = rows.reduce((n, row) => n + (Array.isArray(row?.tools) ? row.tools.length : 0), 0);
  const pendingCount = rows.reduce(
    (n, row) => n + (Array.isArray(row?.tools) ? row.tools.filter((tool) => tool?.pending).length : 0),
    0
  );
  const thoughtLen = String(last?.fullThought || last?.thought || '').length;
  return [rows.length, toolCount, pendingCount, thoughtLen, String(streamContent || '').length].join(':');
}

async function saveRunningTraceCheckpoint({ runId, sessionId, userMessageId, trace, streamContent }) {
  if (!gwState.authed || !runId || !sessionId || !trace || !trace.length) return null;
  const state = buildAgentStateSnapshot({
    reply: streamContent || '运行中',
    trace,
    status: 'running'
  });
  return saveAssistantTraceRecord({
    runId,
    sessionId,
    userMessageId,
    trace,
    status: 'running',
    summary: state.summary || '运行中',
    stateSnapshot: state.snapshot
  });
}

function maybeSaveRunningTraceCheckpoint(live, params = {}) {
  const trace = Array.isArray(params.trace) ? params.trace : [];
  if (!live || live.traceCheckpointClosed || !params.runId || !params.sessionId || !trace.length) return;
  const now = Date.now();
  const signature = buildTraceCheckpointSignature(trace, params.streamContent);
  const elapsed = now - (live.lastTraceCheckpointAt || 0);
  if (!params.immediate && signature === live.lastTraceCheckpointSignature) return;
  if (!params.immediate && live.lastTraceCheckpointAt && elapsed < TRACE_CHECKPOINT_INTERVAL_MS) return;

  live.lastTraceCheckpointAt = now;
  live.lastTraceCheckpointSignature = signature;
  const payload = {
    runId: params.runId,
    sessionId: params.sessionId,
    trace: trace.map((entry) => ({
      ...entry,
      tools: Array.isArray(entry.tools) ? entry.tools.map((tool) => ({ ...tool })) : []
    })),
    streamContent: params.streamContent || '',
    ensureUserLocalMsgId: params.ensureUserLocalMsgId
  };

  const runSave = async (p) => {
    const userMessageId =
      typeof p.ensureUserLocalMsgId === 'function' ? await p.ensureUserLocalMsgId() : null;
    if (live.traceCheckpointClosed) return;
    await saveRunningTraceCheckpoint({ ...p, userMessageId });
  };

  if (live.traceCheckpointSaving) {
    live.pendingTraceCheckpoint = payload;
    return;
  }
  live.traceCheckpointSaving = runSave(payload)
    .catch((e) => console.warn(e))
    .finally(() => {
      live.traceCheckpointSaving = null;
      const pending = live.pendingTraceCheckpoint;
      live.pendingTraceCheckpoint = null;
      if (pending && !live.traceCheckpointClosed) {
        maybeSaveRunningTraceCheckpoint(live, { ...pending, immediate: true });
      }
    });
}

function normalizeStoppedTrace(trace) {
  return (trace || []).map((entry) => {
    const full = String(entry.fullThought || '').trim();
    let thought = full || String(entry.thought || '').trim();
    if (!thought || thought === '请求中…') thought = full || '（已停止）';
    const tools = (entry.tools || []).map((t) =>
      t && t.pending
        ? { ...t, pending: false, summary: t.summary === '执行中…' ? '已停止' : t.summary || '已停止' }
        : t
    );
    return { ...entry, thought, tools };
  });
}

async function persistInterruptedAssistant(trace, replyText, turnMeta = null, opts = {}) {
  const runStatus = opts.status || 'stopped';
  const agentRunId = opts.runId || createTraceRunId();
  const traceRunId = trace && trace.length ? agentRunId : null;
  const sid = String(opts.sessionId || '').trim();
  if (!sid) return null;
  const viewing = String(sid || '') === String(currentSessionId || '');
  const userMeta =
    viewing && opts.userMsgIndex != null && opts.userMsgIndex >= 0
      ? messages[opts.userMsgIndex]?.meta || {}
      : {};
  const merged = { ...(turnMeta || {}), ...userMeta };
  const meta = traceRunId ? { ...merged, traceRunId } : merged;
  const state = buildAgentStateSnapshot({
    reply: replyText,
    trace: trace || [],
    status: runStatus
  });
  const body = buildPersistedAssistantContent(persistAssistantTranscriptText(replyText, trace));
  const persisted = meta ? packAssistantMeta(body, meta) : body;
  const assistantMsg = {
    role: 'assistant',
    content: persisted,
    transientTrace: trace && trace.length ? trace.slice() : []
  };
  if (viewing) {
    messages.push(assistantMsg);
  } else if (typeof invalidateSessionMessageCache === 'function') {
    invalidateSessionMessageCache(sid);
  }
  if (gwState.authed) {
    try {
      const ins = await gatewayCall('memory.message_append', {
        sessionId: sid,
        role: 'assistant',
        content: persisted
      });
      if (ins?.localMsgId) {
        assistantMsg.localMsgId = ins.localMsgId;
        assistantMsg.id = ins.localMsgId;
      }
      await saveAgentRunState({
        runId: agentRunId,
        sessionId: sid,
        assistantMessageId: ins?.localMsgId,
        userMessageId: opts.userMessageId,
        status: runStatus,
        summary: state.summary,
        stateSnapshot: state.snapshot
      });
      await saveAssistantTraceRecord({
        runId: traceRunId,
        sessionId: sid,
        messageId: ins?.localMsgId,
        userMessageId: opts.userMessageId,
        trace: trace || [],
        status: runStatus,
        summary: state.summary,
        stateSnapshot: state.snapshot
      });
      refreshHistoryList();
    } catch (e) {
      console.warn(e);
    }
  }
}

async function persistStoppedAssistant(trace, replyText = '已停止生成。', turnMeta = null, opts = {}) {
  return persistInterruptedAssistant(trace, replyText, turnMeta, { ...opts, status: 'stopped' });
}

async function persistNetworkPausedTurn({ sessionId, runId, partial, userMessageId }) {
  const trace = partial?.trace || [];
  if (!gwState.authed || !sessionId || !trace.length) return;
  const effectiveRunId = runId || partial?.runId || createTraceRunId();
  const replyText = partial?.content || '连接中断，已保存当前进度。';
  const normalizedTrace = normalizeStoppedTrace(trace);
  const state = buildAgentStateSnapshot({
    reply: replyText,
    trace: normalizedTrace,
    status: 'running'
  });
  try {
    await saveAgentRunState({
      runId: effectiveRunId,
      sessionId,
      userMessageId,
      status: 'running',
      summary: state.summary,
      stateSnapshot: state.snapshot
    });
    await saveAssistantTraceRecord({
      runId: effectiveRunId,
      sessionId,
      userMessageId,
      trace: normalizedTrace,
      status: 'running',
      summary: state.summary,
      stateSnapshot: state.snapshot
    });
  } catch (e) {
    console.warn(e);
  }
}

async function persistFailedAssistantTurn({
  sessionId,
  runId,
  trace,
  err,
  turnMeta,
  userMsgIndex,
  userMessageId
}) {
  const liveRun = sessionActiveRuns.get(sessionId);
  if (liveRun) {
    liveRun.traceCheckpointClosed = true;
    if (Array.isArray(trace) && trace.length) liveRun.trace = trace;
  }
  const normalizedTrace = normalizeStoppedTrace(trace || []);
  const replyText = `调用失败：${formatAgentApiError(err)}`;
  await persistInterruptedAssistant(normalizedTrace, replyText, turnMeta, {
    status: 'failed',
    runId,
    sessionId,
    userMsgIndex,
    userMessageId
  });
}

async function recoverInterruptedAssistantTurn(sessionId) {
  if (!gwState.authed || !sessionId) return false;
  const live = sessionActiveRuns.get(String(sessionId));
  if (live && !live.finished) return false;
  if (typeof isSessionSending === 'function' && isSessionSending(sessionId)) return false;
  if (String(sessionId) !== String(currentSessionId || '')) return false;
  const last = messages[messages.length - 1];
  if (!last || last.role !== 'user') return false;

  let state;
  try {
    state = await gatewayCall('agent.state_get', { sessionId });
  } catch {
    return false;
  }
  if (!state?.runId || state.status !== 'running') return false;

  const userCreated = Number(last.created_at) || 0;
  const runUpdated = Number(state.updatedAt) || 0;
  if (userCreated > 0 && runUpdated > 0 && userCreated > runUpdated) {
    return false;
  }

  let traceRow;
  try {
    traceRow = await gatewayCall('agent.trace_get', { runId: state.runId, sessionId });
  } catch {
    return false;
  }
  const trace = traceRow?.trace;
  if (!Array.isArray(trace) || !trace.length) return false;

  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== 'assistant') continue;
    const { meta } = unpackAssistantMeta(m.content);
    if (meta?.traceRunId === state.runId) return false;
    break;
  }

  const userIdx = messages.length - 1;
  const userMeta = messages[userIdx]?.meta || {};
  const normalizedTrace = normalizeStoppedTrace(trace);
  const replyText = '任务中断（程序重启或连接断开），以下为已保存的思考过程。';
  await persistInterruptedAssistant(normalizedTrace, replyText, userMeta, {
    status: 'stopped',
    runId: state.runId,
    sessionId,
    userMsgIndex: userIdx,
    userMessageId: messages[userIdx]?.localMsgId || messages[userIdx]?.id || null
  });
  return true;
}

async function tryDetectResumeCheckpoint(sessionId) {
  const sid = resumeCheckpointSessionKey(sessionId);
  clearPendingResumeCheckpoint(sid);
  if (!sid || !traceStoreLoopApi.agentCheckpointList) return;
  try {
    const list = await traceStoreLoopApi.agentCheckpointList(3);
    const running = (list?.items || []).find(
      (i) => i.status === 'running' && String(i.sessionId || '') === sid
    );
    if (running) {
      setPendingResumeCheckpoint(
        { runId: running.runId, planSummary: running.planSummary || '', sessionId: sid },
        sid
      );
      showAgentToast(
        '可恢复',
        '检测到中断任务；发送「继续」可从中断点恢复，发送其他内容将按新任务执行。',
        { variant: 'info', duration: 6000 }
      );
    }
  } catch {
    clearPendingResumeCheckpoint(sid);
  }
}

function initAgentResumeBanner() {
  // 已移除横幅 UI；恢复逻辑改为 withdrawUserTurn 触发
}

window.DieyunNamespaces.register(
  'DieyunAgent',
  {
    saveAgentRunState,
    saveAssistantTraceRecord,
    maybeSaveRunningTraceCheckpoint,
    persistStoppedAssistant,
    persistNetworkPausedTurn,
    persistFailedAssistantTurn,
    recoverInterruptedAssistantTurn,
    tryDetectResumeCheckpoint,
    getPendingResumeCheckpoint,
    setPendingResumeCheckpoint,
    clearPendingResumeCheckpoint,
    initAgentResumeBanner
  },
  {
    compat: [
      'saveAgentRunState',
      'saveAssistantTraceRecord',
      'maybeSaveRunningTraceCheckpoint',
      'persistStoppedAssistant',
      'persistNetworkPausedTurn',
      'persistFailedAssistantTurn',
      'recoverInterruptedAssistantTurn',
      'tryDetectResumeCheckpoint',
      'getPendingResumeCheckpoint',
      'setPendingResumeCheckpoint',
      'clearPendingResumeCheckpoint',
      'initAgentResumeBanner'
    ]
  }
);
