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
const llmReconnectRetry = require('../../llm-reconnect-retry');
const tokenEstimate = require('../../agent/token-estimate');
const reasoningBackfill = require('../../agent/reasoning-backfill');
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
  compat: [
    'CONTEXT_WINDOW_MAX',
    'MODEL_RUNTIME_SCHEMA',
    'clampModelRuntimeValue',
    'formatModelRuntimeValue'
  ]
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
    'listContextTierIds',
    'getRuntimeValuesForTier',
    'getRuntimeOverridesForTier',
    'setRuntimeValuesForTier',
    'resetRuntimeValuesForTier',
    'getAllRuntimeByTier',
    'hydrateRuntimeByTier',
    'applyTierRuntime',
    'getEditingContextTierId',
    'setEditingContextTierId',
    'migrateGlobalSettingsToDefaultTier',
    'inferContextTierFromModelName',
    'inferContextWindowFromModelName',
    'resolveModelFacts',
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

// LLM 重连重试的**循环与退避**唯一来源（src/llm-reconnect-retry.js）。
// Main 的 rust-loop-runner / rust-planner-runner / compaction-main 等直接 require；
// Renderer 的 renderer-agent-llm.js 消费这里的兼容全局，勿再自抄一份退避循环。
register('DieyunLlmReconnectRetry', { ...llmReconnectRetry, LlmReconnectRetry: llmReconnectRetry }, {
  compat: ['LlmReconnectRetry']
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

