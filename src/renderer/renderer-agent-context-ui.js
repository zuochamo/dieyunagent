/* global window, document, $, settings, currentSessionId, messages, sessionActiveRuns, chatInput, composerSendBtn, isSending, isCurrentSessionSending, estimateContextTokensFallback, estimateMessagesTokensViaMain, getEffectiveInputBudget, getContextWindowTokens, getMaxOutputTokens, getContextReserveTokens, lastComposerContextEstimate, reportTokensToMain, estimateTextTokens, getTextModelId, humanizeModelId, escapeHtml, CTX_LIMITS, dieyunI18n, invalidateSystemMessageCache, gatewayCall, toast */
'use strict';

const sessionContextEstimates = new Map();
let activeRunWorkingTokens = null;
/**
 * 最近一次发送里**实际进入 system prompt** 的记忆条目（Main `prepSystemPrompt` 的 memoryAudit）。
 * 只存最近一次：这是「本轮模型看到了什么」的事实，不是历史审计（历史在 request_snapshots）。
 * @type {{ sessionId: string, audit: object | null } | null}
 */
let lastMemoryInjection = null;
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
  renderMemoryInjectionRows();
  bindMemorySessionControls();
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

/**
 * 记录本轮注入事实（Renderer 只搬运：召回、阈值、kind 过滤、条数都在 Main）。
 * @param {string} sessionId
 * @param {object | null} audit prepSystemPrompt 返回的 memoryAudit
 */
function setLastMemoryInjectionAudit(sessionId, audit) {
  lastMemoryInjection = {
    sessionId: String(sessionId || ''),
    audit: audit && typeof audit === 'object' ? audit : null
  };
  renderMemoryInjectionRows();
}

function formatMemoryAuditCell(block) {
  if (!block) return '未注入';
  const ids = Array.isArray(block.ids) ? block.ids : [];
  const modeLabel =
    block.mode === 'semantic'
      ? '语义'
      : block.mode === 'keyword'
        ? '关键词'
        : block.mode === 'recent'
          ? '最近'
          : '未命中';
  const excluded = Number(block.excluded) || 0;
  if (!ids.length) return `${modeLabel} · 0 条`;
  const shown = ids
    .slice(0, 4)
    .map((id) => `#${id}`)
    .join(' ');
  return `${modeLabel} · ${ids.length} 条 · ${shown}${ids.length > 4 ? ' …' : ''}${
    excluded > 0 ? `（按 kind 隐去 ${excluded}）` : ''
  }`;
}

function renderMemoryInjectionRows() {
  const audit = lastMemoryInjection && lastMemoryInjection.audit;
  const setRow = (id, value, title) => {
    const el = $(id);
    if (!el) return;
    el.textContent = value;
    if (title) el.title = title;
    else el.removeAttribute('title');
  };
  if (!audit) {
    setRow('ctx-memory-project', '—');
    setRow('ctx-memory-global', '—');
    setRow('ctx-memory-extra', '');
    const emptyExtraRow = $('ctx-memory-extra-row');
    if (emptyExtraRow) emptyExtraRow.hidden = true;
    return;
  }
  setRow('ctx-memory-project', formatMemoryAuditCell(audit.project), audit.project ? `mode=${audit.project.mode || ''}` : '');
  setRow('ctx-memory-global', formatMemoryAuditCell(audit.global), audit.global ? `mode=${audit.global.mode || ''}` : '');
  const extras = [];
  if (audit.handoff && audit.handoff.from) extras.push(`交接 ${audit.handoff.from}`);
  if (audit.workMemory) {
    extras.push(`工作记忆${audit.workMemory.runId ? ` ${audit.workMemory.runId}` : ''}`);
  }
  const extraRow = $('ctx-memory-extra-row');
  if (extraRow) extraRow.hidden = extras.length === 0;
  setRow('ctx-memory-extra', extras.join(' · '));
}

/**
 * 会话维度的「沉淀了什么 / 忘掉」——唯一入口是 Gateway `memory.session_memories*`
 * （写入时带 session_id，见 memory.long_add）。Renderer 只渲染，不判断该不该记。
 */
