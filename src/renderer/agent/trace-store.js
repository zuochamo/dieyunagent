/* global window, gwState, gatewayCall, getAgentLimits, currentSessionId, messages, sessionActiveRuns, buildAgentStateSnapshot, createTraceRunId, packAssistantMeta, buildPersistedAssistantContent, persistAssistantTranscriptText, refreshHistoryList, showAgentToast, formatAgentApiError, isCurrentSessionSending, isSessionSending, unpackAssistantMeta, DieyunNamespaces, withSessionRpcScope, AgentRoundText */
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

/* <trace-read-cache> */
/**
 * 思考区回放的 trace 读缓存（runId → row）。
 *
 * 为什么要：回放时每条历史 assistant 回合都要一份**整份** trace（`meta.traceRunId`
 * → `agent.trace_get`，入口 `renderer-chat-render.js#hydrateAssistantTraceFromStore`），
 * 首屏窗口最多 32 次请求；实测单会话首屏 1–3MB、全库平均 93KB、单条最大 3MB（大头是
 * `tool.diff` 与 `fullThought`）。此前没有任何记忆 —— 每次切会话都把同一批整份 trace
 * 重拉一遍、再整块重绘气泡，切得越勤越慢。
 *
 * 三条规矩：
 * 1. **同一 runId 只发一次**：在途请求去重；切走不取消、结果留着，切回来直接命中
 *    （气泡 DOM 早被换掉，但数据不必重取）；
 * 2. **上限按体积**（`agent-limits.rendererTraceCacheMaxMb`），超了按最久未用先丢
 *    —— 条数上限对「单条 3MB」这种负载没有意义；
 * 3. **写穿失效**：`saveAssistantTraceRecord` 每次落库后作废该 runId（运行中的
 *    checkpoint 也走那条路），缓存里因此不会留半截 trace。
 *
 * 只缓存命中，不缓存未命中 / 失败（失败要能重试）。
 */
/** @type {Map<string, { row: object, chars: number }>} */
const agentTraceReadCache = new Map();
/** @type {Map<string, Promise<object|null>>} */
const agentTraceReadInflight = new Map();
/** bundle 未就绪 / limits 缺键时的兜底；真值在 `agent-limits.rendererTraceCacheMaxMb` */
const AGENT_TRACE_READ_CACHE_FALLBACK_MB = 12;

/**
 * 缓存键：同一 runId 分两档 —— `display`（回放展示态，网关侧裁过）与 `full`（完整行）。
 * 展开某轮 / 某个 diff 时把 `full` 取回来补齐，两档各自一条、都算进同一份体积预算。
 */
function agentTraceReadCacheKey(runId, shape) {
  return `${shape === 'display' ? 'd' : 'f'}:${runId}`;
}

function normalizeAgentTraceShape(shape) {
  return shape === 'display' ? 'display' : 'full';
}

function agentTraceReadCacheMaxChars() {
  const mb =
    typeof getAgentLimits === 'function' ? Number(getAgentLimits().rendererTraceCacheMaxMb) : NaN;
  const safe = Number.isFinite(mb) && mb > 0 ? mb : AGENT_TRACE_READ_CACHE_FALLBACK_MB;
  return safe * 1024 * 1024;
}

/**
 * 一条 row 的占用口径：序列化后的**字符数**当字节用。
 * 只服务「该淘汰谁」这一个判断，不追求精确：真按 UTF-8 字节算得再序列化一次，
 * 对 3MB 的行是白烧时间；而占体积的大头（工具 diff）本来就是 ASCII，两者接近。
 */
function agentTraceRowChars(row) {
  try {
    const text = JSON.stringify((row && row.trace) || null);
    return typeof text === 'string' ? text.length : 0;
  } catch {
    return 0;
  }
}

function trimAgentTraceReadCache() {
  const max = agentTraceReadCacheMaxChars();
  let total = 0;
  for (const item of agentTraceReadCache.values()) total += item.chars;
  // 至少留最后一条：即便单条就超预算，也让它把这一次回放服务完
  while (total > max && agentTraceReadCache.size > 1) {
    const oldest = agentTraceReadCache.keys().next().value;
    const dropped = agentTraceReadCache.get(oldest);
    agentTraceReadCache.delete(oldest);
    total -= dropped ? dropped.chars : 0;
  }
}

function rememberAgentTraceRead(runId, row, shape) {
  if (!runId || !row || !Array.isArray(row.trace) || !row.trace.length) return;
  const key = agentTraceReadCacheKey(runId, shape);
  agentTraceReadCache.delete(key);
  agentTraceReadCache.set(key, { row, chars: agentTraceRowChars(row) });
  // 完整行是展示态的超集：留着两档只会让同一份数据在预算里算两遍
  if (shape !== 'display') agentTraceReadCache.delete(agentTraceReadCacheKey(runId, 'display'));
  trimAgentTraceReadCache();
}

