'use strict';

/**
 * 渲染健康判定（唯一来源）：把「暗」和「空」分开。
 *
 * 历史问题：只用截图像素（darkRatio / avgBrightness）判「页面没渲染出来」。
 * 纯黑主题的页面（`#000` 背景 + 白字）在像素上就是整幅全黑 —— 于是登录页被判成
 * `likelyBlank:true`，进而触发引擎改道与反复重绘恢复；而 ref、Cookie、登录态
 * 都贴在原来那个实例上，改道的代价是「换了一台机器」。
 *
 * 现在只有两类事实 + 一条判定：
 *   1. 像素事实 `darkPixels`：画面是否整幅全黑。**只说明「暗」，不说明「空」**。
 *   2. 内容事实 `content`：DOM 侧是否有可见内容（文本 / 可见交互元素 / canvas·img·svg）。
 *   3. `likelyBlank`：像素全黑 **且** 页面确认无可见内容，才算「空」。
 *      DOM 信号取不到时（脚本执行失败）不得断言「空」—— 误改道的代价远大于漏报。
 *
 * 本模块零 Electron 依赖，两个引擎共用同一份判据与同一份探测脚本。
 */

/** 像素「全黑」阈值（历史阈值，保留以免判定口径漂移）。 */
const PIXEL_DARK_RATIO = 0.985;
const PIXEL_DARK_BRIGHTNESS = 8;
/** 可见交互元素扫描上限：超大页面也不让探测脚本变慢。 */
const MAX_INTERACTIVE_SCAN = 60;

/** 判定原因（renderHealth.blankReason）。 */
const HEALTH_REASON = Object.freeze({
  /** 画面有非黑像素：正常渲染。 */
  RENDERED: 'rendered',
  /** 画面全黑但页面有可见内容：深色主题，不是空白。 */
  DARK_WITH_CONTENT: 'dark_theme_with_content',
  /** 画面全黑且 DOM 信号取不到：无法确认，按「不空」处理。 */
  DARK_UNVERIFIED: 'dark_pixels_content_unknown',
  /** 画面全黑且页面确认无可见内容：真的空白。 */
  BLANK: 'all_black_pixels_and_no_visible_content'
});

/** 判定为空白时的工具层警告（唯一文案来源）。 */
const BLANK_WARNING =
  '画面全黑且页面无可见内容（无文本 / 无可见交互元素 / 无媒体），判断为未渲染。' +
  '可先用 browser_status 确认；确实要换实现再显式用 engine=playwright。';

/** 画面全黑但内容信号缺失时的警告（唯一文案来源）。 */
const DARK_UNVERIFIED_WARNING =
  '画面接近全黑，但页面内容信号未取到，无法确认是否真的空白（可能只是深色主题）。' +
  '不要据此切换引擎；可用 browser_evaluate 检查 document.body.innerText.length。';

function toCount(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.round(n);
}

/** 像素事实（截图统计版）：整幅采样是否全黑。sampleCount 为 0 表示没采到样，不算全黑。 */
function pixelsAllBlack(visual) {
  if (!visual || typeof visual !== 'object') return false;
  const sampleCount = toCount(visual.sampleCount);
  if (sampleCount <= 0) return false;
  const darkRatio = Number(visual.darkRatio);
  const avgBrightness = Number(visual.avgBrightness);
  if (!Number.isFinite(darkRatio) || !Number.isFinite(avgBrightness)) return false;
  return darkRatio >= PIXEL_DARK_RATIO && avgBrightness < PIXEL_DARK_BRIGHTNESS;
}

/**
 * 位图是否可用于像素判定：尺寸非零、长度对齐。
 * 不可用 ≠ 全黑 —— 前者是数据坏了，后者是页面黑，调用方要分开处理。
 */
function isUsableBitmap(bitmap, width, height) {
  const total = toCount(width) * toCount(height);
  if (!total) return false;
  const buf = Buffer.isBuffer(bitmap) ? bitmap : Buffer.from(bitmap || []);
  return buf.length >= total * 4;
}

/** 像素事实（原始 BGRA 位图版）：整幅是否全黑。位图不可用时返回 false。 */
function isAllBlackBitmap(bitmap, width, height) {
  if (!isUsableBitmap(bitmap, width, height)) return false;
  const total = toCount(width) * toCount(height);
  const buf = Buffer.isBuffer(bitmap) ? bitmap : Buffer.from(bitmap || []);
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
    if (brightness < PIXEL_DARK_BRIGHTNESS) dark += 1;
  }
  if (!samples) return false;
  return dark / samples >= PIXEL_DARK_RATIO && sum / samples < PIXEL_DARK_BRIGHTNESS;
}

