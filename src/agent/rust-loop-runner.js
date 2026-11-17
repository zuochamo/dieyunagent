'use strict';

const { resolveFoldSpec, recordFoldTelemetry } = require('./compaction-main');
const { recordLlmUsage } = require('./llm-usage-recorder');
const { llmRawTapEnabled } = require('../llm-raw-tap');
const {
  raceAbortable,
  createAbortError,
  isAbortError,
  isContextOverflowError
} = require('../llm-reconnect-retry');
const { resolveAgentLoopSpec, getAgentLimits, AGENT_LIMITS_DEFAULTS } = require('./agent-limits');
// 请求快照：每轮请求的装配与落库唯一写入点（见 docs/REQUEST-SNAPSHOT.md）。
const {
  createRequestSnapshotWriter,
  resolveSnapshotLimits,
  SNAPSHOT_SOURCES,
  SNAPSHOT_REASONS
} = require('./request-snapshot');
const { trimMessagesToCharBudget, foldOlderCompletionMessages, contentCharLen } = require('./session-context');
const { capDelegateResults } = require('./tool-result-cap');
const {
  takePendingVisionImages,
  clearPendingVisionImages,
  buildVisionMessage,
  SOURCE_BROWSER,
  SOURCE_ATTACHMENT,
  SOURCE_MCP
} = require('./browser-vision');
const { sanitizeChatBodyImagesForApi } = require('./guardrails-shared');

const { executeDelegateBatch } = require('./delegate-batch');
const { applyTurnEndSynthesis } = require('./agent-synthesis');
const { buildLlmHeadersFromConfig, resolveLlmEndpoint } = require('./llm-request');
const { getChannelPolicy } = require('./llm-channel');
// 思考占位补全的单一来源（Renderer 经 agent-bundle 消费同一份）。
const { backfillReasoningContent } = require('./reasoning-backfill');

function toolsJsonChars(tools) {
  try {
    return tools ? JSON.stringify(tools).length : 0;
  } catch {
    return 0;
  }
}

/**
 * 请求长度硬上限（`llmRequestMaxChars`，按字符计）：proxy / 上游的输入长度护栏，
 * 与「模型 token 窗口 / 压缩触发线」是两件事 —— 是否压缩由 Rust 账本
 * （触发比 + 冷却轮数）单点决定，这里不做也**不能**做压缩判据。
 * 历史上曾把本函数的前身当触发线，另写了一份 Node 侧判据与 Rust 分叉，勿再回头。
 */
function applyLlmMessageCharCap(body, userData, tierId) {
  if (!body || !Array.isArray(body.messages)) return false;
  let lim = {};
  try {
    lim = getAgentLimits(userData, tierId) || {};
  } catch {
    lim = {};
  }
  const requestMax = Math.max(
    50000,
    Number(lim.llmRequestMaxChars || AGENT_LIMITS_DEFAULTS.llmRequestMaxChars) - toolsJsonChars(body.tools)
  );
  const capOpts = {
    historyMaxChars: lim.completionHistoryMaxChars,
    messageMaxChars: lim.completionMessageMaxChars,
    lastUserMaxChars: lim.completionLastUserMaxChars,
    turnRideMaxChars: lim.completionTurnRideMaxChars,
    requestMaxChars: requestMax,
    recentTurns: lim.completionRecentTurns,
    foldedMaxChars: lim.completionFoldedMaxChars,
    toolResultMaxChars: lim.toolResultMaxJson
  };
  const next = trimMessagesToCharBudget(foldOlderCompletionMessages(body.messages, null, capOpts), capOpts);
  const before = body.messages.length;
  const beforeChars = body.messages.reduce((n, m) => n + contentCharLen(m && m.content), 0);
  const afterChars = next.reduce((n, m) => n + contentCharLen(m && m.content), 0);
  body.messages = next;
  return next.length !== before || afterChars < beforeChars;
}

/**
 * `agent.run.start` 的唯一填参口：把 `agent-limits` 解析出的护栏数字补进 startParams。
 *
 * Rust 内核不再自带 `maxToolCalls=150` / `maxRounds=96` 兜底（跨语言复制数字会静默分叉），
 * 缺参即 `INVALID_PARAMS` —— 所以两个数字必须在这一处补齐，而不是散在各调用点。
 */
