'use strict';

const { loadModelSettings, clampAgentMaxRounds, resolveTextApiConfig } = require('../model-settings');
const { ASSISTANT_IDENTITY, formatDieyunSystemBlock, loadDieyunInstructions } = require('../dieyun-instructions');
const { buildTaskSkillsSystem } = require('../automation/skill-prompt');
const { runRustAgentLoop } = require('../agent/rust-loop-runner');
const { resolveLoopToolCallLimit } = require('../agent/agent-limits');
const { buildCompletionMessagesFromHistory } = require('../agent/session-context');
const { clearToolHarnessSessionsForSession } = require('../agent/tool-harness');
const { buildPlanRunUserText, stripAssistantMeta, stripUserMeta } = require('./plan-run-turn');
const { buildPlanAgentTools } = require('./plan-tools');
const { isAbortError } = require('../llm-reconnect-retry');
const { appendPlanLog } = require('./plan-log');

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

/**
 * @param {object} ctx
 * @param {object} plan
 */
async function runPlanAgentLoop(ctx, plan) {
  const {
    userData,
    workspacePath,
    gateway,
    coreBridge,
    mcpRuntime,
    createToolBridge,
    compactionAgent,
    getTokenBudget,
    webContents,
    signal,
    onPlanPhase,
    log
  } = ctx;
  const emitPhase = typeof onPlanPhase === 'function' ? onPlanPhase : () => {};

  if (!plan || !plan.prompt) throw new Error('计划缺少 prompt');
  if (!gateway || typeof gateway.invokeRpc !== 'function') {
    throw new Error('Gateway 未就绪');
  }
  if (!coreBridge || !coreBridge.isReady()) {
    throw new Error('Agent 需要 dieyun-core 就绪（请运行 npm run pack:dieyun-core 并重启）');
  }

  // 定时执行没有 Renderer 会话：只能按计划自己记住的路由解析模型配置。
  // strict=true —— 路由失效（模型/供应商被删）明确报错，绝不静默换到别的 key 上跑。
  const settings = loadModelSettings(userData);
  const llm = resolveTextApiConfig(settings, {
    route: plan.modelRoute,
    model: plan.model,
    strict: true
  });
  if (!llm.apiKey || !llm.baseUrl) {
    throw new Error(
      plan.modelRoute
        ? `计划绑定的模型不可用（${plan.modelRoute}），请在「模型设置」检查该模型/供应商是否仍启用`
        : '未配置 API Key，请在模型设置中填写'
    );
  }
  const llmModel = llm.model || settings.textModel || '';
  if (!llmModel) {
    // 别再让下层报 “model 必填”：这里是最清楚上下文的一层
    throw new Error(
      '计划未绑定模型，且没有可用的默认模型：请在「定时任务 → 编辑」里选择模型，或在「模型设置」中启用一个供应商模型'
    );
  }

  // 本次运行的会话与用户轮次已由 Main 在运行边界准备好（plan-run-turn#beginPlanRunTurn）：
  // 这里只消费 ctx.sessionId / ctx.planUserPrompt，不再自己绑会话、写会话（唯一实现）。
  const sessionId = String(ctx.sessionId || '');
  if (!sessionId) {
    throw new Error('计划会话未就绪：Main 未能在运行前准备计划专用会话');
  }
  const boundPlan = plan;
  const userPrompt = String(ctx.planUserPrompt || '') || buildPlanRunUserText(boundPlan);
  const sysContent = await buildPlanSystemMessage(userData, workspacePath, boundPlan, userPrompt);

  const history = await loadSessionMessages(gateway, sessionId, 120);
  const messages = buildPlanCompletionMessages(history, sysContent);
  const tools = await buildPlanAgentTools(mcpRuntime);
  const toolBridge = createToolBridge(webContents || null);
  const tokenBudget =
    typeof getTokenBudget === 'function' ? getTokenBudget(llmModel) : 96000;
  // 整体继承 llm：逐字段重建会丢掉 headers / authMode / userAgent（压缩也复用这份 apiCfg）
  const apiCfg = { ...llm, baseUrl: llm.baseUrl, apiKey: llm.apiKey };

  let loopResult = null;
  let aborted = false;
  try {
    loopResult = await runRustAgentLoop({
      coreBridge,
      llm: apiCfg,
      settings,
      userData,
      useStream: true,
      signal: signal || null,
      onPhase: (name, data) => emitPhase(name, data),
      startParams: {
        model: llmModel,
        messages,
        tools,
        maxToolCalls: resolveLoopToolCallLimit(settings, userData),
        maxRounds: clampAgentMaxRounds(settings.agentMaxRounds),
        workspaceRoot: workspacePath || undefined
      },
      compactMessages: compactionAgent
        ? async (msgs, ctx) => {
            const cr = await compactionAgent.maybeCompactMessages(msgs, {
              tokenBudget,
              apiConfig: { ...apiCfg, model: llmModel },
              model: llmModel,
              sessionId,
              toolsChars: ctx?.toolsChars
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
      // 交付决策的单一来源是 `agent-round-text` 的四态（§3.4）：计划这一路同样要把
      // 「有工具轮但没写正文」交给汇总轮，而不是自己拼一句占位文案。
      // 汇总只在此开关打开时发生，且是**追加**一轮无工具 LLM，不改变有正文的行为。
      turnEndSynthesis: true,
      delegateTool: async (name, args) =>
        toolBridge.executeAgentTool(name, args, {
          workspacePath: workspacePath || undefined,
          sessionId,
          model: llmModel,
          modelRoute: boundPlan.modelRoute || undefined
        })
    });
  } catch (err) {
    if (!isAbortError(err)) throw err;
    aborted = true;
  } finally {
    clearToolHarnessSessionsForSession(sessionId);
  }

  if (aborted) {
    // 用户从 UI 停止：assistant 轮次（「（计划已停止）」）由 Main 统一落库
    return {
      ok: false,
      aborted: true,
      error: '已停止',
      summary: '已停止',
      sessionId,
      content: '',
      trace: [],
      modelLabel: llmModel || 'Auto',
      modelId: llmModel
    };
  }

  const reply = String(loopResult?.content || '').trim();
  const trace = Array.isArray(loopResult?.trace) ? loopResult.trace : [];
  if (!reply) {
    // 走到这里仍无正文 == 这一轮什么都没交付。历史上这里会落一句「（计划执行完成，
    // 无文本摘要）」并返回 ok:true —— 于是一次**完全没执行**的巡检被记成
    // `lastRunOk: true`，上游「额度用尽」这类错误被静默丢掉，用户以为任务跑过了。
    // 空交付必须如实失败：让 lastRunOk=false、会话里留 `执行失败：…`。
    const toolCount = trace.reduce((n, r) => n + ((r && r.tools) || []).length, 0);
    throw new Error(
      toolCount
        ? `模型执行了 ${toolCount} 次工具调用但未生成任何正文，请查看日志后重跑`
        : '模型未返回任何正文与工具调用（上游可能拒绝请求或额度已用尽），请查看日志后重跑'
    );
  }
  appendPlanLog(userData, boundPlan, reply);

  const traceNote = summarizeTrace(trace);
  const summary = traceNote ? `${reply.slice(0, 6000)}\n\n---\n${traceNote}` : reply.slice(0, 8000);

  if (log) log(`计划 Agent 完成: ${boundPlan.name} · session ${sessionId}`);

  // 只回结果：assistant 轮次由 Main 在运行边界统一落库（plan-run-turn#endPlanRunTurn）
  return {
    ok: true,
    summary,
    sessionId,
    content: reply,
    trace,
    modelLabel: llmModel,
    modelId: llmModel
  };
}

module.exports = { runPlanAgentLoop };
