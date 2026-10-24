'use strict';
/**
 * 冻结取证落盘去重。
 *
 * PerformanceObserver 一次回调可能带多条 longtask，渲染侧对每条都会上报一次快照，
 * 实测同一 `at` 在 main.log 里连落两行（第二行只多了最后一条 longtask）。
 * 去重放在唯一落盘口 `reportRendererFreeze`，但不能波及窗口生命周期事件。
 */
const assert = require('node:assert/strict');
const { createRendererFreezeReporter } = require('../../src/main/ipc/renderer-freeze.js');

function makeReporter() {
  const lines = [];
  const reporter = createRendererFreezeReporter({
    app: { getAppMetrics: () => [] },
    log: { error: (line) => lines.push(line) },
    getMainWindow: () => null
  });
  return { reporter, lines };
}

const SNAPSHOT = {
  kind: 'longtask',
  at: 1792203760648,
  perfNow: 63228889,
  sessionId: 's-1',
  longTasks: [{ start: 63225989, duration: 1538 }]
};

describe('freeze 快照落盘去重', () => {
  it('同秒同会话同 kind 的第二条快照不落盘', () => {
    const { reporter, lines } = makeReporter();
    reporter.reportRendererFreeze('snapshot', SNAPSHOT);
    reporter.reportRendererFreeze('snapshot', {
      ...SNAPSHOT,
      longTasks: [...SNAPSHOT.longTasks, { start: 63227915, duration: 964 }]
    });
    assert.equal(lines.length, 1);
  });

  it('跨秒的同 kind 快照照常落盘', () => {
    const { reporter, lines } = makeReporter();
    reporter.reportRendererFreeze('snapshot', SNAPSHOT);
    reporter.reportRendererFreeze('snapshot', { ...SNAPSHOT, at: SNAPSHOT.at + 1200 });
    assert.equal(lines.length, 2);
  });

  it('不同 kind / 不同会话不互相吞掉', () => {
    const { reporter, lines } = makeReporter();
    reporter.reportRendererFreeze('snapshot', SNAPSHOT);
    reporter.reportRendererFreeze('snapshot', { ...SNAPSHOT, kind: 'beat-lag', lagMs: 5000 });
    reporter.reportRendererFreeze('snapshot', { ...SNAPSHOT, sessionId: 's-2' });
    assert.equal(lines.length, 3);
  });

  it('窗口生命周期事件永不按快照规则去重', () => {
    const { reporter, lines } = makeReporter();
    reporter.reportRendererFreeze('unresponsive', SNAPSHOT);
    reporter.reportRendererFreeze('unresponsive', SNAPSHOT);
    reporter.reportRendererFreeze('render-process-gone', SNAPSHOT);
    assert.equal(lines.length, 3);
  });
});
