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
        detail: opts.skipUndoReason || '已跳过'
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

/**
 * 索引根在文案里的短名：`…/<项目>/.dieyun/worktrees/<id>/main` → `<项目>`，本地取末段目录名。
 *
 * 为什么要带它：SSH 会话的索引在它**自己那份** worktree 里（另一份 `index.sqlite`），
 * 只写「创建中」看不出是哪一份，用户只能当成 bug（2026-10-29 已误判过一次）。
 */
function shortIndexRoot(root) {
  const raw = String(root || '').trim().replace(/\\/g, '/').replace(/\/+$/, '');
  if (!raw) return '';
  // 会话副本剥尾：与 UI / 会话身份的显示口径一致（项目才是身份，副本是实现细节）
  const m = raw.match(/^(.*)\/\.dieyun\/worktrees\/[^/]+\/[^/]+$/);
  const seg = String(m ? m[1] : raw)
    .split('/')
    .filter(Boolean);
  return seg.length ? seg[seg.length - 1] : '';
}

/**
 * 索引步骤的一句话。**唯一成形处**——别在别处再拼「创建中」。
 *
 * 三条硬约束（都是踩过的坑）：
 * 1. 动词由 `st.indexed` 决定：`indexed=false` 是**首建**（这个根从来没建成过一次），
 *    `indexed=true` 只是**刷新**。一律写「创建中」，用户会看到「面板上明明已建好、
 *    准备区却在创建」而当成 bug，进而去重建一份根本不需要重建的索引。
 * 2. **错误优先于进度**：`lastError` 有值就必须显示。旧实现要求 `!indexing && !indexed`，
 *    于是「一边失败一边重试」时错误被进度永久盖住，症状就是「永远创建中」。
 * 3. 行内不套括号：skipped 行整体会渲染成 `label（detail）`，detail 内再套括号是双层。
 *
 * @param {object|null} st `codebase.status` / `graph.status` 的返回值
 * @param {'codebase'|'graph'} kind
 * @param {'creating'|'started'} [mode] creating=已在跑；started=本轮刚发起、没拿到状态
 * @param {string} [root] 索引根（用于显示是哪个项目的哪份库）
 * @param {{trackStall?: boolean}} [opts] trackStall 只给「每轮读一次状态」的调用方传：
 *   它会在进程内记下本轮 filesDone 供**下一轮**比较。最终的报错文案必须不传 ——
 *   否则同一轮里第二次调用会把第一次刚写进去的同一个 done 当成「上一轮」，
 *   健康的在建会被读成「进度没前进」（本轮就踩过）。
 * @returns {string}
 */
function formatPrepIndexProgress(st, kind, mode, root, opts) {
  // 注意：这里的返回值是 skipped 行的 detail，渲染成 `label（detail）`（renderer-thinking-trace-dom.js:350），
  // 所以 detail 里不要再带「代码索引 / 结构索引」，也不要再套括号。
  const where = shortIndexRoot(root);
  const at = where ? ` · ${where}` : '';
  const done = Number(st && st.filesDone) || 0;
  const total = Number(st && st.filesTotal) || 0;
  const progress = total > 0 ? ` · ${done}/${total} 文件` : done > 0 ? ` · ${done} 文件` : '';

  // 真错误排在进度前面：正在跑不代表没问题（半路失败后 core 会继续重试）
  const lastError = st && st.lastError ? String(st.lastError).trim().slice(0, 120) : '';
  if (lastError) return `索引失败：${lastError}，本轮用 grep`;

  const verb = st && st.indexed ? '刷新' : '首建';
  if (mode === 'creating') {
    const stall = opts && opts.trackStall && prepProgressStalled(kind, root, done) ? ' · 进度未前进' : '';
    return `后台${verb}${at}${progress}${stall}，本轮用 grep`;
  }
  if (mode === 'started') {
    return `已发起后台首建${at}，本轮用 grep`;
  }
  if (mode === 'idle') {
    // 没在跑也没就绪：只在「发起过但被打断 / 建完 0 内容」时出现，必须给出可执行的下一步
    return `未就绪且未在跑，本轮用 grep，可在侧栏「索引」面板重建`;
  }
  return `阶段 ${String((st && st.phase) || '未知')}${at}${progress}`;
}

/** 上一轮的 filesDone（进程内，不落库）：连续两轮没前进就提示「进度未前进」 */
const prepProgressSeen = new Map();

