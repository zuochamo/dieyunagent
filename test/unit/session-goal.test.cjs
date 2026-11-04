'use strict';

/**
 * 会话级目标对象（session_goals）：存取、单会话单目标、每轮注入块、工具端到端。
 *
 * 断言的是**通用契约**（与 plans-goal.test.cjs 同一条纪律）：
 *   1. 目标只是一个对象：objective + 声明检查 + 给人看的清单，代码不猜「够不够」；
 *   2. 事实只来自 goal_check 的命令退出码，「完成」必须与事实一致；
 *   3. 没有目标的会话，注入块与工具面都不变（普通聊天零成本）。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  loadGoal,
  saveGoal,
  patchGoal,
  startGoal,
  isActiveGoal,
  advanceAttempt,
  pushEvidence,
  toPanelView,
  normalizeSessionGoal
} = require('../../src/goals/session-goal');
const { renderSessionGoalBlock, normalizeGoal } = require('../../src/plans/goal-run');
const { validateToolArgs } = require('../../src/agent/tool-validate');
const { createMainToolBridge } = require('../../src/agent/tool-bridge-main');

const LIMITS = {
  goalMaxAttempts: 4,
  goalMaxWallMs: 60 * 60 * 1000,
  goalRetryBackoffMs: 60000,
  goalCheckTimeoutMs: 120000,
  goalEvidenceTailChars: 40,
  goalEvidenceKeep: 3
};

/** 内存版 Gateway：只有目标 KV + host.exec 两条 RPC，够覆盖全部目标工具 */
function makeFakeGateway(opts = {}) {
  const blobs = new Map();
  const execResults = Array.isArray(opts.execResults) ? opts.execResults.slice() : null;
  const gateway = {
    blobs,
    execCalls: [],
    get blob() {
      return blobs.get('s1') || null;
    },
    set blob(v) {
      blobs.set('s1', v);
    },
    invokeRpc: async (method, params = {}) => {
      const key = String(params.sessionId || '');
      if (method === 'memory.session_goal_get') return { goalJson: blobs.get(key) || null };
      if (method === 'memory.session_goal_put') {
        if (params.goalJson == null) blobs.delete(key);
        else blobs.set(key, params.goalJson);
        return { ok: true };
      }
      if (method === 'host.exec') {
        gateway.execCalls.push(params);
        const next = execResults ? execResults.shift() : { code: 0, stdout: 'ok' };
        return next || { code: 0, stdout: 'ok' };
      }
      throw new Error(`unexpected rpc: ${method}`);
    }
  };
  return gateway;
}

function bridgeFor(gateway) {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'dieyun-session-goal-'));
  return createMainToolBridge({ gateway, userDataPath });
}

