'use strict';

/**
 * 计划：plan_*。调度语义在 src/plans/scheduler.js，事实与核对在 src/plans/goal-run.js。
 *
 * 从 `tool-bridge-main.js` 的 1036 行 switch 里拆出（曾零直测）：现在由
 * `scripts/test-tool-bridge-handlers.cjs` 覆盖参数翻译与形状转换。
 * 依赖一律由 `shared` 传入（不 require），所以本文件能被单测直接装进沙箱。
 *
 * @param {object} shared 工具桥闭包里的依赖与取值器（见 main-tools/index.js）
 */
function createPlansHandlers(shared) {
  const {
    plansStore,
    plansCreateFromText,
    deps
  } = shared;

  return {
    plan_create: async (a, ctx) => {
        if (!plansCreateFromText) return { error: '计划 API 不可用' };
        const todoText =
          Array.isArray(a.todos) && a.todos.length
            ? `\n\nTODO：\n${a.todos.map((t, i) => `${i + 1}. ${String(t || '').trim()}`).join('\n')}`
            : '';
        const r = await plansCreateFromText({
          // text 只服务「缺结构化信息时的 LLM 解析」与空描述校验：prompt 就是任务的完整说明，可作兜底
          text: `${a.description || a.text || a.prompt || ''}${todoText}`,
          skillIds: a.skillIds || [],
          // 结构化优先：模型直接给出 rrule/onceAt/goal 时免 LLM 解析
          structured: {
            name: a.name,
            rrule: a.rrule,
            onceAt: a.onceAt,
            prompt: a.prompt,
            todos: a.todos,
            skillIds: a.skillIds,
            // 目标型：{ checks: [...], cwd } —— 检查清单是它唯一的验收面（不解析提示词）
            goal: a.goal,
            // 计划工作空间：不填 = 跟随执行时当前工作空间
            workspace: a.workspace
          },
          // 计划绑定本次运行的路由：定时执行（无 Renderer）据此自洽解析模型配置
          modelRoute: ctx && ctx.modelRoute ? ctx.modelRoute : undefined,
          model: ctx && ctx.model ? ctx.model : undefined,
          // 定时型默认投递到「发起这次对话的会话」；目标型在 parser 里改投专用会话
          sessionId: ctx && ctx.sessionId ? ctx.sessionId : undefined
        });
        const goalChecksDeclared =
          r.plan.trigger === 'goal' && r.plan.goal && Array.isArray(r.plan.goal.checks)
            ? r.plan.goal.checks.map((c) => c && c.command).filter(Boolean)
            : [];
        return {
          ok: true,
          plan: r.plan,
          message:
            r.plan.trigger === 'goal'
              ? `已创建目标型计划「${r.plan.name}」：` +
                (goalChecksDeclared.length
                  ? `验收检查 ${goalChecksDeclared.map((c) => `「${c}」`).join('、')}。`
                  : '未声明检查（未验证模式：完成申请不会被代码核对）。') +
                '它会在后台一轮轮自动跑，跑到申请完成或预算用完为止 —— 别在这里等结果，' +
                '需要看进度或停掉时用 plan_list / plan_run / plan_delete。'
              : `已创建计划「${r.plan.name}」`
        };
    },
    plan_list: async (a, ctx) => {
        if (!plansStore) return { error: '计划 API 不可用' };
        const plans = plansStore.list();
        return {
          plans: (plans || []).map((p) => ({
            id: p.id,
            name: p.name,
            enabled: p.enabled,
            trigger: p.trigger || 'schedule',
            rrule: p.rrule,
            onceAt: p.onceAt,
            todos: Array.isArray(p.todos) ? p.todos : [],
            // 目标型：报状态时要说得清「跑了几轮、声明的检查是什么、最后一条事实、怎么收的尾」
            goal:
              p.trigger === 'goal'
                ? {
                    objective: (p.goal && p.goal.objective) || '',
                    checks: (p.goal && Array.isArray(p.goal.checks) ? p.goal.checks : []).map((c) => c && c.command),
                    cwd: (p.goal && p.goal.cwd) || ''
                  }
                : undefined,
            attempt: Number(p.attempt) || 0,
            outcome: p.outcome || null,
            lastCheck: Array.isArray(p.evidence) && p.evidence.length
              ? {
                  command: p.evidence[p.evidence.length - 1].command,
                  ok: !!p.evidence[p.evidence.length - 1].ok,
                  exitCode: p.evidence[p.evidence.length - 1].exitCode,
                  at: p.evidence[p.evidence.length - 1].at
                }
              : null,
            // 计划绑定的模型与路由（只存路由不存 key）：便于判断到点会用哪个模型执行
            model: p.model || '',
            modelRoute: p.modelRoute || '',
            sessionId: p.deliver?.sessionId,
            // 计划绑定的工作空间（空 = 跟随当前工作空间）
            workspace: p.workspace || '',
            lastRunAt: p.lastRunAt
          }))
        };
    },
    plan_delete: async (a, ctx) => {
        if (!plansStore) return { error: '计划 API 不可用' };
        plansStore.delete(a.id);
        return { ok: true, deleted: a.id };
    },
    plan_run: async (a, ctx) => {
        // 与 IPC plans:run-now 同一条路（scheduler.runNow → 收尾 → reload），不另写一份调度逻辑。
        const scheduler = typeof deps.getPlansScheduler === 'function' ? deps.getPlansScheduler() : null;
        if (!scheduler || !plansStore) return { ok: false, error: '计划调度未就绪', errorCode: 'PLANS_UNAVAILABLE' };
        const id = String(a.id || '').trim();
        if (!id) return { ok: false, error: 'plan_run 需要 id', errorCode: 'MISSING_ARG' };
        const plan = plansStore.get(id);
        if (!plan) return { ok: false, error: `没有这个计划：${id}`, errorCode: 'PLAN_NOT_FOUND' };
        // 触发即返回：`runNow` 是一整段嵌套运行（多轮 LLM + 工具），await 它等于把这次对话轮
        // 挂在另一个 run 上 —— 那边任何一个工具卡住，这边就一直显示「思考中…」直到看门狗收尾
        // （2026-11-04：目标型计划里一个工具挂住，对话轮一起冻住，只剩 RUN_STALL 可看）。
        // 结果本来就落在计划绑定的会话，返回说明也写着「不要在这里等」，所以这里只负责触发。
        Promise.resolve()
          .then(() => scheduler.runNow(id))
          .catch((err) => {
            const failed = { ok: false, error: String((err && err.message) || err) };
            if (typeof deps.finishPlanRun === 'function') {
              deps.finishPlanRun(plan, failed).catch(() => {});
            }
          })
          .finally(() => {
            try {
              scheduler.reload();
            } catch {
              // ignore
            }
          });
        return {
          ok: true,
          triggered: true,
          planId: id,
          name: plan.name,
          note: '已触发一次执行：结果会出现在该计划绑定的会话里，不要在这里等；要看跑没跑完就 plan_list 查该计划状态'
        };
    },
    plan_cancel: async (a, ctx) => {
        const cancelPlanRun = typeof deps.cancelPlanRun === 'function' ? deps.cancelPlanRun : null;
        if (!cancelPlanRun) return { ok: false, error: '计划调度未就绪', errorCode: 'PLANS_UNAVAILABLE' };
        const id = String(a.id || '').trim();
        if (!id) return { ok: false, error: 'plan_cancel 需要 id', errorCode: 'MISSING_ARG' };
        const r = cancelPlanRun(id);
        return { ok: !!(r && r.ok !== false), planId: id, result: r };
    }
  };
}

module.exports = { createPlansHandlers };
