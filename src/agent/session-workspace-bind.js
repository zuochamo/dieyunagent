'use strict';

/**
 * 会话工作空间绑定的**唯一入口**：会话行 + 进程内会话上下文两处都写。
 *
 * 真正落两处的地方只有一处 —— Gateway 的 `memory.session_workspace_set`
 * （`src/gateway/handlers/memory.js`：写完会话行后同步 `setSessionWorkspaceContext`）。
 * 所以本模块只负责「调用它」和「空串 = 解绑」这两个语义，**不再自己直写内存**：
 * 直写内存的副本一旦漏写或者先写后失败，就会重新出现
 * 「库里有绑定、Gateway 处理 RPC 时仍按旧上下文解析路径」。
 *
 * 调用方：外部频道提交入口（`agent/service.js`）、定时计划（`plans/plan-session.js`）、
 * 频道（`channels/agent-turn.js` / `channels/workspace-switch.js`）、
 * 会话 worktree（`session/session-worktree.js`）、桌面 IPC（`main/ipc/workspace-remote.js`）。
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
  if (typeof gateway.invokeRpc !== 'function') return false;
  await gateway.invokeRpc('memory.session_workspace_set', {
    sessionId,
    workspacePath: ws || null
  });
  return true;
}

/**
 * 「这条会话还能不能继续往里写」的**唯一判据**：存在、且没被用户归档。
 *
 * 删除与归档必须同一口径：归档是用户的决定（这里不去改那个位），但继续往里写就等于
 * 把记录丢进侧栏翻不到的地方 —— 侧栏只拉 `archived = 0`。实测症状是「计划天天弹完成通知，
 * 界面里一直没有会话」（见 `plans/plan-session.js` 与 `main/alive-boot.js` 的注释）。
 *
 * **读取失败不是失效**：`memory.session_get` 对「查不到」返回 null，对传输 / SQLite 失败是
 * 抛错。调用方不许把异常当成「已删除」去重建会话（那会把计划/频道会话永久迁走）。
 *
 * @param {{ id?: string, archived?: number|boolean }|null|undefined} row
 * @returns {boolean}
 */
function isReusableSessionRow(row) {
  return !!(row && row.id) && !Number(row.archived);
}

module.exports = { bindSessionWorkspace, isReusableSessionRow };
