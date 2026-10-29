'use strict';

const { chatCompletionJson } = require('../llm-proxy');
const { streamChatCompletionMain, mergeMissingReasoning } = require('../llm-stream-utils');
const { enrichLlmToolCalls } = require('../llm-tool-call-fallback');
const {
  runWithLlmReconnectRetry,
  raceAbortable,
  createAbortError,
  isAbortError,
  isContextOverflowError
} = require('../llm-reconnect-retry');
const { recordLlmUsage } = require('./llm-usage-recorder');
const { estimateLlmRoundUsage } = require('../llm-usage-stats');
const { resolveAgentLoopSpec, getAgentLimits, AGENT_LIMITS_DEFAULTS } = require('./agent-limits');
// 请求快照：本循环是「发请求」的唯一位置，因此也是快照的**唯一写入点**（见 docs/REQUEST-SNAPSHOT.md）。
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
const {
  sanitizeChatBodyImagesForApi,
  isLlmImageRejectedError,
  parseRejectedImageMessageIndices,
  dropRejectedChatImagesForApi
} = require('./guardrails-shared');

const { executeDelegateBatch } = require('./delegate-batch');
const { applyTurnEndSynthesis } = require('./agent-synthesis');
const { buildLlmHeadersFromConfig, resolveLlmEndpoint } = require('./llm-request');
const { getChannelPolicy } = require('./llm-channel');
// 思考占位补全的单一来源（Renderer 经 agent-bundle 消费同一份）。
const { backfillReasoningContent } = require('./reasoning-backfill');

const LOOP_START_TIMEOUT_MS = 30000;
const LOOP_SET_MESSAGES_TIMEOUT_MS = 30000;
const LOOP_CONTINUE_TIMEOUT_MS = 600000;
const LOOP_TOOL_RESULTS_TIMEOUT_MS = 300000;
/**
 * 单轮请求里「图片被上游拒绝」最多自愈几次：第一次按上游给的 `.messages[N].image[M]`
 * 定位丢图，第二次（定位对不上时）丢光本轮全部图并不再注入视觉缓冲。
 */
const MAX_IMAGE_REPAIRS_PER_ROUND = 2;

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

async function capAndSyncLoopMessages(body, runId, signal, bridge, userData, tierId) {
  // 账本自愈：历史里残留的非法图片（旧版本落库，或 Renderer 侧清洗降级放行）
  // 在此剔除并随 set_messages 回写，避免每轮都重发同一张废图换回上游 400。
  const imagesSanitized = sanitizeChatBodyImagesForApi(body);
  if (!applyLlmMessageCharCap(body, userData, tierId) && !imagesSanitized) return false;
  if (!runId) return imagesSanitized;
  await invokeLoopRpc(
    bridge,
    'agent.loop.set_messages',
    { runId, messages: body.messages },
    LOOP_SET_MESSAGES_TIMEOUT_MS,
    signal
  );
  return imagesSanitized;
}

/**
 * `agent.loop.start` 的唯一填参口：把 `agent-limits` 解析出的护栏数字补进 startParams。
 *
 * Rust 内核不再自带 `maxToolCalls=150` / `maxRounds=96` 兜底（跨语言复制数字会静默分叉），
 * 缺参即 `INVALID_PARAMS` —— 所以两个数字必须在这一处补齐，而不是散在各调用点。
 */
function applyResolvedLoopSpec(startParams, spec) {
  const out = { ...(startParams || {}) };
  for (const key of ['maxToolCalls', 'maxRounds']) {
    const resolved = spec && spec[key];
    if ((out[key] == null || out[key] === '') && resolved != null && resolved !== '') {
      out[key] = resolved;
    }
  }
  return out;
}

