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
  'browser_expect'
]);
// 注意：browser_screenshot 支持 filePath 落盘（写文件），不再属于纯只读；
// Explore 需要看图时用 browser_observe（返回页内截图，不落盘）。

const SHELL_TOOL_NAMES = new Set([
  'host_exec',
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
  buildExploreTools,
  buildShellTools,
  buildBuildTools
};
