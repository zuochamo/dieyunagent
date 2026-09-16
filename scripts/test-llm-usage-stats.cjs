'use strict';

const assert = require('assert');
const {
  extractUsageStats,
  usageToActivityPatch,
  addUsageStats,
  hasUsageStats,
  buildEstimatedUsageObject,
  estimateVisionUsage,
  usageReportsCacheTelemetry,
  computeCacheHitRatePercent
} = require('../src/llm-usage-stats');

const deepseekUsage = {
  prompt_tokens: 1000,
  completion_tokens: 200,
  total_tokens: 1200,
  prompt_tokens_details: { cached_tokens: 0 },
  prompt_cache_hit_tokens: 820
};

const mimoUsage = {
  prompt_tokens: 814,
  completion_tokens: 5,
  total_tokens: 819,
  prompt_tokens_details: { cached_tokens: 768 }
};

const ds = extractUsageStats({ usage: deepseekUsage }, 'deepseek-v4-flash');
assert.strictEqual(ds.cachedTokens, 820, 'deepseek prompt_cache_hit_tokens');
assert.strictEqual(ds.promptTokens, 1000);

const mimo = extractUsageStats({ usage: mimoUsage }, 'mimo-v2.5-pro');
assert.strictEqual(mimo.cachedTokens, 768);

const patch = usageToActivityPatch({ usage: mimoUsage }, 'mimo-v2.5-pro');
assert.strictEqual(patch.tokensToday, 819);
assert.strictEqual(patch.cachedTokensToday, 768);
assert.ok(patch.modelUsage['mimo-v2.5-pro'] === 819);

const merged = addUsageStats(ds, mimo);
assert.strictEqual(merged.promptTokens, 1814);
assert.strictEqual(merged.cachedTokens, 1588);
assert.ok(hasUsageStats(merged));

const withTelemetry = extractUsageStats({ usage: mimoUsage }, 'mimo-v2.5-pro');
assert.strictEqual(withTelemetry.cacheTelemetry, true);
const noTelemetry = extractUsageStats(
  { usage: { prompt_tokens: 1930, completion_tokens: 17, total_tokens: 1947 } },
  'gpt-5.5'
);
assert.strictEqual(noTelemetry.cacheTelemetry, false);
assert.strictEqual(noTelemetry.cachedTokens, 0);
assert.strictEqual(usageReportsCacheTelemetry({ prompt_tokens: 100, prompt_tokens_details: { cached_tokens: 0 } }), true);

const patchTelemetry = usageToActivityPatch({ usage: mimoUsage }, 'mimo-v2.5-pro');
assert.strictEqual(patchTelemetry.cacheHitPromptTokensToday, 814);
assert.strictEqual(patchTelemetry.cachedTokensToday, 768);
const patchNoTelemetry = usageToActivityPatch({ usage: { prompt_tokens: 900, completion_tokens: 10, total_tokens: 910 } });
assert.strictEqual(patchNoTelemetry.cacheHitPromptTokensToday, undefined);
assert.strictEqual(patchNoTelemetry.cachedTokensToday, undefined);

assert.strictEqual(computeCacheHitRatePercent(6272, 6669), '94%');
assert.strictEqual(computeCacheHitRatePercent(1, 3), '33.3%');
assert.strictEqual(computeCacheHitRatePercent(0, 0), '—');

console.log('test-llm-usage-stats: ok');
