'use strict';

const {
  AGENT_LIMITS_DEFAULTS,
  normalizeAgentLimits,
  resolveLoopToolCallLimit,
  resolveAgentLoopSpec
} = require('../src/agent/agent-limits');

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed');
}

const mergedHigh = normalizeAgentLimits({ repeatToolStreakLimit: 999 });
assert(mergedHigh.repeatToolStreakLimit === 18, 'clamp max');
const mergedLow = normalizeAgentLimits({ repeatToolStreakLimit: 1 });
assert(mergedLow.repeatToolStreakLimit === 6, 'clamp min');

const merged = normalizeAgentLimits({ repeatToolStreakLimit: 10, verifyDiagMaxChars: 8000 });
assert(merged.repeatToolStreakLimit === 10, 'merge repeat');
assert(merged.verifyDiagMaxChars === 8000, 'merge verify diag');
assert(merged.completionRepairAttempts === AGENT_LIMITS_DEFAULTS.completionRepairAttempts, 'default kept');

assert(
  resolveLoopToolCallLimit({ agentToolCallLimit: 200 }) === 200,
  'settings tool-call limit wins'
);
assert(
  resolveLoopToolCallLimit({ agentToolCallLimit: 0 }) === AGENT_LIMITS_DEFAULTS.ctxAgentToolCallLimit,
  'invalid setting falls back to agent-limits default'
);
assert(
  resolveLoopToolCallLimit({}) === AGENT_LIMITS_DEFAULTS.ctxAgentToolCallLimit,
  'missing setting uses agent-limits default'
);
assert(
  resolveLoopToolCallLimit({ agentToolCallLimit: 9999 }) === 600,
  'tool-call limit clamps to schema max'
);

const spec = resolveAgentLoopSpec({ agentToolCallLimit: 200 });
assert(spec.maxToolCalls === 200, 'loop spec resolves tool-call limit before run');
assert(
  spec.firstTokenTimeoutMs === AGENT_LIMITS_DEFAULTS.llmFirstTokenTimeoutMs ||
    spec.firstTokenTimeoutMs === undefined ||
    spec.firstTokenTimeoutMs >= 10000,
  'loop spec first-token timeout is resolved or omitted'
);
assert(spec.llmMaxRetries === AGENT_LIMITS_DEFAULTS.streamRoundMaxAttempts, 'loop spec sampling retries');
assert(spec.llmRetryBaseMs === AGENT_LIMITS_DEFAULTS.llmRetryBaseMs, 'loop spec retry base');
assert(spec.llmMaxRetryDelayMs === 60000, 'loop spec retry delay cap');
assert(
  spec.llmReconnectMaxWaitMs === AGENT_LIMITS_DEFAULTS.llmReconnectMaxWaitMs,
  'loop spec reconnect wall-clock budget'
);
assert(AGENT_LIMITS_DEFAULTS.llmReconnectMaxWaitMs === 30 * 60 * 1000, 'reconnect budget default 30min');
assert(
  normalizeAgentLimits({ llmReconnectMaxWaitMs: 0 }).llmReconnectMaxWaitMs === 0,
  'reconnect budget can fall back to retry-count mode'
);
assert(
  normalizeAgentLimits({ llmReconnectMaxWaitMs: 99 * 60 * 1000 }).llmReconnectMaxWaitMs === 60 * 60 * 1000,
  'reconnect budget clamps max'
);

assert(AGENT_LIMITS_DEFAULTS.synthesisTimeoutMs === 25000, 'synthesis timeout default');
assert(
  AGENT_LIMITS_DEFAULTS.synthesisReconnectMaxWaitMs === 8000,
  'synthesis reconnect default'
);
assert(
  normalizeAgentLimits({ synthesisTimeoutMs: 1000 }).synthesisTimeoutMs === 5000,
  'synthesis timeout clamps min'
);

assert(AGENT_LIMITS_DEFAULTS.completionRecentTurns === 24, 'recent verbatim turns default');
assert(AGENT_LIMITS_DEFAULTS.completionFoldedMaxChars === 12000, 'folded history cap default');
assert(AGENT_LIMITS_DEFAULTS.userSystemMaxChars === 8000, 'user system cap default');
assert(AGENT_LIMITS_DEFAULTS.systemStableMaxChars === 16000, 'stable system cap default');
assert(AGENT_LIMITS_DEFAULTS.fsReadDefaultMaxBytes === 65536, 'agent fs_read default chunk');
assert(AGENT_LIMITS_DEFAULTS.taskTierEnabled === true, 'taskTier enabled default');
assert(normalizeAgentLimits({ taskTierEnabled: false }).taskTierEnabled === false, 'taskTier can disable');
assert(AGENT_LIMITS_DEFAULTS.taskTierTimeoutMs === undefined, 'no classify LLM timeout');

