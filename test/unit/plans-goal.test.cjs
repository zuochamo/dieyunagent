'use strict';

/**
 * 目标型计划（plans trigger=goal）：事实 / 核对 / 续跑判定 / store 运行态 / 交接班文本。
 *
 * 这一版断言的**不是**「某技术栈怎么验」，而是通用契约：
 *   1. 检查命令退出码 0 = 通过，其它一律是「没通过」的事实（含超时 / 被沙箱拒绝）；
 *   2. 代码只核对「主张与事实是否一致」，不判断「检查够不够证明目标达成」；
 *   3. 预算用完与新事实一样只是事实 —— 既不会写成「完成」，也不会自动续跑。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  decideContinuation,
  resolveGoalBudget,
  runGoalCheck,
  tailEvidence,
  judgeGoalFinish,
  goalChecks,
  isUnverified,
  renderEvidenceBlock,
  latestFactFor
} = require('../../src/plans/goal-run');
const { PlansStore } = require('../../src/plans/store');
const { PlansScheduler } = require('../../src/plans/scheduler');
const { buildPlanRunUserText } = require('../../src/plans/plan-run-turn');
const { validateToolArgs } = require('../../src/agent/tool-validate');
const { AGENT_LIMITS_DEFAULTS } = require('../../src/agent/agent-limits');

const LIMITS = {
  goalMaxAttempts: 3,
  goalMaxWallMs: 60 * 60 * 1000,
  goalRetryBackoffMs: 60000,
  goalCheckTimeoutMs: 120000,
  goalEvidenceTailChars: 40,
  goalEvidenceKeep: 3
};

function makeStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dieyun-goal-'));
  return new PlansStore(dir);
}

function goalPlan(extra = {}) {
  return {
    id: 'g1',
    name: '跑绿色的检查',
    enabled: true,
    trigger: 'goal',
    prompt: '把检查跑绿',
    goal: { checks: [{ id: 'c1', command: 'npm test' }], cwd: '' },
    budget: { maxAttempts: 0, maxWallMs: 0 },
    attempt: 0,
    attemptStartedAt: null,
    nextRunAt: null,
    outcome: null,
    evidence: [],
    claims: [],
    ...extra
  };
}

/** 一条事实（等价于 goal_check 落库后的形状） */
function fact(over = {}) {
  return {
    at: new Date().toISOString(),
    round: 1,
    checkId: 'c1',
    command: 'npm test',
    ok: true,
    exitCode: 0,
    note: 'pass',
    tail: '',
    ...over
  };
}

describe('goal-run: 检查命令只产生事实', () => {
  it('退出码 0 = 通过', async () => {
    const r = await runGoalCheck({
      gateway: { invokeRpc: async () => ({ code: 0, stdout: 'all green' }) },
      plan: goalPlan(),
      command: 'npm test',
      limits: LIMITS
    });
    expect(r.ok).toBe(true);
    expect(r.exitCode).toBe(0);
    expect(r.note).toBe('pass');
    expect(r.tail).toContain('all green');
  });

  it('非 0 退出码 = 未通过（不是错误、不是异常）', async () => {
    const r = await runGoalCheck({
      gateway: { invokeRpc: async () => ({ code: 2, stdout: 'boom' }) },
      plan: goalPlan(),
      command: 'npm test',
      limits: LIMITS
    });
    expect(r.ok).toBe(false);
    expect(r.exitCode).toBe(2);
    expect(r.note).toBe('fail');
  });

  it('超时：记 note=timeout，并顺手结束被转到后台的进程', async () => {
    const calls = [];
    const r = await runGoalCheck({
      gateway: {
        invokeRpc: async (method, params) => {
          calls.push([method, params]);
          if (method === 'host.exec') return { code: null, timedOut: true, stillRunning: true, handle: 'h1' };
          return { ok: true };
        }
      },
      plan: goalPlan(),
      command: 'npm test',
      limits: LIMITS
    });
    expect(r.ok).toBe(false);
    expect(r.note).toBe('timeout');
    expect(calls.some(([m, p]) => m === 'host.proc_kill' && p.id === 'h1')).toBe(true);
  });

  it('沙箱拒绝（无人可批）也只是一种事实：note=blocked', async () => {
    const r = await runGoalCheck({
      gateway: {
        invokeRpc: async () => {
          const e = new Error('sandbox denied');
          e.code = 'SANDBOX_DENIED';
          throw e;
        }
      },
      plan: goalPlan(),
      command: 'npm test',
      limits: LIMITS
    });
    expect(r.ok).toBe(false);
    expect(r.note).toBe('blocked');
    expect(r.exitCode).toBe(null);
  });

  it('没有命令 / 没有 Gateway：不抛错，返回可读的 note', async () => {
    const noCmd = await runGoalCheck({ gateway: { invokeRpc: async () => ({}) }, command: '  ' });
    expect(noCmd.note).toBe('missing');
    const noGw = await runGoalCheck({ gateway: null, command: 'npm test' });
    expect(noGw.note).toBe('error');
    expect(noGw.tail).toContain('Gateway');
  });

  it('证据尾巴只留限定长度的尾部', () => {
    const tail = tailEvidence('a'.repeat(100), '', 40);
    expect(tail.length).toBe(40);
    expect(tail).toBe('a'.repeat(40));
  });
});