function applyResolvedLoopSpec(startParams, spec, foldSpec) {
  const out = { ...(startParams || {}) };
  for (const key of ['maxToolCalls', 'maxRounds']) {
    const resolved = spec && spec[key];
    if ((out[key] == null || out[key] === '') && resolved != null && resolved !== '') {
      out[key] = resolved;
    }
  }
  // 折叠预算只在这一处注入：core 按它自己折，Node 不再每轮算一遍再把 messages 推回去
  if (foldSpec && Number(foldSpec.tokenBudget) > 0) {
    out.tokenBudget = Number(foldSpec.tokenBudget);
    out.triggerRatio = Number(foldSpec.triggerRatio) || 0;
  }
  return out;
}

function isCancelledRpcError(err) {
  if (isAbortError(err)) return true;
  const code = String((err && (err.code || err.name)) || '');
  const msg = String((err && (err.message || err)) || '');
  return (
    code === 'AGENT_CANCELLED' ||
    code === 'CORE_RPC_CANCELLED' ||
    /AGENT_CANCELLED|CORE_RPC_CANCELLED|run 已取消|已停止/i.test(msg)
  );
}

/**
 * 终止一个 run：`agent.run.cancel` 是 core 侧唯一的终止入口。
 *
 * `abortPending` 先把宿主侧在途的那条 invoke 就地 settle（否则「停止」还要等 RPC 超时），
 * 再显式发 `agent.run.cancel`，让 core 把那次请求与账本一起收掉。
 * 旧的 `agent.loop.cancel` 只清账本、不驱动循环，Node 不再调它。
 */
function abortSidecarRun(bridge, runId) {
  if (!bridge || !runId) return Promise.resolve();
  if (typeof bridge.abortPending === 'function') {
    bridge.abortPending({ runId, reason: '已停止' });
  }
  if (typeof bridge.invoke !== 'function') return Promise.resolve();
  return bridge.invoke('agent.run.cancel', { runId }).catch(() => {});
}

async function throwIfCancelled(bridge, runId, signal) {
  if (!signal?.aborted) return;
  await abortSidecarRun(bridge, runId);
  throw createAbortError();
}

/**
 * `agent.run.*` 的唯一调用口。
 *
 * 超时**不在这里传**：`core-rpc-timeouts.js` 的 `agent.run.start` / `agent.run.tools`
 * 分支是唯一来源；取消时连带把 core 侧的 run 收掉。
 */
async function invokeRunRpc(bridge, method, params, signal) {
  const runId = params && params.runId;
  try {
    return await raceAbortable(
      bridge.invoke(method, params),
      signal,
      () => {
        abortSidecarRun(bridge, runId);
      }
    );
  } catch (err) {
    if (isCancelledRpcError(err)) {
      await abortSidecarRun(bridge, runId);
      throw createAbortError();
    }
    throw err;
  }
}

/**
 * 折叠事实 → Node 侧动作（phase / 遥测 / 归档）。
 *
 * 折叠**发生在 core 的循环里**（每次发请求之前）：Node 不再算预算、也不再
 * 把 messages 推回去（同一份对话曾有两个写者）。这里只做三件只有 Node 才能做的事：
 * 推给 UI、记遥测、写归档行。
 */
async function handleFoldFact({ fact, compactMessages, runId, round, onPhase, userData, sessionId }) {
  if (!fact || !fact.level) return { compacted: false };
  onPhase('compacted', {
    runId,
    round,
    tokensBefore: fact.tokensBefore,
    tokensAfter: fact.tokensAfter,
    level: fact.level,
    triggerSource: fact.triggerSource
  });
  try {
    recordFoldTelemetry(userData, fact, { force: false, sessionId });
  } catch {
    // 遥测失败不影响主链路
  }
  let archiveId = null;
  try {
    if (compactMessages && typeof compactMessages.archiveFold === 'function') {
      archiveId = await compactMessages.archiveFold(fact);
    }
  } catch {
    // 归档失败就让快照留 null，不编 id
  }
  return {
    compacted: true,
    tokensBefore: fact.tokensBefore,
    tokensAfter: fact.tokensAfter,
    archiveId: archiveId != null ? archiveId : null,
    level: fact.level,
    triggerSource: fact.triggerSource
  };
}