function prepProgressStalled(kind, root, done) {
  if (!done) return false;
  const key = `${kind}:${String(root || '')}`;
  const prev = prepProgressSeen.get(key);
  prepProgressSeen.set(key, done);
  return typeof prev === 'number' && prev === done;
}

/** 保存触发的增量索引尚未跟上时，注入前最多等待多久 */
const PREP_FRESH_WAIT_MS = 2000;
const PREP_FRESH_POLL_MS = 250;

/**
 * 刚保存过文件、增量索引还没跑完时，最多等待 PREP_FRESH_WAIT_MS 再装配上下文。
 * 只在 status 明确报 refreshPending 时调用，避免每次发送都平白加延迟。
 *
 * 等待期间**不再刷进度文案**：那是「准备区一直显示在创建」的主要噪声源，
 * 而它一句话也回答不了「为什么没建完」。
 */
async function waitForFreshPrepIndex({ callRpc, statusMethod, workspacePath, root }) {
  const target = root || workspacePath;
  const deadline = Date.now() + PREP_FRESH_WAIT_MS;
  let st = null;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, PREP_FRESH_POLL_MS));
    try {
      st = await callRpc(statusMethod, { workspaceRoot: target }, 20000);
    } catch {
      return null;
    }
    if (!st) return null;
    if (!st.refreshPending && !st.indexing) return st;
  }
  return st;
}

/** 状态查询预算（与网关 `codebase.status` / `graph.status` 的 RPC 预算一致） */
const PREP_STATUS_TIMEOUT_MS = 45000;
/** 发起建库：短超时（没答复不等于没发起） */
const PREP_BUILD_KICK_TIMEOUT_MS = 30000;
/** 短超时后的补发：只影响面板忙态，不影响本轮 */
const PREP_BUILD_KICK_RETRY_TIMEOUT_MS = 120000;

/**
 * 读一次索引状态（**只读**：不发 start、不重试、不改文案）。
 *
 * 为什么要拆出来：建库是一次性的、慢的、后台的事，而 prep 是「发一轮消息」的热路径。
 * 两者耦合时每一轮都会重新判一次、必要时重新发起，准备区于是永远停在「创建中」——
 * 用户从中分不出「首建」「卡住」「建在另一个路径」三种完全不同的处境。
 *
 * @param {{
 *   kind: 'codebase'|'graph',
 *   workspacePath: string,
 *   prepSid?: string,
 *   abortIfNeeded?: () => void,
 *   gatewayCall: (method: string, params: object, timeoutMs?: number) => Promise<object>,
 *   isReady: (st: object) => boolean
 * }} opts
 * @returns {Promise<{ ok: boolean, status: object|null, root: string, skipped?: boolean, phase?: string, error?: string }>}
 */
async function readPrepIndexStatus(opts) {
  const { kind, workspacePath, prepSid, abortIfNeeded, gatewayCall: rpc, isReady } = opts;
  const root = String(workspacePath || '').trim();
  const statusMethod = kind === 'codebase' ? 'codebase.status' : 'graph.status';
  if (!root || typeof rpc !== 'function') {
    return { ok: false, status: null, root, skipped: true, phase: 'no_workspace', error: '' };
  }
  const scope = { workspaceRoot: root, sessionId: prepSid || undefined, runWorkspaceRoot: root };

  let st = null;
  try {
    if (typeof abortIfNeeded === 'function') abortIfNeeded();
    st = await rpc(statusMethod, scope, PREP_STATUS_TIMEOUT_MS);
  } catch (err) {
    const msg = err && err.message ? String(err.message) : String(err);
    // 状态查不到 != 没有索引（常见于 SSH 瞬断）：本轮不注入，也不要去 kick
    return {
      ok: false,
      status: null,
      root,
      skipped: true,
      phase: 'unavailable',
      error: `索引状态暂不可用：${msg}`
    };
  }

  // 刚保存过文件：防抖窗口 / 增量还没跟上时先等一小会儿，
  // 否则本次装配会用旧索引（「改完查不到」的主要来源）。
  if (kind === 'codebase' && st && st.refreshPending) {
    const caughtUp = await waitForFreshPrepIndex({
      callRpc: (method, params, timeoutMs) => rpc(method, { ...scope, ...(params || {}) }, timeoutMs),
      statusMethod,
      root
    });
    if (caughtUp) st = caughtUp;
  }

  if (typeof isReady === 'function' && isReady(st)) return { ok: true, status: st, root };
  if (st && st.indexing) {
    return {
      ok: false,
      status: st,
      root,
      skipped: true,
      phase: 'creating',
      error: formatPrepIndexProgress(st, kind, 'creating', root, { trackStall: true })
    };
  }
  return { ok: false, status: st, root, skipped: true, phase: 'not_ready', error: '' };
}

