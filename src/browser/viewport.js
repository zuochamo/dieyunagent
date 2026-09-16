'use strict';

/**
 * 视口/设备仿真参数规整（纯函数，零 Electron 依赖，便于单测）。
 *
 * 用途：让 BrowserView（默认随面板尺寸）与 Playwright（默认 1280×800）能对齐到
 * 同一视口，避免 auto 模式下同一页面两种渲染导致验收结论漂移；同时支持
 * 响应式/移动端布局的验收。
 */

const VIEWPORT_MIN = 120;
const VIEWPORT_MAX = 4096;
const VIEWPORT_DEFAULT = Object.freeze({ width: 1280, height: 800 });
const DSF_MIN = 0.5;
const DSF_MAX = 4;

function clampInt(raw, min, max) {
  const n = Math.round(Number(raw));
  if (!Number.isFinite(n)) return 0;
  return Math.min(max, Math.max(min, n));
}

/**
 * @param {{ width?: number, height?: number, deviceScaleFactor?: number, mobile?: boolean }} args
 * @returns {{ width: number, height: number, deviceScaleFactor: number, mobile: boolean } | null}
 *   width/height 任一缺失或非法时返回 null（由调用方报错）。
 */
function normalizeViewport(args = {}) {
  const width = clampInt(args.width, VIEWPORT_MIN, VIEWPORT_MAX);
  const height = clampInt(args.height, VIEWPORT_MIN, VIEWPORT_MAX);
  if (!width || !height) return null;
  const dsfRaw = Number(args.deviceScaleFactor);
  const deviceScaleFactor = Number.isFinite(dsfRaw)
    ? Math.min(DSF_MAX, Math.max(DSF_MIN, dsfRaw))
    : 1;
  return { width, height, deviceScaleFactor, mobile: !!args.mobile };
}

/**
 * 允许「模拟授权」的权限白名单（其余仍按 permission-policy 一律拒绝）。
 * 仅用于本地验收（如需要定位/通知的前端功能），不改变默认拒绝策略。
 */
const EMULATE_PERMISSIONS = Object.freeze([
  'geolocation',
  'notifications',
  'clipboard-read',
  'clipboard-sanitized-write',
  'midi',
  'midiSysex'
]);

function clampNumber(raw, min, max) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  if (n < min || n > max) return null;
  return n;
}

/**
 * 规整设备/权限仿真参数（纯函数，非法项静默丢弃由调用方决定是否报错）。
 * @param {{
 *   geolocation?: { latitude?: number, longitude?: number, accuracy?: number },
 *   timezone?: string,
 *   locale?: string,
 *   permissions?: string[]
 * }} args
 * @returns {{
 *   geolocation: { latitude: number, longitude: number, accuracy: number } | null,
 *   timezone: string,
 *   locale: string,
 *   permissions: string[]
 * }}
 */
function normalizeEmulation(args = {}) {
  const geoRaw = args.geolocation && typeof args.geolocation === 'object' ? args.geolocation : null;
  let geolocation = null;
  if (geoRaw) {
    const latitude = clampNumber(geoRaw.latitude, -90, 90);
    const longitude = clampNumber(geoRaw.longitude, -180, 180);
    if (latitude !== null && longitude !== null) {
      const accuracy = clampNumber(geoRaw.accuracy, 1, 100000);
      geolocation = { latitude, longitude, accuracy: accuracy === null ? 100 : accuracy };
    }
  }
  const permissions = [];
  for (const item of Array.isArray(args.permissions) ? args.permissions : []) {
    const name = String(item || '').trim();
    if (name && EMULATE_PERMISSIONS.indexOf(name) >= 0 && permissions.indexOf(name) < 0) {
      permissions.push(name);
    }
  }
  return {
    geolocation,
    timezone: String(args.timezone || '').trim(),
    locale: String(args.locale || '').trim(),
    permissions
  };
}

module.exports = {
  VIEWPORT_MIN,
  VIEWPORT_MAX,
  VIEWPORT_DEFAULT,
  DSF_MIN,
  DSF_MAX,
  EMULATE_PERMISSIONS,
  normalizeViewport,
  normalizeEmulation
};
