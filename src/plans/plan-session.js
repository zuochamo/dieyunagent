'use strict';

/**
 * 为定时计划绑定专用会话；若已有有效 sessionId 则复用。
 * @returns {Promise<{ plan: object, sessionId: string }>}
 */
async function ensurePlanSession(gateway, plansStore, plan) {
  if (!gateway || typeof gateway.invokeRpc !== 'function') {
    throw new Error('Gateway 未就绪，无法绑定计划会话');
  }
  if (!plan || !plan.id) throw new Error('计划无效');
  if (!plansStore) throw new Error('计划存储未就绪');

  let sessionId = plan.deliver && plan.deliver.sessionId ? String(plan.deliver.sessionId).trim() : '';
  if (sessionId) {
    try {
      const row = await gateway.invokeRpc('memory.session_get', { sessionId });
      if (row && row.id) {
        return { plan: plansStore.get(plan.id) || plan, sessionId: row.id };
      }
    } catch {
      // 会话已删除，下面重建
    }
  }

  const created = await gateway.invokeRpc('memory.session_create', {
    title: `[计划] ${plan.name || '未命名计划'}`,
    workspacePath: null
  });
  if (!created || !created.id) throw new Error('创建计划专用会话失败');
  sessionId = created.id;

  const bound = plansStore.upsert({
    ...plan,
    deliver: {
      type: 'session',
      sessionId
    }
  });
  return { plan: bound, sessionId };
}

module.exports = { ensurePlanSession };
