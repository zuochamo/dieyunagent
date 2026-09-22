'use strict';

const { PlansScheduler } = require('../../src/plans/scheduler');

const TIMER_MAX_MS = 2147483647;

function makeScheduler(plan, runs) {
  return new PlansScheduler({
    getPlans: () => [plan],
    runPlan: async () => {
      runs.push(new Date());
    }
  });
}

describe('PlansScheduler', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('「每天 09:00」在本地 09:00 触发', () => {
    vi.useFakeTimers();
    const now = new Date(2026, 8, 21, 6, 0, 0);
    vi.setSystemTime(now);
    const plan = {
      id: 'p1',
      name: '早报',
      enabled: true,
      onceAt: '',
      rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
      dtstart: now.toISOString()
    };
    const runs = [];
    makeScheduler(plan, runs).reload();

    vi.advanceTimersByTime(3 * 3600000 - 1);
    expect(runs).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(runs).toHaveLength(1);
    expect(runs[0].getHours()).toBe(9);
  });

  it('远期计划不会在 setTimeout 上限处提前触发', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 8, 21, 10, 0, 0));
    const plan = {
      id: 'p2',
      name: '一次性',
      enabled: true,
      rrule: '',
      onceAt: new Date(2026, 9, 21, 10, 0, 0).toISOString() // 30 天后
    };
    const runs = [];
    makeScheduler(plan, runs).reload();

    vi.advanceTimersByTime(TIMER_MAX_MS);
    expect(runs).toHaveLength(0);
    vi.advanceTimersByTime(7 * 86400000);
    expect(runs).toHaveLength(1);
  });
});