describe('goals/session-goal：存取与单会话单目标', () => {
  test('start → load → patch → delete', async () => {
    const gateway = makeFakeGateway();
    const args = { invokeRpc: gateway.invokeRpc, sessionId: 's1' };

    const started = await startGoal({
      ...args,
      draft: {
        objective: '让 npm test 全绿',
        checks: [{ id: 'unit', command: 'npm test' }],
        todos: [{ text: '改实现' }, { text: '补测试', done: true }]
      }
    });
    expect(started.ok).toBe(true);
    expect(started.unchanged).toBeUndefined();
    expect(started.goal.goal.objective).toBe('让 npm test 全绿');
    expect(started.goal.goal.checks).toHaveLength(1);
    expect(started.goal.goal.todos).toHaveLength(2);
    expect(isActiveGoal(started.goal)).toBe(true);
    expect(started.goal.cwd || started.goal.goal.cwd).toBe('');

    const loaded = await loadGoal(args);
    expect(loaded.goal.objective).toBe('让 npm test 全绿');

    // 已有进行中的目标：再开一次是「返回现有」，不是覆盖
    const again = await startGoal({ ...args, draft: { objective: '另一个目标' } });
    expect(again.unchanged).toBe(true);
    expect(again.goal.goal.objective).toBe('让 npm test 全绿');

    await saveGoal({ ...args, goal: null });
    expect(await loadGoal(args)).toBeNull();
  });

  test('收尾后允许开新目标；暂停的目标不算「进行中」', async () => {
    const gateway = makeFakeGateway();
    const args = { invokeRpc: gateway.invokeRpc, sessionId: 's2' };
    await startGoal({ ...args, draft: { objective: '第一件事' } });

    await patchGoal({
      ...args,
      mutate: (goal) => {
        goal.outcome = 'complete';
        return goal;
      }
    });
    expect(isActiveGoal(await loadGoal(args))).toBe(false);

    const next = await startGoal({ ...args, draft: { objective: '第二件事' } });
    expect(next.unchanged).toBeUndefined();
    expect(next.goal.goal.objective).toBe('第二件事');
    expect(next.goal.outcome).toBeNull();

    await patchGoal({
      ...args,
      mutate: (goal) => {
        goal.status = 'paused';
        return goal;
      }
    });
    expect(isActiveGoal(await loadGoal(args))).toBe(false);
  });

  test('损坏的 JSON 当「没有目标」处理，不让整轮 prompt 组装失败', async () => {
    const gateway = makeFakeGateway();
    gateway.blobs.set('s3', '{ 这不是 JSON');
    const logged = [];
    expect(await loadGoal({ invokeRpc: gateway.invokeRpc, sessionId: 's3', log: (m) => logged.push(m) })).toBeNull();
    expect(logged).toHaveLength(1);
  });

  test('空 objective 的目标不成立（注入不出任何东西）', async () => {
    const gateway = makeFakeGateway();
    const res = await startGoal({
      invokeRpc: gateway.invokeRpc,
      sessionId: 's4',
      draft: { objective: '   ' }
    });
    expect(res.unchanged).toBe(true);
    expect(res.goal).toBeNull();
  });
});

describe('goals/session-goal：事实、轮次与面板视图', () => {
  test('轮次自增 + 事实累积（保留条数来自 limits）', () => {
    let goal = normalizeSessionGoal({
      goal: { objective: '做一件事', checks: ['npm test'], todos: ['a', 'b'] }
    });
    advanceAttempt(goal);
    advanceAttempt(goal);
    expect(goal.attempt).toBe(2);
    expect(typeof goal.attemptStartedAt).toBe('string');

    for (let i = 1; i <= 5; i += 1) {
      pushEvidence(goal, { command: 'npm test', ok: i === 5, exitCode: i === 5 ? 0 : 1, round: i }, LIMITS.goalEvidenceKeep);
    }
    expect(goal.evidence).toHaveLength(LIMITS.goalEvidenceKeep);
    expect(goal.evidence[goal.evidence.length - 1].ok).toBe(true);
  });

  test('面板视图：进度按清单算，没有清单就只有 0/1', () => {
    const withTodos = normalizeSessionGoal({
      goal: { objective: '推进', todos: [{ text: 'a', done: true }, { text: 'b' }] }
    });
    const view = toPanelView({ goal: withTodos, limits: LIMITS, evidenceShown: 5 });
    expect(view.todosDone).toBe(1);
    expect(view.todosTotal).toBe(2);
    expect(view.progress).toBeCloseTo(0.5, 6);
    expect(view.maxAttempts).toBe(LIMITS.goalMaxAttempts);
    expect(view.unverified).toBe(true);

    const noTodos = normalizeSessionGoal({ goal: { objective: '没清单' } });
    expect(toPanelView({ goal: noTodos, limits: LIMITS }).progress).toBe(0);
    noTodos.outcome = 'complete';
    expect(toPanelView({ goal: noTodos, limits: LIMITS }).progress).toBe(1);

    expect(toPanelView({ goal: null, limits: LIMITS })).toBeNull();
  });

  test('面板视图：检查事实按声明的检查聚合（面板与目标条共用这一份）', () => {
    const goal = normalizeSessionGoal({
      goal: {
        objective: '让测试全绿',
        checks: [
          { id: 'unit', command: 'npm test' },
          { id: 'lint', command: 'npm run lint' },
          { id: 'build', command: 'npm run build' }
        ]
      },
      evidence: [
        { round: 1, command: 'npm test', ok: false, exitCode: 1 },
        { round: 2, command: 'npm test', ok: true, exitCode: 0 },
        { round: 2, command: 'npm run lint', ok: false, exitCode: 2 }
      ]
    });
    const view = toPanelView({ goal, limits: LIMITS });
    const byId = Object.fromEntries(view.checks.map((c) => [c.id, c]));
    expect(byId.unit.runs).toBe(2);
    expect(byId.unit.ok).toBe(true);
    expect(byId.unit.exitCode).toBe(0);
    expect(byId.unit.round).toBe(2);
    expect(byId.lint.runs).toBe(1);
    expect(byId.lint.ok).toBe(false);
    // 声明了但从没跑过：三态里的「未验证」，不是「失败」（说成失败会冤枉模型）
    expect(byId.build.runs).toBe(0);
    expect(byId.build.ok).toBeNull();
    expect(byId.build.at).toBeNull();
    // 目标条上的「最近一条事实」仍是最近落盘的那条，与按检查聚合是两件事
    expect(view.lastFact.command).toBe('npm run lint');
  });
});

