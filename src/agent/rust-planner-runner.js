'use strict';

const { chatCompletionJson } = require('../llm-proxy');
const { runWithLlmReconnectRetry, raceAbortable } = require('../llm-reconnect-retry');
const { recordLlmUsage } = require('./llm-usage-recorder');
const {
  addUsageStats,
  emptyUsageStats,
  estimateLlmRoundUsage,
  extractUsageStats
} = require('../llm-usage-stats');
const { loadModelSettings } = require('../model-settings');
const { resolveAgentLoopSpec, scaleLimitForLongHorizon, LONG_HORIZON_HARD_CAP } = require('./agent-limits');
const { settleAllAbortable } = require('./parallel-batch');
const { createPlannerMainBridge } = require('./planner-main-bridge');
const { buildExploreTools, buildShellTools, buildBuildTools } = require('./planner-tool-filters');
const { runRustAgentLoop, resolveChatUrl } = require('./rust-loop-runner');
const { createMainCompactionAgent, getEffectiveInputBudget } = require('./compaction-main');
const { stripToolCallMarkup } = require('../llm-tool-call-fallback');
const {
  LONG_HORIZON_MAX_SEGMENTS,
  buildSegmentContinueMessages
} = require('./segment-continue');

const TASK_TIMEOUT_MS = 60 * 60 * 1000;
const LIVE_THOUGHT_CHARS = 2000;

function createAbortError() {
  const err = new Error('已停止');
  err.name = 'AbortError';
  return err;
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw createAbortError();
}

function createAbortWaiter(signal) {
  if (!signal) return null;
  if (signal.aborted) {
    return { promise: Promise.reject(createAbortError()), cancel() {} };
  }
  if (typeof signal.addEventListener === 'function') {
    let onAbort;
    const promise = new Promise((_, reject) => {
      onAbort = () => {
        signal.removeEventListener('abort', onAbort);
        reject(createAbortError());
      };
      signal.addEventListener('abort', onAbort, { once: true });
    });
    return {
      promise,
      cancel() {
        if (onAbort) signal.removeEventListener('abort', onAbort);
      }
    };
  }
  // main-entry passes `{ get aborted() { return entry.aborted; } }` — poll the getter.
  let timer = null;
  const promise = new Promise((_, reject) => {
    timer = setInterval(() => {
      if (signal.aborted) {
        clearInterval(timer);
        timer = null;
        reject(createAbortError());
      }
    }, 200);
  });
  return {
    promise,
    cancel() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    }
  };
}

function buildLoopPhaseLabel(meta, roundIndex, roundNo) {
  const base =
    meta.phase ||
    (meta.worker && meta.taskId
      ? `执行器 ${meta.worker} · ${meta.taskId}`
      : meta.worker
        ? `执行器 ${meta.worker}`
        : '执行器');
  if (roundIndex <= 0) return base;
  return `${base} · 第 ${roundNo || roundIndex + 1} 轮`;
}

function mapPendingDelegateTool(d) {
  const args = d.arguments && typeof d.arguments === 'object' ? d.arguments : {};
  return {
    id: d.id || '',
    name: d.name || 'tool',
    argsBrief: JSON.stringify(args).slice(0, 120),
    toolArgs: args,
    summary: '',
    pending: true
  };
}

/**
 * Plan / Explore worker loop 的流式 trace（按 subagentId 独立更新，支持并行执行器）。
 */
function createLiveLoopTraceTracker(meta, { onUpdate }) {
  const subagentId = meta.subagentId || '';
  const rounds = [];
  let llmRound = 0;
  let liveContent = '';

  function getRound(roundNo) {
    const n = Math.max(1, Number(roundNo) || 1);
    let row = rounds.find((x) => x.round === n);
    if (!row) {
      row = { round: n, thought: '', fullThought: '', tools: [] };
      rounds.push(row);
      rounds.sort((a, b) => a.round - b.round);
    }
    return row;
  }

  function toUiEntries() {
    return rounds.map((r, i) => ({
      round: r.round,
      phase: buildLoopPhaseLabel(meta, i, r.round),
      thought: r.thought,
      fullThought: r.fullThought || r.thought,
      subagentId,
      isolated: true,
      worker: meta.worker || '',
      parallel: !!meta.parallel,
      tools: r.tools.map((t) => ({ ...t }))
    }));
  }

  function sync() {
    onUpdate(toUiEntries(), liveContent);
  }

  function eventRoundNo(data) {
    if (data && data.round != null) return Number(data.round) + 1;
    return llmRound + 1;
  }

  function handlePhase(name, data) {
    if (name === 'start') {
      getRound(1).thought = '启动…';
      sync();
      return;
    }
    if (name === 'llm_request') {
      llmRound = data && data.round != null ? Number(data.round) : llmRound;
      const row = getRound(eventRoundNo(data));
      row.thought =
        data && data.model ? `请求 LLM · ${String(data.model).trim()}…` : '请求 LLM…';
      sync();
      return;
    }
    if (name === 'llm_delta') {
      llmRound = data && data.round != null ? Number(data.round) : llmRound;
      const reasoning = String((data && data.reasoning) || '');
      const rawContent = String((data && data.content) || '');
      const contentOnly = stripToolCallMarkup(rawContent);
      const thoughtSource = reasoning || contentOnly || rawContent;
      const row = getRound(eventRoundNo(data));
      row.thought = thoughtSource.slice(0, LIVE_THOUGHT_CHARS) || '生成中…';
      row.fullThought = thoughtSource;
      if (reasoning) {
        liveContent = contentOnly.slice(0, 800);
      } else {
        liveContent = '';
      }
      sync();
      return;
    }
    if (name === 'llm_response') {
      if (data && data.round != null) llmRound = Number(data.round) + 1;
      return;
    }
    if (name === 'need_delegate' || name === 'delegate_start') {
      const delegates = Array.isArray(data && data.delegates) ? data.delegates : [];
      if (!delegates.length) return;
      const row = getRound(llmRound || 1);
      for (const d of delegates) {
        if (d.id && row.tools.some((t) => t.id === d.id)) continue;
        row.tools.push(mapPendingDelegateTool(d));
      }
      if (!row.thought || String(row.thought).startsWith('请求 LLM')) row.thought = '执行工具…';
      sync();
      return;
    }
    if (name === 'delegate_result') {
      const row = getRound(llmRound || 1);
      const tool = row.tools.find((t) => t.id === data.id) || row.tools.find((t) => t.pending && t.name === data.name);
      if (tool) {
        tool.pending = false;
        if (data.arguments && typeof data.arguments === 'object') {
          tool.toolArgs = { ...(tool.toolArgs || {}), ...data.arguments };
          tool.args = { ...(tool.args || {}), ...data.arguments };
        }
        if (data.result && typeof data.result === 'object') {
          tool.result = data.result;
          if (data.result.path && !tool.toolArgs?.filePath) {
            tool.toolArgs = { ...(tool.toolArgs || {}), filePath: data.result.path };
            tool.args = { ...(tool.args || {}), filePath: data.result.path };
          }
        }
        const briefArgs = tool.toolArgs || tool.args || {};
        tool.argsBrief =
          briefArgs.filePath ||
          briefArgs.path ||
          JSON.stringify(briefArgs).slice(0, 120);
        tool.summary = data.error
          ? `错误: ${data.error}`
          : summarizeLoopTool({ name: data.name, result: data.result, error: data.error });
        if ((data.name === 'fs_write_file' || data.name === 'fs_edit') && data.result && data.result.diff) {
          tool.diff = compactLoopToolDiff(data.result.diff);
        }
      }
      sync();
    }
  }

  return { handlePhase, getSubagentId: () => subagentId };
}

