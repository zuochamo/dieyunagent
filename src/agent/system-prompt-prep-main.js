'use strict';

const path = require('path');

/**
 * Main 侧 `prepSystemPrompt(snapshot, deps)` 的依赖装配**唯一来源**。
 *
 * 有两个调用方：IPC `agent:prep-system-prompt`（Renderer 上报快照）与频道运行
 * （`src/channels/agent-turn.js`，无 Renderer 参与）。两边必须看到同一套
 * AGENTS.md / 记忆 / 技能 / MCP / 代码库召回 —— 所以装配只写一份，别在频道里另拼。
 *
 * 「WsPath 从 snapshot 取」也归这里：技能扫描、agentHome、代码库范围全以它为根，
 * 各调用点自己算一遍正是历史上三个召回口径漂移的原因。
 *
 * @param {{
 *   gateway: any,
 *   userData: string,
 *   snapshot: object,
 *   listMcpServers?: (userData: string) => any[],
 *   sharedMemory?: any
 * }} opts
 */
function buildPrepSystemPromptDeps(opts) {
  const gateway = opts.gateway;
  const userData = opts.userData;
  const snapshot = opts.snapshot && typeof opts.snapshot === 'object' ? opts.snapshot : {};
  if (!gateway || typeof gateway.invokeRpc !== 'function') {
    throw new Error('Gateway 未就绪');
  }
  const { prepSystemPrompt, resolveAgentHome } = require('./system-prompt-prep');
  const { scanSkills, readSkillContent, assertReadableSkillPath } = require('../skills/scanner');
  const { recallSkills } = require('../skills/vector-index');
  const { readEnabledMap } = require('../skills/enabled-store');
  const { getEmbeddingConfig } = require('../model-settings');
  const { getScanRoots, filterAccessibleSkillRoots } = require('../agent-home');
  const { loadModelSettings } = require('../model-settings');
  const { SANDBOX_MODE_META } = require('../gateway/sandbox-policy');
  const { projectSandboxState } = require('./capability-index');

  const wsPath =
    (snapshot.workspaceInfo && snapshot.workspaceInfo.workspacePath) || snapshot.runWorkspaceRoot || null;

  /**
   * 沙箱事实（档位 + 真实可写根 + 本会话已批准的位置）——【本轮能力事实】的数据来源。
   *
   * 口径只有一份：Gateway 的 `permissions.sandbox_state`（`handlers/permissions.js`），
   * 它报的是**实际生效**的根（含 %TEMP%、含已批准目录），不是「档位 + 工作区」的示意图；
   * 投影函数与 `agent_inspect`（自检工具）共用 `capability-index#projectSandboxState`。
   */
  async function getSandboxState() {
    let raw = null;
    try {
      raw = await gateway.invokeRpc('permissions.sandbox_state', {});
    } catch {
      raw = null;
    }
    return projectSandboxState(raw, SANDBOX_MODE_META);
  }

  return {
    prepSystemPrompt,
    deps: {
      invokeRpc: (method, params) => gateway.invokeRpc(method, params),
      getPermissions: () => gateway.getPermissions(),
      // 能力事实块的另一半：档位 + 真实可写根（判定仍只在 Gateway，这里只读）
      getSandboxState,
      getAgentHome: () => resolveAgentHome(userData, wsPath),
      userDataPath: userData,
      listMcpServers: () =>
        typeof opts.listMcpServers === 'function' ? opts.listMcpServers(userData) : [],
      // 共享记忆（跨机）没有实例时（headless 未装配 / 扩展未配置）这里就是 undefined，
      // prep 侧看到没有就不再召回 —— 不加开关、不做分支判断。
      sharedMemory: opts.sharedMemory || null,
      skills: {
        scan: () => scanSkills({ userData, workspacePath: wsPath }),
        // 启用状态只有一个权威来源（Main 的 skills/enabled-store.js）：Renderer 上报的
        // 快照里没有、也不该有它 —— 频道 / 定时计划 / headless 那几档根本没有 Renderer。
        enabledMap: () => readEnabledMap(userData),
        recall: async ({ query, enabledIds, limit }) => {
          const settings = loadModelSettings(userData);
          const embeddingConfig = getEmbeddingConfig(settings);
          return recallSkills({
            userData,
            workspacePath: wsPath,
            embeddingConfig,
            enabledIds: Array.isArray(enabledIds) ? enabledIds : [],
            query: query || '',
            limit: limit || 8
          });
        },
        read: async (skillPath) => {
          const roots = filterAccessibleSkillRoots(
            getScanRoots(userData, wsPath).map((r) => path.resolve(r))
          );
          assertReadableSkillPath(skillPath, roots);
          return readSkillContent(skillPath);
        }
      }
    }
  };
}

module.exports = { buildPrepSystemPromptDeps };