const {
  scaleLimitForLongHorizon,
  applyLongHorizonGuardrails,
  LONG_HORIZON_GUARDRAIL_SCALE
} = require('../src/agent/agent-limits');
assert(scaleLimitForLongHorizon('repeatToolStreakLimit', 9, false) === 9, 'long horizon off keeps repeat');
assert(
  scaleLimitForLongHorizon('repeatToolStreakLimit', 9, true) ===
    9 * LONG_HORIZON_GUARDRAIL_SCALE.repeatToolStreakLimit,
  'long horizon scales repeat'
);
assert(
  scaleLimitForLongHorizon('ctxAgentToolCallLimit', AGENT_LIMITS_DEFAULTS.ctxAgentToolCallLimit, true) ===
    AGENT_LIMITS_DEFAULTS.ctxAgentToolCallLimit * LONG_HORIZON_GUARDRAIL_SCALE.ctxAgentToolCallLimit,
  'long horizon scales tool-call budget'
);
assert(AGENT_LIMITS_DEFAULTS.exploreStreakLimit == null, 'explore streak hard-block removed');
assert(AGENT_LIMITS_DEFAULTS.sameFileReadLimit == null, 'same-file reread hard-block removed');
assert(AGENT_LIMITS_DEFAULTS.planOnlyRoundLimit == null, 'plan-only round hard-block removed');
const scaledLimits = applyLongHorizonGuardrails(
  { ctxAgentToolCallLimit: 150, repeatToolStreakLimit: 9 },
  true
);
assert(scaledLimits.ctxAgentToolCallLimit === 300, 'apply long horizon to limits object');
assert(scaledLimits.repeatToolStreakLimit === 18, 'apply long horizon repeat');

const {
  MODEL_RUNTIME_PRESETS,
  remapLegacyContextTierId,
  foldLegacyContextTierRecord
} = require('../src/agent/model-runtime-presets');
const { CONTEXT_WINDOW_MAX } = require('../src/agent/model-runtime-schema');
const {
  inferContextTierFromModelName,
  inferContextWindowFromModelName,
  resolveModelContextWindowFromSettings,
  normalizeContextTierId
} = require('../src/agent/model-runtime-by-tier');

const presetIds = MODEL_RUNTIME_PRESETS.map((p) => p.id);
assert(!presetIds.includes('ctx-8k'), '8k tier removed');
assert(presetIds.includes('ctx-16k'), '16k tier is the smallest');
const smallTier = MODEL_RUNTIME_PRESETS.find((p) => p.id === 'ctx-16k');
assert(smallTier && smallTier.values.contextWindow === 16384, '16k tier window');
assert(presetIds.includes('ctx-1m') && presetIds.includes('ctx-2m') && presetIds.includes('ctx-512k'), 'large tiers');
assert(CONTEXT_WINDOW_MAX === 2000000, 'window clamp 2M');
assert(remapLegacyContextTierId('ctx-8k') === 'ctx-16k', '8k alias');
assert(normalizeContextTierId('ctx-8k') === 'ctx-16k', 'normalize 8k');
const folded = foldLegacyContextTierRecord(
  { 'ctx-8k': { temperature: 0.4 }, 'ctx-16k': { temperature: 0.2 } },
  (id) => presetIds.includes(id)
);
assert(folded['ctx-16k'] && folded['ctx-16k'].temperature === 0.2, 'canonical 16k wins over 8k alias');
assert(inferContextTierFromModelName('gemini-2.5-pro') === 'ctx-1m', 'gemini 1M');
assert(inferContextTierFromModelName('gpt-4.1') === 'ctx-1m', 'gpt-4.1 1M');
assert(inferContextTierFromModelName('gpt-5') === 'ctx-128k', 'gpt-5 not 32k');
assert(inferContextTierFromModelName('deepseek-chat') === 'ctx-128k', 'deepseek not 32k');
assert(inferContextTierFromModelName('claude-sonnet-4') === 'ctx-200k', 'claude 200k');
assert(inferContextTierFromModelName('minimax-m2') === 'ctx-1m', 'minimax 1M');
assert(inferContextTierFromModelName('foo-16k') === 'ctx-16k', 'explicit 16k -> small');
assert(inferContextTierFromModelName('foo-8k') === 'ctx-16k', 'explicit 8k -> smallest tier');
assert(inferContextWindowFromModelName('foo-8k') === 8192, '8k name -> 8192 window hint');
assert(inferContextWindowFromModelName('foo-16k') == null, 'no window hint without 8k');
assert(
  resolveModelContextWindowFromSettings(
    { customModels: [{ id: 'm1', name: 'relay-8k' }] },
    'custom:m1'
  ) === 8192,
  'custom model name hint'
);
assert(
  resolveModelContextWindowFromSettings(
    { customModels: [{ id: 'm1', name: 'relay-8k', contextWindow: 32768 }] },
    'custom:m1'
  ) === 32768,
  'explicit model window wins over name hint'
);
assert(
  resolveModelContextWindowFromSettings(
    { customModels: [{ id: 'm1', name: 'relay-8k', contextTier: 'ctx-64k' }] },
    'custom:m1'
  ) == null,
  'explicit tier wins over name hint'
);
assert(
  resolveModelContextWindowFromSettings(
    { customModels: [{ id: 'm1', name: 'relay-8k' }] },
    'relay-8k'
  ) === 8192,
  'bare model name matches custom model'
);
assert(
  resolveModelContextWindowFromSettings(
    { modelSuppliers: [{ id: 'sup', contextTierByModel: {}, enabledModels: {} }] },
    'builtin:sup:foo-8k'
  ) === 8192,
  'builtin route name hint'
);
assert(
  resolveModelContextWindowFromSettings(
    { modelSuppliers: [{ id: 'sup', contextTierByModel: { 'foo-8k': 'ctx-64k' } }] },
    'builtin:sup:foo-8k'
  ) == null,
  'builtin per-model tier wins'
);
assert(inferContextTierFromModelName('gpt-4o') === 'ctx-128k', 'gpt-4o 128k');

console.log('test-agent-limits.cjs ok');
