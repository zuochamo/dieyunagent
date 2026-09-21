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

/**
 * UI 专用字段不落库。
 * `liveNote`（「上游 Ns 无数据」）是运行中的瞬时状态；存下来会在下次打开会话时
 * 显示成过期的等待提示，所以所有 trace 落库前统一剥离，只留真正的思考/工具内容。
 */
function stripTraceUiOnlyFields(trace) {
  return (trace || []).map((entry) => {
    if (!entry || typeof entry !== 'object' || entry.liveNote == null) return entry;
    const next = { ...entry };
    delete next.liveNote;
    return next;
  });
}

/**
 * @param {object} p
 * @param {number} [p.traceFrom] 本批条目在完整 trace 里的起始下标；0 = 全量覆盖。
 * @param {boolean} [p.withTraceText] 是否重算 `traceText`。运行中的 checkpoint 传 false：
 *   `trace_text` 的唯一读者是 `get_agent_trace`，而它只被用来取 `trace`（思考区补渲染、
 *   中断恢复），所以每 2.5s 重拼一遍全量纯文本纯属浪费；终态写入仍带全量文本。
 */
async function saveAssistantTraceRecord({
  runId,
  sessionId,
  messageId,
  userMessageId,
  trace,
  traceFrom = 0,
  withTraceText = true,
  status,
  summary,
  stateSnapshot
}) {
  if (!gwState.authed || !runId || !trace || !trace.length) return null;
  const persistable = stripTraceUiOnlyFields(trace);
  try {
    return await gatewayCall('agent.trace_save', {
      runId,
      sessionId,
      messageId,
      userMessageId,
      trace: persistable,
      traceFrom,
      ...(withTraceText ? { traceText: formatTracePlain(persistable) } : {}),
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

/**
 * 已落库前缀的廉价位指纹：条目数 + 每条思考长度 + 工具项数 + 未完成工具数。
 * 只做整数累加，不拷贝任何对象。前缀被改写（重试重排、trace 被重置成更短）时
 * 指纹几乎必然变化，于是退回全量重发——宁可多传一次，也不让库里留着旧前缀。
 */
function tracePrefixFingerprint(trace, count) {
  const rows = Array.isArray(trace) ? trace : [];
  let acc = count * 31;
  for (let i = 0; i < count && i < rows.length; i += 1) {
    const entry = rows[i];
    const tools = Array.isArray(entry?.tools) ? entry.tools : [];
    let pending = 0;
    for (const tool of tools) if (tool?.pending) pending += 1;
    acc +=
      String(entry?.fullThought || entry?.thought || '').length * 7 + tools.length * 17 + pending * 101;
  }
  return acc;
}

/**
 * 运行中的 checkpoint 只发增量：`{ from, entries }`。
 *
 * `live.trace` 每次事件都是整体替换（`live.trace = event.trace`），但**值上前缀稳定**、
 * 只有尾部那条还在长（思考追加、工具状态翻转），所以：
 * - 重发起点取「已落库条数 - 1」，把会变的尾部一起覆盖；
 * - 前缀指纹对不上、trace 变短、或换了 run 时退回全量（`from = 0`）。
 */
function buildTraceCheckpointDelta(live, runId, trace) {
  const rows = Array.isArray(trace) ? trace : [];
  const cursor = live && live.traceCheckpointCursor;
  const canAppend =
    !!cursor &&
    cursor.runId === runId &&
    cursor.count > 1 &&
    rows.length >= cursor.count &&
    cursor.fingerprint === tracePrefixFingerprint(rows, cursor.count - 1);
  const from = canAppend ? cursor.count - 1 : 0;
  return { from, entries: rows.slice(from) };
}

async function saveRunningTraceCheckpoint({ live, runId, sessionId, userMessageId, trace, streamContent }) {
  if (!gwState.authed || !runId || !sessionId || !trace || !trace.length) return null;
  const state = buildAgentStateSnapshot({
    reply: streamContent || '运行中',
    trace,
    status: 'running'
  });
  const delta = buildTraceCheckpointDelta(live, runId, trace);
  const result = await saveAssistantTraceRecord({
    runId,
    sessionId,
    userMessageId,
    trace: delta.entries,
    traceFrom: delta.from,
    withTraceText: false,
    status: 'running',
    summary: state.summary || '运行中',
    stateSnapshot: state.snapshot
  });
  if (live) {
    // 只有真写进库里才推进游标；`stale` 说明游标对不上，清空让下一次全量重发。
    live.traceCheckpointCursor =
      result && !result.stale
        ? {
            runId,
            count: trace.length,
            fingerprint: tracePrefixFingerprint(trace, trace.length - 1)
          }
        : null;
  }
  return result;
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
  // 入队时不拷贝：trace 在排队期间还在长，切片统一放到真正发包那一刻做
  // （见 `buildTraceCheckpointDelta`）。既省掉每 2.5s 的全量深拷贝，也顺带拿到更新的一版。
  const payload = {
    runId: params.runId,
    sessionId: params.sessionId,
    trace,
    streamContent: params.streamContent || '',
    ensureUserLocalMsgId: params.ensureUserLocalMsgId
  };

  const runSave = async (p) => {
    const userMessageId =
      typeof p.ensureUserLocalMsgId === 'function' ? await p.ensureUserLocalMsgId() : null;
    if (live.traceCheckpointClosed) return;
    await saveRunningTraceCheckpoint({ ...p, live, userMessageId });
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
  return stripTraceUiOnlyFields(trace).map((entry) => {
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
    clearPendingResumeCheckpoint
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
      'clearPendingResumeCheckpoint'
    ]
  }
);