describe('会话目标的每轮注入块', () => {
  function goalWith(extra = {}) {
    return {
      ...normalizeSessionGoal({
        goal: {
          objective: '让 npm test 全绿',
          checks: [{ command: 'npm test' }],
          todos: [{ text: '改实现' }, { text: '补测试', done: true }]
        }
      }),
      ...extra
    };
  }

  test('没有目标 → 空串（普通会话 prompt 一个字节都不变）', () => {
    expect(renderSessionGoalBlock({ goal: null, limits: LIMITS })).toBe('');
    expect(renderSessionGoalBlock({ limits: LIMITS })).toBe('');
  });

  test('进行中的目标：目标 + 进度 + 事实 + 「不要停下来问」', () => {
    const goal = goalWith();
    advanceAttempt(goal);
    pushEvidence(goal, { command: 'npm test', ok: false, exitCode: 1, round: 1, note: 'fail' }, 3);
    const text = renderSessionGoalBlock({ goal, limits: LIMITS });
    expect(text).toContain('【当前目标】让 npm test 全绿');
    expect(text).toContain('进度：1/2 项已完成');
    expect(text).toContain('未完成：改实现');
    expect(text).toContain('第 1/4 轮');
    expect(text).toContain('exit 1');
    expect(text).toContain('不要停下来问用户');
    // 不写结论：措辞里不出现「已完成/未完成」的判断句给模型照抄
    expect(text).not.toContain('目标已完成');
  });

  test('三种终态各有各的措辞：已收尾 / 预算用尽 / 已暂停', () => {
    const done = goalWith({ outcome: 'complete' });
    expect(renderSessionGoalBlock({ goal: done, limits: LIMITS })).toContain('已收尾');

    const stalled = goalWith({ status: 'stalled' });
    const stalledText = renderSessionGoalBlock({ goal: stalled, limits: LIMITS });
    expect(stalledText).toContain('预算已用尽');
    expect(stalledText).toContain('不要假装完成');

    const paused = goalWith({ status: 'paused' });
    expect(renderSessionGoalBlock({ goal: paused, limits: LIMITS })).toContain('已暂停');
  });
});

describe('目标形状归一化：计划与会话共用一份', () => {
  test('objective / checks / todos 同一条规则（含空值裁剪）', () => {
    const g = normalizeGoal({
      objective: '  目标  ',
      checks: ['npm test', { id: 'b', command: '  npm run build ' }, { command: '   ' }],
      todos: ['第一项', { text: '第二项', done: true }, { text: '' }],
      cwd: '   '
    });
    expect(g.objective).toBe('目标');
    expect(g.checks.map((c) => c.command)).toEqual(['npm test', 'npm run build']);
    expect(g.todos).toEqual([
      { text: '第一项', done: false },
      { text: '第二项', done: true }
    ]);
    expect(g.cwd).toBe('');
  });
});

