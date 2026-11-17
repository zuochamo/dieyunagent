'use strict';

/**
 * 工具表（模型看到的 schema）的**唯一入口** —— 本文件现在是 barrel：按域拆到 `./catalog/*`，
 * 导出名与导出集合**一个没改**，所以所有 `require('./tool-catalog')` 的调用点都不用动。
 *
 * 为什么拆：这个文件原本 2599 行、近一年 churn 5384 行（全仓 agent 代码最高），
 * 加一个工具要在 2600 行里找位置，两处改动撞车的概率全仓最高。拆完的规矩：
 *
 * - **加一个工具只改一个域文件**（`catalog/host|browser|code|memory|plan|mcp|session|computer|peer|remote.js`）；
 * - **动作清单只写在 schema 的 `enum` 里**，校验从它派生（`tool-validate.js#toolActionEnum`），
 *   执行分派在 `tool-bridge-main.js` —— 三处不许各抄一份；
 * - **装配顺序在 `catalog/groups.js`**：顺序就是模型看到的顺序，改动要当行为改动对待。
 *
 * 文案类（模型可见）与执行类（真正干活）分属两个文件：这里只有前者。
 */

const { HOST_TOOLS, WEB_TOOLS } = require('./catalog/host');
const {
  BROWSER_TOOLS,
  BROWSER_CORE_TOOLS,
  BROWSER_ADVANCED_TOOLS,
  BROWSER_ADVANCED_TOOL_NAMES
} = require('./catalog/browser');
const {
  CODEBASE_TOOL,
  GREP_TOOL,
  GLOB_TOOL,
  READ_SYMBOL_TOOL,
  LSP_TOOL,
  GRAPH_TOOL,
  GRAPH_TOOLS
} = require('./catalog/code');
const {
  AGENTS_MD_PROPOSE_TOOL,
  SKILL_CREATE_TOOL,
  SKILL_DELETE_TOOL,
  MEMORY_TOOLS
} = require('./catalog/memory');
const { PLAN_TOOLS, GOAL_START_TOOL, GOAL_UPDATE_TOOL, GOAL_TOOLS } = require('./catalog/plan');
const { MCP_TOOL_SCHEMA_TOOL, MCP_MANAGE_TOOL } = require('./catalog/mcp');
const { CLARIFY_TOOL, SESSION_TOOL, SESSION_WORKSPACE_TOOL, SUBAGENT_TOOL } = require('./catalog/session');
const { COMPUTER_TOOL, CAMERA_TOOL, DESKTOP_CAMERA_TOOL } = require('./catalog/computer');
const { PEER_TOOLS } = require('./catalog/peer');
const { SSH_TOOL, WORKTREE_TOOL } = require('./catalog/remote');
const {
  ALL_STATIC_TOOLS,
  PLAN_RUNTIME_TOOL_NAMES,
  CHANNEL_RUNTIME_TOOL_NAMES,
  RENDERER_ONLY_TOOLS,
  getToolByName,
  toolsByNames
} = require('./catalog/groups');

// 「这个工具名是不是 MCP 服务注册出来的」唯一判定（Main 与 Renderer 共用）；
// mcp_manage / mcp_tool_schema 虽同前缀但不是远端工具，细则在 `mcp/tool-name.js`。
const { isMcpServerToolName, MCP_BUILTIN_TOOL_NAMES } = require('../mcp/tool-name');
// MCP 参数瘦身：远端 schema 又深又长，塞进工具表会吃掉上下文（唯一实现在 mcp/schema-slim.js）。
const { slimMcpInputSchema, compactMcpToolDef } = require('../mcp/schema-slim');
// 「工具调用能力弱」的模型判定（与 schema 无关，单独一个模块）。
const { isWeakToolCallerModel } = require('./tool-model-capability');

module.exports = {
  HOST_TOOLS,
  WEB_TOOLS,
  BROWSER_TOOLS,
  BROWSER_CORE_TOOLS,
  BROWSER_ADVANCED_TOOLS,
  BROWSER_ADVANCED_TOOL_NAMES,
  CODEBASE_TOOL,
  GREP_TOOL,
  GLOB_TOOL,
  READ_SYMBOL_TOOL,
  LSP_TOOL,
  GRAPH_TOOL,
  GRAPH_TOOLS,
  AGENTS_MD_PROPOSE_TOOL,
  SKILL_CREATE_TOOL,
  SKILL_DELETE_TOOL,
  MEMORY_TOOLS,
  PLAN_TOOLS,
  GOAL_START_TOOL,
  GOAL_UPDATE_TOOL,
  GOAL_TOOLS,
  MCP_TOOL_SCHEMA_TOOL,
  MCP_MANAGE_TOOL,
  SSH_TOOL,
  WORKTREE_TOOL,
  PEER_TOOLS,
  isMcpServerToolName,
  MCP_BUILTIN_TOOL_NAMES,
  CLARIFY_TOOL,
  SESSION_TOOL,
  SUBAGENT_TOOL,
  SESSION_WORKSPACE_TOOL,
  COMPUTER_TOOL,
  CAMERA_TOOL,
  DESKTOP_CAMERA_TOOL,
  ALL_STATIC_TOOLS,
  PLAN_RUNTIME_TOOL_NAMES,
  CHANNEL_RUNTIME_TOOL_NAMES,
  RENDERER_ONLY_TOOLS,
  getToolByName,
  toolsByNames,
  isWeakToolCallerModel,
  slimMcpInputSchema,
  compactMcpToolDef
};
