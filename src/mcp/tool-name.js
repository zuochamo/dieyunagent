'use strict';

/**
 * MCP 工具名编码 —— **唯一来源**。
 *
 * 两侧共用，因此本文件必须保持「零依赖纯函数」（不得 require electron / SDK / fs 等）：
 * - Main：`mcp/runtime-manager.js` 用它把服务端工具名注册成 Agent 工具名；
 * - Renderer（经 agent-bundle）：`agent/planner-tool-filters.js` 用它判定
 *   「某工具是否属于契约只读的 MCP 服务」，从而在 Explore / Shell 阶段放行。
 *
 * 之前编码只存在于 runtime-manager，白名单侧若想按服务放行就只能把格式抄一份，
 * 一旦编码规则变动，放行规则会静默失效（放行名单失效 = 能力静默消失，不报错），故抽到这里。
 *
 * 形状：`mcp_<serverId>__<toolName>`，非 `[A-Za-z0-9_-]` 一律转成 `_`；
 * 超过 64 字符时退化为 `mcp_<serverId 前 24 位>_<hash>`。
 * 因此「同一服务的所有工具」共享前缀 `mcp_<serverId>__` —— **仅短名分支成立**，
 * 长名退化分支不含该前缀（`mcpToolNamePrefix` 对此失败关闭，见下）。
 */

/** MCP 工具名长度上限（协议/上游 API 的既有约束，勿单独调整） */
const MCP_TOOL_NAME_MAX = 64;

function simpleHash(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

/** 非空字符串化：null/undefined 视为「没有这个部分」，避免生成 `mcp_undefined__` 这种会被误匹配的前缀 */
function sanitizeMcpNamePart(value) {
  return String(value == null ? '' : value).replace(/[^a-zA-Z0-9_-]/g, '_');
}

/**
 * 某个 MCP 服务「全部工具」的公共前缀。
 * 取不到稳定前缀时返回 `''`（调用方据此失败关闭：不放行任何工具，而不是放行一批不确定的）。
 * @param {string} serverId
 * @returns {string}
 */
function mcpToolNamePrefix(serverId) {
  const id = sanitizeMcpNamePart(serverId);
  if (!id) return '';
  const prefix = `mcp_${id}__`;
  // 前缀本身就超限 → 真实工具名必然走长名退化分支，前缀不再成立，宁可返回空
  return prefix.length <= MCP_TOOL_NAME_MAX ? prefix : '';
}

/**
 * @param {string} serverId
 * @param {string} toolName
 * @returns {string}
 */
function encodeMcpToolName(serverId, toolName) {
  const combined = `${serverId}__${toolName}`;
  const name = `mcp_${combined.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
  if (name.length <= MCP_TOOL_NAME_MAX) return name;
  const sid = String(serverId)
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .slice(0, 24);
  return `mcp_${sid}_${simpleHash(combined)}`.slice(0, MCP_TOOL_NAME_MAX);
}

module.exports = {
  MCP_TOOL_NAME_MAX,
  simpleHash,
  mcpToolNamePrefix,
  encodeMcpToolName
};
