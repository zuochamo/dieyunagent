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
  const { getEmbeddingConfig } = require('../model-settings');
  const { getScanRoots, filterAccessibleSkillRoots } = require('../agent-home');
  const { loadModelSettings } = require('../model-settings');

  const wsPath =
    (snapshot.workspaceInfo && snapshot.workspaceInfo.workspacePath) || snapshot.runWorkspaceRoot || null;

  return {
    prepSystemPrompt,
    deps: {
      invokeRpc: (method, params) => gateway.invokeRpc(method, params),
      getPermissions: () => gateway.getPermissions(),
      getAgentHome: () => resolveAgentHome(userData, wsPath),
      userDataPath: userData,
      listMcpServers: () =>
        typeof opts.listMcpServers === 'function' ? opts.listMcpServers(userData) : [],
      // 共享记忆（跨机）没有实例时（headless 未装配 / 扩展未配置）这里就是 undefined，
      // prep 侧看到没有就不再召回 —— 不加开关、不做分支判断。
      sharedMemory: opts.sharedMemory || null,
      skills: {
        scan: () => scanSkills({ userData, workspacePath: wsPath }),
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
