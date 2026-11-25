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
  SKILL_UPDATE_TOOL,
  MEMORY_TOOLS,
  SESSION_RECALL_TOOL
} = require('./memory');
const { PLAN_TOOLS, GOAL_START_TOOL, GOAL_UPDATE_TOOL, GOAL_TOOLS } = require('./plan');
const { MCP_TOOL_SCHEMA_TOOL, MCP_MANAGE_TOOL } = require('./mcp');
const {
  CLARIFY_TOOL,
  SESSION_TOOL,
  SESSION_WORKSPACE_TOOL,
  FAN_OUT_TOOL,
  SUBAGENT_TOOL,
  SUBAGENT_STATUS_TOOL
} = require('./session');
const { COMPUTER_TOOL, CAMERA_TOOL, DESKTOP_CAMERA_TOOL, DESKTOP_CAMERA_PTZ_TOOL } = require('./computer');
const { PEER_TOOLS } = require('./peer');
const { SSH_TOOL, WORKTREE_TOOL } = require('./remote');
const { AGENT_INSPECT_TOOL, AGENT_CAPABILITY_TOOL } = require('./self');
const { PET_TOOLS } = require('./pet');

const ALL_STATIC_TOOLS = HOST_TOOLS.concat(
  WEB_TOOLS,
  BROWSER_TOOLS,
  [CODEBASE_TOOL, GREP_TOOL, GLOB_TOOL, READ_SYMBOL_TOOL, LSP_TOOL],
  GRAPH_TOOLS,
  [AGENTS_MD_PROPOSE_TOOL, SKILL_CREATE_TOOL, SKILL_DELETE_TOOL, SKILL_UPDATE_TOOL],
  MEMORY_TOOLS,
  [SESSION_RECALL_TOOL],
  PLAN_TOOLS,
  [MCP_TOOL_SCHEMA_TOOL, MCP_MANAGE_TOOL, CLARIFY_TOOL, SESSION_TOOL, SESSION_WORKSPACE_TOOL, FAN_OUT_TOOL, SUBAGENT_TOOL, SUBAGENT_STATUS_TOOL],
  [COMPUTER_TOOL],
  [CAMERA_TOOL],
  [DESKTOP_CAMERA_TOOL],
  [DESKTOP_CAMERA_PTZ_TOOL],
  [SSH_TOOL],
  [WORKTREE_TOOL],
  PEER_TOOLS,
  // 「看一眼自己」：放在最后 —— 它是兜底手段（别的工具解释不清时用），不是起手工具
  [AGENT_INSPECT_TOOL],
  // 能力申请 / 复查：与自检同域，紧挨着它
  [AGENT_CAPABILITY_TOOL]
);

/**
 * **条件注入**的工具：不进 `ALL_STATIC_TOOLS`（那会改变模型看到的工具表），
 * 但要能按名解析 —— 校验的 required/enum 从 schema 派生，盘点与生成器也要看到它们。
 *
 * 两类：
 * - 会话目标四件套（`goal_*`）：有目标时才注入；
 * - 身体（`pet_set` / `pet_act`）：只有桌面版注入（聊天轮常驻、心跳轮按绑定与否追加）。
 * 不进静态表，所以 `renderer-tool-defs.js` 自己按宿主条件 push。
 */
const CONDITIONAL_TOOLS = [GOAL_START_TOOL, GOAL_UPDATE_TOOL, ...GOAL_TOOLS, ...PET_TOOLS];

/** 静态 + 条件注入：**按名解析**与各处校验/盘点用的全集（注入面仍只看 `ALL_STATIC_TOOLS`）。 */
const ALL_KNOWN_TOOLS = ALL_STATIC_TOOLS.concat(CONDITIONAL_TOOLS);

const BY_NAME = Object.create(null);
for (const t of ALL_KNOWN_TOOLS) {
  const n = t && t.function && t.function.name;
  if (n && !BY_NAME[n]) BY_NAME[n] = t;
}

const PLAN_RUNTIME_TOOL_NAMES = [
  'host_exec',
  'fs_read_file',
  'fs_edit',
  'fs_write_file',
  'fs_list_dir',
  'web_fetch',
  'web_search',
  // MCP 运维两件套。它们**必须**在主侧这一档里：系统提示的 MCP 块无条件教模型
  // 「缺工具用 mcp_tool_schema 检索」「接新服务用 mcp_manage」（system-prompt-prep.js），
  // 而频道 / 定时计划 / headless / peer 来信跑的都是这一档 —— 少给工具就是在每轮
  // 承诺一件它做不到的事。`mcp_manage` 的用途本来就是「还没有服务时把服务接进来」，
  // 所以不能反过来按「MCP 已启用」有条件给（见 MUTATING_TOOL_NAMES：它是写类工具）。
  'mcp_tool_schema',
  'mcp_manage',
  // 「看一眼自己」：计划 / 频道 / headless / peer 来信这四档没有设置页可点，
  // 模型排查「工具为什么调不到 / 为什么又失败了」时最需要它 —— 只读、无副作用。
  'agent_inspect',
  // 能力申请：无 UI 的档位里它会如实回 CAPABILITY_UI_UNAVAILABLE + 「去哪儿开」，
  // 比「工具不存在」有用；有 UI（网页版）时就是同一条闭环。
  'agent_capability'
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
  CONDITIONAL_TOOLS,
  ALL_KNOWN_TOOLS,
  getToolByName,
  toolsByNames
};
