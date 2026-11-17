'use strict';

const { loadModelSettings, MAX_TOKENS_DEFAULT, resolveTextApiConfig } = require('../model-settings');
const { buildTaskSkillsSystem } = require('../automation/skill-prompt');
const { ASSISTANT_IDENTITY, formatDieyunSystemBlock } = require('../dieyun-instructions');
const { runPlanAgentLoop } = require('./plan-agent-runner');
const { appendPlanLog } = require('./plan-log');
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
 * @param {{ userData: string, workspacePath?: string | null, log?: Function, gateway?: object, plansStore?: object, coreBridge?: object, mcpRuntime?: object, createToolBridge?: Function, compactionAgent?: object, webContents?: object }} ctx
 * @param {object} plan
 */
async function runPlan(ctx, plan) {
  if (ctx && ctx.gateway && ctx.coreBridge && typeof ctx.createToolBridge === 'function') {
    return runPlanAgentLoop(ctx, plan);
  }

  const { userData, workspacePath } = ctx;
  if (!plan.prompt) throw new Error('计划缺少 prompt');

  const extraParts = [];
  const dieyunBlock = formatDieyunSystemBlock();
  if (dieyunBlock) extraParts.push(dieyunBlock);
  let extraSystem = extraParts.join('\n\n');
  try {
    const skillBlock = await buildTaskSkillsSystem(userData, workspacePath || null, plan.skillIds);
    if (skillBlock) extraSystem = extraSystem ? `${extraSystem}\n\n${skillBlock}` : skillBlock;
  } catch {
    // ignore
  }

  const todoBlock = Array.isArray(plan.todos) && plan.todos.length
    ? `\n\n执行 TODO：\n${plan.todos.map((t, i) => `${i + 1}. ${t}`).join('\n')}`
    : '';
  // 本次任务文本与写进会话的用户轮次必须是同一份（Main 已备好 ctx.planUserPrompt）
  const taskPrompt = String((ctx && ctx.planUserPrompt) || '') || `${plan.prompt}${todoBlock}`;
  const reply = await chatCompletion(userData, taskPrompt, extraSystem, {
    route: plan.modelRoute,
    model: plan.model
  });
  // 与 runPlanAgentLoop 同判据：空正文不许冒充成功（否则「没跑」会被记成 lastRunOk: true）
  if (!String(reply || '').trim()) {
    throw new Error('模型未返回任何正文（上游可能拒绝请求或额度已用尽），请查看日志后重跑');
  }
  appendPlanLog(userData, plan, reply);
  return { ok: true, summary: reply.slice(0, 8000), content: reply };
}

module.exports = { runPlan, chatCompletion, appendPlanLog, resolveEndpoint };
