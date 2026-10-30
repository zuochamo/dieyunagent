'use strict';

/**
 * 会话工作空间绑定的**唯一实现**：会话行 + 进程内会话上下文两处都写。
 *
 * 只写会话行：下一次 hydrate 之前，Gateway 处理 RPC（工具、索引、读写）仍按旧上下文解析路径。
 * 只写内存：进程重启 / 会话重新加载后又回到未绑定。
 *
 * 调用方：定时计划（`plans/plan-session.js`）、频道（`channels/agent-turn.js`）、
 * 频道里「换项目 / 切回默认」（`channels/workspace-switch.js`）。
 * 这几条路都是「没有 Renderer 在场的会话」，绑定只能由 Main 自己落。
 *
 * `workspacePath` 传空串表示**解绑**（回到默认 workspace）：此时会话行写 NULL，不是写空串。
 *
 * @param {any} gateway
 * @param {string} sessionId
 * @param {string} workspacePath
 * @returns {Promise<boolean>}
 */
async function bindSessionWorkspace(gateway, sessionId, workspacePath) {
  const ws = String(workspacePath || '').trim();
  if (!sessionId || !gateway) return false;
  if (typeof gateway.setSessionWorkspaceContext === 'function') {
    try {
      gateway.setSessionWorkspaceContext(sessionId, ws);
    } catch {
      // 内存上下文写失败不致命：下面的会话行仍会被 hydrate 回来
    }
  }
  if (typeof gateway.invokeRpc === 'function') {
    await gateway.invokeRpc('memory.session_workspace_set', {
      sessionId,
      workspacePath: ws || null
    });
  }
  return true;
}

module.exports = { bindSessionWorkspace };
