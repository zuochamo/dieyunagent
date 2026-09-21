'use strict';

const EXPLORE_TOOL_NAMES = new Set([
  'fs_read_file',
  'fs_list_dir',
  'grep',
  'glob',
  'read_symbol',
  'lsp',
  'sql_list_databases',
  'sql_list_tables',
  'sql_query',
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

const SHELL_TOOL_NAMES = new Set([
  'host_exec',
  'host_proc',
  'fs_read_file',
  'fs_list_dir',
  'grep',
  'glob',
  'read_symbol',
  'lsp',
  'sql_list_databases',
  'sql_list_tables',
  'sql_query'
]);

function buildExploreTools(allTools) {
  return (allTools || []).filter((t) => {
    const name = t?.function?.name;
    return name && EXPLORE_TOOL_NAMES.has(name);
  });
}

function buildShellTools(allTools) {
  return (allTools || []).filter((t) => {
    const name = t?.function?.name;
    return name && SHELL_TOOL_NAMES.has(name);
  });
}

function buildBuildTools(allTools) {
  return allTools || [];
}

module.exports = {
  EXPLORE_TOOL_NAMES,
  SHELL_TOOL_NAMES,
  buildExploreTools,
  buildShellTools,
  buildBuildTools
};
