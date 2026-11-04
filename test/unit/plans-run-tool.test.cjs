'use strict';

/**
 * `plan_run` 的**唯一契约**：触发即返回，不等这次运行跑完。
 *
 * 为什么值得一条测试（2026-11-04 现场）：`runNow` 是一整段嵌套 agent 运行，
 * 一旦 `await` 它，计划那一侧的任一工具挂住就会让**发起的对话轮**一直是「思考中…」，
 * 直到工具看门狗收尾 —— 用户看到的是「聊天卡死」，日志里只有 RUN_STALL。
 *
 * 断言顺序即语义顺序：工具先返回 `triggered`，收尾（`finishPlanRun` / `reload`）
 * 发生在后台，且失败也只记在计划自己身上，不回头打断对话轮。
 */

const { createMainToolBridge } = require('../../src/agent/tool-bridge-main');

/** 够 plan_run 用：只被 get() 读一次计划名 */
function fakePlansStore(plan) {
  return {
    get: (id) => (id === plan.id ? plan : null),
    list: () => [plan]
  };
}

function bridgeWith(scheduler, plan) {
  return createMainToolBridge({
    plansStore: fakePlansStore(plan),
    getPlansScheduler: () => scheduler
  });
}

const PLAN = { id: 'plan-1', name: '目标型测试计划', trigger: 'goal' };

describe('plan_run 触发即返回', () => {
  test('runNow 永不 resolve 也不阻塞调用方', async () => {
    const reloads = [];
    const scheduler = {
      runNow: () => new Promise(() => {}),
      reload: () => reloads.push(Date.now())
    };
    const bridge = bridgeWith(scheduler, PLAN);

    const raced = await Promise.race([
      bridge.executeAgentTool('plan_run', { id: PLAN.id }, {}),
      new Promise((resolve) => setTimeout(() => resolve('TIMEOUT'), 500))
    ]);

    expect(raced).not.toBe('TIMEOUT');
    expect(raced.ok).toBe(true);
    expect(raced.triggered).toBe(true);
    expect(raced.planId).toBe(PLAN.id);
    // 结果不再回灌给对话轮：说明里指路 plan_list
    expect(String(raced.note)).toContain('plan_list');
    expect(raced.result).toBeUndefined();
  });

  test('runNow 抛错：记到计划上，不把异常甩回对话轮', async () => {
    const finished = [];
    const scheduler = {
      runNow: async () => {
        throw new Error('模型不可用');
      },
      reload: () => {}
    };
    const bridge = createMainToolBridge({
      plansStore: fakePlansStore(PLAN),
      getPlansScheduler: () => scheduler,
      finishPlanRun: async (plan, result) => {
        finished.push({ planId: plan.id, result });
      }
    });

    const out = await bridge.executeAgentTool('plan_run', { id: PLAN.id }, {});
    expect(out.ok).toBe(true);
    expect(out.triggered).toBe(true);

    // 后台收尾：给一个宏任务窗口
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(finished).toHaveLength(1);
    expect(finished[0].planId).toBe(PLAN.id);
    expect(finished[0].result.ok).toBe(false);
    expect(finished[0].result.error).toContain('模型不可用');
  });

  test('计划不存在 / 调度未就绪仍是结构化错误', async () => {
    const scheduler = { runNow: () => new Promise(() => {}), reload: () => {} };
    const bridge = bridgeWith(scheduler, PLAN);

    const missing = await bridge.executeAgentTool('plan_run', { id: 'nope' }, {});
    expect(missing.ok).toBe(false);
    expect(missing.errorCode).toBe('PLAN_NOT_FOUND');

    const noScheduler = createMainToolBridge({
      plansStore: fakePlansStore(PLAN),
      getPlansScheduler: () => null
    });
    const unavailable = await noScheduler.executeAgentTool('plan_run', { id: PLAN.id }, {});
    expect(unavailable.ok).toBe(false);
    expect(unavailable.errorCode).toBe('PLANS_UNAVAILABLE');
  });

  test('plan_run / plan_cancel 不进 workspace 串行队列（否则与嵌套运行互锁）', () => {
    const { MUTATING_TOOL_NAMES } = require('../../src/agent/guardrails-shared');
    // 写 plans.json 的两个仍然是写类
    expect(MUTATING_TOOL_NAMES.has('plan_create')).toBe(true);
    expect(MUTATING_TOOL_NAMES.has('plan_delete')).toBe(true);
    // 触发/中止一次运行不是「写这个工作空间」：占住槽位去等嵌套运行，
    // 嵌套运行的 fs_edit 又在等同一槽位 = 死锁（MUTATE_QUEUE_STALL 强开才解开）
    expect(MUTATING_TOOL_NAMES.has('plan_run')).toBe(false);
    expect(MUTATING_TOOL_NAMES.has('plan_cancel')).toBe(false);
  });
});
