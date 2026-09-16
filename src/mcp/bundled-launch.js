'use strict';

const fs = require('fs');
const path = require('path');

/**
 * 解析内置 MCP 入口脚本绝对路径。
 * @param {string} serverKey 如 dieyun-open-api
 * @returns {string|null}
 */
function resolveBundledMcpEntry(serverKey) {
  const key = String(serverKey || '').trim();
  if (!key) return null;
  const rel = path.join('src', 'mcp', 'servers', key, 'server.js');
  const candidates = [];

  try {
    const { app } = require('electron');
    if (app && typeof app.getAppPath === 'function') {
      candidates.push(path.join(app.getAppPath(), rel));
      candidates.push(path.join(app.getAppPath(), 'mcp', 'servers', key, 'server.js'));
    }
  } catch {
    // 非 Electron 环境
  }

  if (process.resourcesPath) {
    candidates.push(path.join(process.resourcesPath, 'app.asar', rel));
    candidates.push(path.join(process.resourcesPath, rel));
    candidates.push(path.join(process.resourcesPath, 'mcp', 'bundled', key, 'server.js'));
  }

  candidates.push(path.join(__dirname, 'servers', key, 'server.js'));
  candidates.push(path.resolve(process.cwd(), rel));

  for (const candidate of candidates) {
    try {
      if (candidate && fs.existsSync(candidate)) return path.resolve(candidate);
    } catch {
      // ignore
    }
  }
  return null;
}

/**
 * 将 registry 中的 bundledServer 解析为可 stdio 启动的 command/args。
 * @param {object} server
 * @returns {object|null} 解析后的 server；非内置则返回 null
 */
function resolveBundledMcpLaunch(server) {
  const key = server && server.bundledServer ? String(server.bundledServer).trim() : '';
  if (!key) return null;
  const entry = resolveBundledMcpEntry(key);
  if (!entry) {
    const err = new Error(`预装 MCP 入口不存在：${key}`);
    err.code = 'BUNDLED_MCP_MISSING';
    throw err;
  }
  return {
    ...server,
    command: process.execPath,
    args: [entry],
    launchEnv: {
      ...(server.launchEnv && typeof server.launchEnv === 'object' ? server.launchEnv : {}),
      ELECTRON_RUN_AS_NODE: '1',
      ...(server.openApiService
        ? { DIEYUN_OPEN_API_SERVICE: String(server.openApiService) }
        : {})
    }
  };
}

module.exports = {
  resolveBundledMcpEntry,
  resolveBundledMcpLaunch
};
