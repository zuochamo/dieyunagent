'use strict';

/**
 * 目标：goal_*（计划目标与会话目标共用同一份事实与核对）。不在这里判完成 —— 核对是 plans/goal-run.js#judgeGoalFinish 的事，这里只做「取上下文 → 调它 → 把事实回给模型」。
 *
 * 从 `tool-bridge-main.js` 的 1036 行 switch 里拆出（曾零直测）：现在由
 * `scripts/test-tool-bridge-handlers.cjs` 覆盖参数翻译与形状转换。
 * 依赖一律由 `shared` 传入（不 require），所以本文件能被单测直接装进沙箱。
 *
 * @param {object} shared 工具桥闭包里的依赖与取值器（见 main-tools/index.js）
 */
function createGoalsHandlers(shared) {
  const {
    getAgentLimits,
    userDataPath,
    plansStore,
    gateway,
    sessionGoalStore,
    judgeGoalFinish,
    goalChecks,
    runGoalCheck,
    factLine
  } = shared;

  /**
   * 目标解析（**唯一入口**）：目标型计划轮（`ctx.planId`）优先，否则当前会话的会话目标。
   *
   * 两套触发（cron 计划 / 人说话）共用同一份事实、核对与措辞（`plans/goal-run.js`），
   * 差别只有「事实存哪儿」：计划写 plansStore，会话写 session_goals 表。
   * 返回的 `plan` 是可直接喂给 goal-run 纯函数的对象（两者形状同构）。
   */
  async function resolveGoalTarget(ctx = {}) {
    const planId = String((ctx && ctx.planId) || '').trim();
    if (planId) {
      if (!plansStore) {
        return { error: { ok: false, error: '计划 API 不可用', errorCode: 'PLANS_UNAVAILABLE' } };
      }
      const plan = plansStore.get(planId);
      if (!plan) {
        return { error: { ok: false, error: `没有这个计划：${planId}`, errorCode: 'PLAN_NOT_FOUND' } };
      }
      return { kind: 'plan', planId, plan };
    }
    if (!gateway) {
      return { error: { ok: false, error: 'Gateway 未就绪', errorCode: 'GATEWAY_UNAVAILABLE' } };
    }
    const sessionId = String((ctx && ctx.sessionId) || '').trim();
    if (!sessionId) {
      return {
        error: {
          ok: false,
          error: '目标需要绑定一个会话：当前没有会话上下文',
          errorCode: 'NO_SESSION',
          retryable: false
        }
      };
    }
    const goal = await sessionGoalStore.loadGoal({ invokeRpc: gateway.invokeRpc, sessionId });
    if (goal && goal.outcome) {
      // 已收尾的目标是「结过账的账本」：往上写清单 / 补跑检查 / 再次收尾，都会让面板出现
      // 「已完成」配一条新 objective 的怪状态（2026-11-07 现场：面板说已完成，实际在做别的事）。
      // 一个断言点管住 goal_check / goal_update / goal_finish 三条路。
      return {
        error: {
          ok: false,
          error:
            `这个目标已经收尾（${goal.outcome}）：不再接受 goal_check / goal_update / goal_finish。` +
            '要做新的事情先 goal_start 开一个新目标（已收尾的这条不会被复用）。',
          errorCode: 'GOAL_CLOSED',
          retryable: false
        }
      };
    }
    if (!goal) {
      return {
        error: {
          ok: false,
          // 这里**不能**再写「一次能答完就不用建」：模型走到这一步时已经决定要跑验收命令，
          // 是触发意图最强的时刻；同一轮内 goal_start → goal_check → goal_finish 是既有能力。
          error:
            '当前会话还没有目标。先 goal_start 建一个（objective 一句话说清什么算达成；没有验收命令时 checks 可留空），' +
            '本回合内就可以直接接着 goal_check 跑检查、goal_finish 收尾。',
          errorCode: 'NO_SESSION_GOAL',
          retryable: false
        }
      };
    }
    return { kind: 'session', sessionId, plan: goal };
  }

  /** 事实落库：计划 / 会话两条路，写入口各自唯一 */
  async function persistGoalFact(target, fact, keep) {
    if (target.kind === 'plan') {
      plansStore.pushEvidence(target.planId, fact, keep);
      return;
    }
    await sessionGoalStore.patchGoal({
      invokeRpc: gateway.invokeRpc,
      sessionId: target.sessionId,
      mutate: (goal) => {
        if (!goal) return undefined;
        sessionGoalStore.pushEvidence(goal, fact, keep);
        return goal;
      }
    });
  }
  return {
    goal_start: async (a, ctx) => {
        if (!gateway) return { ok: false, error: 'Gateway 未就绪', errorCode: 'GATEWAY_UNAVAILABLE' };
        // 计划型目标轮（`ctx.planId`）的验收面在「自动化」的计划里：这里再起一个会话目标，
        // 每轮注入块就会出现两条互相矛盾的「本轮目标」。
        if (String((ctx && ctx.planId) || '').trim()) {
          return {
            ok: false,
            error: '计划目标轮里不能再起会话目标：验收面在「自动化」的计划里',
            errorCode: 'PLAN_GOAL_READONLY',
            retryable: false
          };
        }
        const startSessionId = String((ctx && ctx.sessionId) || '').trim();
        if (!startSessionId) {
          return {
            ok: false,
            error: 'goal_start 需要会话上下文：目标总是挂在某个会话上',
            errorCode: 'NO_SESSION',
            retryable: false
          };
        }
        const started = await sessionGoalStore.startGoal({
          invokeRpc: gateway.invokeRpc,
          sessionId: startSessionId,
          draft: {
            objective: a.objective,
            checks: a.checks,
            todos: a.todos,
            cwd: a.cwd || (ctx && ctx.workspacePath) || ''
          }
        });
        if (!started.ok) {
          return { ok: false, error: started.error || '建目标失败', errorCode: 'GOAL_START_FAILED' };
        }
        const startedGoal = started.goal;
        if (started.unchanged) {
          // 单会话单目标：把现有目标回给模型，让它接着推进而不是每轮重开
          return {
            ok: true,
            created: false,
            existing: true,
            objective: startedGoal.goal.objective,
            attempt: startedGoal.attempt,
            todos: startedGoal.goal.todos,
            hint:
              '本会话已有进行中的目标（一个会话只有一个）：接着推进它，不要重复开。' +
              '确实换了目标就先 goal_finish(outcome=blocked) 收尾，再 goal_start。'
          };
        }
        return {
          ok: true,
          created: true,
          objective: startedGoal.goal.objective,
          checks: startedGoal.goal.checks.map((c) => c.command),
          todos: startedGoal.goal.todos,
          // 覆盖掉了一条没在跑的旧目标（已收尾 / 已暂停 / 预算尽）：旧账已随覆盖清掉。
          // 不拦（换个目标是正常诉求），但必须让模型看得见，否则账本静默归零。
          replaced: started.replaced || null,
          hint:
            (started.replaced
              ? `已替换上一条未在推进的目标「${String(started.replaced.objective).slice(0, 60)}」` +
                `（${started.replaced.outcome || started.replaced.status}，${Number(started.replaced.attempt) || 0} 轮，` +
                `${Number(started.replaced.evidenceCount) || 0} 条检查事实）：它的清单与事实已随替换清掉，必要时跟用户说一句。`
              : '') +
            '目标已建立。每轮结束会自动带着目标与检查事实再来一轮，直到 goal_finish 收尾或预算用尽。' +
            '推进中随时 goal_check 留事实、goal_update 更新清单。'
        };
    },
    goal_update: async (a, ctx) => {
        if (!gateway) return { ok: false, error: 'Gateway 未就绪', errorCode: 'GATEWAY_UNAVAILABLE' };
        const updateTarget = await resolveGoalTarget(ctx);
        if (updateTarget.error) return updateTarget.error;
        if (updateTarget.kind === 'plan') {
          return {
            ok: false,
            error: '计划目标的验收面在「自动化」的计划里有唯一定义，这里只更新会话目标的清单',
            errorCode: 'PLAN_GOAL_READONLY',
            retryable: false
          };
        }
        const updatedRes = await sessionGoalStore.patchGoal({
          invokeRpc: gateway.invokeRpc,
          sessionId: updateTarget.sessionId,
          mutate: (goal) => {
            if (!goal) return undefined;
            // 空 objective 不许覆盖：`loadGoal` 以「objective 为空」判定「没有目标」，
            // 写成空串会让目标从 prompt / 目标条 / 侧栏一起消失，而 evidence 还留在库里。
            if (a.objective != null && String(a.objective).trim()) {
              goal.goal.objective = String(a.objective).trim();
            }
            // 给什么整体替换什么（没给的字段保留）：saveGoal 会按唯一归一化点裁剪/校验
            if (Array.isArray(a.checks)) goal.goal.checks = a.checks;
            if (Array.isArray(a.todos)) goal.goal.todos = a.todos;
            return goal;
          }
        });
        if (!updatedRes.ok) {
          return { ok: false, error: updatedRes.error || '更新目标失败', errorCode: 'GOAL_UPDATE_FAILED' };
        }
        const updatedGoal = updatedRes.goal;
        return {
          ok: true,
          objective: updatedGoal && updatedGoal.goal && updatedGoal.goal.objective,
          todos: (updatedGoal && updatedGoal.goal && updatedGoal.goal.todos) || [],
          checks: ((updatedGoal && updatedGoal.goal && updatedGoal.goal.checks) || []).map((c) => c.command)
        };
    },
    goal_check: async (a, ctx) => {
        if (!gateway) return { ok: false, error: 'Gateway 未就绪', errorCode: 'GATEWAY_UNAVAILABLE' };
        const checkTarget = await resolveGoalTarget(ctx);
        if (checkTarget.error) return checkTarget.error;
        const goalLimits = getAgentLimits(userDataPath, ctx && ctx.contextTierId);
        const wantId = String(a.check_id || a.checkId || '').trim();
        const declared = goalChecks(checkTarget.plan);
        const picked = wantId
          ? declared.find((c) => c.id === wantId || c.command === wantId) || null
          : null;
        if (wantId && !picked) {
          return {
            ok: false,
            error: `没有这条声明检查：${wantId}`,
            errorCode: 'CHECK_NOT_FOUND',
            retryable: false,
            suggestedFix: declared.length
              ? `可用的 check_id：${declared.map((c) => c.id).join(' / ')}；也可以直接给 command`
              : '这个目标没有声明检查，直接给 command 一条能失败的命令'
          };
        }
        const goalFact = await runGoalCheck({
          gateway,
          plan: checkTarget.plan,
          command: picked ? picked.command : a.command,
          checkId: picked ? picked.id : '',
          cwd:
            (checkTarget.plan.goal && checkTarget.plan.goal.cwd) ||
            (ctx && ctx.workspacePath) ||
            '',
          limits: goalLimits,
          sessionId: (ctx && ctx.sessionId) || '',
          runId: ctx && ctx.runId,
          round: checkTarget.plan.attempt
        });
        await persistGoalFact(checkTarget, goalFact, goalLimits.goalEvidenceKeep);
        return {
          ok: true,
          passed: goalFact.ok,
          exitCode: goalFact.exitCode,
          note: goalFact.note,
          round: goalFact.round,
          fact: factLine(goalFact),
          tail: goalFact.tail,
          hint: goalFact.ok
            ? '这条检查通过并已记为事实；要收尾就调用 goal_finish(outcome=complete)'
            : '这条检查没通过，事实已记录：先修再重跑，别现在申请完成'
        };
    },
    goal_finish: async (a, ctx) => {
        const finishTarget = await resolveGoalTarget(ctx);
        if (finishTarget.error) return finishTarget.error;
        const outcome = String(a.outcome || '').trim() === 'blocked' ? 'blocked' : 'complete';
        // 只核对「主张与事实是否一致」：不够通过就打回并把事实回灌，判断继续归模型
        const verdict = judgeGoalFinish({ plan: finishTarget.plan, outcome });
        if (finishTarget.kind === 'plan') {
          plansStore.recordClaim(finishTarget.planId, {
            outcome,
            round: finishTarget.plan.attempt,
            accepted: verdict.accept,
            note: String(a.note || '')
          });
        } else if (gateway) {
          await sessionGoalStore.patchGoal({
            invokeRpc: gateway.invokeRpc,
            sessionId: finishTarget.sessionId,
            mutate: (goal) => {
              if (!goal) return undefined;
              sessionGoalStore.recordClaim(goal, {
                outcome,
                round: goal.attempt,
                accepted: verdict.accept,
                note: String(a.note || '')
              });
              if (verdict.accept) goal.outcome = outcome;
              return goal;
            }
          });
        }
        if (!verdict.accept) {
          return {
            ok: true,
            accepted: false,
            outcome,
            reason: verdict.reason,
            facts: verdict.facts,
            hint: '这次收尾申请没有事实支撑（已记录）：继续推进，用 goal_check 取新的事实再申请'
          };
        }
        if (finishTarget.kind === 'plan') plansStore.setOutcome(finishTarget.planId, outcome);
        return {
          ok: true,
          accepted: true,
          outcome,
          facts: verdict.facts,
          hint:
            outcome === 'complete'
              ? '已按完成收尾：本轮结束后不再续跑。把结论、证据出处与遗留项写给用户。'
              : '已记为阻塞：本轮结束后不再续跑。把确切卡点与需要人做什么写给用户。'
        };
    }
  };
}

module.exports = { createGoalsHandlers };
