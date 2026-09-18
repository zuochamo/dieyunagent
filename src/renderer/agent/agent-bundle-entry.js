'use strict';
/**
 * Renderer 侧 agent 层「唯一适配入口」。
 *
 * 该文件由 scripts/build-agent-bundle.cjs 在构建期用 esbuild 打成
 * src/renderer/dist/agent-bundle.js（IIFE，无运行时 require），
 * index.html 只加载这一个产物，不再逐个加载 ../agent/*.js。
 *
 * 职责只有两件：按原 index.html 顺序 require、把导出注册进 DieyunNamespaces
 * 并通过 compat 把键镜像回 window.*（沿用改造前的全局契约，调用点零改动）。
 * 这里不写任何业务规则。
 */
const { register } = window.DieyunNamespaces;

const presets = require('../../agent/model-runtime-presets');
const schema = require('../../agent/model-runtime-schema');
const limits = require('../../agent/agent-limits');
const taskTier = require('../../agent/task-tier');
const limitsByTier = require('../../agent/agent-limits-by-tier');
const runtimeByTier = require('../../agent/model-runtime-by-tier');
const modelApiConfig = require('../../agent/model-api-config');
const guardrailsShared = require('../../agent/guardrails-shared');
const toolCatalog = require('../../agent/tool-catalog');
const toolClassify = require('../../agent/tool-classify');
const agentRoundText = require('../../agent/agent-round-text');
const runEvents = require('../../agent/run-events');
const sessionTranscript = require('../../agent/session-transcript');
const sessionContext = require('../../agent/session-context');
const agentSystemPrompt = require('../../agent/agent-system-prompt');
const reviewerJson = require('../../agent/reviewer-json');

register('DieyunModelRuntimePresets', presets, {
  compat: [
    'MODEL_RUNTIME_PRESETS',
    'MODEL_RUNTIME_DEFAULTS',
    'getModelRuntimePresetById',
    'remapLegacyContextTierId',
    'foldLegacyContextTierRecord'
  ]
});

register('DieyunModelRuntimeSchema', schema, {
  compat: ['CONTEXT_WINDOW_MAX', 'MODEL_RUNTIME_SCHEMA', 'formatModelRuntimeValue']
});

// CHARS_PER_TOKEN / CJK_CHARS_PER_TOKEN 改造前由 agent-limits 的 window 导出块额外挂载，
// 不在 module.exports 中，故在此显式补上（renderer-context-engine.js 等直接读裸名）。
register(
  'DieyunAgentLimits',
  {
    ...limits,
    CHARS_PER_TOKEN: limits.AGENT_LIMITS_DEFAULTS.charsPerToken,
    CJK_CHARS_PER_TOKEN: limits.AGENT_LIMITS_DEFAULTS.cjkCharsPerToken
  },
  {
    compat: [
      'AGENT_LIMITS_DEFAULTS',
      'AGENT_LIMITS_SCHEMA',
      'CHARS_PER_TOKEN',
      'CJK_CHARS_PER_TOKEN',
      'LONG_HORIZON_GUARDRAIL_SCALE',
      'scaleLimitForLongHorizon',
      'applyLongHorizonGuardrails',
      'getAgentLimits',
      'getAgentLimit',
      'setAgentLimits',
      'resetAgentLimits',
      'hydrateAgentLimitsFromDisk',
      'formatAgentLimitValue',
      'normalizeAgentLimits',
      'resolveAgentLimitsTierId',
      'resolveLoopToolCallLimit',
      'resolveAgentLoopSpec'
    ]
  }
);

register('DieyunTaskTier', taskTier, {
  compat: [
    'inferTaskTierFromStructure',
    'skipAutoCodebaseForTaskTier',
    'formatTaskTierSystemBlock',
    'isTaskTierFeatureEnabled'
  ]
});