/**
 * 一轮 LLM 请求的请求头（单一来源 llm-request.js）。
 *
 * 变量分工（关系上游缓存命中，勿混）：
 *   - `sessionId`：**同一对话稳定**，用于会话级标识（如 x-opencode-session）→ 上游可据此命中 prompt 缓存；
 *   - `runId`    ：每个 run 一个，用于「每 run 唯一」的追踪头。
 * 供应商自定义头里的 `{{sessionId}}` / `{{runId}}` / `{{model}}` 即取自此。
 */
function buildChatHeaders(llm, runId) {
  return buildLlmHeadersFromConfig(llm, { runId });
}

/**
 * 日志出口由 Main 注入（electron-log）；未注入时退回 console.warn。
 * 与 `mutate-queue.setMutateQueueLog` 同构：一个模块一个钩子，避免 4 个调用点各传一遍。
 */
let loopLogHook = null;
function setLoopRunnerLog(fn) {
  loopLogHook = typeof fn === 'function' ? fn : null;
}

/**
 * 活跃 agent loop 计数（闲时队列「系统是否忙」的唯一来源）。
 * 聊天 Agent / Planner worker / 定时计划全走 runRustAgentLoop，一个计数器覆盖全部。
 */
const activeLoops = new Set();
function getActiveAgentLoopCount() {
  return activeLoops.size;
}

/**
 * `round.prepare` 的宿主侧唯一装配点。
 *
 * core 的反向调用按**方法名**注册（`coreBridge.onCoreCall` 一张表一个方法名），而一个 core
 * 进程同时服务多个 run（聊天 / planner worker / 计划）。所以这里按 `runId` 分派：
 * 每个 run 在 `agent.run.start` **之前**挂上自己的 handler，跑完（finally）摘掉；
 * 同一个 bridge 上的最后一个 run 退出时才真正退订 core 的方法名。
 *
 * 未知 runId（核心认得的 run 宿主没挂 handler）原样把 messages 还回去：让 core 拿到一份
 * 跟它发来的一模一样的副本，比让它按超时/报错收场更省事。
 * @type {WeakMap<object, { handlers: Map<string, Function>, off: Function|null }>}
 */
const roundPrepareRuns = new WeakMap();

/**
 * @param {{ onCoreCall?: Function }} bridge
 * @param {string} runId
 * @param {(params: { runId?: string, round?: number, messages?: object[] }) => object} handler
 * @returns {() => void} 退订（幂等；只在最后一个 run 退出时真正摘掉 bridge 上的方法）
 */
function attachRoundPrepare(bridge, runId, handler) {
  if (!bridge || typeof bridge.onCoreCall !== 'function' || typeof handler !== 'function') {
    return () => {};
  }
  let entry = roundPrepareRuns.get(bridge);
  if (!entry) {
    entry = { handlers: new Map(), off: null };
    roundPrepareRuns.set(bridge, entry);
    entry.off = bridge.onCoreCall('round.prepare', (params) => {
      const inbound = params || {};
      const fn = entry.handlers.get(String(inbound.runId || ''));
      if (typeof fn !== 'function') return { messages: inbound.messages || null };
      return fn(inbound);
    });
  }
  entry.handlers.set(String(runId), handler);
  return () => {
    entry.handlers.delete(String(runId));
    if (entry.handlers.size) return;
    if (typeof entry.off === 'function') entry.off();
    entry.off = null;
    roundPrepareRuns.delete(bridge);
  };
}

/**
 * run 级「无进展」看门狗：只回答一个问题 —— **它最后一次有进展是什么时候、卡在哪一段**。
 *
 * 为什么需要它（2026-10-23→24，两次静默 11 小时 / 40 分钟）：主循环里的每个 await
 * （快照写库、`agent.run.start` / `agent.run.tools`、委托结果回填）都**没有时间维度**。
 * 任何一段挂住，现象都完全一样：没有下一轮请求、没有 trace、main.log 一行不写。
 * 工具段现在有 `toolStallMs` 兜（12min），但其余段此前是彻底的黑洞。
 *
 * 语义刻意保守：
 * - `warn` 只记一次日志（不刷屏、不改变行为）；
 * - `abort` 复用既有的取消路径（`agent.run.cancel`），不新造终止路径；
 * - 每次 `note()` 都会重置 warned —— 有进展就重新计时。
 */
