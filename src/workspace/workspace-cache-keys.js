'use strict';

const path = require('path');

/**
 * 远端 Agent 的身份 key —— **唯一实现**（`gateway/remote-agent-client.js` 也用它，别再各写一份）。
 *
 * 形态只有一种：P2 的 socket 形态 `info.key = "<socket>#<workspace>"`
 * （同一 socket 上一条连接一个 workspace，少了 workspace 这一段，两个工作区会共用同一个缓存条目）。
 *
 * 返回空串表示「这不是一个远端 Agent」，调用方据此跳过缓存，**不要**把它当成合法 key。
 */
function remoteAgentInfoKey(info) {
  if (!info) return '';
  return info.key ? String(info.key) : '';
}

function normalizeCacheWorkspaceRoot(workspaceRoot) {
  const raw = String(workspaceRoot || '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/\/$/, '');
  if (!raw) return '';
  if (raw.startsWith('/')) return raw.toLowerCase();
  return path.resolve(raw).toLowerCase();
}

/** Remote index ready cache: agent + workspace path (same agent, different projects). */
function remoteIndexCacheKey(info, workspaceRoot) {
  const base = remoteAgentInfoKey(info);
  if (!base) return '';
  const ws = normalizeCacheWorkspaceRoot(workspaceRoot);
  return ws ? `${base}:${ws}` : base;
}

function workspaceStoreKey(workspaceRoot) {
  return normalizeCacheWorkspaceRoot(workspaceRoot);
}

module.exports = {
  remoteAgentInfoKey,
  remoteIndexCacheKey,
  workspaceStoreKey
};
