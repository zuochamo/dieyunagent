'use strict';

/**
 * 拖动的位置算账（**纯函数**，不 require electron）：`main/pet-window.js` 只负责调屏幕 API。
 *
 * 为什么单独一份：拖动的三条不变量都是「算」出来的（抓取偏移 / 指针 → 窗口位置 / 夹进哪台显示器），
 * 而 `main/pet-window.js` 顶层 `require('electron')`，在单测里装不进来 —— 于是这块以前零直测，
 * 「拖不动 / 位置卡死」只能靠现场猜。纯函数版由 `test/unit/pet-drag.test.cjs` 直接驱动。
 *
 * 坐标口径：全部是 DIP（页面报的 `screenX/screenY` 与 Electron `screen` / `setPosition` 同一空间）。
 */

/** 点到矩形工作区的距离平方（0 = 在内部）。多屏 DPI 不一致时显示区之间确实有缝，用它找最近那台 */
function distanceToRectSq(px, py, wa) {
  const dx = px < wa.x ? wa.x - px : px > wa.x + wa.width ? px - (wa.x + wa.width) : 0;
  const dy = py < wa.y ? wa.y - py : py > wa.y + wa.height ? py - (wa.y + wa.height) : 0;
  return dx * dx + dy * dy;
}

/**
 * 夹取用的工作区：**窗口中心所在**的那台；中心落在「哪台都不在」的缝里时取**最近**那台。
 *
 * 为什么不是「找不到就回退主屏」：混合 DPI / 不同分辨率的排列下，系统报出来的显示区之间会有空隙，
 * 中心掉进去就回退主屏 —— 宠物在跨屏拖动时突然跳回主屏，用户看到的是「拖不过去 / 位置卡住」。
 */
function pickWorkArea(areas, cx, cy, fallback) {
  const list = Array.isArray(areas) ? areas.filter((wa) => wa && typeof wa.x === 'number') : [];
  const inside = list.find(
    (wa) => cx >= wa.x && cx < wa.x + wa.width && cy >= wa.y && cy < wa.y + wa.height
  );
  if (inside) return inside;
  let best = null;
  let bestDist = Infinity;
  for (const wa of list) {
    const dist = distanceToRectSq(cx, cy, wa);
    if (dist < bestDist) {
      bestDist = dist;
      best = wa;
    }
  }
  if (best) return best;
  return fallback && typeof fallback.x === 'number' ? fallback : { x: 0, y: 0, width: 1280, height: 800 };
}

/** 把窗口左上角夹进 `pickWorkArea` 选中的工作区（窗口整块留在屏内） */
function clampIntoWorkArea(areas, x, y, edge, fallback) {
  const width = Math.max(1, Math.round(edge));
  const wa = pickWorkArea(areas, x + width / 2, y + width / 2, fallback);
  const maxX = wa.x + Math.max(0, wa.width - width);
  const maxY = wa.y + Math.max(0, wa.height - width);
  return {
    x: Math.min(Math.max(Math.round(x), wa.x), maxX),
    y: Math.min(Math.max(Math.round(y), wa.y), maxY)
  };
}

/**
 * 抓取偏移 = 指针 − 窗口左上角。Main 在 dragStart 时算一次，之后所有移动都用它。
 *
 * 偏移丢了（`dragStart` 没拿到窗口 / `getBounds` 抛错 / 窗口刚重建）时**不能丢弃移动**：
 * 用它现补一份，此时「新位置 = 指针 − 新偏移 = 当前位置」—— 窗口不跳，拖动照常继续。
 * 静默 return 的表现正是「页面在拖、窗口一动不动」。
 */
function offsetForPointer(bounds, pointer) {
  const b = bounds || { x: 0, y: 0 };
  const p = pointer || { x: 0, y: 0 };
  return { x: Number(p.x) - Number(b.x), y: Number(p.y) - Number(b.y) };
}

/** 指针当前坐标 → 窗口左上角（已夹取） */
function positionForPointer(areas, bounds, offset, pointer, fallback) {
  const edge = Math.max(1, Number(bounds && bounds.width) || 1);
  const off = offset || { x: 0, y: 0 };
  return clampIntoWorkArea(areas, Number(pointer.x) - off.x, Number(pointer.y) - off.y, edge, fallback);
}

module.exports = {
  distanceToRectSq,
  pickWorkArea,
  clampIntoWorkArea,
  offsetForPointer,
  positionForPointer
};
