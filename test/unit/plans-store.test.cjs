'use strict';
/**
 * `PlansStore` 的计划字段与「总共执行多少次」收尾语义。
 *
 * 守三件事：
 * 1. 计划可以记住自己的工作空间（空 = 跟随执行时当前工作空间）；
 * 2. COUNT 计划的计数锚点只在对齐时机改一次 —— 新建/换规则对齐到下一次触发，
 *    普通编辑不重排（否则次数会被重新充满，永远跑不完）；
 * 3. 次数跑满后计划自动停用，不再挂着一条永远不会再跑却显示「启用中」的计划。
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { PlansStore } = require('../../src/plans/store');
const { msUntilNextRun } = require('../../src/plans/rrule-next');

function tmpStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dieyun-plans-'));
  return new PlansStore(dir);
}

/** 从 `now` 起把规则还会触发的时刻逐个走完（最多 limit 次） */
function drain(plan, now, limit = 20) {
  const hits = [];
  let cursor = now;
  for (let i = 0; i < limit; i += 1) {
    const ms = msUntilNextRun(plan, cursor);
    if (ms == null) break;
    cursor = new Date(cursor.getTime() + ms);
    hits.push(cursor);
  }
  return hits;
}

describe('PlansStore：工作空间', () => {
  afterEach(() => vi.useRealTimers());

  it('保存后原样读回（路径不做改写）', () => {
    const store = tmpStore();
    const plan = store.upsert({
      name: '每日巡检',
      prompt: '看看仓库状态',
      rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
      workspace: 'E:\\projects\\demo'
    });
    expect(store.get(plan.id).workspace).toBe('E:\\projects\\demo');
  });

  it('未指定时为空串 = 跟随执行时当前工作空间', () => {
    const store = tmpStore();
    const plan = store.upsert({
      name: '每日巡检',
      prompt: '看看仓库状态',
      rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0'
    });
    expect(store.get(plan.id).workspace).toBe('');
  });
});

describe('PlansStore：COUNT 计划的计数锚点', () => {
  afterEach(() => vi.useRealTimers());

  it('新建时把 dtstart 对齐到下一次触发，次数正好等于「还会跑几次」', () => {
    vi.useFakeTimers();
    const now = new Date(2026, 8, 21, 10, 7, 0);
    vi.setSystemTime(now);
    const store = tmpStore();
    const plan = store.upsert({
      name: '每半小时巡检',
      prompt: 'x',
      rrule: 'FREQ=MINUTELY;INTERVAL=30;COUNT=3'
    });
    expect(Date.parse(plan.dtstart)).toBeGreaterThan(now.getTime());
    expect(drain(plan, now)).toHaveLength(3);
  });

  it('普通编辑（规则没变）不重排锚点', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 8, 21, 10, 7, 0));
    const store = tmpStore();
    const first = store.upsert({
      name: '每半小时巡检',
      prompt: 'x',
      rrule: 'FREQ=MINUTELY;INTERVAL=30;COUNT=3'
    });
    const edited = store.upsert({ ...first, name: '改个名' });
    expect(edited.dtstart).toBe(first.dtstart);
  });

  it('改了频率规则则重新对齐（新规则重新计数）', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 8, 21, 10, 7, 0));
    const store = tmpStore();
    const first = store.upsert({
      name: 'p',
      prompt: 'x',
      rrule: 'FREQ=MINUTELY;INTERVAL=30;COUNT=3'
    });
    const next = store.upsert({ ...first, rrule: 'FREQ=MINUTELY;INTERVAL=60;COUNT=2' });
    expect(drain(next, new Date())).toHaveLength(2);
  });

  it('次数跑满后自动停用', () => {
    vi.useFakeTimers();
    const now = new Date(2026, 8, 21, 10, 7, 0);
    vi.setSystemTime(now);
    const store = tmpStore();
    const plan = store.upsert({
      name: 'p',
      prompt: 'x',
      rrule: 'FREQ=MINUTELY;INTERVAL=30;COUNT=3'
    });
    const hits = drain(plan, now);
    expect(hits).toHaveLength(3);
    vi.setSystemTime(new Date(hits[hits.length - 1].getTime() + 1000));
    store.updateRunResult(plan.id, { ok: true });
    expect(store.get(plan.id).enabled).toBe(false);
  });

  it('不限次数的计划跑完不会因为「没有下一次」被停用', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 8, 21, 10, 0, 0));
    const store = tmpStore();
    const plan = store.upsert({
      name: 'p',
      prompt: 'x',
      rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0'
    });
    store.updateRunResult(plan.id, { ok: true });
    expect(store.get(plan.id).enabled).toBe(true);
  });
});

describe('PlansStore：新建条数上限（机制上限，不是护栏旋钮）', () => {
  const { AGENT_LIMITS_DEFAULTS } = require('../../src/agent/agent-limits');

  it('到上限后拒绝**新建**，并给结构化错误码', () => {
    const store = tmpStore();
    const cap = AGENT_LIMITS_DEFAULTS.plansMaxCount;
    // 直接铺满内存里的计划列表：这里验的是「新建时挡」，不是磁盘 IO
    store.plans = Array.from({ length: cap }, (_, i) => ({ id: `p${i}`, enabled: false }));
    let err = null;
    try {
      store.upsert({ name: '再建一条', prompt: 'x', rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0' });
    } catch (e) {
      err = e;
    }
    expect(err).toBeTruthy();
    expect(err.code).toBe('PLANS_LIMIT');
    expect(String(err.message)).toContain(String(cap));
  });

  it('存量超限时**改**计划仍然可行（不把人锁死）', () => {
    const store = tmpStore();
    const cap = AGENT_LIMITS_DEFAULTS.plansMaxCount;
    store.plans = Array.from({ length: cap - 1 }, (_, i) => ({ id: `p${i}`, enabled: false }));
    const created = store.upsert({ name: '最后一格', prompt: 'x', rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0' });
    // 现在正好卡在上限；改这条已存在的计划不该被拦
    const edited = store.upsert({ ...created, name: '改个名' });
    expect(edited.name).toBe('改个名');
  });
});
