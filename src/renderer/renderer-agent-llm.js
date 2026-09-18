/* global window, fetch, settings, gwState, gatewayCall, showAgentToast, executeAgentTool, formatToolArgsBrief, summarizeToolResult, TRACE_DESKTOP_THOUGHT_CHARS, getEffectiveInputBudget, getContextWindowTokens, getMaxOutputTokens, getContextReserveTokens, resolveComposerModelForSend, getCustomModelApiConfig, captureTurnBatchCheckpoint, isMutatingAgentTool, currentSessionId, shouldBlockRepeatToolCall, recordToolCallFingerprint, repeatToolBlockMessage, noteContextCompaction, noteComposerSessionUsage, resolveComposerUsageSessionId, streamChatCompletion, fetchChatCompletion, upsertSynthesisTraceRound, getComposerLongHorizon, getCurrentUndoTurnId, getUndoTurnIdForSession, supplierDisplayName, normalizeAgentToolName, syncLiveWriteFromTrace, compactDiffForTrace, getAgentLimits, trackArtifactsFromTrace, resolveSessionWorkspacePath, isWeakAssistantReply, AgentRoundText, formatModelFooterLabel, humanizeModelId, scaleLimitForLongHorizon, dismissAgentContinueRows, maybeShowProposeToolPreview, sanitizeOutboundImageUrl */
'use strict';

function resolveEndpoint(baseUrl) {
  const trimmed = String(baseUrl || '').replace(/\/+$/, '');
  if (/\/chat\/completions(?:\?|$)/i.test(trimmed)) return trimmed;
  if (/\/v\d+$/i.test(trimmed)) return `${trimmed}/chat/completions`;
  return `${trimmed}/v1/chat/completions`;
}

function describeApiHost(baseUrl) {
  const raw = String(baseUrl || '').trim();
  if (!raw) return '模型接口';
  try {
    return new URL(raw).host || raw;
  } catch {
    return raw.replace(/^https?:\/\//i, '').split('/')[0] || raw;
  }
}

function parseHttpStatusFromError(err) {
  if (!err) return 0;
  const code = Number(err.statusCode);
  if (Number.isFinite(code) && code > 0) return code;
  const msg = String(err.message || err);
  const m = msg.match(/\bHTTP\s+(\d{3})\b/i);
  return m ? Number(m[1]) : 0;
}

function isTransientFetchError(err) {
  if (!err) return false;
  if (isUserAbortError(err)) return false;
  const msg = String(err.message || err).toLowerCase();
  const status = parseHttpStatusFromError(err);
  if (status === 400 || status === 401 || status === 403) return false;
  if (/quota|billing|insufficient_quota|额度|余额不足/.test(msg) && status === 429) return false;
  if (/content.?policy|content_policy|内容审核/.test(msg)) return false;
  if (status === 429 || status === 502 || status === 503 || status === 504) return true;
  return (
    err instanceof TypeError ||
    msg.includes('network error') ||
    msg.includes('failed to fetch') ||
    msg.includes('network request failed') ||
    msg.includes('socket hang up') ||
    msg.includes('econnreset') ||
    msg.includes('connection reset') ||
    msg.includes('connection aborted') ||
    msg.includes('connection_error') ||
    msg.includes('etimedout') ||
    msg.includes('timedout') ||
    msg.includes('enotfound') ||
    /\bhttp\s+(429|502|503|504)\b/.test(msg)
  );
}

function isUserAbortError(err) {
  for (let cur = err; cur; cur = cur.cause) {
    if (!cur) break;
    if (cur.name === 'AbortError' || cur.code === 'ABORT_ERR') return true;
    const raw = String(cur.message || '').trim();
    const msg = raw.toLowerCase();
    // 仅精确匹配用户取消；勿用 includes('已停止')，否则会误伤「dieyun-core 已停止」
    if (msg === 'aborted' || raw === '已停止') return true;
    // Electron IPC：Error invoking remote method 'agent:rust-loop-run': AbortError: aborted
    if (/aborterror\s*:\s*aborted/.test(msg)) return true;
    if (/invoke remote method/.test(msg) && /aborterror|:\s*aborted/.test(msg)) return true;
  }
  return false;
}

function toUserAbortError(err, extra = {}) {
  const ae = new Error('已停止');
  ae.name = 'AbortError';
  if (err?.trace) ae.trace = err.trace;
  if (extra.trace) ae.trace = extra.trace;
  ae.cause = err;
  return ae;
}

function enrichFetchError(err, apiBaseUrl, phase) {
  if (isUserAbortError(err)) return toUserAbortError(err);
  const host = describeApiHost(apiBaseUrl);
  const base = err instanceof Error ? err : new Error(String(err || '未知错误'));
  const msg = String(base.message || '').toLowerCase();
  const status = parseHttpStatusFromError(base);
  let hint = base.message || String(err);
  if (status === 502 || msg.includes('http 502')) {
    hint =
      `模型网关暂时不可用（502 · ${host}${phase ? ` · ${phase}` : ''}）` +
      '：上游连接被重置（Connection reset by peer），常见于代理/负载均衡与模型后端之间断连。请稍后重试或更换模型/接口。';
  } else if (status === 503 || status === 504 || msg.includes('http 503') || msg.includes('http 504')) {
    hint =
      `模型服务繁忙或超时（HTTP ${status || '503/504'} · ${host}）` +
      '：请稍后重试，或切换到其它可用模型。';
  } else if (status === 429 || msg.includes('http 429')) {
    hint = `模型接口限流（429 · ${host}），请降低并发或稍后重试。`;
  } else if (msg.includes('network error') || msg.includes('failed to fetch')) {
    hint =
      `网络异常（${host}${phase ? ` · ${phase}` : ''}）` +
      '：连接中断或超时。请检查网络/VPN/代理，并在「模型设置」中测试接口是否可用。';
  } else if (
    msg.includes('econnreset') ||
    msg.includes('socket hang up') ||
    msg.includes('connection reset') ||
    msg.includes('connection aborted') ||
    msg.includes('connection_error')
  ) {
    hint = `连接被服务端重置（${host}），常见于流式响应中断或接口限流，请稍后重试。`;
  } else if (msg.includes('etimedout') || msg.includes('timedout')) {
    hint =
      `请求超时（${host}${phase ? ` · ${phase}` : ''}）` +
      '：网关或模型响应过慢。可重试，或切换到其他可用模型。';
  } else if (msg.includes('enotfound') || msg.includes('getaddrinfo')) {
    hint = `无法解析模型接口地址（${host}），请检查 Base URL 是否正确。`;
  }
  const out = new Error(hint);
  out.name = base.name || 'Error';
  out.apiBaseUrl = apiBaseUrl || '';
  out.cause = base;
  if (base.trace) out.trace = base.trace;
  return out;
}

async function apiFetchWithRetry(url, init, apiBaseUrl, opts = {}) {
  const retries = Number.isFinite(opts.retries) ? opts.retries : 2;
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (init?.signal?.aborted) {
      const err = new Error('已停止');
      err.name = 'AbortError';
      throw err;
    }
    try {
      return await fetch(url, init);
    } catch (err) {
      lastErr = err;
      if (!isTransientFetchError(err) || attempt >= retries) {
        throw enrichFetchError(err, apiBaseUrl, opts.phase || '请求');
      }
      await new Promise((r) => setTimeout(r, 600 * (attempt + 1)));
    }
  }
  throw enrichFetchError(lastErr, apiBaseUrl, opts.phase || '请求');
}