function filterTools(allTools, agentType) {
  if (agentType === 'explore') return buildExploreTools(allTools);
  if (agentType === 'shell') return buildShellTools(allTools);
  return buildBuildTools(allTools);
}

function plannerBestOfNFromPayload(payload, settings) {
  const n = Number(
    payload.plannerBestOfN != null ? payload.plannerBestOfN : settings.plannerBestOfN
  );
  if (!Number.isFinite(n) || n < 2) return 0;
  return Math.min(3, Math.max(2, Math.floor(n)));
}

function clampPlanContentBestOfN(content, enabledN) {
  if (enabledN >= 2) return content;
  const trimmed = String(content || '').trim();
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start < 0 || end <= start) return content;
  try {
    const obj = JSON.parse(trimmed.slice(start, end + 1));
    obj.bestOfN = 0;
    obj.best_of_n = 0;
    return trimmed.slice(0, start) + JSON.stringify(obj) + trimmed.slice(end + 1);
  } catch {
    return content;
  }
}

function sanitizePlanBestOfN(plan, enabledN) {
  if (!plan || typeof plan !== 'object' || enabledN >= 2) return plan;
  return { ...plan, bestOfN: 0, best_of_n: 0 };
}

function shouldUseCoordinatorTaskQueue(plan, payload, enabledBestOfN) {
  if (enabledBestOfN >= 2) return true;
  if (!plan || typeof plan !== 'object') return false;
  const subtasks = Array.isArray(plan.subtasks) ? plan.subtasks : [];
  if (subtasks.length > 3) return true;
  const workers = new Set(subtasks.map((st) => String(st?.worker || 'A')));
  if (workers.size > 1) return true;
  const t = String(payload?.userText || '');
  if (/重构|架构|迁移|集成|全量|多模块|调研|arbitrat/i.test(t)) return true;
  return false;
}

function compactLoopToolDiff(diff) {
  if (!diff || typeof diff !== 'object') return null;
  const out = {
    added: Number(diff.added) || 0,
    removed: Number(diff.removed) || 0,
    created: !!diff.created,
    textTruncated: !!diff.textTruncated
  };
  const cap = 12000;
  if (diff.beforeSnippet != null) {
    const s = String(diff.beforeSnippet);
    out.beforeSnippet = s.length > cap ? s.slice(0, cap) : s;
  }
  if (diff.afterSnippet != null) {
    const s = String(diff.afterSnippet);
    out.afterSnippet = s.length > cap ? s.slice(0, cap) : s;
  }
  if (!diff.textTruncated) {
    if (diff.beforeText != null) {
      const t = String(diff.beforeText);
      if (t.length <= 120000) out.beforeText = t;
    }
    if (diff.afterText != null) {
      const t = String(diff.afterText);
      if (t.length <= 120000) out.afterText = t;
    }
  }
  return out;
}

