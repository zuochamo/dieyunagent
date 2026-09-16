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
const { trimMessagesToCharBudget, foldOlderCompletionMessages, contentCharLen } = require('./session-context');
const { capDelegateResults } = require('./tool-result-cap');
const {
  takePendingVisionImages,
  clearPendingVisionImages,
  buildVisionMessage,
  SOURCE_BROWSER
} = require('./browser-vision');

const { executeDelegateBatch } = require('./delegate-batch');
const { applyTurnEndSynthesis } = require('./agent-synthesis');

const LOOP_START_TIMEOUT_MS = 30000;
const LOOP_SET_MESSAGES_TIMEOUT_MS = 30000;
const LOOP_CONTINUE_TIMEOUT_MS = 600000;
const LOOP_TOOL_RESULTS_TIMEOUT_MS = 300000;
const COMPACT_AFTER_MESSAGES = 12;
const COMPACT_CHAR_RATIO = 0.5;

function toolsJsonChars(tools) {
  try {
    return tools ? JSON.stringify(tools).length : 0;
  } catch {
    return 0;
  }
}

function shouldCompactRound({ force, messageCount, chars, charBudget }) {
  if (force) return true;
  const charCap =
    Number(charBudget) > 0 ? Number(charBudget) : AGENT_LIMITS_DEFAULTS.llmRequestMaxChars;
  const count = Number(messageCount) || 0;
  const n = Number(chars) || 0;
  return count > COMPACT_AFTER_MESSAGES || n > Math.floor(charCap * COMPACT_CHAR_RATIO);
}

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
  if (!applyLlmMessageCharCap(body, userData, tierId)) return;
  if (!runId) return;
  await invokeLoopRpc(
    bridge,
    'agent.loop.set_messages',
    { runId, messages: body.messages },
    LOOP_SET_MESSAGES_TIMEOUT_MS,
    signal
  );
}