describe('goal-run: 完成申请只核对事实', () => {
  it('声明的检查还没跑过 → 拒绝，并给出原因', () => {
    const v = judgeGoalFinish({ plan: goalPlan(), outcome: 'complete' });
    expect(v.accept).toBe(false);
    expect(v.reason).toContain('goal_check');
  });

  it('声明检查最新一次通过 → 接受', () => {
    const v = judgeGoalFinish({
      plan: goalPlan({ evidence: [fact()] }),
      outcome: 'complete'
    });
    expect(v.accept).toBe(true);
    expect(v.outcome).toBe('complete');
    expect(v.facts.lastOk).toBe(true);
  });

  it('声明了两条、只跑通一条 → 拒绝（指出没通过的那条）', () => {
    const plan = goalPlan({
      goal: { checks: [{ id: 'c1', command: 'npm test' }, { id: 'c2', command: 'npm run lint' }], cwd: '' },
      evidence: [fact(), fact({ checkId: 'c2', command: 'npm run lint', ok: false, exitCode: 3, note: 'fail' })]
    });
    const v = judgeGoalFinish({ plan, outcome: 'complete' });
    expect(v.accept).toBe(false);
    expect(v.reason).toContain('npm run lint');
    expect(v.reason).toContain('exit 3');
  });

  it('越新的失败压过越早的通过：最近一次没过就不许收尾', () => {
    const plan = goalPlan({
      evidence: [fact(), fact({ ok: false, exitCode: 1, note: 'fail' })]
    });
    expect(judgeGoalFinish({ plan, outcome: 'complete' }).accept).toBe(false);
  });

  it('声明检查都绿了，但刚跑的另一条命令报红 → 也不许收尾', () => {
    const plan = goalPlan({
      evidence: [
        fact(),
        fact({ checkId: '', command: 'npm run smoke', ok: false, exitCode: 7, note: 'fail' })
      ]
    });
    const v = judgeGoalFinish({ plan, outcome: 'complete' });
    expect(v.accept).toBe(false);
    expect(v.reason).toContain('npm run smoke');
  });

  it('未声明检查（未验证模式）：可以收尾，但事实里标注 unverified', () => {
    const v = judgeGoalFinish({ plan: goalPlan({ goal: { checks: [], cwd: '' } }), outcome: 'complete' });
    expect(v.accept).toBe(true);
    expect(v.facts.unverified).toBe(true);
  });

  it('阻塞申请一律接受：卡点归模型判断，代码只留痕', () => {
    const v = judgeGoalFinish({ plan: goalPlan(), outcome: 'blocked' });
    expect(v.accept).toBe(true);
    expect(v.outcome).toBe('blocked');
  });

  it('按 checkId 或同一条命令都能取到最新事实', () => {
    const evidence = [fact({ checkId: '', command: 'npm test', ok: false, exitCode: 1 })];
    expect(latestFactFor(evidence, { id: 'c1', command: 'npm test' }).ok).toBe(false);
    expect(latestFactFor(evidence, { id: 'zzz', command: 'other' })).toBe(null);
  });

  it('goalChecks / isUnverified 只认结构化字段', () => {
    expect(goalChecks(goalPlan()).length).toBe(1);
    expect(isUnverified(goalPlan({ goal: { checks: [], cwd: '' } }))).toBe(true);
  });
});

