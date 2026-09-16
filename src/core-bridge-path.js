'use strict';

const fs = require('fs');
const path = require('path');

/**
 * 解析 dieyun-core 可执行文件路径（开发 / 打包 / 环境变量）
 * @returns {string | null}
 */
function resolveDieyunCoreBinary() {
  const fromEnv = String(process.env.DIEYUN_CORE_BIN || '').trim();
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;

  const exe = process.platform === 'win32' ? 'dieyun-core.exe' : 'dieyun-core';
  const candidates = [];

  if (process.resourcesPath) {
    candidates.push(path.join(process.resourcesPath, 'dieyun-core', exe));
    candidates.push(path.join(process.resourcesPath, exe));
  }

  const appRoot = path.join(__dirname, '..');
  candidates.push(path.join(appRoot, 'build', 'dieyun-core', exe));
  candidates.push(path.join(appRoot, 'target', 'release', exe));
  candidates.push(path.join(appRoot, 'target', 'debug', exe));

  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return p;
    } catch {
      // ignore
    }
  }
  return null;
}

function isRustCoreEnabled() {
  if (process.env.DIEYUN_CORE === '0') return false;
  return !!resolveDieyunCoreBinary();
}

module.exports = {
  resolveDieyunCoreBinary,
  isRustCoreEnabled
};
