/* global sessionActiveRuns, AGENT_RUN_EVENT_TYPES, createAgentRunEvent, dispatchAgentRunEvent, maybeSaveRunningTraceCheckpoint */
'use strict';

const AGENT_PREP_STEP_DEFS = Object.freeze([
  { id: 'undo', label: '创建文件快照' },
  { id: 'remote_core', label: '等待远程索引引擎' },
  { id: 'codebase', label: '索引代码库' },
  { id: 'graph', label: '结构索引' },
  { id: 'memory', label: '加载项目记忆' },
  { id: 'skills_mcp', label: '加载技能 / MCP' },
  { id: 'tools', label: '组装工具列表' },
  { id: 'compact', label: '压缩上下文' },
  { id: 'llm', label: '请求模型' }
]);

/** @typedef {'pending'|'active'|'done'|'skipped'|'failed'} AgentPrepStepStatus */

function clonePrepSteps(steps) {
  return (steps || []).map((s) => ({ ...s }));
}

function createInitialPrepSteps(opts = {}) {
  const skipUndo = !!opts.skipUndo;
  const skipRemoteCore = !opts.isRemote;
  return AGENT_PREP_STEP_DEFS.map((def) => {
    if (def.id === 'undo' && skipUndo) {
      return {
        id: def.id,
        label: def.label,
        status: 'skipped',
        detail: opts.skipUndoReason || '长程模式，已跳过'
      };
    }
    if (def.id === 'remote_core' && skipRemoteCore) {
      return {
        id: def.id,
        label: def.label,
        status: 'skipped'
      };
    }
    return {
      id: def.id,
      label: def.label,
      status: 'pending'
    };
  });
}

function prepStepsToTrace(steps) {
  return [
    {
      round: 0,
      phase: 'prep',
      thought: '准备中',
      fullThought: '准备中',
      tools: [],
      prepSteps: clonePrepSteps(steps)
    }
  ];
}

function isPrepOnlyTrace(trace) {
  return !!(trace && trace.length === 1 && trace[0] && trace[0].phase === 'prep' && trace[0].prepSteps);
}

function resolveStoppedDisplayTrace(trace) {
  if (isPrepOnlyTrace(trace)) return [];
  if (typeof normalizeStoppedTrace === 'function') {
    return normalizeStoppedTrace(trace);
  }
  return trace || [];
}

/** 失败/停止时不要用准备区 trace 盖掉已经流式出来的思考。 */
function resolveFailedDisplayTrace(err, liveRun, sessionId) {
  const candidates = [
    err && err.trace,
    liveRun && liveRun.lastDisplayedTrace,
    typeof getLastAgentDisplayedTrace === 'function' ? getLastAgentDisplayedTrace(sessionId) : null,
    liveRun && liveRun.trace
  ];
  for (const t of candidates) {
    if (!Array.isArray(t) || !t.length) continue;
    if (isPrepOnlyTrace(t)) continue;
    return typeof normalizeStoppedTrace === 'function' ? normalizeStoppedTrace(t) : t;
  }
  return [];
}

function emitAgentPrepUpdate(sessionId, steps, fields = {}) {
  const sid = String(sessionId || '').trim();
  if (!sid) return;
  const trace = prepStepsToTrace(steps);
  const live = sessionActiveRuns.get(sid);
  if (live && !live.finished) {
    live.prepSteps = clonePrepSteps(steps);
    const keepThinking =
      live.inPrepPhase === false &&
      Array.isArray(live.trace) &&
      live.trace.length > 0 &&
      !isPrepOnlyTrace(live.trace);
    if (!keepThinking) {
      live.inPrepPhase = true;
      live.trace = trace;
      live.streamContent = '';
      if (live.runId && typeof maybeSaveRunningTraceCheckpoint === 'function') {
        maybeSaveRunningTraceCheckpoint(live, {
          runId: live.runId,
          sessionId: sid,
          trace,
          streamContent: ''
        });
      }
    }
  }
  if (typeof dispatchAgentRunEvent === 'function' && typeof createAgentRunEvent === 'function') {
    dispatchAgentRunEvent(
      sid,
      createAgentRunEvent(AGENT_RUN_EVENT_TYPES.PREP, {
        sessionId: sid,
        trace,
        streamContent: '',
        phase: 'prep',
        meta: { prepSteps: clonePrepSteps(steps), ...(fields.meta || {}) },
        ...fields,
        runId: live?.runId || fields.runId || null
      })
    );
  }
}

