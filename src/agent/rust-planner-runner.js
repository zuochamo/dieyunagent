'use strict';

const { completeOnce, currentLlmCompleteBridge } = require('./llm-complete');
const {
  runWithLlmReconnectRetry,
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
const { resolveAgentLoopSpec, getAgentLimits } = require('./agent-limits');
const { settleAllAbortable } = require('./parallel-batch');
const { createPlannerMainBridge } = require('./planner-main-bridge');
const { buildExploreTools, buildShellTools, buildBuildTools } = require('./planner-tool-filters');
const { SUBAGENT_TOOL, SUBAGENT_STATUS_TOOL } = require('./tool-catalog');
const { createSubagentRunner, noteSubagentActivity } = require('./subagent-runner');
const { runRustAgentLoop, resolveChatUrl } = require('./rust-loop-runner');
const { buildLlmHeadersFromConfig } = require('./llm-request');
const { getEffectiveInputBudget } = require('./compaction-main');
const { applyTierRuntime } = require('./model-runtime-by-tier');
const { clampModelRuntimeValue } = require('./model-runtime-schema');
const { stripToolCallMarkup } = require('../llm-tool-call-fallback');
// 交付文本判据（四态 / 思考回落文案）的单一来源 —— 汇总轮空正文时用它，别在这里另写标签
const roundText = require('./agent-round-text');
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

/**
 * best-of-N 路数的**唯一来源**：`agent-limits.plannerBestOfN`（与 plannerMaxParallelWorkers 同源）。
 *
 * 以前这里是 `payload.plannerBestOfN ?? settings.plannerBestOfN`：前者由 Renderer 从
 * localStorage（`dieyun.planner.bestOfN.v1`）读出，而那个键**全仓没有写入点**；后者从来
 * 不是 settings 的字段。两条路都恒为 undefined → 恒 0，best-of-N 事实上一辈子不生效。
 * 现在只读 agent-limits（按本轮 contextTierId 取档），Renderer 不再参与这个判定。
 */
function plannerBestOfNFromLimits(deps, payload) {
  const n = Number(
    (getAgentLimits(deps && deps.userData, payload && payload.contextTierId) || {}).plannerBestOfN
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

async function fetchChatCompletion(body, apiConfig, settings, signal, onUsage, reconnect, coreBridge) {
  const cfg = apiConfig && typeof apiConfig === 'object' ? apiConfig : {};
  const baseUrl = cfg.baseUrl || settings.baseUrl;
  const apiKey = cfg.apiKey || settings.apiKey;
  const url = resolveChatUrl(baseUrl);
  // 请求头单一来源 llm-request.js：自定义头 / User-Agent / 会话标识随配置一起带出
  const headers = buildLlmHeadersFromConfig(
    { ...cfg, baseUrl, apiKey },
    { model: body && body.model }
  );
  // 传输走 core 的 `llm.complete`（端点/请求头/解析/usage 只有 core 那一份实现）。
  // 重连重试仍留在这一层：它是「同一请求再试一次」的业务决定，不是传输实现。
  const json = await runWithLlmReconnectRetry(
    () =>
      completeOnce({
        coreBridge: coreBridge || currentLlmCompleteBridge(),
        url,
        llm: { ...cfg, baseUrl, apiKey, headers },
        body: { ...body, stream: false },
        signal
      }),
    { signal, ...(reconnect || {}) }
  );
  const content = json && json.content != null ? String(json.content) : '';
  // 思考通道**必须一起交出去**：这个模型（deepseek 系 / 中转）经常整轮只回思考、正文为空，
  // 而 planner 的汇总轮正是"要把过程压成一段话"的那一步 —— 只取 content 就等于把整轮产出
  // 丢掉，最终交付成「(模型未生成文字答复。)」（2026-11-19 真事）。通道身份不变：由调用方决定怎么用。
  const reasoning =
    json && json.reasoning != null
      ? String(json.reasoning)
      : json && json.reasoningContent != null
        ? String(json.reasoningContent)
        : '';
  if (json && json.usage) {
    recordLlmUsage(json.usage, body?.model);
    if (typeof onUsage === 'function') onUsage(extractUsageStats(json.usage, body?.model));
  } else {
    const est = estimateLlmRoundUsage(body, { content });
    if (est) {
      recordLlmUsage(est, body?.model);
      if (typeof onUsage === 'function') onUsage(extractUsageStats(est, body?.model));
    }
  }
  return { content, reasoning };
}

/**
 * Rust 驱动 Planner pipeline（逻辑在 dieyun-core，Node 执行 LLM + agent loop + worktree）。
 */
async function runRustPlannerPipeline(deps, payload, opts = {}) {
  const bridge = deps.coreBridge;
  if (!bridge || !bridge.isReady()) {
    throw new Error('dieyun-core 未就绪');
  }
  // 与主链同一份「模型与段预算」：磁盘 settings 叠上本轮 Context 档位
  // （planner 的预算 / 触发比 / 段上限都随档位走，别只落 default 档）。
  const settings = applyTierRuntime(loadModelSettings(deps.userData), deps.userData, {
    tierId: payload.contextTierId,
    model: payload.model || undefined
  });
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
          maxToolCalls: req.maxToolCalls,
          // 子 Agent 的工具表（Explore 白名单）一路带到执行层：tool-gate 的 `subagent-scope`
          // 按它拦表外调用（只过滤「发给模型」的清单挡不住模型输出表外名字）
          allowedToolNames: req.allowedToolNames
        },
        exploreTools,
        null,
        {
          phase: 'Sub · 只读调研',
          worker: 'explore',
          label: meta.label || '',
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
  // 工作区是不是远端（SSH）：只影响退化成串行时的**文案**（远端建不出副本时要说清是远端的问题，
  // 而不是「不是 git 仓库」）。真正的分派在 `planner-main-bridge`（本地 / 远端两套实现）。
  const remoteWorkspace = /^ssh:/i.test(String(workspacePath || ''));

  const agentBridge = createPlannerMainBridge({
    coordinator: deps.coordinator,
    worktreeService: deps.worktreeService,
    subagentStore: deps.subagentStore,
    dieyunHome: deps.dieyunHome,
    // 远端（SSH）分派的**唯一入口**：不转发它，`planner-main-bridge` 里的 `remoteTarget()`
    // 恒为 null，每个执行器都走本地 `worktreeService`（对一个 `ssh://` 根目录必然建不出来）
    // ⇒ 整批退成串行，还把根因说成「远端建不出隔离副本」——远端 per-role 副本于是从未被执行过
    // （2026-11-19 审计）。这里少一个字段，远端并行就等于没做。
    resolveRemoteRunTarget: deps.resolveRemoteRunTarget,
    // 绑定本轮已解析的工作区，禁止回落到 Main 当前视图
    workspaceRootPath: () => workspacePath || (deps.workspaceRootPath && deps.workspaceRootPath()) || null
  });

  // 续跑断点必须在 `runStart` **之前**读：续跑要沿用同一个 run 身份（见下）。
  let resumeCheckpoint = null;
  if (payload.resumeFromRunId) {
    resumeCheckpoint = deps.subagentStore.loadCheckpoint(deps.dieyunHome(), payload.resumeFromRunId);
  }
  // 续跑**复用被中断那一轮的 runId**。
  //
  // 为什么（2026-11-19 实测）：worktree 根目录是 `.dieyun/worktrees/<runId>/<role>`、
  // 分支是 `dieyun/agent-<runId>-<role>`、断点文件也按 runId 存 —— 换一个新 runId 续跑，
  // 就会给同一件活新建一套空副本：中断前已经写进旧副本的产出既不在「变更」面板
  // （预演也按新 runId 扫），也永远无法应用，只能被容量策略归档到不可见分支。
  // 复用旧 id 后 `createAgentWorktree` 命中已存在目录（`reused:true`，不重置）——
  // 半成品正好留给续跑，这也是 worktree-service 注释里写明的设计意图。
  const resumeRunId = resumeCheckpoint?.ok ? String(payload.resumeFromRunId || '').trim() : '';

  let coordinatorRunId = null;
  const started = agentBridge.runStart({ runId: resumeRunId || undefined, userText: String(payload.userText || '').slice(0, 500) });
  if (started?.runId) coordinatorRunId = started.runId;

  // 远端（SSH）的 per-run 副本目录会留下**完整 checkout**：每轮开工前回收过期的几份。
  // 回收口径在 `remote-run-worktree.pruneRunWorktreeRoots`（先归档进分支、再删目录、保留分支），
  // 数字的唯一来源是 `agent-limits.plannerRunWorktreeKeep`。失败只记一行，绝不挡这一轮。
  if (typeof agentBridge.worktreePruneRunCopies === 'function') {
    void (async () => {
      try {
        const keep =
          Number((getAgentLimits(deps.userData, payload.contextTierId) || {}).plannerRunWorktreeKeep) || 0;
        if (keep <= 0) return;
        const pruned = await agentBridge.worktreePruneRunCopies({ keep });
        if (pruned && !pruned.ok && !pruned.skipped) {
          console.warn(
            `[dieyun:planner] 过期副本回收未完成：${pruned.error || (pruned.blocked || []).join('、') || '未知原因'}`
          );
        }
      } catch {
        // ignore：回收是背景维护，失败不影响本轮
      }
    })();
  }

  // 压缩实例的唯一来源是 Main（main-entry.ensureMainCompactionAgent）。planner 若自建实例，
  // 会话冷却计数与累积摘要缓存只活在本轮 run 内 —— 等于每次都绕过冷却、每次重新拉归档。
  const compactionAgent = deps.getCompactionAgent ? deps.getCompactionAgent() : null;
  if (!compactionAgent) {
    throw new Error('planner 缺少 getCompactionAgent 注入，压缩实例必须由 Main 提供');
  }
  const tokenBudget = getEffectiveInputBudget(settings, payload.model || settings.textModel);
  const toolBridge = deps.createToolBridge(opts.webContents);

  const enabledBestOfN = plannerBestOfNFromLimits(deps, payload);
  // 与主链同层：Renderer 传入本轮 contextTierId，planner 子循环的首包 / 静默 / 重连
  // 参数才能落在与主对话相同的档位（原先缺省落 'default'）。
  const loopSpec = resolveAgentLoopSpec(settings, deps.userData, payload.contextTierId);
  const plannerReconnect = {
    baseDelayMs: loopSpec.llmRetryBaseMs,
    maxDelayMs: loopSpec.llmMaxRetryDelayMs,
    maxWaitMs: loopSpec.llmReconnectMaxWaitMs,
    // 与主循环同口径：重连期间要有可见信号。以前这里没有 onWait —— 规划 / 验收 / 汇总的
    // LLM 瞬断时，界面与日志在最多 `llmReconnectMaxWaitMs` 内完全静默，用户分不清
    // 「重连中」和「卡死」（2026-11-19 审计）。
    onWait: (info) => {
      const sec = Math.max(1, Math.round((Number(info && info.waitMs) || 0) / 1000));
      const attempt = Number(info && info.attempt) || 0;
      console.warn(`[dieyun:planner] 模型接口连接中断，${sec}s 后自动重试（第 ${attempt} 次）`);
      onPhase('llm_reconnect_wait', {
        runId: coordinatorRunId,
        attempt,
        waitMs: info && info.waitMs,
        error: String((info && info.error && info.error.message) || (info && info.error) || '')
      });
    }
  };
  const loopMaxToolCalls = loopSpec.maxToolCalls;
  // 并行执行器上限：数字单一来源在 agent-limits（同时是 worktree 数 / LLM 并发流数）。
  const workerLimitCfg = Number(
    (getAgentLimits(deps.userData, payload.contextTierId) || {}).plannerMaxParallelWorkers
  );
  const workerCap = Number.isFinite(workerLimitCfg) && workerLimitCfg > 0
    ? Math.floor(workerLimitCfg)
    : 1;

  const startParams = {
    model: payload.model || settings.textModel,
    sysContent: payload.sysContent || '',
    userText: payload.userText || '',
    chatHistoryBlock: payload.chatHistoryBlock || '',
    hasImages: !!payload.hasImages,
    hasExploreTools: exploreTools.length > 0,
    maxWorkerRetries: 1,
    bestOfN: enabledBestOfN,
    maxOutputTokens: clampModelRuntimeValue('maxOutputTokens', settings.maxOutputTokens ?? settings.maxTokens),
    temperature: clampModelRuntimeValue('temperature', settings.temperature),
    maxToolCalls: loopMaxToolCalls,
    // worker / explore 子循环的轮次预算：**和主循环同一个来源**（`agentMaxRounds`）。
    // 以前这两个数烤在 Rust 里（explore 24 / worker 96），宿主调大轮次对 plan 完全无效。
    maxRounds: loopSpec.maxRounds,
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
    // 卡片自己的正文只留在卡片里：以前把任意一路 worker 的片段写成 run 级
    // `lastStreamContent`，主气泡的流式文本就在 N 路之间来回跳，最后停在「最后一个收尾
    // worker 的某个片段」上（既不是最终答复也不完整），断点里存的也是它（2026-11-19 审计 P2）。
    void streamContent;
    rebuildUiTrace();
  };

  // 「为什么这一轮走了 planner」必须写在最前面：开关只代表**允许**，真正拍板的是侧模型
  // （`src/agent/planner-router.js`）。没有这一行，用户看到 3 路执行器时无法判断是「我自己开的」
  // 还是「判定器判的」，也无从复盘某次误判。`thought` 是结论 + 理由，`fullThought` 带判定模型
  // 的思考原文；Renderer 在「不拆」时补的是同一张卡（phase 名同源 `agent-round-text`）。
  const plannerRouteReason = String(payload.plannerRouteReason || '').trim();
  const plannerRouteThinking = String(payload.plannerRouteThinking || '').trim();
  const plannerRoutePhase =
    String(payload.plannerRoutePhase || '').trim() || roundText.PLANNER_ROUTE_PHASE;
  const routeThought = plannerRouteReason || '侧模型判定：拆成多路并行走 planner';
  const routeNoteEntry =
    plannerRouteReason || plannerRouteThinking
      ? {
          round: 0,
          phase: plannerRoutePhase,
          thought: routeThought,
          fullThought: plannerRouteThinking
            ? `${routeThought}\n\n【判定模型思考】\n${plannerRouteThinking}`
            : routeThought,
          tools: []
        }
      : null;

  const mergePlannerTrace = (trace) => {
    const plannerPart = (trace || []).map(mapPlannerTraceEntryToUi);
    uiTrace = [
      ...(routeNoteEntry ? [routeNoteEntry] : []),
      ...plannerPart,
      ...collectWorkerTracePart()
    ];
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
    // worker 循环现在由 core 驱动（`agent.run.*`），取消也必须走 `agent.run.cancel`：
    // 旧的 `agent.loop.cancel` 只清账本，不会停掉 core 里那次在途的 LLM 调用。
    await Promise.all(
      ids.map((loopRunId) => bridge.invoke('agent.run.cancel', { runId: loopRunId }).catch(() => {}))
    );
  }

  async function runToolLoopOnce(spec, tools, worktreePath, traceMeta, opts = {}) {
    // allowSubagent 只对「协调者」开放（当前仅 Plan 的 explore 阶段）。
    // 子 Agent 循环不会再传它，因此不会出现嵌套派发。
    const coordinatorTools =
      opts.allowSubagent && SUBAGENT_TOOL
        ? tools.concat([SUBAGENT_TOOL, SUBAGENT_STATUS_TOOL].filter(Boolean))
        : tools;
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
            // 子 Agent 有产出 = 有进展：工具看门狗据此续命（别把长期产出的调研判成卡住）
            noteSubagentActivity();
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
        // 请求快照：Planner worker 的请求也要能事后回看（来源标 planner）。
        sessionId: payload.sessionId || undefined,
        runSource: 'planner',
        startParams: {
          model: body.model,
          messages: body.messages,
          tools: coordinatorTools,
          // 这一轮真正写的是 worktree（执行器各一份副本）：账本、快照、索引通知都要对齐，
          // 否则记录会指向主工作区，事后按 runId 复盘时看不出改的是哪份副本。
          workspaceRoot: worktreePath || workspacePath,
          maxToolCalls:
            Number(spec.maxToolCalls) > 0 ? Number(spec.maxToolCalls) : loopMaxToolCalls,
          maxRounds: clampModelRuntimeValue(
            'agentMaxRounds',
            Number(spec.maxRounds) > 0 ? Number(spec.maxRounds) : settings.agentMaxRounds
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
            // 子 Agent 循环：执行层按这张表拦（普通员工/勘察协调者没有这个字段 → 不拦）
            allowedToolNames: Array.isArray(spec.allowedToolNames) ? spec.allowedToolNames : undefined
          };
          // 协调者（Plan explore 阶段）派发的只读研究子 Agent 走 subagent-runner，
          // 不落回普通工具委托 —— 否则「子 Agent」会被当成一个不存在的网关工具。
          // 深度**由 runner 决定**（`runFromCoordinator` = 协调者口径 0）：这里以前自己写
          // `subagentDepth: 1`，与默认 `subagentMaxDepth: 1` 相撞，plan 的并发调研 100% 被拒。
          if (opts.allowSubagent && name === subagentRunner.toolName) {
            return subagentRunner.runFromCoordinator(args, toolCtx);
          }
          if (opts.allowSubagent && name === subagentRunner.statusToolName) {
            return subagentRunner.status();
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
      // **卡片收尾必须在这里**：以前放在 try/finally 之后，`runRustAgentLoop` 抛错时被整段跳过，
      // 那张「准备中…」占位卡会一直挂在思考区转圈，还会被当成这一路的产出落库
      // （2026-11-19 审计）。与主循环入口 `agent-runtime` 的 finalizeSubagentTrace 同形态：
      // 失败也收尾（loopResult 为 null 时退回实时卡片）。
      if (liveMeta) {
        try {
          finalizeLoopTrace(loopResult || null, liveMeta, liveContent);
        } catch {
          // ignore
        }
      }
    }
    if (!liveMeta && traceMeta) {
      const entries = mapLoopTraceToUi(loopResult && loopResult.trace, traceMeta);
      if (entries.length) {
        uiTrace.push(...entries);
        pushUiTrace(loopResult.content || '');
      }
    }
    return loopResult;
  }

  /** 单段执行：撞到轮次/工具上限就停并交付，不再自动续段（无人值守的连续推进归目标型计划）。 */
  async function runToolLoopFromSpec(spec, tools, worktreePath, traceMeta, opts = {}) {
    return runToolLoopOnce(spec, tools, worktreePath, traceMeta, {
      allowSubagent: !!opts.allowSubagent
    });
  }

  async function runWorkerJob(job, isRetry, opts = {}) {
    const worker = job.worker;
    // 卡片的「并行」只反映**真实 batch 并发**：同一执行器的多个子任务在 for 循环里
    // 一个接一个跑（`:666` 起），以前按 `tasks.length > 1` 也标成并行，于是卡片撒谎。
    const parallelRun = !!opts.parallelBatch;
    const worktreeRole = opts.worktreeRole || worker;
    let wtPath = null;
    let wtBaseSha = null;
    // 探建阶段已确认「这个工作区建不出 worktree」时（`noIsolation`），整批统一走主工作区串行。
    // 不允许同一批里 A 在副本、B 在主工作区 —— 半隔离比不隔离更难查：B 的改动会**绕过**
    // 「变更」面板直接落盘（既不在预览里，也没法撤销）。
    if (!opts.noIsolation && agentBridge.worktreeCreate && coordinatorRunId) {
      const wt = await agentBridge.worktreeCreate(coordinatorRunId, worktreeRole);
      wtPath = wt?.ok ? wt.path : null;
      wtBaseSha = wt?.baseSha || null;
    }
    // **隔离闸（失败关闭）**：多路执行器同时跑时，缺 worktree 就等于两路同时写主工作区。
    // 探测阶段已经确认过能建（见 runWorkerBatch），走到这里还失败说明是环境问题
    //（非 git、磁盘、git 锁），宁可整批失败也不允许无隔离地并发写入。
    if (opts.parallelBatch && !wtPath) {
      throw new Error(
        `并行执行器 ${worktreeRole} 没有拿到 worktree（工作区不是 git 仓库或创建失败）：` +
          '已拒绝让多路执行器同时写主工作区。请改用 git 工作区，或在设置里关掉「多 Agent 并行执行」'
      );
    }
    // 重试：先把副本清回基线。否则上一次失败的半成品会留在副本里，被当成**这一次**的产出
    // 合并进主工作区（重试没碰过的文件也会被带出去）。
    if (isRetry && wtPath && agentBridge.worktreeReset) {
      const reset = await agentBridge.worktreeReset(wtPath, wtBaseSha);
      if (reset && reset.ok === false) {
        throw new Error(`重试前重置 worktree 失败（${worktreeRole}）：${reset.error || '未知原因'}`);
      }
    }
    const outputs = [];
    let priorSummary = '';
    let hitRoundLimit = false;
    let partial = null;
    // 同一执行器的多个子任务**共用一段对话**（见下面的 messages 拼接）：
    // 以前每个子任务都新起一次 loop run，system / 已读文件全部重建，第 2 个子任务
    // 会把第 1 个刚查过的东西再查一遍（2026-11-19 实测：同一 worker 的 B1/B2 各起一次 run）。
    let carriedMessages = null;
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
          // 重试不在这里：coordinator 只记事实，重跑由 planner 自己（`planner/run.rs`）按预算决定。
          worktreePath: wtPath
        });
        if (en?.ok && en.task) taskId = en.task.taskId;
      }
      if (useCoordinatorTasks && agentBridge.taskRunning && coordinatorRunId) {
        await agentBridge.taskRunning(coordinatorRunId, taskId);
      }

      // 每个子任务 = 一张子 Agent 卡片（写入/命令/调研），标题「类型 + 序号 · 子任务标题」。
      // id / 序号 / 类型一次分配（共享 namer），并发执行器也不会撞 id；
      // 占位卡也走 buildIsolatedCard，保证与实时/收尾卡片同形、标题一致。
      // `label` 取子任务 title：多路并发时，用户要靠它分清「#2 在改什么」（序号只负责区分）。
      const named = subagentNamer.next(task.agentType || 'build');
      const subagentId = named.subagentId;
      const cardMeta = {
        worker,
        taskId: task.id,
        subagentId,
        label: String(task.title || '').trim(),
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
      // 续做同一执行器的下一个子任务：**只换 system**（它描述当前子任务 + 期望输出），
      // 其余历史（上一段读过哪些文件、跑过哪些命令、结论是什么）原样保留 —— 这正是
      // 「同一执行器顺序执行」该有的语义，也让第 2 个子任务不必重复勘察。
      // 段末再拼一条当前子任务的用户消息，保证模型知道现在要做哪一件。
      if (carriedMessages && carriedMessages.length >= 2 && Array.isArray(spec.messages) && spec.messages.length >= 2) {
        const [systemMsg, userMsg] = spec.messages;
        spec.messages = [systemMsg, ...carriedMessages.slice(1), userMsg];
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
      // 断点里的已完成产出按 id **覆盖写**，不追加：验收触发重试后同一个 id 会再产出一次，
      // 追加会让恢复后的 results 出现两条同 id 记录（一条是被否掉的旧产出），
      // 断点体积还会随每次重试线性增长（2026-11-19 审计）。
      const completedEntry = { id: task.id, worker, subagentId, output, error: null };
      const dedupAt = completedOutputs.findIndex((o) => o && o.id === completedEntry.id);
      if (dedupAt >= 0) completedOutputs[dedupAt] = completedEntry;
      else completedOutputs.push(completedEntry);
      await persistPlannerCheckpoint({
        worker,
        lastSubtaskId: task.id,
        lastSubagentId: subagentId
      });
      if (useCoordinatorTasks && agentBridge.taskComplete && coordinatorRunId) {
        await agentBridge.taskComplete(coordinatorRunId, taskId, { output: output.slice(0, 8000) });
      }
      // 把这一段的对话留给**同一执行器的下一个子任务**（见上面的 messages 拼接）。
      // 账本里的 messages 是「下一轮的输入」：没调工具的收尾轮不会把 assistant 正文补进去，
      // 所以这里要自己补一条 —— 否则带过去的只有原始需求，等于没带上下文。
      if (Array.isArray(loopResult.messages) && loopResult.messages.length) {
        const carried = loopResult.messages.slice();
        const last = carried[carried.length - 1];
        const lastIsAnswer = last && last.role === 'assistant' && String(last.content || '') === output;
        if (output && !lastIsAnswer) carried.push({ role: 'assistant', content: output });
        carriedMessages = carried;
      } else {
        carriedMessages = null;
      }
      priorSummary += `[${task.id}] ${output.slice(0, 400)}\n`;
    }
    return { outputs, hitRoundLimit, partial, worker };
  }

  /**
   * 这一批的执行方式：`{ limit, isolated, note? }`。
   *
   * 两个条件都要满足才并发：① 用户没把上限设成 1；② **隔离能力可用** —— 本地 git 仓库，
   * 或远端（SSH）会话里建得出远端副本（`planner-main-bridge` 分派到 `remote-run-worktree`）。
   * 探测方式：先给第一路建一次 —— `createAgentWorktree` 是幂等的（目录已存在则返回 `reused:true`），
   * 所以真跑时不会重复建，探测本身不浪费。
   *
   * `isolated=false` 时整批**统一**退成「串行 + 主工作区」（limit=1 且各 job 不再尝试建副本）：
   * 半隔离（A 有副本、B 没有）会让 B 的改动绕过「变更」面板直接落盘，比不隔离更难查。
   * 退化的原因写在 `note` 里，由 `runWorkerBatch` 推到思考区（不许静默）。
   */
  async function resolveWorkerBatchPlan(jobs) {
    if (!(jobs.length > 1)) return { limit: 1, isolated: true };
    if (!agentBridge.worktreeCreate || !coordinatorRunId) {
      return {
        limit: 1,
        isolated: false,
        note: '缺少编排账本，建不出隔离副本：本批串行在主工作区执行'
      };
    }
    const first = jobs[0] || {};
    const probe = await agentBridge.worktreeCreate(coordinatorRunId, first.worker || 'A');
    if (!probe || !probe.ok) {
      const where = remoteWorkspace ? '远端会话' : '本地工作区';
      return {
        limit: 1,
        isolated: false,
        note: `${where}建不出隔离副本（${(probe && probe.error) || '未知原因'}）：本批串行在主工作区执行`
      };
    }
    return { limit: Math.max(1, Math.min(workerCap, jobs.length)), isolated: true };
  }

  async function runWorkerBatch(workerJobs, isRetry) {
    const jobs = workerJobs || [];
    throwIfAborted(signal);
    const plan = await resolveWorkerBatchPlan(jobs);
    const parallelLimit = plan.limit;
    const parallelBatch = jobs.length > 1 && parallelLimit > 1;
    // 「实际并发」是**这一层的事实**，必须说出来：core 只报「有几个执行器」（它看不到并发上限、
    // 隔离探测结果、同一执行器多子任务、Best-of-N），并发度由这里决定。
    // 以前只在「隔离退化」时写一条，于是「界面写着 N 路并行、墙钟却是一路一路跑」永远查不出来
    // （2026-11-19 实测：6 段 worker run 首尾相接，用户完全看不出并行没发生）。
    const taskCount = jobs.reduce((n, j) => n + (j.tasks ? j.tasks.length : 0), 0);
    const serialReasons = [];
    if (jobs.length > 1 && parallelLimit <= 1) {
      serialReasons.push(`并发上限为 ${parallelLimit}（设置 → 多 Agent 并行的「并行执行器数」）`);
    }
    if (jobs.some((j) => (j.tasks || []).length > 1)) {
      serialReasons.push('同一执行器的多个子任务在同一份副本里顺序执行');
    }
    if (!plan.isolated && plan.note) serialReasons.push(plan.note);
    const actualNote = parallelBatch
      ? `${jobs.length} 个执行器 / ${taskCount} 个子任务，并发上限 ${parallelLimit}`
      : `串行：${serialReasons.join('；') || '本批只有一个执行器'}`;
    if (jobs.length > 1) {
      console.warn(`[dieyun:planner] 本批实际并发 · ${actualNote}`);
      uiTrace.push({
        phase: '调度 · 实际并发',
        thought: actualNote,
        fullThought: actualNote,
        tools: []
      });
      pushUiTrace();
      if (!parallelBatch) {
        onPhase('workers_serial_fallback', {
          runId,
          jobs: jobs.length,
          note: serialReasons.join('；')
        });
      }
    }
    const settled = await settleAllAbortable(
      jobs,
      (job) => {
        throwIfAborted(signal);
        return runWorkerJob(job, isRetry, {
          parallelBatch,
          noIsolation: !plan.isolated
        });
      },
      {
        signal,
        limit: parallelLimit,
        createAbortWaiter,
        createAbortError,
        onAbort: cancelActiveWorkerLoops
      }
    );
    const results = [];
    /** 先收齐整批结果再决定早退：撞轮次的那一路不该把同批其余路的失败吞掉
     *  （吞掉 = core 的 review 看不到那些 task 的 error，可能直接放过一道没跑完的活）。 */
    let hitRound = null;
    for (let i = 0; i < settled.length; i += 1) {
      const s = settled[i];
      const job = jobs[i] || {};
      if (s.status === 'fulfilled') {
        results.push(...s.value.outputs);
        if (s.value.hitRoundLimit && !hitRound) {
          hitRound = { partial: s.value.partial };
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
    if (hitRound) {
      return { hitRoundLimit: true, partial: hitRound.partial, workerResults: results };
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
        const { content } = await fetchChatCompletion(
          phase.llmBody,
          apiConfig,
          settings,
          signal,
          addPlannerUsage,
          plannerReconnect,
          bridge
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
            // 截断的勘察结论也是**结论**：core 拿 `partialContent` 当笔记继续拆解。
            // 同一份必须进断点（这里先记下，规划落盘时随 `latestPlan` 一并写），
            // 否则从断点续跑后 worker 的【Explore 勘察摘要】是空白的。
            latestExploreNotes = loopResult.content || '';
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
            await persistPlannerCheckpoint();
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
        const { content } = await fetchChatCompletion(
          phase.llmBody,
          apiConfig,
          settings,
          signal,
          addPlannerUsage,
          plannerReconnect,
          bridge
        );
        // 选优之后接着就是验收：把 worktree 的实际 diff 一起带过去。
        // 不带的话验收拿到的 `worktreeChanges` 是空对象，「声称改了文件却零 diff」这条
        // 验收规则在 best-of-N 路径上永远不生效（2026-11-19 审计）。
        let pickWorktreeCtx = null;
        if (agentBridge.worktreePreviewRun && coordinatorRunId) {
          pickWorktreeCtx = await agentBridge.worktreePreviewRun(coordinatorRunId);
        }
        phase = await bridge.invoke(
          'planner.run.continue',
          { runId, step: 'best_of_n_pick_llm', content, worktreeCtx: pickWorktreeCtx || {} },
          60000
        );
      } else if (p === 'need_review_llm') {
        const { content, reasoning } = await fetchChatCompletion(
          phase.llmBody,
          apiConfig,
          settings,
          signal,
          addPlannerUsage,
          plannerReconnect,
          bridge
        );
        // 验收轮要的是 JSON：只回思考就等于没给判定。这里**不塞标签文本**（会被当 JSON 解析），
        // 只留一条可对照的诊断 —— 真正的兜底是 core 侧「不采信未通过验收」的既有语义。
        if (!String(content || '').trim() && String(reasoning || '').trim()) {
          console.warn(
            '[dieyun:planner] 验收轮上游只回了思考（content 为空），本轮判定按「未给出结论」处理'
          );
        }
        phase = await bridge.invoke(
          'planner.run.continue',
          { runId, step: 'review_llm', content },
          60000
        );
      } else if (p === 'need_synthesize_llm') {
        const { content, reasoning } = await fetchChatCompletion(
          phase.llmBody,
          apiConfig,
          settings,
          signal,
          addPlannerUsage,
          plannerReconnect,
          bridge
        );
        // 汇总轮是**唯一**能把这一轮产出交给用户的地方，所以这里只做一件事：
        // 把「不可用的正文」归一成**空正文**，交给 core 已有的判定去决定下一步
        // （`handle_synthesize_llm`：空正文 ⇒ 再要一次最终答复；第二次仍空 ⇒ 如实标「未成文」）。
        //
        // 以前这里有两条「看起来有字、其实不可用」的路径被当成正文喂给 core，两次都砸在
        // 同一个终点上 —— 账本里只剩「（模型未生成文字答复。）」（2026-11-19 三例实锤）：
        //   1. 残留 tool_call 标记：中转常把工具调用当正文吐（`<| |DSML| | invoke …>`），
        //      `stripToolCallMarkup` 会从标记处删到**全文末尾** → 整段汇总归零 → 下游 `(空响应)`；
        //   2. 只有思考通道：把「（以下为模型思考，本轮未成文）」标签当正文交上去 → core 记
        //      「已完成」，而落库口按 REASONING-ISOLATION §3.4 又把这条标签换成同一个占位符。
        // 两者都是伪造成功（思考永不顶正文，标记残渣更不是正文）。所以一律交空串，
        // 并留一条**带原始片段**的诊断 —— 下次要能一眼看出是「泄漏」还是「真空」。
        const rawSummary = String(content || '');
        const markupLeaked = roundText.replyHasToolCallMarkup(rawSummary);
        let finalText = markupLeaked ? '' : stripToolCallMarkup(rawSummary);
        if (markupLeaked) {
          console.warn(
            '[dieyun:planner] 汇总轮正文含残留工具调用标记（剥除后会吃掉整段），按空正文交给 core 重问。原始前 200 字：' +
              JSON.stringify(rawSummary.slice(0, 200))
          );
        } else if (!finalText.trim()) {
          console.warn(
            '[dieyun:planner] 汇总轮没有可用正文（' +
              (String(reasoning || '').trim() ? '只有思考通道' : '既无正文也无思考') +
              '），按空正文交给 core 重问'
          );
        }
        phase = await bridge.invoke(
          'planner.run.continue',
          { runId, step: 'synthesize_llm', content: finalText },
          120000
        );
      } else {
        throw new Error(`未知 planner phase: ${p}`);
      }

      pushTrace(phase.trace);
    }

    if (!phase || phase.phase !== 'done') {
      throw new Error(phase?.message || 'planner 未正常结束');
    }

    // 远端（SSH）：收尾把每个执行器的副本并回会话副本 —— SSH 会话的「变更」面板一直看的是它，
    // 不合并的话各路产出只躺在一堆没人找得到的 per-role 目录里。本地路径这段是 no-op。
    let finalizeMerged = null;
    if (coordinatorRunId && typeof agentBridge.worktreeFinalizeRun === 'function') {
      try {
        finalizeMerged = await agentBridge.worktreeFinalizeRun(coordinatorRunId);
      } catch (e) {
        finalizeMerged = { ok: false, error: (e && e.message) || String(e) };
      }
      if (finalizeMerged && finalizeMerged.failed && finalizeMerged.failed.length) {
        // 只说「有冲突」用户没法自查：把**冲突文件、副本路径、可粘贴的命令**一起给出来。
        const lines = finalizeMerged.failed.map((f) => {
          const head = `${f.roleId}${f.conflict ? '（冲突）' : ''}`;
          const files = Array.isArray(f.paths) && f.paths.length ? `冲突文件：${f.paths.join('、')}` : '';
          const where = f.wtPath ? `副本 ${f.wtPath}${f.branch ? `（分支 ${f.branch}）` : ''}` : '';
          const cmd = f.wtPath ? `自查：git -C ${f.wtPath} show --stat --oneline HEAD` : '';
          return `- ${[head, files, where].filter(Boolean).join('；')}${cmd ? `\n  ${cmd}` : ''}`;
        });
        const note =
          '执行器产出并回会话副本时有冲突（这些改动**没有被覆盖**，副本已保留）：\n' +
          lines.join('\n');
        console.warn(`[dieyun:planner] ${note}`);
        uiTrace.push({ phase: '调度 · 并回副本', thought: note, fullThought: note, tools: [] });
        pushUiTrace();
      }
    }

    // 断点只在**真正跑完**时删除。撞轮次/工具预算（hitRoundLimit）的那一轮是「跑到一半停车」，
    // 断点必须留着 —— 否则「继续」两条入口（tool-loop continue 状态 / planner 断点）都取不到
    // 东西，Composer 空提交变成毫无反应，而这一轮又已经交付了正文。
    if (coordinatorRunId && agentBridge.checkpointDelete && !phase.hitRoundLimit) {
      try {
        await Promise.resolve(agentBridge.checkpointDelete(coordinatorRunId));
      } catch {
        // ignore
      }
      // 续跑成功后把**被消费的那份**断点也删掉：它一直写着 status:'running'，
      // `tryDetectResumeCheckpoint` 每次进会话都会把它端出来（点「继续」= 在又一个新 runId 下
      // 重跑一遍已完成的子任务）。
      const consumed = String(payload.resumeFromRunId || '').trim();
      if (consumed && consumed !== coordinatorRunId) {
        try {
          await Promise.resolve(agentBridge.checkpointDelete(consumed));
        } catch {
          // ignore
        }
      }
    } else if (coordinatorRunId && phase.hitRoundLimit) {
      await persistPlannerCheckpoint({ status: 'running', resumable: true, hitRoundLimit: true });
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
