'use strict';

const { buildExploreTools } = require('../../src/agent/planner-tool-filters');
const { isWriteTool } = require('../../src/agent/guardrails-shared');
const { isMutatingAgentTool } = require('../../src/agent/tool-classify');
const { buildCoreAgentRules } = require('../../src/agent/agent-system-prompt');
const { SUBAGENT_TOOL } = require('../../src/agent/tool-catalog');

function tool(name) {
  return { type: 'function', function: { name, description: name, parameters: { type: 'object' } } };
}

describe('explore mode', () => {
  it('buildExploreTools keeps only read-only tools and drops writes/exec/mcp', () => {
    const all = [
      'fs_read_file',
      'fs_list_dir',
      'grep',
      'glob',
      'lsp',
      'web_search',
      'web_fetch',
      'browser_snapshot',
      'sql_query',
      'fs_write_file',
      'fs_edit',
      'host_exec',
      'agent_clarify',
      'agents_md_propose',
      'mcp_server_tool',
      'graph'
    ].map(tool);

    const kept = buildExploreTools(all).map((t) => t.function.name);
    expect(kept).toEqual(
      expect.arrayContaining(['fs_read_file', 'fs_list_dir', 'grep', 'glob', 'lsp', 'web_search'])
    );
    expect(kept).not.toContain('fs_write_file');
    expect(kept).not.toContain('fs_edit');
    expect(kept).not.toContain('host_exec');
    expect(kept).not.toContain('agent_clarify');
    expect(kept).not.toContain('agents_md_propose');
    expect(kept).not.toContain('mcp_server_tool');

    // 硬保证：保留集合中不存在任何写工具（以护栏单一来源判定）
    for (const name of kept) {
      expect(isWriteTool(name)).toBe(false);
    }
  });

  // 不变式：Explore 白名单同时是「研究子 Agent 的工具集」。
  // 一旦 subagent 混进白名单，子 Agent 就能再派子 Agent，深度不再为 1。
  // 需要 subagent 的是协调者（Agent 主循环 / Explore 模式 / Plan explore 阶段），
  // 它们各自在自己的工具集上显式追加，而不是改这张表。
  it('buildExploreTools 永不包含 subagent —— 深度恒为 1 的结构性保证', () => {
    const all = [
      'fs_read_file',
      'fs_list_dir',
      'grep',
      'glob',
      'lsp',
      'web_search',
      'web_fetch',
      'subagent'
    ].map(tool);

    const kept = buildExploreTools(all).map((t) => t.function.name);
    expect(kept).not.toContain('subagent');
    expect(kept).toContain('grep');
  });

  it('subagent 与其它只读工具同属"可并发"分类', () => {
    expect(isMutatingAgentTool('subagent')).toBe(false);
    expect(SUBAGENT_TOOL.function.name).toBe('subagent');
    expect(isWriteTool('subagent')).toBe(false);
  });

  it('buildExploreTools tolerates null/undefined tool lists', () => {
    expect(buildExploreTools(null)).toEqual([]);
    expect(buildExploreTools(undefined)).toEqual([]);
  });

  it('injects explore rules only for explore composerMode', () => {
    const rules = buildCoreAgentRules({ composerMode: 'explore' });
    const text = Array.isArray(rules) ? rules.join('\n') : String(rules);
    expect(text).toContain('【探索】');
    expect(text).not.toContain('【编排】');

    const planRules = buildCoreAgentRules({ composerMode: 'plan' });
    const planText = Array.isArray(planRules) ? planRules.join('\n') : String(planRules);
    expect(planText).toContain('【编排】');
    expect(planText).not.toContain('【探索】');

    const agentRules = buildCoreAgentRules({ composerMode: 'agent' });
    const agentText = Array.isArray(agentRules) ? agentRules.join('\n') : String(agentRules);
    expect(agentText).not.toContain('【探索】');
    expect(agentText).not.toContain('【编排】');
  });

  // subagent 准则只注入「协调者」入口：Agent 主循环与 Explore 模式。
  // Plan 模式不走主循环（planner 编排），其 explore 阶段的指引在 Rust planner prompt，
  // 因此这里不能注入，避免同一份指引出现两处、并给出与真实工具集不符的承诺。
  it('subagent 准则只注入 agent / explore，不注入 plan', () => {
    const textOf = (mode) => {
      const rules = buildCoreAgentRules({ composerMode: mode });
      return Array.isArray(rules) ? rules.join('\n') : String(rules);
    };
    expect(textOf('agent')).toContain('【只读并发调研】');
    expect(textOf('explore')).toContain('【只读并发调研】');
    expect(textOf('plan')).not.toContain('【只读并发调研】');
  });
});
