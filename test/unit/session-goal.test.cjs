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
  fitGoalToBudget,
  toPanelView,
  normalizeSessionGoal
} = require('../../src/goals/session-goal');
const { renderSessionGoalBlock, normalizeGoal } = require('../../src/plans/goal-run');
const { validateToolArgs } = require('../../src/agent/tool-validate');
const { createMainToolBridge } = require('../../src/agent/tool-bridge-main');
const { createMemoryHandlers } = require('../../src/gateway/handlers/memory');
const { AGENT_LIMITS_DEFAULTS } = require('../../src/agent/agent-limits');

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

  test('面板视图：进度优先按验收算（客观），没检查才退回清单，两样都没有才 0/1', () => {
    // 1) 有声明检查：进度 = 最新通过的检查数 / 声明数（与 judgeGoalFinish 同一算法 goalCheckProgress）
    const withChecks = normalizeSessionGoal({
      goal: {
        objective: '让测试全绿',
        checks: [{ command: 'npm test' }, { command: 'npm run lint' }],
        todos: [{ text: 'a', done: true }, { text: 'b' }]
      },
      evidence: [{ round: 1, command: 'npm test', ok: true, exitCode: 0 }]
    });
    const checksView = toPanelView({ goal: withChecks, limits: LIMITS });
    expect(checksView.progressFrom).toBe('checks');
    expect(checksView.checksPassed).toBe(1);
    expect(checksView.checksTotal).toBe(2);
    expect(checksView.progress).toBeCloseTo(0.5, 6);
    expect(checksView.unverified).toBe(false);
    // 清单勾选是模型自述，不参与进度计算（但照样投影给 UI）
    expect(checksView.todosDone).toBe(1);

    // 2) 没有声明检查（未验证模式）：退回清单勾选比例
    const withTodos = normalizeSessionGoal({
      goal: { objective: '推进', todos: [{ text: 'a', done: true }, { text: 'b' }] }
    });
    const view = toPanelView({ goal: withTodos, limits: LIMITS, evidenceShown: 5 });
    expect(view.progressFrom).toBe('todos');
    expect(view.todosDone).toBe(1);
    expect(view.todosTotal).toBe(2);
    expect(view.checksTotal).toBe(0);
    expect(view.progress).toBeCloseTo(0.5, 6);
    expect(view.maxAttempts).toBe(LIMITS.goalMaxAttempts);
    expect(view.unverified).toBe(true);

    // 3) 既没检查也没清单：只有「收尾了/没」两种可判定取值（不编造百分比）
    const bare = normalizeSessionGoal({ goal: { objective: '没清单' } });
    const bareView = toPanelView({ goal: bare, limits: LIMITS });
    expect(bareView.progressFrom).toBe('outcome');
    expect(bareView.progress).toBe(0);
    bare.outcome = 'complete';
    expect(toPanelView({ goal: bare, limits: LIMITS }).progress).toBe(1);

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
    expect(text).toContain('清单：1/2 项已完成');
    // 验收进度与面板同一算法：声明了 1 条、还没通过
    expect(text).toContain('验收：0/1 条声明的检查最新结果通过');
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

  test('没写 id 的检查编号会去重：同脚本不同参数不再共用同一个 id', () => {
    // 同一个脚本只差参数：前 40 字完全相同（所以才需要去重）
    const a = 'py -3.12 tools\\ue5\\outdoor_final_verify.py --seg 1';
    const b = 'py -3.12 tools\\ue5\\outdoor_final_verify.py --seg 2';
    expect(a.slice(0, 40)).toBe(b.slice(0, 40));

    const g = normalizeGoal({
      checks: [{ command: a }, { command: b }, { id: 'explicit', command: 'npm test' }]
    });
    expect(g.checks.map((c) => c.id)).toEqual([a.slice(0, 40), `${a.slice(0, 40)}#2`, 'explicit']);
    expect(new Set(g.checks.map((c) => c.id)).size).toBe(3);

    // id 由命令列表唯一决定：读路径每次都会重算，不能漂移
    expect(normalizeGoal(g).checks.map((c) => c.id)).toEqual(g.checks.map((c) => c.id));
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

/**
 * 2026-11-07 现场：会话里的目标在 11-06 22:11 就收尾了，之后又聊了一整晚别的需求，
 * 面板还挂着「已完成 · 第 1/12 轮 · 验收通过 1/1」，与窗口里的对话完全对不上。
 *
 * 两条固化：
 *   1. 收尾的目标要能被认出「这是历史」—— 收尾时间来自接受的那条 claim，收尾之后
 *      会话又有人说话就是 `superseded`；
 *   2. 模型要被明确告知「新长任务先 goal_start 开新的」，否则它会以为旧目标就是当前的事。
 */
describe('已收尾的目标：历史标记与「新长任务另开一条」', () => {
  test('completedAt 取接受的那条 claim；其后有人说话即 superseded', () => {
    const goal = normalizeSessionGoal({
      goal: { objective: '拆头发', checks: [{ id: 'assets', command: 'py check_assets.py' }] },
      evidence: [
        { at: '2026-11-06T14:11:54.000Z', command: 'py check_assets.py', checkId: 'assets', ok: true, exitCode: 0 }
      ],
      claims: [
        { at: '2026-11-06T14:11:43.000Z', outcome: 'complete', accepted: false },
        { at: '2026-11-06T14:11:58.000Z', outcome: 'complete', accepted: true }
      ],
      outcome: 'complete',
      startedAt: '2026-11-06T13:53:44.000Z'
    });

    // 结账时刻 = 被接受那次申请，不是最后一条事实、也不是打回的那次
    expect(toPanelView({ goal, limits: LIMITS }).completedAt).toBe('2026-11-06T14:11:58.000Z');

    const before = toPanelView({ goal, limits: LIMITS, lastUserMessageAt: '2026-11-06T13:55:00.000Z' });
    expect(before.superseded).toBe(false);

    const after = toPanelView({ goal, limits: LIMITS, lastUserMessageAt: '2026-11-07T00:03:37.000Z' });
    expect(after.superseded).toBe(true);
    expect(after.outcome).toBe('complete');

    // 进行中的目标没有「收尾时间」，也不可能是历史目标（哪怕对话在往前走）
    const running = normalizeSessionGoal({ goal: { objective: '还在做' } });
    const runningView = toPanelView({ goal: running, limits: LIMITS, lastUserMessageAt: '2030-01-01T00:00:00.000Z' });
    expect(runningView.completedAt).toBeNull();
    expect(runningView.superseded).toBe(false);
  });

  test('注入块：已收尾时必须说清「新长任务先 goal_start」', () => {
    const done = {
      ...normalizeSessionGoal({ goal: { objective: '让 npm test 全绿', checks: [{ command: 'npm test' }] } }),
      outcome: 'complete'
    };
    const text = renderSessionGoalBlock({ goal: done, limits: LIMITS });
    expect(text).toContain('已收尾');
    expect(text).toContain('goal_start');
    expect(text).toContain('不会被复用');
  });

  test('已收尾的目标不再接受 goal_check / goal_update / goal_finish，但可以开新目标', async () => {
    const gateway = makeFakeGateway({ execResults: [{ code: 0, stdout: 'ok' }] });
    const bridge = bridgeFor(gateway);
    const ctx = { sessionId: 'sess-closed' };

    await bridge.executeAgentTool('goal_start', { objective: '让测试全绿', checks: [{ command: 'npm test' }] }, ctx);
    await bridge.executeAgentTool('goal_check', { command: 'npm test' }, ctx);
    const fin = await bridge.executeAgentTool('goal_finish', { outcome: 'complete' }, ctx);
    expect(fin.accepted).toBe(true);

    const check = await bridge.executeAgentTool('goal_check', { command: 'npm test' }, ctx);
    expect(check.ok).toBe(false);
    expect(check.errorCode).toBe('GOAL_CLOSED');
    const upd = await bridge.executeAgentTool('goal_update', { todos: [{ text: 'x' }] }, ctx);
    expect(upd.errorCode).toBe('GOAL_CLOSED');
    const again = await bridge.executeAgentTool('goal_finish', { outcome: 'complete' }, ctx);
    expect(again.errorCode).toBe('GOAL_CLOSED');

    // 收尾过 = 允许覆盖：新目标从头开始，旧账不混进来
    const next = await bridge.executeAgentTool('goal_start', { objective: '另一件事' }, ctx);
    expect(next.created).toBe(true);
    const stored = await loadGoal({ invokeRpc: gateway.invokeRpc, sessionId: 'sess-closed' });
    expect(stored.goal.objective).toBe('另一件事');
    expect(stored.outcome).toBeNull();
    expect(stored.evidence).toHaveLength(0);
  });

  test('updatedAt 是落盘时间：读回来不会被改成「刚刚」', async () => {
    const gateway = makeFakeGateway();
    const args = { invokeRpc: gateway.invokeRpc, sessionId: 'sess-updated' };
    const started = await startGoal({ ...args, draft: { objective: '一件事' } });
    const firstUpdated = started.goal.updatedAt;
    expect((await loadGoal(args)).updatedAt).toBe(firstUpdated);

    await new Promise((r) => setTimeout(r, 5));
    await patchGoal({
      ...args,
      mutate: (g) => {
        g.goal.todos = [{ text: 'a', done: true }];
        return g;
      }
    });
    expect((await loadGoal(args)).updatedAt).not.toBe(firstUpdated);
  });
});

/**
 * 事故（2026-11-07 审计）：事实保留预算是 20 条 × 每条 4000 字符尾巴，满额 JSON 实测 83k 字符，
 * 而 `dieyun-core` 的 `SESSION_GOAL_MAX_CHARS` 是 64000 —— 写满之后每次写盘都被拒：
 * 检查命令跑完了，事实落不了库，`goal_finish` 也写不进去，目标静默卡死。
 */
describe('落盘预算：写入口保证不超过库的上限', () => {
  test('超预算时先削最旧事实的尾巴，最新一条一定保得住', async () => {
    const gateway = makeFakeGateway();
    const args = { invokeRpc: gateway.invokeRpc, sessionId: 'sess-budget' };
    const tail = 'x'.repeat(AGENT_LIMITS_DEFAULTS.goalEvidenceTailChars);
    const goal = normalizeSessionGoal({
      goal: { objective: '长时间构建', checks: [{ id: 'build', command: 'npm run build' }] }
    });
    for (let i = 1; i <= AGENT_LIMITS_DEFAULTS.goalEvidenceKeep; i += 1) {
      pushEvidence(
        goal,
        { command: 'npm run build', checkId: 'build', ok: false, exitCode: 1, round: i, tail },
        AGENT_LIMITS_DEFAULTS.goalEvidenceKeep
      );
    }
    // 裁剪前确实超预算（否则这条测试没测到东西）
    expect(JSON.stringify(goal).length).toBeGreaterThan(AGENT_LIMITS_DEFAULTS.goalBlobMaxChars);

    await saveGoal({ ...args, goal });

    const stored = JSON.parse(gateway.blobs.get('sess-budget'));
    expect(JSON.stringify(stored).length).toBeLessThanOrEqual(AGENT_LIMITS_DEFAULTS.goalBlobMaxChars);
    // 事实条数没有被牺牲（先削尾巴）：判据仍能按检查聚合
    expect(stored.evidence).toHaveLength(AGENT_LIMITS_DEFAULTS.goalEvidenceKeep);
    expect(stored.evidence[stored.evidence.length - 1].round).toBe(AGENT_LIMITS_DEFAULTS.goalEvidenceKeep);
    expect(stored.evidence[0].tail).toBe('');
  });

  test('压到极限还放不下就报错，不写一条会被库拒掉的账', () => {
    const goal = normalizeSessionGoal({ goal: { objective: '一件事' } });
    expect(() => fitGoalToBudget(goal, 10)).toThrow(/超出存储上限/);
  });

  test('预算更紧时先丢最旧的事实，但绝不留空账本', () => {
    const goal = normalizeSessionGoal({ goal: { objective: '一件事' } });
    for (let i = 1; i <= 5; i += 1) pushEvidence(goal, { command: 'npm test', round: i, ok: true }, 20);
    const tight = Math.floor(JSON.stringify(goal).length / 2);
    fitGoalToBudget(goal, tight);
    expect(JSON.stringify(goal).length).toBeLessThanOrEqual(tight);
    expect(goal.evidence.length).toBeGreaterThanOrEqual(1);
    expect(goal.evidence[goal.evidence.length - 1].round).toBe(5);
  });
});

/**
 * 审计项：覆盖一条「没在跑」的目标（已收尾 / 已暂停 / 预算尽）会连旧账一起清掉，
 * 原来是静默的 —— 模型和用户都看不到「上一件事的事实没了」。
 */
describe('覆盖旧目标要留下回执', () => {
  test('stalled 的旧目标被覆盖：replaced 里带明细；首次开目标与「仍在跑」都没有回执', async () => {
    const gateway = makeFakeGateway();
    const args = { invokeRpc: gateway.invokeRpc, sessionId: 'sess-replace' };

    await startGoal({ ...args, draft: { objective: '第一件事', checks: [{ command: 'npm test' }] } });
    await patchGoal({
      ...args,
      mutate: (g) => {
        pushEvidence(g, { command: 'npm test', ok: false, exitCode: 1, round: 3 }, 20);
        g.status = 'stalled';
        return g;
      }
    });

    const next = await startGoal({ ...args, draft: { objective: '第二件事' } });
    expect(next.replaced).toMatchObject({
      objective: '第一件事',
      status: 'stalled',
      attempt: 0,
      evidenceCount: 1
    });
    expect(next.goal.goal.objective).toBe('第二件事');
    expect(next.goal.evidence).toHaveLength(0);

    // 还在跑的目标：返回现有目标，不是覆盖，也就没有「旧账被清」这回事
    const again = await startGoal({ ...args, draft: { objective: '第三件事' } });
    expect(again.unchanged).toBe(true);
    expect(again.replaced).toBeUndefined();

    // 全新的会话：没有旧目标
    const fresh = await startGoal({ invokeRpc: gateway.invokeRpc, sessionId: 'sess-fresh', draft: { objective: 'x' } });
    expect(fresh.replaced).toBeUndefined();
  });

  test('goal_start 把「旧账已清」写进工具结果，模型能就此说一句话', async () => {
    const gateway = makeFakeGateway({ execResults: [{ code: 0, stdout: 'ok' }] });
    const bridge = bridgeFor(gateway);
    const ctx = { sessionId: 'sess-tool-replace' };

    await bridge.executeAgentTool('goal_start', { objective: '第一件事' }, ctx);
    await bridge.executeAgentTool('goal_check', { command: 'npm test' }, ctx);
    // 模拟预算用尽：直接改状态（judgeAfterTurn 的落盘路径在 session-goal-continue.test.cjs 里已覆盖）
    const stored = await loadGoal({ invokeRpc: gateway.invokeRpc, sessionId: 'sess-tool-replace' });
    await saveGoal({ invokeRpc: gateway.invokeRpc, sessionId: 'sess-tool-replace', goal: { ...stored, status: 'stalled' } });

    const next = await bridge.executeAgentTool('goal_start', { objective: '第二件事' }, ctx);
    expect(next.created).toBe(true);
    expect(next.replaced).toMatchObject({ objective: '第一件事', status: 'stalled', evidenceCount: 1 });
    expect(next.hint).toContain('已替换上一条未在推进的目标');
  });
});

/**
 * 事故（2026-11-04 现场）：`memory.session_goal_get / put` 只有 Rust 侧实现，
 * Gateway handler 包里没有 → `goal_start` 一律 `UNKNOWN_METHOD`，
 * 右侧「目标」页签永远「本会话暂无目标」，而错误被 `loadGoal` 的 try/catch 吞掉。
 * 这两条 RPC 是会话目标的唯一通道，注册缺失必须在单测里就断掉。
 */
describe('会话目标的两个 RPC 必须在 Gateway 注册', () => {
  function gatewayHandlers() {
    const calls = [];
    const handlers = createMemoryHandlers({
      requireRustCore: async (method, params) => {
        calls.push({ method, params });
        return method.endsWith('_get') ? { goalJson: null } : { ok: true };
      }
    });
    return { handlers, calls };
  }

  test('get / put 都存在，参数名与 Rust 契约一致（sessionId / goalJson）', async () => {
    const { handlers, calls } = gatewayHandlers();
    expect(typeof handlers['memory.session_goal_get']).toBe('function');
    expect(typeof handlers['memory.session_goal_put']).toBe('function');

    await handlers['memory.session_goal_get']({ sessionId: 's1' });
    await handlers['memory.session_goal_put']({ sessionId: 's1', goalJson: '{"objective":"x"}' });
    // null = 删除（Rust 侧只当 KV，不解析目标）
    await handlers['memory.session_goal_put']({ sessionId: 's1', goalJson: null });

    expect(calls.map((c) => c.method)).toEqual([
      'memory.session_goal_get',
      'memory.session_goal_put',
      'memory.session_goal_put'
    ]);
    expect(calls[0].params).toEqual({ sessionId: 's1' });
    expect(calls[1].params).toEqual({ sessionId: 's1', goalJson: '{"objective":"x"}' });
    expect(calls[2].params.goalJson).toBeNull();
  });
});
