import { describe, it, expect } from 'vitest';

const { buildTraceGraph, laneLabel } = require('../../src/agent/trace-graph.js');

const T = 1_700_000_000_000;

describe('trace-graph / 泳道整形', () => {
  it('主线 + 一个并发子 Agent：两条泳道，时间范围覆盖双方', () => {
    const trace = [
      { round: 1, phase: '思考', startedAt: T, endedAt: T + 1000, tools: [{ name: 'grep' }] },
      { round: 2, phase: '思考', startedAt: T + 1000, endedAt: T + 2000, tools: [{ name: 'fs_edit', failed: true }] },
      {
        isolated: true,
        subagentId: 'sa-write-1',
        phase: '写入子 Agent #1 · 已完成',
        startedAt: T + 500,
        endedAt: T + 4000,
        rounds: [
          { round: 1, startedAt: T + 500, endedAt: T + 2500, tools: [{ name: 'fs_read_file' }] },
          { round: 2, startedAt: T + 2500, endedAt: T + 4000, tools: [{ name: 'fs_edit' }] }
        ]
      }
    ];
    const g = buildTraceGraph(trace, { now: T + 5000 });
    expect(g.degraded).toBe(false);
    expect(g.lanes).toHaveLength(2);
    expect(g.lanes[0].id).toBe('main');
    expect(g.lanes[1].kind).toBe('subagent');
    expect(g.lanes[1].label).toBe('写入子 Agent #1');
    expect(g.lanes[1].spans).toHaveLength(2);
    expect(g.range).toEqual({ start: T, end: T + 4000, unit: 'ms' });
    expect(g.totals.tools).toBe(4);
    expect(g.totals.failed).toBe(1);
    expect(g.totals.wallMs).toBe(4000);
  });

  it('并发关系可读：两条子 Agent 泳道的时间区间重叠', () => {
    const trace = [
      { isolated: true, subagentId: 'a', phase: '写入子 Agent #1', rounds: [{ round: 1, startedAt: T, endedAt: T + 1000 }] },
      { isolated: true, subagentId: 'b', phase: '写入子 Agent #2', rounds: [{ round: 1, startedAt: T + 200, endedAt: T + 900 }] }
    ];
    const g = buildTraceGraph(trace, { now: T + 2000 });
    const a = g.lanes.find((l) => l.id === 'a').spans[0];
    const b = g.lanes.find((l) => l.id === 'b').spans[0];
    expect(a.start < b.end && b.start < a.end).toBe(true); // 真的重叠 = 并行
  });

  it('没有时间戳 → degraded，按序号等宽铺（不谎报时长）', () => {
    const trace = [
      { round: 1, phase: '思考', tools: [] },
      { round: 2, phase: '思考', tools: [{ name: 'grep' }] }
    ];
    const g = buildTraceGraph(trace, { now: T });
    expect(g.degraded).toBe(true);
    expect(g.range.unit).toBe('index');
    expect(g.lanes[0].spans.map((s) => s.start)).toEqual([0, 1]);
    expect(g.totals.wallMs).toBe(0);
  });

  it('卡片只有整体时间、没有逐轮时间 → 用卡片起止画一个 span 且不算降级', () => {
    const trace = [
      {
        isolated: true,
        subagentId: 'a',
        phase: '写入子 Agent #1',
        startedAt: T,
        endedAt: T + 3000,
        rounds: [{ round: 1, tools: [{ name: 'fs_edit' }] }, { round: 2, tools: [] }]
      }
    ];
    const g = buildTraceGraph(trace, { now: T + 9000 });
    expect(g.degraded).toBe(false);
    expect(g.lanes[0].spans).toHaveLength(1);
    expect(g.lanes[0].spans[0].start).toBe(T);
    expect(g.lanes[0].spans[0].tools).toBe(1);
  });

  it('运行中的 span 收在 now（不画成负宽度）', () => {
    const trace = [{ round: 1, phase: '思考', startedAt: T, tools: [] }];
    const g = buildTraceGraph(trace, { now: T + 1500 });
    const s = g.lanes[0].spans[0];
    expect(s.running).toBe(true);
    expect(s.end).toBe(T + 1500);
    expect(g.lanes[0].status).toBe('running');
  });

  it('空 trace 不炸，返回空泳道', () => {
    const g = buildTraceGraph([], { now: T });
    expect(g.lanes).toHaveLength(0);
    expect(g.totals.spans).toBe(0);
  });

  it('没有时间戳 ≠ 运行中：老数据不许被画成「还在跑」', () => {
    const g = buildTraceGraph([{ round: 1, phase: '思考', tools: [] }], { now: T });
    const span = g.lanes[0].spans[0];
    expect(span.running).toBe(false);
    expect(g.lanes[0].status).toBe('done');
  });

  it('泳道名去掉状态后缀，但保留真标题', () => {
    expect(laneLabel({ phase: '写入子 Agent #3 · 已完成' })).toBe('写入子 Agent #3');
    expect(laneLabel({ phase: '写入子 Agent #3 · 同步 README 与 AGENTS.md' })).toBe(
      '写入子 Agent #3 · 同步 README 与 AGENTS.md'
    );
  });
});
