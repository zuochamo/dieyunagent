'use strict';

const { getDeployConfig } = require('../deploy-config');
const { SERVICES } = require('./servers/dieyun-open-api/client');

/** @type {ReadonlyArray<{ id: string, service: keyof typeof SERVICES, name: string, description: string }>} */
const OPEN_API_MCP_DEFS = Object.freeze([
  {
    id: 'mcp-daizhang',
    service: 'daizhang',
    name: '叠云代账',
    description: '内网只读：客户列表、发票查询。配置 Base URL + API Key。'
  },
  {
    id: 'mcp-tools',
    service: 'tools',
    name: '叠云Tools',
    description: '内网只读：帮助文档章节。配置 Base URL + API Key。'
  },
  {
    id: 'mcp-index',
    service: 'index',
    name: '叠云Index',
    description: '内网只读：导航书签、主机监控。配置 Base URL + API Key。'
  },
  {
    id: 'mcp-pixel',
    service: 'pixel',
    name: 'PixelOfficeMonitor',
    description: '内网只读：工位汇总与电脑列表。配置 Base URL + API Key。'
  }
]);

const SERVICE_KEYS = Object.freeze(OPEN_API_MCP_DEFS.map((d) => d.service));
const OPEN_API_MCP_IDS = Object.freeze(OPEN_API_MCP_DEFS.map((d) => d.id));

function getOpenApiMcpDef(serverId) {
  return OPEN_API_MCP_DEFS.find((d) => d.id === String(serverId || '')) || null;
}

function getOpenApiMcpDefByService(serviceId) {
  return OPEN_API_MCP_DEFS.find((d) => d.service === String(serviceId || '')) || null;
}

function isOpenApiMcpId(serverId) {
  return OPEN_API_MCP_IDS.includes(String(serverId || ''));
}

/**
 * @param {object} [opts]
 * @param {ReturnType<typeof getDeployConfig>} [opts.deployConfig]
 * @param {string} [opts.serviceId] 仅取某一系统
 */
function getDieyunOpenApiEnvFromDeploy(opts = {}) {
  const cfg = opts.deployConfig || getDeployConfig();
  const openApi = cfg && cfg.openApi && typeof cfg.openApi === 'object' ? cfg.openApi : null;
  if (!openApi) return {};

  const only = opts.serviceId ? String(opts.serviceId) : '';
  const env = {};
  for (const id of SERVICE_KEYS) {
    if (only && id !== only) continue;
    const svc = SERVICES[id];
    const row = openApi[id];
    if (!svc || !row || typeof row !== 'object') continue;
    const url = String(row.url || '').trim();
    const key = String(row.key || row.apiKey || '').trim();
    if (url) env[svc.urlEnv] = url.replace(/\/+$/, '');
    if (key) env[svc.keyEnv] = key;
  }
  return env;
}

function mergeMcpServerSecrets(serverId, secrets, opts = {}) {
  const base = secrets && typeof secrets === 'object' ? secrets : { token: '', env: {} };
  const out = {
    token: base.token || '',
    env: { ...(base.env && typeof base.env === 'object' ? base.env : {}) }
  };
  const def = getOpenApiMcpDef(serverId);
  if (!def) return out;

  const deployEnv = opts.deployEnv || getDieyunOpenApiEnvFromDeploy({ serviceId: def.service });
  for (const [k, v] of Object.entries(deployEnv)) {
    if (!String(out.env[k] || '').trim()) out.env[k] = v;
  }
  if (opts.applyProcessEnv !== false) {
    for (const [k, v] of Object.entries(deployEnv)) {
      if (!String(process.env[k] || '').trim()) process.env[k] = v;
    }
  }
  return out;
}

/**
 * 单系统配置弹窗：URL + Key。
 * @param {string} serviceId
 * @param {{ env?: Record<string, string> }} [secrets]
 * @param {{ deployEnv?: Record<string, string>, processEnv?: NodeJS.ProcessEnv }} [opts]
 */
