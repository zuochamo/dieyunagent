'use strict';

/**
 * 电脑控制的坐标换算（纯函数，无 Electron / koffi 依赖，可单测）。
 *
 * 统一口径：
 * - 模型看到的坐标系 = 截图像素，即目标显示器**左上角为原点的物理像素**。
 * - 注入与光标回报用「全局物理像素」（virtual desktop 空间，primary 左上为原点）。
 * - 换算链：截图像素 → 显示器物理尺寸缩放 → + 显示器物理原点 → 全局物理。
 *
 * 物理几何的唯一来源是 `capture.js` 的 `listDisplays()`：它用系统 API
 * （`screen.dipToScreenPoint`）求出每块屏的物理原点/尺寸挂在 display 对象上。
 * 这里保留的 `bounds × 本屏 scaleFactor` 只是**兜底**（单测、非 Windows、旧 Electron）：
 * 混合 DPI 下它是错的 —— 实测「1.5 倍副屏挂在主屏右侧 1920 DIP 处」时，真实物理原点是
 * 3840（主屏物理宽），而 bounds.x × 1.5 = 2880，差 960px，且算出来的区间会与主屏重叠。
 */

/** 显示器的物理像素尺寸：优先系统给出的 physSize，退化到 DIP × scaleFactor。 */
function displayPhysicalSize(display) {
  const sys = display && display.physSize;
  if (sys && Number.isFinite(sys.width) && Number.isFinite(sys.height) && sys.width > 0 && sys.height > 0) {
    return { width: Math.round(sys.width), height: Math.round(sys.height) };
  }
  const b = (display && display.bounds) || { width: 0, height: 0 };
  const s = (display && display.scaleFactor) || 1;
  return {
    width: Math.max(1, Math.round(b.width * s)),
    height: Math.max(1, Math.round(b.height * s))
  };
}

/** 显示器左上角在全局物理空间中的位置：优先系统给出的 physOrigin，退化到 DIP × scaleFactor。 */
function displayPhysicalOrigin(display) {
  const sys = display && display.physOrigin;
  if (sys && Number.isFinite(sys.x) && Number.isFinite(sys.y)) {
    return { x: Math.round(sys.x), y: Math.round(sys.y) };
  }
  const b = (display && display.bounds) || { x: 0, y: 0 };
  const s = (display && display.scaleFactor) || 1;
  return { x: Math.round(b.x * s), y: Math.round(b.y * s) };
}

/**
 * 模型坐标（截图像素，显示器左上原点）→ 全局物理坐标。
 * captureSize 是实际返回的截图尺寸（可能与请求的物理尺寸有出入，按比例校正）。
 * @param {object} display capture.js 的 display 对象
 * @param {{width:number, height:number}} captureSize
 * @param {number[]} point [x, y]
 */
function mapDisplayPointToScreenPhysical(display, captureSize, point) {
  const phys = displayPhysicalSize(display);
  const cw = Math.max(1, (captureSize && captureSize.width) || phys.width);
  const ch = Math.max(1, (captureSize && captureSize.height) || phys.height);
  const origin = displayPhysicalOrigin(display);
  return {
    x: origin.x + Math.round((point[0] * phys.width) / cw),
    y: origin.y + Math.round((point[1] * phys.height) / ch)
  };
}

/**
 * 全局物理坐标 → 模型坐标（截图像素空间），用于回报光标位置。
 * 与正向换算是同一套比例的逆运算：给了 captureSize 就缩回截图空间，
 * 否则按物理像素回报（两者不一致会让模型对不上自己看到的画面）。
 * @param {object} display
 * @param {{x:number, y:number}} globalPhysicalPoint
 * @param {{width:number, height:number}} [captureSize]
 */
function mapScreenPhysicalToDisplayPoint(display, globalPhysicalPoint, captureSize) {
  const phys = displayPhysicalSize(display);
  const cw = Math.max(1, (captureSize && captureSize.width) || phys.width);
  const ch = Math.max(1, (captureSize && captureSize.height) || phys.height);
  const origin = displayPhysicalOrigin(display);
  return {
    x: Math.round(((globalPhysicalPoint.x - origin.x) * cw) / phys.width),
    y: Math.round(((globalPhysicalPoint.y - origin.y) * ch) / phys.height)
  };
}

module.exports = {
  displayPhysicalSize,
  displayPhysicalOrigin,
  mapDisplayPointToScreenPhysical,
  mapScreenPhysicalToDisplayPoint
};
