'use strict';

const fs = require('fs');
const path = require('path');
const { loadModelSettings, MAX_TOKENS_DEFAULT } = require('../model-settings');
const { buildTaskSkillsSystem } = require('../automation/skill-prompt');
const { ASSISTANT_IDENTITY, formatDieyunSystemBlock } = require('../dieyun-instructions');
const { runPlanAgentLoop } = require('./plan-agent-runner');

async function chatCompletion(userData, prompt, extraSystem) {
  const settings = loadModelSettings(userData);
  if (!settings.apiKey) throw new Error('未配置 API Key，请在模型设置中填写');

  const systemParts = [ASSISTANT_IDENTITY];
  if (extraSystem) systemParts.push(extraSystem);
  const messages = [
    { role: 'system', content: systemParts.join('\n') },
    { role: 'user', content: prompt }
  ];

  const base = (settings.baseUrl || '').replace(/\/+$/, '');
  const url = /\/chat\/completions(?:\?|$)/i.test(base)
    ? base
    : /\/v\d+$/i.test(base)
      ? `${base}/chat/completions`
      : `${base}/v1/chat/completions`;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${settings.apiKey}`
    },
    body: JSON.stringify({
      model: settings.textModel,
      messages,
      temperature: Number(settings.temperature) || 0.3,
      max_tokens: Number(settings.maxTokens) || MAX_TOKENS_DEFAULT
    })
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`模型请求失败 ${res.status}: ${errText.slice(0, 200)}`);
  }

  const data = await res.json();
  return (
    (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) ||
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
  const reply = await chatCompletion(userData, `${plan.prompt}${todoBlock}`, extraSystem);
  appendPlanLog(userData, plan, reply);
  return { ok: true, summary: reply.slice(0, 8000) };
}

module.exports = { runPlan, chatCompletion, appendPlanLog };
