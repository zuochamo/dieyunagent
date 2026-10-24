'use strict';

const { OPEN_API_MCP_DEFS } = require('./open-api-deploy-env');

/** 预装 MCP 服务（可通过设置 → 技能 → MCP 启用） */
const BUILTIN_MCP_SERVERS = [
  // 这四个是「零配置即用」：内置内网 Base URL + API Key（随 build/deploy-packaged.json 注入），
  // 走纯 JS 服务随 app.asar 分发，无需 npm install / 无需外网，懒连接（不用不 spawn）。
  // 所以默认开启 —— 装完客户端就能让 Agent 查内网数据，不必每台手点一次。
  //
  // 其余预装服务保持 defaultEnabled: false：npx 型要联网拉包（内网断网会反复失败并退避重试），
  // github / brave-search 缺 token 会连不上，postgres 没有 DATABASE_URL 也是空转。
  //
  // 注意：这里只影响**没有显式记录**的机器（store.js 里 `hasOwnProperty(enabled, id)` 优先），
  // 用户手动关过的不会被这次改动重新打开。
  ...OPEN_API_MCP_DEFS.map((def) => ({
    id: def.id,
    name: def.name,
    description: def.description,
    bundledServer: 'dieyun-open-api',
    openApiService: def.service,
    command: 'bundled',
    args: [],
    defaultEnabled: true
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
      'PostgreSQL 只读查询：AST 层拒绝写语句，可查库表结构、执行计划与索引分析（需 DATABASE_URL 或 MCP_DATABASE_URLS）。',
    command: 'npx',
    args: ['-y', 'postgres-mcp-hardened@0.1.10', '--stdio'],
    bundledServer: 'mcp-postgres',
    defaultEnabled: false,
    // 该服务支持**多库**，两个变量互为替代，所以是 'any' 而不是 'all'（只填其一即可用）。
    // 服务侧实测语义（2026-10-16）：
    // - 具名条目分隔符是**分号**；写成逗号会让整串解析失败，报 "invalid connection string"（文案误导）。
    // - MCP_DATABASE_URLS 一旦设置就**完全覆盖** DATABASE_URL —— 原来的单库会「消失」，
    //   所以要用多库就得把主库也写成其中一条具名条目。
    // - 配了 ≥2 个库时，工具的 database 参数变成必填（否则报 several databases are configured）。
    // 变量名以 env-hints.js 的规范化结果为准；不要再读旧的 envHint 字段。
    envHints: [
      {
        name: 'DATABASE_URL',
        label: '主库连接串（单库）',
        hint: '形如 postgresql://用户:口令@主机:5432/库名?sslmode=disable'
      },
      {
        name: 'MCP_DATABASE_URLS',
        label: '多库连接串（可选；设了它会忽略主库连接串）',
        hint: '形如 名字=连接串;名字2=连接串2　注意分隔符是分号'
      }
    ],
    envRequirement: 'any'
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
