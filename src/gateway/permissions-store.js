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
   * OS 级电脑控制（computer 工具：截屏 + 鼠标键盘注入）。**默认开**：
   * 装好即可让 Agent 读屏干活（此前默认关，用户还得自己去设置页开一次）；
   * 鼠标/键盘动作仍按 sandbox-policy 的档位判定 ask-once（`danger-full-access` 除外），
   * 所以「默认开」放开的是截屏读屏，不是无确认的乱点。关掉即整个 computer 工具不再注入。
   */
  osControl: true,
  /**
   * 手机摄像头（`camera_look` 工具：让手机拍一张现实画面）。**默认关**。
   *
   * 为什么不像 osControl 那样默认开：它拍的是**现实世界**——镜头里的人、房间、桌上的东西，
   * 这些内容一旦进上下文/落盘就收不回来，还涉及旁人。所以必须由用户显式打开一次，
   * 打开后每次拍摄手机上仍有可见提示（不做常开预览、不做视频流）。
   * 关掉即整个工具不再注入；模型会看到「能力没开」而不是「能力不存在」。
   */
  camera: false,
  /**
   * 沙箱档位（唯一旋钮）：`read-only` | `workspace-write` | `danger-full-access`。
   * 语义与判定在 `sandbox-policy.js`；落盘白名单的唯一组装点是
   * gateway/server.js `_collectReadRoots/_collectWritableRoots`（远程侧同源
   * ssh/remote-path.js `remoteAllowedRoots`）。
   */
  sandboxMode: DEFAULT_SANDBOX_MODE,
  /**
   * 历史字段：仅作为 `sandboxMode === 'danger-full-access'` 的**派生视图**保留，
   * 供输入区快捷图标与设置页下拉读取（它们表达的是同一件事；设置页不再有独立复选框）。
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
