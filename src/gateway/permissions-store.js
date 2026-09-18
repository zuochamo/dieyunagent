'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  hostControl: true,
  fsRead: true,
  fsWrite: true,
  shellExec: true,
  sqlRead: true,
  webFetch: true,
  browserAutomation: true,
  /**
   * 「完全放开路径限制」：开启后本地白名单 = 本机所有卷根、远程白名单 = `/`。
   * 默认**关闭**。开启等于把整盘读写交给 Agent（含系统目录），只应在完全信任当前任务时使用；
   * 白名单组装点唯一：gateway/server.js `_collectReadRoots/_collectWritableRoots`
   * 与 ssh/remote-path.js `remoteAllowedRoots`。
   */
  unrestrictedPaths: false
};

function loadPermissions(filePath) {
  try {
    if (fs.existsSync(filePath)) {
      const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      return { ...DEFAULTS, ...raw };
    }
  } catch {
    // ignore
  }
  return { ...DEFAULTS };
}

function savePermissions(filePath, perms) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const next = { ...DEFAULTS, ...perms };
  fs.writeFileSync(filePath, JSON.stringify(next, null, 2), 'utf8');
  return next;
}

module.exports = { DEFAULTS, loadPermissions, savePermissions };
