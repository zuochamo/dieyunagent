'use strict';

const { chatCompletionJson } = require('../llm-proxy');
const {
  runWithLlmReconnectRetry,
  raceAbortable,
  createAbortError,
  throwIfAborted
} = require('../llm-reconnect-retry');
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
const { SUBAGENT_TOOL } = require('./tool-catalog');
const { createSubagentRunner } = require('./subagent-runner');
const { runRustAgentLoop, resolveChatUrl } = require('./rust-loop-runner');
const { buildLlmHeadersFromConfig } = require('./llm-request');
const { getEffectiveInputBudget } = require('./compaction-main');
const { stripToolCallMarkup } = require('../llm-tool-call-fallback');
const {
  LONG_HORIZON_MAX_SEGMENTS,
  buildSegmentContinueMessages
} = require('./segment-continue');
const {
  createLiveLoopTraceTracker,
  createSubagentNamer,
  buildIsolatedCard,
  mapLoopTraceToUi,
  mapLoopToolToUi,
  mergeIsolatedCards
} = require('./live-loop-trace');

const TASK_TIMEOUT_MS = 60 * 60 * 1000;

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

/** 是否走协调器任务队列：只看结构信号（bestOfN、子任务数、是否跨 worker），不看用户措辞。 */
function shouldUseCoordinatorTaskQueue(plan, enabledBestOfN) {
  if (enabledBestOfN >= 2) return true;
  if (!plan || typeof plan !== 'object') return false;
  const subtasks = Array.isArray(plan.subtasks) ? plan.subtasks : [];
  if (subtasks.length > 3) return true;
  const workers = new Set(subtasks.map((st) => String(st?.worker || 'A')));
  return workers.size > 1;
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

async function fetchChatCompletion(body, apiConfig, settings, signal, onUsage, reconnect) {
  const cfg = apiConfig && typeof apiConfig === 'object' ? apiConfig : {};
  const baseUrl = cfg.baseUrl || settings.baseUrl;
  const apiKey = cfg.apiKey || settings.apiKey;
  const url = resolveChatUrl(baseUrl);
  // 请求头单一来源 llm-request.js：自定义头 / User-Agent / 会话标识随配置一起带出
  const headers = buildLlmHeadersFromConfig(
    { ...cfg, baseUrl, apiKey },
    { model: body && body.model }
  );
  const json = await runWithLlmReconnectRetry(
    () =>
      chatCompletionJson(url, {
        headers,
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
  // sessionId 注入配置：planner 的若干 LLM 调用（计划解析 / 评审 / 汇总）与主对话同属一个会话，
  // 带上它才能让 {{sessionId}} 这类自定义头生效，并命中上游 prompt 缓存。
  const apiConfig = { ...(payload.apiConfig || {}) };
  if (payload.sessionId && !apiConfig.sessionId) apiConfig.sessionId = payload.sessionId;
  const baseUrl = apiConfig.baseUrl || settings.baseUrl;
  const apiKey = apiConfig.apiKey || settings.apiKey;
  const signal = opts.signal || null;
  const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : () => {};
  const onPhase = typeof opts.onPhase === 'function' ? opts.onPhase : () => {};
  const allTools = payload.tools || [];
  const exploreTools = buildExploreTools(allTools);
  // Plan 的 explore 阶段是「协调者」：runToolLoopOnce 会按 allowSubagent 追加 subagent。
  // 研究子 Agent 拿的是 exploreTools（纯白名单，不含 subagent），因此深度恒为 1。
  // 子 Agent 执行器：编排 / 护栏 / 摘要复用 subagent-runner；真正跑循环复用 runToolLoopFromSpec，
  // 于是每个子 Agent 白拿两件事 —— 隔离 trace（对话里的可折叠卡片）与父级取消联动
  // （runToolLoopOnce 会把子 loop 的 runId 记进 activeWorkerLoopIds）。
  // 序号分配器在本轮内共享：研究子 Agent 与写入/命令执行器共用同一序列，
  // 保证每张子 Agent 卡片标题的「#N」唯一（见 live-loop-trace.createSubagentNamer）。
  const subagentNamer = createSubagentNamer();
  const subagentRunner = createSubagentRunner({
    allTools,
    model: payload.model,
    userDataPath: deps.userData,
    contextTierId: payload.contextTierId,
    signal,
    namer: subagentNamer,
    runChildLoop: (req, meta) =>
      runToolLoopFromSpec(
        {
          model: req.model,
          messages: req.messages,
          maxRounds: req.maxRounds,
          maxToolCalls: req.maxToolCalls
        },
        exploreTools,
        null,
        {
          phase: 'Sub · 只读调研',
          worker: 'explore',
          subagentId: meta.subagentId,
          subagentKind: meta.subagentKind,
          subagentIndex: meta.subagentIndex
        }
      )
  });
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

  // 压缩实例的唯一来源是 Main（main-entry.ensureMainCompactionAgent）。planner 若自建实例，
  // 会话冷却计数与累积摘要缓存只活在本轮 run 内 —— 等于每次都绕过冷却、每次重新拉归档。
  const compactionAgent = deps.getCompactionAgent ? deps.getCompactionAgent() : null;
  if (!compactionAgent) {
    throw new Error('planner 缺少 getCompactionAgent 注入，压缩实例必须由 Main 提供');
  }
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
    // 收尾：Rust 最终 trace 合进实时卡片，保持「一个执行器一张卡片」。
    const rustCard = mapLoopTraceToUi((loopResult && loopResult.trace) || [], meta)[0] || null;
    const liveCard = (isolatedTraceBySubagent.get(meta.subagentId) || [])[0] || null;
    const card = rustCard && liveCard ? mergeIsolatedCards(liveCard, rustCard) : rustCard || liveCard;
    if (!card) return;
    upsertIsolatedTrace(
      meta.subagentId,
      [card],
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
    // allowSubagent 只对「协调者」开放（当前仅 Plan 的 explore 阶段）。
    // 子 Agent 循环不会再传它，因此不会出现嵌套派发。
    const coordinatorTools =
      opts.allowSubagent && SUBAGENT_TOOL ? tools.concat([SUBAGENT_TOOL]) : tools;
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
          tools: coordinatorTools,
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
            // 整体透传（含 headers / authMode / userAgent），勿逐字段重建
            apiConfig: { ...apiConfig, baseUrl, apiKey, model: body.model },
            model: body.model,
            sessionId: payload.sessionId || undefined,
            signal: ctx?.signal,
            toolsChars: ctx?.toolsChars
          }),
        delegateTool: async (name, args) => {
          const toolCtx = {
            workspacePath,
            worktreePath: worktreePath || undefined,
            sessionId: payload.sessionId || undefined,
            runId: traceMeta?.subagentId || undefined,
            model: body.model || payload.model,
            taskTier: payload.taskTier || null,
            longHorizon: !!payload.longHorizon
          };
          // 协调者（Plan explore 阶段）派发的只读研究子 Agent 走 subagent-runner，
          // 不落回普通工具委托 —— 否则「子 Agent」会被当成一个不存在的网关工具。
          if (opts.allowSubagent && name === subagentRunner.toolName) {
            return subagentRunner.run(args, { ...toolCtx, subagentDepth: 1 });
          }
          return toolBridge.executeAgentTool(name, args, toolCtx);
        }
      });
    } finally {
      if (trackedLoopRunId) activeWorkerLoopIds.delete(trackedLoopRunId);
      // 补发节流中未到达的一帧，保证下面的 finalizeLoopTrace 合并到最新思考文本
      if (tracker) {
        try {
          tracker.dispose();
        } catch {
          // ignore
        }
      }
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

  async function runToolLoopFromSpec(spec, tools, worktreePath, traceMeta, opts = {}) {
    const longHorizon = !!payload.longHorizon;
    let segmentIndex = 0;
    let currentSpec = { ...(spec || {}) };
    let mergedTrace = [];
    let lastLiveContent = '';
    const liveMeta = traceMeta && traceMeta.subagentId ? traceMeta : null;

    while (true) {
      const multiSegment = longHorizon;
      const loopResult = await runToolLoopOnce(currentSpec, tools, worktreePath, traceMeta, {
        deferFinalize: multiSegment,
        allowSubagent: !!opts.allowSubagent
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
    const useCoordinatorTasks = shouldUseCoordinatorTaskQueue(latestPlan, enabledBestOfN);

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

      // 每个子任务 = 一张子 Agent 卡片（写入/命令/调研），标题「类型 + 序号」。
      // id / 序号 / 类型一次分配（共享 namer），并发执行器也不会撞 id；
      // 占位卡也走 buildIsolatedCard，保证与实时/收尾卡片同形、标题一致。
      const named = subagentNamer.next(task.agentType || 'build');
      const subagentId = named.subagentId;
      const cardMeta = {
        worker,
        taskId: task.id,
        subagentId,
        parallel: parallelRun,
        ...named
      };
      upsertIsolatedTrace(
        subagentId,
        [
          buildIsolatedCard(cardMeta, [{ round: 1, thought: '准备中…', fullThought: '准备中…', tools: [] }], subagentId)
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
        loopResult = await runToolLoopFromSpec(spec, taskTools, wtPath, cardMeta);
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
          // Plan 的 explore 阶段是协调者：额外拿到 subagent，可并行派只读研究子 Agent
          // 摸清多个方向，再由它汇总成勘察笔记交回 planner。
          // 它也占一个序号（kind=plan →「勘察子 Agent #1」），保证思考区每张卡片标题
          // 都是统一的「类型 + 序号」，不会出现一张没有编号的卡片。
          const loopResult = await runToolLoopFromSpec(
            spec,
            exploreTools,
            null,
            {
              phase: 'Explore · 只读勘察',
              worker: 'explore',
              ...subagentNamer.next('plan')
            },
            { allowSubagent: true }
          );
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
