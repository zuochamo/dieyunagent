'use strict';

const { ASSISTANT_IDENTITY, formatDieyunSystemBlock, loadDieyunInstructions } = require('../dieyun-instructions');
const { buildTaskSkillsSystem } = require('../automation/skill-prompt');
const { runRustAgentLoop } = require('../agent/rust-loop-runner');
const { resolveTurnModel } = require('../agent/main-turn-runner');
const { resolveLoopToolCallLimit, resolveAgentMaxRounds } = require('../agent/agent-limits');
const {
  buildCompletionMessagesFromHistory,
  loadRecentTurnMessages,
  completionHistoryHelpers
} = require('../agent/session-context');
const roundText = require('../agent/agent-round-text');
const { clearToolHarnessSessionsForSession } = require('../agent/tool-harness');
const { buildPlanRunUserText } = require('./plan-run-turn');
const { buildMainAgentTools } = require('../agent/main-agent-tools');
// 目标型计划专用的两个工具（goal_check / goal_finish）：schema 的唯一来源是 tool-catalog
const { GOAL_TOOLS } = require('../agent/tool-catalog');
// 「这个工具会不会改工作区」的唯一判定（收尾事实里的改动次数用它统计）
const { isMutatingAgentTool } = require('../agent/tool-classify');
const { buildLoopCompactionHandler } = require('../agent/compaction-loop');
const { isAbortError } = require('../llm-reconnect-retry');
const { appendPlanLog } = require('./plan-log');

/**
 * 计划执行器（Main 侧「跑一轮」的**计划分支**）。
 *
 * 与 `agent/main-turn-runner.js` 的关系（2026-11-21 明确，见 docs/CODE-CLEANLINESS-REVIEW §8.7）：
 * - **共用**：历史读取与消息装配（`session-context.loadRecentTurnMessages` /
 *   `completionHistoryHelpers`）、轮次上限（`agent-limits.resolveAgentMaxRounds`）、
 *   空交付文案（`agent-round-text.emptyTurnFailureMessage`）、循环装配与压缩、交付四态；
 * - **只有三处是计划独有**（刻意不复用）：
 *   1. 系统提示：定时任务没有 Renderer 会话，人格段/计划名/工作空间要在无 UI 上下文里拼
 *      （`buildPlanSystemMessage`），与聊天那条 `prepSystemPrompt` 的输入快照不是同一形状；
 *   2. `trigger === 'goal'` 的计划额外拿到 `GOAL_TOOLS`（只在这条路径加，避免「在聊天里对着空气申请完成」）；
 *   3. 事实统计 `mutatingToolCalls`（收尾时给人看「一次改动都没有、检查却全绿」）。
 * 改这三处以外的东西，先问「能不能改到共用那一份」。
 */

