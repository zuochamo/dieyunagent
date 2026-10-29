'use strict';

/**
 * 目标型计划（plans trigger=goal）：判定表 / 验收执行 / store 运行态 / 调度触发。
 *
 * 这里断言的都不是「某技术栈怎么验」，而是通用契约：
 *   命令退出码 0 = 通过；未通过且预算未尽 = 再来一轮；任何停止都不许写成「完成」。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  decideContinuation,
  resolveGoalBudget,
  runGoalVerify,
  tailEvidence,
  buildGoalAuditReport,
  goalVerifyCommand
} = require('../../src/plans/goal-run');
const { PlansStore } = require('../../src/plans/store');
const { PlansScheduler } = require('../../src/plans/scheduler');
const { buildPlanRunUserText } = require('../../src/plans/plan-run-turn');

const LIMITS = {
  goalMaxAttempts: 3,
  goalMaxWallMs: 60 * 60 * 1000,
  goalRetryBackoffMs: 60000,
  goalRetryBackoffMaxMs: 300000,
  goalVerifyTimeoutMs: 120000,
  goalVerifyTailChars: 40
};

function makeStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dieyun-goal-'));
  return new PlansStore(dir);
}

function goalPlan(extra = {}) {
  return {
    id: 'g1',
    name: '跑绿色的验收',
    enabled: true,
    trigger: 'goal',
    prompt: '把验收命令跑绿',
    goal: { verify: 'npm test', cwd: '' },
    budget: { maxAttempts: 0, maxWallMs: 0 },
    attempt: 0,
    attemptStartedAt: null,
    nextRunAt: null,
    lastVerify: null,
    baseline: null,
    ...extra
  };
}

describe('goal-run: 续跑判定表', () => {
  it('验收通过 → 完成（不再续跑）', () => {
    const d = decideContinuation({
      plan: goalPlan({ attempt: 1 }),
      verify: { ok: true, note: 'pass' },
      limits: LIMITS
    });
    expect(d.cont).toBe(false);
    expect(d.stop).toBe('done');
  });

  it('无人可批的阻塞 → 立刻停，不算失败重试', () => {
    const d = decideContinuation({
      plan: goalPlan({ attempt: 1 }),
      verify: { ok: false, note: 'blocked-approval' },
      limits: LIMITS
    });
    expect(d.cont).toBe(false);
    expect(d.stop).toBe('blocked');
  });

  it('没有验收命令 → 停（无尺子不许无人值守跑）', () => {
    const d = decideContinuation({
      plan: goalPlan({ attempt: 1 }),
      verify: { ok: false, note: 'no-verify' },
      limits: LIMITS
    });
    expect(d.cont).toBe(false);
    expect(d.stop).toBe('no-verify');
  });

  it('轮次用完 → 停，且是「未完成」不是「完成」', () => {
    const d = decideContinuation({
      plan: goalPlan({ attempt: 3 }),
      verify: { ok: false, note: 'fail' },
      limits: LIMITS
    });
    expect(d.cont).toBe(false);
    expect(d.stop).toBe('attempts');
  });

  it('墙钟用完 → 停（即便轮次还有剩）', () => {
    const startedAt = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const d = decideContinuation({
      plan: goalPlan({ attempt: 1, attemptStartedAt: startedAt }),
      verify: { ok: false, note: 'fail' },
      limits: LIMITS
    });
    expect(d.cont).toBe(false);
    expect(d.stop).toBe('budget');
  });

  it('失败后退避按轮次指数增长并封顶', () => {
    const at = (attempt) =>
      decideContinuation({
        plan: goalPlan({ attempt, attemptStartedAt: new Date().toISOString() }),
        verify: { ok: false, note: 'fail' },
        limits: LIMITS
      }).delayMs;
    expect(at(1)).toBe(60000);
    expect(at(2)).toBe(120000);
    // 3 轮已到 maxAttempts，这里只看 2→4 的翻倍与封顶：把 3 轮预算放开
    const wide = { ...LIMITS, goalMaxAttempts: 8 };
    const delay = (attempt) =>
      decideContinuation({
        plan: goalPlan({ attempt, attemptStartedAt: new Date().toISOString() }),
        verify: { ok: false, note: 'fail' },
        limits: wide
      }).delayMs;
    expect(delay(3)).toBe(240000);
    expect(delay(4)).toBe(300000); // 480000 → 封顶 300000
  });

  it('表单填的预算被 clamp 在 agent-limits 上限内', () => {
    const b = resolveGoalBudget({ budget: { maxAttempts: 9999, maxWallMs: 999 * 60 * 60 * 1000 } }, LIMITS);
    expect(b.maxAttempts).toBeLessThanOrEqual(48);
    expect(b.maxWallMs).toBeLessThanOrEqual(24 * 60 * 60 * 1000);
  });

  it('未填预算 → 用默认值（0 不等于「跑 0 轮」）', () => {
    const b = resolveGoalBudget({ budget: { maxAttempts: 0, maxWallMs: 0 } }, LIMITS);
    expect(b.maxAttempts).toBe(3);
    expect(b.maxWallMs).toBe(60 * 60 * 1000);
  });
});

describe('goal-run: 验收命令执行', () => {
  function fakeGateway(handler) {
    const calls = [];
    return {
      calls,
      invokeRpc: async (method, params) => {
        calls.push({ method, params });
        return handler(method, params);
      }
    };
  }

  it('退出码 0 = 通过；只传 timeoutMs，不传 waitMs/keepOnTimeout', async () => {
    const gw = fakeGateway(() => ({ code: 0, stdout: 'ok' }));
    const r = await runGoalVerify({ gateway: gw, plan: goalPlan(), limits: LIMITS, cwd: 'C:/w' });
    expect(r.ok).toBe(true);
    expect(r.note).toBe('pass');
    const call = gw.calls[0];
    expect(call.method).toBe('host.exec');
    expect(call.params.command).toBe('npm test');
    expect(call.params.timeoutMs).toBe(120000);
    expect(call.params.waitMs).toBeUndefined();
    expect(call.params.keepOnTimeout).toBeUndefined();
  });

  it('非 0 退出码 = 未通过，并把输出尾巴留作证据', async () => {
    const gw = fakeGateway(() => ({ code: 2, stdout: 'x'.repeat(100), stderr: 'ERR 3 tests failed' }));
    const r = await runGoalVerify({ gateway: gw, plan: goalPlan(), limits: LIMITS });
    expect(r.ok).toBe(false);
    expect(r.exitCode).toBe(2);
    expect(r.note).toBe('fail');
    expect(r.tail).toContain('ERR 3 tests failed');
    expect(r.tail.length).toBeLessThanOrEqual(40);
  });

  it('超时被转后台 → 判未通过并顺手结束进程（不留孤儿构建）', async () => {
    const gw = fakeGateway((method) =>
      method === 'host.exec'
        ? { code: null, timedOut: true, stillRunning: true, handle: 'proc-9' }
        : { ok: true }
    );
    const r = await runGoalVerify({ gateway: gw, plan: goalPlan(), limits: LIMITS });
    expect(r.ok).toBe(false);
    expect(r.note).toBe('timeout');
    const kill = gw.calls.find((c) => c.method === 'host.proc_kill');
    expect(kill && kill.params.id).toBe('proc-9');
  });

  it('沙箱拒绝 / 审批超时 → blocked-approval（不是「失败重试」）', async () => {
    for (const code of ['SANDBOX_DENIED', 'SANDBOX_APPROVAL_TIMEOUT', 'APPROVAL_TIMEOUT']) {
      const gw = fakeGateway(() => {
        const e = new Error('blocked');
        e.code = code;
        throw e;
      });
      const r = await runGoalVerify({ gateway: gw, plan: goalPlan(), limits: LIMITS });
      expect(r.note).toBe('blocked-approval');
      expect(r.ok).toBe(false);
    }
  });

  it('命令超时（SHELL_TIMEOUT）→ note=timeout，仍可在下一轮重试', async () => {
    const gw = fakeGateway(() => {
      const e = new Error('shell timeout after 120000ms');
      e.code = 'SHELL_TIMEOUT';
      e.timedOut = true;
      throw e;
    });
    const r = await runGoalVerify({ gateway: gw, plan: goalPlan(), limits: LIMITS });
    expect(r.note).toBe('timeout');
    expect(r.ok).toBe(false);
  });

  it('没填验收命令 → no-verify，且不去执行任何命令', async () => {
    const gw = fakeGateway(() => ({ code: 0 }));
    const r = await runGoalVerify({
      gateway: gw,
      plan: goalPlan({ goal: { verify: '   ' } }),
      limits: LIMITS
    });
    expect(r.note).toBe('no-verify');
    expect(gw.calls.length).toBe(0);
  });

  it('验收命令只从结构化字段来（不解析提示词里的文字）', () => {
    const plan = goalPlan({ prompt: '验收：npm run build', goal: { verify: '' } });
    expect(goalVerifyCommand(plan)).toBe('');
  });

  it('证据尾巴超长时只留尾部', () => {
    expect(tailEvidence('a'.repeat(200), '', 10)).toBe('a'.repeat(10));
    expect(tailEvidence('', 'last-line', 10)).toBe('last-line');
  });
});

describe('goal-run: 停止时的措辞', () => {
  it('预算/轮次耗尽写「未完成」，不出现「已完成」', () => {
    const text = buildGoalAuditReport({
      plan: goalPlan({ attempt: 3 }),
      verify: { ok: false, exitCode: 2, note: 'fail', tail: 'boom' },
      stop: 'attempts',
      budget: { maxAttempts: 3, maxWallMs: 60 * 60 * 1000 }
    });
    expect(text).toContain('目标未完成');
    expect(text).toContain('boom');
    expect(text).not.toContain('已完成');
  });
});

describe('PlansStore: 目标型字段与运行态', () => {
  it('trigger=goal 必须带验收命令', () => {
    const store = makeStore();
    expect(() => store.upsert(goalPlan({ goal: { verify: '' } }))).toThrowError(/验收命令/);
    const saved = store.upsert(goalPlan());
    expect(saved.trigger).toBe('goal');
  });

  it('表单保存不清掉轮次/基线/证据（只有专用方法能改）', () => {
    const store = makeStore();
    store.upsert(goalPlan());
    store.beginAttempt('g1');
    store.setBaseline('g1', { red: true, exitCode: 1, note: 'fail', tail: 'baseline red' });
    store.updateVerify('g1', { ok: false, exitCode: 1, note: 'fail', tail: 'boom' });
    const again = store.upsert({ ...store.get('g1'), name: '改名', prompt: '换个说法' });
    expect(again.name).toBe('改名');
    expect(again.attempt).toBe(1);
    expect(again.baseline && again.baseline.red).toBe(true);
    expect(again.lastVerify && again.lastVerify.note).toBe('fail');
  });

  it('beginAttempt 只在首轮记墙钟起点；scheduleNextAttempt 写未来时间（不启定时器）', () => {
    const store = makeStore();
    store.upsert(goalPlan());
    const a1 = store.beginAttempt('g1');
    expect(a1.attempt).toBe(1);
    expect(a1.attemptStartedAt).toBeTruthy();
    expect(a1.nextRunAt).toBeNull();
    const startedAt = a1.attemptStartedAt;
    const a2 = store.beginAttempt('g1');
    expect(a2.attempt).toBe(2);
    expect(a2.attemptStartedAt).toBe(startedAt);
    const nextRunAt = store.scheduleNextAttempt('g1', 60000);
    expect(Date.parse(nextRunAt) - Date.now()).toBeGreaterThan(50000);
  });

  it('lastRunOk 对目标型按「验收是否通过」记，且成功后不被自动停用', () => {
    const store = makeStore();
    store.upsert(goalPlan());
    store.updateRunResult('g1', { ok: true, verify: { ok: false } });
    expect(store.get('g1').lastRunOk).toBe(false);
    expect(store.get('g1').enabled).toBe(true);
    store.updateRunResult('g1', { ok: true, verify: { ok: true } });
    expect(store.get('g1').lastRunOk).toBe(true);
    // 停用由 decideContinuation 驱动，不走 once/idle 的「成功即停用」
    expect(store.get('g1').enabled).toBe(true);
  });

  it('clearGoalRuntime 清运行态但保留配置', () => {
    const store = makeStore();
    store.upsert(goalPlan());
    store.beginAttempt('g1');
    store.updateVerify('g1', { ok: false, exitCode: 1, note: 'fail' });
    const cleared = store.clearGoalRuntime('g1');
    expect(cleared.attempt).toBe(0);
    expect(cleared.lastVerify).toBeNull();
    expect(cleared.goal.verify).toBe('npm test');
  });
});

describe('PlansScheduler: 目标型按 nextRunAt 触发', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function makeScheduler(plan, runs) {
    return new PlansScheduler({
      getPlans: () => [plan],
      runPlan: async (p) => {
        runs.push({ id: p.id, at: Date.now() });
      }
    });
  }

  it('目标型不走 setTimeout，由轮询按 nextRunAt 触发', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 9, 27, 23, 0, 0));
    const runs = [];
    const plan = goalPlan();
    const sched = makeScheduler(plan, runs);
    sched.reload();
    expect(sched.timers.size).toBe(0);
    await sched._idleTick();
    expect(runs.length).toBe(1);
  });

  it('nextRunAt 未到不触发，到点后触发', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 9, 27, 23, 0, 0));
    const runs = [];
    const plan = goalPlan({ nextRunAt: new Date(2026, 9, 27, 23, 2, 0).toISOString() });
    const sched = makeScheduler(plan, runs);
    await sched._idleTick();
    expect(runs.length).toBe(0);
    vi.setSystemTime(new Date(2026, 9, 27, 23, 2, 1));
    await sched._idleTick();
    expect(runs.length).toBe(1);
  });

  it('停用的目标型不触发', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 9, 27, 23, 0, 0));
    const runs = [];
    const sched = makeScheduler(goalPlan({ enabled: false }), runs);
    await sched._idleTick();
    expect(runs.length).toBe(0);
  });

  it('目标型不受「静默阈值」影响（夜里没人操作也要能连续推进）', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 9, 27, 23, 0, 0));
    const runs = [];
    const sched = new PlansScheduler({
      getPlans: () => [goalPlan()],
      runPlan: async () => runs.push(Date.now()),
      idleQuietMs: 5 * 60 * 1000,
      isBusy: () => false
    });
    await sched._idleTick();
    expect(runs.length).toBe(1);
  });
});

describe('交接班文本：新一轮要看见上轮怎么红的', () => {
  it('目标型轮次文本带轮次、预算与上轮证据尾巴', () => {
    const text = buildPlanRunUserText(
      goalPlan({
        attempt: 2,
        attemptStartedAt: new Date(Date.now() - 60000).toISOString(),
        lastVerify: { ok: false, exitCode: 1, note: 'fail', at: new Date().toISOString(), tail: 'ERR boom' },
        budget: { maxAttempts: 5, maxWallMs: 60 * 60 * 1000 }
      })
    );
    expect(text).toContain('目标型第 3/5 轮');
    expect(text).toContain('上一轮验收');
    expect(text).toContain('ERR boom');
    expect(text).toContain('目标续跑');
  });

  it('非目标型（定时）文本不变形', () => {
    const text = buildPlanRunUserText({
      name: '早报',
      trigger: 'schedule',
      prompt: '总结昨天的提交',
      todos: ['看 git log'],
      rrule: 'FREQ=DAILY;BYHOUR=9'
    });
    expect(text).toContain('定时触发');
    expect(text).not.toContain('目标型第');
    expect(text).toContain('执行 TODO');
  });
});
