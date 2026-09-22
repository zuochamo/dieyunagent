'use strict';

const {
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
} = require('../../src/browser/render-health');

/** 全黑位图（BGRA：alpha=255、RGB=0）。 */
function blackBitmap(pixels = 4) {
  const buf = Buffer.alloc(pixels * 4, 0);
  for (let i = 3; i < buf.length; i += 4) buf[i] = 255;
  return buf;
}

/** 最小 DOM 桩：只覆盖探测脚本用到的接口。 */
function makeDom(overrides = {}) {
  const nodes = Array.from({ length: overrides.interactiveCount || 0 }, () => ({
    getClientRects: () => [{}]
  }));
  return {
    document: {
      readyState: 'complete',
      title: 'Stub',
      body: { innerText: overrides.text || '' },
      images: { length: overrides.imageCount || 0 },
      querySelectorAll: (selector) => {
        if (selector === 'canvas') return { length: overrides.canvasCount || 0 };
        if (selector === 'svg') return { length: overrides.svgCount || 0 };
        return nodes;
      }
    },
    window: {
      getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' })
    },
    location: { href: 'http://example.test/login' }
  };
}

function runContentSignals(dom) {
  // 模拟 webContents.executeJavaScript / page.evaluate 的表达式求值
  const fn = new Function('document', 'window', 'location', `return ${buildContentSignalsScript()};`);
  return fn(dom.document, dom.window, dom.location);
}

describe('render-health：「暗」与「空」必须分开（P1-4）', () => {
  it('全黑但页面有可见内容 → 深色主题，不判空白、不触发任何警告', () => {
    const health = classifyRenderHealth({
      allBlackPixels: true,
      page: { textLength: 120, interactiveCount: 3, canvasCount: 0, imageCount: 0, svgCount: 0 }
    });
    expect(health.darkPixels).toBe(true);
    expect(health.contentKnown).toBe(true);
    expect(health.likelyBlank).toBe(false);
    expect(health.blankReason).toBe(HEALTH_REASON.DARK_WITH_CONTENT);
    expect(renderHealthWarning(health)).toBe('');
  });

  it('只有 canvas 的页面也算有内容（3D 页不得判空白）', () => {
    const health = classifyRenderHealth({
      allBlackPixels: true,
      page: { textLength: 0, interactiveCount: 0, canvasCount: 1, imageCount: 0, svgCount: 0 }
    });
    expect(health.content.mediaCount).toBe(1);
    expect(health.content.hasContent).toBe(true);
    expect(health.likelyBlank).toBe(false);
  });

  it('全黑且页面确认无可见内容 → 判空白，警告说明未渲染', () => {
    const health = classifyRenderHealth({
      allBlackPixels: true,
      page: { textLength: 0, interactiveCount: 0, canvasCount: 0, imageCount: 0, svgCount: 0 }
    });
    expect(health.likelyBlank).toBe(true);
    expect(health.blankReason).toBe(HEALTH_REASON.BLANK);
    expect(renderHealthWarning(health)).toBe(BLANK_WARNING);
  });

  it('全黑但内容信号取不到 → 视为未知，绝不判空白', () => {
    const health = classifyRenderHealth({ allBlackPixels: true, page: null });
    expect(health.contentKnown).toBe(false);
    expect(health.likelyBlank).toBe(false);
    expect(health.blankReason).toBe(HEALTH_REASON.DARK_UNVERIFIED);
    expect(renderHealthWarning(health)).toBe(DARK_UNVERIFIED_WARNING);
  });

  it('画面不黑 → rendered，无警告', () => {
    const health = classifyRenderHealth({
      visual: { sampleCount: 4099, darkRatio: 0.01, avgBrightness: 201.4 },
      page: { textLength: 0 }
    });
    expect(health.darkPixels).toBe(false);
    expect(health.blankReason).toBe(HEALTH_REASON.RENDERED);
    expect(renderHealthWarning(health)).toBe('');
  });

  it('没有采到样（sampleCount=0）不等于全黑', () => {
    expect(pixelsAllBlack({ sampleCount: 0, darkRatio: 1, avgBrightness: 0 })).toBe(false);
    expect(pixelsAllBlack({ sampleCount: 4099, darkRatio: 0.993, avgBrightness: 1.2 })).toBe(true);
    expect(pixelsAllBlack(null)).toBe(false);
  });

  it('renderHealth.ok=false（探测失败）不产生警告', () => {
    expect(renderHealthWarning({ ok: false, error: 'no_view' })).toBe('');
    expect(renderHealthWarning(null)).toBe('');
  });
});

