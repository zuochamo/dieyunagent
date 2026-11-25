'use strict';

const { loadModelSettings, MAX_TOKENS_DEFAULT, resolveTextApiConfig } = require('../model-settings');
const { ASSISTANT_IDENTITY } = require('../dieyun-instructions');
const { runPlanAgentLoop } = require('./plan-agent-runner');
const { completeOnce, currentLlmCompleteBridge } = require('../agent/llm-complete');
const { buildLlmHeadersFromConfig, resolveLlmEndpoint } = require('../agent/llm-request');

function resolveEndpoint(baseUrl) {
  // 端点拼接单一来源 llm-request.js（调用方已保证 baseUrl 非空）
  return resolveLlmEndpoint(baseUrl, 'chat');
}

/**
 * 计划解析（自然语言 → 计划字段）用的单轮补全。
 *
 * - 模型配置经 resolveTextApiConfig 解析：按本次运行路由 → 供应商/自定义模型 → 兜底，
 *   不再直接读顶层 settings.apiKey（自定义模型 / 供应商场景下顶层往往为空）。
 * - 传输走 core 的 `llm.complete`（RPC）：端点/请求头/超时/解析都由 core 负责，
 *   勿在此另写裸 fetch（也不许再出现第二份 SSE 解析）。
 *
 * @param {string} userData
 * @param {string} prompt
 * @param {string} [extraSystem]
 * @param {{ route?: string, model?: string, signal?: object }} [opts]
 */
async function chatCompletion(userData, prompt, extraSystem, opts = {}) {
  const settings = loadModelSettings(userData);
  const cfg = resolveTextApiConfig(settings, { route: opts.route, model: opts.model });
  if (!cfg.apiKey) throw new Error('未配置 API Key，请在模型设置中填写');
  if (!cfg.baseUrl) throw new Error('未配置模型 Base URL，请在模型设置中填写');

  const systemParts = [ASSISTANT_IDENTITY];
  if (extraSystem) systemParts.push(extraSystem);
  const messages = [
    { role: 'system', content: systemParts.join('\n') },
    { role: 'user', content: prompt }
  ];

  const url = resolveEndpoint(cfg.baseUrl);
  // 请求由 core 发（`llm.complete`）：端点/请求头/超时/解析/usage 只有 core 那一份实现。
  // 这里只负责「问什么」（system + user）和「怎么用结果」。
  const result = await completeOnce({
    coreBridge: opts.coreBridge || currentLlmCompleteBridge(),
    url,
    // 取消语义保留：abort 后立刻返回（core 侧那次请求跑完即弃）
    signal: opts.signal || null,
    llm: { ...cfg, headers: buildLlmHeadersFromConfig(cfg, { sessionId: opts.sessionId }) },
    body: {
      model: cfg.model,
      messages,
      temperature: Number(settings.temperature) || 0.3,
      max_tokens: Number(settings.maxTokens) || MAX_TOKENS_DEFAULT
    }
  });

  return String((result && result.content) || '');
}

/**
 * 计划执行只有一条路：`runPlanAgentLoop`（工具注入、预算、交付闸门都在那里）。
 *
 * 这里保留 `runPlan` 这个名字，只为调用方（`main/mcp-plans-boot.js`）的入口稳定。
 * 2026-11-21 删掉了原先的「无工具、单次 LLM」降级分支：它自带第二份 dieyun 系统块、
 * 技能块与「执行 TODO」块，而唯一生产调用点 `mcp-plans-boot.js` 恒传
 * `gateway/coreBridge/createToolBridge`，那条分支在树内永远走不到。
 *
 * @param {object} ctx
 * @param {object} plan
 */
const runPlan = runPlanAgentLoop;

module.exports = { runPlan, chatCompletion, resolveEndpoint };