function createRunStallWatchdog(opts = {}) {
  const warnMs = Number(opts.warnMs) > 0 ? Number(opts.warnMs) : 5 * 60 * 1000;
  const abortMs =
    Number(opts.abortMs) > 0 ? Number(opts.abortMs) : Math.max(warnMs, 45 * 60 * 1000);
  let stage = 'start';
  let at = Date.now();
  let warned = false;
  let aborted = false;

  return {
    /** 标记一次真实进展（进入新段 / 收到新相位都算）。 */
    note(nextStage) {
      if (typeof nextStage === 'string' && nextStage) stage = nextStage;
      at = Date.now();
      warned = false;
    },
    /** @returns {{ level: 'warn'|'abort', stage: string, idleMs: number, message: string } | null} */
    check(now = Date.now(), runId = '') {
      const idleMs = Math.max(0, now - at);
      if (idleMs < warnMs) return null;
      const head =
        `run=${runId || '?'} stage=${stage} idleMs=${idleMs}` +
        ` (${Math.round(idleMs / 1000)}s 无任何进展)`;
      if (!warned) {
        warned = true;
        return { level: 'warn', stage, idleMs, message: `RUN_STALL ${head}` };
      }
      if (!aborted && idleMs >= abortMs) {
        aborted = true;
        return {
          level: 'abort',
          stage,
          idleMs,
          message: `RUN_STALL_ABORT ${head} — 已调用 agent.run.cancel 收尾（不再是永远 running）`
        };
      }
      return null;
    },
    get stage() {
      return stage;
    },
    get idleMs() {
      return Date.now() - at;
    }
  };
}

/**
 * 运行 core 驱动的 agent loop（**驱动者是 core**：LLM 调用与轮次推进都在
 * `crates/dieyun-core/src/agent/driver.rs`，工具仍在 Node 执行）。
 *
 * 协议见 [`docs/AGENT-RUN-MIGRATION.md`](docs/AGENT-RUN-MIGRATION.md) §2：
 * - `agent.run.start` 跑到「要工具」就返回 `{phase:'need_tools', runId, delegates}`，
 *   否则返回 `{phase:'done', runId, content, trace, messages, hitRoundLimit}`；
 * - 宿主用 `executeDelegateBatch` 执行工具，再调 `agent.run.tools` 回填，直到 `done`；
 * - 流式增量由 core 经事件通道推来（`agent.delta`），宿主按 runId 过滤后转 `llm_delta`。
 *
 * @param {object} opts
 * @param {{ invoke: Function, onCoreEvent?: Function, abortPending?: Function }} opts.coreBridge
 * @param {{ baseUrl: string, apiKey: string, headers?: object, authMode?: string }} opts.llm
 * @param {object} opts.startParams `agent.run.start` 的业务入参（model / messages / tools / …）
 * @param {(phase: string, data: object) => void} [opts.onPhase]
 * @param {{ aborted?: boolean }} [opts.signal]
 * @param {(name: string, args: object) => Promise<object>} [opts.delegateTool]
 * @param {(messages: object[], ctx: object) => Promise<object>} [opts.compactMessages]
 *   只用到 `archiveFold`（折叠已由 core 完成，Node 只写遥测与归档）
 * @param {boolean} [opts.useStream]
 * @param {object} [opts.settings]
 * @param {string} [opts.userData]
 * @param {string} [opts.contextTierId]
 * @param {{ maxToolCalls?: number }} [opts.loopSpec]
 * @param {boolean} [opts.turnEndSynthesis] 聊天路径：空回复才补汇总；规划 worker 勿开
 * @param {string} [opts.sessionId] 请求快照的会话归属（缺省回落到 `llm.sessionId`）
 * @param {'chat'|'subagent'|'planner'|'plan'} [opts.runSource] 快照来源，仅用于事后归因
 * @param {object} [opts.contextAudit] Renderer 带下来的折叠/裁剪事实，原样落到快照
 * @param {boolean} [opts.browserVision] 是否为多模态模型：允许把浏览器截图 / 附件补看图片作为 image_url 注入
 * @param {Function} [opts.fetchSynthesisOnce] 可选：覆盖汇总 LLM（测试用）
 */