async function loadSessionMemories() {
  const listEl = $('ctx-memory-session-items');
  const forgetBtn = $('ctx-memory-session-forget');
  const sid = String(typeof currentSessionId !== 'undefined' ? currentSessionId || '' : '');
  if (!listEl) return;
  if (!sid || typeof gatewayCall !== 'function') {
    listEl.hidden = false;
    listEl.textContent = '当前没有会话';
    if (forgetBtn) forgetBtn.hidden = true;
    return;
  }
  listEl.hidden = false;
  listEl.textContent = '读取中…';
  try {
    const res = await gatewayCall('memory.session_memories', { sessionId: sid, limit: 50 });
    const rows = res && Array.isArray(res.results) ? res.results : [];
    if (!rows.length) {
      listEl.textContent = '本会话没有沉淀记忆（旧版本写入的记忆没有会话来源）';
      if (forgetBtn) forgetBtn.hidden = true;
      return;
    }
    listEl.innerHTML = rows
      .map((r) => {
        const kind = r.kind && r.kind !== 'normal' ? ` [${escapeHtml(String(r.kind))}]` : '';
        const imp = r.importance != null ? ` ·${r.importance}` : '';
        return `<div class="context-stats-memory-item">#${escapeHtml(String(r.id))}${kind}${imp} ${
          escapeHtml(String(r.content || '').slice(0, 120))
        }</div>`;
      })
      .join('');
    if (forgetBtn) {
      forgetBtn.hidden = false;
      forgetBtn.textContent = `忘掉这 ${rows.length} 条`;
    }
  } catch (err) {
    listEl.textContent = `读取失败：${err && (err.message || err)}`;
    if (forgetBtn) forgetBtn.hidden = true;
  }
}

async function forgetSessionMemories() {
  const listEl = $('ctx-memory-session-items');
  const sid = String(typeof currentSessionId !== 'undefined' ? currentSessionId || '' : '');
  if (!sid || typeof gatewayCall !== 'function') return;
  try {
    const res = await gatewayCall('memory.session_memories_forget', { sessionId: sid });
    const n = Number(res && res.archived) || 0;
    if (listEl) {
      listEl.textContent = n ? `已归档 ${n} 条（可在记忆库里恢复）` : '没有可归档的记忆';
    }
    const forgetBtn = $('ctx-memory-session-forget');
    if (forgetBtn) forgetBtn.hidden = true;
    if (typeof toast === 'function') toast('记忆已归档', `${n} 条本会话沉淀的记忆已软归档`);
  } catch (err) {
    if (listEl) listEl.textContent = `归档失败：${err && (err.message || err)}`;
  }
}

let memorySessionControlsBound = false;
function bindMemorySessionControls() {
  if (memorySessionControlsBound) return;
  const btn = $('ctx-memory-session-btn');
  const forgetBtn = $('ctx-memory-session-forget');
  if (!btn && !forgetBtn) return;
  memorySessionControlsBound = true;
  if (btn) btn.addEventListener('click', () => void loadSessionMemories());
  if (forgetBtn) {
    forgetBtn.addEventListener('click', () => {
      if (typeof window !== 'undefined' && typeof window.confirm === 'function') {
        if (!window.confirm('把这期间由本会话沉淀的记忆全部归档？可在记忆库里恢复。')) return;
      }
      void forgetSessionMemories();
    });
  }
}

function estimateSystemPromptTokens(sessionId) {
  const system = getSessionContextEstimate(sessionId).system || '';
  return estimateTextTokens(system);
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
    return estimateTextTokens(capText(s)) + 6;
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
  window.setLastMemoryInjectionAudit = setLastMemoryInjectionAudit;
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
}

/**
 * 压缩失败的原始原因是 Rust 侧分类码，展示前翻成人话。
 * 码的唯一来源是 `crates/dieyun-core/src/compaction/llm.rs`；这里只是展示层映射，
 * 未收录的新码会原样显示（便于发现新增分类），不会被吞掉。
 */
