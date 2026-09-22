'use strict';

const { msUntilNextRun } = require('../../src/plans/rrule-next');

function planOf(patch) {
  return { id: 'p1', enabled: true, rrule: '', onceAt: '', dtstart: '', ...patch };
}

/** 断言用：把「距现在多少毫秒」还原成本地时刻 */
function nextAt(plan, now) {
  const ms = msUntilNextRun(plan, now);
  return ms == null ? null : new Date(now.getTime() + ms);
}

/** 与 renderer-automation-schedule.js 的 untilSuffix 同款：本地当天 23:59:59 写成 UTC 时刻 */
function untilFromLocalEndOfDay(y, m, d) {
  const pad = (n) => String(n).padStart(2, '0');
  const end = new Date(y, m - 1, d, 23, 59, 59);
  return `${end.getUTCFullYear()}${pad(end.getUTCMonth() + 1)}${pad(end.getUTCDate())}T${pad(
    end.getUTCHours()
  )}${pad(end.getUTCMinutes())}${pad(end.getUTCSeconds())}Z`;
}

describe('msUntilNextRun：rrule 按本地时间触发', () => {
  it('「每天 09:00」落在本地 09:00（不再整体偏移一个时区）', () => {
    const now = new Date(2026, 8, 21, 6, 30, 0);
    const next = nextAt(planOf({ rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0', dtstart: now.toISOString() }), now);
    expect([next.getFullYear(), next.getMonth(), next.getDate()]).toEqual([2026, 8, 21]);
    expect([next.getHours(), next.getMinutes()]).toEqual([9, 0]);
  });

  it('当天该时刻已过 → 顺延到次日同一本地时刻', () => {
    const now = new Date(2026, 8, 21, 10, 0, 0);
    const next = nextAt(planOf({ rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0', dtstart: now.toISOString() }), now);
    expect([next.getDate(), next.getHours()]).toEqual([22, 9]);
  });

  it('「每周一 09:00」落在下一个周一本地 09:00', () => {
    const now = new Date(2026, 8, 21, 10, 0, 0); // 2026-09-21 是周一
    const next = nextAt(
      planOf({ rrule: 'FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0', dtstart: now.toISOString() }),
      now
    );
    expect(next.getDay()).toBe(1);
    expect([next.getMonth(), next.getDate(), next.getHours()]).toEqual([8, 28, 9]);
  });

  it('「每 30 分钟」不受墙钟换算影响', () => {
    const now = new Date(2026, 8, 21, 10, 7, 0);
    const ms = msUntilNextRun(
      planOf({ rrule: 'FREQ=MINUTELY;INTERVAL=30', dtstart: now.toISOString() }),
      now
    );
    expect(ms).toBe(30 * 60000);
  });

  it('生效开始（dtstart）在未来时不提前触发', () => {
    const now = new Date(2026, 8, 21, 10, 0, 0);
    const dtstart = new Date(2026, 8, 25, 0, 0, 0).toISOString();
    const next = nextAt(planOf({ rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0', dtstart }), now);
    expect([next.getDate(), next.getHours()]).toEqual([25, 9]);
  });

  it('生效结束（UNTIL）：最后一晚照跑，之后没有下一次', () => {
    const dtstart = new Date(2026, 8, 1, 0, 0, 0).toISOString();
    const rrule = `FREQ=DAILY;BYHOUR=20;BYMINUTE=0;UNTIL=${untilFromLocalEndOfDay(2026, 9, 30)}`;

    const lastNight = new Date(2026, 8, 30, 19, 0, 0);
    const next = nextAt(planOf({ rrule, dtstart }), lastNight);
    expect([next.getDate(), next.getHours()]).toEqual([30, 20]);

    const after = new Date(2026, 8, 30, 21, 0, 0);
    expect(msUntilNextRun(planOf({ rrule, dtstart }), after)).toBeNull();
  });
});

describe('msUntilNextRun：onceAt 与停用', () => {
  it('onceAt 是真实时刻，差值即到期毫秒数', () => {
    const now = new Date(2026, 8, 21, 8, 0, 0);
    const at = new Date(2026, 8, 21, 9, 0, 0);
    expect(msUntilNextRun(planOf({ onceAt: at.toISOString() }), now)).toBe(3600000);
  });

  it('onceAt 已过期 / 无规则 / 规则不可解析 / 已停用都为 null', () => {
    const now = new Date(2026, 8, 21, 10, 0, 0);
    const past = new Date(2026, 8, 20, 9, 0, 0).toISOString();
    expect(msUntilNextRun(planOf({ onceAt: past }), now)).toBeNull();
    expect(msUntilNextRun(planOf({}), now)).toBeNull();
    expect(msUntilNextRun(planOf({ rrule: 'FREQ=EVERYDAY;BYHOUR=9' }), now)).toBeNull();
    expect(msUntilNextRun(planOf({ rrule: 'FREQ=DAILY', enabled: false }), now)).toBeNull();
    expect(msUntilNextRun(null, now)).toBeNull();
  });
});
