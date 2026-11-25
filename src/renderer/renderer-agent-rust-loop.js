/* global window, fetch, settings, gwState, gatewayCall, showAgentToast, executeAgentTool, formatToolArgsBrief, summarizeToolResult, TRACE_DESKTOP_THOUGHT_CHARS, getEffectiveInputBudget, getContextWindowTokens, getMaxOutputTokens, getContextReserveTokens, resolveComposerModelForSend, getCustomModelApiConfig, captureTurnBatchCheckpoint, isMutatingAgentTool, currentSessionId, noteContextCompaction, noteComposerSessionUsage, resolveComposerUsageSessionId, streamChatCompletion, fetchChatCompletion, upsertSynthesisTraceRound, getCurrentUndoTurnId, getUndoTurnIdForSession, supplierDisplayName, normalizeAgentToolName, compactDiffForTrace, getAgentLimits, trackArtifactsFromTrace, resolveSessionWorkspacePath, isWeakAssistantReply, AgentRoundText, formatModelFooterLabel, humanizeModelId, dismissAgentContinueRows, maybeShowProposeToolPreview, agentApi, STREAM_IDLE_HINT_MS, STREAM_FIRST_TOKEN_HINT_MS, SUBAGENT_TOOL, createProgressFlush, settleAssistantBubbleAfterLoop */
'use strict';

function isDieyunCoreReady() {
  return !!(typeof gwState !== 'undefined' && gwState.rustCore && gwState.rustCore.enabled);
}

/**
 * 「这个客户端能不能跑 Agent」的唯一判据 + 唯一文案。
 *
 * Renderer 里**没有**第二套循环：core 未就绪（`DIEYUN_CORE=0` / sidecar 没打包）时不是
 * 「换一条路跑」，而是明确不可用。所有入口（发送闸门 / 目标续跑 / 继续 / 计划）都问这一个
 * 函数，别在各分支里各写一句 `!isDieyunCoreReady()` 的抛错。
 */
const AGENT_RUNTIME_UNAVAILABLE =
  'Agent 不可用：dieyun-core 未就绪（`npm run pack:dieyun-core` 后重启；若设了 `DIEYUN_CORE=0` 请先取消）。';

function requireAgentRuntime() {
  if (isDieyunCoreReady()) return;
  const err = new Error(AGENT_RUNTIME_UNAVAILABLE);
  err.code = 'CORE_UNAVAILABLE';
  err.userSafe = true;
  throw err;
}

/**
 * 循环模型是否多模态：决定是否把浏览器截图作为 image_url 注入上下文。
 * 仅当所选模型支持识图时开启，避免给文本模型发送图片触发上游 400。
 */
function resolveBrowserVision(model) {
  try {
    const caps = typeof window !== 'undefined' ? window.ModelCapabilities : null;
    if (caps && typeof caps.modelSupportsMultimodalInSettings === 'function') {
      return !!caps.modelSupportsMultimodalInSettings(settings, model);
    }
  } catch {
    /* 能力探测失败时保守关闭 */
  }
  return false;
}

/**
 * 流式进度的合批装配：**唯一实现在** `src/agent/progress-flush.js`
 * （经 agent-bundle 暴露为 `window.createProgressFlush`，Main 直接 require 同一份）。
 *
 * 这里只注入渲染进程的环境差异：贴帧（rAF）+ 数字只认 `agent-limits` 的
 * `agentProgressFlushMs`。planner 与主循环两条流共用这一份 ——
 * 以前两条流各写一套 pending / timer / rAF，数字还是两套（120 / 160）。
 */
function createRendererProgressFlush({ flush, signature }) {
  if (typeof createProgressFlush !== 'function') {
    throw new Error('agent-bundle 未加载：需要 createProgressFlush（agent/progress-flush.js）');
  }
  return createProgressFlush({
    minIntervalMs: getAgentLimits().agentProgressFlushMs,
    flush,
    signature,
    requestFrame: (fn) => window.requestAnimationFrame(fn),
    cancelFrame: (handle) => window.cancelAnimationFrame(handle)
  });
}

/**
 * 结构签名：判断这一份 trace 是「只多了几个字」还是「结构变了（换轮次 / 新工具 /
 * 收尾）」。`renderer-thinking-trace-dom.js` 是唯一实现，缺失时退化成「按轮次数量」——
 * 那只会让合批更保守（更容易判成结构变化 → 走最小间隔），不会丢帧。
 */
function traceStructureSig(trace) {
  return typeof thinkingTraceStructureSig === 'function'
    ? thinkingTraceStructureSig(trace)
    : String((trace || []).length);
}

/**
 * Main 进程 Rust planner pipeline（Explore/Worker 使用 Rust agent loop）。
 */
