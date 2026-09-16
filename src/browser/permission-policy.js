'use strict';

/**
 * 内嵌浏览器的网页权限策略（纯函数，零 Electron 依赖，便于单测）。
 *
 * 背景：Electron 在未安装 permission handler 时默认「批准」权限请求，
 * 而浏览器分区（persist:dieyun-browser*）此前没有安装处理器 → 等于全放开。
 * 这里改为显式最小授权：只放行无害能力，其余（地理位置/通知/摄像头/麦克风录制等）拒绝。
 *
 * 需要新增能力时在此加白名单，并评估对 Agent 的风险。
 */

const BROWSER_PERMISSION_ALLOW = Object.freeze(
  new Set(['fullscreen', 'clipboard-sanitized-write', 'pointerLock'])
);

/**
 * @param {string} permission Electron 权限名
 * @param {{ mediaTypes?: string[] }} [details]
 * @returns {boolean}
 */
function isBrowserPermissionAllowed(permission, details) {
  if (permission === 'media') {
    const types = details && details.mediaTypes;
    return !types || types.includes('audio');
  }
  return BROWSER_PERMISSION_ALLOW.has(String(permission || ''));
}

module.exports = { BROWSER_PERMISSION_ALLOW, isBrowserPermissionAllowed };
