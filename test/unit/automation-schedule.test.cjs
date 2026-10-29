'use strict';
/**
 * 定时任务调度字段「RRULE ⇄ 表单」的双向一致性（`src/renderer/renderer-automation-schedule.js`）。
 *
 * 该文件是纯浏览器脚本（`<script>` 直接加载，无 module.exports），这里用 `new Function`
 * 造一个最小 `window` 把 `DieyunAutomationSchedule` 取出来断言。守的是：
 * 1. 「每 N 分钟/小时/天」三种间隔单位各自映射到正确的 FREQ；
 * 2. 「总共执行多少次」→ COUNT，且与「生效结束」→ UNTIL 二选一（COUNT 优先）；
 * 3. 表单 → 规则 → 表单 往返不丢字段（exact 才允许回写）；
 * 4. 分钟间隔的下限钳制（别把额度打空）。
 */
const fs = require('node:fs');
const path = require('node:path');

const SRC = path.join(__dirname, '..', '..', 'src', 'renderer', 'renderer-automation-schedule.js');

function loadScheduleApi() {
  const win = {};
  const source = fs.readFileSync(SRC, 'utf8');
  const factory = new Function('window', `${source}\nreturn window.DieyunAutomationSchedule;`);
  return factory(win);
}

const api = loadScheduleApi();

/** 表单值 → rrule 文本（断言只看字符串，避免耦合对象形状） */
function build(input) {
  return api.buildAutomationRrule(input).rrule;
}

describe('buildAutomationRrule：间隔单位', () => {
  it('「每 2 小时」→ FREQ=HOURLY;INTERVAL=2', () => {
    expect(build({ tab: 'interval', intervalUnit: 'hour', intervalValue: 2 })).toBe(
      'FREQ=HOURLY;INTERVAL=2'
    );
  });

  it('「每 3 天」→ FREQ=DAILY;INTERVAL=3', () => {
    expect(build({ tab: 'interval', intervalUnit: 'day', intervalValue: 3 })).toBe(
      'FREQ=DAILY;INTERVAL=3'
    );
  });

  it('「每 N 分钟」保留 5 分钟下限（避免把模型额度打空）', () => {
    expect(build({ tab: 'interval', intervalUnit: 'minute', intervalValue: 1 })).toBe(
      'FREQ=MINUTELY;INTERVAL=5'
    );
    expect(build({ tab: 'interval', intervalUnit: 'minute', intervalValue: 30 })).toBe(
      'FREQ=MINUTELY;INTERVAL=30'
    );
  });

  it('单位缺省时按分钟处理（历史表单兼容）', () => {
    expect(build({ tab: 'interval', intervalValue: 45 })).toBe('FREQ=MINUTELY;INTERVAL=45');
  });
});

describe('buildAutomationRrule：总共执行次数（COUNT）', () => {
  it('填了次数就写 COUNT', () => {
    expect(build({ tab: 'interval', intervalUnit: 'hour', intervalValue: 1, runCount: 5 })).toBe(
      'FREQ=HOURLY;INTERVAL=1;COUNT=5'
    );
  });

  it('周期页签同样受次数约束', () => {
    expect(
      build({ tab: 'periodic', unit: 'day', hour: 9, minute: 0, runCount: '3' })
    ).toBe('FREQ=DAILY;BYHOUR=9;BYMINUTE=0;COUNT=3');
  });

  it('COUNT 与 UNTIL 互斥：两者都填时以次数为准', () => {
    expect(
      build({
        tab: 'periodic',
        unit: 'day',
        hour: 9,
        minute: 0,
        runCount: 3,
        untilDate: '2026-12-31'
      })
    ).toBe('FREQ=DAILY;BYHOUR=9;BYMINUTE=0;COUNT=3');
  });

  it('次数留空才用「生效结束」→ UNTIL', () => {
    const rrule = build({
      tab: 'periodic',
      unit: 'day',
      hour: 9,
      minute: 0,
      runCount: '',
      untilDate: '2026-12-31'
    });
    expect(rrule.startsWith('FREQ=DAILY;BYHOUR=9;BYMINUTE=0;UNTIL=')).toBe(true);
  });

  it('次数非法/非正数一律视为不限', () => {
    expect(build({ tab: 'interval', intervalUnit: 'hour', intervalValue: 1, runCount: -2 })).toBe(
      'FREQ=HOURLY;INTERVAL=1'
    );
    expect(build({ tab: 'interval', intervalUnit: 'hour', intervalValue: 1, runCount: 'abc' })).toBe(
      'FREQ=HOURLY;INTERVAL=1'
    );
  });
});

describe('automationScheduleFromPlan ⇄ buildAutomationRrule：往返', () => {
  const roundtrip = (rrule) => {
    const state = api.automationScheduleFromPlan({ rrule, onceAt: '', trigger: 'schedule' });
    return { state, rebuilt: build(state) };
  };

  it('「每 2 小时」完整可编辑（不再退化成分钟近似值）', () => {
    const { state, rebuilt } = roundtrip('FREQ=HOURLY;INTERVAL=2');
    expect(state.tab).toBe('interval');
    expect(state.intervalUnit).toBe('hour');
    expect(Number(state.intervalValue)).toBe(2);
    expect(state.exact).toBe(true);
    expect(rebuilt).toBe('FREQ=HOURLY;INTERVAL=2');
  });

  it('「每 3 天」归到间隔页签且保真', () => {
    const { state, rebuilt } = roundtrip('FREQ=DAILY;INTERVAL=3');
    expect(state.tab).toBe('interval');
    expect(state.intervalUnit).toBe('day');
    expect(Number(state.intervalValue)).toBe(3);
    expect(rebuilt).toBe('FREQ=DAILY;INTERVAL=3');
  });

  it('带 COUNT 的间隔规则回填出次数', () => {
    const { state, rebuilt } = roundtrip('FREQ=MINUTELY;INTERVAL=30;COUNT=4');
    expect(state.runCount).toBe('4');
    expect(state.exact).toBe(true);
    expect(rebuilt).toBe('FREQ=MINUTELY;INTERVAL=30;COUNT=4');
  });

  it('周期规则带 COUNT 时仍是周期页签，且次数回填', () => {
    const { state, rebuilt } = roundtrip('FREQ=DAILY;BYHOUR=21;BYMINUTE=30;COUNT=7');
    expect(state.tab).toBe('periodic');
    expect([state.hour, state.minute]).toEqual([21, 30]);
    expect(state.runCount).toBe('7');
    expect(rebuilt).toBe('FREQ=DAILY;BYHOUR=21;BYMINUTE=30;COUNT=7');
  });

  it('界面表达不了的规则标记 exact=false（不得按近似值回写）', () => {
    const { state } = roundtrip('FREQ=MONTHLY;BYMONTHDAY=1;BYHOUR=9');
    expect(state.exact).toBe(false);
  });

  it('间隔页签遇到 BYHOUR 这类它没有的控件时也标记 exact=false', () => {
    const { state } = roundtrip('FREQ=HOURLY;INTERVAL=2;BYMINUTE=15');
    expect(state.tab).toBe('interval');
    expect(state.exact).toBe(false);
  });

  it('超出界面上下限的间隔被钳制时标记 exact=false（显示值不是原规则）', () => {
    expect(roundtrip('FREQ=DAILY;INTERVAL=999').state.exact).toBe(false);
    expect(roundtrip('FREQ=MINUTELY;INTERVAL=2').state.exact).toBe(false);
  });
});