// STORAGE_KEY / LEGACY_STORAGE_KEY 与 model-runtime-by-tier 同名，
// 注册顺序必须保持 index.html 原顺序，由后者覆盖（改造前即如此）。
register('DieyunAgentLimitsByTier', limitsByTier, {
  compat: [
    'STORAGE_KEY',
    'LEGACY_STORAGE_KEY',
    'reloadLimitsByTier',
    'getLimitsForTier',
    'getLimitsOverridesForTier',
    'setLimitsForTier',
    'resetLimitsForTier',
    'getAllLimitsByTier',
    'hydrateLimitsByTier',
    'isLimitsByTierShape',
    'extractLimitOverrides',
    'isValidLimitsTierId'
  ]
});

register('DieyunModelRuntimeByTier', runtimeByTier, {
  compat: [
    'STORAGE_KEY',
    'reloadRuntimeByTier',
    'getRuntimeValuesForTier',
    'getRuntimeOverridesForTier',
    'setRuntimeValuesForTier',
    'resetRuntimeValuesForTier',
    'getEditingContextTierId',
    'setEditingContextTierId',
    'migrateGlobalSettingsToDefaultTier',
    'inferContextTierFromModelName',
    'inferContextWindowFromModelName',
    'resolveModelContextWindowFromSettings',
    'normalizeContextTierId',
    'resolveContextTierIdFromSettings',
    'isValidContextTierId'
  ]
});

// 模型路由 → API 配置的单一来源（Main 直接 require；Renderer 侧统一走这里，勿再写第二份）
register('DieyunModelApiConfig', modelApiConfig, {
  compat: [
    'parseModelRoute',
    'resolveApiConfigForRoute',
    'resolveDefaultApiConfig',
    'resolveSupplierApiConfig',
    'isUsableApiConfig'
  ]
});

// 改造前 window.GuardrailsShared = 整个导出对象（键名与导出名不同名），此处显式补上。
register('DieyunGuardrailsShared', { ...guardrailsShared, GuardrailsShared: guardrailsShared }, {
  compat: ['GuardrailsShared']
});

register('DieyunToolCatalog', toolCatalog, { compat: ['DieyunToolCatalog'] });
register('DieyunToolClassify', toolClassify, { compat: ['DieyunToolClassify'] });
// 改造前 window.AgentRoundText = 整个导出对象（键名与导出名不同名），此处显式补上。
register('DieyunAgentRoundText', { ...agentRoundText, AgentRoundText: agentRoundText }, {
  compat: ['AgentRoundText']
});

register('DieyunRunEvents', runEvents, {
  compat: [
    'AGENT_RUN_EVENT_TYPES',
    'createAgentRunEvent',
    'normalizeAgentRunEvent',
    'agentRunEventFromTrace',
    'applyAgentRunEventToLive',
    'agentRunEventFromServicePayload'
  ]
});

register('DieyunSessionTranscript', sessionTranscript, { compat: ['transcriptFromMessages'] });

register('DieyunSessionContext', sessionContext, {
  compat: [
    'persistableAssistantText',
    'messagesForTranscript',
    'assistantTextFromMessage',
    'buildSessionChatHistoryFromMessages',
    'buildCompletionMessagesFromHistory',
    'trimMessagesToCharBudget',
    'selectHistoryMessagesForSession',
    'cloneHistoryMessages',
    'buildCurrentTaskText',
    'SESSION_HISTORY_HEADER',
    'TURN_RIDE_HEADER',
    'COMPACTION_ARCHIVE_HEADER',
    'FOLDED_HISTORY_HEADER',
    'foldOlderCompletionMessages',
    'formatCompactionArchiveBlock',
    'mergeCompactionBlockIntoTurnRide',
    'isSyntheticLoopUserContent',
    'extractBookPrefixMessages',
    'extractInTurnLoopTail',
    'applyTurnRideToCompletionMessages',
    'reprojectContinueLoopMessages',
    'joinPromptChunks',
    'packSystemPrompt',
    'unwrapSystemPromptPack',
    'attachTurnRideToUserContent',
    'isWeakAssistantReply'
  ]
});

register('DieyunAgentSystemPrompt', agentSystemPrompt, {
  compat: ['buildCoreAgentRules', 'formatSystemTimeChunk', 'assembleSystemPrompt']
});

register('DieyunReviewerJson', reviewerJson, {
  compat: [
    'closeTruncatedJson',
    'extractReviewerJson',
    'inferReviewerFromPartial',
    'collectReviewerFileDiffs'
  ]
});
