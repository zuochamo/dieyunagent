'use strict';

const { createPlanRunTrace } = require('../../src/plans/plan-run-events');

function collect() {
  const updates = [];
  const trace = createPlanRunTrace({ onUpdate: (p) => updates.push(p) });
  return {
    trace,
    updates,
    last: () => updates[updates.length - 1] || { trace: [], streamContent: '' }
  };
}

describe('createPlanRunTrace', () => {
  it('把 llm_delta 的 reasoning 归约成思考行，正文单独走 streamContent', () => {
    const { trace, last } = collect();
    trace.handlePhase('start', {});
    trace.handlePhase('llm_request', { round: 0, model: 'm1' });
    trace.handlePhase('llm_delta', {
      round: 0,
      reasoning: '先看目录',
      content: '',
      hasToolCalls: false
    });
    trace.handlePhase('llm_delta', {
      round: 0,
      reasoning: '先看目录，再读文件',
      content: '答案是 42',
      hasToolCalls: false
    });

    const { trace: rows, streamContent } = last();
    expect(rows[0].phase).toBe('执行计划');
    expect(rows[0].thought).toBe('先看目录，再读文件');
    expect(streamContent).toBe('答案是 42');
  });

  it('工具先 pending 再落结果，且不把原始 result 整包带出', () => {
    const { trace, last } = collect();
    trace.handlePhase('llm_request', { round: 0, model: 'm1' });
    trace.handlePhase('llm_response', { round: 0, toolCalls: 1 });
    trace.handlePhase('delegate_start', {
      delegates: [{ id: 'c1', name: 'fs_read_file', arguments: { filePath: 'a.js' } }]
    });

    let row = last().trace[0];
    expect(row.tools).toHaveLength(1);
    expect(row.tools[0].pending).toBe(true);
    expect(row.tools[0].args.filePath).toBe('a.js');

    trace.handlePhase('delegate_result', {
      id: 'c1',
      name: 'fs_read_file',
      result: { path: 'a.js', content: 'x'.repeat(5000), ok: true }
    });

    row = last().trace[0];
    expect(row.tools[0].pending).toBe(false);
    expect(row.tools[0].result.content).toHaveLength(1200);
    expect(row.tools[0].result.path).toBe('a.js');
  });

  it('delegate_result 带上 error 时保留错误', () => {
    const { trace, last } = collect();
    trace.handlePhase('llm_request', { round: 0, model: 'm1' });
    trace.handlePhase('delegate_start', {
      delegates: [{ id: 'c9', name: 'host_exec', arguments: { command: 'x' } }]
    });
    trace.handlePhase('delegate_result', { id: 'c9', name: 'host_exec', error: 'boom' });
    expect(last().trace[0].tools[0].error).toBe('boom');
    expect(last().trace[0].tools[0].pending).toBe(false);
  });

  it('单通道模型：content 只进思考区，不写进正文', () => {
    const { trace, last } = collect();
    trace.handlePhase('llm_request', { round: 0, model: 'm1' });
    trace.handlePhase('llm_delta', { round: 0, reasoning: '', content: '思考内容', hasToolCalls: false });
    const { trace: rows, streamContent } = last();
    expect(rows[0].thought).toBe('思考内容');
    expect(streamContent).toBe('');
  });

  it('多轮 trace 按 round 递增且不共享可变对象', () => {
    const { trace, last } = collect();
    trace.handlePhase('llm_request', { round: 0, model: 'm1' });
    trace.handlePhase('llm_request', { round: 1, model: 'm1' });
    const rows = last().trace;
    expect(rows.map((r) => r.round)).toEqual([1, 2]);
    expect(rows[1].phase).toBe('执行计划 · 第 2 轮');
  });
});
