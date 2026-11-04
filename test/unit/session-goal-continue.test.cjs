'use strict';

/**
 * 会话目标的**续跑判定**（`session-goal.judgeAfterTurn`）与停止/继续状态迁移。
 *
 * 断言的是判定与状态机，不是 UI：
 *   1. 一轮结束后判一次：没目标 / 已收尾 / 已暂停 → 不续跑（返回 null）；
 *   2. 轮次或墙钟预算用尽 → 不续跑，且状态落成 `stalled`（不是 complete —— 没做完就是没做完）；
 *   3. `paused` / `stalled` 只能由人恢复；`resumeGoal` 重置轮次预算但**不丢事实与清单**；
 *   4. attempt 的自增不在这里（一轮开始时自增一次），本函数只读数。
 */

const {
  startGoal,
  loadGoal,
  patchGoal,
  advanceAttempt,
  judgeAfterTurn,
  pauseGoal,
  resumeGoal,
  toPanelView
} = require('../../src/goals/session-goal');

const LIMITS = {
  goalMaxAttempts: 3,
  goalMaxWallMs: 60 * 60 * 1000,
  goalRetryBackoffMs: 60000,
  goalCheckTimeoutMs: 120000,
  goalEvidenceTailChars: 4000,
  goalEvidenceKeep: 20
};

/** 内存版 Gateway：目标 KV 就够（本判定不碰命令执行） */
function makeFakeGateway() {
  const blobs = new Map();
  return {
    blobs,
    invokeRpc: async (method, params = {}) => {
      const key = String(params.sessionId || '');
      if (method === 'memory.session_goal_get') return { goalJson: blobs.get(key) || null };
      if (method === 'memory.session_goal_put') {
        if (params.goalJson == null) blobs.delete(key);
        else blobs.set(key, params.goalJson);
        return { ok: true };
      }
      throw new Error(`unexpected rpc: ${method}`);
    }
  };
}

function ctx(sessionId = 's1') {
  const gateway = makeFakeGateway();
  return { gateway, args: { invokeRpc: gateway.invokeRpc, sessionId } };
}

async function startSimple(args, objective = '让 npm test 全绿') {
  return startGoal({
    ...args,
    draft: {
      objective,
      checks: [{ id: 'unit', command: 'npm test' }],
      todos: [{ text: '改实现' }, { text: '补测试' }]
    }
  });
}

describe('session-goal：续跑判定', () => {
  test('没有目标 / 已收尾 / 已暂停 → 不续跑（返回 null）', async () => {
    const { args } = ctx('s1');
    expect(await judgeAfterTurn({ ...args, limits: LIMITS })).toBeNull();

    await startSimple(args);
    await patchGoal({
      ...args,
      mutate: (goal) => {
        goal.outcome = 'complete';
        return goal;
      }
    });
    expect(await judgeAfterTurn({ ...args, limits: LIMITS })).toBeNull();

    await startSimple(args, '第二件事');
    await pauseGoal(args);
    expect(await judgeAfterTurn({ ...args, limits: LIMITS })).toBeNull();
  });

  test('进行中且预算充足 → cont=true，带上轮次与上限（不碰状态）', async () => {
    const { args } = ctx('s2');
    await startSimple(args);
    await patchGoal({
      ...args,
      mutate: (goal) => {
        advanceAttempt(goal);
        advanceAttempt(goal);
        return goal;
      }
    });

    const decision = await judgeAfterTurn({ ...args, limits: LIMITS });
    expect(decision).toEqual({ active: true, cont: true, stop: null, attempt: 2, max: 3 });
    expect((await loadGoal(args)).status).toBe('active');
  });

  test('轮次用尽 → 不续跑，落 stalled（不收尾）', async () => {
    const { args } = ctx('s3');
    await startSimple(args);
    await patchGoal({
      ...args,
      mutate: (goal) => {
        for (let i = 0; i < LIMITS.goalMaxAttempts; i += 1) advanceAttempt(goal);
        return goal;
      }
    });

    const decision = await judgeAfterTurn({ ...args, limits: LIMITS });
    expect(decision).toEqual({ active: true, cont: false, stop: 'attempts', attempt: 3, max: 3 });
    const after = await loadGoal(args);
    expect(after.status).toBe('stalled');
    // 预算用尽不是完成：outcome 必须还是空的
    expect(after.outcome).toBeNull();
  });

  test('墙钟用尽 → 不续跑，落 stalled', async () => {
    const { args } = ctx('s4');
    await startSimple(args);
    await patchGoal({
      ...args,
      mutate: (goal) => {
        advanceAttempt(goal);
        // 起点挪到两小时前，超出 1 小时预算
        goal.attemptStartedAt = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
        return goal;
      }
    });

    const decision = await judgeAfterTurn({ ...args, limits: LIMITS });
    expect(decision.cont).toBe(false);
    expect(decision.stop).toBe('budget');
    expect((await loadGoal(args)).status).toBe('stalled');
  });

  test('goal_finish 已收尾（complete）时判定不再续跑，状态不被改写', async () => {
    const { args } = ctx('s5');
    await startSimple(args);
    await patchGoal({
      ...args,
      mutate: (goal) => {
        advanceAttempt(goal);
        goal.outcome = 'complete';
        return goal;
      }
    });

    expect(await judgeAfterTurn({ ...args, limits: LIMITS })).toBeNull();
    const after = await loadGoal(args);
    expect(after.status).toBe('active');
    expect(after.outcome).toBe('complete');
  });

  test('暂停 / 继续：resume 重置轮次预算但保留事实与清单', async () => {
    const { args } = ctx('s6');
    await startSimple(args);
    await patchGoal({
      ...args,
      mutate: (goal) => {
        advanceAttempt(goal);
        advanceAttempt(goal);
        goal.status = 'stalled';
        goal.evidence = [
          { at: new Date().toISOString(), round: 1, command: 'npm test', ok: false, exitCode: 1 }
        ];
        return goal;
      }
    });

    const resumed = await resumeGoal(args);
    expect(resumed.ok).toBe(true);
    expect(resumed.goal.status).toBe('active');
    expect(resumed.goal.attempt).toBe(0);
    // 事实与清单是下一轮的判断依据，重置预算不能丢
    expect(resumed.goal.evidence).toHaveLength(1);
    expect(resumed.goal.goal.todos).toHaveLength(2);

    const view = toPanelView({ goal: await loadGoal(args), limits: LIMITS });
    expect(view.status).toBe('active');
    expect(view.attempt).toBe(0);
    expect(view.evidence).toHaveLength(1);

    // 收尾过的目标不给「继续」：没有可推进的东西了
    await patchGoal({
      ...args,
      mutate: (goal) => {
        goal.outcome = 'complete';
        return goal;
      }
    });
    expect((await resumeGoal(args)).unchanged).toBe(true);
  });
});