async function runRustAgentLoop(opts) {
  const bridge = opts.coreBridge;
  const llm = opts.llm || {};
  const signal = opts.signal || null;
  const useStream = opts.useStream !== false;
  const onPhase = typeof opts.onPhase === 'function' ? opts.onPhase : () => {};
  const compactMessages = typeof opts.compactMessages === 'function' ? opts.compactMessages : null;
  const delegateTool =
    typeof opts.delegateTool === 'function'
      ? opts.delegateTool
      : async (name, args) => ({ error: `delegate not implemented: ${name}`, args });

  const browserVision = opts.browserVision === true;

  // 闲时队列的忙碌信号：进入即计数，finally 必减（含 throw / abort 路径）。
  const loopTicket = {};
  activeLoops.add(loopTicket);

  let llmRound = 0;

  // run 级无进展看门狗（阈值只认 agent-limits，见 createRunStallWatchdog 注释）。
  const stallLimits = getAgentLimits(opts.userData, opts.contextTierId) || {};
  const runLog =
    typeof opts.log === 'function'
      ? opts.log
      : loopLogHook ||
        ((msg) => {
          try {
            console.warn(msg);
          } catch {
            /* ignore */
          }
        });
  const runStall = createRunStallWatchdog({
    warnMs: stallLimits.runStallWarnMs,
    abortMs: stallLimits.runStallAbortMs
  });
  let stallTimer = null;

  /**
   * runId **必须由宿主生成**并在 `agent.run.start` 里传入（见 §2.1）：
   * core 在 start 内部就开始推 `agent.delta`，宿主要在本轮发请求**之前**按 runId 订阅；
   * 等 core 返回再拿 id 就晚了 —— 第一轮增量必然丢。
   */
  const runId = `run-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

  /**
   * 请求快照写入器（每 run 一个，内部维护 system/tools 的 hash 游标做去重）。
   * session 归属：显式 `opts.sessionId` 优先，其次沿用 `llm.sessionId`（同样的会话标识
   * 已经用于 `x-opencode-session` 这类请求头，语义一致）。都没有就不写——匿名 run 无账可查。
   */
  const snapshotWriter = createRequestSnapshotWriter({
    invoke: (method, params, timeoutMs) => bridge.invoke(method, params, timeoutMs),
    sessionId: opts.sessionId || (llm && llm.sessionId) || '',
    source: opts.runSource || SNAPSHOT_SOURCES.CHAT,
    limits: resolveSnapshotLimits(opts.userData, opts.contextTierId)
  });

  /**
   * 留底「这一份请求」。失败只记日志、不影响主链路。
   *
   * 两件事让它不至于变成主链路的刹车：
   * 1. 已取消就根本不写（DB 慢时不该让"停止"再等一个超时）；
   * 2. 写的同时盯着取消信号，用户点停止立刻走。
   */
  const writeRequestSnapshot = async (sendBody, roundOverride) => {
    if (!snapshotWriter.enabled) return;
    if (signal && signal.aborted) return;
    try {
      await raceAbortable(
        snapshotWriter.write({
          body: sendBody,
          runId,
          round: roundOverride == null ? llmRound : Number(roundOverride),
          reason: SNAPSHOT_REASONS.INITIAL,
          compaction: null,
          contextAudit: Number(roundOverride || 0) === 0 ? opts.contextAudit || null : null
        }),
        signal
      );
    } catch (err) {
      if (isAbortError(err)) throw err;
      // write 内部已经只记一次日志，这里不再放大
    }
  };

  const loopSpec = opts.loopSpec || resolveAgentLoopSpec(opts.settings, opts.userData, opts.contextTierId);
  // 折叠预算（窗口 → 预算 → 扣工具 schema）仍只在 compaction-main 一处算；
  // 传进 startParams 后由 core 自己折（transcript 归它所有）。
  const foldSpec =
    opts.foldSpec ||
    resolveFoldSpec({
      userData: opts.userData,
      model: opts.startParams && opts.startParams.model,
      contextTierId: opts.contextTierId,
      toolsChars: toolsJsonChars((opts.startParams && opts.startParams.tools) || [])
    });
  const startParams = applyResolvedLoopSpec(opts.startParams, loopSpec, foldSpec);

  // 端点与请求头仍是 `llm-request.js` 的单一来源；core 只负责发出去。
  const url = resolveChatUrl(llm.baseUrl);
  const headers = buildChatHeaders(llm, runId);
  const model = String(startParams.model || '');
  // content 的通道身份：由能力表按模型声明一次，随每个 llm_delta / start 下发。
  const policy = getChannelPolicy(model);
  const contentChannel = policy.singleChannel ? 'reasoning' : 'answer';
  const hasTools = Array.isArray(startParams.tools) && startParams.tools.length > 0;

  /**
   * start / tools 两条调用的公共传输参数（单一来源，勿在调用点各拼一份）。
   * `includeRaw` 只在 `DIEYUN_LLM_RAW_LOG` 打开时要 —— 是否回传由 core 决定。
   */
  const transport = () => ({
    runId,
    url,
    stream: !!useStream,
    llm: {
      baseUrl: (llm && llm.baseUrl) || '',
      apiKey: (llm && llm.apiKey) || '',
      headers,
      authMode: (llm && llm.authMode) || ''
    },
    contentChannel,
    includeRaw: llmRawTapEnabled()
  });

  let phase = null;
  /** `round.prepare` 的退订器（finally 必调：否则方法名会挂着上一个 run 的 handler）。 */
  let detachRoundPrepare = () => {};
  /** 本轮的累积增量（core 推的是增量，UI 要的是累积值）。 */
  let deltaContent = '';
  let deltaReasoning = '';

  /**
   * 视觉注入（**逐轮**，唯一实现）：把本轮新产出的浏览器截图 / 附件补看图拼成一条 user 消息。
   *
   * 取样口是 `browser-vision` 的待注入队列（按 runId，取走即清）：这一轮中途产出的图
   * 这一轮就能看到 —— 因为调用点从「回合开始一次」变成了 core 每发请求前一次。
   *
   * @returns {{ messages: object[], injected: number }} `injected` 是张数（0 表示没注入）
   */
  const withVision = (messages, round) => {
    if (!browserVision || !Array.isArray(messages)) return { messages, injected: 0 };
    const images = takePendingVisionImages(runId);
    if (!images.length) return { messages, injected: 0 };
    const browserCount = images.filter((s) => s && s.source === SOURCE_BROWSER).length;
    const attachmentCount = images.filter((s) => s && s.source === SOURCE_ATTACHMENT).length;
    const mcpCount = images.filter((s) => s && s.source === SOURCE_MCP).length;
    if (browserCount) {
      onPhase('browser_vision_injected', { runId, round, count: browserCount });
    }
    if (attachmentCount) {
      onPhase('attachment_vision_injected', { runId, round, count: attachmentCount });
    }
    if (mcpCount) {
      onPhase('mcp_vision_injected', { runId, round, count: mcpCount });
    }
    const visionMessage = buildVisionMessage(images);
    if (!visionMessage) return { messages, injected: 0 };
    return { messages: [...messages, visionMessage], injected: images.length };
  };

  /**
   * **一次请求**用 messages 副本的唯一装配点（顺序即语义）：
   * 1. 摘掉历史里残留的非法 inline 图片（旧版本落库，或 Renderer 侧清洗降级放行）；
   * 2. 请求长度硬上限（`llmRequestMaxChars`）—— 请求级策略，与压缩触发线无关；
   * 3. 视觉注入（`withVision`）；
   * 4. 思考回传补全（`reasoning_content`，能力表声明）。
   *
   * 只作用于副本：transcript 归 core（`loop_run`），这里的任何裁剪都不会回写账本 ——
   * 宿主没有账本写入口（docs/AGENT-RUN-MIGRATION.md §5 负向清单）。
   */
  const prepareRequestMessages = (baseMessages, round) => {
    const body = {
      messages: Array.isArray(baseMessages) ? [...baseMessages] : [],
      tools: Array.isArray(startParams.tools) ? startParams.tools : []
    };
    if (sanitizeChatBodyImagesForApi(body)) {
      onPhase('llm_images_sanitized', { runId, round });
    }
    applyLlmMessageCharCap(body, opts.userData, opts.contextTierId);
    const vision = withVision(body.messages, round);
    return {
      messages: backfillReasoningContent(vision.messages, hasTools, !!policy.echoReasoning),
      visionInjected: vision.injected
    };
  };

  /** 溢出兜底：折叠已经是 core 的内部动作，Node 只能如实停下并说明（不假装成功）。 */
  const stopForOverflow = async (extra = {}) => {
    onPhase('turn_overflow_stopped', { runId, round: llmRound, ...extra });
    await abortSidecarRun(bridge, runId);
    return {
      phase: 'done',
      runId,
      content: String(deltaContent || ''),
      overflowStopped: true
    };
  };

  // 订阅必须在 `agent.run.start` **之前**：否则第一轮增量丢。
  const unsubscribeEvents =
    typeof bridge.onCoreEvent === 'function'
      ? bridge.onCoreEvent((event) => {
          if (!event) return;
          if (String(event.runId || '') !== runId) return;
          // 每轮 usage：core 以事件回流（账本不带供应商口径），成本统计只认这里
          if (event.type === 'agent.usage') {
            if (event.usage) {
              try {
                recordLlmUsage(event.usage, event.model || (startParams && startParams.model) || '');
              } catch {
                // 记账失败不影响主链路
              }
            }
            return;
          }
          if (event.type !== 'agent.delta') return;
          if (event.content) deltaContent += String(event.content);
          if (event.reasoning) deltaReasoning += String(event.reasoning);
          runStall.note('llm_delta');
          onPhase('llm_delta', {
            runId,
            round: event.round != null ? Number(event.round) : llmRound,
            content: deltaContent,
            reasoning: deltaReasoning,
            contentChannel,
            hasToolCalls: false
          });
        })
      : () => {};

  try {
    // 30s 采样：warn 只记一次；到 abort 阈值用既有的取消路径收尾。
    // 只在**主循环**里跑：`while` 的每个 await 都是它盯着的对象。
    stallTimer = setInterval(() => {
      const hit = runStall.check(Date.now(), runId);
      if (!hit) return;
      runLog(hit.message);
      if (hit.level === 'abort') {
        void bridge.invoke('agent.run.cancel', { runId }).catch(() => {});
      }
    }, 30000);
    if (stallTimer && typeof stallTimer.unref === 'function') stallTimer.unref();

    // `round.prepare` 必须在 `agent.run.start` **之前**挂上：core 在第一轮请求前就会问，
    // 晚了这一轮就拿不到注入（视觉 / 请求裁剪都要等下一次 run 才生效）。
    detachRoundPrepare = attachRoundPrepare(bridge, runId, async ({ round, messages } = {}) => {
      // round 是账本事实（core 给的）；老 core 没带就退回宿主自己的计数
      const roundNo = round == null ? llmRound : Number(round);
      const prepared = prepareRequestMessages(messages, roundNo);
      // 快照记**这一个请求真正发出去的形态**：装配（裁剪 / 视觉注入 / 思考回填）就发生在
      // 这里，之前的「回合开始记一份账本种子」看不出这一轮注入了什么。
      runStall.note('llm_snapshot');
      await writeRequestSnapshot(
        { model, messages: prepared.messages, tools: startParams.tools || [] },
        roundNo
      ).catch(() => {});
      // 拿不到视觉能力（非多模态 / 未开 browserVision）时只回 messages，别谎报张数
      if (!browserVision) return { messages: prepared.messages };
      return { messages: prepared.messages, visionInjected: prepared.visionInjected };
    });

    // 账本种子就是宿主给的原文：请求级装配（裁剪 / 视觉注入 / 思考回填）已全部挪到
    // `round.prepare`，这里再处理一遍就是第二个装配点。
    if (!Array.isArray(startParams.messages)) startParams.messages = [];

    onPhase('start', { runId, model });

    /** 上一轮工具结果：非空表示下一次该调 `agent.run.tools` 回填。 */
    let pendingResults = null;
    while (true) {
      await throwIfCancelled(bridge, runId, signal);
      deltaContent = '';
      deltaReasoning = '';
      onPhase('llm_request', { runId, model, round: llmRound });

      const method = pendingResults ? 'agent.run.tools' : 'agent.run.start';
      const params = pendingResults
        ? { results: pendingResults, ...transport() }
        : { ...startParams, ...transport() };
      runStall.note(method);
      phase = await invokeRunRpc(bridge, method, params, signal);
      runStall.note(`agent_run_${(phase && phase.phase) || 'unknown'}`);

      // 折叠是 core 的事：这里只消费它交上来的事实（UI / 遥测 / 归档）。
      await handleFoldFact({
        fact: phase && phase.compacted,
        compactMessages,
        runId,
        round: llmRound,
        onPhase,
        userData: opts.userData,
        sessionId: opts.sessionId
      });

      const delegates = Array.isArray(phase && phase.delegates) ? phase.delegates : [];
      const needTools = !!phase && phase.phase === 'need_tools';
      // 本轮收尾：toolCalls>0 时 UI 把流式正文挂成轮次旁白，=0 时把回答区切到正文阶段。
      onPhase('llm_response', {
        runId,
        round: llmRound,
        toolCalls: needTools ? delegates.length : 0,
        model,
        content: deltaContent,
        reasoning: deltaReasoning,
        persistRound: true
      });
      llmRound += 1;

      if (!needTools) break;

      onPhase('delegate_start', { runId, delegates });
      runStall.note('delegate');
      // 工具段是唯一能长时间没有回音的地方（其余段都有超时）。先记「谁在跑」：
      // trace 只写**已完成**的工具，挂住的那个名字在库里看不见，RUN_STALL 又只报 stage=delegate。
      runLog(
        `工具执行: ${delegates.map((d) => (d && d.name) || 'tool').join(', ') || '（空）'}`
      );
      pendingResults = capDelegateResults(
        await executeDelegateBatch(delegates, delegateTool, onPhase, runId, signal),
        (getAgentLimits(opts.userData, opts.contextTierId) || {}).toolResultMaxJson
      );
      await throwIfCancelled(bridge, runId, signal);
    }

    if (!phase || phase.phase !== 'done') {
      throw new Error(phase?.message || `agent.run 未知阶段: ${phase?.phase || 'null'}`);
    }
    // 账本以宿主给的 runId 为准；若 core 没回（老版本），补上一份，下游按 runId 归因。
    onPhase('done', { ...phase, runId: phase.runId || runId });

    if (opts.turnEndSynthesis) {
      return applyTurnEndSynthesis({
        done: phase,
        llm,
        signal,
        onPhase,
        userData: opts.userData,
        model: model || startParams.model,
        fetchSynthesisOnce: opts.fetchSynthesisOnce
      });
    }
    return phase;
  } catch (err) {
    if (isCancelledRpcError(err)) {
      await abortSidecarRun(bridge, runId);
      throw createAbortError();
    }
    if (isContextOverflowError(err)) {
      // 溢出 = 估算已不准：折叠现在在 core 内部（发请求之前），Node 没有第二次机会。
      return await stopForOverflow({ llmError: String(err.message || err) });
    }
    onPhase('loop_failed', {
      checkpoint: {
        runId,
        model,
        messages: Array.isArray(startParams.messages) ? startParams.messages : [],
        tools: Array.isArray(startParams.tools) ? startParams.tools : []
      },
      error: err.message || String(err)
    });
    throw err;
  } finally {
    activeLoops.delete(loopTicket);
    if (stallTimer) clearInterval(stallTimer);
    unsubscribeEvents();
    detachRoundPrepare();
    if (browserVision) clearPendingVisionImages(runId);
  }
}

function resolveChatUrl(baseUrl) {
  // 端点拼接的单一来源是 llm-request.js（裸 host 补 /v1、已含版本段只补资源路径、
  // Azure 的 ?api-version= 查询串不二次拼接）；此处仅负责本模块的「必填」语义。
  const url = resolveLlmEndpoint(baseUrl, 'chat');
  if (!url) throw new Error('LLM baseUrl 未配置');
  return url;
}

module.exports = {
  runRustAgentLoop,
  createRunStallWatchdog,
  setLoopRunnerLog,
  getActiveAgentLoopCount,
  resolveChatUrl,
  applyResolvedLoopSpec,
  backfillReasoningContent
};
