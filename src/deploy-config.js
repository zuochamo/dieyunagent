'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

/** 叠云内网内置默认（无 deploy.json 时生效；文件与环境变量可覆盖） */
const BUILTIN_DEFAULTS = Object.freeze({
  monitor: { serverUrl: 'http://192.168.31.62:3003/' },
  updates: {
    primaryUrl: 'http://192.168.31.62:3099/',
    fallbackUrl: 'https://dieyunagent-updates-1440856872.cos.ap-shanghai.myqcloud.com/'
  }
});

let cachedConfig = null;
let cachedRepoRoot = null;

function deepMerge(base, patch) {
  const out = { ...(base || {}) };
  for (const [key, value] of Object.entries(patch || {})) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      out[key] = deepMerge(out[key] || {}, value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

function readJsonFile(filePath) {
  try {
    if (filePath && fs.existsSync(filePath)) {
      // 记事本 / 部分编辑器会写入 UTF-8 BOM，直接 JSON.parse 会抛错并静默丢失整份配置
      const raw = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
      return JSON.parse(raw);
    }
  } catch {
    // ignore
  }
  return null;
}

function findRepoRoot(startDir) {
  let dir = startDir || process.cwd();
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function deployConfigPaths(repoRoot) {
  const root = repoRoot || findRepoRoot(path.join(__dirname, '..'));
  return {
    home: path.join(os.homedir(), '.dieyun', 'deploy.json'),
    local: root ? path.join(root, 'deploy.local.json') : null,
    example: root ? path.join(root, 'deploy.defaults.example.json') : null
  };
}

/**
 * 为「合并写回」而读取 deploy.local.json。
 * 解析失败时抛错而不是退化成空对象：否则写回会把文件里其它段落整体清空（数据丢失）。
 * @param {string} localPath
 * @returns {Record<string, unknown>}
 */
function readDeployLocalJson(localPath) {
  if (!localPath || !fs.existsSync(localPath)) return {};
  const raw = String(fs.readFileSync(localPath, 'utf8')).replace(/^\uFEFF/, '');
  if (!raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (err) {
    const e = new Error(
      `deploy.local.json 不是合法 JSON，已中止写入以免覆盖原有配置（${localPath}）：${
        err && err.message ? err.message : err
      }`
    );
    e.code = 'DEPLOY_LOCAL_PARSE_FAILED';
    throw e;
  }
}

/**
 * 文件层优先级：~/.dieyun/deploy.json → 仓库 deploy.local.json。
 * 曾有的第三层「安装包内置 deploy-packaged.json」随叠云 Open API 凭据注入链一起下线
 * （2026-11）：那一层只装 openApi 段，而读 openApi 的模块已删，留着只会把内网 Key 白塞进安装包。
 */
function loadFileLayers(repoRoot) {
  const paths = deployConfigPaths(repoRoot);
  let merged = {};
  for (const filePath of [paths.home, paths.local]) {
    const json = readJsonFile(filePath);
    if (json) merged = deepMerge(merged, json);
  }
  return { merged, paths };
}

function setIfEnv(obj, section, key, envKey, transform) {
  const raw = process.env[envKey];
  if (raw == null || String(raw).trim() === '') return;
  if (!obj[section]) obj[section] = {};
  obj[section][key] = typeof transform === 'function' ? transform(raw) : String(raw).trim();
}

function applyEnvOverrides(cfg) {
  const out = deepMerge(BUILTIN_DEFAULTS, cfg || {});
  setIfEnv(out, 'monitor', 'serverUrl', 'SERVER_URL');
  setIfEnv(out, 'updates', 'primaryUrl', 'UPDATE_URL');
  setIfEnv(out, 'updates', 'fallbackUrl', 'UPDATE_URL_FALLBACK');
  return out;
}

function getDeployConfig(opts = {}) {
  const repoRoot = opts.repoRoot ?? findRepoRoot(path.join(__dirname, '..'));
  if (cachedConfig && !opts.reload && cachedRepoRoot === repoRoot) {
    return cachedConfig;
  }
  const { merged } = loadFileLayers(repoRoot);
  cachedConfig = applyEnvOverrides(merged);
  cachedRepoRoot = repoRoot;
  return cachedConfig;
}

function resetDeployConfigCache() {
  cachedConfig = null;
  cachedRepoRoot = null;
}

module.exports = {
  BUILTIN_DEFAULTS,
  getDeployConfig,
  deployConfigPaths,
  readDeployLocalJson,
  resetDeployConfigCache,
  findRepoRoot
};