describe('目标工具的入参校验', () => {
  test('goal_start 必须有 objective', () => {
    const r = validateToolArgs('goal_start', {});
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe('MISSING_ARG');
    expect(validateToolArgs('goal_start', { objective: '做一件事' }).ok).toBe(true);
  });

  test('goal_update 三个字段至少给一个', () => {
    expect(validateToolArgs('goal_update', {}).ok).toBe(false);
    expect(validateToolArgs('goal_update', { todos: [] }).ok).toBe(true);
    expect(validateToolArgs('goal_update', { objective: '改一下' }).ok).toBe(true);
  });
});

describe('工具端到端：goal_start / goal_check / goal_finish 打在会话目标上', () => {
  test('建目标 → 检查未通过 → 完成被打回 → 检查通过 → 收尾完成', async () => {
    const gateway = makeFakeGateway({
      execResults: [
        { code: 1, stdout: 'failing', stderr: 'boom' },
        { code: 0, stdout: 'all green' }
      ]
    });
    const bridge = bridgeFor(gateway);
    const ctx = { sessionId: 'sess-goal', workspacePath: '' };

    const started = await bridge.executeAgentTool(
      'goal_start',
      {
        objective: '让测试全绿',
        checks: [{ command: 'npm test' }],
        todos: [{ text: '修实现' }]
      },
      ctx
    );
    expect(started.ok).toBe(true);
    expect(started.created).toBe(true);

    // 第二会话上下文里没有目标：goal 工具给结构化错误，而不是静默记账
    const noGoal = await bridge.executeAgentTool('goal_check', { command: 'npm test' }, { sessionId: 'sess-other' });
    expect(noGoal.ok).toBe(false);
    expect(noGoal.errorCode).toBe('NO_SESSION_GOAL');

    const failed = await bridge.executeAgentTool('goal_check', { command: 'npm test' }, ctx);
    expect(failed.ok).toBe(true);
    expect(failed.passed).toBe(false);
    expect(failed.exitCode).toBe(1);

    const rejected = await bridge.executeAgentTool('goal_finish', { outcome: 'complete' }, ctx);
    expect(rejected.ok).toBe(true);
    expect(rejected.accepted).toBe(false);

    const passed = await bridge.executeAgentTool('goal_check', { command: 'npm test' }, ctx);
    expect(passed.passed).toBe(true);

    const accepted = await bridge.executeAgentTool('goal_finish', { outcome: 'complete' }, ctx);
    expect(accepted.ok).toBe(true);
    expect(accepted.accepted).toBe(true);

    const goal = await loadGoal({ invokeRpc: gateway.invokeRpc, sessionId: 'sess-goal' });
    expect(goal.outcome).toBe('complete');
    expect(goal.evidence.length).toBeGreaterThanOrEqual(2);
    expect(goal.claims.some((c) => c.accepted === false)).toBe(true);
  });

  test('goal_update 整体替换清单，done 进度进到面板视图', async () => {
    const gateway = makeFakeGateway();
    const bridge = bridgeFor(gateway);
    const ctx = { sessionId: 'sess-update' };

    await bridge.executeAgentTool('goal_start', { objective: '推进两件事', todos: [{ text: 'a' }, { text: 'b' }] }, ctx);
    const updated = await bridge.executeAgentTool(
      'goal_update',
      { todos: [{ text: 'a', done: true }, { text: 'b' }] },
      ctx
    );
    expect(updated.ok).toBe(true);
    expect(updated.todos).toHaveLength(2);
    expect(updated.todos[0].done).toBe(true);

    const goal = await loadGoal({ invokeRpc: gateway.invokeRpc, sessionId: 'sess-update' });
    expect(toPanelView({ goal, limits: LIMITS }).todosDone).toBe(1);
  });
});
