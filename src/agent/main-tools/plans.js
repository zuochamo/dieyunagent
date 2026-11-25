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
  const { plansStore, plansCreateFromText, userDataPath, deps } = shared;
  const { changeReceipt, fingerprintJson } = require('../change-receipt');
  // 「接下来会怎么跑」的事实（下一次 / 间隔 / 每日次数）：解析口径只在 rrule-next 一处
  const { scheduleFacts } = require('../../plans/rrule-next');

  /** 计划重新上钟的唯一动作（`scheduler.reload` 会 disarm + 重新按最新规则上钟）。 */
  function reloadScheduler() {
    const scheduler = typeof deps.getPlansScheduler === 'function' ? deps.getPlansScheduler() : null;
    if (!scheduler || typeof scheduler.reload !== 'function') return false;
    try {
      scheduler.reload();
      return true;
    } catch {
      return false;
    }
  }

  return {
    plan_create: async (a, ctx) => {
        if (!plansCreateFromText) return { error: '计划 API 不可用' };
        const todoText =
          Array.isArray(a.todos) && a.todos.length
            ? `\n\nTODO：\n${a.todos.map((t, i) => `${i + 1}. ${String(t || '').trim()}`).join('\n')}`
            : '';
        let r;
        try {
          r = await plansCreateFromText({
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
        } catch (e) {
          const code = (e && e.code) || 'PLAN_CREATE_FAILED';
          return {
            ok: false,
            error: String((e && e.message) || e || '创建计划失败'),
            errorCode: code,
            retryable: false,
            // 条数上限是「机制上限」不是错误操作：给一句能照做的下一步，别让它反复重试
            ...(code === 'PLANS_LIMIT'
              ? { suggestedFix: '先用 plan_list 看现有计划：不再需要的 plan_delete，暂时不跑的先 plan_set_enabled(false)' }
              : {})
          };
        }
        const goalChecksDeclared =
          r.plan.trigger === 'goal' && r.plan.goal && Array.isArray(r.plan.goal.checks)
            ? r.plan.goal.checks.map((c) => c && c.command).filter(Boolean)
            : [];
        return {
          ok: true,
          plan: r.plan,
          // 频次事实：让模型/用户在「先看一眼成本」时不用自己算 rrule
          schedule: scheduleFacts(r.plan),
          change: changeReceipt(userDataPath, {
            target: `plan:${r.plan.id}`,
            after: fingerprintJson(r.plan),
            effectiveFrom: 'immediate',
            verifyWith: 'plan_list'
          }),
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
        const id = String((a && a.id) || '').trim();
        const before = id ? plansStore.get(id) : null;
        plansStore.delete(id);
        reloadScheduler();
        return {
          ok: true,
          deleted: id,
          change: changeReceipt(userDataPath, {
            target: `plan:${id}`,
            before: before ? fingerprintJson(before) : null,
            effectiveFrom: 'immediate',
            verifyWith: 'plan_list'
          })
        };
    },
    plan_update: async (a, ctx) => {
        if (!plansStore) {
          return { ok: false, error: '计划 API 不可用', errorCode: 'PLANS_UNAVAILABLE', retryable: true };
        }
        const id = String((a && a.id) || '').trim();
        if (!id) return { ok: false, error: 'plan_update 需要 id', errorCode: 'MISSING_ARG', retryable: false };
        const cur = plansStore.get(id);
        if (!cur) {
          return { ok: false, error: `没有这个计划：${id}`, errorCode: 'PLAN_NOT_FOUND', retryable: false };
        }
        /**
         * 「定时型 ↔ 目标型」不在这里切换：两者的验收面完全不同，换类型 = 换一条计划。
         * 硬切成半套（保留旧的 evidence、换掉 checks）会造出「验收事实对不上当前检查」的账本。
         */
        const wantsGoal = a && a.goal !== undefined;
        const wantsSchedule = a && (a.rrule !== undefined || a.onceAt !== undefined);
        if (wantsGoal && cur.trigger !== 'goal') {
          return {
            ok: false,
            error: '这条计划不是目标型：要改成目标型请 plan_delete 后重新 plan_create（验收面整条换）',
            errorCode: 'PLAN_MODE_FIXED',
            retryable: false
          };
        }
        if (wantsSchedule && cur.trigger === 'goal') {
          return {
            ok: false,
            error: '这条计划是目标型：目标型不吃 rrule/onceAt。要改成定时型请 plan_delete 后重新 plan_create',
            errorCode: 'PLAN_MODE_FIXED',
            retryable: false
          };
        }
        // 空闲触发的计划同样不看时间规则：收下 rrule 只会静默不生效（触发源是「静默够久」）
        if (wantsSchedule && cur.trigger === 'idle') {
          return {
            ok: false,
            error: '这条计划是「空闲触发」的：它不看 rrule/onceAt（触发源是静默够久）。要改成定时型请 plan_delete 后重新 plan_create',
            errorCode: 'PLAN_MODE_FIXED',
            retryable: false
          };
        }
        // 只覆盖「给了的字段」：normalizePlan 会把缺省字段填默认值，把 a 直接喂给 upsert 会冲掉没给的字段
        const patch = { ...cur };
        for (const key of ['name', 'prompt', 'description', 'rrule', 'onceAt', 'skillIds', 'todos', 'workspace']) {
          if (a && a[key] !== undefined) patch[key] = a[key];
        }
        // 目标验收面是整体替换（objective + checks 必填），但 `cwd` 是可选的：
        // 没给就沿用旧值，别让「只换一条检查命令」把工作目录悄悄清掉
        if (a && a.goal !== undefined) {
          patch.goal = { ...(cur.goal || {}), ...a.goal };
        }
        let saved = null;
        try {
          saved = plansStore.upsert(patch);
        } catch (e) {
          return {
            ok: false,
            error: String((e && e.message) || e || '更新计划失败'),
            errorCode: (e && e.code) || 'PLAN_UPDATE_FAILED',
            retryable: false
          };
        }
        reloadScheduler();
        return {
          ok: true,
          plan: saved,
          schedule: scheduleFacts(saved),
          change: changeReceipt(userDataPath, {
            target: `plan:${id}`,
            before: fingerprintJson(cur),
            after: fingerprintJson(saved),
            effectiveFrom: 'immediate',
            verifyWith: 'plan_list'
          }),
          note: '已按新规则重新上钟。运行态（轮次 / 检查事实 / 收尾结论）没有被改动。'
        };
    },
    plan_set_enabled: async (a, ctx) => {
        if (!plansStore) {
          return { ok: false, error: '计划 API 不可用', errorCode: 'PLANS_UNAVAILABLE', retryable: true };
        }
        const id = String((a && a.id) || '').trim();
        if (!id) return { ok: false, error: 'plan_set_enabled 需要 id', errorCode: 'MISSING_ARG', retryable: false };
        const cur = plansStore.get(id);
        if (!cur) {
          return { ok: false, error: `没有这个计划：${id}`, errorCode: 'PLAN_NOT_FOUND', retryable: false };
        }
        const enabled = a && a.enabled !== false;
        plansStore.setEnabled(id, enabled);
        reloadScheduler();
        return {
          ok: true,
          id,
          enabled,
          change: changeReceipt(userDataPath, {
            target: `plan:${id}`,
            before: fingerprintJson({ enabled: cur.enabled !== false }),
            after: fingerprintJson({ enabled }),
            effectiveFrom: 'immediate',
            verifyWith: 'plan_list'
          }),
          note: enabled
            ? '已启用：到点（或下个空闲窗口）会重新触发，跑过的轮次与检查事实都还在。'
            : '已停用：不再触发，但计划、跑过的轮次与检查事实都保留 —— 想恢复就 enabled=true。'
        };
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
