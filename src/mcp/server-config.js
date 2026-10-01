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
 * 声明的环境变量是否已就位（保存的凭据能解密出值，或进程环境里已有）。
 * @param {object} server
 * @param {{ getSecretMeta: (id: string) => { envKeys?: string[] } }} deps
 */
function hasRequiredEnv(server, deps) {
  const envHint = String(server.envHint || '').trim();
  if (!envHint) return true;
  const meta = deps.getSecretMeta(server.id);
  if (meta && meta.envKeys && meta.envKeys.includes(envHint)) return true;
  return hasProcessEnv(envHint);
}

/**
 * getSecretMeta 的 envKeys / hasToken 已按「能解密出值」计算（见 credentials-store），
 * 所以解不开的密文在这里天然表现为未配置。
 * @param {object} server
 * @param {{ getSecretMeta: (id: string) => { hasToken?: boolean, envKeys?: string[], hasEnv?: boolean, undecryptable?: string[] } }} deps
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

  // 预装服务：启动命令来自 app 资源，不要求用户填 command，但凭据要求与普通 stdio 一致 ——
  // 声明了 envHint（如 mcp-postgres 的 DATABASE_URL）就仍须就位，否则会「已启用但连不上」。
  if (server.bundledServer) return hasRequiredEnv(server, deps);

  const command = String(server.command || '').trim();
  if (!command) return false;

  return hasRequiredEnv(server, deps);
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
    hasToken: !!(meta && meta.hasToken),
    /** 存在但解不开的凭据键（含 'token'）：UI 据此提示"请重新填写"而不是"请填写" */
    undecryptable: meta && Array.isArray(meta.undecryptable) ? meta.undecryptable : []
  };
}

module.exports = {
  transportKind,
  isMcpServerConfigured,
  enrichMcpServerForUi
};
