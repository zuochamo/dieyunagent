(function () {
'use strict';

function toTokenCount(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

function firstTokenCount(...values) {
  for (const value of values) {
    const n = toTokenCount(value);
    if (n > 0) return n;
  }
  return 0;
}

function normalizeUsageModelName(model) {
  const text = String(model || '').trim();
  return text ? text.slice(0, 120) : '';
}

function normalizeUsageModelMap(value) {
  const out = {};
  if (!value || typeof value !== 'object') return out;
  for (const [model, tokens] of Object.entries(value)) {
    const name = normalizeUsageModelName(model);
    const n = toTokenCount(tokens);
    if (name && n > 0) out[name] = (out[name] || 0) + n;
  }
  return out;
}

function usageReportsCacheTelemetry(u) {
  if (!u || u._estimated) return false;
  const promptDetails = u.prompt_tokens_details || u.prompt_token_details || {};
  const inputDetails = u.input_tokens_details || u.input_token_details || {};
  const detailKeys = ['cached_tokens', 'cache_read', 'cache_read_tokens'];
  for (const key of detailKeys) {
    if (Object.prototype.hasOwnProperty.call(promptDetails, key)) return true;
    if (Object.prototype.hasOwnProperty.call(inputDetails, key)) return true;
  }
  const topKeys = [
    'prompt_cache_hit_tokens',
    'promptCacheHitTokens',
    'cachedTokens',
    'cached_tokens',
    'cache_read_input_tokens',
    'cache_read_tokens'
  ];
  return topKeys.some((key) => Object.prototype.hasOwnProperty.call(u, key));
}

function extractCachedTokensFromUsage(u) {
  if (!u) return 0;
  const promptDetails = u.prompt_tokens_details || u.prompt_token_details || {};
  const inputDetails = u.input_tokens_details || u.input_token_details || {};
  return firstTokenCount(
    promptDetails.cached_tokens,
    promptDetails.cache_read,
    promptDetails.cache_read_tokens,
    inputDetails.cached_tokens,
    inputDetails.cache_read,
    inputDetails.cache_read_tokens,
    u.prompt_cache_hit_tokens,
    u.promptCacheHitTokens,
    u.cachedTokens,
    u.cached_tokens,
    u.cache_read_input_tokens,
    u.cache_read_tokens
  );
}

function computeCacheHitRatePercent(cachedTokens, promptTokens) {
  const cached = Math.max(0, Number(cachedTokens) || 0);
  const prompt = Math.max(0, Number(promptTokens) || 0);
  if (prompt <= 0) return cached > 0 ? '100%' : '—';
  const pct = Math.max(0, Math.min(100, (cached / prompt) * 100));
  return `${pct.toFixed(1).replace(/\.0$/, '')}%`;
}

function extractUsageStats(input, model) {
  const u = input && input.usage ? input.usage : input;
  if (!u) {
    return { totalTokens: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, modelUsage: {} };
  }
  const promptTokens = firstTokenCount(u.promptTokens, u.prompt_tokens, u.input_tokens);
  const completionTokens = firstTokenCount(u.completionTokens, u.completion_tokens, u.output_tokens);
  const totalTokens = firstTokenCount(u.totalTokens, u.total_tokens, promptTokens + completionTokens);
  const modelName = normalizeUsageModelName(model || input?.model || u.model);
  const cacheTelemetry = usageReportsCacheTelemetry(u);
  return {
    totalTokens,
    promptTokens,
    completionTokens,
    cachedTokens: extractCachedTokensFromUsage(u),
    cacheTelemetry,
    modelUsage:
      modelName && totalTokens > 0
        ? { [modelName]: totalTokens }
        : normalizeUsageModelMap(input?.modelUsage || u.modelUsage)
  };
}

function addUsageStats(a, b) {
  const modelUsage = normalizeUsageModelMap(a?.modelUsage);
  for (const [model, tokens] of Object.entries(normalizeUsageModelMap(b?.modelUsage))) {
    modelUsage[model] = (modelUsage[model] || 0) + tokens;
  }
  return {
    totalTokens: toTokenCount(a?.totalTokens) + toTokenCount(b?.totalTokens),
    promptTokens: toTokenCount(a?.promptTokens) + toTokenCount(b?.promptTokens),
    completionTokens: toTokenCount(a?.completionTokens) + toTokenCount(b?.completionTokens),
    cachedTokens: toTokenCount(a?.cachedTokens) + toTokenCount(b?.cachedTokens),
    modelUsage
  };
}

function hasUsageStats(stats) {
  return !!(
    toTokenCount(stats?.totalTokens) ||
    toTokenCount(stats?.promptTokens) ||
    toTokenCount(stats?.completionTokens) ||
    toTokenCount(stats?.cachedTokens) ||
    Object.keys(normalizeUsageModelMap(stats?.modelUsage)).length > 0
  );
}

function emptyUsageStats() {
  return {
    totalTokens: 0,
    promptTokens: 0,
    completionTokens: 0,
    cachedTokens: 0,
    cacheTelemetry: false,
    modelUsage: {}
  };
}

/** @returns {object | null} patch for bumpActivityStats */
function usageToActivityPatch(input, model) {
  const stats = extractUsageStats(input, model);
  if (!hasUsageStats(stats)) return null;
  const total = stats.totalTokens || stats.promptTokens + stats.completionTokens;
  const patch = {
    tokensToday: total,
    promptTokensToday: stats.promptTokens,
    completionTokensToday: stats.completionTokens,
    modelUsage: stats.modelUsage
  };
  if (stats.cacheTelemetry) {
    patch.cachedTokensToday = stats.cachedTokens;
    patch.cacheHitPromptTokensToday = stats.promptTokens;
  }
  return patch;
}

function messageContentText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object') return part.text || part.content || '';
        return '';
      })
      .join('\n');
  }
  return '';
}

