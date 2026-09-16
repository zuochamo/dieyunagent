'use strict';

const { OPEN_API_MCP_DEFS } = require('./open-api-deploy-env');

/** 预装 MCP 服务（可通过设置 → 技能 → MCP 启用） */
const BUILTIN_MCP_SERVERS = [
  ...OPEN_API_MCP_DEFS.map((def) => ({
    id: def.id,
    name: def.name,
    description: def.description,
    bundledServer: 'dieyun-open-api',
    openApiService: def.service,
    command: 'bundled',
    args: [],
    defaultEnabled: false
  })),
  {
    id: 'mcp-sequential-thinking',
    name: 'Sequential Thinking',
    description: '结构化分步推理：复杂问题拆解为可追踪的思考链。',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-sequential-thinking'],
    defaultEnabled: false
  },
  {
    id: 'mcp-everything',
    name: 'MCP Everything（测试）',
    description: '官方 Everything 示例服务，用于验证 MCP 安装与 Agent 工具桥接。',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-everything'],
    defaultEnabled: false
  },
  {
    id: 'mcp-playwright',
    name: 'Playwright',
    description: 'Playwright 浏览器自动化 MCP（与叠云内置浏览器工具互补）。',
    command: 'npx',
    args: ['-y', '@playwright/mcp'],
    defaultEnabled: false
  },
  {
    id: 'mcp-context7',
    name: 'Context7',
    description: 'Context7 文档检索：查询开源库最新文档与示例（需联网）。',
    command: 'npx',
    args: ['-y', '@upstash/context7-mcp'],
    defaultEnabled: false
  },
  {
    id: 'mcp-github',
    name: 'GitHub',
    description: 'GitHub 仓库 / Issue / PR 操作。',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-github'],
    defaultEnabled: false,
    envHint: 'GITHUB_PERSONAL_ACCESS_TOKEN'
  },
  {
    id: 'mcp-brave-search',
    name: 'Brave 搜索',
    description: 'Brave Search API 网页搜索。',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-brave-search'],
    defaultEnabled: false,
    envHint: 'BRAVE_API_KEY'
  }
];

function listBuiltinMcpServers() {
  return BUILTIN_MCP_SERVERS.map((s) => ({ ...s }));
}

function getBuiltinMcpById(id) {
  return BUILTIN_MCP_SERVERS.find((s) => s.id === id) || null;
}

module.exports = {
  BUILTIN_MCP_SERVERS,
  listBuiltinMcpServers,
  getBuiltinMcpById
};
