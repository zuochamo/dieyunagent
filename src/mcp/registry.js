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
  },
  {
    // 版本与 --stdio 是该包的行为契约（写死在 AST 层拒写、不带参数会改成开 HTTP 服务），
    // 浮动版本会让预装行为静默变化，故锁定版本；升级需同时确认 --stdio 与只读语义未变。
    // 「服务端契约保证拒写」→ 只读阶段（Explore / Shell / 研究子 Agent）放行，
    // 放行名单唯一来源是 agent/planner-tool-filters.js 的 READONLY_MCP_SERVER_IDS。
    //
    // bundledServer：该服务**离线预装**随客户端分发（scripts/pack-mcp-bundled.cjs 在构建期
    // 取 npm 包 + 平台二进制、校 sha256，打进 <resources>/mcp/bundled/<key>），
    // 因此运行时既不 npm install、也不从 GitHub Releases 下载 —— 内网可用。
    // 包名与版本仍以本条目为唯一来源（pack 脚本读这里，勿在别处再写一份版本）。
    id: 'mcp-postgres',
    name: 'PostgreSQL',
    description:
      'PostgreSQL 只读查询：AST 层拒绝写语句，可查库表结构、执行计划与索引分析（需 DATABASE_URL）。',
    command: 'npx',
    args: ['-y', 'postgres-mcp-hardened@0.1.10', '--stdio'],
    bundledServer: 'mcp-postgres',
    defaultEnabled: false,
    envHint: 'DATABASE_URL'
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
