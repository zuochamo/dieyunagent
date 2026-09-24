'use strict';

/**
 * 像素级视觉差异比较（纯计算，零 Electron 依赖，便于单测）。
 *
 * 输入是 Electron `nativeImage.toBitmap()` 的原始位图（**BGRA** 顺序，
 * 与 `nativeImage.createFromBitmap()` 期望的输入一致，可直接回编码成 PNG）。
 *
 * 用途：回归验收 —— 「改前 vs 改后」页面是否发生变化。
 * 注意：只有**同引擎 + 同视口**的比较才有意义，跨引擎像素必然不同；
 * 该约束靠 `withEngineTag` 把引擎编进基准文件名来实现 —— 不同引擎落在不同文件，
 * 「拿 A 引擎的基准跟 B 引擎比」结构上不可能发生，不需要额外的元信息文件。
 *
 * 像素级「全黑」事实与「空 / 暗」判定在 `render-health.js`（唯一来源），
 * 本模块只做「两张图之间的差异」与「基准文件命名」。
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
 * 引擎隔离的**唯一实现**：把 engine 插到扩展名前。
 * `shots/login.png` + browserview → `shots/login.browserview.png`。
 *
 * 这样「跨引擎拿同一张基准比较」不会发生 —— 不是靠运行时报错拦住，而是两侧根本
 * 指向不同文件。因此基准不需要再落一份 `.meta.json` 记录引擎。
 *
 * 幂等：已带本引擎标记的路径原样返回。模型会把上一次返回的 `baselinePath` 传回来，
 * 二次追加会凭空造出新文件、让基准永远对不上。
 */
function withEngineTag(filePath, engine) {
  const p = String(filePath || '');
  const tag = `.${engine || 'unknown'}`;
  const dot = p.lastIndexOf('.');
  const hasExt = dot > 0 && dot > p.lastIndexOf('/') && dot > p.lastIndexOf('\\');
  const base = hasExt ? p.slice(0, dot) : p;
  const ext = hasExt ? p.slice(dot) : '.png';
  if (base.endsWith(tag)) return p;
  return `${base}${tag}${ext}`;
}

/**
 * 默认基准文件名（不含目录、不含引擎标记 —— 引擎标记统一由 withEngineTag 附加）：
 * 按目标派生稳定 key，保证同一目标多次调用比的是同一个文件。
 * @param {{ ref?: string, selector?: string, fullPage?: boolean }} params
 */
function defaultBaselineName(params = {}) {
  const key = stableKey(
    [params.ref || '', params.selector || '', params.fullPage ? 'full' : 'viewport'].join('|')
  );
  return `dieyun-visual-baseline-${key}.png`;
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

module.exports = {
  DEFAULT_PIXEL_TOLERANCE,
  DEFAULT_RATIO_THRESHOLD,
  clampRatio,
  stableKey,
  withEngineTag,
  defaultBaselineName,
  diffBitmaps
};