function formatAgentApiError(err, fallbackBaseUrl) {
  if (!err) return '未知错误';
  const raw = String(err.message || err);
  if (/unexpected end of data/i.test(raw)) {
    return (
      '模型网关拒绝了请求：对话历史中存在损坏的工具调用参数（JSON 不完整）。' +
      ' 已尝试自动修复；若仍失败请新建对话或清除当前会话后重试。' +
      (raw.includes('HTTP') ? `\n${raw}` : '')
    );
  }
  const apiBaseUrl = err.apiBaseUrl || fallbackBaseUrl || '';
  if (apiBaseUrl && !raw.includes(describeApiHost(apiBaseUrl))) {
    return enrichFetchError(err, apiBaseUrl).message;
  }
  return raw;
}

function listAlternateModelHints(currentBaseUrl) {
  const currentHost = describeApiHost(currentBaseUrl).toLowerCase();
  const hints = [];
  const seen = new Set();
  const add = (label, baseUrl) => {
    const host = describeApiHost(baseUrl).toLowerCase();
    if (!host || host === currentHost || seen.has(host)) return;
    seen.add(host);
    hints.push(`${label}（${host}）`);
  };
  for (const m of settings.customModels || []) {
    if (m && m.name && m.baseUrl) add(String(m.name), m.baseUrl);
  }
  if ((settings.modelSuppliers || []).some((s) => (s.baseUrl || '').trim())) {
    for (const s of settings.modelSuppliers) {
      if (s.baseUrl) add('供应商', `${supplierDisplayName(s)} · ${s.baseUrl}`);
    }
  }
  if (settings.baseUrl) add(settings.textModel || '当前文本模型', settings.baseUrl);
  return hints.slice(0, 4);
}

const LLM_RECONNECT_TOAST_MIN_INTERVAL_MS = 45000;
let lastLlmReconnectToastAt = 0;

function maybeShowLlmReconnectToast(title, body, opts = {}) {
  const now = Date.now();
  const force = opts.force === true;
  if (!force && now - lastLlmReconnectToastAt < LLM_RECONNECT_TOAST_MIN_INTERVAL_MS) return false;
  lastLlmReconnectToastAt = now;
  showAgentToast(title, body, { variant: opts.variant || 'warn' });
  return true;
}

function noteLlmSuccess() {
  llmConsecutiveFailures = 0;
  lastLlmReconnectToastAt = 0;
}

function noteLlmFailure(err, apiBaseUrl) {
  if (isUserAbortError(err)) return;
  llmConsecutiveFailures += 1;
  if (llmConsecutiveFailures < 2) return;
  const alts = listAlternateModelHints(apiBaseUrl);
  const body = alts.length
    ? `已连续 ${llmConsecutiveFailures} 次失败，建议切换：${alts.join('、')}。可在输入框下方模型菜单或「模型设置」中更换。`
    : `已连续 ${llmConsecutiveFailures} 次失败，请在「模型设置」中测试接口或更换 Base URL。`;
  showAgentToast('模型连接不稳定', body, { variant: 'warn' });
}