const COMPACTION_REASON_LABELS = {
  LLM_UPSTREAM_TIMEOUT: '代理上游写超时',
  LLM_UPSTREAM_5XX: '上游服务错误',
  LLM_TIMEOUT: '请求超时',
  LLM_CONNECT: '连不上服务',
  LLM_BAD_JSON: '响应非 JSON',
  LLM_BAD_REQUEST: '请求被拒',
  LLM_AUTH: '鉴权失败',
  LLM_RATE_LIMIT: '被限流',
  LLM_EMPTY_CONTENT: '模型未输出正文',
  LLM_REASONING_ONLY: '模型只输出思考',
  LLM_HTTP: '网络错误',
  LLM_CONFIG: '模型未配置',
  content_policy: '内容审核拒绝',
  llm_error: 'LLM 调用失败'
};

let compactionStatsLoading = false;
let compactionStatsLastAt = 0;
let compactionStatsRefreshTimer = null;
const COMPACTION_STATS_MIN_INTERVAL_MS = 3000;
const COMPACTION_STATS_DEBOUNCE_MS = 1200;

function scheduleCompactionStatsRefresh() {
  if (compactionStatsRefreshTimer) return;
  compactionStatsRefreshTimer = setTimeout(() => {
    compactionStatsRefreshTimer = null;
    // force：压缩是低频事件，防抖已经把抖动合并掉了，再撞 3s 最小间隔只会让
    // 「刚压缩完」的统计要等下一次触发才出现（且撞上节流时是直接丢弃、不是排队）。
    loadCompactionStats({ force: true }).catch(() => {});
  }, COMPACTION_STATS_DEBOUNCE_MS);
}

/**
 * 上下文压缩统计（次数 / 动态 / 强制 / 成功率 / 失败原因），渲染在「上下文」面板。
 *
 * **口径 = 当前对话**（与本面板上半部分的「上下文明细」一致）。同一面板里一半看当前
 * 会话、一半看全机累计，是最容易被误读的错配，所以这里请求必带 `currentSessionId`。
 * 口径见 Main 侧 `agent/compaction-telemetry.js`：一次「压缩次数」= 一次真正发起摘要 LLM 的
 * 尝试，未达触发线或仍在冷却的空转不计入 —— 所以这里的成功率不会被空转轮次稀释。
 * 数据源是磁盘 jsonl，非热路径字段：切页 / 切会话 / 压缩发生 / 清空统计时按最小间隔节流拉取。
 */
async function loadCompactionStats(opts) {
  const force = !!(opts && opts.force);
  if (!force) {
    if (compactionStatsLoading) return;
    if (Date.now() - compactionStatsLastAt < COMPACTION_STATS_MIN_INTERVAL_MS) return;
  }
  const scopeSessionId = String(currentSessionId || '');
  const api = typeof window !== 'undefined' ? window.diecloud : null;
  const reasonsEl = $('ctx-compaction-reasons');
  if (!api || typeof api.agentCompactionTelemetrySummary !== 'function') {
    if (reasonsEl) reasonsEl.innerHTML = '<p class="context-model-usage-empty">Telemetry 不可用</p>';
    return;
  }
  compactionStatsLoading = true;
  if (reasonsEl) reasonsEl.innerHTML = '<p class="context-model-usage-empty">加载中…</p>';
  try {
    const s = await api.agentCompactionTelemetrySummary(scopeSessionId);
    // 等 IPC 期间用户可能已切走会话：这份结果属于旧会话，写上去就是串台
    if (String(currentSessionId || '') !== scopeSessionId) return;
    const attempted = s.attempted || 0;
    const setStat = (id, value) => {
      const el = $(id);
      if (el) el.textContent = value;
    };
    setStat('ctx-compaction-attempted', String(attempted));
    setStat('ctx-compaction-auto', String(s.auto || 0));
    setStat('ctx-compaction-forced', String(s.forced || 0));
    setStat(
      'ctx-compaction-success',
      attempted ? `${s.successRate ?? 0}% (${s.ok || 0}/${attempted})` : '—'
    );
    setStat('ctx-compaction-failed', String(s.failed || 0));
    setStat('ctx-compaction-saved', s.savedTokensAvg ? formatTokenCountFull(s.savedTokensAvg) : '—');
    setStat('ctx-compaction-elapsed', attempted ? `${s.elapsedMsAvg || 0} ms` : '—');

    if (reasonsEl) {
      const reasons = s.byReason || [];
      if (!attempted) {
        reasonsEl.innerHTML = '<p class="context-model-usage-empty">暂无压缩记录</p>';
      } else if (!reasons.length) {
        reasonsEl.innerHTML = '<p class="context-model-usage-empty">无压缩失败</p>';
      } else {
        const tags = reasons
          .map(
            (r) =>
              `<span class="help-harness-err-tag">${escapeContextHtml(
                COMPACTION_REASON_LABELS[r.reason] || r.reason
              )} ×${r.count}</span>`
          )
          .join('');
        reasonsEl.innerHTML = `<div class="help-harness-errors"><span class="meta-label">失败原因</span>${tags}</div>`;
      }
    }
  } catch (e) {
    if (reasonsEl) {
      reasonsEl.innerHTML = `<p class="context-model-usage-empty">加载失败: ${escapeContextHtml(
        e && e.message ? e.message : String(e)
      )}</p>`;
    }
  } finally {
    compactionStatsLoading = false;
    compactionStatsLastAt = Date.now();
  }
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
  scheduleCompactionStatsRefresh();
}

