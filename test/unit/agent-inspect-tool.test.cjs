'use strict';

/**
 * `agent_inspect` 的接线（工具在不在、给谁、带不带参数）。
 *
 * 它存在的理由是「模型能问自己」：档位 / 真实可写根 / 生效预算 / 最近失败面。
 * 这里只锁接线三件事，事实本身由执行体直测（`scripts/test-tool-bridge-handlers.cjs`）覆盖：
 * 1. 注册在 catalog 里，且**没有参数**（这是它不会被误用成写工具的前提）；
 * 2. Main 侧那些没有设置页的档位（计划 / 频道 / headless / peer 来信）也能看见它；
 * 3. 它不是渲染器专属工具（否则后台轮次永远调不到）。
 */

const catalog = require('../../src/agent/tool-catalog');

describe('agent_inspect 工具接线', () => {
  it('catalog 里有它，且不收任何参数', () => {
    const tool = catalog.getToolByName('agent_inspect');
    expect(tool).toBeTruthy();
    expect(tool.function.name).toBe('agent_inspect');
    const params = tool.function.parameters;
    expect(params.type).toBe('object');
    expect(Object.keys(params.properties || {})).toEqual([]);
    expect(params.required).toBeUndefined();
  });

  it('进静态工具表，也进 Main 侧运行档（计划 / 频道 / headless / peer 来信）', () => {
    expect(catalog.ALL_STATIC_TOOLS.map((t) => t.function.name)).toContain('agent_inspect');
    expect(catalog.PLAN_RUNTIME_TOOL_NAMES).toContain('agent_inspect');
    expect(catalog.RENDERER_ONLY_TOOLS).not.toContain('agent_inspect');
  });

  it('描述里写清「只读、只报事实」—— 免得被当成修改入口', () => {
    const desc = catalog.getToolByName('agent_inspect').function.description;
    expect(desc).toContain('只读');
    expect(desc).toContain('事实');
  });
});

describe('agent_capability 工具接线', () => {
  it('catalog 里有它，只有 action / kind / reason 三个参数', () => {
    const tool = catalog.getToolByName('agent_capability');
    expect(tool).toBeTruthy();
    const props = tool.function.parameters.properties;
    expect(Object.keys(props).sort()).toEqual(['action', 'kind', 'reason']);
    expect(tool.function.parameters.required).toEqual(['action']);
    // request 时必须给 kind（条件必填只写在 schema 里，不写进手写校验）
    expect(Array.isArray(tool.function.parameters.allOf)).toBe(true);
  });

  it('Main 侧与渲染器两侧都能看见（后台轮次也要能申请/复查）', () => {
    expect(catalog.ALL_STATIC_TOOLS.map((t) => t.function.name)).toContain('agent_capability');
    expect(catalog.PLAN_RUNTIME_TOOL_NAMES).toContain('agent_capability');
    expect(catalog.RENDERER_ONLY_TOOLS).not.toContain('agent_capability');
  });

  it('描述里不承诺提权（开关永远由用户按）', () => {
    const desc = catalog.getToolByName('agent_capability').function.description;
    expect(desc).toContain('不会给你提权');
  });
});
