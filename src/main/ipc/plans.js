'use strict';

/**
 * @param {import('../context').MainIpcContext & {
 *   getPlansStore: () => import('../../plans/store').PlansStore | null,
 *   getPlansScheduler: () => import('../../plans/scheduler').PlansScheduler | null,
 *   getLocalGateway: () => import('../../gateway/server').LocalGateway | null,
 *   getUserDataPath: () => string,
 *   ensurePlanSession: Function,
 *   parsePlanFromText: Function,
 *   finishPlanRun: (plan: object, result: object) => Promise<void>,
 *   listRunningPlans: () => Array<{ planId: string, runId: string, sessionId: string, startedAt: number }>,
 *   cancelPlanRun: (planId: string) => { ok: boolean, error?: string },
 *   log: { warn: (msg: string, ...args: unknown[]) => void }
 * }} ctx
 */
function registerPlansIpc(ctx) {
  const {
    ipcMain,
    getPlansStore,
    getPlansScheduler,
    getLocalGateway,
    getUserDataPath,
    ensurePlanSession,
    parsePlanFromText,
    finishPlanRun,
    listRunningPlans,
    cancelPlanRun,
    log
  } = ctx;

  /**
   * 计划列表 + 运行态合并：`running` 是「本进程内正在跑」的内存事实。
   * 落盘的 `runState` 只服务崩溃恢复（见 `recoverInterruptedRuns`），不代表此刻在运行，
   * 所以不能拿来当 `running` 用，只在这里合。
   * @returns {object[]}
   */
  function listPlansWithRuntime() {
    const plansStore = getPlansStore();
    const plans = plansStore ? plansStore.list() : [];
    const running = new Map(
      (typeof listRunningPlans === 'function' ? listRunningPlans() : []).map((r) => [r.planId, r])
    );
    if (!running.size) return plans;
    return plans.map((p) => {
      const live = running.get(p.id);
      return live
        ? { ...p, running: true, runId: live.runId, runningSessionId: live.sessionId, runningSince: live.startedAt }
        : p;
    });
  }

  ipcMain.handle('plans:list', () => listPlansWithRuntime());

  ipcMain.handle('plans:save', async (_evt, plan) => {
    const plansStore = getPlansStore();
    const localGateway = getLocalGateway();
    const plansScheduler = getPlansScheduler();
    if (!plansStore) return { ok: false, error: 'plans not ready' };
    const saved = plansStore.upsert(plan);
    let bound = saved;
    if (localGateway) {
      try {
        bound = (await ensurePlanSession(localGateway, plansStore, saved)).plan;
      } catch (e) {
        log.warn('计划绑定会话失败:', e.message);
      }
    }
    if (plansScheduler) plansScheduler.reload();
    return { ok: true, plan: bound };
  });

  ipcMain.handle('plans:delete', (_evt, id) => {
    const plansStore = getPlansStore();
    const plansScheduler = getPlansScheduler();
    if (!plansStore) return { ok: false };
    plansStore.delete(id);
    if (plansScheduler) plansScheduler.reload();
    return { ok: true };
  });

  ipcMain.handle('plans:run-now', async (_evt, id) => {
    const plansScheduler = getPlansScheduler();
    const plansStore = getPlansStore();
    if (!plansScheduler || !plansStore) {
      throw new Error('计划调度未就绪');
    }
    let result;
    try {
      result = await plansScheduler.runNow(id);
    } catch (e) {
      result = { ok: false, error: e.message || String(e) };
      const plan = plansStore.get(id);
      if (plan) finishPlanRun(plan, result).catch((e) => log.warn('计划收尾失败:', e.message));
    }
    if (plansScheduler) plansScheduler.reload();
    return result;
  });

  ipcMain.handle('plans:cancel', (_evt, planId) => {
    if (typeof cancelPlanRun !== 'function') return { ok: false, error: '计划调度未就绪' };
    return cancelPlanRun(String(planId || ''));
  });

  ipcMain.handle('plans:create-from-text', async (_evt, payload) => {
    const plansStore = getPlansStore();
    const localGateway = getLocalGateway();
    const plansScheduler = getPlansScheduler();
    if (!plansStore) throw new Error('计划存储未就绪');
    const text = payload && payload.text != null ? String(payload.text) : '';
    if (!text.trim()) throw new Error('请提供计划描述');
    const plan = await parsePlanFromText(getUserDataPath(), text, {
      skillIds: payload && payload.skillIds ? payload.skillIds : [],
      structured: payload && payload.structured ? payload.structured : undefined,
      route: payload && payload.modelRoute ? payload.modelRoute : undefined,
      model: payload && payload.model ? payload.model : undefined
    });
    let saved = plansStore.upsert({
      ...plan,
      modelRoute: (payload && payload.modelRoute) || plan.modelRoute || '',
      model: (payload && payload.model) || plan.model || ''
    });
    if (localGateway) {
      saved = (await ensurePlanSession(localGateway, plansStore, saved)).plan;
    }
    if (plansScheduler) plansScheduler.reload();
    return { ok: true, plan: saved };
  });
}

module.exports = { registerPlansIpc };
