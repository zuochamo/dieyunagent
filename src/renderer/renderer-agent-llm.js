/* global window, fetch, settings, gwState, gatewayCall, showAgentToast, executeAgentTool, formatToolArgsBrief, summarizeToolResult, TRACE_DESKTOP_THOUGHT_CHARS, getEffectiveInputBudget, getContextWindowTokens, getMaxOutputTokens, getContextReserveTokens, resolveComposerModelForSend, getCustomModelApiConfig, captureTurnBatchCheckpoint, isMutatingAgentTool, currentSessionId, noteContextCompaction, noteComposerSessionUsage, resolveComposerUsageSessionId, streamChatCompletion, fetchChatCompletion, upsertSynthesisTraceRound, getCurrentUndoTurnId, getUndoTurnIdForSession, supplierDisplayName, normalizeAgentToolName, compactDiffForTrace, getAgentLimits, trackArtifactsFromTrace, resolveSessionWorkspacePath, isWeakAssistantReply, AgentRoundText, formatModelFooterLabel, humanizeModelId, dismissAgentContinueRows, maybeShowProposeToolPreview, sanitizeOutboundImageUrl */
'use strict';

/**
 * 端点拼接与请求头装配的单一来源：`agent/llm-request.js`（经 agent-bundle 注册为
 * `window.LlmRequest`，与 Main 同一份实现），与 `renderer-model-settings.js` 的调用方式一致。
 *
 * 这里以前各留了一份内联兜底（三条端点规则 + `Content-Type + Bearer`）。兜底是**加法**：
 * 它让「自定义头 / authMode 静默失效」看起来像正常请求，只在 console 留一行警告。
 * bundle 未加载属于装配错误，直接抛 —— 与 `agent-guardrails.js` / 模型设置页同一立场。
 */
function requireLlmRequestApi() {
  const api = typeof window !== 'undefined' ? window.LlmRequest : null;
  if (!api || typeof api.resolveLlmEndpoint !== 'function') {
    throw new Error('agent-bundle 未加载：llm-request 不可用（端点拼接 / 请求头装配的唯一来源）');
  }
  return api;
}

function resolveEndpoint(baseUrl) {
  return requireLlmRequestApi().resolveLlmEndpoint(baseUrl, 'chat');
}

/**
 * 请求头装配：非流式与流式两处调用点共用本函数。
 */
