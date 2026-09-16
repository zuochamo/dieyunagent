/* global window, document, $, settings, currentSessionId, messages, sessionActiveRuns, chatInput, composerSendBtn, isSending, isCurrentSessionSending, estimateContextTokensFallback, estimateMessagesTokensViaMain, getEffectiveInputBudget, getContextWindowTokens, getMaxOutputTokens, getContextReserveTokens, lastComposerContextEstimate, reportTokensToMain, estimateTextTokens, getTextModelId, humanizeModelId, escapeHtml, CTX_LIMITS, dieyunI18n, invalidateSystemMessageCache */
'use strict';

const sessionContextEstimates = new Map();
let activeRunWorkingTokens = null;
/** @type {Map<string, { tokensBefore: number, tokensAfter: number }>} */
const sessionCompactionSnapshots = new Map();
let lastContextAutoCollapseBand = 0;
let contextProgressSeq = 0;
let contextProgressRefreshTimer = null;
let contextEstimateIpcTimer = null;
let contextEstimateIpcInflight = false;
const CONTEXT_ESTIMATE_IPC_DEBOUNCE_MS = 900;

function isCoreLikelyBusyForContextEstimate() {
  if (typeof isCurrentSessionSending === 'function' && isCurrentSessionSending()) return true;
  if (typeof sessionActiveRuns !== 'undefined' && sessionActiveRuns && sessionActiveRuns.size > 0) {
    for (const live of sessionActiveRuns.values()) {
      if (live && !live.finished) return true;
    }
  }
  return false;
}

function scheduleContextEstimateIpc(contextMessages, seq, parts) {
  if (contextEstimateIpcTimer) {
    clearTimeout(contextEstimateIpcTimer);
    contextEstimateIpcTimer = null;
  }
  contextEstimateIpcTimer = setTimeout(() => {
    contextEstimateIpcTimer = null;
    if (seq !== contextProgressSeq) return;
    if (isCoreLikelyBusyForContextEstimate()) return;
    if (contextEstimateIpcInflight) return;
    contextEstimateIpcInflight = true;
    void estimateMessagesTokensViaMain(contextMessages)
      .then((msgTokens) => {
        if (seq !== contextProgressSeq) return;
        const sendingNow = typeof isCurrentSessionSending === 'function' && isCurrentSessionSending();
        if (activeRunWorkingTokens != null && sendingNow) return;
        if (isCoreLikelyBusyForContextEstimate()) return;
        const liveInflight =
          sendingNow && typeof collectComposerContextMessages === 'function'
            ? collectComposerContextMessages().inflightTokens
            : 0;
        paintContextProgressFromParts(sendingNow, {
          systemTokens: parts.systemTokens,
          toolsTokens: parts.toolsTokens,
          rawMessageTokens: msgTokens,
          inflightTokens: liveInflight,
          draftEst: sendingNow ? parts.draftEst : 0
        });
      })
      .catch(() => {})
      .finally(() => {
        contextEstimateIpcInflight = false;
      });
  }, CONTEXT_ESTIMATE_IPC_DEBOUNCE_MS);
}
/** @type {{ system: number, tools: number, messages: number, rawMessages: number, inflight: number, used: number, rawUsed: number, budget: number, compacted: boolean }} */
let lastContextBreakdown = {
  system: 0,
  tools: 0,
  messages: 0,
  rawMessages: 0,
  inflight: 0,
  used: 0,
  rawUsed: 0,
  budget: 0,
  compacted: false
};
/** @type {Map<string, { llmRequests: number, totalTokens: number, promptTokens: number, completionTokens: number, cachedTokens: number, cacheHitPromptTokens: number, cacheTelemetryRequests: number, activeRunMs: number, runStartedAt: number | null, modelStats: Record<string, { requests: number, totalTokens: number, promptTokens: number, completionTokens: number }> }>} */
const composerSessionStats = new Map();
/** @type {string | null} */
let composerUsageAttributionSessionId = null;

function resolveContextSessionId(sessionId) {
  return String(sessionId != null ? sessionId : currentSessionId || '').trim() || '_default';
}

function getSessionContextEstimate(sessionId) {
  const sid = resolveContextSessionId(sessionId);
  if (!sessionContextEstimates.has(sid)) {
    sessionContextEstimates.set(sid, { system: '', toolsTokenEst: 0 });
  }
  return sessionContextEstimates.get(sid);
}