describe('render-health：位图事实与内容事实的合成', () => {
  it('位图不可用 ≠ 全黑（数据坏了与页面黑是两回事）', () => {
    expect(isUsableBitmap(Buffer.alloc(4), 2, 2)).toBe(false);
    expect(isUsableBitmap(Buffer.alloc(0), 0, 0)).toBe(false);
    expect(isAllBlackBitmap(Buffer.alloc(4), 2, 2)).toBe(false);
    expect(isUsableBitmap(blackBitmap(), 2, 2)).toBe(true);
    expect(isAllBlackBitmap(Buffer.alloc(16, 255), 2, 2)).toBe(false);
  });

  it('classifyBitmapRenderHealth：深色主题是合法基准，位图损坏单独暴露', () => {
    const dark = classifyBitmapRenderHealth(blackBitmap(), 2, 2, { textLength: 42, interactiveCount: 1 });
    expect(dark.bitmapUsable).toBe(true);
    expect(dark.likelyBlank).toBe(false);

    const broken = classifyBitmapRenderHealth(Buffer.alloc(0), 0, 0, null);
    expect(broken.bitmapUsable).toBe(false);
    expect(broken.likelyBlank).toBe(false);
  });
});

describe('render-health：内容探测脚本（两引擎共用）', () => {
  const script = buildContentSignalsScript();

  it('是表达式形式（可直接交给 executeJavaScript / page.evaluate）', () => {
    expect(script.trim().startsWith('(() =>')).toBe(true);
  });

  it('也能作为 buildEvaluateScript 的脚本体编译通过', () => {
    expect(typeof new Function('document', 'window', 'location', script)).toBe('function');
  });

  it('返回的字段能被 readContentSignals 正确解读', () => {
    const withText = runContentSignals(makeDom({ text: '  登录  ' }));
    expect(withText.textLength).toBe(2);
    expect(readContentSignals(withText).hasContent).toBe(true);

    const withInteractive = runContentSignals(makeDom({ interactiveCount: 3 }));
    expect(withInteractive.interactiveCount).toBe(3);
    expect(readContentSignals(withInteractive).hasContent).toBe(true);

    const empty = runContentSignals(makeDom());
    const signals = readContentSignals(empty);
    expect(signals.hasContent).toBe(false);
    expect(signals.textLength).toBe(0);
    // 「全黑 + 这个页面」才是空白：脚本事实与判定入口对齐
    expect(classifyRenderHealth({ allBlackPixels: true, page: empty }).likelyBlank).toBe(true);
  });

  it('不可见元素不计入交互元素数', () => {
    const dom = makeDom({ interactiveCount: 2 });
    dom.window.getComputedStyle = () => ({ display: 'none', visibility: 'visible', opacity: '1' });
    expect(runContentSignals(dom).interactiveCount).toBe(0);
  });
});

describe('render-health：内容信号规整', () => {
  it('非对象输入返回 null（= 未知，而不是空）', () => {
    expect(readContentSignals(null)).toBeNull();
    expect(readContentSignals(undefined)).toBeNull();
    expect(readContentSignals('nope')).toBeNull();
  });

  it('数值字段容错（负数 / 字符串 / 缺失都折算为 0）', () => {
    const signals = readContentSignals({ textLength: -5, interactiveCount: 'x', canvasCount: '2' });
    expect(signals.textLength).toBe(0);
    expect(signals.interactiveCount).toBe(0);
    expect(signals.mediaCount).toBe(2);
  });
});