/** 同步查：命中就直接画，不挂「加载中」占位。要展示态但手上只有完整行时，用完整行（超集）。 */
function peekAgentTraceRead(runId, opts = {}) {
  const id = String(runId || '').trim();
  if (!id) return null;
  const shape = normalizeAgentTraceShape(opts.shape);
  let key = agentTraceReadCacheKey(id, shape);
  let hit = agentTraceReadCache.get(key);
  if (!hit && shape === 'display') {
    key = agentTraceReadCacheKey(id, 'full');
    hit = agentTraceReadCache.get(key);
  }
  if (!hit) return null;
  agentTraceReadCache.delete(key);
  agentTraceReadCache.set(key, hit); // 命中即刷到队尾（LRU）
  return hit.row;
}

/**
 * 异步取：命中即返回；同一 runId + 同一档在途只发一次；成功后进缓存，失败 / 未命中不入缓存。
 *
 * `agent.trace_get` 只认 `runId`（`sessionId` 在契约里从来没用上：账本永远在本地 core，
 * SSH 会话也一样）。`shape: 'display'` 是网关侧的展示态整形（见 `agent/trace-display.js`）。
 */
function readAgentTraceRecord(runId, opts = {}) {
  const id = String(runId || '').trim();
  if (!id) return Promise.resolve(null);
  const shape = normalizeAgentTraceShape(opts.shape);
  const cached = peekAgentTraceRead(id, { shape });
  if (cached) return Promise.resolve(cached);
  const key = agentTraceReadCacheKey(id, shape);
  const inflight = agentTraceReadInflight.get(key);
  if (inflight) return inflight;
  if (typeof gatewayCall !== 'function') return Promise.resolve(null);
  const task = gatewayCall('agent.trace_get', shape === 'display' ? { runId: id, shape } : { runId: id })
    .then((row) => {
      rememberAgentTraceRead(id, row, shape);
      return row || null;
    })
    .catch((e) => {
      console.warn(e);
      return null;
    })
    .finally(() => {
      agentTraceReadInflight.delete(key);
    });
  agentTraceReadInflight.set(key, task);
  return task;
}

/**
 * 批量取（回放一屏的最省路径）：命中的直接用缓存，未命中的**合成一次** RPC。
 *
 * 逐条 `readAgentTraceRecord` 时一屏 32 条回合 = 32 次往返 + core 侧 32 次同一条 SQL；
 * 这里把它们压成一次 `agent.traces_get`（Rust 一次读池 + 一条 SQL，见
 * `crates/dieyun-memory/src/memory/agent.rs#get_agent_traces`）。
 *
 * 未命中的每条仍登记一条「等这一批」的在途 promise —— 期间别的调用点走
 * `readAgentTraceRecord`（例如逐条回填）会直接复用同一批，不会再发第二个请求。
 *
 * @returns {Promise<Map<string, object|null>>} runId → row（没取到的不进缓存，下次还能重试）
 */
