'use strict';
// @ts-check

/** @typedef {'run_start'|'prep'|'trace'|'stream'|'tool'|'round_limit'|'arbitration'|'done'|'error'|'stopped'} AgentRunEventType */

const AGENT_RUN_EVENT_TYPES = Object.freeze({
  RUN_START: 'run_start',
  PREP: 'prep',
  TRACE: 'trace',
  STREAM: 'stream',
  TOOL: 'tool',
  ROUND_LIMIT: 'round_limit',
  ARBITRATION: 'arbitration',
  DONE: 'done',
  ERROR: 'error',
  STOPPED: 'stopped'
});

const VALID_TYPES = new Set(Object.values(AGENT_RUN_EVENT_TYPES));

/** @type {Readonly<Record<string, { description: string, producer?: string, consumer?: string }>>} */
const AGENT_RUN_EVENT_TYPE_DOCS = Object.freeze({
  run_start: { description: 'Agent run 开始', producer: 'Main/Rust loop', consumer: 'Renderer, Mobile' },
  prep: { description: '准备阶段（上下文/工具组装）', producer: 'Renderer prep', consumer: 'Renderer thinking UI' },
  trace: { description: '思考 trace 更新', producer: 'Rust loop / Renderer', consumer: 'Renderer, Mobile task.progress' },
  stream: { description: '助手正文流式增量', producer: 'Rust loop', consumer: 'Renderer bubble, Mobile streamContent' },
  tool: { description: '工具调用轮次', producer: 'Rust loop', consumer: 'Renderer tool cards' },
  round_limit: { description: '达到轮次上限', producer: 'Guardrails', consumer: 'Renderer, Mobile' },
  arbitration: { description: '多 Agent 仲裁', producer: 'Planner', consumer: 'Renderer' },
  done: { description: '正常完成', producer: 'Rust loop / Renderer', consumer: 'Renderer, Mobile task.completed' },
  error: { description: '失败', producer: 'Rust loop / Main', consumer: 'Renderer, Mobile task.failed' },
  stopped: { description: '用户停止', producer: 'Main', consumer: 'Renderer, Mobile task.stopped' }
});

/** AgentRunEvent 公共字段（createAgentRunEvent 输出） */
const AGENT_RUN_EVENT_FIELDS = Object.freeze([
  { name: 'type', type: 'AgentRunEventType', required: true },
  { name: 'at', type: 'number', required: true, description: 'Unix ms timestamp' },
  { name: 'sessionId', type: 'string|null', required: false },
  { name: 'runId', type: 'string|null', required: false },
  { name: 'requestId', type: 'string|null', required: false },
  { name: 'trace', type: 'TraceEntry[]', required: false },
  { name: 'streamContent', type: 'string', required: false, description: '助手回复流式正文（PC + 手机）' },
  { name: 'hitRoundLimit', type: 'boolean', required: false },
  { name: 'stopped', type: 'boolean', required: false },
  { name: 'error', type: 'string', required: false },
  { name: 'summary', type: 'string', required: false },
  { name: 'mode', type: 'string', required: false },
  { name: 'phase', type: 'string', required: false },
  { name: 'tool', type: 'object|null', required: false },
  { name: 'meta', type: 'object|null', required: false, description: 'prepSteps 等扩展' }
]);

/** Mobile AgentService 旧事件 → AgentRunEvent 映射 */
const MOBILE_SERVICE_EVENT_MAP = Object.freeze({
  'task.started': 'run_start',
  'task.queued': 'run_start',
  'task.progress': 'trace',
  'task.completed': 'done',
  'task.failed': 'error',
  'task.stopped': 'stopped',
  'task.stopping': 'stopped'
});

/** PC dispatchAgentRunEvent → Mobile task.progress 字段对齐 */
const MOBILE_PROGRESS_FIELD_MAP = Object.freeze({
  trace: 'event.trace → task.progress.trace',
  streamContent: 'live.streamContent / runEvent.streamContent → task.progress.streamContent',
  runEvent: 'runEvent 附在 progress payload（bridge 可选转发）',
  sessionId: 'sessionId',
  requestId: 'requestId（手机任务关联）'
});

function cloneTrace(trace) {
  return (trace || []).map((entry) => ({
    ...entry,
    tools: Array.isArray(entry.tools) ? entry.tools.map((tool) => ({ ...tool })) : []
  }));
}

/**
 * @param {AgentRunEventType} type
 * @param {Record<string, unknown>} [fields]
 */
function createAgentRunEvent(type, fields = {}) {
  const t = VALID_TYPES.has(type) ? type : AGENT_RUN_EVENT_TYPES.TRACE;
  const trace = Array.isArray(fields.trace) ? cloneTrace(fields.trace) : undefined;
  return {
    type: t,
    at: Number(fields.at) > 0 ? Number(fields.at) : Date.now(),
    sessionId: fields.sessionId != null ? String(fields.sessionId) : null,
    runId: fields.runId != null ? String(fields.runId) : null,
    requestId: fields.requestId != null ? String(fields.requestId) : null,
    trace,
    streamContent: typeof fields.streamContent === 'string' ? fields.streamContent : '',
    hitRoundLimit: !!fields.hitRoundLimit,
    stopped: !!fields.stopped,
    error: fields.error != null ? String(fields.error) : '',
    summary: fields.summary != null ? String(fields.summary) : '',
    mode: fields.mode != null ? String(fields.mode) : '',
    phase: fields.phase != null ? String(fields.phase) : '',
    tool: fields.tool && typeof fields.tool === 'object' ? { ...fields.tool } : null,
    meta:
      fields.meta && typeof fields.meta === 'object' && !Array.isArray(fields.meta)
        ? { ...fields.meta }
        : null
  };
}

