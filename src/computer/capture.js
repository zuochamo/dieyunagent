'use strict';

/**
 * OS 级屏幕截图（Electron desktopCapturer，仅 Main 进程）。
 *
 * 按「目标显示器物理像素」请求捕获（bounds × scaleFactor），实际分辨率以
 * 返回图像为准 —— 模型坐标就是这套截图像素（见 coordinate-map.js 口径说明）。
 *
 * 两处易踩的坑（都已用真机数据验证，别再改回去）：
 * 1. 匹配捕获源只能用 `display_id === String(Display.id)`。`Display` 上**没有** displayId
 *    字段（用它会恒为空 → 永远走「按序号猜」）；而 `getSources()` 的返回顺序与
 *    `getAllDisplays()` 不保证一致（实测双屏机正好相反），按序号猜会把另一块屏的
 *    截图当成本屏 —— 模型看 A 屏、坐标按 B 屏换算，点击落在别的显示器上。
 * 2. 物理原点只能问系统（`screen.dipToScreenPoint`）。`bounds.x × 本屏 scaleFactor`
 *    在混合 DPI 下会偏（实测偏 960px，且区间与主屏重叠）。
 */

const { displayPhysicalSize, displayPhysicalOrigin } = require('./coordinate-map');
const { AGENT_LIMITS_DEFAULTS } = require('../agent/agent-limits');

/**
 * 缩放后仍超预算时换 JPEG 的质量（界面截图对 JPEG 很耐受，只有极端细节图会走到这一步）。
 */
const JPEG_QUALITY = 82;
/** 逐次缩小的下限：再小就完全看不清界面了，此时宁可如实报「没注入」。 */
const MIN_SHOT_EDGE = 320;

function electronScreen() {
  return require('electron').screen;
}

/**
 * 按长边上限等比缩小；不需要缩小时原样返回。
 * @param {object} image Electron nativeImage
 * @param {number} maxEdge
 */
function shrinkToEdge(image, maxEdge) {
  const size = image.getSize();
  const longEdge = Math.max(size.width, size.height);
  if (!(maxEdge > 0) || longEdge <= maxEdge) return image;
  const ratio = maxEdge / longEdge;
  const width = Math.max(1, Math.round(size.width * ratio));
  const height = Math.max(1, Math.round(size.height * ratio));
  const out = image.resize({ width, height, quality: 'good' });
  return out && typeof out.isEmpty === 'function' && out.isEmpty() ? image : out;
}

/**
 * 把截图编码到「视觉注入预算」以内 —— 这是 computer/browser 截图能力的最后一环：
 * 编码超限的图会被 browser-vision 整张丢弃，模型就只能反复说「下一轮就能看到」。
 *
 * 顺序：长边缩放到上限 → PNG；仍超单张 base64 上限则换 JPEG；还超就再缩 30%（最多 4 轮）。
 * 全程不静默：走到最后仍超预算时回 `overBudget: true`，由工具结果如实告诉模型。
 *
 * @param {{ getSize: Function, resize: Function, isEmpty?: Function, toPNG: Function, toJPEG: Function }} image
 * @param {{ maxEdge?: number, maxBase64Chars?: number }} [opts]
 * @returns {{ mime: string, base64: string, width: number, height: number,
 *   native: { width: number, height: number }, overBudget?: boolean }}
 */
function encodeWithinBudget(image, opts = {}) {
  const wantEdge = Number(opts.maxEdge);
  const wantChars = Number(opts.maxBase64Chars);
  const maxEdge = wantEdge > 0 ? Math.round(wantEdge) : AGENT_LIMITS_DEFAULTS.visionShotMaxEdge;
  const maxBase64Chars =
    wantChars > 0 ? Math.round(wantChars) : AGENT_LIMITS_DEFAULTS.visionMaxBase64Chars;
  const native = image.getSize();
  let current = shrinkToEdge(image, maxEdge);
  /** @type {{ mime: string, base64: string, width: number, height: number }|null} */
  let last = null;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const size = current.getSize();
    const png = current.toPNG().toString('base64');
    last = { mime: 'image/png', base64: png, width: size.width, height: size.height };
    if (png.length <= maxBase64Chars) return { ...last, native };
    const jpeg = current.toJPEG(JPEG_QUALITY).toString('base64');
    last = { mime: 'image/jpeg', base64: jpeg, width: size.width, height: size.height };
    if (jpeg.length <= maxBase64Chars) return { ...last, native };
    const longEdge = Math.max(size.width, size.height);
    const nextEdge = Math.max(MIN_SHOT_EDGE, Math.round(longEdge * 0.7));
    if (nextEdge >= longEdge) break;
    current = shrinkToEdge(current, nextEdge);
  }
  return { ...last, native, overBudget: true };
}

/** 系统换算出的显示器左上角物理坐标；平台/版本不支持时返回 null。 */
function systemPhysicalOrigin(bounds) {
  try {
    const screen = electronScreen();
    if (typeof screen.dipToScreenPoint !== 'function') return null;
    const p = screen.dipToScreenPoint({ x: bounds.x, y: bounds.y });
    if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) return null;
    return { x: Math.round(p.x), y: Math.round(p.y) };
  } catch {
    return null;
  }
}

