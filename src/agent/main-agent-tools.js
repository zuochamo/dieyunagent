'use strict';

const catalog = require('./tool-catalog');

/**
 * Main 侧（无 Renderer）工具清单的唯一构造函数。
 *
 * 聊天路径的完整工具集在 Renderer（`renderer-tool-defs.js#buildAgentTools`，依赖编辑器态与
 * 权限快照），Main 侧跑一轮的调用方（定时计划、频道）只能用「静态工具 + MCP 工具」这一档：
 * 它们没有编辑器上下文，也不该替用户开新会话/弹澄清框。
 *
 * @param {import('../mcp/runtime-manager').McpRuntimeManager | null} mcpRuntime
 * @returns {Promise<Array<object>>} OpenAI 工具 schema 列表
 */
async function buildMainAgentTools(mcpRuntime) {
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
    // MCP 不可用不该让整轮跑不起来：静态工具已经够跑完本轮
  }
  return tools;
}

module.exports = { buildMainAgentTools };
