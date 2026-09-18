'use strict';

const fs = require('fs');
const path = require('path');
const { loadModelSettings, MAX_TOKENS_DEFAULT, resolveTextApiConfig } = require('../model-settings');
const { buildTaskSkillsSystem } = require('../automation/skill-prompt');
const { ASSISTANT_IDENTITY, formatDieyunSystemBlock } = require('../dieyun-instructions');
const { runPlanAgentLoop } = require('./plan-agent-runner');
const { chatCompletionJson } = require('../llm-proxy');

function resolveEndpoint(baseUrl) {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  if (/\/chat\/completions(?:\?|$)/i.test(base)) return base;
  if (/\/v\d+$/i.test(base)) return `${base}/chat/completions`;
  return `${base}/v1/chat/completions`;
}

/**
 * 计划解析（自然语言 → 计划字段）用的单轮补全。
 *
 * - 模型配置经 resolveTextApiConfig 解析：按本次运行路由 → 供应商/自定义模型 → 兜底，
 *   不再直接读顶层 settings.apiKey（自定义模型 / 供应商场景下顶层往往为空）。
 * - 传输复用 src/llm-proxy.js#chatCompletionJson：带连接/空闲/总时长超时与 abort，
 *   勿在此另写裸 fetch。
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

  const json = await chatCompletionJson(resolveEndpoint(cfg.baseUrl), {
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${cfg.apiKey}`
    },
    body: JSON.stringify({
      model: cfg.model,
      messages,
      temperature: Number(settings.temperature) || 0.3,
      max_tokens: Number(settings.maxTokens) || MAX_TOKENS_DEFAULT
    }),
    signal: opts.signal || null
  });

  return (
    (json &&
      json.choices &&
      json.choices[0] &&
      json.choices[0].message &&
      json.choices[0].message.content) ||
    ''
  );
}

function appendPlanLog(userData, plan, text) {
  const dir = path.join(userData, 'plans-logs');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${plan.id}.md`);
  const header = `\n\n---\n## ${new Date().toLocaleString('zh-CN')} · ${plan.name}\n\n`;
  fs.appendFileSync(file, header + text, 'utf8');
  return file;
}

/**
 * @param {{ userData: string, workspacePath?: string | null, log?: Function, gateway?: object, plansStore?: object, coreBridge?: object, mcpRuntime?: object, createToolBridge?: Function, compactionAgent?: object, getTokenBudget?: Function, webContents?: object }} ctx
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
  appendPlanLog(userData, plan, reply);
  return { ok: true, summary: reply.slice(0, 8000), content: reply };
}

module.exports = { runPlan, chatCompletion, appendPlanLog, resolveEndpoint };
