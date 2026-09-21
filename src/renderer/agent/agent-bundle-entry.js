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
const plannerToolFilters = require('../../agent/planner-tool-filters');
const agentRoundText = require('../../agent/agent-round-text');
const runEvents = require('../../agent/run-events');
const sessionTranscript = require('../../agent/session-transcript');
const sessionContext = require('../../agent/session-context');
const agentSystemPrompt = require('../../agent/agent-system-prompt');
const reviewerJson = require('../../agent/reviewer-json');
const llmRequest = require('../../agent/llm-request');
const llmChannel = require('../../agent/llm-channel');
const tokenEstimate = require('../../agent/token-estimate');
const sseDeltaParse = require('../../agent/sse-delta-parse');
const contextSignals = require('../../agent/context-signals');

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
// isSupplierModelEnabled 也走这里：renderer-model-runtime / renderer-model-capabilities
// 的勾选判定统一委托本模块，避免同一条设置在两侧得出不同模型名。
register('DieyunModelApiConfig', modelApiConfig, {
  compat: [
    'parseModelRoute',
    'resolveApiConfigForRoute',
    'resolveDefaultApiConfig',
    'resolveSupplierApiConfig',
    'pickSupplierModelId',
    'isSupplierModelEnabled',
    'supplierModelIds',
    'isUsableApiConfig'
  ]
});

// LLM 出站请求装配的单一来源（端点解析 + 请求头）。
// Renderer 侧发 LLM 请求前必须走这里构造 headers，勿再内联 Content-Type + Authorization。
register('DieyunLlmRequest', { ...llmRequest, LlmRequest: llmRequest }, {
  compat: ['LlmRequest']
});

// 思考 / 正文通道身份的唯一来源：入口 classifyDelta 盖章，下游只搬运 channel，不再各自猜。
// 只镜像一个命名空间全局 LlmChannel，避免 getChannelPolicy / classifyDelta 这类通用名污染 window。
register('DieyunLlmChannel', { ...llmChannel, LlmChannel: llmChannel }, {
  compat: ['LlmChannel']
});

// 文本→token 估算的唯一来源（src/agent/token-estimate.js，公式对齐 Rust compaction/tokens.rs）。
// Main 直接 require；Renderer 的 estimate* 兼容全局由此提供，勿再各写一份 char/CPT 启发式。
register('DieyunTokenEstimate', {
  estimateTextTokens: tokenEstimate.estimateTextTokens,
  estimateMessageTokens: tokenEstimate.estimateMessageTokens,
  estimateMessagesTokens: tokenEstimate.estimateMessagesTokens,
  estimateToolsTokens: tokenEstimate.estimateToolsTokens,
  estimateFullContextUsage: tokenEstimate.estimateFullContextUsage,
  countCjkChars: tokenEstimate.countCjkChars
}, {
  compat: ['estimateTextTokens', 'estimateMessagesTokens', 'estimateToolsTokens', 'estimateFullContextUsage']
});

// SSE delta 解析的唯一来源：Main（src/llm-stream-utils.js）与 Renderer（renderer-agent-llm.js）
// 共用同一份实现；渲染器侧勿再自抄 emitParsedSseJson / processSseTextChunk / buildToolCallAccumulator。
register('DieyunSseDeltaParse', { ...sseDeltaParse, SseDeltaParse: sseDeltaParse }, {
  compat: ['SseDeltaParse']
});

// 改造前 window.GuardrailsShared = 整个导出对象（键名与导出名不同名），此处显式补上。
register('DieyunGuardrailsShared', { ...guardrailsShared, GuardrailsShared: guardrailsShared }, {
  compat: ['GuardrailsShared']
});

register('DieyunToolCatalog', toolCatalog, { compat: ['DieyunToolCatalog'] });
register('DieyunToolClassify', toolClassify, { compat: ['DieyunToolClassify'] });
// Explore / Shell / Build 工具白名单的唯一来源（Main 侧由 planner / loop runner 直接 require）。
// 渲染器勿再自抄一份：renderer-tool-defs.js 直接消费这里镜像出的兼容全局。
register('DieyunPlannerToolFilters', plannerToolFilters, {
  compat: [
    'EXPLORE_TOOL_NAMES',
    'SHELL_TOOL_NAMES',
    'buildExploreTools',
    'buildShellTools',
    'buildBuildTools'
  ]
});
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
    'MESSAGE_META_PREFIX',
    'packMessageMeta',
    'unpackMessageMeta',
    'slimAttachmentsForPersist',
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

// 「消息结构信号 → 是否注入代码 / 是否自动检索」判定的唯一来源（src/agent/context-signals.js）。
// Main 的 system-prompt-prep.js 直接 require；Renderer 的
// renderer-editor-context.js / renderer-agent-system-message.js 消费这里的兼容全局，
// 勿再自抄 textHasCodebaseMention / extractPathHintsFromText / formatCodebaseBlock。
// 注：shouldInjectCodeContext 不进 compat —— Renderer 需先把 Monaco 状态适配成
// snapshot.editor，故 renderer-context-engine.js 只保留 shouldInjectCodeContext 一层薄适配器。
// shouldAutoCodebaseSearch 仅 Main（system-prompt-prep.js）使用，Renderer 侧适配器已删除。
register('DieyunContextSignals', { ...contextSignals, ContextSignals: contextSignals }, {
  compat: ['ContextSignals', 'textHasCodebaseMention', 'extractPathHintsFromText', 'extractCodebasePathsFromBlock', 'formatCodebaseBlock']
});

register('DieyunReviewerJson', reviewerJson, {
  compat: [
    'closeTruncatedJson',
    'extractReviewerJson',
    'inferReviewerFromPartial',
    'collectReviewerFileDiffs'
  ]
});