function setSessionContextEstimate(sessionId, patch) {
  const est = getSessionContextEstimate(sessionId);
  if (patch && typeof patch === 'object') {
    if (patch.system != null) est.system = String(patch.system);
    if (patch.toolsTokenEst != null) est.toolsTokenEst = Number(patch.toolsTokenEst) || 0;
  }
  return est;
}

function beginComposerUsageAttribution(sessionId) {
  composerUsageAttributionSessionId = resolveContextSessionId(sessionId);
}

function resolveComposerUsageSessionId() {
  return composerUsageAttributionSessionId || resolveContextSessionId();
}

function formatCompactTokenCount(n) {
  const v = Math.max(0, Math.round(Number(n) || 0));
  if (v >= 1000000) return `${(v / 1000000).toFixed(1)}M`;
  if (v >= 10000) return `${Math.round(v / 1000)}k`;
  if (v >= 1000) return `${(v / 1000).toFixed(1)}k`;
  return String(v);
}

function formatTokenCountFull(n) {
  return Math.max(0, Math.round(Number(n) || 0)).toLocaleString();
}

function formatContextRuntime(ms) {
  const totalSec = Math.max(0, Math.floor(Number(ms) / 1000));
  if (totalSec < 60) return `${totalSec}s`;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (min < 60) return sec ? `${min}m ${sec}s` : `${min}m`;
  const hour = Math.floor(min / 60);
  const remMin = min % 60;
  return remMin ? `${hour}h ${remMin}m` : `${hour}h`;
}

function formatHitRatePercent(cached, prompt) {
  if (typeof LlmUsageStats !== 'undefined' && LlmUsageStats.computeCacheHitRatePercent) {
    return LlmUsageStats.computeCacheHitRatePercent(cached, prompt);
  }
  const c = Math.max(0, Number(cached) || 0);
  const p = Math.max(0, Number(prompt) || 0);
  if (p <= 0) return c > 0 ? '100%' : '—';
  return `${Math.min(100, Math.round((c / p) * 100))}%`;
}

function normalizeSessionModelUsageMap(value) {
  if (typeof LlmUsageStats !== 'undefined' && LlmUsageStats.normalizeUsageModelMap) {
    return LlmUsageStats.normalizeUsageModelMap(value);
  }
  const out = {};
  if (!value || typeof value !== 'object') return out;
  for (const [model, tokens] of Object.entries(value)) {
    const name = String(model || '').trim();
    const n = Math.max(0, Math.floor(Number(tokens) || 0));
    if (name && n > 0) out[name] = (out[name] || 0) + n;
  }
  return out;
}

function ensureSessionModelStat(bucket, model) {
  if (!bucket.modelStats) bucket.modelStats = {};
  const key = String(model || '').trim() || '未知模型';
  if (!bucket.modelStats[key]) {
    bucket.modelStats[key] = {
      requests: 0,
      totalTokens: 0,
      promptTokens: 0,
      completionTokens: 0
    };
  }
  return bucket.modelStats[key];
}

function formatContextModelLabel(model) {
  const id = String(model || '').trim();
  if (!id) return '未知模型';
  if (typeof formatModelFooterLabel === 'function') return formatModelFooterLabel(id);
  if (typeof humanizeModelId === 'function') return humanizeModelId(id);
  return id;
}