/**
 * 页面侧内容信号探测脚本（唯一来源）。
 * 写成 IIFE 表达式：既能直接交给 `webContents.executeJavaScript` / `page.evaluate`，
 * 也能作为 `buildEvaluateScript` 的脚本体（内部 `await`），两个引擎同一份。
 */
function buildContentSignalsScript() {
  return `(() => {
    const visible = (el) => {
      if (!el) return false;
      if (el.getClientRects && el.getClientRects().length === 0) return false;
      const style = window.getComputedStyle(el);
      if (!style) return false;
      if (style.display === 'none' || style.visibility === 'hidden') return false;
      return Number(style.opacity) !== 0;
    };
    const body = document.body;
    const bodyStyle = body ? window.getComputedStyle(body) : null;
    const nodes = document.querySelectorAll(
      'a[href],button,input,select,textarea,[role],[onclick],[contenteditable="true"],[tabindex]'
    );
    let interactiveCount = 0;
    for (let i = 0; i < nodes.length; i += 1) {
      if (visible(nodes[i])) interactiveCount += 1;
      if (interactiveCount >= ${MAX_INTERACTIVE_SCAN}) break;
    }
    return {
      readyState: document.readyState,
      title: document.title || '',
      url: location.href,
      textLength: ((body && body.innerText) || '').trim().length,
      interactiveCount,
      interactiveScanned: nodes.length,
      canvasCount: document.querySelectorAll('canvas').length,
      svgCount: document.querySelectorAll('svg').length,
      imageCount: document.images ? document.images.length : 0,
      bodyBackground: bodyStyle ? bodyStyle.backgroundColor : ''
    };
  })()`;
}

/**
 * 把页面侧返回值规整成内容事实。拿不到（null / 非对象 / 无任何字段）返回 null。
 * @param {object|null} page
 */
function readContentSignals(page) {
  if (!page || typeof page !== 'object') return null;
  const textLength = toCount(page.textLength);
  const interactiveCount = toCount(page.interactiveCount);
  const mediaCount = toCount(page.canvasCount) + toCount(page.imageCount) + toCount(page.svgCount);
  return {
    textLength,
    interactiveCount,
    mediaCount,
    hasContent: textLength > 0 || interactiveCount > 0 || mediaCount > 0
  };
}

/**
 * 唯一判定入口：把像素事实与内容事实合成 renderHealth 结论。
 * @param {{ visual?: object, allBlackPixels?: boolean, page?: object|null }} input
 *   `visual` 为截图统计（controller.analyzeImage）；`allBlackPixels` 供已用位图测过像素的调用方
 *   直接传入结论，避免重复采样；`page` 为内容信号原始返回。
 */
function classifyRenderHealth(input = {}) {
  const darkPixels = input.allBlackPixels == null ? pixelsAllBlack(input.visual) : !!input.allBlackPixels;
  const content = readContentSignals(input.page);
  const contentKnown = content != null;
  const likelyBlank = darkPixels && contentKnown && content.hasContent === false;
  let blankReason = HEALTH_REASON.RENDERED;
  if (likelyBlank) blankReason = HEALTH_REASON.BLANK;
  else if (darkPixels) blankReason = contentKnown ? HEALTH_REASON.DARK_WITH_CONTENT : HEALTH_REASON.DARK_UNVERIFIED;
  return { darkPixels, content, contentKnown, likelyBlank, blankReason };
}

/**
 * 位图 + 页面内容 → 完整判定（给不经过截图像素统计的调用方，如 visual_diff）。
 * `bitmapUsable=false` 表示位图本身不可用（尺寸 / 长度异常），与「全黑」是两回事：
 * 前者是抓取数据坏了，后者是页面黑。
 */
function classifyBitmapRenderHealth(bitmap, width, height, page) {
  const bitmapUsable = isUsableBitmap(bitmap, width, height);
  const allBlackPixels = isAllBlackBitmap(bitmap, width, height);
  return { bitmapUsable, ...classifyRenderHealth({ allBlackPixels, page }) };
}

/** 工具结果 warning 文案（唯一来源）。正常渲染（含深色主题）返回空串。 */
function renderHealthWarning(health) {
  if (!health || typeof health !== 'object' || health.ok === false) return '';
  if (health.likelyBlank) return BLANK_WARNING;
  if (health.darkPixels && !health.contentKnown) return DARK_UNVERIFIED_WARNING;
  return '';
}

module.exports = {
  HEALTH_REASON,
  BLANK_WARNING,
  DARK_UNVERIFIED_WARNING,
  pixelsAllBlack,
  isUsableBitmap,
  isAllBlackBitmap,
  buildContentSignalsScript,
  readContentSignals,
  classifyRenderHealth,
  classifyBitmapRenderHealth,
  renderHealthWarning
};
