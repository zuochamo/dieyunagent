'use strict';

const fs = require('fs');
const path = require('path');
const { REMOTE_PACK_DIR_NAME, REMOTE_PACK_CORE_REL } = require('./remote/remote-pack-layout');

/**
 * 解析 dieyun-core 可执行文件路径（开发 / 打包 / 环境变量）
 * @returns {string | null}
 */
function resolveDieyunCoreBinary() {
  const fromEnv = String(process.env.DIEYUN_CORE_BIN || '').trim();
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;

  const isWin = process.platform === 'win32';
  const exe = isWin ? 'dieyun-core.exe' : 'dieyun-core';
  const candidates = [];

  if (process.resourcesPath) {
    candidates.push(path.join(process.resourcesPath, 'dieyun-core', exe));
    candidates.push(path.join(process.resourcesPath, exe));
    // Linux 安装包只在远端注入包里存一份 Linux core（同一个 ELF，不要存两遍）：
    // Windows 包里的那份是 PE，远端注入包里的才是本机该跑的那个，所以只在非 Windows 上认它。
    if (!isWin) {
      candidates.push(
        path.join(process.resourcesPath, REMOTE_PACK_DIR_NAME, ...REMOTE_PACK_CORE_REL.split('/'))
      );
    }
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
