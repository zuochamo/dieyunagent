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
});
