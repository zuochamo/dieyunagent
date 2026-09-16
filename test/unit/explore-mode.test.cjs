'use strict';

const { buildExploreTools } = require('../../src/agent/planner-tool-filters');
const { isWriteTool } = require('../../src/agent/guardrails-shared');
const { buildCoreAgentRules } = require('../../src/agent/agent-system-prompt');

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
      'playbook_propose',
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
});
