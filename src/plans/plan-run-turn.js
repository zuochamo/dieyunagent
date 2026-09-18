'use strict';

const { ensurePlanSession } = require('./plan-session');

const PLAN_MODE_LABEL = '定时 Agent';

/**
 * 叠云 meta 前缀打包/剥离。
 *
 * 计划运行没有 Renderer 参与，会话轮次只能由 Main 写；这里与 Renderer
 * (`renderer-chat-bubbles.js`) 共用同一份 `【叠云meta】{...}\n<正文>` 约定。
 */
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

const stripUserMeta = stripAssistantMeta;

/** 计划专用会话标题：创建与 touch 共用一处，避免两处拼串漂移 */
function planSessionTitle(plan) {
  const name = (plan && plan.name) || '未命名计划';
  return `[计划] ${name}`;
}

/** 本次触发的用户轮次文本（同时是 Agent 的「本次任务」输入，两处必须完全一致） */
function buildPlanRunUserText(plan, at) {
  const when = (at instanceof Date ? at : new Date()).toLocaleString('zh-CN');
  const todos = plan && Array.isArray(plan.todos) ? plan.todos : [];
  const todoBlock = todos.length ? `\n\n执行 TODO：\n${todos.map((t, i) => `${i + 1}. ${t}`).join('\n')}` : '';
  return `[计划 · ${(plan && plan.name) || '未命名计划'}]\n${when} · 定时触发\n\n${(plan && plan.prompt) || ''}${todoBlock}`;
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
async function beginPlanRunTurn(gateway, plansStore, plan) {
  const { plan: boundPlan, sessionId, rebuilt, staleSessionId } = await ensurePlanSession(
    gateway,
    plansStore,
    plan
  );
  const userText = buildPlanRunUserText(boundPlan);
  await gateway.invokeRpc('memory.message_append', {
    sessionId,
    role: 'user',
    content: userText
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
    return String(result.content || result.summary || '').trim() || '（计划执行完成，无文本摘要）';
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
  const body = opts.replyText != null ? String(opts.replyText) : assistantReplyText(result);
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
  PLAN_MODE_LABEL,
  packAssistantMeta,
  stripAssistantMeta,
  stripUserMeta,
  planSessionTitle,
  buildPlanRunUserText,
  beginPlanRunTurn,
  endPlanRunTurn,
  assistantReplyText,
  interruptedRunResult
};