function buildDieyunServiceConfigForUi(serviceId, secrets, opts = {}) {
  const svc = SERVICES[serviceId];
  if (!svc) return null;
  const credEnv = secrets && secrets.env && typeof secrets.env === 'object' ? secrets.env : {};
  const deployEnv = opts.deployEnv || getDieyunOpenApiEnvFromDeploy({ serviceId });
  const proc = opts.processEnv || process.env;
  const url =
    String(credEnv[svc.urlEnv] || '').trim() ||
    String(proc[svc.urlEnv] || '').trim() ||
    String(deployEnv[svc.urlEnv] || '').trim() ||
    svc.defaultUrl;
  const key =
    String(credEnv[svc.keyEnv] || '').trim() ||
    String(proc[svc.keyEnv] || '').trim() ||
    String(deployEnv[svc.keyEnv] || '').trim() ||
    '';
  let keySource = '';
  if (String(credEnv[svc.keyEnv] || '').trim()) keySource = 'credentials';
  else if (String(proc[svc.keyEnv] || '').trim()) keySource = 'env';
  else if (String(deployEnv[svc.keyEnv] || '').trim()) keySource = 'deploy';
  return {
    configKind: 'dieyun-service',
    serviceId,
    label: svc.label,
    urlEnv: svc.urlEnv,
    keyEnv: svc.keyEnv,
    url,
    key,
    hasKey: !!key,
    keySource,
    enableHint: svc.enableHint
  };
}

function writeDieyunServiceToDeployLocal(serviceId, { url, key }) {
  const fs = require('fs');
  const path = require('path');
  const {
    findRepoRoot,
    deployConfigPaths,
    readDeployLocalJson,
    resetDeployConfigCache
  } = require('../deploy-config');
  if (!SERVICE_KEYS.includes(serviceId)) throw new Error(`未知服务：${serviceId}`);
  const root = findRepoRoot(path.join(__dirname, '..'));
  const localPath = deployConfigPaths(root).local;
  if (!localPath) throw new Error('无法定位 deploy.local.json');
  const existing = readDeployLocalJson(localPath);
  const openApi = existing.openApi && typeof existing.openApi === 'object' ? { ...existing.openApi } : {};
  openApi[serviceId] = {
    url: String(url || '').trim().replace(/\/+$/, ''),
    key: String(key || '').trim()
  };
  const next = {
    ...existing,
    _comment: existing._comment || '本机开发覆盖（已 gitignore）。勿提交密钥。',
    openApi
  };
  fs.writeFileSync(localPath, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  resetDeployConfigCache();
}

function openApiServicesToEnv(services) {
  const env = {};
  for (const row of Array.isArray(services) ? services : []) {
    const urlEnv = String(row.urlEnv || '').trim();
    const keyEnv = String(row.keyEnv || '').trim();
    const url = String(row.url || '')
      .trim()
      .replace(/\/+$/, '');
    const key = String(row.key || '').trim();
    if (urlEnv && url) env[urlEnv] = url;
    if (keyEnv && key) env[keyEnv] = key;
  }
  return env;
}

function writeOpenApiToDeployLocal(services) {
  for (const row of Array.isArray(services) ? services : []) {
    const id = String(row.id || '').trim();
    if (!SERVICE_KEYS.includes(id)) continue;
    writeDieyunServiceToDeployLocal(id, { url: row.url, key: row.key });
  }
}

module.exports = {
  OPEN_API_MCP_DEFS,
  OPEN_API_MCP_IDS,
  SERVICE_KEYS,
  getOpenApiMcpDef,
  getOpenApiMcpDefByService,
  isOpenApiMcpId,
  getDieyunOpenApiEnvFromDeploy,
  mergeMcpServerSecrets,
  buildDieyunServiceConfigForUi,
  openApiServicesToEnv,
  writeDieyunServiceToDeployLocal,
  writeOpenApiToDeployLocal
};