function recordLlmRoundUsage(body, llmResp) {
  const model = body?.model;
  if (llmResp?.usage) {
    recordLlmUsage(llmResp.usage, model);
    return;
  }
  const est = estimateLlmRoundUsage(body, llmResp);
  if (est) recordLlmUsage(est, model);
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

function abortSidecarRun(bridge, runId) {
  if (!bridge || !runId) return Promise.resolve();
  if (typeof bridge.abortPending === 'function') {
    bridge.abortPending({ runId, reason: '已停止' });
  }
  if (typeof bridge.invoke !== 'function') return Promise.resolve();
  return bridge.invoke('agent.loop.cancel', { runId }).catch(() => {});
}

function abortCompactOnly(bridge, runId) {
  if (!bridge || typeof bridge.abortPending !== 'function') return;
  bridge.abortPending({
    runId: runId || undefined,
    methods: ['compaction.maybe_compact'],
    reason: '已停止'
  });
}

async function throwIfCancelled(bridge, runId, signal) {
  if (!signal?.aborted) return;
  await abortSidecarRun(bridge, runId);
  throw createAbortError();
}

async function invokeLoopRpc(bridge, method, params, timeoutMs, signal) {
  const runId = params && params.runId;
  try {
    return await raceAbortable(
      bridge.invoke(method, params, timeoutMs),
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
 * 每轮 need_llm 都无条件问一次压缩（不再做 Node 侧预判）。
 *
 * 「是否压缩、是否在冷却」的唯一决策点是 Rust `compaction::maybe_compact`：
 * 它在 prepare 里按触发比与 compactionRoundCount 判定，未达阈值就直接早退
 * —— 不调 LLM、不改账本、messages 原样返回，Node 只负责搬运与 set_messages。
 * 这里删掉的是旧的条数 / 字符比预判：那套口径拿不到真 token 账本，必然会和
 * Rust 分叉（模型自带窗口、图片等效字符、工具 schema 扣减都会让两边不一致）。
 * @param {boolean} [force] 溢出兜底：要求 Rust 忽略触发比与冷却强制压一次
 */
async function maybeCompactRound({
  compactMessages,
  body,
  llmRound,
  runId,
  signal,
  bridge,
  onPhase,
  apiConfig,
  force
}) {
  if (!compactMessages || !Array.isArray(body.messages)) return { compacted: false };
  let cr;
  try {
    cr = await raceAbortable(
      compactMessages(body.messages, {
        runId,
        round: llmRound,
        signal,
        force: !!force,
        // 压缩必须与主链路同配置（自定义头 / 会话标识随 apiConfig 透传），
        // 否则会出现「对话正常、压缩先撞上游 4xx」的割裂现象。
        apiConfig,
        sessionId: apiConfig && apiConfig.sessionId,
        // 工具 schema 不计入 messages，但占真实窗口；交给压缩层从预算里扣
        toolsChars: toolsJsonChars(body.tools)
      }),
      signal,
      () => {
        abortCompactOnly(bridge, runId);
        if (signal?.aborted) abortSidecarRun(bridge, runId);
      }
    );
  } catch (err) {
    if (isCancelledRpcError(err)) {
      await abortSidecarRun(bridge, runId);
      throw createAbortError();
    }
    onPhase('compact_skipped', {
      runId,
      reason: 'llm_error',
      llmError: String((err && err.message) || err || 'compaction failed')
    });
    return { compacted: false, skipped: true };
  }
  await throwIfCancelled(bridge, runId, signal);
  if (cr && (cr.compactionSkipped || cr.llmError) && !cr.compacted) {
    onPhase('compact_skipped', {
      runId,
      reason: cr.compactionSkipped || 'llm_error',
      llmError: cr.llmError || undefined
    });
    return { compacted: false, skipped: true, reason: cr.compactionSkipped };
  }
  if (!(cr && cr.compacted && Array.isArray(cr.messages))) {
    return { compacted: false, ...compactionFacts(cr) };
  }
  body.messages = cr.messages;
  await invokeLoopRpc(
    bridge,
    'agent.loop.set_messages',
    { runId, messages: cr.messages },
    LOOP_SET_MESSAGES_TIMEOUT_MS,
    signal
  );
  onPhase('compacted', {
    runId,
    tokensBefore: cr.tokensBefore,
    tokensAfter: cr.tokensAfter
  });
  return {
    compacted: true,
    tokensBefore: cr.tokensBefore,
    tokensAfter: cr.tokensAfter,
    // 归档行 id 由调用方的 compactMessages 闭包回填（它才知道 archive 写没写成）；
    // 拿不到就为 null —— 快照里宁可空着，也不编一个 id。
    archiveId: cr.compactionArchiveId != null ? cr.compactionArchiveId : null,
    ...compactionFacts(cr)
  };
}

/**
 * 压缩判定的事实（预算 / 触发比 / 冷却计数）：快照要用它们回答「这轮为什么没压」。
 * 只搬不判：数字全部由 compaction-main 给（它才是唯一算预算的地方）。
 */
function compactionFacts(cr) {
  if (!cr || typeof cr !== 'object') return {};
  /** @type {{ tokenBudget?: number, triggerRatio?: number, compactionRoundCount?: number }} */
  const out = {};
  const budget = Number(cr.tokenBudget);
  if (Number.isFinite(budget) && budget > 0) out.tokenBudget = budget;
  const ratio = Number(cr.triggerRatio);
  if (Number.isFinite(ratio) && ratio > 0) out.triggerRatio = ratio;
  const rounds = Number(cr.compactionRoundCount);
  if (Number.isFinite(rounds) && rounds >= 0) out.compactionRoundCount = rounds;
  return out;
}

/** 一次压缩判定的快照行（压没压都记，事实取自 compaction-main）。 */
function snapshotOfCompaction(result) {
  const r = result && typeof result === 'object' ? result : {};
  return {
    compacted: !!r.compacted,
    tokensBefore: r.tokensBefore,
    tokensAfter: r.tokensAfter,
    archiveId: r.archiveId != null ? r.archiveId : null,
    ...compactionFacts(r)
  };
}

/**
 * 一轮 LLM 请求的请求头（单一来源 llm-request.js）。
 *
 * 变量分工（关系上游缓存命中，勿混）：
 *   - `sessionId`：**同一对话稳定**，用于会话级标识（如 x-opencode-session）→ 上游可据此命中 prompt 缓存；
 *   - `runId`    ：每轮不同，用于「每轮唯一」的追踪头。
 * 供应商自定义头里的 `{{sessionId}}` / `{{runId}}` / `{{model}}` 即取自此。
 */
function buildChatHeaders(llm, runId) {
  return buildLlmHeadersFromConfig(llm, { runId });
}

/**
 * @param {object} [tag] 抓包归属标签（透传 llm-raw-tap；仅 `DIEYUN_LLM_RAW_LOG` 打开时落盘）
 */
async function completeNonStreamChat(url, headers, body, signal, tag) {
  const sendBody = { ...body, stream: false };
  const json = await chatCompletionJson(url, {
    headers,
    body: JSON.stringify(sendBody),
    signal,
    tag
  });
  return normalizeLlmResponse(json);
}

/**
 * 诊断：上游因 reasoning_content 报 400 时，把本次请求的消息形态附到错误信息里，
 * 便于判断是「客户端漏传」还是「中间代理吞字段」。仅诊断，不改变行为。
 */
function markReasoningDiag(err, body) {
  try {
    const msg = String((err && err.message) || '');
    if (!/reasoning_content/i.test(msg) || msg.includes('[diag ')) return;
    const msgs = Array.isArray(body && body.messages) ? body.messages : [];
    const assistants = msgs.filter((m) => m && m.role === 'assistant');
    const missing = assistants.filter(
      (m) => !(typeof m.reasoning_content === 'string' && m.reasoning_content.trim())
    );
    const tools = Array.isArray(body && body.tools) ? body.tools.length : 0;
    err.message = `${msg} [diag tools=${tools} msgs=${msgs.length} assistant=${assistants.length} missingReasoning=${missing.length} missingWithToolCalls=${missing.filter((m) => Array.isArray(m.tool_calls) && m.tool_calls.length).length}]`;
  } catch {
    /* 诊断失败不影响原错误 */
  }
}

async function fetchLlmRound({
  bridge,
  runId,
  body,
  llm,
  signal,
  useStream,
  firstTokenTimeoutMs,
  streamIdleTimeoutMs,
  llmRound,
  onPhase,
  fetchLlmOnce: fetchOverride,
  reconnectOpts
}) {
  const url = resolveChatUrl(llm.baseUrl);
  const headers = buildChatHeaders(llm, runId);
  const hasTools = Array.isArray(body.tools) && body.tools.length > 0;
  // content 的通道身份：由能力表按模型声明一次，随每个 llm_delta 下发。
  // 展示层（live-loop-trace / plan-run-events / renderer-agent-rust-loop）只搬运，
  // 不再各自用 `reasoning || contentOnly` 猜 content 是正文还是思考。
  const policy = getChannelPolicy(body && body.model);
  const contentChannel = policy.singleChannel ? 'reasoning' : 'answer';
  const requestBody = {
    ...body,
    // 思考回传：真值优先取账本 `reasoning`，真值不可得才补占位；回传面由能力表统一声明。
    messages: backfillReasoningContent(body.messages, hasTools, !!policy.echoReasoning)
  };
  let frozenPartial = { content: '', reasoning: '' };
  /**
   * 抓包归属标签（仅 `DIEYUN_LLM_RAW_LOG` 打开时落盘）。
   * 没有 runId/round 的话，抓下来的一堆原始响应体无从对回到某一轮，
   * 也就没法回答「这段文字出自哪一轮的哪个字段」。
   */
  const rawTapTag = { runId, round: llmRound, model: body && body.model };

  const capturePartial = (err) => {
    if (err && err.partial) {
      frozenPartial = {
        content: err.partial.content || frozenPartial.content,
        reasoning: err.partial.reasoning || frozenPartial.reasoning
      };
    }
  };

  const fetchLlmOnce = async () => {
    onPhase('llm_request', { runId, model: body.model, round: llmRound });
    if (typeof fetchOverride === 'function') {
      try {
        const overrideResp = await fetchOverride({
          body,
          url,
          headers,
          signal,
          useStream,
          firstTokenTimeoutMs,
          tag: rawTapTag,
          onDelta: (delta) => {
            onPhase('llm_delta', {
              runId,
              round: llmRound,
              content: delta.content || '',
              reasoning: delta.reasoning || '',
              contentChannel,
              hasToolCalls: !!delta.hasToolCalls
            });
          }
        });
        return mergeMissingReasoning(overrideResp, frozenPartial);
      } catch (err) {
        capturePartial(err);
        throw err;
      }
    }
    if (useStream) {
      try {
        const streamResp = await streamChatCompletionMain(requestBody, {
          url,
          headers,
          apiKey: llm.apiKey,
          signal,
          firstTokenTimeoutMs,
          idleTimeoutMs: streamIdleTimeoutMs,
          tag: rawTapTag,
          onDelta: (delta) => {
            onPhase('llm_delta', {
              runId,
              round: llmRound,
              content: delta.content || '',
              reasoning: delta.reasoning || '',
              contentChannel,
              hasToolCalls: !!delta.hasToolCalls
            });
          }
        });
        return mergeMissingReasoning(streamResp, frozenPartial);
      } catch (streamErr) {
        capturePartial(streamErr);
        if (isAbortError(streamErr) || (streamErr && streamErr.name === 'AbortError')) {
          throw streamErr;
        }
        const streamMsg = String((streamErr && streamErr.message) || streamErr || '');
        if (/ETIMEDOUT/i.test(streamMsg)) {
          throw streamErr;
        }
        onPhase('llm_stream_fallback', { runId, error: streamErr.message || String(streamErr) });
        const jsonResp = await completeNonStreamChat(url, headers, requestBody, signal, rawTapTag);
        return mergeMissingReasoning(jsonResp, frozenPartial);
      }
    }
    return mergeMissingReasoning(
      await completeNonStreamChat(url, headers, requestBody, signal, rawTapTag),
      frozenPartial
    );
  };

  const reconnect = reconnectOpts || {
    signal,
    onWait: (info) => onPhase('llm_reconnect_wait', { runId, round: llmRound, ...info })
  };

  let llmResp;
  try {
    llmResp = await raceAbortable(
      runWithLlmReconnectRetry(fetchLlmOnce, reconnect),
      signal,
      () => abortSidecarRun(bridge, runId)
    );
  } catch (err) {
    markReasoningDiag(err, requestBody);
    if (isContextOverflowError(err)) throw err;
    if (
      !isAbortError(err) &&
      (String(frozenPartial.reasoning || '').trim() || String(frozenPartial.content || '').trim())
    ) {
      // 重连耗尽但已收到部分内容：把它当作本轮响应继续走正常通道（llm_response），
      // 因此不需要额外的「已恢复」事件通知。
      llmResp = mergeMissingReasoning(
        { content: frozenPartial.content || '', reasoning: frozenPartial.reasoning || '', toolCalls: [] },
        frozenPartial
      );
    } else {
      throw err;
    }
  }

  llmResp = enrichLlmToolCalls(llmResp);
  recordLlmRoundUsage(body, llmResp);

  if (llmResp.incompleteToolMarkup || llmResp.incompleteJsonToolCalls) {
    onPhase('llm_incomplete_tool_markup', { runId, round: llmRound });
    const json = await raceAbortable(
      runWithLlmReconnectRetry(
        () =>
          chatCompletionJson(url, {
            headers,
            body: JSON.stringify({ ...requestBody, stream: false }),
            signal,
            tag: rawTapTag
          }),
        reconnect
      ),
      signal,
      () => abortSidecarRun(bridge, runId)
    );
    llmResp = normalizeLlmResponse(json);
    recordLlmRoundUsage(body, llmResp);
    if (
      (llmResp.incompleteToolMarkup || llmResp.incompleteJsonToolCalls) &&
      !(llmResp.toolCalls && llmResp.toolCalls.length)
    ) {
      throw new Error('模型输出了无法解析的工具调用 markup');
    }
  }

  // 通道身份随账本一起交给 Rust：`content` 键属于正文还是思考由能力表（入口）决定，
  // Rust 不再用「长度 ≥24 且不含 <tool_call」这类启发式猜（§3.3）。
  // 这里只**标注**、不搬迁字段：`llmResp.content` 的既有消费方（UI 的 llm_response、
  // 压缩回退）不受影响；账本层的分流由 Rust 依据 `contentChannel` 完成。
  llmResp = { ...llmResp, contentChannel };
  return llmResp;
}

/**
 * 运行 Rust agent loop（LLM 在 Node，工具全部 delegate 回 Node）。
 * @param {object} opts
 * @param {{ invoke: Function }} opts.coreBridge
 * @param {{ baseUrl: string, apiKey: string }} opts.llm
 * @param {object} opts.startParams agent.loop.start params
 * @param {(phase: string, data: object) => void} [opts.onPhase]
 * @param {{ aborted?: boolean }} [opts.signal]
 * @param {(name: string, args: object) => Promise<object>} [opts.delegateTool]
 * @param {(messages: object[], ctx: object) => Promise<{ messages: object[], compacted?: boolean }>} [opts.compactMessages]
 * @param {boolean} [opts.useStream]
 * @param {object} [opts.settings]
 * @param {string} [opts.userData]
 * @param {string} [opts.contextTierId]
 * @param {{ maxToolCalls?: number, firstTokenTimeoutMs?: number, streamIdleTimeoutMs?: number }} [opts.loopSpec]
 * @param {Function} [opts.fetchLlmOnce] 可选：覆盖本轮 LLM 请求（测试用）
 * @param {boolean} [opts.turnEndSynthesis] 聊天路径：空回复才补汇总；规划 worker 勿开
 * @param {string} [opts.sessionId] 请求快照的会话归属（缺省回落到 `llm.sessionId`）
 * @param {'chat'|'subagent'|'planner'|'plan'} [opts.runSource] 快照来源，仅用于事后归因
 * @param {object} [opts.contextAudit] Renderer 带下来的折叠/裁剪事实，原样落到快照
 * @param {boolean} [opts.browserVision] 是否为多模态模型：允许把浏览器截图 / 附件补看图片作为 image_url 注入下一轮
 * @param {Function} [opts.fetchSynthesisOnce] 可选：覆盖汇总 LLM（测试用）
 */
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
 * run 级「无进展」看门狗：只回答一个问题 —— **它最后一次有进展是什么时候、卡在哪一段**。
 *
 * 为什么需要它（2026-10-23→24，两次静默 11 小时 / 40 分钟）：`while (phase !== 'done')`
 * 里的每个 await（压缩判定、快照写库、`agent.loop.continue`、委托结果回填）都**没有时间维度**。
 * 任何一段挂住，现象都完全一样：没有下一轮请求、没有 trace、main.log 一行不写。
 * 工具段现在有 `toolStallMs` 兜（12min），但其余段此前是彻底的黑洞。
 *
 * 语义刻意保守：
 * - `warn` 只记一次日志（不刷屏、不改变行为）；
 * - `abort` 复用既有的 `agent.loop.cancel`，不新造终止路径；
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
          message: `RUN_STALL_ABORT ${head} — 已调用 agent.loop.cancel 收尾（不再是永远 running）`
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
  /** 本次发送之前刚发生过的压缩结论（写进这条快照后即清空，避免记到后续轮次）。 */
  let snapshotCompaction = null;
  let snapshotReason = SNAPSHOT_REASONS.INITIAL;
  /**
   * 留底「这一份请求」。失败只记日志、不影响主链路；await 是为了保证
   * 同一轮内的多次发送（溢出重发 / 图片重发）在库里顺序正确。
   *
   * 两件事让它不至于变成主链路的刹车：
   * 1. 已取消就根本不写（DB 慢时不该让"停止"再等一个超时）；
   * 2. 写的同时盯着取消信号，用户点停止立刻走。
   */
  const writeRequestSnapshot = async (sendBody, runId) => {
    if (!snapshotWriter.enabled) return;
    if (signal && signal.aborted) return;
    try {
      await raceAbortable(
        snapshotWriter.write({
          body: sendBody,
          runId: runId || '',
          round: llmRound,
          reason: snapshotReason,
          compaction: snapshotCompaction,
          // 折叠/裁剪的审计只描述「首次装配」的那一份；后续轮的 body 来自账本，
          // 把它复制到每一行会让 messageCount 与 audit.messagesOut 对不上。
          contextAudit: Number(llmRound) === 0 ? opts.contextAudit || null : null
        }),
        signal
      );
    } catch (err) {
      if (isAbortError(err)) throw err;
      // write 内部已经只记一次日志，这里不再放大
    }
    snapshotCompaction = null;
    snapshotReason = SNAPSHOT_REASONS.INITIAL;
  };

  let lastCheckpoint = null;
  // 本轮 run 是否已用掉「溢出强制压缩」这一次重试：预检真压过、或强压已经试过
  // （无论成败）都置位 —— 再次溢出只停不重试，否则会每轮空转一次注定失败的压缩。
  // 注意预检未压成时**不**置位（那次 chance 留给真溢出时的强制压缩）。
  // 成败与跳过原因单独记在 overflowCompaction，供停止文案如实说明。
  let overflowCompactionAttempted = false;
  let overflowCompaction = null;
  let activeRunId = '';
  let lastAssistantContent = '';

  const loopSpec = opts.loopSpec || resolveAgentLoopSpec(opts.settings, opts.userData, opts.contextTierId);
  const startParams = applyResolvedLoopSpec(opts.startParams, loopSpec);
  const firstTokenTimeoutMs = loopSpec.firstTokenTimeoutMs;
  // 流式「包间隔」容忍时长（上游断流多久算瞬时错误 → 交给重连层）
  const streamIdleTimeoutMs = loopSpec.streamIdleTimeoutMs;
  const reconnectOptsBase = {
    signal,
    maxRetries: loopSpec.llmMaxRetries,
    baseDelayMs: loopSpec.llmRetryBaseMs,
    maxDelayMs: loopSpec.llmMaxRetryDelayMs,
    // 时间驱动：默认 30 分钟持续重连，不再要求用户手动点继续
    maxWaitMs: loopSpec.llmReconnectMaxWaitMs
  };

  /**
   * 把上一轮工具调用暂存的视觉图片（浏览器截图 / 附件补看）作为 user 消息
   * （image_url）附到本轮请求。按来源分别上报 phase，便于观察调用率。
   * 只影响发往 LLM 的 body：不写 Rust 消息账本，也不进 checkpoint。
   *
   * 按 llmRound 记忆已取走的图片：上下文超限时同一个 round 会重发一次请求，
   * 若每次都 drain，重试那一次就拿不到图了 —— 而工具结果已经告诉模型「已附在下一轮」。
   */
  let visionRound = null;
  /** 本轮的视觉注入被上游拒过：重发时不再带上，否则只会换回同一个 400 */
  let visionSkipRound = null;
  const withVision = (baseBody, runId) => {
    if (!browserVision || !runId || !baseBody || !Array.isArray(baseBody.messages)) return baseBody;
    if (visionSkipRound === llmRound) return baseBody;
    if (!visionRound || visionRound.round !== llmRound || visionRound.runId !== runId) {
      const images = takePendingVisionImages(runId);
      const browserCount = images.filter((s) => s && s.source === SOURCE_BROWSER).length;
      const attachmentCount = images.filter((s) => s && s.source === SOURCE_ATTACHMENT).length;
      const mcpCount = images.filter((s) => s && s.source === SOURCE_MCP).length;
      if (browserCount) {
        onPhase('browser_vision_injected', { runId, round: llmRound, count: browserCount });
      }
      if (attachmentCount) {
        onPhase('attachment_vision_injected', { runId, round: llmRound, count: attachmentCount });
      }
      if (mcpCount) {
        onPhase('mcp_vision_injected', { runId, round: llmRound, count: mcpCount });
      }
      visionRound = { round: llmRound, runId, message: buildVisionMessage(images) };
    }
    if (!visionRound.message) return baseBody;
    return { ...baseBody, messages: [...baseBody.messages, visionRound.message] };
  };

  const stopForOverflow = async (runId, extra = {}) => {
    onPhase('turn_overflow_stopped', { runId, round: llmRound, ...extra });
    await abortSidecarRun(bridge, runId);
    return {
      phase: 'done',
      runId,
      content: lastAssistantContent || '',
      overflowStopped: true
    };
  };

  let phase = await bridge.invoke('agent.loop.start', startParams, LOOP_START_TIMEOUT_MS);
  if (!phase || !phase.runId) {
    throw new Error('agent.loop.start 失败');
  }
  activeRunId = String(phase.runId);
  onPhase('start', phase);

  try {
    // 30s 采样：warn 只记一次；到 abort 阈值用既有的 agent.loop.cancel 收尾。
    // 只在**主循环**里跑：`while` 的每个 await 都是它盯着的对象。
    stallTimer = setInterval(() => {
      const hit = runStall.check(Date.now(), (phase && phase.runId) || '');
      if (!hit) return;
      runLog(hit.message);
      if (hit.level === 'abort') {
        void bridge
          .invoke('agent.loop.cancel', { runId: (phase && phase.runId) || '' })
          .catch(() => {});
      }
    }, 30000);
    if (stallTimer && typeof stallTimer.unref === 'function') stallTimer.unref();

    while (phase && phase.phase !== 'done') {
      runStall.note(String(phase.phase || 'unknown'));
      await throwIfCancelled(bridge, phase.runId, signal);

      if (phase.phase === 'need_llm') {
        snapshotReason = SNAPSHOT_REASONS.INITIAL;
        const body = { ...(phase.llmBody || {}) };
        runStall.note('compact');
        const compactResult = await maybeCompactRound({
          compactMessages,
          body,
          llmRound,
          runId: phase.runId,
          signal,
          bridge,
          onPhase,
          apiConfig: llm
        });
        // 无论压没压，都把这次的判定事实挂到「这一次发送」的快照上：
        // 只记 compacted=true 的话，「这轮为什么没压」在事后就无从复盘了。
        snapshotCompaction = snapshotOfCompaction(compactResult);
        if (compactResult && compactResult.compacted) {
          overflowCompactionAttempted = true;
          overflowCompaction = { compacted: true };
        }
        const imagesSanitized = await capAndSyncLoopMessages(
          body,
          phase.runId,
          signal,
          bridge,
          opts.userData,
          opts.contextTierId
        );
        if (imagesSanitized) {
          onPhase('llm_images_sanitized', { runId: phase.runId, round: llmRound });
        }

        lastCheckpoint = {
          runId: phase.runId,
          model: body.model,
          messages: Array.isArray(body.messages) ? body.messages : [],
          tools: body.tools || []
        };

        const roundReconnect = {
          ...reconnectOptsBase,
          onWait: (info) => onPhase('llm_reconnect_wait', { runId: phase.runId, round: llmRound, ...info })
        };

        const fetchRoundOnce = async () => {
          const sendBody = withVision(body, phase.runId);
          // 先留底再发：`sendBody` 就是这一轮真正出去的请求（含视觉注入后的形态）。
          runStall.note('llm_snapshot');
          await writeRequestSnapshot(sendBody, phase.runId);
          runStall.note('llm_fetch');
          return fetchLlmRound({
            bridge,
            runId: phase.runId,
            body: sendBody,
            llm,
            signal,
            useStream,
            firstTokenTimeoutMs,
            streamIdleTimeoutMs,
            llmRound,
            onPhase,
            fetchLlmOnce: opts.fetchLlmOnce,
            reconnectOpts: roundReconnect
          });
        };

        /**
         * 上游把「图片不合规」当整轮 400 打回时的自愈：丢图 → 换成文字说明 → 回写账本 →
         * 重发本轮，绝不让整轮对话因为一张图报废（历史上重发的旧图同样适用）。
         *
         * 定位来自上游文案里的 `.messages[N].image[M]`：只有下标可信时才按定位丢，
         * 否则（定位不到 / 落在视觉注入消息上 / 指到的消息里没有图）直接丢光本轮所有图，
         * 保证重发一定是一次「无图片」的请求。
         * @returns {Promise<boolean>} 是否有实际改动（没有就没必要重发）
         */
        const dropRejectedRoundImages = async (err, attempt) => {
          const refs = parseRejectedImageMessageIndices(err && err.message);
          const ledgerCount = Array.isArray(body.messages) ? body.messages.length : 0;
          // 视觉注入消息是临时追加、不在账本里，故下标 >= 账本长度即「要丢的是本轮注入图」
          const targets = refs.filter((i) => i < ledgerCount);
          const canTarget = attempt === 0 && targets.length > 0 && targets.length === refs.length;
          let dropped = 0;
          let dropAll = !canTarget;
          if (canTarget) {
            dropped = dropRejectedChatImagesForApi(body, { messageIndices: targets }).dropped;
            if (!dropped) dropAll = true;
          }
          if (dropAll) dropped += dropRejectedChatImagesForApi(body, {}).dropped;
          const visionDropped = dropAll || refs.some((i) => i >= ledgerCount);
          if (visionDropped) visionSkipRound = llmRound;
          if (!dropped && !visionDropped) return false;
          if (dropped) {
            await invokeLoopRpc(
              bridge,
              'agent.loop.set_messages',
              { runId: phase.runId, messages: body.messages },
              LOOP_SET_MESSAGES_TIMEOUT_MS,
              signal
            );
          }
          console.warn(
            '[dieyun:agent]',
            'LLM_IMAGES_DROPPED',
            `round=${llmRound} dropped=${dropped} visionDropped=${visionDropped} err=${String(
              (err && err.message) || err
            ).slice(0, 200)}`
          );
          onPhase('llm_images_dropped', {
            runId: phase.runId,
            round: llmRound,
            dropped,
            visionDropped,
            attempt: attempt + 1
          });
          return true;
        };

        const fetchRoundWithImageRepair = async () => {
          for (let attempt = 0; ; attempt += 1) {
            try {
              return await fetchRoundOnce();
            } catch (err) {
              if (isCancelledRpcError(err) || attempt >= MAX_IMAGE_REPAIRS_PER_ROUND) throw err;
              if (!isLlmImageRejectedError(err)) throw err;
              if (!(await dropRejectedRoundImages(err, attempt))) throw err;
              // 丢掉被拒图片后的重发：留底时如实标成 image-repair（与首发区分开）。
              snapshotReason = SNAPSHOT_REASONS.IMAGE_REPAIR;
            }
          }
        };

        let llmResp;
        try {
          llmResp = await fetchRoundWithImageRepair();
        } catch (err) {
          if (isCancelledRpcError(err)) throw err;
          if (isContextOverflowError(err) && overflowCompactionAttempted) {
            return await stopForOverflow(phase.runId, {
              llmError: String(err.message || err),
              compaction: overflowCompaction
            });
          }
          if (isContextOverflowError(err) && !overflowCompactionAttempted) {
            const forcedCompaction = await maybeCompactRound({
              compactMessages,
              body,
              llmRound,
              runId: phase.runId,
              signal,
              bridge,
              onPhase,
              apiConfig: llm,
              force: true
            });
            overflowCompactionAttempted = true;
            // 强制压缩也可能失败（摘要模型报错 / 内容审核拦截）：如实记录，
            // 停止文案不能声称「已压缩一次」。
            overflowCompaction = {
              compacted: !!(forcedCompaction && forcedCompaction.compacted),
              reason: (forcedCompaction && forcedCompaction.reason) || undefined
            };
            if (forcedCompaction && forcedCompaction.compacted) {
              // 这次强压发生在下面这次重发之前 —— 结论落在重发那条快照上。
              snapshotCompaction = snapshotOfCompaction(forcedCompaction);
            }
            snapshotReason = SNAPSHOT_REASONS.OVERFLOW_RETRY;
            const retrySanitized = await capAndSyncLoopMessages(
              body,
              phase.runId,
              signal,
              bridge,
              opts.userData,
              opts.contextTierId
            );
            if (retrySanitized) {
              onPhase('llm_images_sanitized', { runId: phase.runId, round: llmRound });
            }
            lastCheckpoint = {
              runId: phase.runId,
              model: body.model,
              messages: Array.isArray(body.messages) ? body.messages : [],
              tools: body.tools || []
            };
            try {
              // 压缩后的重发同样带上「图片被拒」自愈：压缩不改变图片合法性
              llmResp = await fetchRoundWithImageRepair();
            } catch (retryErr) {
              if (isCancelledRpcError(retryErr)) throw retryErr;
              if (isContextOverflowError(retryErr)) {
                return await stopForOverflow(phase.runId, {
                  llmError: String(retryErr.message || retryErr),
                  compaction: overflowCompaction
                });
              }
              throw retryErr;
            }
          } else {
            throw err;
          }
        }

        lastAssistantContent = String((llmResp && llmResp.content) || lastAssistantContent || '');
        onPhase('llm_response', {
          runId: phase.runId,
          round: llmRound,
          toolCalls: llmResp.toolCalls?.length || 0,
          usage: llmResp.usage || null,
          model: body.model || null,
          persistRound: true,
          reasoning: llmResp.reasoning || '',
          content: llmResp.content || ''
        });
        llmRound += 1;
        const contRunId = phase.runId;
        phase = await invokeLoopRpc(
          bridge,
          'agent.loop.continue',
          { runId: contRunId, llm: llmResp },
          LOOP_CONTINUE_TIMEOUT_MS,
          signal
        );
        onPhase(phase?.phase || 'unknown', phase || {});
        continue;
      }

      if (phase.phase === 'need_delegate') {
        const delegates = Array.isArray(phase.delegates) ? phase.delegates : [];
        onPhase('delegate_start', { runId: phase.runId, delegates });
        runStall.note('delegate');
        const results = capDelegateResults(
          await executeDelegateBatch(delegates, delegateTool, onPhase, phase.runId, signal),
          (getAgentLimits(opts.userData, opts.contextTierId) || {}).toolResultMaxJson
        );
        await throwIfCancelled(bridge, phase.runId, signal);
        const toolRunId = phase.runId;
        runStall.note('tool_results');
        phase = await invokeLoopRpc(
          bridge,
          'agent.loop.tool_results',
          { runId: toolRunId, results },
          LOOP_TOOL_RESULTS_TIMEOUT_MS,
          signal
        );
        onPhase(phase?.phase || 'unknown', phase || {});
        continue;
      }

      throw new Error(phase?.message || `agent loop 未知阶段: ${phase?.phase || 'null'}`);
    }

    if (!phase || phase.phase !== 'done') {
      throw new Error(phase?.message || 'agent loop 未正常结束');
    }
    if (opts.turnEndSynthesis) {
      return applyTurnEndSynthesis({
        done: phase,
        llm,
        signal,
        onPhase,
        userData: opts.userData,
        model: (lastCheckpoint && lastCheckpoint.model) || startParams.model,
        fetchSynthesisOnce: opts.fetchSynthesisOnce
      });
    }
    return phase;
  } catch (err) {
    if (isCancelledRpcError(err)) {
      const runId = (phase && phase.runId) || (lastCheckpoint && lastCheckpoint.runId);
      await abortSidecarRun(bridge, runId);
      throw createAbortError();
    }
    if (lastCheckpoint) {
      onPhase('loop_failed', { checkpoint: lastCheckpoint, error: err.message || String(err) });
    }
    throw err;
  } finally {
    activeLoops.delete(loopTicket);
    if (stallTimer) clearInterval(stallTimer);
    if (browserVision) clearPendingVisionImages(activeRunId);
  }
}

function resolveChatUrl(baseUrl) {
  // 端点拼接的单一来源是 llm-request.js（裸 host 补 /v1、已含版本段只补资源路径、
  // Azure 的 ?api-version= 查询串不二次拼接）；此处仅负责本模块的「必填」语义。
  const url = resolveLlmEndpoint(baseUrl, 'chat');
  if (!url) throw new Error('LLM baseUrl 未配置');
  return url;
}

function normalizeLlmResponse(json) {
  const choice = json?.choices?.[0];
  const msg = choice?.message || {};
  const seenIds = new Set();
  let idx = 0;
  const toolCalls = [];
  for (const tc of Array.isArray(msg.tool_calls) ? msg.tool_calls : []) {
    const name = tc && tc.function ? tc.function.name : '';
    if (!String(name || '').trim()) continue;
    let id = tc && tc.id != null ? String(tc.id).trim() : '';
    if (!id || seenIds.has(id)) {
      id = `call_${Date.now().toString(36)}_${idx}`;
    }
    seenIds.add(id);
    idx += 1;
    toolCalls.push({
      id,
      name,
      arguments: tc.function && tc.function.arguments
    });
  }
  return enrichLlmToolCalls({
    content: msg.content != null ? String(msg.content) : '',
    reasoning: msg.reasoning_content || msg.reasoning || '',
    toolCalls,
    usage: json?.usage || null,
    finishReason: choice?.finish_reason || choice?.finishReason || null
  });
}

module.exports = {
  runRustAgentLoop,
  createRunStallWatchdog,
  setLoopRunnerLog,
  getActiveAgentLoopCount,
  resolveChatUrl,
  normalizeLlmResponse,
  applyResolvedLoopSpec,
  backfillReasoningContent
};
