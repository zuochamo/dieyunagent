'use strict';

/**
 * `session_new` 的目录接线（建会话 + 挂工作空间）。
 *
 * 这里只锁「它在不在、归谁执行、会不会被子 Agent 拿去用」这三件事：
 * 真正的建会话顺序是渲染器 createNewSession 的单源流程，不在单测里重演。
 */

const catalog = require('../../src/agent/tool-catalog');
const filters = require('../../src/agent/planner-tool-filters');

describe('session_new 工具接线', () => {
  it('注册在工具目录里，且 schema 带 workspacePath / title / prompt', () => {
    const tool = catalog.getToolByName('session_new');
    expect(tool).toBeTruthy();
    expect(tool.function.name).toBe('session_new');
    const props = tool.function.parameters.properties;
    expect(Object.keys(props).sort()).toEqual(['prompt', 'title', 'workspacePath']);
    // 工作空间可省略（沿用当前对话），所以没有必填项
    expect(tool.function.parameters.required).toEqual([]);
  });

  it('只有一个执行方：属于 RENDERER_ONLY_TOOLS（Main 只反委托）', () => {
    expect(catalog.RENDERER_ONLY_TOOLS).toContain('session_new');
    // 会话列表 / 当前会话都是渲染器状态，不能被列进 Main 侧静态工具白名单重复实现
    expect(catalog.PLAN_RUNTIME_TOOL_NAMES).not.toContain('session_new');
  });

  it('子 Agent 白名单里没有它：只读调研不得顺手切走用户的会话', () => {
    const lists = [filters.EXPLORE_TOOL_NAMES, filters.SHELL_TOOL_NAMES, filters.BUILD_TOOL_NAMES];
    for (const list of lists) {
      if (Array.isArray(list)) expect(list).not.toContain('session_new');
    }
  });
});
