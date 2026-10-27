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

function electronScreen() {
  return require('electron').screen;
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
 * 截取指定显示器，返回 { mime, base64, width, height }（像素即模型坐标系）。
 */
async function captureDisplay(display) {
  const desktopCapturer = require('electron').desktopCapturer;
  const want = displayPhysicalSize(display);
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: want });
  const hit = pickSourceForDisplay(sources, display, { singleDisplay: listDisplays().length === 1 });
  if (!hit.thumbnail || hit.thumbnail.isEmpty()) {
    const e = new Error(`屏幕 ${display.index} 捕获失败（desktopCapturer 返回空图像）`);
    e.code = 'CAPTURE_FAILED';
    throw e;
  }
  const image = hit.thumbnail;
  const size = image.getSize();
  return {
    mime: 'image/png',
    base64: image.toPNG().toString('base64'),
    width: size.width,
    height: size.height
  };
}

module.exports = { listDisplays, getDisplay, captureDisplay, pickSourceForDisplay };
