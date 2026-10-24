'use strict';

const fs = require('fs');
const path = require('path');

const { normalizeSandboxMode, DEFAULT_SANDBOX_MODE } = require('./sandbox-policy');

const DEFAULTS = {
  hostControl: true,
  fsRead: true,
  fsWrite: true,
  shellExec: true,
  webFetch: true,
  browserAutomation: true,
  /**
   * 沙箱档位（唯一旋钮）：`read-only` | `workspace-write` | `danger-full-access`。
   * 语义与判定在 `sandbox-policy.js`；落盘白名单的唯一组装点是
   * gateway/server.js `_collectReadRoots/_collectWritableRoots`（远程侧同源
   * ssh/remote-path.js `remoteAllowedRoots`）。
   */
  sandboxMode: DEFAULT_SANDBOX_MODE,
  /**
   * 历史字段：仅作为 `sandboxMode === 'danger-full-access'` 的**派生视图**保留，
   * 供设置页开关与输入区图标读取（它们表达的是同一件事）。
   * 写入时会自动折算成 sandboxMode —— 不要在别处再读它做判定。
   */
  unrestrictedPaths: false
};

/**
 * 归一：`unrestrictedPaths === true` 是**明确的用户动作**（设置页开关 / 输入区图标），
 * 优先级高于 `sandboxMode`；关掉时不清档位（它只是派生视图，`false` 不代表"想收窄"）。
 *
 * 这样两个入口行为一致：老配置文件（只有 unrestrictedPaths）升级后仍是用户原意，
 * 输入区图标点一下也能真的切成「完全放开」，不会因为同时带着旧 sandboxMode 而失效。
 */
function normalizePermissions(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  let sandboxMode = normalizeSandboxMode(src.sandboxMode);
  if (src.unrestrictedPaths === true) sandboxMode = 'danger-full-access';
  return {
    ...DEFAULTS,
    ...src,
    sandboxMode,
    unrestrictedPaths: sandboxMode === 'danger-full-access'
  };
}

function loadPermissions(filePath) {
  try {
    if (fs.existsSync(filePath)) {
      const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      return normalizePermissions(raw);
    }
  } catch {
    // ignore
  }
  return { ...DEFAULTS };
}

function savePermissions(filePath, perms) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const next = normalizePermissions(perms);
  fs.writeFileSync(filePath, JSON.stringify(next, null, 2), 'utf8');
  return next;
}

module.exports = { DEFAULTS, loadPermissions, savePermissions, normalizePermissions };
