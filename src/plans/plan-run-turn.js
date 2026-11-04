'use strict';

const { ensurePlanSession } = require('./plan-session');
// 目标型的事实块与预算收敛：唯一来源是 goal-run（本文件不另写措辞/不另算预算）
const { renderEvidenceBlock } = require('./goal-run');
const { packMessageMeta, unpackMessageMeta } = require('../agent/session-context');
// 空交付文案 / 「思考回退不落库」闸门的单一来源，勿在此另造一句
const roundText = require('../agent/agent-round-text');

const PLAN_MODE_LABEL = '定时 Agent';

/**
 * 叠云 meta 前缀打包/剥离：统一走 session-context 的唯一实现。
 *
 * 计划运行没有 Renderer 参与，会话轮次只能由 Main 写。这里原有第二份 packAssistantMeta，
 * 与 Renderer 那份是同一约定的两份独立实现（且都不过滤字节）——「附件 base64 落库」
 * 就是这么漏出来的，现在全部委托 packMessageMeta。
 */
function packAssistantMeta(content, meta) {
  return packMessageMeta(content, meta, { role: 'assistant' });
}

function stripAssistantMeta(raw) {
  return unpackMessageMeta(raw).content;
}

const stripUserMeta = stripAssistantMeta;

/** 计划专用会话标题：创建与 touch 共用一处，避免两处拼串漂移 */
function planSessionTitle(plan) {
  const name = (plan && plan.name) || '未命名计划';
  return `[计划] ${name}`;
}

/**
 * 目标型计划的「交接班」段落（唯一来源）：轮次、预算、已经落盘的检查事实。
 *
 * 这是对抗「开局失忆」和「自称完成」的主要手段：新的一轮 context 是空的，
 * 靠这段文本把「已经试过什么、上一条检查怎么红的」交回来。事实块由 goal-run 渲染，
 * 这里只负责把它放到交接班文本里 —— 不在这一层另写一份措辞。
 *
 * @param {object} plan
 * @param {object} [limits] agent-limits（缺省用默认值）
 */
function buildGoalRoundBlock(plan, limits) {
  return renderEvidenceBlock({ plan, limits, upcoming: true });
}

/**
 * 本次触发的用户轮次文本（同时是 Agent 的「本次任务」输入，两处必须完全一致）。
 * @param {object} plan
 * @param {Date} [at]
 * @param {object} [limits]
 */
function buildPlanRunUserText(plan, at, limits) {
  const when = (at instanceof Date ? at : new Date()).toLocaleString('zh-CN');
  const isGoal = !!(plan && plan.trigger === 'goal');
  const todos = plan && Array.isArray(plan.todos) ? plan.todos : [];
  const todoBlock = todos.length
    ? `\n\n执行 TODO：\n${todos.map((t, i) => `${i + 1}. ${t}`).join('\n')}`
    : '';
  const goalBlock = isGoal ? `\n\n${buildGoalRoundBlock(plan, limits)}` : '';
  // 目标的「是什么」单独一行：事实块只讲轮次与检查事实，不重复目标本身。
  const objective = isGoal && plan.goal ? String(plan.goal.objective || '').trim() : '';
  const objectiveLine = objective ? `\n目标：${objective}` : '';
  // 目标型的收尾入口只讲一次：跑检查 → 留事实 → 申请收尾。文案写在工具 schema 里，
  // 这里只说「本轮该做什么」，不重复工具用法（避免两处描述漂移）。
  const goalTail = isGoal
    ? '\n\n要求：先看上面的事实块再决定本轮做什么，只推进尚未完成的部分；' +
      '改完用 goal_check 跑检查留下事实，确认目标已达成再调用 goal_finish（outcome=complete）；' +
      '真正卡住就用 goal_finish（outcome=blocked）说明确切卡点。'
    : '';
  return (
    `[计划 · ${(plan && plan.name) || '未命名计划'}]\n` +
    `${when} · ${isGoal ? '目标续跑' : '定时触发'}` +
    objectiveLine +
    goalBlock +
    `\n\n${(plan && plan.prompt) || ''}` +
    todoBlock +
    goalTail
  );
}

/**
 * 本次触发的结构化归因（落进 user meta 的 `trigger`）。
 *
 * 与正文抬头 `[计划 · 名字] … · 定时触发` 是同一事实的两种载体：正文给模型读，
 * meta 给 UI 与回放读（Renderer 据此渲染成「触发条」，不再把系统自己开的一轮
 * 冒充成用户气泡）。kind 只在有 Producer 时才登记，未登记的类型由 Renderer 回落通用标题。
 *
 * @param {object} plan
 * @param {Date} [at]
 * @returns {{ kind: string, planId: string, planName: string, at: string }}
 */
function buildPlanRunTrigger(plan, at) {
  const when = at instanceof Date ? at : new Date();
  return {
    kind: plan && plan.trigger === 'goal' ? 'goal' : 'schedule',
    planId: String((plan && plan.id) || ''),
    planName: String((plan && plan.name) || '').trim() || '未命名计划',
    at: when.toISOString()
  };
}

