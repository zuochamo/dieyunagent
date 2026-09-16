'use strict';

const catalog = require('../agent/tool-catalog');

/**
 * @param {import('../mcp/runtime-manager').McpRuntimeManager | null} mcpRuntime
 */
async function buildPlanAgentTools(mcpRuntime) {
  const tools = catalog.toolsByNames(catalog.PLAN_RUNTIME_TOOL_NAMES);
  if (!mcpRuntime || typeof mcpRuntime.listAgentTools !== 'function') {
    return tools;
  }
  try {
    const result = await mcpRuntime.listAgentTools({ catalogOnly: true });
    for (const item of result.tools || []) {
      if (!item || !item.agentName) continue;
      tools.push({
        type: 'function',
        function: {
          name: item.agentName,
          description: `[MCP · ${item.serverId || 'mcp'}] ${item.description || item.toolName || item.agentName}`,
          parameters:
            item.inputSchema && typeof item.inputSchema === 'object'
              ? item.inputSchema
              : { type: 'object', properties: {} }
        }
      });
    }
  } catch {
    // ignore
  }
  return tools;
}

module.exports = {
  buildPlanAgentTools,
  PLAN_HOST_TOOLS: catalog.toolsByNames(['host_exec', 'fs_read_file', 'fs_edit', 'fs_write_file', 'fs_list_dir']),
  PLAN_WEB_TOOLS: catalog.toolsByNames(['web_fetch', 'web_search'])
};