function newSubagentId(worker) {
  return `exec-${worker}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

function summarizeLoopTool(t) {
  if (t.error) return `错误: ${t.error}`;
  if (t.name === 'host_exec') {
    return summarizeHostExecInline(t.result, t.error);
  }
  if (t.name === 'fs_write_file' || t.name === 'fs_edit') {
    const r = t.result;
    if (r && typeof r === 'object' && r.path) {
      const file = String(r.path).replace(/\\/g, '/').split('/').pop() || r.path;
      const diff = r.diff
        ? ` · +${Number(r.diff.added) || 0} -${Number(r.diff.removed) || 0}`
        : '';
      const n = Number(r.replacements);
      const repl = t.name === 'fs_edit' && Number.isFinite(n) && n > 0 ? ` · ${n} 处` : '';
      return `${file}${r.diff?.created ? ' · 新建' : t.name === 'fs_edit' ? ' · 已替换' : ' · 已写入'}${diff}${repl}`;
    }
  }
  const r = t.result;
  if (r && typeof r === 'object') {
    if (typeof r.stdout === 'string' && r.stdout.trim()) return r.stdout.trim().slice(0, 240);
    if (typeof r.stderr === 'string' && r.stderr.trim()) return r.stderr.trim().slice(0, 240);
    if (typeof r.message === 'string' && r.message.trim()) return r.message.trim().slice(0, 240);
    if (typeof r.content === 'string' && r.content.trim()) return r.content.trim().slice(0, 240);
  }
  return '完成';
}

function summarizeHostExecInline(result, error) {
  if (error) return `错误: ${error}`;
  if (!result || typeof result !== 'object') return '完成';
  const exit = result.code != null ? result.code : result.exitCode;
  const stderr = String(result.stderr ?? '').trim();
  if (stderr && exit != null && exit !== 0) {
    return `exit ${exit} · ${stderr.slice(0, 80)}`;
  }
  const out = String(result.stdout ?? result.output ?? '').trim();
  if (out) {
    if ((/^\/\*|^#|^<!DOCTYPE|^<html[\s>]/i.test(out) || out.includes('{')) && out.length > 80) {
      return `exit ${exit ?? 0} · 输出 ${out.length} 字`;
    }
    if (/^(True|False|OK|null|None)$/i.test(out)) return `exit ${exit ?? 0} · ${out}`;
    return out.length > 100 ? `${out.slice(0, 100)}…` : out;
  }
  if (stderr) return stderr.slice(0, 100);
  return exit != null ? (exit === 0 ? 'exit 0' : `exit ${exit}`) : '完成';
}

function mapLoopToolToUi(t) {
  const args =
    (t.toolArgs && typeof t.toolArgs === 'object' && Object.keys(t.toolArgs).length
      ? t.toolArgs
      : null) ||
    (t.args && typeof t.args === 'object' ? t.args : {});
  const normalized = { ...(args || {}) };
  if (!normalized.filePath && normalized.path) normalized.filePath = normalized.path;
  if (!normalized.filePath && normalized.file) normalized.filePath = normalized.file;
  if (!normalized.filePath && t.result && typeof t.result === 'object' && t.result.path) {
    normalized.filePath = String(t.result.path);
  }
  const out = {
    name: t.name || 'tool',
    argsBrief:
      normalized.filePath ||
      normalized.path ||
      JSON.stringify(normalized).slice(0, 120),
    summary: summarizeLoopTool(t),
    pending: !!t.pending,
    failed: !!t.failed,
    toolArgs: normalized,
    args: t.args && typeof t.args === 'object' ? t.args : normalized
  };
  if (t.diff) out.diff = t.diff;
  if (t.result) out.result = t.result;
  if (t.error) out.error = t.error;
  return out;
}

function mergeTraceTools(liveTools, rustTools) {
  const out = [];
  const n = Math.max(liveTools.length, rustTools.length);
  for (let i = 0; i < n; i += 1) {
    const live = liveTools[i];
    const rust = rustTools[i];
    if (!live) {
      out.push(rust);
      continue;
    }
    if (!rust) {
      out.push(live);
      continue;
    }
    const mergedArgs = {
      ...(rust.args && typeof rust.args === 'object' ? rust.args : {}),
      ...(rust.toolArgs && typeof rust.toolArgs === 'object' ? rust.toolArgs : {}),
      ...(live.args && typeof live.args === 'object' ? live.args : {}),
      ...(live.toolArgs && typeof live.toolArgs === 'object' ? live.toolArgs : {})
    };
    if (!mergedArgs.filePath && mergedArgs.path) mergedArgs.filePath = mergedArgs.path;
    const mergedResult = live.result || rust.result || null;
    if (!mergedArgs.filePath && mergedResult && mergedResult.path) {
      mergedArgs.filePath = String(mergedResult.path);
    }
    out.push({
      ...rust,
      ...live,
      toolArgs: mergedArgs,
      args: live.args || rust.args || mergedArgs,
      result: mergedResult,
      diff: live.diff || rust.diff,
      summary: live.summary || rust.summary,
      argsBrief:
        (live.argsBrief && live.argsBrief !== '{}' && live.argsBrief) ||
        (rust.argsBrief && rust.argsBrief !== '{}' && rust.argsBrief) ||
        mergedArgs.filePath ||
        JSON.stringify(mergedArgs).slice(0, 120),
      pending: !!(live.pending || rust.pending),
      failed: !!(live.failed || rust.failed)
    });
  }
  return out;
}

function mapPlannerTraceEntryToUi(entry) {
  const thought = String(entry?.thought || '').trim();
  return {
    round: entry?.round,
    phase: entry?.phase || '思考',
    thought,
    fullThought: thought,
    tools: Array.isArray(entry?.tools)
      ? entry.tools
          .filter((t) => t && typeof t === 'object' && t.name)
          .map(mapLoopToolToUi)
      : []
  };
}

function mapLoopTraceToUi(trace, meta = {}) {
  const worker = meta.worker || '';
  const taskId = meta.taskId || '';
  const subagentId = meta.subagentId || '';
  const basePhase =
    meta.phase ||
    (worker && taskId ? `执行器 ${worker} · ${taskId}` : worker ? `执行器 ${worker}` : '执行器');
  return (trace || []).map((r, i) => {
    const thought = String(r.fullThought || r.thought || '').trim();
    return {
      round: r.round,
      phase: i === 0 ? basePhase : `${basePhase} · 第 ${r.round} 轮`,
      thought,
      fullThought: thought,
      subagentId,
      isolated: true,
      worker,
      parallel: !!meta.parallel,
      tools: Array.isArray(r.tools) ? r.tools.map(mapLoopToolToUi) : []
    };
  });
}

async function fetchChatCompletion(body, apiConfig, settings, signal, onUsage, reconnect) {
  const baseUrl = (apiConfig && apiConfig.baseUrl) || settings.baseUrl;
  const apiKey = (apiConfig && apiConfig.apiKey) || settings.apiKey;
  const url = resolveChatUrl(baseUrl);
  const json = await runWithLlmReconnectRetry(
    () =>
      chatCompletionJson(url, {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`
        },
        body: JSON.stringify({ ...body, stream: false }),
        signal
      }),
    { signal, ...(reconnect || {}) }
  );
  const msg = json?.choices?.[0]?.message;
  if (json?.usage) {
    recordLlmUsage(json.usage, body?.model);
    if (typeof onUsage === 'function') onUsage(extractUsageStats(json.usage, body?.model));
  } else {
    const est = estimateLlmRoundUsage(body, {
      content: msg?.content != null ? String(msg.content) : ''
    });
    if (est) {
      recordLlmUsage(est, body?.model);
      if (typeof onUsage === 'function') onUsage(extractUsageStats(est, body?.model));
    }
  }
  return msg?.content != null ? String(msg.content) : '';
}