function buildRendererLlmHeaders(apiConfig, apiBaseUrl, apiKey) {
  return requireLlmRequestApi().buildLlmHeadersFromConfig(
    { ...(apiConfig || {}), baseUrl: apiBaseUrl, apiKey },
    { sessionId: currentSessionId }
  );
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

/** HTTP 状态码解析单一来源（llm-reconnect-retry.parseHttpStatus）；bundle 缺失时保守返回 0。 */
function llmHttpStatus(err) {
  const shared = resolveLlmReconnectRetry();
  return shared && typeof shared.parseHttpStatus === 'function' ? shared.parseHttpStatus(err) : 0;
}

/**
 * 瞬时错误判定单一来源（llm-reconnect-retry.isTransientLlmError）。
 * 渲染层只加「用户取消优先」这一层：IPC 包装过的 AbortError 必须先在本地拦掉。
 * bundle 缺失时保守判「非瞬时」——宁可快速失败并展示错误，也不在此复制一份关键词表。
 */
function isTransientFetchError(err) {
  if (!err) return false;
  if (isUserAbortError(err)) return false;
  const shared = resolveLlmReconnectRetry();
  return shared ? shared.isTransientLlmError(err) : false;
}

/**
 * 用户主动停止判定 —— 渲染层唯一扩展点。
 * 刻意**不复用** llm-reconnect-retry.isAbortError：后者用 includes('已停止') 宽松匹配，
 * 会把「dieyun-core 已停止」这类内核错误误判成用户取消；此处只认精确串与 Electron IPC 包装。
 */
function isUserAbortError(err) {
  for (let cur = err; cur; cur = cur.cause) {
    if (!cur) break;
    if (cur.name === 'AbortError' || cur.code === 'ABORT_ERR') return true;
    const raw = String(cur.message || '').trim();
    const msg = raw.toLowerCase();
    if (msg === 'aborted' || raw === '已停止') return true;
    // Electron IPC：Error invoking remote method 'agent:rust-loop-run': AbortError: aborted
    if (/aborterror\s*:\s*aborted/.test(msg)) return true;
    if (/invoke remote method/.test(msg) && /aborterror|:\s*aborted/.test(msg)) return true;
  }
  return false;
}

/** AbortError 构造单一来源（llm-reconnect-retry.createAbortError）；bundle 缺失时降级为等价内联。 */
function userAbortError() {
  const shared = resolveLlmReconnectRetry();
  if (shared && typeof shared.createAbortError === 'function') return shared.createAbortError();
  const err = new Error('已停止');
  err.name = 'AbortError';
  return err;
}

function toUserAbortError(err, extra = {}) {
  const ae = userAbortError();
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
  const status = llmHttpStatus(base);
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

/**
 * 重连重试的**循环、退避与错误分类**由 src/llm-reconnect-retry.js 单一来源提供
 * （经 agent-bundle 注册为 window.LlmReconnectRetry，与 Main 侧同一份实现）。
 * 本函数只补渲染层专有部分：错误文案富化、连续失败通知、用户取消语义（见 isUserAbortError）。
 */
function resolveLlmReconnectRetry() {
  const mod = typeof window !== 'undefined' ? window.LlmReconnectRetry : null;
  return mod && typeof mod.runWithLlmReconnectRetry === 'function' ? mod : null;
}

async function runRendererLlmReconnectRetry(runOnce, opts = {}) {
  const { signal, onWait, maxWaitMs = 0, apiBaseUrl, phase = 'LLM' } = opts;
  const shared = resolveLlmReconnectRetry();
  if (!shared) {
    // 缺失只可能因 renderer agent bundle 未重建；降级为单次尝试，绝不在此复制退避循环。
    console.warn('[agent-llm] window.LlmReconnectRetry 缺失，重连重试降级为单次尝试；请重建 renderer agent bundle');
    try {
      return await runOnce();
    } catch (err) {
      throw enrichFetchError(err, apiBaseUrl, phase);
    }
  }
  try {
    return await shared.runWithLlmReconnectRetry(runOnce, {
      signal,
      onWait,
      isTransient: isTransientFetchError,
      // baseDelayMs / maxRetries 取 agent-limits 配置；maxDelayMs 用共享模块默认，勿再复制常量。
      baseDelayMs: LLM_RETRY_BASE_MS(),
      maxRetries: STREAM_ROUND_MAX_ATTEMPTS(),
      maxWaitMs: Number(maxWaitMs) > 0 ? Number(maxWaitMs) : 0
    });
  } catch (err) {
    // 共享循环抛出的错误未富化；此处补文案，并保留 LLM_RECONNECT_EXHAUSTED
    // （renderer-agent-rust-loop 依赖该 code 判定可续跑断点）。
    const exhausted = !!(err && err.code === 'LLM_RECONNECT_EXHAUSTED');
    if (exhausted) noteLlmFailure(err, apiBaseUrl);
    const out = enrichFetchError(err, apiBaseUrl, phase);
    if (err && err.code && !out.code) out.code = err.code;
    throw out;
  }
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

/**
 * 取思考回传共享实现（window.ReasoningBackfill，经 agent-bundle 注册的
 * src/agent/reasoning-backfill.js）。缺失（bundle 未重建）时安全退化：不补占位并告警，
 * 不在此内联第二份判定，避免与 Main 的语义再次分叉。
 */
function applyReasoningBackfill(messages, hasTools, echoReasoning) {
  const mod = typeof window !== 'undefined' ? window.ReasoningBackfill : null;
  if (!mod || typeof mod.backfillReasoningContent !== 'function') {
    console.warn('[llm] window.ReasoningBackfill 未加载，跳过 reasoning_content 回传');
    return messages;
  }
  return mod.backfillReasoningContent(messages, hasTools, !!echoReasoning);
}

/**
 * 能力表是否声明「脱工具也回传思考」（getChannelPolicy(model).echoReasoning）。
 * 缺失（bundle 未重建 / 模型未声明）时退化为 false，行为与改造前一致。
 */
function echoReasoningForModel(model) {
  const ch = typeof window !== 'undefined' ? window.LlmChannel : null;
  if (!ch || typeof ch.getChannelPolicy !== 'function' || !model) return false;
  try {
    return !!ch.getChannelPolicy(model).echoReasoning;
  } catch (e) {
    return false;
  }
}

function sanitizeMessagesForChatApi(messages, hasTools, model) {
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
    // 账本真思考（与 content 分列）：只作传输字段交给 reasoning-backfill 提升为
    // reasoning_content（真值优先），本函数不直接落 reasoning_content、不并进 content。
    if (role === 'assistant' && typeof m?.reasoning === 'string' && m.reasoning.trim()) {
      out.reasoning = m.reasoning;
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
    if (m?.tool_call_id) out.tool_call_id = String(m.tool_call_id);
    if (m?.name) out.name = String(m.name);
    return out;
  });
  const filtered = mapped.filter((m) => {
    if (!m || m.role !== 'tool') return true;
    const id = m.tool_call_id != null ? String(m.tool_call_id) : '';
    return !(id && droppedIds.has(id));
  });
  // 历史轮思考回传：单一来源（reasoning-backfill）。真值优先取账本 `reasoning`，
  // 真值不可得才补占位；判定与 Main 的 rust-loop-runner 完全一致（含「本轮带 tools 的普通回复轮」）。
  return applyReasoningBackfill(filtered, !!hasTools, echoReasoningForModel(model));
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

/**
 * 非流式一次调用。请求由 Main 递给 core（RPC `llm.complete`），渲染层**不发 HTTP、
 * 不拼请求头之外的任何传输细节**：端点与请求头仍只由 `agent/llm-request.js` 给出，
 * 这里只负责「问什么」与「失败怎么降级」。
 *
 * 返回：core 归一后的正文文本（与改造前同为字符串）。
 *
 * 瞬时重试/退避仍由外层 runRendererLlmReconnectRetry（单一来源 src/llm-reconnect-retry.js）
 * 负责：core 不在传输层重试，这里也不再复制第二层退避。
 */
async function fetchChatCompletion({ model, messages, temperature, max_tokens, response_format, apiConfig, signal }) {
  if (!agentApi.llmChatCompletion) {
    // 装配错误就直说：这条通道只能由 Main → core 发，渲染层不再有直连兜底。
    throw new Error('LLM 调用通道缺失（preload 未暴露 llmChatCompletion）：请重启客户端或重建 renderer bundle');
  }
  const apiBaseUrl = (apiConfig && apiConfig.baseUrl) || settings.baseUrl;
  const apiKey = (apiConfig && apiConfig.apiKey) || settings.apiKey;
  const url = resolveEndpoint(apiBaseUrl);
  const bodyPayload = {
    model,
    messages: sanitizeMessagesForChatApi(messages, false, model),
    temperature,
    max_tokens
  };
  if (response_format && typeof response_format === 'object') {
    bodyPayload.response_format = response_format;
  }
  const body = JSON.stringify(bodyPayload);
  // 请求头装配单点（唯一来源 llm-request，见 buildRendererLlmHeaders）。
  const headers = buildRendererLlmHeaders(apiConfig, apiBaseUrl, apiKey);

  return runRendererLlmReconnectRetry(
    async () => {
      // 请求由 Main 递给 core；瞬时重试由外层 runRendererLlmReconnectRetry 统一负责。
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
      let result;
      try {
        result = await reqPromise;
      } finally {
        unbind();
      }
      await reportTokensToMain(result, model);
      return String((result && result.content) || '').trim() || '(空响应)';
    },
    { signal, apiBaseUrl, phase: '对话请求' }
  ).then((text) => {
    noteLlmSuccess();
    return text;
  });
}


/**
 * core 的工具调用形状 `{ id, name, arguments }`（arguments 是已拼回的 JSON 字符串）
 * → 既有 OpenAI 形状，交给 normalizeToolCallsForApi 统一做 id 补齐与参数校验。
 * 对外仍只有 `normalizeToolCallsForApi` 一个出口。
 */
function toOpenAiToolCalls(toolCalls) {
  if (!Array.isArray(toolCalls)) return [];
  return toolCalls.map((tc) => ({
    id: tc && tc.id,
    type: 'function',
    function: { name: tc && tc.name, arguments: tc && tc.arguments }
  }));
}

/**
 * 流式 chat completion —— 单轮。
 *
 * 增量从哪来：core 解析 SSE 后经事件通道推 `agent.delta`，Main 按 runId 过滤再转发到本进程
 * （`agentApi.streamChatViaMain` 的 `onDelta`）。渲染层**不再自己发请求、不再解析 SSE**：
 * 传输与解析只有 `crates/dieyun-runtime/src/agent/llm.rs` 一份实现（原渲染层解析器与主进程
 * `llm-stream-utils.js` 两份重复实现已删除）。
 */
async function streamChatCompletionOnce(body, signal, onDelta) {
  // `_apiConfig` 承载完整模型配置（含自定义头 / authMode / userAgent）；
  // `_apiBaseUrl` / `_apiKey` 是历史遗留的简化写法，仍兼容。
  const apiConfig = body._apiConfig && typeof body._apiConfig === 'object' ? body._apiConfig : null;
  const apiBaseUrl = (apiConfig && apiConfig.baseUrl) || body._apiBaseUrl || settings.baseUrl;
  const apiKey = (apiConfig && apiConfig.apiKey) || body._apiKey || settings.apiKey;

  if (!agentApi.streamChatViaMain) {
    // 装配错误就直说：这条通道只能由 Main → core 发，渲染层没有直连兜底。
    throw new Error('LLM 流式调用通道缺失（preload 未暴露 streamChatViaMain）：请求只能由 Main → core 发');
  }

  const sendBody = { ...body };
  delete sendBody._apiBaseUrl;
  delete sendBody._apiKey;
  delete sendBody._apiConfig;
  sendBody.messages = sanitizeMessagesForChatApi(
    sendBody.messages,
    Array.isArray(sendBody.tools) && sendBody.tools.length > 0,
    sendBody.model
  );
  sendBody.stream = true;
  sendBody.stream_options = { ...(sendBody.stream_options || {}), include_usage: true };

  const url = resolveEndpoint(apiBaseUrl);
  const headers = buildRendererLlmHeaders(apiConfig, apiBaseUrl, apiKey);

  // 流式期间的本地累计只为给回调「到目前为止」的文本；最终值以 core 的结果为准。
  let liveContent = '';
  let liveReasoning = '';

  const ctrl = { abort: null };
  const streamPromise = agentApi.streamChatViaMain({
    url,
    headers,
    body: JSON.stringify(sendBody),
    onDelta: (delta) => {
      if (!delta) return;
      if (delta.content) liveContent += String(delta.content);
      if (delta.reasoning) liveReasoning += String(delta.reasoning);
      if (onDelta) onDelta({ content: liveContent, reasoning: liveReasoning, hasToolCalls: false });
    },
    onControl: ({ abort }) => {
      ctrl.abort = abort;
    }
  });
  const unbind = bindSignalToMainAbort(signal, () => ctrl.abort);
  let outcome;
  try {
    outcome = await streamPromise;
  } finally {
    unbind();
  }

  if (signal?.aborted) {
    throw userAbortError();
  }

  // 正文 / 思考 / 工具调用 / usage 都只有 core 那份解析器算得准。
  // 上游把错误当正常流回吐（HTTP 200 + `{"error":...}`）也由 core 变成失败抛出，这里无需再判。
  const result = (outcome && outcome.result) || {};
  const content = String(result.content != null ? result.content : liveContent).trim();
  const reasoning = String(result.reasoning != null ? result.reasoning : liveReasoning).trim();
  const usage = result.usage || null;
  const toolCalls = normalizeToolCallsForApi(toOpenAiToolCalls(result.toolCalls));
  const hasToolCalls = toolCalls.length > 0;
  if (onDelta) onDelta({ content, reasoning, hasToolCalls });

  if (usage) {
    await reportTokensToMain(usage, sendBody.model);
  } else if (usageStats) {
    const est = usageStats.estimateStreamCompletionUsage(sendBody, content, reasoning);
    if (est) await reportTokensToMain(est, sendBody.model);
  }

  return {
    content,
    reasoning,
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
