'use strict';

const { planDraftFromStructured, parsePlanFromText } = require('../../src/plans/parser');

describe('planDraftFromStructured', () => {
  it('给出 rrule + prompt 时直接成计划（免 LLM）', () => {
    const plan = planDraftFromStructured({
      name: '早报',
      rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
      prompt: '汇总昨日进展'
    });
    expect(plan).toBeTruthy();
    expect(plan.name).toBe('早报');
    expect(plan.rrule).toBe('FREQ=DAILY;BYHOUR=9;BYMINUTE=0');
    expect(plan.onceAt).toBe('');
    expect(plan.prompt).toBe('汇总昨日进展');
    expect(plan.tz).toBe('Asia/Shanghai');
    expect(plan.enabled).toBe(true);
  });

  it('onceAt 与 rrule 二选一：给了 onceAt 就清空 rrule', () => {
    const plan = planDraftFromStructured({
      onceAt: '2026-05-26T09:00:00',
      rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
      prompt: '只跑一次'
    });
    expect(plan.onceAt).toBe('2026-05-26T09:00:00');
    expect(plan.rrule).toBe('');
  });

  it('description 可作为 prompt 的兜底', () => {
    const plan = planDraftFromStructured({
      rrule: 'FREQ=DAILY;BYHOUR=8;BYMINUTE=0',
      description: '每天 8 点说明'
    });
    expect(plan.prompt).toBe('每天 8 点说明');
  });

  it('缺时间规则或缺 prompt 时返回 null（交给 LLM 解析兜底）', () => {
    expect(planDraftFromStructured({ prompt: '只有任务' })).toBeNull();
    expect(planDraftFromStructured({ rrule: 'FREQ=DAILY' })).toBeNull();
    expect(planDraftFromStructured(null)).toBeNull();
    expect(planDraftFromStructured(undefined)).toBeNull();
  });

  it('skillIds：结构化未给时用 opts.skillIds', () => {
    const plan = planDraftFromStructured(
      { rrule: 'FREQ=DAILY;BYHOUR=9', prompt: 'x' },
      { skillIds: ['s1'] }
    );
    expect(plan.skillIds).toEqual(['s1']);
  });

  it('给 goal.checks 时建目标型计划（无时间规则，命令原样落库）', () => {
    const plan = planDraftFromStructured({
      name: '把测试跑绿',
      prompt: '修复失败的测试直到全绿',
      goal: { checks: ['npm test', 'npm run lint'], cwd: 'E:\\proj' }
    });
    expect(plan.trigger).toBe('goal');
    expect(plan.rrule).toBe('');
    expect(plan.goal.checks.map((c) => c.command)).toEqual(['npm test', 'npm run lint']);
    expect(plan.goal.cwd).toBe('E:\\proj');
    expect(plan.enabled).toBe(true);
  });

  it('goal.checks 为空数组 = 未验证模式，仍是目标型', () => {
    const plan = planDraftFromStructured({
      prompt: '把文档重写成能读的样子',
      goal: { checks: [] }
    });
    expect(plan.trigger).toBe('goal');
    expect(plan.goal.checks).toEqual([]);
  });

  it('goal 优先于 rrule：同时给了也不会掉回定时型', () => {
    const plan = planDraftFromStructured({
      prompt: '跑绿',
      rrule: 'FREQ=DAILY;BYHOUR=9',
      goal: { checks: ['npm test'] }
    });
    expect(plan.trigger).toBe('goal');
    expect(plan.rrule).toBe('');
  });

  it('goal 但缺 checks 字段 → 不走结构化（不留一个猜出来的目标型计划）', () => {
    expect(planDraftFromStructured({ prompt: '跑绿', goal: { cwd: '/w' } })).toBeNull();
  });
});

describe('parsePlanFromText', () => {
  it('结构化可用时短路，不触发任何模型调用', async () => {
    // userData 指向不存在的目录也不会报错 —— 说明压根没走到 chatCompletion
    const plan = await parsePlanFromText('/definitely/missing/userdata', '每天 9 点跑', {
      structured: { rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0', prompt: '跑' },
      sessionId: 'sess-1'
    });
    expect(plan.rrule).toBe('FREQ=DAILY;BYHOUR=9;BYMINUTE=0');
    expect(plan.deliver).toEqual({ type: 'session', sessionId: 'sess-1' });
  });

  it('目标型结构化同样短路，命令原样保留', async () => {
    const plan = await parsePlanFromText('/definitely/missing/userdata', '做到全绿', {
      structured: { prompt: '把检查跑绿', goal: { checks: ['npm test'] } },
      sessionId: 'sess-1'
    });
    expect(plan.trigger).toBe('goal');
    expect(plan.goal.checks.map((c) => c.command)).toEqual(['npm test']);
  });

  it('目标型不绑定发起对话的会话（每轮记录进它自己的专用会话）', async () => {
    const plan = await parsePlanFromText('/definitely/missing/userdata', '做到全绿', {
      structured: { prompt: '把检查跑绿', goal: { checks: ['npm test'] } },
      sessionId: 'sess-1'
    });
    // 塞进聊天会淹没真人对话；ensurePlanSession 会为它建 [计划] 专用会话
    expect(plan.deliver).toEqual({ type: 'session', sessionId: '' });
  });
});
