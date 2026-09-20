'use strict';

const {
  createSubagentRunner,
  buildSubagentPrompt,
  resolveSubagentLimits,
  FALLBACK_LIMITS
} = require('../../src/agent/subagent-runner');
const { SUBAGENT_TOOL } = require('../../src/agent/tool-catalog');
const { isMutatingAgentTool } = require('../../src/agent/tool-classify');

function tool(name) {
  return { type: 'function', function: { name, description: name, parameters: { type: 'object' } } };
}

const ALL_TOOLS = [
  'fs_read_file',
  'fs_list_dir',
  'grep',
  'glob',
  'lsp',
  'web_search',
  'fs_write_file',
  'fs_edit',
  'host_exec',
  'subagent'
].map(tool);

const LIMITS = {
  subagentMaxDepth: 1,
  subagentMaxConcurrent: 3,
  subagentMaxPerRun: 8,
  subagentMaxRounds: 16,
  subagentMaxToolCalls: 32,
  subagentSummaryMaxChars: 2400
};

/**
 * @param {object} [limitOverrides]
 * @param {(req: any, meta: any) => Promise<any>} [loopImpl]
 */
function makeRunner(limitOverrides = {}, loopImpl) {
  return createSubagentRunner({
    allTools: ALL_TOOLS,
    limits: { ...LIMITS, ...limitOverrides },
    runChildLoop: loopImpl || (async () => ({ content: '结论：找到了' }))
  });
}

describe('subagent runner', () => {
  it('requires runChildLoop', () => {
    expect(() => createSubagentRunner({ allTools: ALL_TOOLS })).toThrow(/runChildLoop/);
  });

  it('exposes the tool name from the catalog single source', () => {
    expect(makeRunner().toolName).toBe('subagent');
    expect(SUBAGENT_TOOL.function.name).toBe('subagent');
  });

  // 核心不变式：子 Agent 的工具集是 Explore 只读白名单，且不含 subagent。
  // 这同时保证「只读」与「深度恒为 1」两件事，不需要运行期判断。
  it('gives the child loop only read-only tools, without subagent', () => {
    const names = makeRunner().childToolNames();
    expect(names).not.toContain('subagent');
    expect(names).not.toContain('fs_write_file');
    expect(names).not.toContain('fs_edit');
    expect(names).not.toContain('host_exec');
    expect(names).toContain('grep');
    for (const name of names) {
      expect(isMutatingAgentTool(name)).toBe(false);
    }
  });

  it('passes the read-only tool set and per-child budget to the child loop', async () => {
    let seen = null;
    const runner = makeRunner({ subagentMaxRounds: 7, subagentMaxToolCalls: 9 }, async (req) => {
      seen = req;
      return { content: 'ok' };
    });
    await runner.run({ task: 't' }, {});
    expect(seen.maxRounds).toBe(7);
    expect(seen.maxToolCalls).toBe(9);
    expect(seen.tools.some((t) => t.function.name === 'grep')).toBe(true);
    expect(seen.tools.some((t) => t.function.name === 'subagent')).toBe(false);
    expect(seen.messages).toHaveLength(1);
    expect(seen.messages[0].role).toBe('user');
  });

  it('rejects recursion with a structured error instead of throwing', async () => {
    const out = await makeRunner().run({ task: 'x' }, { subagentDepth: 1 });
    expect(out.errorCode).toBe('SUBAGENT_DEPTH_EXCEEDED');
    expect(out.summary).toBeUndefined();
  });

  it('rejects a missing task with a structured error', async () => {
    const out = await makeRunner().run({}, {});
    expect(out.errorCode).toBe('SUBAGENT_TASK_REQUIRED');
  });

  // 只读工具在 delegate-batch 走的是无限并发分支，所以限流必须在这里生效。
  it('never exceeds subagentMaxConcurrent', async () => {
    let active = 0;
    let peak = 0;
    const runner = makeRunner({ subagentMaxConcurrent: 2, subagentMaxPerRun: 10 }, async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active -= 1;
      return { content: 'ok' };
    });

    await Promise.all([1, 2, 3, 4, 5].map((i) => runner.run({ task: `t${i}` }, {})));
    expect(peak).toBeLessThanOrEqual(2);
    expect(runner.stats().issued).toBe(5);
  });

  it('stops dispatching once subagentMaxPerRun is reached', async () => {
    const runner = makeRunner({ subagentMaxPerRun: 1 });
    expect((await runner.run({ task: 'a' }, {})).ok).toBe(true);
    const second = await runner.run({ task: 'b' }, {});
    expect(second.errorCode).toBe('SUBAGENT_BUDGET_EXCEEDED');
  });

  it('truncates an over-long conclusion and flags it', async () => {
    const runner = makeRunner({ subagentSummaryMaxChars: 50 }, async () => ({
      content: 'x'.repeat(400)
    }));
    const out = await runner.run({ task: 't' }, {});
    expect(out.truncated).toBe(true);
    expect(out.summary.length).toBeLessThan(400);
    expect(out.summary).toContain('已截断');
  });

  it('reports an empty conclusion without inventing one', async () => {
    const runner = makeRunner({}, async () => ({ content: '   ' }));
    const out = await runner.run({ task: 't' }, {});
    expect(out.truncated).toBe(false);
    expect(out.summary).toContain('未产出结论');
  });

  it('converges a child loop failure into a structured error', async () => {
    const runner = makeRunner({}, async () => {
      throw new Error('boom');
    });
    const out = await runner.run({ task: 't' }, {});
    expect(out.errorCode).toBe('SUBAGENT_FAILED');
    expect(out.error).toContain('boom');
  });

  it('propagates cancellation and never issues the child request', async () => {
    let called = false;
    const runner = makeRunner({}, async () => {
      called = true;
      return { content: 'ok' };
    });
    await expect(runner.run({ task: 't' }, { signal: { aborted: true } })).rejects.toThrow();
    expect(called).toBe(false);
  });

  it('reports SUBAGENT_NO_TOOLS when nothing read-only is available', async () => {
    const runner = createSubagentRunner({
      allTools: [tool('fs_write_file'), tool('host_exec')],
      limits: LIMITS,
      runChildLoop: async () => ({ content: 'ok' })
    });
    const out = await runner.run({ task: 't' }, {});
    expect(out.errorCode).toBe('SUBAGENT_NO_TOOLS');
  });

  it('labels children and falls back to an index-based label', async () => {
    const runner = makeRunner();
    expect((await runner.run({ task: 't', label: '鉴权入口' }, {})).label).toBe('鉴权入口');
    expect((await runner.run({ task: 't' }, {})).label).toBe('调研 2');
  });

  it('builds a read-only, conclusion-first prompt including hints', () => {
    const prompt = buildSubagentPrompt('定位鉴权入口', ['src/auth', '  ', 'src/gateway']);
    expect(prompt).toContain('只读');
    expect(prompt).toContain('定位鉴权入口');
    expect(prompt).toContain('src/auth');
    expect(prompt).toContain('src/gateway');
    expect(prompt).toContain('结论先行');
    expect(prompt).not.toContain('  \n');
  });

  it('falls back to defaults without a userDataPath', () => {
    expect(resolveSubagentLimits()).toEqual(FALLBACK_LIMITS);
    expect(resolveSubagentLimits('')).toEqual(FALLBACK_LIMITS);
  });
});