function getLivePrepSteps(sessionId) {
  const live = sessionActiveRuns.get(String(sessionId || ''));
  if (live && Array.isArray(live.prepSteps) && live.prepSteps.length) {
    return live.prepSteps;
  }
  return null;
}

function initAgentPrepSteps(sessionId, opts = {}) {
  const steps = createInitialPrepSteps(opts);
  emitAgentPrepUpdate(sessionId, steps, {
    requestId: opts.requestId || null,
    meta: { prepInit: true }
  });
  return steps;
}

function agentPrepStepStart(sessionId, stepId) {
  const steps = getLivePrepSteps(sessionId) || createInitialPrepSteps();
  const id = String(stepId || '');
  let changed = false;
  for (const step of steps) {
    if (step.id === id) {
      if (step.status !== 'done' && step.status !== 'skipped' && step.status !== 'failed') {
        step.status = 'active';
        changed = true;
      }
    }
  }
  if (changed) emitAgentPrepUpdate(sessionId, steps);
  return steps;
}

function agentPrepStepDone(sessionId, stepId) {
  const steps = getLivePrepSteps(sessionId);
  if (!steps) return null;
  const id = String(stepId || '');
  let changed = false;
  for (const step of steps) {
    if (step.id === id && (step.status === 'pending' || step.status === 'active')) {
      step.status = 'done';
      delete step.detail;
      changed = true;
    }
  }
  if (changed) emitAgentPrepUpdate(sessionId, steps);
  return steps;
}

function agentPrepStepSkip(sessionId, stepId, detail) {
  const steps = getLivePrepSteps(sessionId);
  if (!steps) return null;
  const id = String(stepId || '');
  const detailText = detail != null ? String(detail).trim().slice(0, 420) : '';
  let changed = false;
  for (const step of steps) {
    if (step.id === id && step.status !== 'done' && step.status !== 'failed') {
      step.status = 'skipped';
      if (detailText) step.detail = detailText;
      else delete step.detail;
      changed = true;
    }
  }
  if (changed) emitAgentPrepUpdate(sessionId, steps);
  return steps;
}

function agentPrepStepFail(sessionId, stepId, detail) {
  const steps = getLivePrepSteps(sessionId);
  if (!steps) return null;
  const id = String(stepId || '');
  let changed = false;
  for (const step of steps) {
    if (step.id === id && step.status !== 'skipped') {
      step.status = 'failed';
      step.detail = detail ? String(detail).slice(0, 420) : '';
      changed = true;
    }
  }
  if (changed) emitAgentPrepUpdate(sessionId, steps);
  return steps;
}

function agentPrepStepNote(sessionId, stepId, detail) {
  const steps = getLivePrepSteps(sessionId);
  if (!steps) return null;
  const id = String(stepId || '');
  let changed = false;
  for (const step of steps) {
    if (step.id === id && step.status === 'active') {
      const next = detail ? String(detail).slice(0, 420) : '';
      if (step.detail !== next) {
        step.detail = next;
        changed = true;
      }
    }
  }
  if (changed) emitAgentPrepUpdate(sessionId, steps);
  return steps;
}

function finishAgentPrepPhase(sessionId) {
  const sid = String(sessionId || '').trim();
  const live = sessionActiveRuns.get(sid);
  if (!live) return;
  live.inPrepPhase = false;
  delete live.prepSteps;
}

function agentPrepStepsSig(steps) {
  return (steps || [])
    .map((s) => `${s.id}:${s.status}:${String(s.detail || '').slice(0, 80)}`)
    .join(',');
}

const INDEX_PREP_TRANSIENT_RE =
  /超时|timeout|dieyun-core 已停止|dieyun-core 已退出|EXEC_ERROR/i;

/**
 * 发消息前索引门闩（codebase / graph 共用）：
 * status → 已可检索则注入 → 构建中则仅提示 → 未建立则 start 一次 → **一律不等待**。
 *
 * @param {{
 *   kind: 'codebase'|'graph',
 *   workspacePath: string,
 *   prepSid: string,
 *   abortIfNeeded: () => void,
 *   gatewayCall: (method: string, params: object, timeoutMs?: number) => Promise<object>,
 *   isReady: (st: object) => boolean
 * }} opts
 * @returns {Promise<{ ok: boolean, status: object|null, skipped?: boolean, phase?: string, error?: string }>}
 */
