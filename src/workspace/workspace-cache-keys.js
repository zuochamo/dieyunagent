'use strict';

const path = require('path');

function remoteAgentInfoKey(info) {
  return info && info.url && info.token ? `${info.url}:${info.token}` : '';
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
  normalizeCacheWorkspaceRoot,
  workspaceStoreKey
};