function normalizeAgentRunEvent(raw) {
  if (!raw || typeof raw !== 'object') {
    return createAgentRunEvent(AGENT_RUN_EVENT_TYPES.TRACE, {});
  }
  const type = VALID_TYPES.has(raw.type) ? raw.type : AGENT_RUN_EVENT_TYPES.TRACE;
  return createAgentRunEvent(type, raw);
}

function agentRunEventFromTrace(sessionId, trace, streamContent, extra = {}) {
  const hitRoundLimit = !!extra.hitRoundLimit;
  const type = hitRoundLimit
    ? AGENT_RUN_EVENT_TYPES.ROUND_LIMIT
    : extra.type && VALID_TYPES.has(extra.type)
      ? extra.type
      : AGENT_RUN_EVENT_TYPES.TRACE;
  return createAgentRunEvent(type, {
    sessionId,
    trace,
    streamContent,
    hitRoundLimit,
    ...extra
  });
}

/**
 * @param {object} live sessionActiveRuns entry
 * @param {ReturnType<typeof createAgentRunEvent>} event
 */
function applyAgentRunEventToLive(live, event) {
  if (!live || !event) return live;
  if (Array.isArray(event.trace)) {
    const keepThinking =
      event.type === AGENT_RUN_EVENT_TYPES.PREP &&
      live.inPrepPhase === false &&
      Array.isArray(live.trace) &&
      live.trace.length > 0;
    if (!keepThinking) live.trace = event.trace;
  }
  if (typeof event.streamContent === 'string') live.streamContent = event.streamContent;
  if (typeof event.streamContent === 'string' && String(event.streamContent).trim()) {
    live.inPrepPhase = false;
  }
  if (event.meta && Array.isArray(event.meta.prepSteps)) {
    live.prepSteps = event.meta.prepSteps.map((s) => ({ ...s }));
    live.inPrepPhase = true;
  }
  if (event.type === AGENT_RUN_EVENT_TYPES.PREP && Array.isArray(event.trace) && event.trace[0]?.prepSteps) {
    live.inPrepPhase = true;
    live.prepSteps = event.trace[0].prepSteps.map((s) => ({ ...s }));
  }
  if (event.hitRoundLimit || event.type === AGENT_RUN_EVENT_TYPES.ROUND_LIMIT) {
    live.hitRoundLimit = true;
  } else if (
    event.type === AGENT_RUN_EVENT_TYPES.RUN_START ||
    event.type === AGENT_RUN_EVENT_TYPES.PREP ||
    event.type === AGENT_RUN_EVENT_TYPES.TRACE ||
    event.type === AGENT_RUN_EVENT_TYPES.STREAM ||
    event.type === AGENT_RUN_EVENT_TYPES.TOOL ||
    event.type === AGENT_RUN_EVENT_TYPES.DONE
  ) {
    live.hitRoundLimit = false;
  }
  if (event.type === AGENT_RUN_EVENT_TYPES.DONE || event.type === AGENT_RUN_EVENT_TYPES.STOPPED) {
    live.finished = true;
  }
  if (event.type === AGENT_RUN_EVENT_TYPES.ERROR) {
    live.finished = true;
    live.error = event.error || 'Agent 运行失败';
  }
  live.lastEvent = event;
  live.lastEventAt = event.at;
  return live;
}

function mapLegacyServiceEventType(serviceType) {
  const t = String(serviceType || '');
  if (t === 'task.completed') return AGENT_RUN_EVENT_TYPES.DONE;
  if (t === 'task.failed') return AGENT_RUN_EVENT_TYPES.ERROR;
  if (t === 'task.stopped' || t === 'task.stopping') return AGENT_RUN_EVENT_TYPES.STOPPED;
  if (t === 'task.progress') return AGENT_RUN_EVENT_TYPES.TRACE;
  if (t === 'task.started' || t === 'task.queued') return AGENT_RUN_EVENT_TYPES.RUN_START;
  return AGENT_RUN_EVENT_TYPES.TRACE;
}

function agentRunEventFromServicePayload(payload = {}) {
  const stream =
    typeof payload.streamContent === 'string'
      ? payload.streamContent
      : typeof payload.summary === 'string'
        ? payload.summary
        : '';
  return createAgentRunEvent(mapLegacyServiceEventType(payload.type), {
    sessionId: payload.sessionId,
    runId: payload.runId,
    requestId: payload.requestId,
    trace: payload.trace,
    streamContent: stream,
    error: payload.error || '',
    summary: payload.summary || stream,
    meta: { serviceType: payload.type }
  });
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    AGENT_RUN_EVENT_TYPES,
    AGENT_RUN_EVENT_TYPE_DOCS,
    AGENT_RUN_EVENT_FIELDS,
    MOBILE_SERVICE_EVENT_MAP,
    MOBILE_PROGRESS_FIELD_MAP,
    createAgentRunEvent,
    normalizeAgentRunEvent,
    agentRunEventFromTrace,
    applyAgentRunEventToLive,
    agentRunEventFromServicePayload,
    mapLegacyServiceEventType,
    cloneTrace
  };
}

if (typeof window !== 'undefined') {
  /** @type {any} */
  const w = window;
  w.AGENT_RUN_EVENT_TYPES = AGENT_RUN_EVENT_TYPES;
  w.createAgentRunEvent = createAgentRunEvent;
  w.normalizeAgentRunEvent = normalizeAgentRunEvent;
  w.agentRunEventFromTrace = agentRunEventFromTrace;
  w.applyAgentRunEventToLive = applyAgentRunEventToLive;
  w.agentRunEventFromServicePayload = agentRunEventFromServicePayload;
}
