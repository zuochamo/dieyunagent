'use strict';

/**
 * MCP 工具定义的**两侧一致性**：同一份运行时目录条目，Main 侧（`mcpAgentTool`）与
 * Renderer 侧（`compactMcpToolDef(entry)`）必须产出逐字段相同的定义。
 *
 * 为什么要有这条：以前 Main 侧内联拼了一份**不瘦身**的定义，于是计划 / 频道 / headless
 * 每轮带的 MCP schema 比桌面聊天大一截（更容易撞上下文预算）；描述模板也在三处各写一遍。
 * 现在形状只有 `src/mcp/schema-slim.js` 一份，这条用例钉住「谁再拼一份就红」。
 */

const {
  compactMcpToolDef,
  mcpAgentTool,
  mcpCandidate,
  mcpToolDescription
} = require('../../src/mcp/schema-slim');

/** 模拟 `McpRuntimeManager#listAgentTools` 的条目（含深层嵌套 schema）。 */
const ITEM = {
  agentName: 'mcp_fs__read_file',
  serverId: 'fs',
  toolName: 'read_file',
  description: '读取文件  内容（带嵌套参数）',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '文件路径' },
      options: {
        type: 'object',
        properties: {
          deep: {
            type: 'object',
            properties: { deeper: { type: 'string', description: '再深一层' } }
          }
        }
      },
      retries: { type: 'array', items: { type: 'number' } }
    },
    required: ['path']
  }
};

/** Renderer 走的那条：先把目录条目拼成 catalog entry，再 `compactMcpToolDef`。 */
function rendererSideTool(item) {
  return compactMcpToolDef({
    id: item.agentName,
    tool: {
      type: 'function',
      function: {
        name: item.agentName,
        description: mcpToolDescription(item),
        parameters: item.inputSchema
      }
    },
    candidate: mcpCandidate(item)
  });
}

describe('MCP 工具定义两侧一致（Main ↔ Renderer）', () => {
  test('同一份条目产出的工具定义逐字段相同', () => {
    expect(mcpAgentTool(ITEM)).toEqual(rendererSideTool(ITEM));
  });

  test('描述带服务前缀且空白压缩成单空格', () => {
    expect(mcpAgentTool(ITEM).function.description).toBe(
      '[MCP · fs] 读取文件 内容（带嵌套参数）'
    );
  });

  test('参数 schema 走瘦身：再深一层的对象只留一句指引', () => {
    const params = mcpAgentTool(ITEM).function.parameters;
    expect(params.properties.options.type).toBe('object');
    expect(String(params.properties.options.properties.deep.description)).toContain(
      'mcp_tool_schema'
    );
    expect(params.required).toEqual(['path']);
  });

  test('没有列出参数时描述补上「用 mcp_tool_schema」', () => {
    const def = mcpAgentTool({ agentName: 'mcp_x__noop', serverId: 'x', toolName: 'noop' });
    expect(def.function.description).toContain('mcp_tool_schema');
  });

  test('候选项与描述同源（Main 召回用的那一份）', () => {
    expect(mcpCandidate(ITEM)).toEqual({
      id: 'mcp_fs__read_file',
      name: 'mcp_fs__read_file',
      description: '[MCP · fs] 读取文件 内容（带嵌套参数）',
      source: 'mcp',
      serverId: 'fs'
    });
  });
});
