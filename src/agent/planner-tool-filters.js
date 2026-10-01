'use strict';

const { mcpToolNamePrefix } = require('../mcp/tool-name');

const EXPLORE_TOOL_NAMES = new Set([
  'fs_read_file',
  'fs_list_dir',
  'grep',
  'glob',
  'read_symbol',
  'lsp',
  'web_fetch',
  'web_search',
  'browser_snapshot',
  'browser_observe',
  'browser_wait_for',
  'browser_status',
  'browser_a11y_snapshot',
  'browser_network',
  'browser_console',
  'browser_frames',
  'browser_timeline',
  'browser_expect'
]);
// 注意：browser_screenshot 支持 filePath 落盘（写文件），不再属于纯只读；
// Explore 需要看图时用 browser_observe（返回页内截图，不落盘）。
//
// 【不变式 · 勿破】EXPLORE_TOOL_NAMES 必须保持「纯只读」，尤其**不得加入 subagent**。
// 这张白名单同时是「研究子 Agent 的工具集」（src/agent/subagent-runner.js 直接用它建子回合），
// 一旦加入 subagent，子 Agent 就能再派子 Agent，深度不再为 1，会指数级放大调用。
// 需要 subagent 的是「协调者」——Agent 主循环、Explore 模式、Plan 的 explore 阶段，
// 它们各自在自己的工具集上显式追加 SUBAGENT_TOOL，而不是改这张表。
// MCP 工具名运行期才知道（mcp_<serverId>__<tool>），写不进这张按名字的白名单，
// 其只读放行走下面的 isReadOnlyMcpToolName —— 同样只放「纯只读」，不放可写 MCP。

const SHELL_TOOL_NAMES = new Set([
  'host_exec',
  'host_proc',
  'fs_read_file',
  'fs_list_dir',
  'grep',
  'glob',
  'read_symbol',
  'lsp'
]);

/**
 * 只读阶段（Explore 模式 / 研究子 Agent / Plan 的 explore 与 shell 阶段）放行的 MCP 服务。
 *
 * 数据库只读以前是内置 sql_* 工具，直接列在上面两张白名单里；换成外部 PostgreSQL MCP 后，
 * 工具名变成 `mcp_mcp-postgres__*`，按名字的白名单必然匹配不到 —— 表现是「只读查库能力
 * 在只读阶段静默消失」（不报错、模型只看到工具没了）。这里把放行收敛为一个显式名单。
 *
 * **准入条件：该 MCP 服务由服务端契约保证拒写**（而不是靠提示词约束模型）。
 * postgres-mcp-hardened 在 AST 层拒绝写语句、全程 READ ONLY 事务（见 mcp/registry.js 的条目注释）；
 * 实测其 tools/list 的 10 个工具**全部**声明 `annotations.readOnlyHint=true`（v0.1.10）。
 * playwright / github / everything 等可写 MCP **一律不放行**：「白名单保持纯只读」的不变式优先于
 * 「能用的工具更多」。
 *
 * 既然有注解，为何仍用显式名单而不按注解自动放行：本白名单运行在**已转换的 OpenAI tool def** 上，
 * MCP 注解经 compactMcpToolDef / slimMcpInputSchema 之后不再保留；要按注解放行，得把注解一路带到
 * 三个过滤点（Renderer 工具集 / Plan payload / 研究子 Agent），链路上任何一处丢失都表现为
 * 「只读能力静默消失」—— 正是本名单要修的那类故障。故此处用显式名单：准入即人工审过、失败关闭，
 * 注解作为准入证据记录于此（新增只读 MCP 前请先实测其 tools/list 全为 readOnlyHint=true）。
 *
 * 前缀由 mcp/tool-name.js 的 mcpToolNamePrefix 生成 —— 编码格式不在本文件复写，
 * 免得上游改编码时这里静默失效。名单里的 id 必须真实存在于 mcp/registry.js：
 * 由 test/unit/explore-mode.test.cjs 锁定（改 id 漏改这里会测试失败，而不是静默失去能力）。
 *
 * 已知边界：工具名超 64 字符时编码器退化为 `mcp_<serverId 前 24 位>_<hash>`，前缀不再成立，
 * 这类工具**不放行**（失败关闭：宁可少给一个只读工具，也不按弱前缀误放行别的服务的工具）。
 * 当前 postgres 的工具名（query / list_schemas / describe_table 等）都远短于该上限。
 */
const READONLY_MCP_SERVER_IDS = Object.freeze(['mcp-postgres']);

const READONLY_MCP_TOOL_PREFIXES = Object.freeze(
  READONLY_MCP_SERVER_IDS.map((id) => mcpToolNamePrefix(id)).filter(Boolean)
);

/**
 * 该工具名是否来自「契约只读」的 MCP 服务 —— Explore / Shell 白名单里唯一的 MCP 放行口。
 * @param {string} name
 */
function isReadOnlyMcpToolName(name) {
  const n = String(name || '');
  if (!n.startsWith('mcp_')) return false;
  return READONLY_MCP_TOOL_PREFIXES.some((prefix) => n.startsWith(prefix));
}

function buildExploreTools(allTools) {
  return (allTools || []).filter((t) => {
    const name = t?.function?.name;
    if (!name) return false;
    return EXPLORE_TOOL_NAMES.has(name) || isReadOnlyMcpToolName(name);
  });
}

function buildShellTools(allTools) {
  return (allTools || []).filter((t) => {
    const name = t?.function?.name;
    if (!name) return false;
    return SHELL_TOOL_NAMES.has(name) || isReadOnlyMcpToolName(name);
  });
}

function buildBuildTools(allTools) {
  return allTools || [];
}

module.exports = {
  EXPLORE_TOOL_NAMES,
  SHELL_TOOL_NAMES,
  READONLY_MCP_SERVER_IDS,
  READONLY_MCP_TOOL_PREFIXES,
  isReadOnlyMcpToolName,
  buildExploreTools,
  buildShellTools,
  buildBuildTools
};
