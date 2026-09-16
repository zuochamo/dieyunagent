'use strict';

/**
 * 将计划执行结果投递到目标叠云对话会话。
 * @returns {Promise<string|null>} sessionId
 */
async function deliverPlanResult(gateway, plan, result) {
  if (!gateway || typeof gateway.invokeRpc !== 'function' || !plan) return null;
  const sessionId = plan.deliver && plan.deliver.sessionId ? String(plan.deliver.sessionId) : '';
  if (!sessionId) return null;

  const when = new Date().toLocaleString('zh-CN');
  const userLine = `[计划 · ${plan.name}]\n${when} · 定时触发`;
  let assistantLine;
  if (result && result.ok) {
    assistantLine = String(result.summary || '执行完成').trim() || '执行完成';
  } else {
    assistantLine = `执行失败：${(result && result.error) || '未知错误'}`;
  }

  await gateway.invokeRpc('memory.message_append', {
    sessionId,
    role: 'user',
    content: userLine
  });
  await gateway.invokeRpc('memory.message_append', {
    sessionId,
    role: 'assistant',
    content: assistantLine
  });
  await gateway.invokeRpc('memory.touch_session', {
    sessionId,
    title: `[计划] ${plan.name}`
  });
  return sessionId;
}

module.exports = { deliverPlanResult };
