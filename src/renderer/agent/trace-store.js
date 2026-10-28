/* global window, gwState, gatewayCall, currentSessionId, messages, sessionActiveRuns, buildAgentStateSnapshot, createTraceRunId, packAssistantMeta, buildPersistedAssistantContent, persistAssistantTranscriptText, refreshHistoryList, showAgentToast, formatAgentApiError, isCurrentSessionSending, isSessionSending, unpackAssistantMeta, DieyunNamespaces, withSessionRpcScope, AgentRoundText */
'use strict';

const traceStoreLoopApi = window.diecloud || {};
/** 同一结构性边界内的最小写入间隔（只降抖，不再决定「要不要写」）。 */
const TRACE_CHECKPOINT_INTERVAL_MS = 2500;
/**
 * 纯思考（没有新工具、没进下一轮）时的最长落库间隔。
 * 崩溃保护只需这个粒度：每 2.5s 灌一次 100KB~1.3MB 的行是持续伤害，
 * 而丢掉最后 30s 的思考对回顾无实际影响。
 */
const TRACE_CHECKPOINT_FORCE_MS = 30000;

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
 *
 * 刻意不传 `traceText`：跨边界可回读的只有**结构化 `trace`**（事实源），
 * 展示用纯文本一律由展示层现场格式化（`docs/REASONING-ISOLATION-PLAN.md` §3.7 D4）。
 */
async function saveAssistantTraceRecord({
  runId,
  sessionId,
  messageId,
  userMessageId,
  trace,
  traceFrom = 0,
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

/**
 * checkpoint 触发签名：只认**结构性边界**（新一轮 / 新工具 / 工具状态翻转）。
 *
 * 曾经的实现把「思考长度 + 正文长度」也算进签名，而流式期间这两个值每帧都在变，
 * 于是 2.5s 节流被穿透成「每 2.5s 必写一次」—— `agent_traces` 单行 avg 100KB / max 1.3MB，
 * core 侧 `MemoryStore` 又只有一把 DB Mutex，直接后果是 `agent.trace_save` 排到 45s 超时；
 * 超时会把 checkpoint 游标清空，下一次退化成全量重发，越滚越慢。
 *
 * 思考/正文的增长不构成 checkpoint 理由：真正值得落库的是「多了一轮」「多了一个工具」
 * 「工具从 pending 翻成完成」。纯思考期间的兜底交给 `TRACE_CHECKPOINT_FORCE_MS`。
 */
function buildTraceCheckpointSignature(trace) {
  const rows = Array.isArray(trace) ? trace : [];
  let toolCount = 0;
  let pendingCount = 0;
  for (const row of rows) {
    const tools = Array.isArray(row?.tools) ? row.tools : [];
    toolCount += tools.length;
    for (const tool of tools) if (tool?.pending) pendingCount += 1;
  }
  return [rows.length, toolCount, pendingCount].join(':');
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
  const signature = buildTraceCheckpointSignature(trace);
  const elapsed = now - (live.lastTraceCheckpointAt || 0);
  if (!params.immediate) {
    const structural = signature !== live.lastTraceCheckpointSignature;
    // 结构没变 ⇒ 只是思考/正文在长，不写；超过 FORCE 才落一次兜底快照。
    if (!structural && elapsed < TRACE_CHECKPOINT_FORCE_MS) return;
    if (elapsed < TRACE_CHECKPOINT_INTERVAL_MS) return;
  }

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
    // 占位行（placeholder: true）没有模型原文可留：落「已停止」，不把「生成中…」写进账本
    const thought = entry.placeholder === true ? '（已停止）' : full || String(entry.thought || '').trim() || '（已停止）';
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
  // 本轮真思考：与 content 分列落库（messages.reasoning），只作上行回传真值来源，
  // 不并进 content、不进历史重建的正文（REASONING-ISOLATION §3.5 / D1）。
  // 提取单一来源 agent-round-text.reasoningTextFromTrace；bundle 未重建时不落 reasoning。
  const persistedReasoning =
    typeof AgentRoundText !== 'undefined' && typeof AgentRoundText.reasoningTextFromTrace === 'function'
      ? AgentRoundText.reasoningTextFromTrace(trace)
      : '';
  const assistantMsg = {
    role: 'assistant',
    content: persisted,
    transientTrace: trace && trace.length ? trace.slice() : [],
    ...(persistedReasoning ? { reasoning: persistedReasoning } : {})
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
        content: persisted,
        ...(persistedReasoning ? { reasoning: persistedReasoning } : {})
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
