'use strict';

const { getEnvHintDefs, getEnvHintNames, getEnvRequirement, isEnvSatisfied } = require('./env-hints');

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
 * 判定口径由 env-hints.js 决定：默认「required 的条目全都要有」；声明了
 * `envRequirement: 'any'` 的服务则是「至少一条有」（条目互为替代，例如
 * mcp-postgres 的单库串与多库串）。
 * @param {object} server
 * @param {{ getSecretMeta: (id: string) => { envKeys?: string[] } }} deps
 */
function hasRequiredEnv(server, deps) {
  if (!getEnvHintDefs(server).length) return true;
  const meta = deps.getSecretMeta(server.id);
  const saved = new Set(meta && Array.isArray(meta.envKeys) ? meta.envKeys : []);
  return isEnvSatisfied(server, (name) => saved.has(name) || hasProcessEnv(name));
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
  // 声明了环境变量（如 mcp-postgres 的 DATABASE_URL / MCP_DATABASE_URLS）就仍须就位，
  // 否则会「已启用但连不上」。
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
  const undecryptable = meta && Array.isArray(meta.undecryptable) ? meta.undecryptable : [];
  const saved = new Set(meta && Array.isArray(meta.envKeys) ? meta.envKeys : []);
  return {
    ...server,
    transportKind: kind,
    configured,
    needsConfig: !configured,
    hasToken: !!(meta && meta.hasToken),
    /** 存在但解不开的凭据键（含 'token'）：UI 据此提示"请重新填写"而不是"请填写" */
    undecryptable,
    /**
     * 逐项环境变量的**规范化 + 当前状态**，配置页据此渲染多个输入框。
     * 这里会覆盖服务定义里的原始 envHints —— 原始数组可能只是字符串名，
     * UI 需要的是带 label、且标明「已就位 / 待填写 / 解不开」的形态。
     */
    envHintNames: getEnvHintNames(server),
    envRequirement: getEnvRequirement(server),
    envHints: getEnvHintDefs(server).map((def) => ({
      name: def.name,
      label: def.label,
      hint: def.hint,
      required: def.required,
      saved: saved.has(def.name) || hasProcessEnv(def.name),
      undecryptable: undecryptable.includes(def.name)
    }))
  };
}

module.exports = {
  transportKind,
  isMcpServerConfigured,
  enrichMcpServerForUi
};