async function runPlannerPipelineViaMain(params, options = {}) {
  if (!agentApi.agentPlannerRun) {
    throw new Error('Rust planner IPC 不可用');
  }
  const cancelToken = options.cancelToken || `pl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const signal = options.signal;
  const onProgress = options.onProgress;
  // 合批的唯一实现是 `agent/progress-flush.js`（经 agent-bundle 暴露为 ProgressFlush）：
  // planner 与主循环共用同一份，别再各写一套 pending / timer / rAF（数字也只在 agent-limits）。
  const progressFlush = createRendererProgressFlush({
    flush: ({ trace, streamContent, plan }) => {
      if (typeof onProgress !== 'function') return;
      onProgress(trace, streamContent || '', plan || null);
    },
    signature: ({ trace }) => traceStructureSig(trace)
  });
  const scheduleProgress = (trace, streamContent, plan) =>
    progressFlush.push({ trace, streamContent: streamContent || '', plan: plan || null });
  const flushProgress = () => progressFlush.flushNow();
  const unregisterBackendCancel = registerActiveAgentBackendCancel(
    'planner',
    cancelToken,
    () => {
      if (agentApi.agentPlannerCancel) {
        return agentApi.agentPlannerCancel({ cancelToken });
      }
      return null;
    },
    options.sessionId
  );

  const onAbort = () => {
    if (options.sessionId) {
      cancelActiveAgentBackendsForSession(options.sessionId, '用户停止');
    } else {
      cancelActiveAgentBackends('用户停止');
    }
  };
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }

  const offPhase =
    typeof agentApi.onAgentPlannerPhase === 'function'
      ? agentApi.onAgentPlannerPhase((ev) => {
          if (!ev || ev.cancelToken !== cancelToken) return;
          if (ev.phase === 'started' && ev.data) {
            const rid = ev.data.coordinatorRunId || ev.data.runId;
            // 只有**当前可见会话**才去动侧栏：后台会话的 plan 起步不该把用户眼前的
            // 「变更」面板切走（`progress` 分支早就有这个判据，这里以前漏了）。
            const startedSessionId = options.sessionId || params.sessionId || null;
            const startedVisible =
              String(startedSessionId || '') === String(currentSessionId || '');
            if (rid && startedVisible && typeof window.beginPlanWorktreeTracking === 'function') {
              window.beginPlanWorktreeTracking(rid, startedSessionId);
            }
          }
          if (ev.phase === 'progress' && ev.data && ev.data.trace && typeof onProgress === 'function') {
            scheduleProgress(ev.data.trace, ev.data.streamContent || '', ev.data.plan || null);
            const planSessionId = options.sessionId || params.sessionId || null;
            const planVisible = String(planSessionId || '') === String(currentSessionId || '');
            if (planVisible && ev.data.plan && typeof window.syncPlanPreviewFromPlan === 'function') {
              window.syncPlanPreviewFromPlan(ev.data.plan);
            }
            const planTraceDiff =
              typeof window.shouldPlanUseTraceDiffFallback === 'function' &&
              window.shouldPlanUseTraceDiffFallback() &&
              planVisible;
            if (planTraceDiff) {
              if (typeof trackArtifactsFromTrace === 'function') {
                trackArtifactsFromTrace(ev.data.trace, { sessionId: planSessionId });
              }
            }
            if (planVisible && typeof window.schedulePlanWorktreeChangesRefresh === 'function') {
              window.schedulePlanWorktreeChangesRefresh();
            }
          }
        })
      : null;

  try {
    const result = await agentApi.agentPlannerRun({
      cancelToken,
      sessionId: options.sessionId || params.sessionId || undefined,
      ...params
    });
    flushProgress();
    if (typeof onProgress === 'function' && result && result.trace) {
      onProgress(result.trace, result.content || '');
    }
    if (result?.runId && typeof window.beginPlanWorktreeTracking === 'function') {
      window.beginPlanWorktreeTracking(result.runId, options.sessionId || params.sessionId);
    }
    return result;
  } finally {
    flushProgress();
    unregisterBackendCancel();
    if (offPhase) offPhase();
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

/**
 * 把工具结果里的「界面可渲染图片凭证」搬到 trace 条目上。
 *
 * 唯一字段是 `imagePaths`（Main 侧 record-browser-screenshot / absorb-mcp-vision 写入，
 * 见 tool-bridge-main；渲染进程不解析 note 文案里的路径）。base64 一律不搬。
 * 账本 result 超过 toolResultMaxJson 被 tailAwarePreview 顶替时这里拿不到，属预期：
 * 那种情况下界面按「没有图」处理，而不是去猜。
 */
function liftToolImagePaths(tool, result) {
  const list = result && typeof result === 'object' ? result.imagePaths : null;
  if (!Array.isArray(list) || !list.length) return;
  const paths = list.filter((p) => typeof p === 'string' && p.trim()).slice(0, 8);
  if (paths.length) tool.imagePaths = paths;
}

function mapRustAgentTrace(rustTrace, prefixTrace) {
  const out = Array.isArray(prefixTrace) ? prefixTrace.slice() : [];
  if (!Array.isArray(rustTrace)) return out;
  for (const r of rustTrace) {
    const tools = (r.tools || []).map((t) => {
      const args = t.args || t.toolArgs || {};
      const argsBrief =
        typeof formatToolArgsBrief === 'function'
          ? formatToolArgsBrief(t.name, args)
          : JSON.stringify(args).slice(0, 120);
      // pending 只出现在「实时进度」trace（Main 侧边跑边推）；Rust 收尾 trace 不带该字段
      const pending = !!t.pending;
      let summary = '完成';
      if (t.error) summary = `错误: ${t.error}`;
      else if (pending) summary = '';
      else if (typeof summarizeToolResult === 'function') {
        summary = summarizeToolResult(t.name, t.result);
      }
      const failed =
        !pending &&
        (!!t.error ||
          !!(t.result && typeof t.result === 'object' && (t.result.error || t.result.ok === false)));
      const tool = {
        name: t.name,
        argsBrief,
        summary,
        pending,
        failed,
        errorCode: t.result && t.result.errorCode ? t.result.errorCode : undefined,
        toolArgs: args
      };
      liftToolImagePaths(tool, t.result);
      // 账本 result 未超上限时保留完整 diff；超限被 tailAwarePreview 顶替时由
      // mergeTraceEditDiffsFromLive 从实时 trace 回填，保证思考结束后 diff 卡不消失
      if (
        t.result &&
        typeof t.result === 'object' &&
        t.result.diff &&
        typeof t.result.diff === 'object'
      ) {
        const diff =
          typeof compactDiffForTrace === 'function' ? compactDiffForTrace(t.result.diff) : t.result.diff;
        if (diff) tool.diff = diff;
      }
      return tool;
    });
    const row = {
      round: r.round,
      phase: r.phase || '',
      thought: r.thought || '',
      fullThought: r.fullThought || r.thought || '',
      // 占位文案是平台写的，不是模型思考：随行不变地搬结构标记（2026-10-28 整改）
      ...(r.placeholder ? { placeholder: true } : {}),
      subagentId: r.subagentId,
      isolated: r.isolated,
      worker: r.worker,
      parallel: r.parallel,
      tools
    };
    const vis = String(r.visibleContent || '').trim();
    if (vis) row.visibleContent = vis;
    out.push(row);
  }
  return out;
}

function mergeTraceVisibleContent(mapped, liveTrace) {
  if (!Array.isArray(mapped) || !Array.isArray(liveTrace)) return mapped;
  const visByRound = new Map();
  for (const e of liveTrace) {
    const v = String((e && e.visibleContent) || '').trim();
    if (e && e.round != null && v) visByRound.set(e.round, v);
  }
  if (!visByRound.size) return mapped;
  return mapped.map((e) => {
    const v = e && e.round != null ? visByRound.get(e.round) : '';
    if (!v || String((e && e.visibleContent) || '').trim()) return e;
    return { ...e, visibleContent: v };
  });
}

/**
 * Rust 收尾 trace 的工具 result 超过 toolResultMaxJson 时被 tailAwarePreview 顶替，
 * diff 随之丢失；实时 trace（delegate_result 事件）里还留着 compactDiffForTrace 后的正文。
 * 按归一化工具名 + 出现顺序回填，容错两侧轮次数量不一致（实时侧有临时 live 行）。
 */
function mergeTraceEditDiffsFromLive(rows, liveRows) {
  if (!Array.isArray(rows) || !rows.length || !Array.isArray(liveRows) || !liveRows.length) return rows;
  const queueByName = new Map();
  for (const row of liveRows) {
    for (const t of row?.tools || []) {
      if (!t || !t.diff) continue;
      const name =
        typeof normalizeAgentToolName === 'function'
          ? normalizeAgentToolName(t.name, t.toolArgs || t.args || {}).name
          : String(t.name || '');
      if (!queueByName.has(name)) queueByName.set(name, []);
      queueByName.get(name).push(t.diff);
    }
  }
  if (!queueByName.size) return rows;
  let changed = false;
  const out = rows.map((row) => {
    if (!row || !Array.isArray(row.tools) || !row.tools.length) return row;
    let rowChanged = false;
    const tools = row.tools.map((t) => {
      if (!t || t.diff) return t;
      const name =
        typeof normalizeAgentToolName === 'function'
          ? normalizeAgentToolName(t.name, t.toolArgs || {}).name
          : String(t.name || '');
      const queue = queueByName.get(name);
      if (!queue || !queue.length) return t;
      const raw = queue.shift();
      const diff = typeof compactDiffForTrace === 'function' ? compactDiffForTrace(raw) : raw;
      if (!diff) return t;
      rowChanged = true;
      return { ...t, diff };
    });
    if (!rowChanged) return row;
    changed = true;
    return { ...row, tools };
  });
  return changed ? out : rows;
}

function applyCheckpointIdsToTrace(traceRows, checkpointByRound) {
  if (!checkpointByRound || !checkpointByRound.size || !Array.isArray(traceRows)) return traceRows;
  return traceRows.map((entry) => {
    const round = entry && entry.round;
    const cp = round != null ? checkpointByRound.get(round) : null;
    if (!cp) return entry;
    return { ...entry, checkpointId: cp };
  });
}

function seedCheckpointByRound(traceRows, checkpointByRound) {
  if (!checkpointByRound || !Array.isArray(traceRows)) return;
  for (const entry of traceRows) {
    if (entry && entry.checkpointId != null && entry.round != null) {
      checkpointByRound.set(entry.round, entry.checkpointId);
    }
  }
}

function formatLlmWaitLabel(kind, modelId) {
  const prefix = kind === 'vision' ? '多模态识图中' : '请求 LLM';
  const id = String(modelId || '').trim();
  let name = '';
  if (id) {
    if (typeof formatModelFooterLabel === 'function') {
      name = String(formatModelFooterLabel(id) || '').trim();
    } else if (typeof humanizeModelId === 'function') {
      name = String(humanizeModelId(id) || '').trim();
    } else {
      name = id;
    }
  }
  if (!name) return `${prefix}…`;
  return `${prefix} · ${name}…`;
}

/**
 * 「等模型」期间思考区那行备注的**唯一文案来源**。
 *
 * 两段等待，各说各的：
 * - 首字之前（请求已发出、一个 token 都还没回来）：`${notePrefix} Ns`
 *   —— 2026-11-25 用户要求：「已请求模型，等待首字 Ns」。这段等待原本完全看不见：
 *   占位符里的「（已等 Ns）」在 `visibleThoughtDisplay` 里会被替换成「思考中…」。
 * - 首字之后静默 ≥ `idleHintMs`：`上游 Ns 无数据`（原有行为）。
 * - 其它情况返回空串：正常出字时不加噪音。
 *
 * @param {{ streaming?: boolean, waitingMs?: number, idleMs?: number, notePrefix?: string,
 *   firstHintMs?: number, idleHintMs?: number }} input
 * @returns {string} 空串 = 不显示备注
 */
function llmWaitNoteText(input) {
  const i = input || {};
  const prefix = String(i.notePrefix || '已请求模型，等待首字').trim();
  const firstHintMs = Math.max(0, Number(i.firstHintMs) || 0);
  const idleHintMs = Math.max(0, Number(i.idleHintMs) || 0);
  if (!i.streaming) {
    const waitingMs = Math.max(0, Number(i.waitingMs) || 0);
    // 阈值缺失 / 为 0 时宁可不打扰：调用方总会给常量，走到这里说明配置没接上
    if (firstHintMs <= 0 || waitingMs < firstHintMs) return '';
    return `${prefix} ${Math.max(1, Math.round(waitingMs / 1000))}s`;
  }
  const idleMs = Math.max(0, Number(i.idleMs) || 0);
  if (idleHintMs > 0 && idleMs >= idleHintMs) return `上游 ${Math.round(idleMs / 1000)}s 无数据`;
  return '';
}

async function chatCompletionWithToolsViaRust(payload, tools, options = {}) {
  if (!agentApi.agentRustLoopRun) {
    throw new Error('Rust agent loop IPC 不可用');
  }
  let body = options.body ? options.body : { ...payload };
  const useTools = tools && tools.length > 0;
  if (!options.body && useTools) body.tools = tools;
  else if (options.body && useTools && !body.tools) body.tools = tools;

  const trace = options.trace ? options.trace.slice() : [];
  const onProgress = options.onProgress;
  const signal = options.signal;
  const apiConfig = options.apiConfig || getCustomModelApiConfig(body.model);
  const cancelToken = options.cancelToken || `rl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  let runId = options.runId || null;
  let coreRunId = null;
  const unregisterBackendCancel = registerActiveAgentBackendCancel(
    'rust-loop',
    cancelToken,
    () => {
      if (agentApi.agentRustLoopCancel) {
        return agentApi.agentRustLoopCancel({ cancelToken, runId: coreRunId || runId });
      }
      return null;
    },
    options.sessionId
  );
  let displayedTrace = trace.slice();
  let liveContent = '';
  let frozenRounds = [];
  /**
   * 当前轮的开始时刻（轨迹图 `trace-graph.js` 画主线泳道要的唯一时间来源）。
   * 0 = 这一版没记到（老逻辑/老数据）→ 图会退化成等宽顺序图，绝不拿 now 假造时长。
   */
  let roundStartedAt = 0;
  // 主循环并发 subagent 的「过程卡片」：Main 经 agent:subagent-trace 按 subagentId 分桶推送
  // （见 main/ipc/agent-runtime.js）。它们不进 displayedTrace —— 父运行收尾会用 Rust trace
  // 整体覆盖 displayedTrace，所以只在推给 UI 前合并一次。
  const isolatedSubagentTrace = new Map();
  const SUBAGENT_TOOL_NAME =
    typeof SUBAGENT_TOOL !== 'undefined' && SUBAGENT_TOOL && SUBAGENT_TOOL.function
      ? SUBAGENT_TOOL.function.name
      : 'subagent';
  const mergeIsolatedSubagentTrace = (traceRows) => {
    if (!isolatedSubagentTrace.size) return traceRows;
    const base = Array.isArray(traceRows) ? traceRows : [];
    const cards = [];
    for (const entries of isolatedSubagentTrace.values()) {
      if (Array.isArray(entries) && entries.length) cards.push(...entries);
    }
    if (!cards.length) return base;
    // 卡片紧跟「派发 subagent 的那一轮」之后：父循环后续再追加轮次也不会打乱时序。
    let anchor = -1;
    for (let i = base.length - 1; i >= 0; i -= 1) {
      const toolRows = base[i] && base[i].tools;
      if (Array.isArray(toolRows) && toolRows.some((t) => t && t.name === SUBAGENT_TOOL_NAME)) {
        anchor = i;
        break;
      }
    }
    const out = base.slice();
    out.splice(anchor >= 0 ? anchor + 1 : out.length, 0, ...cards);
    return out;
  };
  const checkpointByRound = new Map();
  let rustLoopFailedCheckpoint = null;
  let tokenUsage = options.tokenUsage
    ? addUsageStats(emptyUsageStats(), options.tokenUsage)
    : emptyUsageStats();

  const cloneTraceSnapshot = (traceRows) =>
    traceRows.map((r) => ({ ...r, tools: (r.tools || []).map((t) => ({ ...t })) }));

  /**
   * 合批的唯一实现（`createRendererProgressFlush` → `agent/progress-flush.js`）。
   * 主循环与 planner 两条流共用同一份状态机，间隔只认 `agent-limits.agentProgressFlushMs`。
   */
  const rustProgressFlush = createRendererProgressFlush({
    flush: ({ traceRows, streamContent }) => {
      if (typeof onProgress !== 'function') return;
      onProgress(cloneTraceSnapshot(traceRows), streamContent || '');
    },
    signature: ({ traceRows }) => traceStructureSig(traceRows)
  });

  const flushRustProgress = () => rustProgressFlush.flushNow();

  const notifyRustProgress = (traceRows, streamContent, { immediate = false } = {}) => {
    if (typeof onProgress !== 'function') return traceRows;
    // 推给 UI 前合并子 Agent 过程卡片；返回值仍是未合并的 traceRows，
    // 否则卡片会被写回 displayedTrace 并在后续每帧重复追加。
    const emitRows = mergeIsolatedSubagentTrace(traceRows);
    rustProgressFlush.push({ traceRows: emitRows, streamContent: streamContent || '' });
    if (immediate) rustProgressFlush.flushNow();
    return traceRows;
  };

  const mapDelegateTools = (delegates) =>
    (delegates || []).map((d) => {
      const rawName = String(d.name || 'tool').trim();
      const rawArgs = d.arguments && typeof d.arguments === 'object' ? d.arguments : {};
      const norm =
        typeof normalizeAgentToolName === 'function'
          ? normalizeAgentToolName(rawName, rawArgs)
          : { name: rawName, args: rawArgs };
      return {
        id: d.id || '',
        name: norm.name,
        argsBrief:
          typeof formatToolArgsBrief === 'function'
            ? formatToolArgsBrief(norm.name, norm.args)
            : JSON.stringify(norm.args || {}).slice(0, 120),
        toolArgs: norm.args,
        summary: '',
        pending: true,
        failed: false
      };
    });

  const normalizeDelegateEvent = (evData) => {
    if (!evData) return { name: '', args: {} };
    const rawName = String(evData.name || '').trim();
    const rawArgs = evData.arguments && typeof evData.arguments === 'object' ? evData.arguments : {};
    if (typeof normalizeAgentToolName !== 'function') {
      return { name: rawName, args: rawArgs };
    }
    const norm = normalizeAgentToolName(rawName, rawArgs);
    return { name: norm.name, args: norm.args };
  };

  let rustBootSteps =
    typeof createInitialRustLoopBootSteps === 'function' ? createInitialRustLoopBootSteps() : null;
  let rustBootVisible = !!rustBootSteps;
  let llmWaitTimer = null;
  let llmWaitStartedAt = 0;
  /** 本轮是否已出字（首包到达）：出字前显示「等待首字」，出字后改为静默监控 */
  let llmStreaming = false;
  /** 最近一次收到 delta 的时刻 */
  let llmLastDeltaAt = 0;

  /** 思考轮次上的等待备注（如「上游 42s 无数据」）：叠加一行，不覆盖模型正文 */
  const setLiveNote = (note) => {
    const text = String(note || '').trim();
    if (!displayedTrace.length) return;
    const idx = displayedTrace.length - 1;
    const live = displayedTrace[idx];
    if (String(live.liveNote || '') === text) return;
    displayedTrace = displayedTrace.slice();
    displayedTrace[idx] = { ...live, liveNote: text };
    notifyRustProgress(displayedTrace, liveContent);
  };

  const clearLlmWaitTimer = () => {
    if (llmWaitTimer) {
      clearInterval(llmWaitTimer);
      llmWaitTimer = null;
    }
    llmWaitStartedAt = 0;
    llmStreaming = false;
    llmLastDeltaAt = 0;
    setLiveNote('');
  };

  /**
   * 「等模型」期间思考区那行备注的唯一来源（`llmWaitNoteText`）。
   *
   * 为什么不再每秒重推占位符：占位符文本在 `visibleThoughtDisplay` 里会被换成「思考中…」，
   * 写进去用户也看不见，而且每次重推都会重建 live 槽位、把备注一起冲掉。
   */
  const startLlmWaitTimer = (notePrefix) => {
    clearLlmWaitTimer();
    llmWaitStartedAt = Date.now();
    llmWaitTimer = setInterval(() => {
      if (!llmWaitStartedAt) return;
      setLiveNote(
        llmWaitNoteText({
          streaming: llmStreaming,
          waitingMs: Date.now() - llmWaitStartedAt,
          idleMs: llmLastDeltaAt ? Date.now() - llmLastDeltaAt : 0,
          notePrefix,
          firstHintMs: STREAM_FIRST_TOKEN_HINT_MS,
          idleHintMs: STREAM_IDLE_HINT_MS
        })
      );
    }, 1000);
  };

  const stripBootStepsFromEntry = (entry) => {
    if (!entry || !entry.bootSteps) return entry;
    const next = { ...entry };
    delete next.bootSteps;
    return next;
  };

  const finishRustBootDisplay = ({ immediate = false } = {}) => {
    if (!rustBootVisible && !rustBootSteps) return;
    rustBootVisible = false;
    rustBootSteps = null;
    for (let i = 0; i < frozenRounds.length; i++) {
      frozenRounds[i] = stripBootStepsFromEntry(frozenRounds[i]);
    }
    displayedTrace = displayedTrace.map(stripBootStepsFromEntry);
    notifyRustProgress(displayedTrace, liveContent, { immediate });
  };

  const syncBootStepsToLiveTrace = ({ immediate = false } = {}) => {
    if (!rustBootVisible || !rustBootSteps || !displayedTrace.length) return;
    const liveIdx = displayedTrace.length - 1;
    const live = displayedTrace[liveIdx];
    if (!live || live.phase === 'prep') return;
    displayedTrace = displayedTrace.slice();
    displayedTrace[liveIdx] = {
      ...live,
      bootSteps:
        typeof cloneRustBootSteps === 'function'
          ? cloneRustBootSteps(rustBootSteps)
          : rustBootSteps.map((s) => ({ ...s }))
    };
    notifyRustProgress(displayedTrace, liveContent, { immediate });
  };

  const patchRustBootSteps = (mutator, { immediate = true } = {}) => {
    if (!rustBootVisible || !rustBootSteps || typeof mutator !== 'function') return;
    const next = mutator(rustBootSteps);
    if (next) rustBootSteps = next;
    syncBootStepsToLiveTrace({ immediate });
  };

  /**
   * `placeholder`（第 5 个参数）表示这一行是**平台占位文案**（「请求 LLM…」「生成中…」），
   * 不是模型思考。它是结构标记：账本 `reasoning` 提取、思考区渲染都按标记过滤，
   * 不再靠中文词表去猜哪句「像占位」。
   */
  const pushLive = (thoughtPreview, toolsRows, fullThoughtText, extra = {}, placeholder = false) => {
    const rawFull = fullThoughtText != null ? String(fullThoughtText) : String(thoughtPreview || '');
    const full = rawFull;
    const preview = full.slice(0, TRACE_DESKTOP_THOUGHT_CHARS);
    const entry = {
      round: trace.length + frozenRounds.length + 1,
      thought: preview,
      fullThought: full,
      tools: toolsRows || [],
      ...(placeholder ? { placeholder: true } : {}),
      ...(roundStartedAt ? { startedAt: roundStartedAt } : {}),
      ...(extra || {})
    };
    if (rustBootVisible && rustBootSteps && !entry.bootSteps) {
      entry.bootSteps =
        typeof cloneRustBootSteps === 'function'
          ? cloneRustBootSteps(rustBootSteps)
          : rustBootSteps.map((s) => ({ ...s }));
    }
    displayedTrace = [...trace, ...frozenRounds, entry];
    notifyRustProgress(displayedTrace, liveContent);
  };

  /** 平台占位文案的唯一写法：等价 `pushLive(..., { placeholder: true })`。 */
  const pushPlaceholder = (text, toolsRows, fullThoughtText) =>
    pushLive(text, toolsRows, fullThoughtText, {}, true);

  /** 给当前轮打「确认不再调工具」标记：思考区折叠的唯一信号来源 */
  const markAnswerPhaseRound = (traceRows) => {
    const rows = Array.isArray(traceRows) ? traceRows : [];
    if (!rows.length) return rows;
    const idx = rows.length - 1;
    const last = rows[idx];
    if (!last || last.answerPhase) return rows;
    const next = rows.slice();
    next[idx] = { ...last, answerPhase: true };
    return next;
  };

  const freezeLiveWithTools = (toolsRows) => {
    const live = displayedTrace.length ? displayedTrace[displayedTrace.length - 1] : null;
    if (!live) return;
    frozenRounds.push({
      ...live,
      tools: toolsRows || live.tools || [],
      thought: live.thought || live.fullThought || '',
      fullThought: live.fullThought || live.thought || '',
      // 轮次在这一刻收尾：轨迹图靠它画块右边界（已有就别覆盖，多工具轮不重置）
      ...(live.endedAt ? {} : { endedAt: Date.now() })
    });
    pushPlaceholder('…', []);
  };

  const liveThoughtLooksEphemeral = () => {
    const live = displayedTrace.length ? displayedTrace[displayedTrace.length - 1] : null;
    return !!(live && live.placeholder);
  };

  const offSubagentTrace = (() => {
    if (typeof agentApi.onAgentSubagentTrace !== 'function') return null;
    try {
      return agentApi.onAgentSubagentTrace((ev) => {
        if (!ev || ev.cancelToken !== cancelToken) return;
        const subagentId = String(ev.subagentId || '');
        if (!subagentId || !Array.isArray(ev.entries) || !ev.entries.length) return;
        // 一个子 Agent = 一张卡片条目（entries 通常只有 1 个）；带上 done 标记驱动「运行中/已完成」。
        isolatedSubagentTrace.set(
          subagentId,
          ev.entries.map((e) => ({ ...e, runDone: !!ev.done }))
        );
        notifyRustProgress(displayedTrace, liveContent);
      });
    } catch {
      return null;
    }
  })();

  const offPhase =
    typeof agentApi.onAgentRustLoopPhase === 'function'
      ? agentApi.onAgentRustLoopPhase((ev) => {
          if (!ev || ev.cancelToken !== cancelToken) return;
          if (ev.data && ev.data.runId) coreRunId = ev.data.runId;
          if (ev.phase === 'start') {
            patchRustBootSteps((steps) => {
              rustBootStepDone(steps, 'ipc_start');
              rustBootStepDone(steps, 'loop_init');
              return steps;
            });
          } else if (ev.phase === 'llm_request') {
            patchRustBootSteps((steps) => {
              const compact = steps.find((s) => s.id === 'compact_loop');
              if (compact && (compact.status === 'pending' || compact.status === 'active')) {
                const detail =
                  compact.status === 'active' && compact.detail
                    ? String(compact.detail).slice(0, 120)
                    : '无需压缩';
                rustBootStepSkip(steps, 'compact_loop', detail);
              }
              rustBootStepDone(steps, 'loop_init');
              rustBootStepStart(steps, 'llm_handoff');
              rustBootStepDone(steps, 'llm_handoff');
              return steps;
            });
            finishRustBootDisplay({ immediate: true });
            const modelId = (ev.data && ev.data.model) || body.model || '';
            const phaseLabel = formatLlmWaitLabel(options.hasImages ? 'vision' : 'text', modelId);
            // 新一轮开始：轨迹图按这个时刻画主线这一块的左边界
            roundStartedAt = Date.now();
            pushPlaceholder(phaseLabel, []);
            startLlmWaitTimer('已请求模型，等待首字');
          } else if (ev.phase === 'llm_delta') {
            // 不结束心跳：出字后从「请求 LLM（已等 Ns）」切到「静默时长」监控，
            // 上游断流时才会出现「上游 Ns 无数据」，不再回落成无信息的占位符
            llmStreaming = true;
            llmLastDeltaAt = Date.now();
            finishRustBootDisplay();
            const reasoning = String((ev.data && ev.data.reasoning) || '');
            const rawContent = String((ev.data && ev.data.content) || '');
            const content = stripVisibleToolCallMarkup(rawContent);
            const hasToolCalls = !!(ev.data && ev.data.hasToolCalls);
            // content 的通道身份由入口盖章（llm-channel.classifyDelta），此处不再用 `a || b` 猜。
            const contentIsReasoning = (ev.data && ev.data.contentChannel) === 'reasoning';
            if (reasoning) {
              // 双通道：reasoning → 思考；有 tool 时 content 挂轮次旁白，无 tool 时才进回答尾
              const extra = hasToolCalls && content ? { visibleContent: content } : {};
              pushLive(reasoning, [], reasoning, extra);
              liveContent = hasToolCalls || contentIsReasoning ? '' : content;
            } else if (contentIsReasoning && content) {
              // 单通道（能力表声明，如 mimo）：流式 content 是推理，不应泄漏到正文区
              pushLive(content, [], content);
              liveContent = '';
            } else if (content) {
              // 普通模型：content 是正文，进回答区；思考区不镜像正文
              liveContent = content;
              pushPlaceholder('生成中…', []);
            } else {
              pushPlaceholder('生成中…', []);
            }
          } else if (ev.phase === 'llm_response') {
            clearLlmWaitTimer();
            // 这一轮（模型输出）到此收尾：给当前那条实时行打右边界，轨迹图据此画块。
            // 工具轮会再冻结成 frozenRounds（那里已有 endedAt 就不覆盖）。
            {
              const liveRow = displayedTrace.length ? displayedTrace[displayedTrace.length - 1] : null;
              if (liveRow && !liveRow.endedAt) {
                displayedTrace = [
                  ...displayedTrace.slice(0, -1),
                  { ...liveRow, endedAt: Date.now() }
                ];
              }
              roundStartedAt = 0;
            }
            if (ev.data?.usage) {
              const usageChunk = extractUsageStats(ev.data.usage, ev.data.model || body.model);
              tokenUsage = addUsageStats(tokenUsage, usageChunk);
              if (typeof noteComposerSessionUsage === 'function' && options.sessionId) {
                noteComposerSessionUsage(options.sessionId, usageChunk);
              }
            }
            const toolCalls = Number(ev.data && ev.data.toolCalls);
            if (Number.isFinite(toolCalls) && toolCalls > 0) {
              const leftover = stripVisibleToolCallMarkup(
                String((ev.data && ev.data.content) || liveContent || '')
              ).trim();
              const live = displayedTrace.length ? displayedTrace[displayedTrace.length - 1] : null;
              if (live && leftover) live.visibleContent = leftover;
              liveContent = '';
              notifyRustProgress(displayedTrace, liveContent, { immediate: true });
            } else if (Number.isFinite(toolCalls) && toolCalls === 0) {
              // 本轮不再调工具：正文会落到回答区，思考区据此折叠
              displayedTrace = markAnswerPhaseRound(displayedTrace);
              notifyRustProgress(displayedTrace, liveContent, { immediate: true });
            } else if (ev.data && ev.data.persistRound) {
              notifyRustProgress(displayedTrace, liveContent, { immediate: true });
            }
          } else if (ev.phase === 'synthesis_start') {
            displayedTrace = upsertSynthesisTraceRound(displayedTrace, { streaming: true });
            notifyRustProgress(displayedTrace, liveContent, { immediate: true });
          } else if (ev.phase === 'synthesis_delta') {
            liveContent = String((ev.data && ev.data.content) || liveContent);
            notifyRustProgress(displayedTrace, liveContent);
          } else if (ev.phase === 'synthesis_done') {
            displayedTrace = upsertSynthesisTraceRound(displayedTrace, {
              streaming: false,
              failed: !!(ev.data && ev.data.failed)
            });
            if (ev.data && ev.data.content) liveContent = String(ev.data.content);
            notifyRustProgress(displayedTrace, liveContent, { immediate: true });
          } else if (ev.phase === 'turn_overflow_stopped') {
            notifyRustProgress(displayedTrace, liveContent, { immediate: true });
            // 归因只转述上游原文（`llmError` 由 rust-loop-runner.stopForOverflow 带出）：
            // 本地不分类、不给建议 —— 「请求体过长（图太大）」与「token 溢出」的处置方向相反
            // （前者压缩压不掉：图 pin 在当前任务消息里；后者压缩有效），本地写死一句建议
            // 必然对其中一类是错的，而用户拿不到可判断的原始事实。
            // 展示长度由 showAgentToast 统一截断（240 字符），此处不再做二次加工。
            const overflowLlmError = String((ev.data && ev.data.llmError) || '').trim();
            showAgentToast('本轮已停止', overflowLlmError || '上游未返回错误详情', {
              variant: 'warn'
            });
          } else if (ev.phase === 'compacted') {
            const compactCr = {
              tokensBefore: ev.data && ev.data.tokensBefore,
              tokensAfter: ev.data && ev.data.tokensAfter
            };
            if (typeof noteContextCompaction === 'function' && options.sessionId) {
              noteContextCompaction(compactCr, options.sessionId);
            }
            const before = Number(compactCr.tokensBefore);
            const after = Number(compactCr.tokensAfter);
            const compactDetail =
              Number.isFinite(before) && Number.isFinite(after)
                ? `${Math.round(before).toLocaleString()} → ${Math.round(after).toLocaleString()} tokens`
                : '';
            patchRustBootSteps((steps) => {
              rustBootStepStart(steps, 'compact_loop');
              rustBootStepDone(steps, 'compact_loop', compactDetail || undefined);
              return steps;
            });
            const detail =
              Number.isFinite(before) && Number.isFinite(after)
                ? `messages 约 ${Math.round(before).toLocaleString()} → ${Math.round(after).toLocaleString()} tokens；工具定义另计，圆环仍可能偏红`
                : '较早对话已摘要归档，可继续当前任务';
            showAgentToast('上下文已压缩', detail, { variant: 'info' });
          } else if (ev.phase === 'compact_skipped') {
            const skipReason = String((ev.data && ev.data.reason) || '');
            const skipDetail =
              skipReason === 'content_policy'
                ? '内容审核拦截'
                : typeof shortenCompactionLlmMessage === 'function'
                  ? shortenCompactionLlmMessage(ev.data && ev.data.llmError)
                  : '模型超时或失败';
            patchRustBootSteps((steps) => {
              rustBootStepStart(steps, 'compact_loop');
              rustBootStepSkip(steps, 'compact_loop', skipDetail || '已跳过');
              return steps;
            });
            showAgentToast(
              skipReason === 'content_policy' ? '上下文压缩被供应商拦截' : '上下文压缩已跳过',
              skipReason === 'content_policy'
                ? '内容审核未通过，已跳过压缩继续请求。建议新开对话或缩短历史。'
                : '摘要模型超时或失败，本轮继续用原对话。可新开对话或缩短历史后再试。',
              { variant: 'warn' }
            );
          } else if (ev.phase === 'delegate_start') {
            const toolsRows = mapDelegateTools(ev.data && ev.data.delegates);
            freezeLiveWithTools(toolsRows);
            const fr = frozenRounds[frozenRounds.length - 1];
            const runSessionId = options.sessionId || null;
            const undoTurnId =
              options.undoTurnId ||
              (runSessionId && typeof getUndoTurnIdForSession === 'function'
                ? getUndoTurnIdForSession(runSessionId)
                : null);
            const hasMutatingBatch =
              fr &&
              (fr.tools || []).some((t) =>
                typeof isMutatingAgentTool === 'function' ? isMutatingAgentTool(t.name) : false
              );
            if (fr && undoTurnId && hasMutatingBatch && typeof captureTurnBatchCheckpoint === 'function') {
              void captureTurnBatchCheckpoint({
                sessionId: runSessionId,
                turnId: undoTurnId,
                round: fr.round,
                tools: fr.tools,
                runWorkspaceRoot: options.runWorkspaceRoot
              })
                .then((r) => {
                  if (r && r.ok && r.batchId) {
                    fr.checkpointId = r.batchId;
                    if (fr.round != null) checkpointByRound.set(fr.round, r.batchId);
                    notifyRustProgress(displayedTrace, liveContent, { immediate: true });
                  }
                })
                .catch(() => {});
            }
          } else if (ev.phase === 'delegate_result') {
            const fr = frozenRounds[frozenRounds.length - 1];
            const normEv = normalizeDelegateEvent(ev.data);
            if (fr && fr.tools) {
              const tool =
                fr.tools.find((t) => t.id && t.id === ev.data.id) ||
                fr.tools.find((t) => t.pending && t.name === normEv.name);
              if (tool) {
                tool.pending = false;
                tool.toolArgs = normEv.args || tool.toolArgs || {};
                const result = ev.data.result || {};
                const failed = !!(ev.data.error || result.error || result.ok === false);
                tool.failed = failed;
                if (ev.data.error) {
                  tool.summary = `错误: ${ev.data.error}`;
                  tool.errorCode = 'EXCEPTION';
                } else if (typeof summarizeToolResult === 'function') {
                  tool.summary = summarizeToolResult(normEv.name, {
                    stdout: result.stdout,
                    stderr: result.stderr,
                    code: result.code,
                    ...result
                  });
                } else {
                  tool.summary = failed ? `错误: ${result.error || '失败'}` : '完成';
                }
                if (result.errorCode) tool.errorCode = result.errorCode;
                if (result.suggestedFix) tool.suggestedFix = result.suggestedFix;
                liftToolImagePaths(tool, result);
                if (
                  (normEv.name === 'fs_write_file' || normEv.name === 'fs_edit') &&
                  result.diff &&
                  typeof compactDiffForTrace === 'function'
                ) {
                  tool.diff = compactDiffForTrace(result.diff);
                }
                if (!failed && typeof maybeShowProposeToolPreview === 'function') {
                  maybeShowProposeToolPreview(normEv.name, result);
                }
              }
            }
            const live = displayedTrace[displayedTrace.length - 1];
            pushLive(
              live?.thought || '…',
              fr?.tools || live?.tools || [],
              live?.fullThought || live?.thought || '',
              {},
              !!(live && live.placeholder)
            );
          } else if (ev.phase === 'llm_reconnect_wait') {
            const waitData = ev.data || {};
            const sec = Math.max(1, Math.round((waitData.waitMs || 0) / 1000));
            const remainMin = waitData.remainingMs > 0 ? Math.ceil(waitData.remainingMs / 60000) : 0;
            const budgetNote = remainMin > 0 ? `，最长再等 ${remainMin} 分钟` : '';
            // 不冻结当前轮：中断的那次尝试是「正在被重新生成」的东西，不属于历史。
            // 这里只把 live 槽位换成等待提示（带 placeholder 标记），重试的 delta 自然接管
            // 同一槽位；彻底失败时 Main 用 frozenPartial 以 llm_response 交回残片，信息不丢。
            const waitLabel = `连接中断，等待第 ${waitData.attempt || 1} 次自动重试${budgetNote}`;
            pushPlaceholder(waitLabel, [], '等待模型连接恢复，恢复后将从当前进度继续…');
            startLlmWaitTimer('等待模型连接恢复，已等');
            maybeShowLlmReconnectToast(
              '模型连接中断',
              `${sec}s 后自动重试${budgetNote}，无需手动点「继续」`,
              { force: (waitData.attempt || 1) === 1 }
            );
          } else if (ev.phase === 'done') {
            // 循环账本已经收尾（`done` 由 core 在返回前发出）：**先把气泡收成「已完成」**。
            // 为什么不能等 IPC 返回：Main 在 `return result` 之前还要 `await attachTurnFacts`
            // （完成验收证据 + 独立 Reviewer + 目标判定），改过文件的轮次光 LSP 诊断就能到秒级，
            // Reviewer 开着时还多一次完整 LLM 往返 —— 这段时间气泡一直显示「生成中…」，
            // 用户看起来就是「模型说完了但卡住了」。
            // 这里只做**展示**收口：不写库、不动 `live.finished`（终态与验收 note 仍由
            // `completeAgentRunAfterSuccess` 在 IPC 返回后统一落库）。
            const doneData = ev.data || {};
            const doneContent = String(doneData.content || liveContent || '');
            liveContent = doneContent;
            clearLlmWaitTimer();
            notifyRustProgress(displayedTrace, liveContent, { immediate: true });
            const settleSessionId = options.sessionId || doneData.sessionId || null;
            if (settleSessionId && typeof settleAssistantBubbleAfterLoop === 'function') {
              // trace 用**当前这份**：紧随其后的账本映射（`runRustSegment` 返回后那几行）
              // 还会把它换成合并过 live 内容/差异的版本，这里不抢那一份的活。
              try {
                settleAssistantBubbleAfterLoop(settleSessionId, null, {
                  content: doneContent,
                  trace: displayedTrace,
                  hitRoundLimit: !!doneData.hitRoundLimit
                });
              } catch {
                // 气泡收口失败不该让后面的 phases 处理跟着断（终态仍由完整收尾路径兜住）
              }
            }
          } else if (ev.phase === 'loop_failed' && ev.data?.checkpoint) {
            rustLoopFailedCheckpoint = ev.data.checkpoint;
          }
        })
      : null;

  const onAbort = () => {
    if (options.sessionId) {
      cancelActiveAgentBackendsForSession(options.sessionId, '用户停止');
    } else {
      cancelActiveAgentBackends('用户停止');
    }
  };
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }

  try {
    if (signal?.aborted) {
      const err = new Error('已停止');
      err.name = 'AbortError';
      err.trace = displayedTrace;
      throw err;
    }

    pushPlaceholder('启动 Rust agent loop…', []);
    patchRustBootSteps((steps) => {
      rustBootStepStart(steps, 'compact_preflight');
      return steps;
    });
    const preflightResult = await applyContextCompaction(body, {
      signal,
      apiConfig,
      sessionId: options.sessionId || undefined
    });
    if (signal?.aborted) {
      throw toUserAbortError(new Error('已停止'), { trace: displayedTrace });
    }
    patchRustBootSteps((steps) => {
      if (preflightResult && preflightResult.compacted) {
        rustBootStepDone(steps, 'compact_preflight', '已压缩');
      } else if (preflightResult && preflightResult.skipped === 'llm_error') {
        rustBootStepSkip(
          steps,
          'compact_preflight',
          shortenCompactionLlmMessage(preflightResult.llmError)
        );
      } else if (preflightResult && preflightResult.skipped === 'content_policy') {
        rustBootStepSkip(steps, 'compact_preflight', '内容审核拦截');
      } else {
        rustBootStepSkip(steps, 'compact_preflight', '未触发');
      }
      rustBootStepStart(steps, 'ipc_start');
      return steps;
    });
    const runRustSegment = (segmentBody) => {
      patchRustBootSteps((steps) => {
        rustBootStepStart(steps, 'loop_init');
        return steps;
      });
      return agentApi.agentRustLoopRun({
        cancelToken,
        runWorkspaceRoot: options.runWorkspaceRoot || undefined,
        browserVision: resolveBrowserVision(segmentBody.model),
        startParams: {
          model: segmentBody.model,
          messages: sanitizeMessagesForChatApi(
            segmentBody.messages,
            (segmentBody.tools || tools || []).length > 0,
            segmentBody.model
          ),
          tools: segmentBody.tools || tools || [],
          maxToolCalls: getAgentToolCallLimit(),
          maxRounds: getAgentMaxRounds(),
          taskTier: options.taskTier || undefined
        },
        apiConfig,
        modelRoute: options.modelRoute || undefined,
        sessionId: options.sessionId || undefined,
        model: segmentBody.model,
        taskTier: options.taskTier || undefined,
        contextTierId:
          typeof resolveContextTierId === 'function'
            ? resolveContextTierId({ sessionId: options.sessionId })
            : undefined,
        // 请求快照用：Renderer 拼 prompt 时算出的折叠/裁剪事实（Main 无法重算）。
        contextAudit: options.contextAudit || null,
        undoTurnId:
          options.undoTurnId ||
          (typeof getUndoTurnIdForSession === 'function' && options.sessionId
            ? getUndoTurnIdForSession(options.sessionId)
            : null),
        turnEndSynthesis: true
      });
    };

    let done = null;
    let mapped = trace.slice();
    let resultTrace = mapped;
    let finalContent = '';
    let hitRoundLimit = false;
    let loopMessages = body.messages;
    let tracePrefix = trace.slice();

    while (true) {
      if (signal?.aborted) {
        throw toUserAbortError(new Error('已停止'), { trace: displayedTrace });
      }
      done = await runRustSegment(body);
      if (signal?.aborted) {
        throw toUserAbortError(new Error('已停止'), { trace: displayedTrace });
      }
      if (done && done.overflowStopped) {
        finalContent =
          stripVisibleToolCallMarkup(done.content || liveContent || '') ||
          '上下文仍超限，本轮已停止。思考已保留，可缩短历史后再试。';
        resultTrace = displayedTrace;
        notifyRustProgress(displayedTrace, finalContent, { immediate: true });
        break;
      }
      finalContent = stripVisibleToolCallMarkup(done.content || '');
      mapped = mapRustAgentTrace(done.trace, tracePrefix);
      mapped = mergeTraceVisibleContent(mapped, displayedTrace);
      // 账本 result 被截断顶替的工具，diff 从实时 trace 回填（slice 掉前段前缀，避免串段）
      mapped = mergeTraceEditDiffsFromLive(mapped, displayedTrace.slice(trace.length));
      seedCheckpointByRound(mapped, checkpointByRound);
      mapped = applyCheckpointIdsToTrace(mapped, checkpointByRound);
      resultTrace = mapped;
      displayedTrace = notifyRustProgress(mapped, finalContent, { immediate: true });
      hitRoundLimit = !!done.hitRoundLimit;
      loopMessages = Array.isArray(done.messages) && done.messages.length ? done.messages : body.messages;
      break;
    }

    liveContent = finalContent;

    let toolCallsUsed = 0;
    for (const r of resultTrace || []) {
      toolCallsUsed += Array.isArray(r.tools) ? r.tools.length : 0;
    }

    // 续段起点的压缩不在此处做：续段入口（本函数开头的 preflight）会用同一 Rust 判据对
    // 重投影后的 messages 再判一次。此处压缩的产物会被 reprojectContinueFromBody 重建掉，
    // 只会把 compaction 冷却推高、让续段那次预检空转（与 2.4 的重复预检同根因）。
    const outBody = hitRoundLimit
      ? { ...body, messages: buildSegmentContinueMessages(loopMessages, finalContent) }
      : body;

    // 以 IPC 结果为底、只覆盖渲染端加工过的字段：Main 挂在 result 上的结论字段
    // （goal / readiness …）必须原样透传给下游。逐字段重建会让下游读到 undefined，
    // 静默走「没有目标 / 没有验收结论」的分支 —— 会话目标自动续跑就是这么失效的。
    return {
      ...(done && typeof done === 'object' ? done : null),
      runId: runId || coreRunId || null,
      content: finalContent || '(空响应)',
      trace: resultTrace,
      hitRoundLimit,
      toolCallsUsed,
      toolFingerprintHistory: options.toolFingerprintHistory || [],
      body: outBody,
      messages: loopMessages,
      tools,
      tokensUsed: options.tokensUsed || tokenUsage.totalTokens || 0,
      tokenUsage
    };
  } catch (err) {
    flushRustProgress();
    if (!err.trace || !err.trace.length) {
      err.trace = displayedTrace.slice();
    }
    if (isUserAbortError(err)) {
      throw toUserAbortError(err, { trace: displayedTrace });
    }
    const checkpoint = rustLoopFailedCheckpoint;
    if (
      (isTransientFetchError(err) || err.code === 'LLM_RECONNECT_EXHAUSTED') &&
      displayedTrace.length > 0
    ) {
      const checkpointBody = checkpoint
        ? {
            ...body,
            model: checkpoint.model || body.model,
            messages: checkpoint.messages || body.messages,
            tools: checkpoint.tools || body.tools || tools
          }
        : body;
      err.partialResult = {
        content: liveContent || '',
        trace: displayedTrace,
        body: checkpointBody,
        toolFingerprintHistory: options.toolFingerprintHistory || [],
        tokensUsed: options.tokensUsed || tokenUsage.totalTokens || 0,
        tokenUsage,
        runId: runId || coreRunId || checkpoint?.runId || null
      };
      err.networkDisconnect = true;
    }
    throw err;
  } finally {
    clearLlmWaitTimer();
    flushRustProgress();
    rustLoopFailedCheckpoint = null;
    unregisterBackendCancel();
    if (offPhase) offPhase();
    if (offSubagentTrace) offSubagentTrace();
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}
