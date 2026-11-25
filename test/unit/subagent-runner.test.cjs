'use strict';

const {
  createSubagentRunner,
  buildSubagentPrompt,
  resolveSubagentLimits,
  FALLBACK_LIMITS
} = require('../../src/agent/subagent-runner');
const { SUBAGENT_TOOL } = require('../../src/agent/tool-catalog');
const { isMutatingAgentTool } = require('../../src/agent/tool-classify');
const { AGENT_LIMITS_DEFAULTS, SCHEMA_BY_KEY } = require('../../src/agent/agent-limits');

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
  subagentMaxRounds: 48,
  subagentMaxToolCalls: 96,
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

  // 回归（2026-11-19）：**协调者**派发必须能用。以前调用方各自写 `subagentDepth`，
  // planner 的 explore 阶段写成 1，与默认 `subagentMaxDepth: 1` 相撞 ——
  // plan 模式的并发只读调研从上线起 100% 被拒（SUBAGENT_DEPTH_EXCEEDED）。
  // 现在深度语义只在 runner 里（`runFromCoordinator` = 协调者 0），两个入口都不再手写数字。
  it('lets the coordinator dispatch without hand-written depth', async () => {
    const runner = makeRunner({ subagentMaxDepth: 1 }, async () => ({ content: '结论：找到了' }));
    const out = await runner.runFromCoordinator({ task: 't' }, {});
    expect(out.errorCode).toBeUndefined();
    expect(out.ok).toBe(true);
    expect(out.summary).toContain('结论');
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
    expect(out.reason).toBe('empty');
    expect(out.summary).toContain('未产出结论');
  });

  // 回归（D3 契约，docs/REASONING-ISOLATION-PLAN.md §3.7）：内层循环被预算截断时，
  // 最后一轮常常只有 tool_calls、没有正文。若只看 content，就会把子 Agent 已经跑出来的
  // **工具事实**全部丢掉，只回一句「未产出结论」，协调者只能把同一块工作重做一遍。
  // 摘要必须把「被截断」和「工具调用记录」一起带上 —— 但**不得回注思考**：
  // 思考是子 Agent 的私有推理（含过程猜测与元评论），跨 Agent 越界会被主 Agent 当事实用。
  it('folds the child trace into the summary when the loop was cut off at budget', async () => {
    const runner = makeRunner({}, async () => ({
      content: '',
      hitRoundLimit: true,
      trace: [
        {
          round: 1,
          thought: '先列 llm 目录，确认有哪些 Python 文件与入口',
          tools: [{ name: 'glob', summary: 'llm/*.py 共 12 个文件' }]
        },
        {
          round: 2,
          thought: '路由装饰器集中在 llm/app.py 第 40 行附近，下一步看常量表',
          tools: [{ name: 'grep', summary: 'llm/app.py:40 route' }]
        }
      ]
    }));
    const out = await runner.run({ task: 't' }, {});
    expect(out.ok).toBe(true);
    expect(out.reason).toBe('limit');
    expect(out.summary).toContain('截断');
    expect(out.summary).toContain('工具调用记录');
    expect(out.summary).toContain('llm/app.py');
    expect(out.summary).toContain('grep');
    expect(out.summary).not.toContain('未产出结论');
    // D3：思考一律不回注（工具事实才回注）。
    expect(out.summary).not.toContain('先列 llm 目录');
    expect(out.summary).not.toContain('路由装饰器');
  });

  it('folds the child trace into the summary when the model gave no conclusion', async () => {
    const runner = makeRunner({}, async () => ({
      content: '   ',
      trace: [
        {
          round: 1,
          thought: '读完 llm 目录，鉴权入口在 llm/auth.py 的 login 函数',
          tools: [{ name: 'fs_read_file', summary: 'llm/auth.py' }]
        }
      ]
    }));
    const out = await runner.run({ task: 't' }, {});
    expect(out.reason).toBe('empty');
    expect(out.summary).toContain('llm/auth.py');
    expect(out.summary).not.toContain('未产出结论');
    // D3：思考里的结论（没写进正文）不得被当「发现」回注。
    expect(out.summary).not.toContain('鉴权入口在');
  });

  it('flags a budget-truncated conclusion that did carry content', async () => {
    const runner = makeRunner({}, async () => ({
      content: '结论：入口在 llm/app.py:40',
      hitRoundLimit: true
    }));
    const out = await runner.run({ task: 't' }, {});
    expect(out.reason).toBe('limit');
    expect(out.summary).toContain('llm/app.py:40');
    expect(out.summary).toContain('不完整');
  });

  // 回归（2026-11-19）：上游把工具调用**写成文本**（`<| |DSML| | invoke …>`），那一轮循环在
  // 「无 tool_calls 的文字 = 本轮结束」处收场，工具从未执行。这种「假正文」不能被当结论回注，
  // 否则协调者会把一段标记当成子 Agent 的调研结果。标记之前的正文保留（可能有用），并在
  // reason 上标 `tool-markup`，与「查完没查到（empty）」「预算截断（limit）」区分开。
  it('never hands leaked tool-call markup back as the conclusion', async () => {
    const runner = makeRunner({}, async () => ({
      content: [
        '桌面目录里两个 xlsx 同名不同后缀，先确认真身。',
        '<| |DSML| | calls>',
        '<| |DSML| | invoke name="host_exec">',
        '<| |DSML| | parameter name="command" string="true">dir /O:D</| |DSML| | parameter>',
        '</| |DSML| | invoke>',
        '</| |DSML| | calls>'
      ].join('\n'),
      trace: [
        {
          round: 1,
          thought: '先列目录',
          tools: [{ name: 'fs_list_dir', summary: 'Desktop 共 12 项' }]
        }
      ]
    }));
    const out = await runner.run({ task: 't' }, {});
    expect(out.ok).toBe(true);
    expect(out.reason).toBe('tool-markup');
    expect(out.summary).toContain('把工具调用写成了文本');
    expect(out.summary).toContain('桌面目录里两个 xlsx');
    expect(out.summary).not.toContain('DSML');
    expect(out.summary).not.toContain('host_exec');
  });

  it('falls back to the child trace facts when only markup came back', async () => {
    const runner = makeRunner({}, async () => ({
      content: '<| |DSML| | invoke name="host_exec"></| |DSML| | invoke>',
      trace: [
        { round: 1, thought: '列目录', tools: [{ name: 'fs_list_dir', summary: 'Desktop 共 12 项' }] }
      ]
    }));
    const out = await runner.run({ task: 't' }, {});
    expect(out.reason).toBe('tool-markup');
    expect(out.summary).toContain('工具调用记录');
    expect(out.summary).toContain('fs_list_dir');
    expect(out.summary).not.toContain('DSML');
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

  it('label 只认派发方显式给的名字：没给就留空（卡片标题退回「类型 + 序号」）', async () => {
    const runner = makeRunner();
    expect((await runner.run({ task: 't', label: '鉴权入口' }, {})).label).toBe('鉴权入口');
    // 曾经会默认拼「调研 N」，于是卡片显示成「调研子 Agent #1 · 调研 1」：序号说两遍，
    // 反而挤掉了「这次在查什么」这一唯一有用信息。现在缺省留空，由标题退回序号形态。
    const noLabel = await runner.run({ task: 't' }, {});
    expect(noLabel.label).toBe('');
    expect(noLabel.subagentId).toBe('sa-explore-2');
  });

  // `subagent_status`：把 runner **已有的**账本（issued / active / waiters / followups）
  // 只读投影给模型。存在的唯一理由：追问要的 subagentId 只活在本轮内存 LRU 里，
  // 模型不能靠回忆猜（猜错就 SUBAGENT_FOLLOWUP_NOT_FOUND，然后整块调研重做）。
  // 因此这里守三件事：不新增状态、只给事实、子 Agent（深度 1）永远拿不到它。
  it('projects the existing ledger through status()', () => {
    const runner = makeRunner({ subagentMaxConcurrent: 2, subagentMaxPerRun: 5 });
    expect(runner.statusToolName).toBe('subagent_status');
    const empty = runner.status();
    expect(empty.ok).toBe(true);
    expect(empty.dispatched).toBe(0);
    expect(empty.active).toBe(0);
    expect(empty.queued).toBe(0);
    expect(empty.continuable).toEqual([]);
    expect(empty.limits).toMatchObject({
      perRun: 5,
      concurrent: 2,
      maxDepth: LIMITS.subagentMaxDepth
    });
  });

  it('lists continuable subagents by id + original task, and truncates the task', async () => {
    const loop = async (req) => ({
      content: 'ok',
      messages: [...req.messages, { role: 'assistant', content: 'ok' }]
    });
    const runner = makeRunner(
      { subagentFollowupRetention: 8, subagentStatusTaskMaxChars: 6 },
      loop
    );
    const a = await runner.run({ task: '鉴权入口在哪个模块' }, {});
    const b = await runner.run({ task: '短问题' }, {});
    const st = runner.status();
    expect(st.dispatched).toBe(2);
    expect(st.active).toBe(0);
    expect(st.continuable.map((c) => c.subagentId)).toEqual([a.subagentId, b.subagentId]);
    // 事实原样投影（截断只截长的，短的不动）
    expect(st.continuable[1].task).toBe('短问题');
    expect(st.continuable[0].task).toBe('鉴权入口在哪…');
  });

  // 回归：错误文案以前只说「请不带 continueFrom 重新派发」——那等于让模型重派整块调研。
  // 现在把「当前可续用的 id」摆在错误里，模型能自己改参数自救。
  it('names the available ids when continueFrom is unknown', async () => {
    const loop = async (req) => ({
      content: 'ok',
      messages: [...req.messages, { role: 'assistant', content: 'ok' }]
    });
    const runner = makeRunner({ subagentFollowupRetention: 8 }, loop);
    const a = await runner.run({ task: '查鉴权入口' }, {});
    const miss = await runner.run({ task: 'x', continueFrom: 'ghost' }, {});
    expect(miss.errorCode).toBe('SUBAGENT_FOLLOWUP_NOT_FOUND');
    expect(miss.error).toContain('ghost');
    expect(miss.error).toContain(a.subagentId);
  });

  it('never hands subagent_status to a child agent (depth stays 1)', () => {
    const runner = createSubagentRunner({
      allTools: [tool('grep'), tool('subagent'), tool('subagent_status')],
      limits: LIMITS,
      runChildLoop: async () => ({ content: 'ok' })
    });
    expect(runner.childToolNames()).toContain('grep');
    expect(runner.childToolNames()).not.toContain('subagent');
    expect(runner.childToolNames()).not.toContain('subagent_status');
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

  // 护栏数字的唯一来源是 agent-limits.js。兜底值若另写一份字面量，改预算就只会改到一半：
  // 有 userDataPath 的走新值、Renderer/测试走的还是旧值，两边行为悄悄分叉。
  it('derives fallback limits from the agent-limits single source', () => {
    for (const key of Object.keys(FALLBACK_LIMITS)) {
      expect(FALLBACK_LIMITS[key]).toBe(AGENT_LIMITS_DEFAULTS[key]);
    }
    // 放宽后的轮次预算必须真的落在 schema 的 min/max 之间，否则设置页会把它夹回去。
    // 第三次放宽：48/96 → 160/320（2026-11-19：执行器跑到 96 轮仍在有效推进，被硬上限截断）。
    expect(FALLBACK_LIMITS.subagentMaxRounds).toBe(160);
    expect(FALLBACK_LIMITS.subagentMaxToolCalls).toBe(320);
    // 不变式：默认值落在设置页 min/max 内，且**低于**上限，保证用户仍能手动上调。
    for (const key of ['subagentMaxRounds', 'subagentMaxToolCalls']) {
      const item = SCHEMA_BY_KEY.get(key);
      expect(item).toBeTruthy();
      expect(FALLBACK_LIMITS[key]).toBeGreaterThanOrEqual(item.min);
      expect(FALLBACK_LIMITS[key]).toBeLessThan(item.max);
    }
  });
});