function readAgentTraceRecords(runIds, opts = {}) {
  const shape = normalizeAgentTraceShape(opts.shape);
  const ids = [];
  const seen = new Set();
  for (const raw of runIds || []) {
    const id = String(raw || '').trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  const out = new Map();
  const missing = [];
  for (const id of ids) {
    const cached = peekAgentTraceRead(id, { shape });
    if (cached) out.set(id, cached);
    else missing.push(id);
  }
  if (!missing.length) return Promise.resolve(out);
  if (typeof gatewayCall !== 'function') return Promise.resolve(out);

  /** @type {Map<string, { key: string, resolve: (row: object|null) => void }>} */
  const deferred = new Map();
  const waits = [];
  for (const id of missing) {
    const key = agentTraceReadCacheKey(id, shape);
    const inflight = agentTraceReadInflight.get(key);
    if (inflight) {
      waits.push(inflight.then((row) => out.set(id, row || null)));
      continue;
    }
    let resolveFn = null;
    const pending = new Promise((resolve) => {
      resolveFn = resolve;
    });
    deferred.set(id, { key, resolve: resolveFn });
    agentTraceReadInflight.set(key, pending);
    waits.push(pending.then((row) => out.set(id, row || null)));
  }
  if (deferred.size) {
    const params = shape === 'display' ? { runIds: [...deferred.keys()], shape } : { runIds: [...deferred.keys()] };
    gatewayCall('agent.traces_get', params)
      .then((res) => {
        const rows = (res && res.rows) || {};
        for (const [id, entry] of deferred) {
          const row = rows[id] || null;
          rememberAgentTraceRead(id, row, shape);
          agentTraceReadInflight.delete(entry.key);
          entry.resolve(row);
        }
      })
      .catch((e) => {
        console.warn(e);
        for (const entry of deferred.values()) {
          agentTraceReadInflight.delete(entry.key);
          entry.resolve(null);
        }
      });
  }
  return Promise.all(waits).then(() => out);
}

/**
 * 展示态的「按需升级」：把该 runId 的完整行取回来（只取一次，之后走 `full` 缓存）。
 * 触发点只有用户的展开动作（某轮思考被截断 / 某个 diff 正文被裁）。
 */
function upgradeAgentTraceRecord(runId) {
  return readAgentTraceRecord(runId, { shape: 'full' });
}

function invalidateAgentTraceRead(runId) {
  const id = String(runId || '').trim();
  if (!id) return;
  agentTraceReadCache.delete(agentTraceReadCacheKey(id, 'display'));
  agentTraceReadCache.delete(agentTraceReadCacheKey(id, 'full'));
}
/* </trace-read-cache> */


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
/**
 * 落库前的 trace 瘦身：只去掉**纯展示用**的字段（`liveNote` = 流式期间的临时旁注）。
 *
 * 唯一实现在 `agent-round-text.stripTraceUiOnlyFields`（Main 侧的心跳 / 频道 / headless 轮次
 * 也写同一张 `agent_traces`，两边必须同一套瘦身规则）。bundle 在本文件之前加载，
 * 所以顶层取一次就够；万一 bundle 没就绪，退化成"原样存"（只多一个展示字段，不影响回放）。
 */
const stripTraceUiOnlyFields =
  typeof window !== 'undefined' &&
  window.AgentRoundText &&
  typeof window.AgentRoundText.stripTraceUiOnlyFields === 'function'
    ? window.AgentRoundText.stripTraceUiOnlyFields
    : (trace) => (Array.isArray(trace) ? trace : []);

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
    const result = await gatewayCall('agent.trace_save', {
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
    // 写穿失效：这一行的内容刚变过（运行中 checkpoint 也走这里），
    // 回放缓存里那一份立刻作废，下一次回放重新读——缓存里永远不留半截 trace。
    invalidateAgentTraceRead(runId);
    return result;
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
      // 消息落库失败**不能**连带跳过下面的终态写入：否则气泡已经显示「已完成/已停止」，
      // 库里这一轮却还是 running —— 下次进会话会被 `recoverInterruptedAssistantTurn`
      // 当成「程序重启/连接断开」，再补一条伪中断消息（2026-11-19 审计）。
      const ins = await gatewayCall('memory.message_append', {
        sessionId: sid,
        role: 'assistant',
        content: persisted,
        ...(persistedReasoning ? { reasoning: persistedReasoning } : {})
      }).catch((e) => {
        console.warn(e);
        return null;
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
  // 文案只说**验证过的事实**，不替用户猜原因。
  //
  // 以前这里一律写「任务中断（程序重启或连接断开）」—— 但同一个条件（state 仍是 running、
  // 本地已无 live run）在 2026-11-19 实测里对应的是「plan 执行器撞轮次上限后停车」，
  // 与进程重启无关。真正的可恢复性由 checkpoint 说了算（`tryDetectResumeCheckpoint`
  // 用的是同一份 `agentCheckpointList`）：有可续跑的断点就说能继续，没有才说被中断。
  let hasResumableCheckpoint = false;
  try {
    if (traceStoreLoopApi.agentCheckpointList) {
      const list = await traceStoreLoopApi.agentCheckpointList(3);
      hasResumableCheckpoint = (list?.items || []).some(
        (i) => i && i.status === 'running' && String(i.sessionId || '') === String(sessionId || '')
      );
    }
  } catch {
    hasResumableCheckpoint = false;
  }
  const replyText = hasResumableCheckpoint
    ? '上一轮没有跑完（撞轮次/工具上限或被中断），已在断点处保存；点「继续」或直接回车可接着跑。以下为已保存的思考过程。'
    : '上一轮没有收尾（程序重启 / 连接断开 / 运行被中断），以下为已保存的思考过程。';
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
        '检测到中断任务：点思考区「继续」或留空直接回车即可从中断点恢复，输入其他内容按新任务执行。',
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
    clearPendingResumeCheckpoint,
    // 思考区回放用的读路径（缓存 + 在途去重 + 展示态升级 + 批量取）：只给本仓渲染层用，不镜像回 window.*
    peekAgentTraceRead,
    readAgentTraceRecord,
    readAgentTraceRecords,
    upgradeAgentTraceRecord,
    invalidateAgentTraceRead
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