/**
 * Rust 驱动 Planner pipeline（逻辑在 dieyun-core，Node 执行 LLM + agent loop + worktree）。
 */
async function runRustPlannerPipeline(deps, payload, opts = {}) {
  const bridge = deps.coreBridge;
  if (!bridge || !bridge.isReady()) {
    throw new Error('dieyun-core 未就绪');
  }
  const settings = loadModelSettings(deps.userData);
  const apiConfig = payload.apiConfig || {};
  const baseUrl = apiConfig.baseUrl || settings.baseUrl;
  const apiKey = apiConfig.apiKey || settings.apiKey;
  const signal = opts.signal || null;
  const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : () => {};
  const onPhase = typeof opts.onPhase === 'function' ? opts.onPhase : () => {};
  const allTools = payload.tools || [];
  const exploreTools = buildExploreTools(allTools);
  let workspacePath = payload.workspacePath || undefined;
  if (!workspacePath && typeof deps.resolveAgentRunWorkspacePath === 'function' && payload.sessionId) {
    workspacePath = (await deps.resolveAgentRunWorkspacePath(payload.sessionId)) || undefined;
  }
  if (!workspacePath) {
    const ws = deps.localGateway ? deps.localGateway.getWorkspace() : null;
    workspacePath =
      (ws && ws.kind === 'local' ? ws.workspacePath : null) || deps.workspaceRootPath() || undefined;
  }

  const agentBridge = createPlannerMainBridge({
    coordinator: deps.coordinator,
    worktreeService: deps.worktreeService,
    subagentStore: deps.subagentStore,
    dieyunHome: deps.dieyunHome,
    // 绑定本轮已解析的工作区，禁止回落到 Main 当前视图
    workspaceRootPath: () => workspacePath || (deps.workspaceRootPath && deps.workspaceRootPath()) || null
  });

  let coordinatorRunId = null;
  const started = agentBridge.runStart({ userText: String(payload.userText || '').slice(0, 500) });
  if (started?.runId) coordinatorRunId = started.runId;

  const compactionAgent = createMainCompactionAgent(deps.userData, deps.coreBridge);
  const tokenBudget = getEffectiveInputBudget(settings, payload.model || settings.textModel);
  const toolBridge = deps.createToolBridge(opts.webContents);

  let resumeCheckpoint = null;
  if (payload.resumeFromRunId) {
    resumeCheckpoint = deps.subagentStore.loadCheckpoint(deps.dieyunHome(), payload.resumeFromRunId);
  }

  const enabledBestOfN = plannerBestOfNFromPayload(payload, settings);
  const loopSpec = resolveAgentLoopSpec(settings, deps.userData);
  const plannerReconnect = {
    baseDelayMs: loopSpec.llmRetryBaseMs,
    maxDelayMs: loopSpec.llmMaxRetryDelayMs,
    maxWaitMs: loopSpec.llmReconnectMaxWaitMs
  };
  const loopMaxToolCalls = scaleLimitForLongHorizon(
    'ctxAgentToolCallLimit',
    loopSpec.maxToolCalls,
    payload.longHorizon
  );

  const startParams = {
    model: payload.model || settings.textModel,
    sysContent: payload.sysContent || '',
    userText: payload.userText || '',
    chatHistoryBlock: payload.chatHistoryBlock || '',
    hasImages: !!payload.hasImages,
    hasExploreTools: exploreTools.length > 0,
    maxWorkerRetries: 1,
    bestOfN: enabledBestOfN,
    maxOutputTokens: Math.min(240000, Math.max(1, Number(settings.maxOutputTokens || settings.maxTokens || 8192))),
    temperature: Number(settings.temperature) || 0.7,
    visionModel: payload.visionModel || payload.model || settings.textModel,
    maxToolCalls: loopMaxToolCalls,
    resumeCheckpoint: resumeCheckpoint?.ok ? resumeCheckpoint.data || resumeCheckpoint : null
  };

  let phase = await bridge.invoke('planner.run.start', startParams, 30000);
  let runId = phase.runId;
  onPhase('started', { runId, coordinatorRunId });

  const completedOutputs = [];
  let latestPlan = resumeCheckpoint?.ok && resumeCheckpoint.data?.plan ? resumeCheckpoint.data.plan : null;
  if (latestPlan) latestPlan = sanitizePlanBestOfN(latestPlan, enabledBestOfN);
  let latestExploreNotes =
    (resumeCheckpoint?.ok && resumeCheckpoint.data?.exploreNotes) || '';
  if (resumeCheckpoint?.ok && Array.isArray(resumeCheckpoint.data?.completedOutputs)) {
    completedOutputs.push(...resumeCheckpoint.data.completedOutputs);
  }

  async function persistPlannerCheckpoint(extra = {}) {
    if (!coordinatorRunId || !agentBridge.checkpointSave || !latestPlan) return;
    try {
      await Promise.resolve(
        agentBridge.checkpointSave(coordinatorRunId, {
          status: 'running',
          sessionId: payload.sessionId || null,
          plan: latestPlan,
          planSummary: latestPlan.planSummary || latestPlan.summary || '',
          completedOutputs: completedOutputs.slice(),
          exploreNotes: latestExploreNotes,
          resumable: true,
          ...extra
        })
      );
    } catch {
      // ignore
    }
  }

  let uiTrace = [];
  let lastStreamContent = '';
  let tokenUsage = emptyUsageStats();
  /** 并行 worker 各自独立 trace，避免 Promise.all 竞态覆盖 */
  const isolatedTraceBySubagent = new Map();

  function addPlannerUsage(usage, model) {
    const stats = usage && usage.totalTokens != null
      ? usage
      : extractUsageStats(usage, model || startParams.model);
    tokenUsage = addUsageStats(tokenUsage, stats);
  }

  function compareWorkerTraceEntries(a, b) {
    const wa = String(a.worker || '');
    const wb = String(b.worker || '');
    if (wa !== wb) return wa.localeCompare(wb, undefined, { numeric: true });
    const pa = String(a.phase || '');
    const pb = String(b.phase || '');
    if (pa !== pb) return pa.localeCompare(pb);
    return (Number(a.round) || 0) - (Number(b.round) || 0);
  }

  function collectWorkerTracePart() {
    const workerPart = [];
    for (const entries of isolatedTraceBySubagent.values()) {
      workerPart.push(...entries);
    }
    workerPart.sort(compareWorkerTraceEntries);
    return workerPart;
  }

  const pushUiTrace = (streamContent) => {
    if (streamContent) lastStreamContent = streamContent;
    if (typeof onProgress !== 'function') return;
    onProgress(
      Array.isArray(uiTrace) ? uiTrace.slice() : [],
      lastStreamContent || '',
      latestPlan || null
    );
  };

  function rebuildUiTrace(streamContent) {
    const plannerPart = uiTrace.filter((e) => !e.isolated);
    uiTrace = [...plannerPart, ...collectWorkerTracePart()];
    pushUiTrace(streamContent);
  }

  const upsertIsolatedTrace = (subagentId, entries, streamContent) => {
    if (!subagentId || !Array.isArray(entries) || !entries.length) return;
    isolatedTraceBySubagent.set(subagentId, entries);
    rebuildUiTrace(streamContent);
  };

  const mergePlannerTrace = (trace) => {
    const plannerPart = (trace || []).map(mapPlannerTraceEntryToUi);
    uiTrace = [...plannerPart, ...collectWorkerTracePart()];
    pushUiTrace();
  };

  const finalizeLoopTrace = (loopResult, meta, streamContent) => {
    if (!meta || !meta.subagentId) return;
    const rustEntries = mapLoopTraceToUi(loopResult && loopResult.trace, meta);
    const liveEntries = isolatedTraceBySubagent.get(meta.subagentId) || [];
    const finalEntries = rustEntries.map((rustEntry, idx) => {
      const liveEntry = liveEntries[idx];
      if (!liveEntry) return rustEntry;
      return {
        ...rustEntry,
        thought: liveEntry.thought || rustEntry.thought,
        fullThought: liveEntry.fullThought || rustEntry.fullThought,
        tools: mergeTraceTools(liveEntry.tools || [], rustEntry.tools || [])
      };
    });
    if (!finalEntries.length && liveEntries.length) {
      upsertIsolatedTrace(meta.subagentId, liveEntries, streamContent);
      return;
    }
    if (!finalEntries.length) return;
    upsertIsolatedTrace(
      meta.subagentId,
      finalEntries,
      streamContent || (loopResult && loopResult.content) || ''
    );
  };

  const pushTrace = (trace) => {
    mergePlannerTrace(trace);
  };
  pushTrace(phase.trace);
  if (latestPlan) pushUiTrace();

  /** @type {Set<string>} */
  const activeWorkerLoopIds = new Set();

  async function cancelActiveWorkerLoops() {
    const ids = [...activeWorkerLoopIds];
    activeWorkerLoopIds.clear();
    await Promise.all(
      ids.map((loopRunId) => bridge.invoke('agent.loop.cancel', { runId: loopRunId }).catch(() => {}))
    );
  }

  async function runToolLoopOnce(spec, tools, worktreePath, traceMeta, opts = {}) {
    const deferFinalize = !!opts.deferFinalize;
    const body = {
      model: spec.model || startParams.model,
      messages: spec.messages || [],
      temperature: spec.temperature != null ? spec.temperature : startParams.temperature
    };
    const liveMeta = traceMeta && traceMeta.subagentId ? traceMeta : null;
    let liveContent = '';
    const tracker = liveMeta
      ? createLiveLoopTraceTracker(liveMeta, {
          onUpdate: (entries, content) => {
            if (content) liveContent = content;
            upsertIsolatedTrace(liveMeta.subagentId, entries, content);
          }
        })
      : null;
    if (tracker) tracker.handlePhase('start', {});

    let trackedLoopRunId = null;
    let loopResult;
    try {
      loopResult = await runRustAgentLoop({
        coreBridge: bridge,
        llm: { baseUrl, apiKey },
        loopSpec,
        startParams: {
          model: body.model,
          messages: body.messages,
          tools,
          workspaceRoot: workspacePath,
          maxToolCalls:
            Number(spec.maxToolCalls) > 0 ? Number(spec.maxToolCalls) : loopMaxToolCalls,
          maxRounds: scaleLimitForLongHorizon(
            'agentMaxRounds',
            Math.min(
              LONG_HORIZON_HARD_CAP.agentMaxRounds,
              Math.max(5, Number(spec.maxRounds || settings.agentMaxRounds) || 96)
            ),
            payload.longHorizon
          )
        },
        settings,
        userData: deps.userData,
        useStream: true,
        signal,
        onPhase: (phaseName, data) => {
          if (phaseName === 'start' && data?.runId) {
            trackedLoopRunId = String(data.runId);
            activeWorkerLoopIds.add(trackedLoopRunId);
          }
          if (phaseName === 'llm_response' && data?.usage) {
            addPlannerUsage(data.usage, data.model || body.model);
          }
          if (tracker) tracker.handlePhase(phaseName, data || {});
        },
        compactMessages: async (messages, ctx) =>
          compactionAgent.maybeCompactMessages(messages, {
            tokenBudget,
            apiConfig: { baseUrl, apiKey, model: body.model },
            model: body.model,
            signal: ctx?.signal,
            toolsChars: ctx?.toolsChars
          }),
        delegateTool: async (name, args) =>
          toolBridge.executeAgentTool(name, args, {
            workspacePath,
            worktreePath: worktreePath || undefined,
            sessionId: payload.sessionId || undefined,
            runId: traceMeta?.subagentId || undefined,
            model: body.model || payload.model,
            taskTier: payload.taskTier || null,
            longHorizon: !!payload.longHorizon
          })
      });
    } finally {
      if (trackedLoopRunId) activeWorkerLoopIds.delete(trackedLoopRunId);
    }
    if (!deferFinalize) {
      if (liveMeta) {
        finalizeLoopTrace(loopResult, liveMeta, liveContent);
      } else if (traceMeta) {
        const entries = mapLoopTraceToUi(loopResult && loopResult.trace, traceMeta);
        if (entries.length) {
          uiTrace.push(...entries);
          pushUiTrace(loopResult.content || '');
        }
      }
    }
    return loopResult;
  }

  function finalizeToolLoopTrace(loopResult, traceMeta, liveContent, liveMeta) {
    if (liveMeta) {
      finalizeLoopTrace(loopResult, liveMeta, liveContent);
      return;
    }
    if (!traceMeta) return;
    const entries = mapLoopTraceToUi(loopResult && loopResult.trace, traceMeta);
    if (entries.length) {
      uiTrace.push(...entries);
      pushUiTrace(loopResult.content || '');
    }
  }

  async function runToolLoopFromSpec(spec, tools, worktreePath, traceMeta) {
    const longHorizon = !!payload.longHorizon;
    let segmentIndex = 0;
    let currentSpec = { ...(spec || {}) };
    let mergedTrace = [];
    let lastLiveContent = '';
    const liveMeta = traceMeta && traceMeta.subagentId ? traceMeta : null;

    while (true) {
      const multiSegment = longHorizon;
      const loopResult = await runToolLoopOnce(currentSpec, tools, worktreePath, traceMeta, {
        deferFinalize: multiSegment
      });
      if (Array.isArray(loopResult.trace) && loopResult.trace.length) {
        mergedTrace = mergedTrace.concat(loopResult.trace);
        loopResult.trace = mergedTrace.slice();
      }
      if (loopResult.content) lastLiveContent = loopResult.content;

      if (!loopResult.hitRoundLimit || !longHorizon) {
        if (multiSegment && mergedTrace.length) {
          loopResult.trace = mergedTrace.slice();
        }
        if (multiSegment) {
          finalizeToolLoopTrace(loopResult, traceMeta, lastLiveContent, liveMeta);
        }
        return loopResult;
      }
      segmentIndex += 1;
      if (segmentIndex >= LONG_HORIZON_MAX_SEGMENTS) {
        if (mergedTrace.length) loopResult.trace = mergedTrace.slice();
        finalizeToolLoopTrace(loopResult, traceMeta, lastLiveContent, liveMeta);
        return loopResult;
      }
      const messages = buildSegmentContinueMessages(
        loopResult.messages || currentSpec.messages,
        loopResult.content
      );
      currentSpec = { ...currentSpec, messages };
    }
  }

  async function runWorkerJob(job, isRetry, opts = {}) {
    const worker = job.worker;
    const parallelRun = !!opts.parallelBatch || !!(job.tasks && job.tasks.length > 1);
    const worktreeRole = opts.worktreeRole || worker;
    let wtPath = null;
    if (agentBridge.worktreeCreate && coordinatorRunId) {
      const wt = await agentBridge.worktreeCreate(coordinatorRunId, worktreeRole);
      wtPath = wt?.ok ? wt.path : null;
    }
    const outputs = [];
    let priorSummary = '';
    let hitRoundLimit = false;
    let partial = null;
    const useCoordinatorTasks = shouldUseCoordinatorTaskQueue(latestPlan, payload, enabledBestOfN);

    for (const task of job.tasks || []) {
      throwIfAborted(signal);
      let taskId = task.id;
      if (useCoordinatorTasks && agentBridge.taskEnqueue && coordinatorRunId) {
        const en = await agentBridge.taskEnqueue(coordinatorRunId, {
          taskId: isRetry ? `${task.id}-retry` : task.id,
          roleId: worker,
          worker,
          title: task.title,
          instruction: isRetry
            ? `${task.instruction}\n\n【重试原因】${job.retryReason || ''}`
            : task.instruction,
          expectedOutput: task.expectedOutput,
          priority: 5,
          deadlineAt: Date.now() + TASK_TIMEOUT_MS,
          timeoutMs: TASK_TIMEOUT_MS,
          maxRetries: 3,
          exceptionPolicy: 'retry',
          worktreePath: wtPath
        });
        if (en?.ok && en.task) taskId = en.task.taskId;
      }
      if (useCoordinatorTasks && agentBridge.taskRunning && coordinatorRunId) {
        await agentBridge.taskRunning(coordinatorRunId, taskId);
      }

      const subagentId = newSubagentId(worker);
      upsertIsolatedTrace(
        subagentId,
        [
          {
            round: 1,
            phase: `执行器 ${worker} · ${task.id}`,
            thought: '准备中…',
            fullThought: '准备中…',
            subagentId,
            isolated: true,
            worker,
            parallel: parallelRun,
            tools: []
          }
        ],
        ''
      );
      const spec = await bridge.invoke(
        'planner.run.worker_loop',
        {
          runId,
          worker,
          taskId: task.id,
          subagentId,
          worktreePath: wtPath || undefined,
          roleMessages: '',
          priorSummary
        },
        15000
      );
      const taskTools = filterTools(allTools, task.agentType || spec.agentType || 'build');
      if (!taskTools.length) {
        throw new Error(`子任务 ${task.id} 无可用工具`);
      }
      let loopResult;
      try {
        loopResult = await runToolLoopFromSpec(spec, taskTools, wtPath, {
          worker,
          taskId: task.id,
          subagentId,
          parallel: parallelRun
        });
      } catch (err) {
        if (useCoordinatorTasks && agentBridge.taskFail && coordinatorRunId) {
          await agentBridge.taskFail(coordinatorRunId, taskId, err.message || String(err), signal?.aborted);
        }
        throw err;
      }
      if (loopResult.hitRoundLimit) {
        hitRoundLimit = true;
        partial = loopResult;
        break;
      }
      const output = String(loopResult.content || '').trim();
      outputs.push({
        id: task.id,
        worker,
        subagentId,
        output,
        error: null
      });
      completedOutputs.push({
        id: task.id,
        worker,
        subagentId,
        output,
        error: null
      });
      await persistPlannerCheckpoint({
        worker,
        lastSubtaskId: task.id,
        lastSubagentId: subagentId
      });
      if (useCoordinatorTasks && agentBridge.taskComplete && coordinatorRunId) {
        await agentBridge.taskComplete(coordinatorRunId, taskId, { output: output.slice(0, 8000) });
      }
      priorSummary += `[${task.id}] ${output.slice(0, 400)}\n`;
    }
    return { outputs, hitRoundLimit, partial, worker };
  }

  async function runWorkerBatch(workerJobs, isRetry) {
    const jobs = workerJobs || [];
    const parallelBatch = jobs.length > 1;
    throwIfAborted(signal);
    const settled = await settleAllAbortable(
      jobs,
      (job) => {
        throwIfAborted(signal);
        return runWorkerJob(job, isRetry, { parallelBatch });
      },
      {
        signal,
        createAbortWaiter,
        createAbortError,
        onAbort: cancelActiveWorkerLoops
      }
    );
    const results = [];
    for (let i = 0; i < settled.length; i += 1) {
      const s = settled[i];
      const job = jobs[i] || {};
      if (s.status === 'fulfilled') {
        results.push(...s.value.outputs);
        if (s.value.hitRoundLimit) {
          return {
            hitRoundLimit: true,
            partial: s.value.partial,
            workerResults: results
          };
        }
        continue;
      }
      const err = s.reason;
      if (err?.name === 'AbortError') throw err;
      const errorText = err?.message || String(err || 'worker failed');
      const tasks = job.tasks || [];
      if (!tasks.length) {
        results.push({
          id: `${job.worker || 'worker'}-failed`,
          worker: job.worker || 'A',
          subagentId: null,
          output: null,
          error: errorText
        });
        continue;
      }
      for (const task of tasks) {
        results.push({
          id: task.id,
          worker: job.worker || task.worker || 'A',
          subagentId: null,
          output: null,
          error: errorText
        });
      }
    }
    return { hitRoundLimit: false, workerResults: results };
  }

  try {
    while (phase && phase.phase !== 'done' && phase.phase !== 'cancelled') {
      if (signal?.aborted) {
        await cancelActiveWorkerLoops();
        await bridge.invoke('planner.run.cancel', { runId }, 10000).catch(() => {});
        if (coordinatorRunId) agentBridge.runCancel(coordinatorRunId, '用户停止');
        throw createAbortError();
      }

      const p = phase.phase;
      onPhase(p, { runId });

      if (p === 'need_plan_llm') {
        const content = await fetchChatCompletion(
          phase.llmBody,
          apiConfig,
          settings,
          signal,
          addPlannerUsage,
          plannerReconnect
        );
        const planContent = clampPlanContentBestOfN(content, enabledBestOfN);
        phase = await bridge.invoke(
          'planner.run.continue',
          { runId, step: 'plan_llm', content: planContent },
          60000
        );
        if (phase?.plan) {
          latestPlan = sanitizePlanBestOfN(phase.plan, enabledBestOfN);
          await persistPlannerCheckpoint();
          pushUiTrace();
        }
      } else if (p === 'need_explore_loop') {
        const skipExplore = !!phase.skipExplore;
        if (skipExplore) {
          phase = await bridge.invoke(
            'planner.run.continue',
            { runId, step: 'explore_loop', content: '' },
            30000
          );
        } else {
          const spec = phase.loopStart || {};
          const loopResult = await runToolLoopFromSpec(spec, exploreTools, null, {
            phase: 'Explore · 只读勘察',
            worker: 'explore',
            subagentId: newSubagentId('explore')
          });
          if (loopResult.hitRoundLimit) {
            phase = await bridge.invoke(
              'planner.run.continue',
              {
                runId,
                step: 'explore_loop',
                content: loopResult.content || '',
                hitRoundLimit: true,
                partialContent: loopResult.content,
                partialBody: loopResult
              },
              30000
            );
          } else {
            phase = await bridge.invoke(
              'planner.run.continue',
              { runId, step: 'explore_loop', content: loopResult.content || '' },
              30000
            );
            latestExploreNotes = loopResult.content || '';
            await persistPlannerCheckpoint();
          }
        }
      } else if (p === 'need_workers' || p === 'need_retry_workers') {
        const batch = await runWorkerBatch(phase.workerJobs, p === 'need_retry_workers');
        let worktreeCtx = null;
        if (agentBridge.worktreePreviewRun && coordinatorRunId) {
          worktreeCtx = await agentBridge.worktreePreviewRun(coordinatorRunId);
        }
        phase = await bridge.invoke(
          'planner.run.continue',
          {
            runId,
            step: 'worker_batch',
            workerResults: batch.workerResults,
            hitRoundLimit: batch.hitRoundLimit,
            partialContent: batch.partial?.content,
            partialBody: batch.partial,
            worktreeCtx: worktreeCtx || {}
          },
          120000
        );
      } else if (p === 'need_best_of_n_attempt') {
        const batch = await runWorkerJob(phase.workerJob, !!phase.isRetry, {
          worktreeRole: phase.worktreeRole || phase.workerJob?.worker
        });
        if (batch.hitRoundLimit) {
          phase = await bridge.invoke(
            'planner.run.continue',
            {
              runId,
              step: 'best_of_n_attempt',
              workerResults: batch.outputs,
              hitRoundLimit: true,
              partialContent: batch.partial?.content,
              partialBody: batch.partial
            },
            120000
          );
        } else {
          phase = await bridge.invoke(
            'planner.run.continue',
            {
              runId,
              step: 'best_of_n_attempt',
              workerResults: batch.outputs
            },
            120000
          );
        }
      } else if (p === 'need_best_of_n_pick_llm') {
        const content = await fetchChatCompletion(
          phase.llmBody,
          apiConfig,
          settings,
          signal,
          addPlannerUsage,
          plannerReconnect
        );
        phase = await bridge.invoke(
          'planner.run.continue',
          { runId, step: 'best_of_n_pick_llm', content },
          60000
        );
      } else if (p === 'need_review_llm') {
        const content = await fetchChatCompletion(
          phase.llmBody,
          apiConfig,
          settings,
          signal,
          addPlannerUsage,
          plannerReconnect
        );
        phase = await bridge.invoke(
          'planner.run.continue',
          { runId, step: 'review_llm', content },
          60000
        );
      } else if (p === 'need_synthesize_llm') {
        const content = await fetchChatCompletion(
          phase.llmBody,
          apiConfig,
          settings,
          signal,
          addPlannerUsage,
          plannerReconnect
        );
        phase = await bridge.invoke(
          'planner.run.continue',
          { runId, step: 'synthesize_llm', content },
          120000
        );
      } else if (p === 'need_arbitration') {
        const decision =
          typeof opts.onArbitration === 'function'
            ? await raceAbortable(
                opts.onArbitration({ runId: coordinatorRunId, pending: phase.pendingArbitration }),
                signal
              )
            : { action: 'retry' };
        phase = await bridge.invoke(
          'planner.run.continue',
          { runId, step: 'arbitration', arbitrationAction: decision?.action || 'fail' },
          30000
        );
      } else {
        throw new Error(`未知 planner phase: ${p}`);
      }

      pushTrace(phase.trace);
    }

    if (!phase || phase.phase !== 'done') {
      throw new Error(phase?.message || 'planner 未正常结束');
    }

    if (coordinatorRunId && agentBridge.checkpointDelete) {
      try {
        await Promise.resolve(agentBridge.checkpointDelete(coordinatorRunId));
      } catch {
        // ignore
      }
    }

    return {
      content: stripToolCallMarkup(phase.content || '') || '(空响应)',
      trace: uiTrace.length ? uiTrace.slice() : (phase.trace || []).map(mapPlannerTraceEntryToUi),
      hitRoundLimit: !!phase.hitRoundLimit,
      tokensUsed: tokenUsage.totalTokens || 0,
      tokenUsage,
      runId: coordinatorRunId,
      plan: phase.plan,
      results: phase.results,
      review: phase.review,
      deferWorktreeCleanup: true
    };
  } catch (err) {
    if (runId && bridge) {
      try {
        await bridge.invoke('planner.run.cancel', { runId }, 10000).catch(() => {});
      } catch {
        // ignore
      }
    }
    if (coordinatorRunId && agentBridge.worktreeCleanupRun && err.name === 'AbortError') {
      try {
        await Promise.resolve(agentBridge.worktreeCleanupRun(coordinatorRunId));
      } catch {
        // ignore
      }
    }
    throw err;
  } finally {
    await cancelActiveWorkerLoops().catch(() => {});
    if (coordinatorRunId && agentBridge.runEnd) {
      try {
        await Promise.resolve(agentBridge.runEnd(coordinatorRunId));
      } catch {
        // ignore
      }
    }
  }
}

module.exports = { runRustPlannerPipeline, createLiveLoopTraceTracker };