function sleepMs(ms, signal) {
  const wait = Math.max(0, Number(ms) || 0);
  if (!signal) {
    return new Promise((r) => setTimeout(r, wait));
  }
  if (signal.aborted) {
    const err = new Error('已停止');
    err.name = 'AbortError';
    return Promise.reject(err);
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    }, wait);
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      const err = new Error('已停止');
      err.name = 'AbortError';
      reject(err);
    };
    const cleanup = () => {
      clearTimeout(timer);
      if (typeof signal.removeEventListener === 'function') {
        signal.removeEventListener('abort', onAbort);
      }
    };
    if (typeof signal.addEventListener === 'function') {
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

/**
 * 主对话重连墙钟预算：显式正数优先，否则读 agent-limits（默认 30 分钟）。
 * 返回 0 表示退回「流式轮次重试」次数模式。
 * 只应由主对话调用方使用——短任务（reviewer / 记忆 / AGENTS.md 等）不得借用，
 * 否则会把 30 分钟重连扩散到本该快速失败的一次性请求。
 */
function resolveRendererReconnectBudgetMs(explicit) {
  const n = Number(explicit);
  if (Number.isFinite(n) && n > 0) return n;
  try {
    const cfg = Number(getAgentLimits().llmReconnectMaxWaitMs);
    if (Number.isFinite(cfg) && cfg > 0) return cfg;
  } catch {
    /* 配置不可用时退回次数模式 */
  }
  return 0;
}

async function runRendererLlmReconnectRetry(runOnce, opts = {}) {
  const { signal, onWait, maxWaitMs = 0 } = opts;
  const maxRetries = STREAM_ROUND_MAX_ATTEMPTS();
  const retryBase = LLM_RETRY_BASE_MS();
  // 必须调用方显式传预算才进入时间模式；缺省保持次数模式（旧行为）
  const timeBudgetMs = Number(maxWaitMs) > 0 ? Number(maxWaitMs) : 0;
  const startedAt = Date.now();
  let retryAttempt = 0;
  let lastErr;
  for (;;) {
    if (signal?.aborted) {
      const err = new Error('已停止');
      err.name = 'AbortError';
      throw err;
    }
    // 时间驱动：首次必试，之后墙钟耗尽即停（不受次数上限约束）
    if (retryAttempt > 0 && timeBudgetMs > 0 && Date.now() - startedAt >= timeBudgetMs) break;
    try {
      return await runOnce();
    } catch (err) {
      lastErr = enrichFetchError(err, opts.apiBaseUrl, opts.phase || 'LLM');
      if (isUserAbortError(err) || isUserAbortError(lastErr)) throw lastErr;
      if (!isTransientFetchError(lastErr)) throw lastErr;
      retryAttempt += 1;
      if (timeBudgetMs > 0) {
        if (Date.now() - startedAt >= timeBudgetMs) break;
      } else if (retryAttempt > maxRetries) {
        break;
      }
      const elapsed = Date.now() - startedAt;
      const waitMs = Math.min(LLM_RECONNECT_MAX_DELAY_MS, retryBase * Math.pow(2, retryAttempt - 1));
      // 时间驱动：剩余时间放不下下一次退避 → 不再空等
      if (timeBudgetMs > 0 && timeBudgetMs - elapsed <= waitMs) break;
      if (typeof onWait === 'function') {
        await onWait({
          attempt: retryAttempt,
          waitMs,
          error: lastErr,
          elapsedMs: elapsed,
          maxRetries: timeBudgetMs > 0 ? 0 : maxRetries,
          maxWaitMs: timeBudgetMs,
          remainingMs: timeBudgetMs > 0 ? Math.max(0, timeBudgetMs - elapsed) : 0
        });
      }
      await sleepMs(waitMs, signal);
    }
  }
  noteLlmFailure(lastErr, opts.apiBaseUrl);
  const exhausted = lastErr || new Error('模型连接恢复超时');
  exhausted.code = 'LLM_RECONNECT_EXHAUSTED';
  throw exhausted;
}

/** AbortSignal 不能经 contextBridge 传递，须在渲染进程绑定后通过 IPC 中止主进程请求 */
function bindSignalToMainAbort(signal, getAbort) {
  if (!signal) return () => {};
  let poll = null;
  const clearPoll = () => {
    if (poll) {
      clearInterval(poll);
      poll = null;
    }
  };
  const tryAbort = () => {
    const fn = typeof getAbort === 'function' ? getAbort() : null;
    if (typeof fn !== 'function') return false;
    clearPoll();
    try {
      fn();
    } catch {
      // ignore
    }
    return true;
  };
  const armPoll = () => {
    if (poll) return;
    const started = Date.now();
    poll = setInterval(() => {
      if (tryAbort() || Date.now() - started > 8000) clearPoll();
    }, 25);
  };
  if (signal.aborted) {
    if (!tryAbort()) armPoll();
    return clearPoll;
  }
  const onAbort = () => {
    if (!tryAbort()) armPoll();
  };
  signal.addEventListener('abort', onAbort, { once: true });
  return () => {
    clearPoll();
    signal.removeEventListener('abort', onAbort);
  };
}

function normalizeToolCallArgumentsJson(raw) {
  if (raw == null) return '{}';
  if (typeof raw === 'object') {
    try {
      return JSON.stringify(raw);
    } catch {
      return null;
    }
  }
  const text = String(raw).trim();
  if (!text) return '{}';
  try {
    return JSON.stringify(JSON.parse(text));
  } catch {
    return null;
  }
}

let fallbackToolCallIdSeq = 0;

function makeFallbackToolCallId(index) {
  fallbackToolCallIdSeq += 1;
  const idx = index != null && index !== '' ? String(index) : '0';
  return `call_dieyun_${idx}_${Date.now()}_${fallbackToolCallIdSeq}`;
}

function ensureToolCallId(tc, index) {
  const existing = tc && tc.id != null ? String(tc.id).trim() : '';
  if (existing) return existing;
  const id = makeFallbackToolCallId(index);
  const name = tc?.function?.name ? String(tc.function.name) : '';
  console.warn('[agent] tool_call 缺少 id，已自动生成:', id, name || '(unknown)');
  return id;
}

function normalizeToolCallsForApi(toolCalls) {
  if (!Array.isArray(toolCalls)) return [];
  const out = [];
  for (let i = 0; i < toolCalls.length; i += 1) {
    const tc = toolCalls[i];
    if (!tc || !tc.function || !String(tc.function.name || '').trim()) continue;
    const args = normalizeToolCallArgumentsJson(tc.function.arguments);
    if (args == null) {
      console.warn(
        '[agent] 丢弃无法解析的 tool_call arguments:',
        String(tc.function.arguments || '').slice(0, 160)
      );
      continue;
    }
    out.push({
      id: ensureToolCallId(tc, tc.index != null ? tc.index : i),
      type: tc.type || 'function',
      function: {
        name: String(tc.function.name || ''),
        arguments: args
      }
    });
  }
  return out;
}

function safeJsonStringify(value) {
  try {
    return JSON.stringify(value);
  } catch (err) {
    return JSON.stringify({
      error: 'tool_result_not_serializable',
      message: String(err?.message || err)
    });
  }
}

/**
 * 出站图片 part 的统一闸门：格式不受上游支持（bmp/svg/heic/tiff/ico、坏 base64、
 * 空图）时降级为文字说明，绝不让 image_url 带着不合法内容出门——上游会以
 * HTTP 400 "unsupported image" 打回整轮请求（历史里的图也一样会被重发）。
 * 判定逻辑单一来源是 renderer-utils.js 的 sanitizeOutboundImageUrl。
 */
function imagePartForApi(url) {
  const safe = sanitizeOutboundImageUrl(url);
  if (!safe) {
    return {
      type: 'text',
      text: '（图片格式不受模型接口支持，已省略；仅支持 png/jpeg/gif/webp）'
    };
  }
  return { type: 'image_url', image_url: { url: safe } };
}

function normalizeContentPartForApi(part) {
  if (typeof part === 'string') return { type: 'text', text: part };
  if (!part || typeof part !== 'object') return null;
  if (part.type === 'text') {
    return { type: 'text', text: String(part.text ?? part.content ?? '') };
  }
  if (part.type === 'image_url') {
    const url = part.image_url?.url || part.url;
    return url ? imagePartForApi(url) : null;
  }
  if (part.type === 'input_text') {
    return { type: 'text', text: String(part.text ?? part.content ?? '') };
  }
  if (part.type === 'input_image') {
    const url = part.image_url || part.url;
    return url ? imagePartForApi(url) : null;
  }
  if (part.text || part.content) {
    return { type: 'text', text: String(part.text || part.content) };
  }
  return { type: 'text', text: JSON.stringify(part) };
}

function normalizeMessageContentForApi(content) {
  if (Array.isArray(content)) {
    const parts = content.map(normalizeContentPartForApi).filter(Boolean);
    return parts.length ? parts : '';
  }
  if (content && typeof content === 'object') {
    const part = normalizeContentPartForApi(content);
    if (!part) return '';
    if (part.type === 'image_url') return [{ type: 'text', text: '请参考图片。' }, part];
    return part.text || JSON.stringify(content);
  }
  return content == null ? '' : String(content);
}

function sanitizeMessagesForChatApi(messages) {
  const droppedIds = new Set();
  const mapped = (messages || []).map((m) => {
    const role = m && m.role ? String(m.role) : 'user';
    let content = normalizeMessageContentForApi(m ? m.content : '');
    if (content == null) content = '';
    const out = { role, content };
    // 思考模式（DeepSeek V4 等）：带 tool_calls 的 assistant 消息必须原样回传
    // reasoning_content，否则下一轮请求会被上游以 HTTP 400 拒绝。
    if (role === 'assistant' && typeof m?.reasoning_content === 'string' && m.reasoning_content.trim()) {
      out.reasoning_content = m.reasoning_content;
    }
    if (Array.isArray(m?.tool_calls) && m.tool_calls.length) {
      const orig = m.tool_calls;
      const toolCalls = normalizeToolCallsForApi(orig);
      const kept = new Set(toolCalls.map((tc) => String(tc.id)));
      for (const tc of orig) {
        const id = tc && tc.id != null ? String(tc.id).trim() : '';
        if (id && !kept.has(id)) droppedIds.add(id);
      }
      if (toolCalls.length) {
        out.tool_calls = toolCalls;
        if (!out.content) out.content = '';
      }
    }
    // 修复前落库/续跑的历史轮没有 reasoning_content；DeepSeek 思考模式要求带
    // tool_calls 的 assistant 消息必须回传该字段，缺失时补占位避免 HTTP 400。
    if (
      role === 'assistant' &&
      Array.isArray(out.tool_calls) &&
      out.tool_calls.length &&
      !(typeof out.reasoning_content === 'string' && out.reasoning_content.trim())
    ) {
      out.reasoning_content = '（思考内容未随消息保存）';
    }
    if (m?.tool_call_id) out.tool_call_id = String(m.tool_call_id);
    if (m?.name) out.name = String(m.name);
    return out;
  });
  return mapped.filter((m) => {
    if (!m || m.role !== 'tool') return true;
    const id = m.tool_call_id != null ? String(m.tool_call_id) : '';
    return !(id && droppedIds.has(id));
  });
}

function toTokenCount(value) {
  return usageStats ? usageStats.toTokenCount(value) : (Number.isFinite(Number(value)) && Number(value) > 0 ? Math.floor(Number(value)) : 0);
}

function extractUsageStats(input, model) {
  if (usageStats) return usageStats.extractUsageStats(input, model);
  return { totalTokens: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, modelUsage: {} };
}

function addUsageStats(a, b) {
  if (usageStats) return usageStats.addUsageStats(a, b);
  return extractUsageStats(null);
}

function hasUsageStats(stats) {
  return usageStats ? usageStats.hasUsageStats(stats) : false;
}

function normalizeUsageModelMap(value) {
  return usageStats ? usageStats.normalizeUsageModelMap(value) : {};
}

function emptyUsageStats() {
  return usageStats ? usageStats.emptyUsageStats() : { totalTokens: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, modelUsage: {} };
}

async function reportTokensToMain(input, model) {
  const stats = typeof input === 'object'
    ? extractUsageStats(input, model)
    : { totalTokens: toTokenCount(input), promptTokens: 0, completionTokens: 0, cachedTokens: 0 };
  if (typeof noteComposerSessionUsage === 'function' && hasUsageStats(stats)) {
    noteComposerSessionUsage(
      typeof resolveComposerUsageSessionId === 'function'
        ? resolveComposerUsageSessionId()
        : currentSessionId,
      stats
    );
  }
  if (!hasUsageStats(stats) || !agentApi.addTokens) return;
  try {
    await agentApi.addTokens(stats);
  } catch (e) {
    console.warn('report tokens', e);
  }
}

function emitAgentProgress(trace, onProgress, streamContent) {
  const snapshot = trace.map((r) => ({ ...r, tools: (r.tools || []).map((t) => ({ ...t })) }));
  if (!onProgress) return snapshot;

  if (!emitAgentProgress._state || emitAgentProgress._state.onProgress !== onProgress) {
    emitAgentProgress._state = { onProgress, lastSig: '', pending: null, raf: null };
  }
  const st = emitAgentProgress._state;
  const sig =
    typeof thinkingTraceStructureSig === 'function'
      ? thinkingTraceStructureSig(snapshot)
      : String(snapshot.length);
  const streamOnly = !!(st.lastSig && sig === st.lastSig);
  st.lastSig = sig;
  st.pending = { snapshot, streamContent: streamContent || '' };

  const flush = () => {
    st.raf = null;
    const p = st.pending;
    if (!p) return;
    onProgress(p.snapshot, p.streamContent);
  };

  if (streamOnly) {
    if (!st.raf) st.raf = requestAnimationFrame(flush);
    return snapshot;
  }

  if (st.raf) {
    cancelAnimationFrame(st.raf);
    st.raf = null;
  }
  flush();
  return snapshot;
}

async function fetchChatCompletion({ model, messages, temperature, max_tokens, response_format, apiConfig, signal }) {
  const apiBaseUrl = (apiConfig && apiConfig.baseUrl) || settings.baseUrl;
  const apiKey = (apiConfig && apiConfig.apiKey) || settings.apiKey;
  const url = resolveEndpoint(apiBaseUrl);
  const bodyPayload = {
    model,
    messages: sanitizeMessagesForChatApi(messages),
    temperature,
    max_tokens
  };
  if (response_format && typeof response_format === 'object') {
    bodyPayload.response_format = response_format;
  }
  const body = JSON.stringify(bodyPayload);
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`
  };

  return runRendererLlmReconnectRetry(
    async () => {
      let data;
      if (agentApi.llmChatCompletion) {
        const ctrl = { abort: null };
        const reqPromise = agentApi.llmChatCompletion({
          url,
          headers,
          body,
          onControl: ({ abort }) => {
            ctrl.abort = abort;
          }
        });
        const unbind = bindSignalToMainAbort(signal, () => ctrl.abort);
        try {
          data = await reqPromise;
        } finally {
          unbind();
        }
      } else {
        const resp = await apiFetchWithRetry(
          url,
          { method: 'POST', headers, body, signal },
          apiBaseUrl,
          { phase: '对话请求', retries: 0 }
        );
        if (!resp.ok) {
          const errText = await resp.text();
          const err = new Error(`HTTP ${resp.status} ${resp.statusText}\n${errText.slice(0, 400)}`);
          err.statusCode = resp.status;
          throw err;
        }
        data = await resp.json();
      }
      await reportTokensToMain(data, model);
      const msg = data?.choices?.[0]?.message;
      return (msg?.content || '').trim() || '(空响应)';
    },
    { signal, apiBaseUrl, phase: '对话请求' }
  ).then((text) => {
    noteLlmSuccess();
    return text;
  });
}

let lastMemoryConsolidationAt = 0;
let memoryConsolidationPending = false;
let memoryMaintenanceTimer = null;

function parseMemoryConsolidationJson(text) {
  const raw = String(text || '').trim();
  if (!raw) return [];
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1].trim() : raw;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) return [];
  try {
    const json = JSON.parse(body.slice(start, end + 1));
    const items = Array.isArray(json.memories) ? json.memories : Array.isArray(json.items) ? json.items : [];
    return items
      .map((item) => ({
        content: compactPlainText(item.content || item.memory || item.text || '', 420),
        kind: ['normal', 'private', 'secret'].includes(String(item.kind || '').toLowerCase())
          ? String(item.kind).toLowerCase()
          : undefined,
        importance: Math.min(5, Math.max(1, Number(item.importance) || 3)),
        scope: compactPlainText(item.scope || 'global', 80)
      }))
      .filter((item) => item.content && item.content.length >= 8)
      .slice(0, 5);
  } catch {
    return [];
  }
}

async function consolidateLongMemoryNow(input) {
  if (!gwState.authed) return { ok: false, reason: 'gateway_disconnected' };
  const userText = compactPlainText(input?.userText || '', 1800);
  const assistantText = compactPlainText(input?.assistantText || '', 2200);
  const recentText = compactPlainText(input?.recentText || '', 2400);
  if (!userText && !assistantText && !recentText) return { ok: false, reason: 'empty' };
  const model = input?.model || resolveComposerModelForSend(userText || recentText).model;
  const apiConfig = input?.apiConfig || resolveComposerModelForSend(userText || recentText).apiConfig || getCustomModelApiConfig();
  if (!model || !apiConfig?.baseUrl) return { ok: false, reason: 'model_unavailable' };

  const job = await gatewayCall('memory.consolidation_job_create', {
    scope: input?.scope || 'global',
    reason: input?.reason || 'task_completed'
  }).catch(() => null);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 45000);
  try {
    const content = await fetchChatCompletion({
      model,
      apiConfig,
      temperature: 0.1,
      max_tokens: 1200,
      signal: controller.signal,
      messages: [
        {
          role: 'system',
          content:
            '你是叠云 Agent 的长期记忆归纳器。只输出 JSON，不要 Markdown。' +
            '从输入中提取未来任务仍可能用到的长期记忆。允许保存密钥、token、密码和隐私内容，但必须标记 kind。' +
            '不要保存一次性寒暄、临时过程、无结论猜测。每条 content 用一两句话，稳定、明确、可复用。' +
            '输出格式：{"memories":[{"content":"...","kind":"normal|private|secret","importance":1-5,"scope":"global|project"}]}' +
            '与工作空间架构/约定/常用命令/目录结构相关的事实请标记 scope=project。'
        },
        {
          role: 'user',
          content:
            `【用户任务】\n${userText || '无'}\n\n` +
            `【Agent 最终结果】\n${assistantText || '无'}\n\n` +
            `【近期上下文】\n${recentText || '无'}`
        }
      ]
    });
    const items = parseMemoryConsolidationJson(content);
    let saved = 0;
    const wsPath = input?.workspacePath ? String(input.workspacePath).trim() : '';
    for (const item of items) {
      const useProject =
        wsPath &&
        (String(item.scope || '').toLowerCase() === 'project' ||
          String(item.scope || '').toLowerCase() === 'workspace' ||
          Number(item.importance) >= 4);
      if (useProject) {
        await gatewayCall('memory.project_add', {
          workspacePath: wsPath,
          content: item.content,
          source: input?.source || 'auto_consolidation',
          kind: item.kind,
          importance: item.importance
        });
      } else {
        await gatewayCall('memory.long_add', {
          content: item.content,
          source: input?.source || 'auto_consolidation',
          kind: item.kind,
          scope: item.scope,
          importance: item.importance
        });
      }
      saved += 1;
    }
    if (job?.jobId) {
      await gatewayCall('memory.consolidation_job_finish', {
        jobId: job.jobId,
        status: 'completed'
      }).catch(() => {});
    }
    lastMemoryConsolidationAt = Date.now();
    return { ok: true, saved };
  } catch (err) {
    if (job?.jobId) {
      await gatewayCall('memory.consolidation_job_finish', {
        jobId: job.jobId,
        status: 'failed',
        error: err.message || String(err)
      }).catch(() => {});
    }
    return { ok: false, error: err.message || String(err) };
  } finally {
    clearTimeout(timeout);
  }
}

function scheduleMemoryConsolidation(input) {
  if (!gwState.authed) return;
  if (typeof scheduleUnifiedKnowledgeMaintenance === 'function') {
    scheduleUnifiedKnowledgeMaintenance({
      ...input,
      periodicOnly: true,
      memorySource: input?.source || 'periodic_consolidation',
      delayMs: Math.max(1000, Number(input?.delayMs) || 1000)
    });
    return;
  }
  if (memoryConsolidationPending) return;
  const now = Date.now();
  if (now - lastMemoryConsolidationAt < 60 * 1000) return;
  memoryConsolidationPending = true;
  setTimeout(() => {
    consolidateLongMemoryNow(input)
      .catch((err) => console.warn('memory consolidation', err))
      .finally(() => {
        memoryConsolidationPending = false;
      });
  }, Math.max(1000, Number(input?.delayMs) || 45000));
}

function startMemoryMaintenanceTimers() {
  if (typeof startKnowledgeConsolidationTimers === 'function') {
    startKnowledgeConsolidationTimers();
    return;
  }
  if (memoryMaintenanceTimer) return;
  memoryMaintenanceTimer = setInterval(() => {
    if (!gwState.authed) return;
    gatewayCall('memory.long_decay', { staleDays: 120, archiveDays: 240 }).catch(() => {});
    gatewayCall('memory.long_reindex', { limit: 100 }).catch(() => {});
    const recent = messages
      .slice(-16)
      .map((m) => `${m.role}: ${compactPlainText(m.content || '', 360)}`)
      .join('\n');
    if (recent) {
      scheduleMemoryConsolidation({
        reason: 'periodic',
        source: 'periodic_consolidation',
        recentText: recent,
        delayMs: 1000
      });
    }
  }, 6 * 60 * 60 * 1000);
}

// ---- SSE 流式响应的解析器 ----

function emitParsedSseJson(json, emit) {
  if (!json || typeof emit !== 'function') return;
  const choice = json?.choices?.[0];
  const delta = choice?.delta;
  if (delta) {
    repairDeltaMojibake(delta);
    if (json.usage) delta._usage = json.usage;
    emit(delta);
    return;
  }
  if (choice?.message) {
    const msg = choice.message;
    const merged = {
      content: typeof msg.content === 'string' ? msg.content : '',
      reasoning_content:
        typeof msg.reasoning_content === 'string' ? msg.reasoning_content : extractDeltaReasoning(msg)
    };
    if (Array.isArray(msg.tool_calls) && msg.tool_calls.length) {
      merged.tool_calls = msg.tool_calls;
    }
    if (merged.content || merged.reasoning_content || merged.tool_calls) {
      repairDeltaMojibake(merged);
      if (json.usage) merged._usage = json.usage;
      emit(merged);
    } else if (json?.usage) {
      emit({ _usage: json.usage });
    }
    return;
  }
  if (json?.usage) emit({ _usage: json.usage });
}

function processSseLineTrimmed(trimmed, emit) {
  if (!trimmed || !trimmed.startsWith('data:')) return null;
  const json = trimmed.slice(5).trim();
  if (!json) return null;
  if (json === '[DONE]') return 'done';
  try {
    emitParsedSseJson(JSON.parse(json), emit);
  } catch {
    // ignore bad json line
  }
  return null;
}

function processSseTextChunk(buffer, text, emit) {
  let buf = buffer + String(text || '');
  const lines = buf.split(/\r?\n/);
  buf = lines.pop() || '';
  for (const line of lines) {
    if (processSseLineTrimmed(line.trim(), emit) === 'done') return { buffer: '', done: true };
  }
  return { buffer: buf, done: false };
}

function flushSseBuffer(buffer, emit) {
  const tail = String(buffer || '').trim();
  if (!tail.startsWith('data:')) return;
  processSseLineTrimmed(tail, emit);
}

function countCjkChars(text) {
  return (String(text || '').match(/[\u3400-\u9fff\uf900-\ufaff]/g) || []).length;
}

function maybeRepairMojibakeText(value) {
  const text = String(value || '');
  if (!text) return text;
  if (!/[ÃÂÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖØÙÚÛÜÝÞßàáâãäåæçèéêëìíîïðñòôõöøùúûüýþÿ\u0080-\u009f]/.test(text)) {
    return text;
  }
  try {
    const bytes = new Uint8Array(text.length);
    for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i) & 0xff;
    const repaired = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    if (!repaired || repaired.includes('\uFFFD')) return text;
    const originalCjk = countCjkChars(text);
    const repairedCjk = countCjkChars(repaired);
    if (repairedCjk > originalCjk || (originalCjk === 0 && repairedCjk > 0)) return repaired;
  } catch {
    // ignore
  }
  return text;
}

function repairDeltaMojibake(delta) {
  if (!delta || typeof delta !== 'object') return delta;
  if (typeof delta.content === 'string') delta.content = maybeRepairMojibakeText(delta.content);
  for (const key of ['reasoning_content', 'reasoning', 'thinking']) {
    if (typeof delta[key] === 'string') delta[key] = maybeRepairMojibakeText(delta[key]);
  }
  for (const tc of delta.tool_calls || []) {
    if (tc?.function) {
      if (typeof tc.function.name === 'string') tc.function.name = maybeRepairMojibakeText(tc.function.name);
      if (typeof tc.function.arguments === 'string') {
        tc.function.arguments = maybeRepairMojibakeText(tc.function.arguments);
      }
    }
  }
  return delta;
}

function extractDeltaReasoning(delta) {
  if (!delta || typeof delta !== 'object') return '';
  for (const key of ['reasoning_content', 'reasoning', 'thinking']) {
    const text = delta[key];
    if (typeof text === 'string' && text) return text;
  }
  return '';
}

/**
 * tool_call deltas 是分片到达的，需要按 index 累积合并
 * 流结束后调用 flush() 返回完整 tool_calls 数组
 */
function buildToolCallAccumulator() {
  const byIndex = new Map();

  function apply(delta) {
    const calls = delta.tool_calls;
    if (!calls || !calls.length) return;
    calls.forEach((tc, callIdx) => {
      const idx = String(tc.index != null ? tc.index : callIdx);
      let acc = byIndex.get(idx);
      if (!acc) {
        acc = { id: tc.id || '', type: tc.type || 'function', function: { name: '', arguments: '' } };
        byIndex.set(idx, acc);
      }
      if (tc.id) acc.id = tc.id;
      if (tc.type) acc.type = tc.type;
      if (tc.function) {
        if (tc.function.name) acc.function.name += tc.function.name;
        if (tc.function.arguments != null && tc.function.arguments !== '') {
          const chunk = tc.function.arguments;
          if (typeof chunk === 'object') {
            acc.function.arguments = chunk;
          } else if (typeof acc.function.arguments === 'object') {
            acc.function.arguments = JSON.stringify(acc.function.arguments) + String(chunk);
          } else {
            acc.function.arguments += chunk;
          }
        }
      }
    });
  }

  function flush() {
    const out = [];
    for (const [, acc] of [...byIndex.entries()].sort((a, b) => Number(a[0]) - Number(b[0]))) {
      if (!String(acc.function?.name || '').trim()) continue;
      out.push({ ...acc, type: acc.type || 'function' });
    }
    return out.length ? out : null;
  }

  return { apply, flush };
}

/**
 * 流式 chat completion — 单轮（主进程 HTTP + 渲染进程 SSE 解析）
 */
async function streamChatCompletionOnce(body, signal, onDelta) {
  const apiBaseUrl = body._apiBaseUrl || settings.baseUrl;
  const apiKey = body._apiKey || settings.apiKey;

  let sendBody = { ...body };
  delete sendBody._apiBaseUrl;
  delete sendBody._apiKey;
  sendBody.messages = sanitizeMessagesForChatApi(sendBody.messages);
  sendBody.stream = true;
  sendBody.stream_options = { ...(sendBody.stream_options || {}), include_usage: true };

  const url = resolveEndpoint(apiBaseUrl);
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`
  };
  const payload = JSON.stringify(sendBody);

  let content = '';
  let reasoning = '';
  let usage = null;
  const tcAcc = buildToolCallAccumulator();
  let sseBuffer = '';

  const applyDelta = (delta) => {
    if (!delta) return;
    if (delta.content) content += delta.content;
    const reasoningChunk = extractDeltaReasoning(delta);
    if (reasoningChunk) reasoning += reasoningChunk;
    if (delta._usage) usage = delta._usage;
    tcAcc.apply(delta);
    if (onDelta) onDelta({ content, reasoning, hasToolCalls: false });
  };

  const consumeRaw = (text) => {
    const r = processSseTextChunk(sseBuffer, text, applyDelta);
    sseBuffer = r.buffer;
    if (r.done) sseBuffer = '';
  };

  if (agentApi.streamChatViaMain) {
    const ctrl = { abort: null };
    const streamPromise = agentApi.streamChatViaMain({
      url,
      headers,
      body: payload,
      onRaw: consumeRaw,
      onControl: ({ abort }) => {
        ctrl.abort = abort;
      }
    });
    const unbind = bindSignalToMainAbort(signal, () => ctrl.abort);
    try {
      await streamPromise;
    } finally {
      unbind();
    }
  } else {
    const resp = await apiFetchWithRetry(
      url,
      { method: 'POST', headers, body: payload, signal },
      apiBaseUrl,
      { phase: '流式对话' }
    );
    if (!resp.ok) {
      const errText = await resp.text();
      const err = new Error(`HTTP ${resp.status} ${resp.statusText}\n${errText.slice(0, 400)}`);
      err.statusCode = resp.status;
      throw err;
    }
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        if (signal?.aborted) {
          const err = new Error('已停止');
          err.name = 'AbortError';
          throw err;
        }
        let done;
        let value;
        try {
          ({ done, value } = await reader.read());
        } catch (err) {
          if (signal?.aborted || err?.name === 'AbortError') {
            const abortErr = new Error('已停止');
            abortErr.name = 'AbortError';
            throw abortErr;
          }
          throw enrichFetchError(err, apiBaseUrl, '流式响应');
        }
        if (done) break;
        consumeRaw(decoder.decode(value || new Uint8Array(), { stream: true }));
      }
    } finally {
      try {
        reader.cancel();
      } catch {
        // ignore
      }
    }
  }

  if (signal?.aborted) {
    const err = new Error('已停止');
    err.name = 'AbortError';
    throw err;
  }

  flushSseBuffer(sseBuffer, applyDelta);

  const toolCalls = normalizeToolCallsForApi(tcAcc.flush());
  const hasToolCalls = !!(toolCalls && toolCalls.length);
  if (onDelta) onDelta({ content, reasoning, hasToolCalls });

  if (usage) {
    await reportTokensToMain(usage, sendBody.model);
  } else if (usageStats) {
    const est = usageStats.estimateStreamCompletionUsage(sendBody, content, reasoning);
    if (est) await reportTokensToMain(est, sendBody.model);
  }

  return {
    content: content.trim(),
    reasoning: reasoning.trim(),
    toolCalls,
    hasToolCalls,
    usage
  };
}