function formatPrepIndexProgress(st, kind, mode) {
  const label = kind === 'codebase' ? '代码索引' : '结构索引';
  const phase = String(st && st.phase ? st.phase : '').trim();
  const phaseLabel =
    kind === 'codebase'
      ? phase === 'walking'
        ? '扫描文件'
        : phase === 'chunking'
          ? '切分代码'
          : phase === 'embedding'
            ? '生成向量'
            : phase === 'finishing'
              ? '写入索引'
              : phase === 'error'
                ? '索引失败'
                : '建立索引'
      : phase === 'walking'
        ? '扫描文件'
        : phase === 'parsing'
          ? '解析符号'
          : phase === 'finishing'
            ? '写入结构'
            : phase === 'error'
              ? '索引失败'
              : '建立结构';
  const done = Number(st && st.filesDone) || 0;
  const total = Number(st && st.filesTotal) || 0;
  const progress = total > 0 ? `（${done}/${total} 文件）` : done > 0 ? `（${done} 文件）` : '';
  if (mode === 'creating') {
    return `${label}创建中${progress}，本次不等待`;
  }
  if (mode === 'started') {
    return `已发起${label}创建任务（后台），本次不等待`;
  }
  return `${label}${phaseLabel ? ` · ${phaseLabel}` : ''}${progress}`;
}

/** 保存触发的增量索引尚未跟上时，注入前最多等待多久 */
const PREP_FRESH_WAIT_MS = 2000;
const PREP_FRESH_POLL_MS = 250;

/**
 * 刚保存过文件、增量索引还没跑完时，最多等待 PREP_FRESH_WAIT_MS 再装配上下文。
 * 只在 status 明确报 refreshPending 时调用，避免每次发送都平白加延迟。
 */
async function waitForFreshPrepIndex({ callRpc, statusMethod, workspacePath, note, kind }) {
  const deadline = Date.now() + PREP_FRESH_WAIT_MS;
  let st = null;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, PREP_FRESH_POLL_MS));
    try {
      st = await callRpc(statusMethod, { workspaceRoot: workspacePath }, 20000);
    } catch {
      return null;
    }
    if (!st) return null;
    if (!st.refreshPending && !st.indexing) return st;
    if (st.indexing) {
      try {
        note(formatPrepIndexProgress(st, kind, 'creating'));
      } catch {
        /* 进度提示失败不影响等待 */
      }
    }
  }
  return st;
}