async function buildPlanSystemMessage(userData, workspacePath, plan, userPrompt) {
  const chunks = [
    ASSISTANT_IDENTITY,
    '【定时计划 Agent】你正在执行叠云定时任务。这是该计划的专用会话，可读取上文历次执行记录。请使用工具完成可执行步骤，给出明确结果。',
    `计划名称：${plan.name || '未命名计划'}`
  ];
  // 计划可以绑定自己的工作空间（见 plans/store#workspace）：不写进上下文，模型只能用相对路径猜根目录
  const ws = String(workspacePath || '').trim();
  if (ws) chunks.push(`【工作空间】\n${ws}`);
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

  // 本次运行的会话与用户轮次已由 Main 在运行边界准备好（plan-run-turn#beginPlanRunTurn）：
  // 这里只消费 ctx.sessionId / ctx.planUserPrompt，不再自己绑会话、写会话（唯一实现）。
  const sessionId = String(ctx.sessionId || '');
  if (!sessionId) {
    throw new Error('计划会话未就绪：Main 未能在运行前准备计划专用会话');
  }

  // 模型 / 档位 / 预算 / apiCfg 的解析与主循环同一份（main-turn-runner#resolveTurnModel）：
  // strict=true（路由失效明确报错，绝不静默换 key）+ tierHint 用「计划绑定的路由」判档
  // （定时执行没有设置页可问，档位不能假设在 default）。
  const bound = String(plan.modelRoute || plan.model || '').trim();
  let resolved;
  try {
    resolved = resolveTurnModel({
      userData,
      route: plan.modelRoute,
      model: plan.model,
      strict: true,
      tierHint: plan.modelRoute
    });
  } catch (err) {
    // 计划侧把「哪条绑定失效」说清楚：定时任务没有设置页上下文，一句「未配置 API Key」帮不到人。
    if (!bound) throw err;
    throw new Error(
      `计划绑定的模型不可用（${bound}），请在「模型设置」检查该模型/供应商是否仍启用`
    );
  }
  const { runSettings, llmModel, contextTierId, tokenBudget, apiCfg } = resolved;
  const boundPlan = plan;
  const userPrompt = String(ctx.planUserPrompt || '') || buildPlanRunUserText(boundPlan);
  const sysContent = await buildPlanSystemMessage(userData, workspacePath, boundPlan, userPrompt);

  // 历史读取与 helpers 与主循环同一份（session-context）：这里不再自带一份「只认 created_at」的实现。
  const history = await loadRecentTurnMessages(gateway, sessionId, 120);
  const messages = buildCompletionMessagesFromHistory(
    history,
    sysContent,
    null,
    false,
    completionHistoryHelpers()
  );
  const tools = await buildMainAgentTools(mcpRuntime);
  // 目标型计划多给两个工具：跑检查（留事实）与申请收尾（代码核对事实）。
  // 只在这一条路径上加 —— 聊天/频道/其它计划拿不到它们，避免「在聊天里对着空气申请完成」。
  if (boundPlan.trigger === 'goal') tools.push(...GOAL_TOOLS);
  const toolBridge = createToolBridge(webContents || null);

  let loopResult = null;
  let aborted = false;
  // 目标型：本轮「改动工作区」的工具调用次数。收尾时作为事实给人看 ——
  // 「一次改动都没有、检查却全绿」是「这条检查分不出做没做完」的唯一机械线索。
  let mutatingToolCalls = 0;
  // 工具调用的固定上下文（planId 让 goal_check / goal_finish 知道该给哪个计划留事实）
  const toolCtx = {
    workspacePath: workspacePath || undefined,
    sessionId,
    model: llmModel,
    modelRoute: boundPlan.modelRoute || undefined,
    contextTierId,
    planId: boundPlan.trigger === 'goal' ? boundPlan.id : undefined
  };
  // 测试缝：单测用假 loop 跑完整编排，断言「计划这一轮到底喂了什么」（sysContent / startParams）。
  // 生产调用方从不传 ctx.runRustAgentLoop。
  const runLoop = typeof ctx.runRustAgentLoop === 'function' ? ctx.runRustAgentLoop : runRustAgentLoop;
  try {
    loopResult = await runLoop({
      coreBridge,
      llm: apiCfg,
      settings: runSettings,
      userData,
      useStream: true,
      signal: signal || null,
      // 请求快照：定时/计划任务的请求同样留底（来源标 plan）。
      sessionId,
      runSource: 'plan',
      onPhase: (name, data) => emitPhase(name, data),
      startParams: {
        model: llmModel,
        messages,
        tools,
        maxToolCalls: resolveLoopToolCallLimit(runSettings),
        maxRounds: resolveAgentMaxRounds(runSettings),
        workspaceRoot: workspacePath || undefined
      },
      compactMessages: buildLoopCompactionHandler({
        compactionAgent,
        gateway,
        userData,
        sessionId,
        workspacePath,
        tokenBudget,
        contextTierId,
        apiConfig: apiCfg,
        model: llmModel
      }),
      // 交付决策的单一来源是 `agent-round-text` 的四态（§3.4）：计划这一路同样要把
      // 「有工具轮但没写正文」交给汇总轮，而不是自己拼一句占位文案。
      // 汇总只在此开关打开时发生，且是**追加**一轮无工具 LLM，不改变有正文的行为。
      turnEndSynthesis: true,
      delegateTool: async (name, args) => {
        const result = await toolBridge.executeAgentTool(name, args, toolCtx);
        if (isMutatingAgentTool(name) && result && result.ok !== false) mutatingToolCalls += 1;
        return result;
      }
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
      modelId: llmModel,
      mutatingToolCalls
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
      roundText.emptyTurnFailureMessage(toolCount)
    );
  }
  appendPlanLog(userData, boundPlan, reply);

  const traceNote = summarizeTrace(trace);
  const summary = traceNote ? `${reply.slice(0, 6000)}\n\n---\n${traceNote}` : reply.slice(0, 8000);

  if (log) log(`计划 Agent 完成: ${boundPlan.name} · session ${sessionId}`);

  // 记忆归纳：定时计划 / 目标任务的轮次同样要沉淀（以前只有对话收尾路径会归纳，
  // 自动跑出来的成果一条都没进长期记忆）。事实直接取本轮 result，不额外上报。
  try {
    const { afterAgentRun } = require('../agent/knowledge-maintainer');
    afterAgentRun({
      result: {
        content: reply,
        trace,
        runId: loopResult && loopResult.runId,
        plan: null,
        review: null,
        readiness: loopResult && loopResult.readiness
      },
      opts: {
        sessionId,
        workspacePath: workspacePath || '',
        model: llmModel,
        apiConfig: apiCfg,
        userText: userPrompt
      }
    });
  } catch {
    // 归纳失败不影响任务本身
  }

  // 只回结果：assistant 轮次由 Main 在运行边界统一落库（plan-run-turn#endPlanRunTurn）
  return {
    ok: true,
    summary,
    sessionId,
    content: reply,
    trace,
    modelLabel: llmModel,
    modelId: llmModel,
    // 目标型收尾事实：「本轮改动工作区的工具调用次数」（其它计划忽略）
    mutatingToolCalls
  };
}

module.exports = { runPlanAgentLoop };