/**
 * 流式 chat completion — 瞬时错误按采样次数重试，停止可打断等待
 */
async function streamChatCompletion(body, signal, onDelta, opts = {}) {
  const apiBaseUrl = body._apiBaseUrl || settings.baseUrl;
  return runRendererLlmReconnectRetry(() => streamChatCompletionOnce(body, signal, onDelta), {
    signal,
    apiBaseUrl,
    phase: '流式对话',
    maxWaitMs: resolveRendererReconnectBudgetMs(opts.maxWaitMs),
    onWait: (info) => {
      if (typeof opts.onReconnectWait === 'function') opts.onReconnectWait(info);
      else {
        const sec = Math.max(1, Math.round((info.waitMs || 0) / 1000));
        const remainMin = info.remainingMs > 0 ? Math.ceil(info.remainingMs / 60000) : 0;
        maybeShowLlmReconnectToast(
          '模型连接中断',
          remainMin > 0
            ? `${sec}s 后自动重试（第 ${info.attempt} 次，最长再等 ${remainMin} 分钟）`
            : `${sec}s 后自动重试（第 ${info.attempt}/${info.maxRetries || STREAM_ROUND_MAX_ATTEMPTS()} 次）`,
          { force: info.attempt === 1 }
        );
      }
    }
  }).then((result) => {
    noteLlmSuccess();
    return result;
  });
}
