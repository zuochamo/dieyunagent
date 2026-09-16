'use strict';

function transportKind(server) {
  if (!server) return 'stdio';
  if (server.transportKind === 'remote' || server.remoteUrl) return 'remote';
  return 'stdio';
}

function hasProcessEnv(name) {
  const key = String(name || '').trim();
  if (!key) return false;
  return !!String(process.env[key] || '').trim();
}

/**
 * @param {object} server
 * @param {{ getSecretMeta: (id: string) => { hasToken?: boolean, envKeys?: string[], hasEnv?: boolean } }} deps
 */
function isMcpServerConfigured(server, deps) {
  if (!server) return false;
  const kind = transportKind(server);
  if (kind === 'remote') {
    const url = String(server.remoteUrl || '').trim();
    if (!url) return false;
    if (server.authRequired) {
      const meta = deps.getSecretMeta(server.id);
      return !!(meta && meta.hasToken);
    }
    return true;
  }

  if (server.bundledServer) return true;

  const command = String(server.command || '').trim();
  if (!command) return false;

  const envHint = String(server.envHint || '').trim();
  if (!envHint) return true;

  const meta = deps.getSecretMeta(server.id);
  if (meta && meta.envKeys && meta.envKeys.includes(envHint)) return true;
  if (hasProcessEnv(envHint)) return true;
  return false;
}

/**
 * @param {object} server
 * @param {{ getSecretMeta: (id: string) => object }} deps
 */
function enrichMcpServerForUi(server, deps) {
  const kind = transportKind(server);
  const configured = isMcpServerConfigured(server, deps);
  const meta = deps.getSecretMeta(server.id);
  return {
    ...server,
    transportKind: kind,
    configured,
    needsConfig: !configured,
    hasToken: !!(meta && meta.hasToken)
  };
}

module.exports = {
  transportKind,
  isMcpServerConfigured,
  enrichMcpServerForUi
};