async function ensurePrepIndexReady(opts) {
  const { kind, workspacePath, prepSid, abortIfNeeded, gatewayCall: rpc, isReady } = opts;
  const statusMethod = kind === 'codebase' ? 'codebase.status' : 'graph.status';
  const startMethod = kind === 'codebase' ? 'codebase.index.start' : 'graph.index.start';
  const label = kind === 'codebase' ? '代码索引' : '结构索引';
  const note = (detail) => {
    if (prepSid && typeof agentPrepStepNote === 'function') {
      agentPrepStepNote(prepSid, kind, detail);
    }
  };

  const callRpc = async (method, params, timeoutMs, retryNote) => {
    let lastErr = null;
    const scoped = {
      ...(params || {}),
      sessionId: prepSid || params?.sessionId,
      runWorkspaceRoot: workspacePath || params?.runWorkspaceRoot
    };
    for (let attempt = 0; attempt < 2; attempt++) {
      if (typeof abortIfNeeded === 'function') abortIfNeeded();
      try {
        return await rpc(method, scoped, timeoutMs);
      } catch (err) {
        lastErr = err;
        const msg = err && err.message ? String(err.message) : String(err);
        if (!INDEX_PREP_TRANSIENT_RE.test(msg) || attempt >= 1) throw err;
        note(retryNote || '索引服务瞬断，重试…');
        await new Promise((r) => setTimeout(r, 1200));
      }
    }
    throw lastErr;
  };

  let st = null;
  try {
    st = await callRpc(statusMethod, { workspaceRoot: workspacePath }, 45000, '状态查询失败，重试…');
  } catch (err) {
    const msg = err && err.message ? String(err.message) : String(err);
    note(`状态暂不可用，跳过：${msg}`);
    return { ok: false, status: null, skipped: true, phase: 'unavailable', error: msg };
  }

  // 刚保存过文件：防抖窗口/增量索引还没跟上时先等一小会儿，
  // 否则本次装配会用旧索引（「改完查不到」的主要来源）。
  if (kind === 'codebase' && st && st.refreshPending) {
    const caughtUp = await waitForFreshPrepIndex({
      callRpc,
      statusMethod,
      workspacePath,
      note,
      kind
    });
    if (caughtUp) st = caughtUp;
  }

  if (isReady(st)) return { ok: true, status: st };

  if (st && st.indexing) {
    const detail = formatPrepIndexProgress(st, kind, 'creating');
    note(detail);
    kickPrepIndexRailBusy(kind);
    return { ok: false, status: st, skipped: true, phase: 'creating', error: detail };
  }

  if (st && st.lastError && !st.indexing && !st.indexed) {
    const detail = `${label}失败：${String(st.lastError).slice(0, 120)}（本次不等待）`;
    note(detail);
    return { ok: false, status: st, skipped: true, phase: 'error', error: detail };
  }

  let started = false;
  try {
    const startRes = await callRpc(
      startMethod,
      // 未就绪时勿 skipIfReady：空仓 indexed 壳也需触发后台 refresh
      { workspaceRoot: workspacePath, force: false, skipIfReady: false },
      30000,
      '索引启动失败，重试…'
    );
    st = startRes || st;
    started = true;
  } catch {
    started = true;
    void callRpc(
      startMethod,
      { workspaceRoot: workspacePath, force: false, skipIfReady: false },
      120000
    ).catch(() => {});
  }

  kickPrepIndexRailBusy(kind);

  if (isReady(st)) return { ok: true, status: st };

  if (st && st.indexing) {
    const detail = formatPrepIndexProgress(st, kind, 'creating');
    note(detail);
    return { ok: false, status: st, skipped: true, phase: 'creating', error: detail };
  }

  const detail = started
    ? formatPrepIndexProgress(st, kind, 'started')
    : `已发起${label}创建任务（后台），本次不等待`;
  note(detail);
  return { ok: false, status: st, skipped: true, phase: 'started', error: detail };
}

function kickPrepIndexRailBusy(kind) {
  try {
    if (kind === 'codebase' && typeof window.refreshCodebasePanelStatus === 'function') {
      window.refreshCodebasePanelStatus().catch(() => {});
    } else if (kind === 'graph' && typeof window.refreshGraphPanelStatus === 'function') {
      window.refreshGraphPanelStatus().catch(() => {});
    }
  } catch {
    /* ignore */
  }
}

function isCodebasePrepReady(st) {
  if (!st || !st.indexed || st.indexing) return false;
  return (Number(st.chunkCount != null ? st.chunkCount : st.chunk_count) || 0) > 0;
}

function isGraphPrepReady(st) {
  if (!st || !st.indexed || st.indexing) return false;
  const symbols = Number(st.symbolCount != null ? st.symbolCount : st.symbol_count) || 0;
  const edges = Number(st.edgeCount != null ? st.edgeCount : st.edge_count) || 0;
  return symbols > 0 || edges > 0;
}

if (typeof window !== 'undefined') {
  window.AGENT_PREP_STEP_DEFS = AGENT_PREP_STEP_DEFS;
  window.initAgentPrepSteps = initAgentPrepSteps;
  window.agentPrepStepStart = agentPrepStepStart;
  window.agentPrepStepDone = agentPrepStepDone;
  window.agentPrepStepSkip = agentPrepStepSkip;
  window.agentPrepStepFail = agentPrepStepFail;
  window.agentPrepStepNote = agentPrepStepNote;
  window.finishAgentPrepPhase = finishAgentPrepPhase;
  window.isPrepOnlyTrace = isPrepOnlyTrace;
  window.resolveStoppedDisplayTrace = resolveStoppedDisplayTrace;
  window.resolveFailedDisplayTrace = resolveFailedDisplayTrace;
  window.agentPrepStepsSig = agentPrepStepsSig;
  window.ensurePrepIndexReady = ensurePrepIndexReady;
  window.formatPrepIndexProgress = formatPrepIndexProgress;
  window.isCodebasePrepReady = isCodebasePrepReady;
  window.isGraphPrepReady = isGraphPrepReady;
}
