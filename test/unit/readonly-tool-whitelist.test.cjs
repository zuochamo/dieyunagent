'use strict';

const {
  buildExploreTools,
  buildShellTools,
  READONLY_MCP_SERVER_IDS,
  READONLY_MCP_TOOL_PREFIXES,
  isReadOnlyMcpToolName
} = require('../../src/agent/planner-tool-filters');
const { encodeMcpToolName, mcpToolNamePrefix } = require('../../src/mcp/tool-name');
const { getBuiltinMcpById } = require('../../src/mcp/registry');
const { isWriteTool } = require('../../src/agent/guardrails-shared');
const { isMutatingAgentTool } = require('../../src/agent/tool-classify');
const { SUBAGENT_TOOL } = require('../../src/agent/tool-catalog');

function tool(name) {
  return { type: 'function', function: { name, description: name, parameters: { type: 'object' } } };
}

describe('只读工具白名单（研究子 Agent 的工具集）', () => {
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

  // 不变式：这张白名单就是「研究子 Agent 的工具集」（subagent-runner 直接用它）。
  // 一旦 subagent 混进白名单，子 Agent 就能再派子 Agent，深度不再为 1。
  // 需要 subagent 的是协调者（Agent 主循环），它在自己的工具集上显式追加，
  // 而不是改这张表。
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
});

// 数据库只读从内置 sql_* 迁到外部 PostgreSQL MCP 后，工具名变成 mcp_<serverId>__<tool>，
// 按名字的白名单必然匹配不到（表现为只读查库能力在只读阶段静默消失，不报错）。
// 放行名单把「服务端契约保证拒写」的 MCP 补回来。这里锁死四件事：
// 1) 名单内的服务放行；2) 可写 MCP 一概不放行；3) 放行后仍满足「纯只读 + 无 subagent」不变式；
// 4) 名单 id 与编码前缀不脱钩（改 id 漏改名单 → 测试失败，而不是静默失效）。
describe('只读 MCP 放行（Explore / Shell / 研究子 Agent）', () => {
  const pgQuery = encodeMcpToolName('mcp-postgres', 'query');
  const playwrightClick = encodeMcpToolName('mcp-playwright', 'browser_click');
  const githubWrite = encodeMcpToolName('mcp-github', 'create_issue');

  it('契约只读 MCP 的工具在 Explore / Shell 都放行', () => {
    const all = [pgQuery, 'fs_write_file', 'host_exec', 'agent_clarify'].map(tool);
    // Explore：写/执行/clarify 全部剔除，只读 MCP 保留
    expect(buildExploreTools(all).map((t) => t.function.name)).toEqual([pgQuery]);
    // Shell：白名单原有 host_exec 照旧，只读 MCP 一并放行
    expect(buildShellTools(all).map((t) => t.function.name)).toEqual([pgQuery, 'host_exec']);
  });

  it('可写 MCP 一律不放行（白名单的纯只读不变式优先）', () => {
    const all = [playwrightClick, githubWrite].map(tool);
    expect(buildExploreTools(all)).toEqual([]);
    expect(buildShellTools(all)).toEqual([]);
    expect(isReadOnlyMcpToolName(playwrightClick)).toBe(false);
    expect(isReadOnlyMcpToolName(githubWrite)).toBe(false);
  });

  it('放行的 MCP 仍满足「无写工具 + 无 subagent」硬约束', () => {
    const kept = buildExploreTools([pgQuery, 'subagent'].map(tool)).map((t) => t.function.name);
    expect(kept).toEqual([pgQuery]);
    for (const name of kept) {
      expect(isWriteTool(name)).toBe(false);
      expect(name).not.toBe(SUBAGENT_TOOL.function.name);
    }
  });

  it('名单 id 必须真实存在于 registry，且前缀由编码器生成（防脱钩）', () => {
    expect(READONLY_MCP_SERVER_IDS.length).toBeGreaterThan(0);
    for (const id of READONLY_MCP_SERVER_IDS) {
      expect(getBuiltinMcpById(id)).toBeTruthy();
      const prefix = mcpToolNamePrefix(id);
      expect(prefix).toBeTruthy();
      expect(READONLY_MCP_TOOL_PREFIXES).toContain(prefix);
      expect(encodeMcpToolName(id, 'query').startsWith(prefix)).toBe(true);
    }
  });

  it('不做前缀猜测：接近但不属于该服务的名字不放行', () => {
    expect(isReadOnlyMcpToolName('mcp_server_tool')).toBe(false);
    expect(isReadOnlyMcpToolName('mcp_postgres__query')).toBe(false);
    expect(isReadOnlyMcpToolName('fs_read_file')).toBe(false);
    expect(isReadOnlyMcpToolName('')).toBe(false);
  });

  // 已知边界（失败关闭，不是放行漏洞）：工具名超 64 字符时编码器走长名退化分支，
  // `mcp_<serverId>__` 前缀不再成立，故该工具在只读阶段不放行 —— 宁可少给，不按弱前缀误放行。
  it('超长工具名（长名退化分支）不放行', () => {
    const long = encodeMcpToolName('mcp-postgres', 'x'.repeat(80));
    expect(long.length).toBeLessThanOrEqual(64);
    expect(long.startsWith('mcp_mcp-postgres__')).toBe(false);
    expect(isReadOnlyMcpToolName(long)).toBe(false);
  });
});