/**
 * 已经发起过首建的索引根（进程内，不落库）。
 *
 * 一个根只 kick 一次是刻意的：失败后继续每轮重试，等于把「建不完」变成常态且对用户不可见。
 * 能再次发起的只有三条显式路径——用户点侧栏「索引」面板的重建、会话换工作区（换根）、进程重启。
 * 这不需要新增状态机：key 是索引根本身，换根天然就是新的 key。
 */
const kickedIndexRoots = new Set();

/**
 * 该索引根**从未发起过**建库时才发起一次（后台，不等）。
 *
 * @param {{
 *   kind: 'codebase'|'graph',
 *   workspacePath: string,
 *   prepSid?: string,
 *   gatewayCall: (method: string, params: object, timeoutMs?: number) => Promise<object>
 * }} opts
 * @returns {Promise<{ kicked: boolean, status: object|null }>}
 */
async function kickIndexBuildOnce(opts) {
  const { kind, workspacePath, prepSid, gatewayCall: rpc } = opts;
  const root = String(workspacePath || '').trim();
  const startMethod = kind === 'codebase' ? 'codebase.index.start' : 'graph.index.start';
  const key = `${kind}:${root}`;
  if (!root || typeof rpc !== 'function' || kickedIndexRoots.has(key)) {
    return { kicked: false, status: null };
  }
  kickedIndexRoots.add(key);
  kickPrepIndexRailBusy(kind);
  const params = {
    workspaceRoot: root,
    sessionId: prepSid || undefined,
    runWorkspaceRoot: root,
    // 未就绪时勿 skipIfReady：空仓 indexed 壳也需触发后台 refresh
    force: false,
    skipIfReady: false
  };
  try {
    const startRes = await rpc(startMethod, params, PREP_BUILD_KICK_TIMEOUT_MS);
    return { kicked: true, status: startRes || null };
  } catch {
    // 短超时没答复不等于没发起：用长超时再发一次，结果只影响面板忙态
    void rpc(startMethod, params, PREP_BUILD_KICK_RETRY_TIMEOUT_MS).catch(() => {});
    return { kicked: true, status: null };
  }
}

/**
 * 发消息前的索引门闩（codebase / graph 共用）：**只读判断 + 从未发起过才 kick 一次**。
 *
 * 顺序：status → 已可检索则注入 → 在跑/未就绪则记一句**可读的**跳过理由 →
 * 从未发起过才 kick。**一律不等待**；文案的唯一成形处是 {@link formatPrepIndexProgress}。
 *
 * @param {{
 *   kind: 'codebase'|'graph',
 *   workspacePath: string,
 *   prepSid: string,
 *   abortIfNeeded: () => void,
 *   gatewayCall: (method: string, params: object, timeoutMs?: number) => Promise<object>,
 *   isReady: (st: object) => boolean
 * }} opts
 * @returns {Promise<{ ok: boolean, status: object|null, root?: string, skipped?: boolean, phase?: string, error?: string }>}
 */
async function ensurePrepIndexReady(opts) {
  const { kind, isReady } = opts;
  const read = await readPrepIndexStatus(opts);
  if (read.ok) return read;
  if (read.phase === 'unavailable' || read.phase === 'no_workspace') return read;

  const kicked = await kickIndexBuildOnce({ ...opts, workspacePath: read.root || opts.workspacePath });
  const st = kicked.status || read.status;
  if (typeof isReady === 'function' && isReady(st)) return { ok: true, status: st, root: read.root };

  const mode = st && st.indexing ? 'creating' : kicked.kicked ? 'started' : 'idle';
  return {
    ok: false,
    status: st,
    root: read.root,
    skipped: true,
    phase: mode,
    error: formatPrepIndexProgress(st, kind, mode, read.root)
  };
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
  window.readPrepIndexStatus = readPrepIndexStatus;
  window.kickIndexBuildOnce = kickIndexBuildOnce;
  window.formatPrepIndexProgress = formatPrepIndexProgress;
  window.shortIndexRoot = shortIndexRoot;
  window.isCodebasePrepReady = isCodebasePrepReady;
  window.isGraphPrepReady = isGraphPrepReady;
}
