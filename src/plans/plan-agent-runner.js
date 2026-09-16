'use strict';

const { loadModelSettings, clampAgentMaxRounds } = require('../model-settings');
const { ASSISTANT_IDENTITY, formatDieyunSystemBlock, loadDieyunInstructions } = require('../dieyun-instructions');
const { buildTaskSkillsSystem } = require('../automation/skill-prompt');
const { runRustAgentLoop } = require('../agent/rust-loop-runner');
const { resolveLoopToolCallLimit } = require('../agent/agent-limits');
const { buildCompletionMessagesFromHistory } = require('../agent/session-context');
const { clearToolHarnessSessionsForSession } = require('../agent/tool-harness');
const { ensurePlanSession } = require('./plan-session');
const { buildPlanAgentTools } = require('./plan-tools');
const fs = require('fs');
const path = require('path');

const PLAN_MODE_LABEL = '定时 Agent';

function packAssistantMeta(content, meta) {
  if (!meta) return content;
  try {
    return `【叠云meta】${JSON.stringify(meta)}\n${content}`;
  } catch {
    return content;
  }
}

function stripAssistantMeta(raw) {
  const s = String(raw || '');
  const m = s.match(/^【叠云meta】\{[\s\S]*?\}\n([\s\S]*)$/);
  return m ? m[1] : s;
}

function stripUserMeta(raw) {
  return stripAssistantMeta(raw);
}

function buildPlanUserPrompt(plan) {
  const when = new Date().toLocaleString('zh-CN');
  const todoBlock =
    Array.isArray(plan.todos) && plan.todos.length
      ? `\n\n执行 TODO：\n${plan.todos.map((t, i) => `${i + 1}. ${t}`).join('\n')}`
      : '';
  return `[计划 · ${plan.name}]\n${when} · 定时触发\n\n${plan.prompt}${todoBlock}`;
}

async function buildPlanSystemMessage(userData, workspacePath, plan, userPrompt) {
  const chunks = [
    ASSISTANT_IDENTITY,
    '【定时计划 Agent】你正在执行叠云定时任务。这是该计划的专用会话，可读取上文历次执行记录。请使用工具完成可执行步骤，给出明确结果。',
    `计划名称：${plan.name || '未命名计划'}`
  ];
  const dieyunBlock = formatDieyunSystemBlock();
  if (dieyunBlock) chunks.push(dieyunBlock);
  try {
    const { content } = loadDieyunInstructions();
    if (content) chunks.push(content.slice(0, 8000));
  } catch {
    // ignore
  }
  try {
    const skillBlock = await buildTaskSkillsSystem(userData, workspacePath || null, plan.skillIds);
    if (skillBlock) chunks.push(skillBlock);
  } catch {
    // ignore
  }
  if (userPrompt) {
    chunks.push(`【本次任务】\n${userPrompt.slice(0, 4000)}`);
  }
  return chunks.filter(Boolean).join('\n\n');
}

async function loadSessionMessages(gateway, sessionId, limit = 120) {
  const rows = await gateway.invokeRpc('memory.messages_recent', {
    sessionId,
    limit
  });
  return (Array.isArray(rows) ? rows : [])
    .filter((r) => r && (r.role === 'user' || r.role === 'assistant'))
    .map((r) => ({
      role: r.role,
      content: String(r.content || ''),
      created_at: r.created_at
    }));
}

function buildPlanCompletionMessages(historyMessages, sysContent) {
  const helpers = {
    unpackUserContent: stripUserMeta,
    unpackAssistantMeta: (raw) => ({ content: stripAssistantMeta(raw), meta: null }),
    compactPlainText: (s, n) => String(s || '').slice(0, n)
  };
  return buildCompletionMessagesFromHistory(historyMessages, sysContent, null, false, helpers);
}

