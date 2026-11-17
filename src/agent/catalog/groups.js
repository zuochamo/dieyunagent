'use strict';

/**
 * 工具分组与按名索引：工具表的**装配顺序在这里**（顺序就是模型看到的顺序），
 * 各运行档位的白名单（计划 / 频道 / 仅渲染器）也在这里派生。
 */
const { HOST_TOOLS, WEB_TOOLS } = require('./host');
const { BROWSER_TOOLS } = require('./browser');
const { CODEBASE_TOOL, GREP_TOOL, GLOB_TOOL, READ_SYMBOL_TOOL, LSP_TOOL, GRAPH_TOOLS } = require('./code');
const {
  AGENTS_MD_PROPOSE_TOOL,
  SKILL_CREATE_TOOL,
  SKILL_DELETE_TOOL,
  MEMORY_TOOLS,
  SESSION_RECALL_TOOL
} = require('./memory');
const { PLAN_TOOLS } = require('./plan');
const { MCP_TOOL_SCHEMA_TOOL, MCP_MANAGE_TOOL } = require('./mcp');
const {
  CLARIFY_TOOL,
  SESSION_TOOL,
  SESSION_WORKSPACE_TOOL,
  SUBAGENT_TOOL,
  SUBAGENT_STATUS_TOOL
} = require('./session');
const { COMPUTER_TOOL, CAMERA_TOOL, DESKTOP_CAMERA_TOOL, DESKTOP_CAMERA_PTZ_TOOL } = require('./computer');
const { PEER_TOOLS } = require('./peer');
const { SSH_TOOL, WORKTREE_TOOL } = require('./remote');

const ALL_STATIC_TOOLS = HOST_TOOLS.concat(
  WEB_TOOLS,
  BROWSER_TOOLS,
  [CODEBASE_TOOL, GREP_TOOL, GLOB_TOOL, READ_SYMBOL_TOOL, LSP_TOOL],
  GRAPH_TOOLS,
  [AGENTS_MD_PROPOSE_TOOL, SKILL_CREATE_TOOL, SKILL_DELETE_TOOL],
  MEMORY_TOOLS,
  [SESSION_RECALL_TOOL],
  PLAN_TOOLS,
  [MCP_TOOL_SCHEMA_TOOL, MCP_MANAGE_TOOL, CLARIFY_TOOL, SESSION_TOOL, SESSION_WORKSPACE_TOOL, SUBAGENT_TOOL, SUBAGENT_STATUS_TOOL],
  [COMPUTER_TOOL],
  [CAMERA_TOOL],
  [DESKTOP_CAMERA_TOOL],
  [DESKTOP_CAMERA_PTZ_TOOL],
  [SSH_TOOL],
  [WORKTREE_TOOL],
  PEER_TOOLS
);

const BY_NAME = Object.create(null);
for (const t of ALL_STATIC_TOOLS) {
  const n = t && t.function && t.function.name;
  if (n) BY_NAME[n] = t;
}

const PLAN_RUNTIME_TOOL_NAMES = [
  'host_exec',
  'fs_read_file',
  'fs_edit',
  'fs_write_file',
  'fs_list_dir',
  'web_fetch',
  'web_search'
];

// 只认渲染器能做的事：确认卡片、会话/工作空间切换。Main 收到这些名字只做反委托，不自己执行。
// session_set_workspace 同时在频道里由 Main 自己执行（见 CHANNEL_RUNTIME_TOOL_NAMES）：
// 「换工作空间的真相」分属两边 —— 桌面归渲染器视图，频道归 Main 的会话绑定，各写各的那一份。
const RENDERER_ONLY_TOOLS = ['agent_clarify', 'session_new', 'session_set_workspace'];

// 外部频道（Main 后台跑、没有 UI）额外需要的工具：换工作空间只能靠模型显式调用。
// 不进 PLAN_RUNTIME_TOOL_NAMES（计划的工作空间由计划自己定）。
const CHANNEL_RUNTIME_TOOL_NAMES = ['session_set_workspace'];

function getToolByName(name) {
  return BY_NAME[String(name || '')] || null;
}

function toolsByNames(names) {
  return (names || []).map(getToolByName).filter(Boolean);
}

module.exports = {
  ALL_STATIC_TOOLS,
  BY_NAME,
  PLAN_RUNTIME_TOOL_NAMES,
  RENDERER_ONLY_TOOLS,
  CHANNEL_RUNTIME_TOOL_NAMES,
  getToolByName,
  toolsByNames
};