/**
 * 「上下文」面板可见性守卫 —— 与 `renderer-codebase-panel.js: isCodebasePaneActive` 同构。
 * 收起动画期间也视为不可见，避免动画里白刷一轮。
 */
function isContextPaneActive() {
  const panel = document.getElementById('artifacts-panel');
  if (!panel || panel.hidden || panel.classList.contains('is-panel-closing')) return false;
  const pane = document.querySelector('.side-panel-pane[data-side-pane="context"]');
  return !!(pane && !pane.hidden);
}

/**
 * 「上下文」面板低频心跳（可见才跑）。
 *
 * 本面板此前是**零定时器**的纯事件驱动（切页 / 输入 / 流式 / 压缩发生才刷），后果是面板
 * 开着不动时数据冻结，且压缩统计还要吃 1.2s 防抖 + 3s 最小间隔的双延迟。这里照
 * codebase / graph 面板的既有模式补一个兜底心跳 —— 事件驱动仍是主路径，心跳只兜住
 * 「事件没来但数据该变」的窗口：运行中无 delta 的思考期、压缩后统计的延迟、
 * 以及切页刚好撞上 3s 节流被丢弃的那一次。
 *
 * 面板不可见即自停，不是常驻轮询。
 */
const CONTEXT_PANEL_POLL_MS = 4000;
let contextPanelPollTimer = null;

function stopContextPanelPoll() {
  if (!contextPanelPollTimer) return;
  clearInterval(contextPanelPollTimer);
  contextPanelPollTimer = null;
}

function startContextPanelPoll() {
  if (contextPanelPollTimer) return;
  contextPanelPollTimer = setInterval(() => {
    if (!isContextPaneActive()) {
      stopContextPanelPoll();
      return;
    }
    // 窗口隐藏时 Chromium 会节流定时器：这一拍直接跳过，省掉无意义的估算与 IPC
    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
    refreshContextProgress();
    loadCompactionStats().catch(() => {});
  }, CONTEXT_PANEL_POLL_MS);
}

/**
 * 面板可见 → 首刷 + 启心跳。**唯一入口**，`setSidePanelTab` 与
 * `settleSessionSidePanelAfterSwitch`（切会话）共用，避免两处各写一份刷新逻辑。
 */
function onContextPanelShown() {
  // 启动时 initSidePanel 会以 silent 方式恢复上次的 tab，此时面板容器仍是 hidden：
  // 不挡掉就会在应用启动瞬间白跑一轮 IPC。
  if (!isContextPaneActive()) return;
  refreshContextProgress();
  // force：用户主动打开 / 切会话的语义就是「要看最新」，3s 最小间隔对它纯属误伤。
  loadCompactionStats({ force: true }).catch(() => {});
  startContextPanelPoll();
}

/** 面板隐藏 → 停心跳 */
function onContextPanelHidden() {
  stopContextPanelPoll();
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
  const draftEst = draft.trim() ? estimateTextTokens(draft) + 6 : 0;

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