describe('goal-run: 续跑判定表', () => {
  it('已按完成收尾 → 停（不再续跑）', () => {
    const d = decideContinuation({ plan: goalPlan({ attempt: 1, outcome: 'complete' }), limits: LIMITS });
    expect(d.cont).toBe(false);
    expect(d.stop).toBe('done');
  });

  it('模型报阻塞 → 停', () => {
    const d = decideContinuation({ plan: goalPlan({ attempt: 1, outcome: 'blocked' }), limits: LIMITS });
    expect(d.cont).toBe(false);
    expect(d.stop).toBe('blocked');
  });

  it('轮次用完 → 停（未收尾就是未完成，措辞交给模型）', () => {
    const d = decideContinuation({ plan: goalPlan({ attempt: 3 }), limits: LIMITS });
    expect(d.cont).toBe(false);
    expect(d.stop).toBe('attempts');
  });

  it('墙钟用完 → 停（即便轮次还有剩）', () => {
    const startedAt = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const d = decideContinuation({ plan: goalPlan({ attempt: 1, attemptStartedAt: startedAt }), limits: LIMITS });
    expect(d.cont).toBe(false);
    expect(d.stop).toBe('budget');
  });

  it('没跑完、预算还有 → 立刻接下一轮（正常轮次不额外等待）', () => {
    const d = decideContinuation({ plan: goalPlan({ attempt: 1 }), limits: LIMITS });
    expect(d.cont).toBe(true);
    expect(d.delayMs).toBe(0);
  });

  it('崩溃恢复才退避：那是唯一「代码比模型知道得多」的情形', () => {
    const d = decideContinuation({ plan: goalPlan({ attempt: 1 }), limits: LIMITS, interrupted: true });
    expect(d.cont).toBe(true);
    expect(d.delayMs).toBe(LIMITS.goalRetryBackoffMs);
  });

  it('预算默认值与上限收敛在一处', () => {
    const b = resolveGoalBudget({ budget: { maxAttempts: 999, maxWallMs: 0 } }, LIMITS);
    expect(b.maxAttempts).toBe(48); // schema 上限
    expect(b.maxWallMs).toBe(LIMITS.goalMaxWallMs);
    expect(resolveGoalBudget({}, LIMITS).maxAttempts).toBe(LIMITS.goalMaxAttempts);
  });
});

describe('goal-run: 事实块只陈述事实', () => {
  it('列出轮次预算、声明检查与最近事实（含退出码）', () => {
    const text = renderEvidenceBlock({
      plan: goalPlan({
        attempt: 2,
        attemptStartedAt: new Date(Date.now() - 60000).toISOString(),
        budget: { maxAttempts: 5, maxWallMs: 60 * 60 * 1000 },
        evidence: [fact({ round: 1 }), fact({ round: 2, ok: false, exitCode: 1, note: 'fail', tail: 'ERR boom' })]
      }),
      limits: LIMITS,
      upcoming: true
    });
    expect(text).toContain('目标第 3/5 轮');
    expect(text).toContain('npm test');
    expect(text).toContain('exit 1');
    expect(text).toContain('ERR boom');
    // 结论性措辞不属于事实块：谁来做完没做完的判断是模型与人
    expect(text).not.toContain('已完成');
  });

  it('未声明检查时明说「未验证」', () => {
    const text = renderEvidenceBlock({ plan: goalPlan({ goal: { checks: [], cwd: '' } }), limits: LIMITS });
    expect(text).toContain('未验证');
  });

  it('带上「本轮改了几次文件」这条事实（0 次是最好的线索）', () => {
    const text = renderEvidenceBlock({ plan: goalPlan(), limits: LIMITS, writes: 0 });
    expect(text).toContain('改动工作区的工具调用：0 次');
  });
});

