'use strict';

const { buildPlanRunUserText, endPlanRunTurn } = require('./plan-run-turn');

/**
 * 计划结果投递（降级兜底）。
 *
 * 正常路径下这次运行的会话轮次已经由 Main 在运行边界写完了
 * （`plan-run-turn#beginPlanRunTurn` / `endPlanRunTurn`，result.sessionId 有值），
 * 不会走到这里。只有「运行开始时没能准备会话」才由本函数补投，
 * 避免用户在计划会话里完全看不到这次运行。
 *
 * @returns {Promise<string|null>} sessionId
 */
async function deliverPlanResult(gateway, plan, result) {
  if (!gateway || typeof gateway.invokeRpc !== 'function' || !plan) return null;
  const sessionId = plan.deliver && plan.deliver.sessionId ? String(plan.deliver.sessionId) : '';
  if (!sessionId) return null;

  // 与运行边界完全同一份文案与 meta（不再各写一套）
  await gateway.invokeRpc('memory.message_append', {
    sessionId,
    role: 'user',
    content: buildPlanRunUserText(plan)
  });
  await endPlanRunTurn(gateway, sessionId, plan, result);
  return sessionId;
}

module.exports = { deliverPlanResult };
