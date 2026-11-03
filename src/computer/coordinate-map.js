'use strict';

/**
 * 电脑控制的坐标换算（纯函数，无 Electron / koffi 依赖，可单测）。
 *
 * 统一口径：
 * - 模型看到的坐标系 = **它最近一次看到的那张图**的像素（左上角为原点）。
 *   那张图通常是一块屏的全图，也可能是该屏的一块裁剪（`screenshot` 的 `region`）。
 * - 注入与光标回报用「全局物理像素」（virtual desktop 空间，primary 左上为原点）。
 *
 * 「视图」= 被截的那块屏幕矩形 + 注入给模型的那张图的尺寸：
 *   { originX, originY, nativeWidth, nativeHeight, width, height }
 * 换算链：视图像素 ×(native/图尺寸) → + 视图原点 → 全局物理。
 * 全屏截图时 origin = 屏原点、native = 屏物理尺寸，退化成「1:1 或等比缩放」的旧口径，
 * 所以裁剪与全屏共用同一套映射（没有第二种坐标语义）。
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

function positiveInt(v, fallback) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function clampInt(v, lo, hi) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return lo;
  return Math.min(Math.max(n, lo), hi);
}

/** 视图自洽兜底：缺字段/零尺寸时按 1:1 处理，绝不让除零把坐标变成 NaN。 */
function normalizeView(view) {
  const v = view && typeof view === 'object' ? view : {};
  const nativeWidth = positiveInt(v.nativeWidth, 1);
  const nativeHeight = positiveInt(v.nativeHeight, 1);
  return {
    originX: Number.isFinite(Number(v.originX)) ? Math.round(Number(v.originX)) : 0,
    originY: Number.isFinite(Number(v.originY)) ? Math.round(Number(v.originY)) : 0,
    nativeWidth,
    nativeHeight,
    width: positiveInt(v.width, nativeWidth),
    height: positiveInt(v.height, nativeHeight)
  };
}

/**
 * 全屏视图（整块屏 → 整张图）。
 * @param {object} display capture.js 的 display 对象
 * @param {{width:number,height:number}} [encodedSize] 注入给模型的图尺寸；缺省 = 物理尺寸（1:1）
 */
function fullView(display, encodedSize) {
  const phys = displayPhysicalSize(display);
  const origin = displayPhysicalOrigin(display);
  return {
    originX: origin.x,
    originY: origin.y,
    nativeWidth: phys.width,
    nativeHeight: phys.height,
    width: positiveInt(encodedSize && encodedSize.width, phys.width),
    height: positiveInt(encodedSize && encodedSize.height, phys.height)
  };
}

/**
 * 视图坐标 → 全局物理坐标。
 * 越界坐标在这里钳制到图内（模型报 2000 不该点到别的屏/别的屏外区域）。
 */
function viewPointToScreenPhysical(view, point) {
  const v = normalizeView(view);
  const x = clampInt(point && point[0], 0, v.width - 1);
  const y = clampInt(point && point[1], 0, v.height - 1);
  return {
    x: v.originX + Math.round((x * v.nativeWidth) / v.width),
    y: v.originY + Math.round((y * v.nativeHeight) / v.height)
  };
}

/**
 * 全局物理坐标 → 视图坐标（光标回报）。
 * 与正换算同一套比例：截图被放大/缩小过时，cursor 与 coordinate 才是同一个空间。
 */
function screenPhysicalToViewPoint(view, point) {
  const v = normalizeView(view);
  const p = point || { x: 0, y: 0 };
  return {
    x: Math.round(((Number(p.x) - v.originX) * v.width) / v.nativeWidth),
    y: Math.round(((Number(p.y) - v.originY) * v.height) / v.nativeHeight)
  };
}

/**
 * 视图里的一块矩形（`screenshot` 的 `region`）→ 全局物理矩形，钳制在视图内。
 * @param {object} baseView 模型当前坐标空间
 * @param {number[]} region [x, y, w, h]（baseView 的像素）
 * @returns {{ x: number, y: number, width: number, height: number }}
 */
function viewRectToPhysicalRect(baseView, region) {
  const v = normalizeView(baseView);
  const r = Array.isArray(region) ? region : [];
  const x0 = clampInt(r[0], 0, v.width - 1);
  const y0 = clampInt(r[1], 0, v.height - 1);
  const x1 = clampInt(x0 + positiveInt(r[2], v.width), x0 + 1, v.width);
  const y1 = clampInt(y0 + positiveInt(r[3], v.height), y0 + 1, v.height);
  const sx = v.nativeWidth / v.width;
  const sy = v.nativeHeight / v.height;
  return {
    x: v.originX + Math.round(x0 * sx),
    y: v.originY + Math.round(y0 * sy),
    width: Math.max(1, Math.round((x1 - x0) * sx)),
    height: Math.max(1, Math.round((y1 - y0) * sy))
  };
}

/**
 * 全局物理矩形 → 视图（新的坐标空间）。
 * 裁剪出来的那张图以矩形左上角为原点、native 尺寸就是矩形尺寸；
 * `width/height`（注入给模型的图尺寸）由编码端补上。
 * @param {{ x: number, y: number, width: number, height: number }} rect
 */
function regionView(rect) {
  const r = rect || {};
  return {
    originX: Math.round(Number(r.x) || 0),
    originY: Math.round(Number(r.y) || 0),
    nativeWidth: positiveInt(r.width, 1),
    nativeHeight: positiveInt(r.height, 1)
  };
}

/**
 * 全局物理矩形 → 视图里的矩形（list_windows 的窗口位置换算成「和 click 同一套像素」）。
 * 与 screenPhysicalToViewPoint 同比例，不钳制：落在视图外的窗口要如实越界。
 */
function physicalRectToViewRect(view, rect) {
  const v = normalizeView(view);
  const r = rect || {};
  const tl = screenPhysicalToViewPoint(v, { x: r.x, y: r.y });
  const br = screenPhysicalToViewPoint(v, { x: Number(r.x) + Number(r.width), y: Number(r.y) + Number(r.height) });
  return {
    x: tl.x,
    y: tl.y,
    width: Math.max(0, br.x - tl.x),
    height: Math.max(0, br.y - tl.y)
  };
}

/**
 * 两个视图是否覆盖同一块屏幕矩形（不看图尺寸）。
 *
 * 用途：动作后要不要「继续给同一块放大区域」的判定 —— 只看矩形是否一致，
 * 图尺寸每次都可能因为编码缩放略有不同，不该影响这个决定。
 */
function sameViewRect(a, b) {
  if (!a || !b) return false;
  const x = normalizeView(a);
  const y = normalizeView(b);
  return (
    x.originX === y.originX &&
    x.originY === y.originY &&
    x.nativeWidth === y.nativeWidth &&
    x.nativeHeight === y.nativeHeight
  );
}

/**
 * 两个视图是否同一个坐标空间（同屏 + 同区域 + 同图尺寸）。
 *
 * 只有同空间的帧指纹才可比 —— 否则「画面变了吗」比的是两块不同的区域，
 * 那是个假信号（比没有信号更糟）。
 */
function sameViewSpace(a, b) {
  if (!sameViewRect(a, b)) return false;
  const x = normalizeView(a);
  const y = normalizeView(b);
  return x.width === y.width && x.height === y.height;
}

module.exports = {
  displayPhysicalSize,
  displayPhysicalOrigin,
  fullView,
  viewPointToScreenPhysical,
  screenPhysicalToViewPoint,
  viewRectToPhysicalRect,
  regionView,
  physicalRectToViewRect,
  sameViewRect,
  sameViewSpace
};