describe('store: 目标型运行态', () => {
  it('开一轮就 +1，并清掉上一轮的收尾结论', () => {
    const s = makeStore();
    const p = s.upsert(goalPlan());
    s.setOutcome(p.id, 'complete');
    const after = s.beginAttempt(p.id);
    expect(after.attempt).toBe(1);
    expect(after.outcome).toBe(null);
    expect(after.attemptStartedAt).toBeTruthy();
  });

  it('检查事实按保留条数有界，最新在最前可见', () => {
    const s = makeStore();
    const p = s.upsert(goalPlan());
    for (let i = 0; i < 5; i += 1) s.pushEvidence(p.id, fact({ round: i + 1 }), 3);
    const fresh = s.get(p.id);
    expect(fresh.evidence.length).toBe(3);
    expect(fresh.evidence[fresh.evidence.length - 1].round).toBe(5);
  });

  it('主张（含被拒绝的）也留痕，便于早上复盘', () => {
    const s = makeStore();
    const p = s.upsert(goalPlan());
    s.recordClaim(p.id, { outcome: 'complete', round: 1, accepted: false, note: '我先说做完了' });
    const fresh = s.get(p.id);
    expect(fresh.claims.length).toBe(1);
    expect(fresh.claims[0].accepted).toBe(false);
  });

  it('重新启用会清空轮次/事实/主张，但保留检查与预算配置', () => {
    const s = makeStore();
    const p = s.upsert(goalPlan({ budget: { maxAttempts: 4, maxWallMs: 0 } }));
    s.beginAttempt(p.id);
    s.pushEvidence(p.id, fact());
    s.setOutcome(p.id, 'blocked');
    const cleared = s.clearGoalRuntime(p.id);
    expect(cleared.attempt).toBe(0);
    expect(cleared.evidence).toEqual([]);
    expect(cleared.claims).toEqual([]);
    expect(cleared.outcome).toBe(null);
    expect(cleared.goal.checks.length).toBe(1);
    expect(cleared.budget.maxAttempts).toBe(4);
  });

  it('目标型不强制填检查命令（未验证模式照样能跑）', () => {
    const s = makeStore();
    const p = s.upsert(goalPlan({ goal: { checks: [], cwd: '' } }));
    expect(p.goal.checks).toEqual([]);
  });

  it('「这一轮成功」的定义是 outcome=complete，不是模型写了正文', () => {
    const s = makeStore();
    const p = s.upsert(goalPlan());
    s.updateRunResult(p.id, { ok: true, outcome: null });
    expect(s.get(p.id).lastRunOk).toBe(false);
    s.updateRunResult(p.id, { ok: true, outcome: 'complete' });
    expect(s.get(p.id).lastRunOk).toBe(true);
  });
});

describe('store: 已完成目标型有界保留', () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /** 造一条「按完成收尾并已停用」的目标型计划（updatedAt 由 setOutcome 刷新成收尾时刻） */
  async function finished(s, id) {
    const p = s.upsert(goalPlan({ id, name: id }));
    s.beginAttempt(p.id);
    s.setOutcome(p.id, 'complete');
    s.setEnabled(p.id, false);
    await sleep(2);
    return p.id;
  }

  it('只留最近 N 条已完成，更早的自动清掉', async () => {
    const s = makeStore();
    for (let i = 1; i <= 7; i += 1) await finished(s, `g${i}`);
    const dropped = s.pruneFinishedGoals(5);
    expect(dropped).toEqual(['g1', 'g2']);
    expect(s.list().map((p) => p.id)).toEqual(['g3', 'g4', 'g5', 'g6', 'g7']);
  });

  it('blocked / 未收尾 / 仍在启用的一律不清（keep=0 也不清）', async () => {
    const s = makeStore();
    const done = await finished(s, 'done1');
    const blocked = s.upsert(goalPlan({ id: 'blocked1' }));
    s.setOutcome(blocked.id, 'blocked');
    s.setEnabled(blocked.id, false);
    const running = s.upsert(goalPlan({ id: 'running1' }));
    s.beginAttempt(running.id);
    const plain = s.upsert({
      id: 'sched1',
      name: '定时',
      prompt: '每天汇报',
      enabled: false,
      rrule: 'FREQ=DAILY'
    });

    const dropped = s.pruneFinishedGoals(0);
    expect(dropped).toEqual([done]);
    expect(s.list().map((p) => p.id).sort()).toEqual(['blocked1', 'running1', 'sched1']);
    expect(s.get(plain.id)).toBeTruthy();
  });

  it('默认保留条数取自 agent-limits，不在 store 里另写一个数字', async () => {
    const s = makeStore();
    const keep = AGENT_LIMITS_DEFAULTS.goalCompletedKeep;
    for (let i = 0; i <= keep; i += 1) await finished(s, `g${i}`);
    expect(s.pruneFinishedGoals().length).toBe(1);
    expect(s.list().length).toBe(keep);
  });
});

