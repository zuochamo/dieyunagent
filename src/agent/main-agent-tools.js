'use strict';

const catalog = require('./tool-catalog');

/**
 * Main 侧（无 Renderer）工具清单的唯一构造函数。
 *
 * 聊天路径的完整工具集在 Renderer（`renderer-tool-defs.js#buildAgentTools`，依赖编辑器态与
 * 权限快照），Main 侧跑一轮的调用方（定时计划、频道、headless、peer 来信触发的那一轮）只能用
 * 「静态工具 + MCP 工具」这一档：它们没有编辑器上下文，也不该替用户开新会话/弹澄清框。
 *
 * 内网互通三件套（`PEER_TOOLS`）在这一档里：协调器本来就住在 Main（`src/peer/boot.js`），
 * 这些轮次是**同一台机器上的 agent 在跑**，能不能看同事的 agent 不该取决于这一轮是谁发起的。
 * 互通没启用时执行端返回 PEER_UNAVAILABLE 结构化错误，不是「工具不存在」。
 *
 * @param {import('../mcp/runtime-manager').McpRuntimeManager | null} mcpRuntime
 * @param {string[] | null} [names]
 *   **显式清单**（心跳轮用）：给了就只发这些工具，且**不注入 MCP**。
 *   名单由 `guardrails-shared.aliveWakeToolNames(power, senses)` 派生 —— 它同时是「能不能调用」
 *   的那份白名单，所以模型看得见的 = 它调得动的。MCP 工具名是运行期才知道的（`mcp_<server>__<tool>`），
 *   写不进按名字的白名单，一律进不去；注入只会让它每轮撞一次 `READ_ONLY_SCOPE`。
 * @returns {Promise<Array<object>>} OpenAI 工具 schema 列表
 */
async function buildMainAgentTools(mcpRuntime, names) {
  const explicit = Array.isArray(names) ? names.filter((n) => typeof n === 'string' && n.trim()) : null;
  const tools = catalog.toolsByNames(explicit || catalog.PLAN_RUNTIME_TOOL_NAMES);
  if (!explicit) {
    for (const t of catalog.PEER_TOOLS || []) tools.push(t);
  }
  if (explicit) return tools;
  if (!mcpRuntime || typeof mcpRuntime.listAgentTools !== 'function') {
    return tools;
  }
  try {
    const result = await mcpRuntime.listAgentTools({ catalogOnly: true });
    for (const item of result.tools || []) {
      // 定义形状只有一份（`mcp/schema-slim.js#mcpAgentTool`）：参数瘦身 + 描述截断都在那里。
      // 以前这里内联拼了一份**不瘦身**的，于是计划 / 频道 / headless 每轮的 MCP schema
      // 比桌面聊天大一截（更容易撞上下文预算），且两侧描述模板各写一遍。
      const def = catalog.mcpAgentTool(item);
      if (def) tools.push(def);
    }
  } catch {
    // MCP 不可用不该让整轮跑不起来：静态工具已经够跑完本轮
  }
  return tools;
}

module.exports = { buildMainAgentTools };
