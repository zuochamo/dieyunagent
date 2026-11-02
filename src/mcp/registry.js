'use strict';

/**
 * 预装 MCP 服务（可通过设置 → 技能 → MCP 启用）。
 *
 * **只保留离线预打包的 mcp-postgres**。2026-11 发版决策：不再预装
 * - 叠云 Open API 四件套（mcp-daizhang / mcp-tools / mcp-index / mcp-pixel，原 `bundledServer: 'dieyun-open-api'`）；
 * - 6 个第三方 npx 模板（sequential-thinking / everything / playwright / context7 / github / brave-search）。
 *
 * 为什么这么减：
 * - 叠云四件套默认开启，等于每台客户端一装完就把内网地址 + Key 摆进 Agent 工具表；
 *   要去哪家客户，就由谁按需接入（MCP 设置页「新增远端」，或 Agent 的 mcp_manage），
 *   而不是替所有人预置一套。
 * - 6 个 npx 模板本身不占体积也不默认开，但它们是「列表里的噪音」：内网断网场景下点开即失败
 *   （要联网拉包），留着只会制造无效重试与误解。
 *
 * 注意：这里只影响**没有显式记录**的机器（store.js 里 `hasOwnProperty(enabled, id)` 优先）
 * 与新装客户端；老机器 mcp.json 里残留的 `enabled` / `removed` 键不再对应任何服务，属惰性数据。
 */
const BUILTIN_MCP_SERVERS = [
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