describe('plan-run-turn: 目标型交接班文本', () => {
  it('带事实块与两个工具的指引', () => {
    const text = buildPlanRunUserText(
      goalPlan({
        attempt: 2,
        attemptStartedAt: new Date(Date.now() - 60000).toISOString(),
        budget: { maxAttempts: 5, maxWallMs: 60 * 60 * 1000 },
        evidence: [fact({ round: 2, ok: false, exitCode: 1, note: 'fail', tail: 'ERR boom' })]
      })
    );
    expect(text).toContain('目标第 3/5 轮');
    expect(text).toContain('ERR boom');
    expect(text).toContain('目标续跑');
    expect(text).toContain('goal_check');
    expect(text).toContain('goal_finish');
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
    expect(text).not.toContain('目标第');
    expect(text).not.toContain('goal_check');
    expect(text).toContain('执行 TODO');
  });

  it('目标原文进交接班文本（每轮都得知道「什么算达成」）', () => {
    const text = buildPlanRunUserText({
      ...goalPlan({}),
      goal: {
        objective: 'python check_greet.py 退出码为 0',
        checks: [{ id: 'c1', command: 'python check_greet.py' }],
        cwd: ''
      }
    });
    expect(text).toContain('目标：python check_greet.py 退出码为 0');
  });

  it('没有 objective 的老计划不印空行', () => {
    const text = buildPlanRunUserText(goalPlan({}));
    expect(text).not.toContain('目标：');
  });
});

describe('scheduler: 目标型只由轮询触发', () => {
  it('nextRunAt 未到不跑，到了就跑（不新增计时器）', async () => {
    const ran = [];
    const plans = [
      goalPlan({ id: 'a', nextRunAt: new Date(Date.now() + 60000).toISOString() }),
      goalPlan({ id: 'b', nextRunAt: new Date(Date.now() - 1000).toISOString() })
    ];
    const s = new PlansScheduler({
      getPlans: () => plans,
      runPlan: async (p) => {
        ran.push(p.id);
      },
      isBusy: () => false,
      idlePollMs: 10,
      idleQuietMs: 0
    });
    s.reload();
    expect(s.timers.size).toBe(0);
    await s._idleTick();
    expect(ran).toEqual(['b']);
    s.clearAll();
  });
});

describe('对话里建目标型计划：参数契约', () => {
  it('plan_create + goal(objective + checks) → 放行', () => {
    const v = validateToolArgs('plan_create', {
      prompt: '把测试跑绿',
      goal: { objective: 'npm test 退出码为 0', checks: ['npm test'] }
    });
    expect(v.ok).toBe(true);
  });

  it('goal 缺 objective / 缺 checks / 缺 prompt / 同时给 rrule → 拒绝（别留一个猜出来的长任务）', () => {
    // objective 必填：没有它，面板里「目标」正文是空的，每轮交接班也没有「什么算达成」
    //（与 goal_start 的 objective 同一契约）
    const noObjective = validateToolArgs('plan_create', { prompt: 'x', goal: { checks: [] } });
    expect(noObjective.ok).toBe(false);
    expect(noObjective.error).toContain('objective');
    expect(
      validateToolArgs('plan_create', { prompt: 'x', goal: { objective: '做到 x', cwd: '/w' } }).ok
    ).toBe(false);
    expect(validateToolArgs('plan_create', { goal: { objective: 'x', checks: [] } }).ok).toBe(false);
    expect(
      validateToolArgs('plan_create', {
        prompt: 'x',
        rrule: 'FREQ=DAILY',
        goal: { objective: 'x', checks: [] }
      }).ok
    ).toBe(false);
  });

  it('定时型（不带 goal）不受影响', () => {
    expect(validateToolArgs('plan_create', { prompt: 'x', rrule: 'FREQ=DAILY' }).ok).toBe(true);
  });

  it('goal_check 需要 command 或 check_id', () => {
    expect(validateToolArgs('goal_check', {}).ok).toBe(false);
    expect(validateToolArgs('goal_check', { check_id: 'c1' }).ok).toBe(true);
    expect(validateToolArgs('goal_check', { command: 'npm test' }).ok).toBe(true);
  });

  it('goal_finish 只认 complete / blocked', () => {
    expect(validateToolArgs('goal_finish', { outcome: 'complete' }).ok).toBe(true);
    expect(validateToolArgs('goal_finish', { outcome: 'blocked' }).ok).toBe(true);
    const bad = validateToolArgs('goal_finish', { outcome: 'done' });
    expect(bad.ok).toBe(false);
    expect(bad.error).toContain('complete');
  });
});
