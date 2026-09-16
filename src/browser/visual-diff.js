'use strict';

/**
 * 像素级视觉差异比较（纯计算，零 Electron 依赖，便于单测）。
 *
 * 输入是 Electron `nativeImage.toBitmap()` 的原始位图（**BGRA** 顺序，
 * 与 `nativeImage.createFromBitmap()` 期望的输入一致，可直接回编码成 PNG）。
 *
 * 用途：回归验收 —— 「改前 vs 改后」页面是否发生变化。
 * 注意：只有**同引擎 + 同视口**的比较才有意义，跨引擎像素必然不同，
 * 该约束由调用方（service）用基准元信息硬校验。
 */

const DEFAULT_PIXEL_TOLERANCE = 12;
const DEFAULT_RATIO_THRESHOLD = 0.005;

function toTolerance(raw) {
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_PIXEL_TOLERANCE;
}

function clampRatio(raw, fallback) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.min(1, n);
}

/** 稳定的短哈希（djb2），用于默认基准文件名。 */
function stableKey(input) {
  const s = String(input == null ? '' : input);
  let h = 5381;
  for (let i = 0; i < s.length; i += 1) {
    h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  }
  return h.toString(36);
}

/**
 * 逐像素比较两张同尺寸位图。
 * @param {Buffer|Uint8Array} prev
 * @param {Buffer|Uint8Array} next
 * @param {{ width: number, height: number, pixelTolerance?: number, ratioThreshold?: number }} opts
 */
function diffBitmaps(prev, next, opts = {}) {
  const width = Math.max(0, Math.round(Number(opts.width) || 0));
  const height = Math.max(0, Math.round(Number(opts.height) || 0));
  const totalPixels = width * height;
  const pixelTolerance = toTolerance(opts.pixelTolerance);
  const ratioThreshold = clampRatio(opts.ratioThreshold, DEFAULT_RATIO_THRESHOLD);
  const a = Buffer.isBuffer(prev) ? prev : Buffer.from(prev || []);
  const b = Buffer.isBuffer(next) ? next : Buffer.from(next || []);
  const expected = totalPixels * 4;

  if (!totalPixels || a.length !== expected || b.length !== expected) {
    return {
      ok: false,
      errorCode: 'BITMAP_SIZE_MISMATCH',
      width,
      height,
      totalPixels,
      changedPixels: 0,
      ratio: 0,
      ratioThreshold,
      changed: true,
      diffBitmap: b.length ? Buffer.from(b) : Buffer.alloc(0)
    };
  }

  const diffBitmap = Buffer.alloc(expected);
  let changedPixels = 0;
  for (let i = 0; i < expected; i += 4) {
    const db = Math.abs(a[i] - b[i]);
    const dg = Math.abs(a[i + 1] - b[i + 1]);
    const dr = Math.abs(a[i + 2] - b[i + 2]);
    const da = Math.abs(a[i + 3] - b[i + 3]);
    if (Math.max(db, dg, dr, da) > pixelTolerance) {
      changedPixels += 1;
      // BGRA：不透明纯红
      diffBitmap[i] = 0;
      diffBitmap[i + 1] = 0;
      diffBitmap[i + 2] = 255;
      diffBitmap[i + 3] = 255;
    } else {
      // 未变化：淡化成浅灰，让红色差异更醒目
      const lum = (b[i] + b[i + 1] + b[i + 2]) / 3;
      const faded = Math.round(lum * 0.35 + 255 * 0.65);
      diffBitmap[i] = faded;
      diffBitmap[i + 1] = faded;
      diffBitmap[i + 2] = faded;
      diffBitmap[i + 3] = 255;
    }
  }

  const ratio = totalPixels ? changedPixels / totalPixels : 0;
  return {
    ok: true,
    width,
    height,
    totalPixels,
    changedPixels,
    ratio,
    ratioThreshold,
    changed: ratio > ratioThreshold,
    diffBitmap
  };
}

/**
 * 引擎无关的"疑似全黑"判定（与 controller.analyzeImage 同阈值）。
 * 用于拒绝把空白截图当成基准或"无变化"，BrowserView / Playwright 一视同仁。
 * @param {Buffer|Uint8Array} bitmap BGRA 位图
 */
function isLikelyBlankBitmap(bitmap, width, height) {
  const total = Math.max(0, Math.round(Number(width) || 0)) * Math.max(0, Math.round(Number(height) || 0));
  if (!total) return true;
  const buf = Buffer.isBuffer(bitmap) ? bitmap : Buffer.from(bitmap || []);
  if (buf.length < total * 4) return true;

  const step = Math.max(1, Math.floor(total / 4096));
  let samples = 0;
  let dark = 0;
  let sum = 0;
  for (let p = 0; p < total; p += step) {
    const i = p * 4;
    const b = buf[i] || 0;
    const g = buf[i + 1] || 0;
    const r = buf[i + 2] || 0;
    const brightness = (r + g + b) / 3;
    samples += 1;
    sum += brightness;
    if (brightness < 8) dark += 1;
  }
  const avgBrightness = samples ? sum / samples : 0;
  const darkRatio = samples ? dark / samples : 1;
  return darkRatio > 0.985 && avgBrightness < 8;
}

module.exports = {
  DEFAULT_PIXEL_TOLERANCE,
  DEFAULT_RATIO_THRESHOLD,
  clampRatio,
  stableKey,
  diffBitmaps,
  isLikelyBlankBitmap
};
