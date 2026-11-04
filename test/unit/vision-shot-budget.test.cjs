'use strict';

/**
 * 视觉注入前的缩放（回归：整页截图 2656×11460 被上游按「图片不合规」整轮 400 打回）。
 *
 * 口径：`agent-limits.visionShotMaxEdge`（长边）+ `visionMaxBase64Chars`（单张体积），
 * 归一化只有 `browser-vision.resolveVisionLimits` 一份，编码只有
 * `computer/capture.encodeWithinBudget` 一份 —— 本文件测的是「浏览器截图这条路用上了它们」。
 */

const { fitVisionShotToBudget } = require('../../src/agent/tool-bridge-main');
const { resolveVisionLimits } = require('../../src/agent/browser-vision');

/** 假的 Electron nativeImage：resize 后体积按像素数缩小，用来验证编码降级顺序。 */
function fakeImage(width, height) {
  const img = {
    width,
    height,
    getSize: () => ({ width: img.width, height: img.height }),
    resize: ({ width: w, height: h }) =>
      fakeImage(Math.max(1, Math.round(w)), Math.max(1, Math.round(h))),
    isEmpty: () => false,
    toPNG: () => Buffer.alloc(Math.floor((img.width * img.height) / 8) + 4, 1),
    toJPEG: () => Buffer.alloc(Math.floor((img.width * img.height) / 64) + 4, 2)
  };
  return img;
}

const decode = (buffer) => (buffer && buffer.length ? fakeImage(2656, 11460) : null);

/** 整页截图那张图：2656×11460（长宽比 1:4.3，约 3000 万像素）。 */
function tallShot(overrides = {}) {
  return {
    source: 'browser',
    tool: 'browser_screenshot',
    mime: 'image/png',
    base64: 'A'.repeat(1000),
    width: 2656,
    height: 11460,
    ...overrides
  };
}

describe('vision 注入预算归一', () => {
  it('长边上限与体积上限来自 agent-limits，缺省退回默认值', () => {
    const defaults = resolveVisionLimits();
    expect(defaults.maxEdge).toBe(1568);
    expect(defaults.maxBase64Chars).toBe(4 * 1024 * 1024);
    const custom = resolveVisionLimits({ visionShotMaxEdge: 1024, visionMaxBase64Chars: 2048 });
    expect(custom.maxEdge).toBe(1024);
    expect(custom.maxBase64Chars).toBe(2048);
  });
});

describe('fitVisionShotToBudget', () => {
  it('已在预算内的常见截图：不解码、不重编码', () => {
    const shot = tallShot({ width: 1280, height: 800 });
    expect(fitVisionShotToBudget(shot, undefined, { decode })).toBe(null);
  });

  it('整页高图按长边缩到上限，并保留来源/工具', () => {
    const fitted = fitVisionShotToBudget(tallShot(), undefined, { decode });
    expect(fitted).not.toBe(null);
    expect(fitted.width).toBe(363);
    expect(fitted.height).toBe(1568);
    expect(fitted.mime).toBe('image/png');
    expect(fitted.source).toBe('browser');
    expect(fitted.tool).toBe('browser_screenshot');
    expect(fitted.base64.length).toBeLessThan(4 * 1024 * 1024);
  });

  it('尺寸没超但体积顶穿单张上限：仍走编码（PNG 不够就降级 JPEG）', () => {
    const fitted = fitVisionShotToBudget(tallShot(), { visionMaxBase64Chars: 50000 }, { decode });
    expect(fitted).not.toBe(null);
    expect(fitted.mime).toBe('image/jpeg');
    expect(fitted.base64.length).toBeLessThanOrEqual(50000);
  });

  it('缩到底仍超预算：返回 null（交给既有「为什么没注入」的判定），不假装成功', () => {
    expect(fitVisionShotToBudget(tallShot(), { visionMaxBase64Chars: 10 }, { decode })).toBe(null);
  });

  it('解码失败（如非 Electron 环境）时返回 null，不抛错', () => {
    expect(
      fitVisionShotToBudget(tallShot(), undefined, {
        decode: () => {
          throw new Error('no nativeImage');
        }
      })
    ).toBe(null);
    expect(fitVisionShotToBudget(tallShot(), undefined, { decode: () => null })).toBe(null);
  });

  it('尺寸未知（工具没报 width/height）但体积超限：仍会压', () => {
    const fitted = fitVisionShotToBudget(
      tallShot({ width: undefined, height: undefined }),
      { visionMaxBase64Chars: 50000 },
      { decode }
    );
    expect(fitted).not.toBe(null);
    expect(fitted.width).toBeGreaterThan(0);
  });

  it('没有 base64 的 shot 直接跳过', () => {
    expect(fitVisionShotToBudget({ width: 2656, height: 11460 }, undefined, { decode })).toBe(null);
    expect(fitVisionShotToBudget(null, undefined, { decode })).toBe(null);
  });
});
