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
    log
  } = ctx;

  ipcMain.handle('plans:list', () => {
    const plansStore = getPlansStore();
    return plansStore ? plansStore.list() : [];
  });

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

  ipcMain.handle('plans:create-from-text', async (_evt, payload) => {
    const plansStore = getPlansStore();
    const localGateway = getLocalGateway();
    const plansScheduler = getPlansScheduler();
    if (!plansStore) throw new Error('计划存储未就绪');
    const text = payload && payload.text != null ? String(payload.text) : '';
    if (!text.trim()) throw new Error('请提供计划描述');
    const plan = await parsePlanFromText(getUserDataPath(), text, {
      skillIds: payload && payload.skillIds ? payload.skillIds : []
    });
    let saved = plansStore.upsert(plan);
    if (localGateway) {
      saved = (await ensurePlanSession(localGateway, plansStore, saved)).plan;
    }
    if (plansScheduler) plansScheduler.reload();
    return { ok: true, plan: saved };
  });
}

module.exports = { registerPlansIpc };