let cachedCharsPerToken = 0;

/**
 * 字符→token 折算系数唯一来源：agent-limits.js。
 * renderer 打包无 require，读 agent-limits 发布的 window 全局；Node 走 require。
 */
function charsPerToken() {
  if (cachedCharsPerToken > 0) return cachedCharsPerToken;
  const fromGlobal = typeof CHARS_PER_TOKEN === 'number' ? CHARS_PER_TOKEN : 0;
  if (fromGlobal > 0) {
    cachedCharsPerToken = fromGlobal;
    return cachedCharsPerToken;
  }
  try {
    const d = require('./agent-limits').AGENT_LIMITS_DEFAULTS;
    if (d && Number.isFinite(d.charsPerToken) && d.charsPerToken > 0) {
      cachedCharsPerToken = d.charsPerToken;
      return cachedCharsPerToken;
    }
  } catch {
    // renderer：无 require
  }
  cachedCharsPerToken = 3.2;
  return cachedCharsPerToken;
}

function estimateTokensFromText(text) {
  const n = String(text || '').length;
  if (n <= 0) return 0;
  return Math.max(1, Math.ceil(n / charsPerToken()));
}

function estimatePromptTokensFromMessages(messages) {
  let sum = 0;
  for (const m of messages || []) {
    sum += estimateTokensFromText(messageContentText(m?.content)) + 6;
  }
  return sum;
}

function estimateToolDefinitionTokens(tools) {
  if (!Array.isArray(tools) || !tools.length) return 0;
  return estimateTokensFromText(JSON.stringify(tools));
}

function buildEstimatedUsageObject({ promptTokens = 0, completionTokens = 0 } = {}) {
  const prompt_tokens = Math.max(0, Math.floor(promptTokens));
  const completion_tokens = Math.max(0, Math.floor(completionTokens));
  if (prompt_tokens <= 0 && completion_tokens <= 0) return null;
  return {
    prompt_tokens,
    completion_tokens,
    total_tokens: prompt_tokens + completion_tokens,
    _estimated: true
  };
}

function estimateLlmRoundUsage(body, llmResp) {
  const promptTokens =
    estimatePromptTokensFromMessages(body?.messages) + estimateToolDefinitionTokens(body?.tools);
  const completionTokens = estimateTokensFromText(
    [llmResp?.content, llmResp?.reasoning].filter(Boolean).join('\n')
  );
  return buildEstimatedUsageObject({ promptTokens, completionTokens });
}

function estimateStreamCompletionUsage(body, content, reasoning) {
  const promptTokens =
    estimatePromptTokensFromMessages(body?.messages) + estimateToolDefinitionTokens(body?.tools);
  const completionTokens = estimateTokensFromText([content, reasoning].filter(Boolean).join('\n'));
  return buildEstimatedUsageObject({ promptTokens, completionTokens });
}

function estimateVisionUsage({ imageBase64Length = 0, outputText = '' } = {}) {
  const imgLen = Math.max(0, Number(imageBase64Length) || 0);
  const promptTokens = Math.max(256, Math.ceil(imgLen / 1024) * 85 + 32);
  const completionTokens = estimateTokensFromText(outputText);
  return buildEstimatedUsageObject({ promptTokens, completionTokens });
}

const llmUsageStatsExports = {
  toTokenCount,
  firstTokenCount,
  normalizeUsageModelName,
  normalizeUsageModelMap,
  usageReportsCacheTelemetry,
  extractCachedTokensFromUsage,
  computeCacheHitRatePercent,
  extractUsageStats,
  addUsageStats,
  hasUsageStats,
  emptyUsageStats,
  usageToActivityPatch,
  estimateTokensFromText,
  estimatePromptTokensFromMessages,
  estimateToolDefinitionTokens,
  buildEstimatedUsageObject,
  estimateLlmRoundUsage,
  estimateStreamCompletionUsage,
  estimateVisionUsage
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = llmUsageStatsExports;
}
if (typeof globalThis !== 'undefined') {
  globalThis.LlmUsageStats = llmUsageStatsExports;
}
}());