function escapeContextHtml(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderComposerModelUsageBreakdown(modelStats) {
  const container = $('ctx-model-usage-list');
  if (!container) return;
  const entries = Object.entries(modelStats || {})
    .map(([model, stat]) => ({
      model,
      label: formatContextModelLabel(model),
      requests: Math.max(0, Number(stat?.requests) || 0),
      totalTokens: Math.max(0, Number(stat?.totalTokens) || 0),
      promptTokens: Math.max(0, Number(stat?.promptTokens) || 0),
      completionTokens: Math.max(0, Number(stat?.completionTokens) || 0)
    }))
    .filter((item) => item.requests > 0 || item.totalTokens > 0)
    .sort((a, b) => b.totalTokens - a.totalTokens || b.requests - a.requests);
  if (!entries.length) {
    container.innerHTML = '<p class="context-model-usage-empty">暂无模型调用</p>';
    return;
  }
  container.innerHTML = entries
    .map((item) => {
      const safeLabel = escapeContextHtml(item.label);
      const safeModel = escapeContextHtml(item.model);
      return (
        `<article class="context-model-usage-group" title="${safeModel}">` +
          `<div class="context-model-usage-name">${safeLabel}</div>` +
          `<div class="context-stats-row"><span>请求</span><span>${item.requests.toLocaleString()}</span></div>` +
          `<div class="context-stats-row"><span>累计 Token</span><span>${formatTokenCountFull(item.totalTokens)}</span></div>` +
          `<div class="context-stats-row"><span>输入 Token</span><span>${formatTokenCountFull(item.promptTokens)}</span></div>` +
          `<div class="context-stats-row"><span>输出 Token</span><span>${formatTokenCountFull(item.completionTokens)}</span></div>` +
        `</article>`
      );
    })
    .join('');
}

function getComposerSessionStats(sessionId) {
  const sid = resolveContextSessionId(sessionId);
  if (!composerSessionStats.has(sid)) {
    composerSessionStats.set(sid, {
      llmRequests: 0,
      totalTokens: 0,
      promptTokens: 0,
      completionTokens: 0,
      cachedTokens: 0,
      cacheHitPromptTokens: 0,
      cacheTelemetryRequests: 0,
      activeRunMs: 0,
      runStartedAt: null,
      modelStats: {}
    });
  }
  const bucket = composerSessionStats.get(sid);
  if (!bucket.modelStats) bucket.modelStats = {};
  return bucket;
}

function getContextRingCapacity() {
  const n = typeof getContextWindowTokens === 'function' ? getContextWindowTokens() : 0;
  return Math.max(1, Math.floor(Number(n) || 0));
}

function noteComposerSessionRunStart(sessionId) {
  const stats = getComposerSessionStats(sessionId);
  stats.runStartedAt = Date.now();
  const capacity = lastContextBreakdown.budget || getContextRingCapacity();
  const ratio = capacity > 0 ? lastContextBreakdown.used / capacity : 0;
  updateComposerContextStatsUi(lastContextBreakdown.used, capacity, ratio, true);
}

function noteComposerSessionRunEnd(sessionId) {
  const stats = getComposerSessionStats(sessionId);
  if (stats.runStartedAt) {
    stats.activeRunMs += Math.max(0, Date.now() - stats.runStartedAt);
    stats.runStartedAt = null;
  }
  const capacity = lastContextBreakdown.budget || getContextRingCapacity();
  const ratio = capacity > 0 ? lastContextBreakdown.used / capacity : 0;
  updateComposerContextStatsUi(lastContextBreakdown.used, capacity, ratio, false);
}

function noteComposerSessionUsage(sessionId, stats) {
  if (!stats) return;
  const total = Number(stats.totalTokens) || 0;
  const prompt = Number(stats.promptTokens) || 0;
  const completion = Number(stats.completionTokens) || 0;
  const cached = Number(stats.cachedTokens) || 0;
  const cacheTelemetry = stats.cacheTelemetry === true;
  if (total <= 0 && prompt <= 0 && completion <= 0) return;
  const bucket = getComposerSessionStats(sessionId);
  bucket.llmRequests += 1;
  bucket.totalTokens += total || prompt + completion;
  bucket.promptTokens += prompt;
  bucket.completionTokens += completion;
  if (cacheTelemetry) {
    bucket.cacheTelemetryRequests += 1;
    bucket.cacheHitPromptTokens += prompt;
    bucket.cachedTokens += cached;
  }
  const modelMap = normalizeSessionModelUsageMap(stats.modelUsage);
  const modelNames = Object.keys(modelMap);
  if (modelNames.length === 1) {
    const model = modelNames[0];
    const m = ensureSessionModelStat(bucket, model);
    m.requests += 1;
    m.totalTokens += total || prompt + completion;
    m.promptTokens += prompt;
    m.completionTokens += completion;
  } else if (modelNames.length > 1) {
    for (const [model, tokens] of Object.entries(modelMap)) {
      const m = ensureSessionModelStat(bucket, model);
      m.requests += 1;
      m.totalTokens += tokens;
    }
  } else if (total > 0 || prompt > 0 || completion > 0) {
    const m = ensureSessionModelStat(bucket, '未知模型');
    m.requests += 1;
    m.totalTokens += total || prompt + completion;
    m.promptTokens += prompt;
    m.completionTokens += completion;
  }
  const capacity = lastContextBreakdown.budget || getContextRingCapacity();
  const ratio = capacity > 0 ? lastContextBreakdown.used / capacity : 0;
  updateComposerContextStatsUi(lastContextBreakdown.used, capacity, ratio, false);
}

function getComposerSessionRuntimeMs(sessionId) {
  const stats = getComposerSessionStats(sessionId);
  return stats.activeRunMs + (stats.runStartedAt ? Math.max(0, Date.now() - stats.runStartedAt) : 0);
}

function updateComposerContextStatsUi(used, capacity, ratio, sending) {
  const stats = getComposerSessionStats(currentSessionId);
  const runtimeMs = getComposerSessionRuntimeMs(currentSessionId);
  const hitRate = formatHitRatePercent(stats.cachedTokens, stats.cacheHitPromptTokens);
  const level = ratio > 0.88 ? 'warn' : ratio > 0.72 ? 'mid' : 'ok';
  const remainPct = capacity > 0 ? Math.round(Math.max(0, Math.min(100, (1 - used / capacity) * 100))) : 0;
  const inputBudget =
    typeof getEffectiveInputBudget === 'function' ? getEffectiveInputBudget() : 0;

  const progressBlock = $('context-stats-ring-block');
  if (progressBlock) progressBlock.dataset.level = level;

  const fillPct = capacity > 0 ? Math.max(0, Math.min(100, ratio * 100)) : 0;

  const progressFill = $('ctx-panel-progress-fill');
  if (progressFill) {
    progressFill.style.width = `${fillPct}%`;
  }

  const setRow = (id, value) => {
    const el = $(id);
    if (el) el.textContent = value;
  };
  const budgetLine = `${formatTokenCountFull(used)} / ${formatTokenCountFull(capacity)}`;
  setRow('ctx-stat-system', formatTokenCountFull(lastContextBreakdown.system));
  setRow('ctx-stat-tools', formatTokenCountFull(lastContextBreakdown.tools));
  setRow(
    'ctx-stat-messages',
    formatTokenCountFull(
      lastContextBreakdown.rawMessages > 0
        ? lastContextBreakdown.rawMessages
        : lastContextBreakdown.messages
    )
  );
  setRow('ctx-stat-inflight', formatTokenCountFull(lastContextBreakdown.inflight));
  setRow('ctx-stat-budget', budgetLine);
  setRow('ctx-stat-requests', String(stats.llmRequests));
  setRow('ctx-stat-session-tokens', formatTokenCountFull(stats.totalTokens));
  setRow('ctx-stat-prompt-tokens', formatTokenCountFull(stats.promptTokens));
  setRow('ctx-stat-completion-tokens', formatTokenCountFull(stats.completionTokens));
  setRow('ctx-stat-hit-rate', hitRate);
  const hitRateEl = $('ctx-stat-hit-rate');
  if (hitRateEl) {
    if (stats.cacheHitPromptTokens > 0) {
      hitRateEl.title = `缓存 ${formatTokenCountFull(stats.cachedTokens)} / 输入 ${formatTokenCountFull(stats.cacheHitPromptTokens)} tokens（${stats.cacheTelemetryRequests} 次请求返回缓存字段）`;
    } else {
      hitRateEl.title = '尚无返回缓存字段的 LLM 请求';
    }
  }
  setRow('ctx-stat-runtime', runtimeMs > 0 ? formatContextRuntime(runtimeMs) : sending ? '计时中…' : '—');
  setRow('ctx-panel-window', `预计发送 · 剩余 ${remainPct}%`);
  const historyNote = $('ctx-panel-history-note');
  const rawUsed = Number(lastContextBreakdown.rawUsed) || used;
  if (historyNote) {
    if (rawUsed > used * 1.08 && inputBudget > 0 && rawUsed > inputBudget * 0.9) {
      historyNote.hidden = false;
      historyNote.textContent = `历史已攒约 ${formatTokenCountFull(rawUsed)}（请求前会压缩）`;
    } else if (rawUsed > used * 1.08) {
      historyNote.hidden = false;
      historyNote.textContent = `历史已攒约 ${formatTokenCountFull(rawUsed)}`;
    } else {
      historyNote.hidden = true;
      historyNote.textContent = '';
    }
  }
  setRow('ctx-stat-input-budget', formatTokenCountFull(inputBudget));
  setRow('ctx-stat-context-window', getContextWindowTokens().toLocaleString());
  setRow('ctx-stat-output-reserve', getMaxOutputTokens().toLocaleString());
  setRow('ctx-stat-safety-reserve', getContextReserveTokens().toLocaleString());
  setRow('ctx-panel-summary', `${formatCompactTokenCount(used)}/${formatCompactTokenCount(capacity)} · 剩 ${remainPct}%`);
  renderComposerModelUsageBreakdown(stats.modelStats);
}

function estimateSystemPromptTokens(sessionId) {
  const system = getSessionContextEstimate(sessionId).system || '';
  return typeof estimateTextTokens === 'function'
    ? estimateTextTokens(system)
    : Math.ceil(String(system).length / 3.2);
}

function estimateSystemToolsExtra(sessionId) {
  const est = getSessionContextEstimate(sessionId);
  return estimateSystemPromptTokens(sessionId) + (est.toolsTokenEst || 0);
}

function estimateInflightRunTokens(live) {
  if (!live || live.finished || live.inPrepPhase) return 0;
  const INFLIGHT_TEXT_CAP = 8192;
  const capText = (text) => {
    const s = String(text || '');
    return s.length > INFLIGHT_TEXT_CAP ? s.slice(0, INFLIGHT_TEXT_CAP) : s;
  };
  const addText = (text) => {
    const s = String(text || '').trim();
    if (!s) return 0;
    return (typeof estimateTextTokens === 'function' ? estimateTextTokens(capText(s)) : Math.ceil(capText(s).length / 3.2)) + 6;
  };

  let total = 0;
  let latestThought = '';
  const trace = Array.isArray(live.trace) ? live.trace : [];
  for (const entry of trace) {
    if (!entry || entry.phase === 'prep') continue;
    const thought = String(entry.fullThought || entry.thought || '').trim();
    if (thought) latestThought = thought;
    total += addText(thought);
    for (const tool of entry.tools || []) {
      if (!tool || typeof tool !== 'object') continue;
      total += addText(tool.name);
      total += addText(tool.summary);
      total += addText(tool.argsBrief);
    }
  }

  const stream = String(live.streamContent || '').trim();
  if (stream) {
    const duplicate =
      latestThought &&
      (stream === latestThought || latestThought.includes(stream) || stream.includes(latestThought));
    if (!duplicate) total += addText(stream);
  }
  return total;
}

function collectComposerContextMessages() {
  const contextMessages = messages.map((m) => ({
    role: m.role,
    content:
      m.role === 'user'
        ? unpackUserMessageContent(m.content || m.displayContent || '').content
        : splitPersistedAssistantTrace(unpackAssistantMeta(m.content || '').content).content
  }));
  const draft = chatInput ? chatInput.value : '';
  if (draft.trim()) {
    contextMessages.push({ role: 'user', content: draft });
  }
  const composerAttachments = getPendingAttachments();
  if (composerAttachments.length) {
    contextMessages.push({
      role: 'user',
      content: composerAttachments.map((a) => `附件：${a.originalName || a.path || ''}`).join('\n')
    });
  }
  const sid = String(currentSessionId || '');
  const sending = typeof isCurrentSessionSending === 'function' && isCurrentSessionSending();
  let inflightTokens = 0;
  if (sending && sid) {
    const live = sessionActiveRuns.get(sid);
    if (live && !live.finished) {
      inflightTokens = estimateInflightRunTokens(live);
    }
  }
  return { contextMessages, draft, sending, inflightTokens };
}

function scheduleContextProgressRefresh() {
  if (contextProgressRefreshTimer) return;
  contextProgressRefreshTimer = setTimeout(() => {
    contextProgressRefreshTimer = null;
    refreshContextProgress();
  }, 280);
}

function getSessionCompactionSnapshot(sessionId) {
  return sessionCompactionSnapshots.get(resolveContextSessionId(sessionId)) || null;
}

function setSessionCompactionSnapshot(sessionId, snap) {
  const sid = resolveContextSessionId(sessionId);
  if (!snap || !Number.isFinite(Number(snap.tokensAfter))) {
    sessionCompactionSnapshots.delete(sid);
    return;
  }
  sessionCompactionSnapshots.set(sid, {
    tokensBefore: Number(snap.tokensBefore) || 0,
    tokensAfter: Number(snap.tokensAfter) || 0
  });
}

function clearSessionCompactionSnapshot(sessionId) {
  setSessionCompactionSnapshot(sessionId, null);
}

if (typeof window !== 'undefined') {
  window.clearSessionCompactionSnapshot = clearSessionCompactionSnapshot;
}

/** 圆环用「预计发送」历史量：优先压缩后工作集，否则用原始堆积估算 */
function resolveWorkingMessageTokens(rawMessageTokens, sending) {
  const raw = Math.max(0, Number(rawMessageTokens) || 0);
  if (sending && activeRunWorkingTokens != null && Number.isFinite(activeRunWorkingTokens)) {
    return Math.max(0, activeRunWorkingTokens);
  }
  const snap = getSessionCompactionSnapshot(currentSessionId);
  if (snap && Number.isFinite(snap.tokensAfter)) {
    // 原始历史变短（撤回/新会话片段）时跟 raw；否则用上次压缩后体积作「预计发送」
    if (raw <= snap.tokensAfter) return raw;
    return Math.max(0, snap.tokensAfter);
  }
  return raw;
}

function resetActiveRunContextUiState(sessionId) {
  activeRunWorkingTokens = null;
  // 保留 sessionCompactionSnapshots：空闲圆环继续显示上次预计发送量
  lastContextAutoCollapseBand = 0;
  setSessionContextEstimate(sessionId, { system: '', toolsTokenEst: 0 });
  contextProgressSeq += 1;
  if (contextProgressRefreshTimer) {
    clearTimeout(contextProgressRefreshTimer);
    contextProgressRefreshTimer = null;
  }
  if (contextEstimateIpcTimer) {
    clearTimeout(contextEstimateIpcTimer);
    contextEstimateIpcTimer = null;
  }
  contextEstimateIpcInflight = false;
  if (typeof resetTraceAutoCollapseState === 'function') resetTraceAutoCollapseState();
}

function noteContextCompaction(cr, sessionId) {
  if (!cr) return;
  const sid = sessionId != null && String(sessionId).trim() ? String(sessionId).trim() : '';
  if (!sid) return;
  if (typeof invalidateSystemMessageCache === 'function') {
    invalidateSystemMessageCache(sid);
  }
  if (typeof cr.tokensAfter === 'number' && Number.isFinite(cr.tokensAfter)) {
    activeRunWorkingTokens = cr.tokensAfter;
  }
  if (
    typeof cr.tokensBefore === 'number' &&
    Number.isFinite(cr.tokensBefore) &&
    typeof cr.tokensAfter === 'number' &&
    Number.isFinite(cr.tokensAfter)
  ) {
    setSessionCompactionSnapshot(sid, {
      tokensBefore: cr.tokensBefore,
      tokensAfter: cr.tokensAfter
    });
  }
  lastContextAutoCollapseBand = Math.max(lastContextAutoCollapseBand, 2);
  refreshContextProgress();
}

function paintContextProgressRing(used, sending, breakdown) {
  const wrap = $('composer-context-wrap');
  const ring = $('composer-context-ring-fg');
  if (!wrap || !ring) return;
  const capacity = getContextRingCapacity();
  const ratio = capacity > 0 ? Math.max(0, Math.min(1, used / capacity)) : 0;
  const remainRatio = 1 - ratio;
  const band = ratio > 0.88 ? 2 : ratio > 0.72 ? 1 : 0;
  if (sending && band > lastContextAutoCollapseBand) {
    lastContextAutoCollapseBand = band;
  }
  const circumference = 97.4;
  const offset = circumference * (1 - ratio);
  ring.style.strokeDashoffset = String(offset);
  ring.setAttribute('stroke-dashoffset', String(offset));
  wrap.dataset.level = ratio > 0.88 ? 'warn' : ratio > 0.72 ? 'mid' : 'ok';
  const compacted = !!(breakdown && breakdown.compacted);
  if (compacted) wrap.dataset.compacted = '1';
  else delete wrap.dataset.compacted;
  if (breakdown && typeof breakdown === 'object') {
    lastContextBreakdown = {
      system: breakdown.system || 0,
      tools: breakdown.tools || 0,
      messages: breakdown.messages || 0,
      rawMessages: breakdown.rawMessages || breakdown.messages || 0,
      inflight: breakdown.inflight || 0,
      used,
      rawUsed: breakdown.rawUsed != null ? breakdown.rawUsed : used,
      budget: capacity,
      compacted
    };
  } else {
    lastContextBreakdown = { ...lastContextBreakdown, used, budget: capacity };
  }
  const remainPct = Math.round(remainRatio * 100);
  const rawUsed = lastContextBreakdown.rawUsed || used;
  let title = `预计发送 ${Math.round(used).toLocaleString()} / ${capacity.toLocaleString()} tokens（剩余 ${remainPct}%）`;
  if (rawUsed > used * 1.08) {
    title += `\n历史已攒约 ${Math.round(rawUsed).toLocaleString()} tokens`;
  }
  if (compacted) title += ' · 含压缩后估算';
  wrap.title = title;
  updateComposerContextStatsUi(used, capacity, ratio, sending);
}

function paintContextProgressFromParts(sending, parts) {
  const systemTokens = parts.systemTokens || 0;
  const toolsTokens = parts.toolsTokens || 0;
  const rawMessageTokens =
    parts.rawMessageTokens != null ? parts.rawMessageTokens : parts.messageTokens || 0;
  const workingMessageTokens =
    parts.workingMessageTokens != null
      ? parts.workingMessageTokens
      : resolveWorkingMessageTokens(rawMessageTokens, sending);
  const inflightTokens = parts.inflightTokens || 0;
  const draftEst = parts.draftEst || 0;
  const used = systemTokens + toolsTokens + workingMessageTokens + inflightTokens + draftEst;
  const rawUsed = systemTokens + toolsTokens + rawMessageTokens + inflightTokens + draftEst;
  paintContextProgressRing(used, sending, {
    system: systemTokens,
    tools: toolsTokens,
    messages: workingMessageTokens,
    rawMessages: rawMessageTokens,
    inflight: inflightTokens + draftEst,
    rawUsed,
    compacted: workingMessageTokens + 32 < rawMessageTokens
  });
}

function refreshContextProgress() {
  const wrap = $('composer-context-wrap');
  const ring = $('composer-context-ring-fg');
  if (!wrap || !ring) return;
  const { contextMessages, draft, sending, inflightTokens } = collectComposerContextMessages();
  const systemTokens = estimateSystemPromptTokens(currentSessionId);
  const toolsTokens = getSessionContextEstimate(currentSessionId).toolsTokenEst || 0;
  const draftEst =
    draft.trim() && typeof estimateTextTokens === 'function'
      ? estimateTextTokens(draft) + 6
      : draft.trim()
        ? Math.ceil(draft.length / 3.2) + 6
        : 0;

  const syncMessageTokens = estimateContextTokensFallback(contextMessages);
  const workingMessageTokens =
    sending && activeRunWorkingTokens != null
      ? activeRunWorkingTokens
      : resolveWorkingMessageTokens(syncMessageTokens, sending);

  if (sending && activeRunWorkingTokens != null) {
    contextProgressSeq += 1;
    paintContextProgressFromParts(sending, {
      systemTokens,
      toolsTokens,
      rawMessageTokens: syncMessageTokens,
      workingMessageTokens,
      inflightTokens,
      draftEst
    });
    return;
  }

  paintContextProgressFromParts(sending, {
    systemTokens,
    toolsTokens,
    rawMessageTokens: syncMessageTokens,
    workingMessageTokens,
    inflightTokens,
    draftEst
  });

  const seq = ++contextProgressSeq;
  if (!isCoreLikelyBusyForContextEstimate()) {
    scheduleContextEstimateIpc(contextMessages, seq, {
      systemTokens,
      toolsTokens,
      inflightTokens,
      draftEst
    });
  }
}

function setComposerSendingState(sending) {
  const wasSending = isSending;
  isSending = sending;
  if (sending && !wasSending) noteComposerSessionRunStart(currentSessionId);
  if (!sending && wasSending) noteComposerSessionRunEnd(currentSessionId);
  if (composerSendBtn) {
    if (sending) {
      composerSendBtn.type = 'button';
      composerSendBtn.classList.add('stopping');
      composerSendBtn.title = '停止';
      composerSendBtn.setAttribute('aria-label', '停止');
    } else {
      composerSendBtn.type = 'submit';
      composerSendBtn.classList.remove('stopping');
      composerSendBtn.title = '发送';
      composerSendBtn.setAttribute('aria-label', '发送');
    }
  }
}