function summarizeTrace(trace) {
  if (!Array.isArray(trace) || !trace.length) return '';
  return trace
    .slice(-6)
    .map((round) => {
      const thought = String(round.fullThought || round.thought || '').trim();
      const tools = (round.tools || [])
        .map((t) => `${t.name}${t.failed ? '✗' : '✓'}`)
        .join(', ');
      return [thought && `思考: ${thought.slice(0, 200)}`, tools && `工具: ${tools}`]
        .filter(Boolean)
        .join(' · ');
    })
    .filter(Boolean)
    .join('\n');
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
 * @param {object} ctx
 * @param {object} plan
 */
async function runPlanAgentLoop(ctx, plan) {
  const {
    userData,
    workspacePath,
    gateway,
    plansStore,
    coreBridge,
    mcpRuntime,
    createToolBridge,
    compactionAgent,
    getTokenBudget,
    webContents,
    log
  } = ctx;

  if (!plan || !plan.prompt) throw new Error('计划缺少 prompt');
  if (!gateway || typeof gateway.invokeRpc !== 'function') {
    throw new Error('Gateway 未就绪');
  }
  if (!coreBridge || !coreBridge.isReady()) {
    throw new Error('Agent 需要 dieyun-core 就绪（请运行 npm run pack:dieyun-core 并重启）');
  }

  const settings = loadModelSettings(userData);
  if (!settings.apiKey) throw new Error('未配置 API Key');

  const { plan: boundPlan, sessionId } = await ensurePlanSession(gateway, plansStore, plan);
  const userPrompt = buildPlanUserPrompt(boundPlan);
  const sysContent = await buildPlanSystemMessage(userData, workspacePath, boundPlan, userPrompt);

  await gateway.invokeRpc('memory.message_append', {
    sessionId,
    role: 'user',
    content: userPrompt
  });
  await gateway.invokeRpc('memory.touch_session', {
    sessionId,
    title: `[计划] ${boundPlan.name}`
  });

  const history = await loadSessionMessages(gateway, sessionId, 120);
  const messages = buildPlanCompletionMessages(history, sysContent);
  const tools = await buildPlanAgentTools(mcpRuntime);
  const toolBridge = createToolBridge(webContents || null);
  const tokenBudget =
    typeof getTokenBudget === 'function' ? getTokenBudget(settings.textModel) : 96000;
  const apiCfg = { baseUrl: settings.baseUrl, apiKey: settings.apiKey };

  let loopResult;
  try {
    loopResult = await runRustAgentLoop({
      coreBridge,
      llm: apiCfg,
      settings,
      userData,
      useStream: true,
      startParams: {
        model: settings.textModel,
        messages,
        tools,
        maxToolCalls: resolveLoopToolCallLimit(settings, userData),
        maxRounds: clampAgentMaxRounds(settings.agentMaxRounds),
        workspaceRoot: workspacePath || undefined
      },
      compactMessages: compactionAgent
        ? async (msgs) => {
            const cr = await compactionAgent.maybeCompactMessages(msgs, {
              tokenBudget,
              apiConfig: { ...apiCfg, model: settings.textModel },
              model: settings.textModel,
              sessionId
            });
            if (cr && cr.compacted) {
              gateway
                .invokeRpc('memory.compaction_archive', {
                  sessionId,
                  workspacePath: workspacePath || null,
                  tokensBefore: cr.tokensBefore,
                  tokensAfter: cr.tokensAfter,
                  summary: cr.summary || null,
                  foldedTranscript: cr.foldedTranscript || null
                })
                .catch(() => {});
            }
            return cr;
          }
        : null,
      delegateTool: async (name, args) =>
        toolBridge.executeAgentTool(name, args, {
          workspacePath: workspacePath || undefined,
          sessionId,
          model: settings.textModel
        })
    });
  } finally {
    clearToolHarnessSessionsForSession(sessionId);
  }

  const reply = String(loopResult?.content || '').trim() || '（计划执行完成，无文本摘要）';
  const trace = Array.isArray(loopResult?.trace) ? loopResult.trace : [];
  appendPlanLog(userData, boundPlan, reply);

  const assistantMeta = {
    modeLabel: PLAN_MODE_LABEL,
    modelLabel: settings.textModel || 'Auto',
    modelId: settings.textModel || '',
    ts: Date.now(),
    planId: boundPlan.id
  };
  const persisted = packAssistantMeta(reply, assistantMeta);
  await gateway.invokeRpc('memory.message_append', {
    sessionId,
    role: 'assistant',
    content: persisted
  });
  await gateway.invokeRpc('memory.touch_session', {
    sessionId,
    title: `[计划] ${boundPlan.name}`
  });

  const traceNote = summarizeTrace(trace);
  const summary = traceNote ? `${reply.slice(0, 6000)}\n\n---\n${traceNote}` : reply.slice(0, 8000);

  if (log) log(`计划 Agent 完成: ${boundPlan.name} · session ${sessionId}`);

  return {
    ok: true,
    summary,
    sessionId,
    content: reply,
    trace,
    persisted: true
  };
}

module.exports = { runPlanAgentLoop, ensurePlanSession, buildPlanUserPrompt };