function applyResolvedLoopSpec(startParams, spec) {
  const out = { ...(startParams || {}) };
  const resolved = spec && spec.maxToolCalls;
  if ((out.maxToolCalls == null || out.maxToolCalls === '') && resolved != null && resolved !== '') {
    out.maxToolCalls = resolved;
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

async function maybeCompactRound({
  compactMessages,
  body,
  llmRound,
  runId,
  signal,
  bridge,
  onPhase,
  force,
  charBudget
}) {
  if (!compactMessages || !Array.isArray(body.messages)) return { compacted: false };
  const chars = (body.messages || []).reduce((n, m) => n + contentCharLen(m && m.content), 0);
  if (
    !shouldCompactRound({
      force,
      messageCount: body.messages.length,
      chars,
      charBudget
    })
  ) {
    return { compacted: false };
  }
  let cr;
  try {
    cr = await raceAbortable(
      compactMessages(body.messages, {
        runId,
        round: llmRound,
        signal,
        force: !!force
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
  if (!(cr && cr.compacted && Array.isArray(cr.messages))) return { compacted: false };
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
  return { compacted: true, tokensBefore: cr.tokensBefore, tokensAfter: cr.tokensAfter };
}

function buildChatHeaders(llm) {
  const headers = { 'Content-Type': 'application/json' };
  if (llm.apiKey) headers.Authorization = `Bearer ${llm.apiKey}`;
  return headers;
}

async function completeNonStreamChat(url, headers, body, signal) {
  const sendBody = { ...body, stream: false };
  const json = await chatCompletionJson(url, {
    headers,
    body: JSON.stringify(sendBody),
    signal
  });
  return normalizeLlmResponse(json);
}

/**
 * DeepSeek 思考模式 + tools 的硬校验：请求里只要带 tools，历史中的 assistant
 * 消息就必须回传 reasoning_content（含未发起 tool call 的普通回复轮）。
 * 修复前落库/续跑的历史消息没有该字段，发送前补占位，避免上游 HTTP 400。
 */
function backfillReasoningContent(messages, hasTools) {
  if (!Array.isArray(messages)) return messages;
  let changed = false;
  const next = messages.map((m) => {
    if (!m || m.role !== 'assistant') return m;
    const needsField = !!hasTools || (Array.isArray(m.tool_calls) && m.tool_calls.length > 0);
    if (!needsField) return m;
    if (typeof m.reasoning_content === 'string' && m.reasoning_content.trim()) return m;
    changed = true;
    return { ...m, reasoning_content: '（思考内容未随消息保存）' };
  });
  return changed ? next : messages;
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
  llmRound,
  onPhase,
  fetchLlmOnce: fetchOverride,
  reconnectOpts
}) {
  const url = resolveChatUrl(llm.baseUrl);
  const headers = buildChatHeaders(llm);
  const hasTools = Array.isArray(body.tools) && body.tools.length > 0;
  const requestBody = {
    ...body,
    messages: backfillReasoningContent(body.messages, hasTools)
  };
  let frozenPartial = { content: '', reasoning: '' };

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
          onDelta: (delta) => {
            onPhase('llm_delta', {
              runId,
              round: llmRound,
              content: delta.content || '',
              reasoning: delta.reasoning || '',
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
          apiKey: llm.apiKey,
          signal,
          firstTokenTimeoutMs,
          onDelta: (delta) => {
            onPhase('llm_delta', {
              runId,
              round: llmRound,
              content: delta.content || '',
              reasoning: delta.reasoning || '',
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
        const jsonResp = await completeNonStreamChat(url, headers, requestBody, signal);
        return mergeMissingReasoning(jsonResp, frozenPartial);
      }
    }
    return mergeMissingReasoning(await completeNonStreamChat(url, headers, requestBody, signal), frozenPartial);
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
      onPhase('llm_partial_recovered', {
        runId,
        round: llmRound,
        recoveredReasoning: !!String(frozenPartial.reasoning || '').trim(),
        recoveredContent: !!String(frozenPartial.content || '').trim()
      });
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
            signal
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
 * @param {{ maxToolCalls?: number, firstTokenTimeoutMs?: number }} [opts.loopSpec]
 * @param {Function} [opts.fetchLlmOnce] 可选：覆盖本轮 LLM 请求（测试用）
 * @param {boolean} [opts.turnEndSynthesis] 聊天路径：空回复才补汇总；规划 worker 勿开
 * @param {boolean} [opts.browserVision] 是否为多模态模型：允许把浏览器截图 / 附件补看图片作为 image_url 注入下一轮
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

  let llmRound = 0;
  let lastCheckpoint = null;
  let overflowCompacted = false;
  let activeRunId = '';
  let lastAssistantContent = '';

  const loopSpec = opts.loopSpec || resolveAgentLoopSpec(opts.settings, opts.userData, opts.contextTierId);
  const startParams = applyResolvedLoopSpec(opts.startParams, loopSpec);
  const firstTokenTimeoutMs = loopSpec.firstTokenTimeoutMs;
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
  const withVision = (baseBody, runId) => {
    if (!browserVision || !runId || !baseBody || !Array.isArray(baseBody.messages)) return baseBody;
    if (!visionRound || visionRound.round !== llmRound || visionRound.runId !== runId) {
      const images = takePendingVisionImages(runId);
      const browserCount = images.filter((s) => s && s.source === SOURCE_BROWSER).length;
      const attachmentCount = images.length - browserCount;
      if (browserCount) {
        onPhase('browser_vision_injected', { runId, round: llmRound, count: browserCount });
      }
      if (attachmentCount) {
        onPhase('attachment_vision_injected', { runId, round: llmRound, count: attachmentCount });
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
    while (phase && phase.phase !== 'done') {
      await throwIfCancelled(bridge, phase.runId, signal);

      if (phase.phase === 'need_llm') {
        const body = { ...(phase.llmBody || {}) };
        const compactResult = await maybeCompactRound({
          compactMessages,
          body,
          llmRound,
          runId: phase.runId,
          signal,
          bridge,
          onPhase,
          charBudget: (() => {
            try {
              const lim = getAgentLimits(opts.userData, opts.contextTierId) || {};
              return Math.max(50000, Number(lim.llmRequestMaxChars || 800000) - toolsJsonChars(body.tools));
            } catch {
              return Math.max(50000, 800000 - toolsJsonChars(body.tools));
            }
          })()
        });
        if (compactResult && compactResult.compacted) {
          overflowCompacted = true;
        }
        await capAndSyncLoopMessages(
          body,
          phase.runId,
          signal,
          bridge,
          opts.userData,
          opts.contextTierId
        );

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

        let llmResp;
        try {
          llmResp = await fetchLlmRound({
            bridge,
            runId: phase.runId,
            body: withVision(body, phase.runId),
            llm,
            signal,
            useStream,
            firstTokenTimeoutMs,
            llmRound,
            onPhase,
            fetchLlmOnce: opts.fetchLlmOnce,
            reconnectOpts: roundReconnect
          });
        } catch (err) {
          if (isCancelledRpcError(err)) throw err;
          if (isContextOverflowError(err) && overflowCompacted) {
            return await stopForOverflow(phase.runId, { llmError: String(err.message || err) });
          }
          if (isContextOverflowError(err) && !overflowCompacted) {
            const forced = await maybeCompactRound({
              compactMessages,
              body,
              llmRound,
              runId: phase.runId,
              signal,
              bridge,
              onPhase,
              force: true
            });
            overflowCompacted = true;
            await capAndSyncLoopMessages(
              body,
              phase.runId,
              signal,
              bridge,
              opts.userData,
              opts.contextTierId
            );
            lastCheckpoint = {
              runId: phase.runId,
              model: body.model,
              messages: Array.isArray(body.messages) ? body.messages : [],
              tools: body.tools || []
            };
            try {
              llmResp = await fetchLlmRound({
                bridge,
                runId: phase.runId,
                body: withVision(body, phase.runId),
                llm,
                signal,
                useStream,
                firstTokenTimeoutMs,
                llmRound,
                onPhase,
                fetchLlmOnce: opts.fetchLlmOnce,
                reconnectOpts: roundReconnect
              });
            } catch (retryErr) {
              if (isCancelledRpcError(retryErr)) throw retryErr;
              if (isContextOverflowError(retryErr)) {
                return await stopForOverflow(phase.runId, { llmError: String(retryErr.message || retryErr) });
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
        const results = capDelegateResults(
          await executeDelegateBatch(delegates, delegateTool, onPhase, phase.runId, signal),
          (getAgentLimits(opts.userData, opts.contextTierId) || {}).toolResultMaxJson
        );
        await throwIfCancelled(bridge, phase.runId, signal);
        const toolRunId = phase.runId;
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
    if (browserVision) clearPendingVisionImages(activeRunId);
  }
}

function resolveChatUrl(baseUrl) {
  const raw = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!raw) throw new Error('LLM baseUrl 未配置');
  // 已含 chat/completions（含 Azure ?api-version= 查询串）则不再拼接
  if (/\/chat\/completions(?:\?|$)/i.test(raw)) return raw;
  // LM Studio / OpenAI 兼容：裸 host 须带 /v1，否则会打到 /chat/completions 得到空 SSE
  if (/\/v\d+$/i.test(raw)) return `${raw}/chat/completions`;
  return `${raw}/v1/chat/completions`;
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
  resolveChatUrl,
  normalizeLlmResponse,
  applyResolvedLoopSpec,
  shouldCompactRound,
  backfillReasoningContent
};