/**
 * 显示器清单（含物理几何）。**主屏固定排第 0 位** —— 模型看到的 `display` 序号必须
 * 与文档「0 = 主屏」一致，而 `getAllDisplays()` 不保证主屏在前。
 * @returns {Array<{ index: number, id: number|string, displayId: string, primary: boolean,
 *   bounds: object, scaleFactor: number, physOrigin: {x:number,y:number}, physSize: {width:number,height:number} }>}
 */
function listDisplays() {
  const screen = electronScreen();
  const primaryId = screen.getPrimaryDisplay().id;
  const rows = screen.getAllDisplays().map((d) => {
    const bounds = d.bounds;
    const scaleFactor = d.scaleFactor || 1;
    return {
      id: d.id,
      displayId: String(d.id),
      primary: d.id === primaryId,
      bounds,
      scaleFactor,
      physOrigin: systemPhysicalOrigin(bounds) || displayPhysicalOrigin({ bounds, scaleFactor }),
      physSize: displayPhysicalSize({ bounds, scaleFactor })
    };
  });
  // 稳定排序：主屏在前，其余保持系统顺序
  rows.sort((a, b) => Number(b.primary) - Number(a.primary));
  return rows.map((d, index) => ({ ...d, index }));
}

/**
 * 取目标显示器：缺省主屏；序号越界报错（带当前清单，模型可自行纠正）。
 * @param {number} [index]
 */
function getDisplay(index) {
  const list = listDisplays();
  if (!list.length) {
    const e = new Error('没有可用的显示器');
    e.code = 'CAPTURE_FAILED';
    throw e;
  }
  if (index == null || index === '') return list.find((d) => d.primary) || list[0];
  const n = Number(index);
  const hit = list.find((d) => d.index === n);
  if (!hit) {
    const e = new Error(`display=${n} 不存在；当前共 ${list.length} 块屏幕（0..${list.length - 1}，0=主屏）`);
    e.code = 'DISPLAY_NOT_FOUND';
    e.retryable = false;
    throw e;
  }
  return hit;
}

/**
 * 在 desktopCapturer 的源里找出目标屏的源：唯一正确的键是 `display_id === String(Display.id)`。
 * 匹配不到就报错（不做「按序号兜底」：静默截错屏比失败更难查）。
 * @param {Array} sources getSources 的返回
 * @param {object} display listDisplays() 的条目
 * @param {{ singleDisplay?: boolean }} [opts] 单屏单源时允许无视 display_id（部分平台不提供）
 */
function pickSourceForDisplay(sources, display, opts = {}) {
  const list = Array.isArray(sources) ? sources.filter(Boolean) : [];
  const want = String((display && display.displayId) || '');
  if (want) {
    const hit = list.find((s) => String(s.display_id || '') === want);
    if (hit) return hit;
  }
  // 只有一块屏、也只有一个源：无歧义（Linux 等平台可能不给 display_id）
  if (want && opts.singleDisplay === true && list.length === 1) return list[0];
  const e = new Error(
    `屏幕 ${display && display.index}（display_id=${want || '?'}）捕获失败：desktopCapturer 没有对应源` +
      `（当前源 display_id：${list.map((s) => s.display_id || '?').join('、') || '无'}）`
  );
  e.code = 'CAPTURE_FAILED';
  throw e;
}

/**
 * 截取指定显示器，返回 { mime, base64, width, height }。
 *
 * **width/height 是注入给模型的那张图的尺寸**（按 agent-limits 的长边上限缩放过），
 * 也就是模型坐标系本身 —— coordinate-map 的换算一直以「模型看到的截图」为准，
 * 所以缩放是安全的：模型报的坐标与窗口物理坐标仍能对上，只是屏幕像素被等比压缩。
 *
 * @param {object} display listDisplays() 的条目
 * @param {{ maxEdge?: number, maxBase64Chars?: number }} [visionBudget] 缺省取 agent-limits 默认值
 */
async function captureDisplay(display, visionBudget) {
  const desktopCapturer = require('electron').desktopCapturer;
  const want = displayPhysicalSize(display);
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: want });
  const hit = pickSourceForDisplay(sources, display, { singleDisplay: listDisplays().length === 1 });
  if (!hit.thumbnail || hit.thumbnail.isEmpty()) {
    const e = new Error(`屏幕 ${display.index} 捕获失败（desktopCapturer 返回空图像）`);
    e.code = 'CAPTURE_FAILED';
    throw e;
  }
  const shot = encodeWithinBudget(hit.thumbnail, visionBudget || {});
  return {
    mime: shot.mime,
    base64: shot.base64,
    width: shot.width,
    height: shot.height,
    nativeWidth: shot.native.width,
    nativeHeight: shot.native.height
  };
}

module.exports = {
  listDisplays,
  getDisplay,
  captureDisplay,
  encodeWithinBudget,
  pickSourceForDisplay
};