/**
 * 计划用户轮次的落库形态：正文（= 模型输入）+ 触发归因一次产出、一次打包。
 *
 * 运行边界（`beginPlanRunTurn`）与降级投递（`deliver.js`）共用这一处，
 * 避免两处各拼一次 meta 导致「计划轮次有的带归因、有的不带」。
 *
 * @param {object} plan
 * @param {Date} [at]
 * @param {object} [limits]
 * @returns {{ userText: string, content: string }}
 */
function planRunUserTurn(plan, at, limits) {
  const userText = buildPlanRunUserText(plan, at, limits);
  return {
    userText,
    content: packMessageMeta(userText, { trigger: buildPlanRunTrigger(plan, at) }, { role: 'user' })
  };
}

/**
 * 运行开始：确保计划专用会话存在，并把本次触发的用户轮次落库。
 *
 * 必须在广播 run_start 之前调用：`memory.sessions_list` 只返回有消息的会话，
 * 会话里先有这一轮，Renderer 才能在运行一开始就刷新出该会话与「运行中」，
 * 而不是等收尾投递之后才第一次出现。
 *
 * @returns {Promise<{ plan: object, sessionId: string, userText: string, rebuilt: boolean, staleSessionId: string }>}
 */
async function beginPlanRunTurn(gateway, plansStore, plan, opts = {}) {
  const { plan: boundPlan, sessionId, rebuilt, staleSessionId } = await ensurePlanSession(
    gateway,
    plansStore,
    plan
  );
  const { userText, content } = planRunUserTurn(boundPlan, undefined, opts.limits);
  await gateway.invokeRpc('memory.message_append', {
    sessionId,
    role: 'user',
    content
  });
  await gateway.invokeRpc('memory.touch_session', {
    sessionId,
    title: planSessionTitle(boundPlan)
  });
  return { plan: boundPlan, sessionId, userText, rebuilt, staleSessionId };
}

/**
 * 「中断」的统一结果：应用在运行边界内退出/重启，Main 没机会走完收尾。
 *
 * 与「用户停止」「执行失败」区分开，是为了让落库文案与恢复逻辑共用同一份语义
 * （中断回执只在启动恢复里产生，见 `mcp-plans-boot#recoverInterruptedRuns`）。
 */
function interruptedRunResult(reason) {
  return {
    ok: false,
    interrupted: true,
    error: String(reason || '应用在计划执行期间退出或重启')
  };
}

/** 这一轮该写进会话的 assistant 正文（停止/失败/中断也要留一条，否则只剩悬空的用户轮次） */
function assistantReplyText(result) {
  if (result && result.interrupted) {
    return `（本次运行被中断：${(result && result.error) || '应用退出或重启'}）`;
  }
  if (result && (result.aborted || result.stopped)) return '（计划已停止）';
  if (result && result.ok) {
    return (
      String(result.content || result.summary || '').trim() || roundText.TURN_EMPTY_REPLY_TEXT
    );
  }
  return `执行失败：${(result && result.error) || '未知错误'}`;
}

/**
 * 运行结束：写入 assistant 轮次。
 *
 * - `traceRunId` 用本次 runId：Renderer 收尾时把这次运行的思考过程存成同 runId 的
 *   trace 记录，这条消息下次打开时靠 `meta.traceRunId` 把思考区挂回来。
 * - 计划运行不经过聊天发送链路，正文不会自动落库，所以这里就是唯一写入点。
 * - `opts.replyText` 允许调用方复用「已经算好的同一份正文」（落库与终态事件同源），
 *   不传则按 result 现算。
 *
 * @param {{ traceRunId?: string, replyText?: string }} [opts]
 * @returns {Promise<string|null>} sessionId
 */
async function endPlanRunTurn(gateway, sessionId, plan, result, opts = {}) {
  if (!gateway || typeof gateway.invokeRpc !== 'function' || !sessionId) return null;
  const modelId = String((result && result.modelId) || (plan && plan.model) || '');
  const meta = {
    modeLabel: PLAN_MODE_LABEL,
    modelLabel: String((result && result.modelLabel) || modelId || 'Auto'),
    modelId,
    ts: Date.now(),
    planId: String((plan && plan.id) || '')
  };
  if (opts.traceRunId) meta.traceRunId = String(opts.traceRunId);
  // 账本正文再过一次「带标签思考引用不落库」闸门（REASONING-ISOLATION §3.4）：
  // 终态事件（展示）仍用原样 replyText，落库这一路与聊天路径同判据 ——
  // 带标签的思考引用只用于展示，写进账本一律换成占位。
  const body = roundText.persistableTurnText(
    opts.replyText != null ? String(opts.replyText) : assistantReplyText(result)
  );
  await gateway.invokeRpc('memory.message_append', {
    sessionId,
    role: 'assistant',
    content: packAssistantMeta(body, meta)
  });
  await gateway.invokeRpc('memory.touch_session', {
    sessionId,
    title: planSessionTitle(plan)
  });
  return sessionId;
}

module.exports = {
  packAssistantMeta,
  stripAssistantMeta,
  stripUserMeta,
  buildGoalRoundBlock,
  buildPlanRunUserText,
  buildPlanRunTrigger,
  planRunUserTurn,
  beginPlanRunTurn,
  endPlanRunTurn,
  assistantReplyText,
  interruptedRunResult
};
