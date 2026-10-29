'use strict';

/**
 * 电脑控制坐标换算（coordinate-map 纯函数）。
 * 口径：模型坐标 = **它最近看到的那张图**的像素（左上角为原点）；
 * 注入 = 全局物理像素（primary 左上原点）。
 * 「视图」= 被截的那块屏幕矩形 + 注入给模型的那张图的尺寸，全屏与 region 裁剪共用同一套映射。
 */

const {
  displayPhysicalSize,
  displayPhysicalOrigin,
  fullView,
  viewPointToScreenPhysical,
  screenPhysicalToViewPoint,
  viewRectToPhysicalRect,
  sameViewRect,
  sameViewSpace
} = require('../../src/computer/coordinate-map');

const DISPLAY_1080P = {
  index: 0,
  primary: true,
  bounds: { x: 0, y: 0, width: 1920, height: 1080 },
  scaleFactor: 1
};

const DISPLAY_150 = {
  index: 0,
  primary: true,
  bounds: { x: 0, y: 0, width: 1280, height: 720 },
  scaleFactor: 1.5
};

const SECOND_1080P = {
  index: 1,
  primary: false,
  bounds: { x: 1920, y: 0, width: 1920, height: 1080 },
  scaleFactor: 1
};

describe('computer coordinate-map', () => {
  it('displayPhysicalSize：DIP × scaleFactor', () => {
    expect(displayPhysicalSize(DISPLAY_1080P)).toEqual({ width: 1920, height: 1080 });
    expect(displayPhysicalSize(DISPLAY_150)).toEqual({ width: 1920, height: 1080 });
  });

  it('displayPhysicalOrigin：副屏原点随 bounds × scaleFactor', () => {
    expect(displayPhysicalOrigin(DISPLAY_1080P)).toEqual({ x: 0, y: 0 });
    expect(displayPhysicalOrigin(SECOND_1080P)).toEqual({ x: 1920, y: 0 });
  });

  it('全屏 1:1：图与物理同尺寸时坐标即物理坐标', () => {
    const view = fullView(DISPLAY_1080P, { width: 1920, height: 1080 });
    expect(view).toEqual({
      originX: 0,
      originY: 0,
      nativeWidth: 1920,
      nativeHeight: 1080,
      width: 1920,
      height: 1080
    });
    expect(viewPointToScreenPhysical(view, [960, 540])).toEqual({ x: 960, y: 540 });
  });

  it('图被降采样时按比例放大回物理', () => {
    // 模型看到的是 960x540 的图（长边上限缩放过）
    const view = fullView(DISPLAY_1080P, { width: 960, height: 540 });
    expect(viewPointToScreenPhysical(view, [480, 270])).toEqual({ x: 960, y: 540 });
  });

  it('150% 缩放屏：图的像素 → 全局物理', () => {
    const one = fullView(DISPLAY_150, { width: 1920, height: 1080 });
    expect(viewPointToScreenPhysical(one, [100, 50])).toEqual({ x: 100, y: 50 });
    const half = fullView(DISPLAY_150, { width: 960, height: 540 });
    expect(viewPointToScreenPhysical(half, [50, 25])).toEqual({ x: 100, y: 50 });
  });

  it('副屏偏移叠加', () => {
    const view = fullView(SECOND_1080P, { width: 1920, height: 1080 });
    expect(viewPointToScreenPhysical(view, [10, 20])).toEqual({ x: 1930, y: 20 });
  });

  it('物理 → 视图坐标（光标回报）与正向换算互逆', () => {
    const view = fullView(SECOND_1080P, { width: 1920, height: 1080 });
    expect(screenPhysicalToViewPoint(view, { x: 1930, y: 20 })).toEqual({ x: 10, y: 20 });
  });

  it('越界坐标钳制在图内（不再需要调用方各自钳）', () => {
    const view = fullView(DISPLAY_1080P, { width: 1920, height: 1080 });
    expect(viewPointToScreenPhysical(view, [-5, 2000])).toEqual({ x: 0, y: 1079 });
  });

  /**
   * 混合 DPI 回归（真机数据）：主屏 1920×1080 @2（物理 3840×2160，原点 0,0），
   * 副屏挂在它右边 1920 DIP 处、1280×854 @1.5（物理 1920×1281，真实物理原点 3840）。
   * capture.listDisplays 会把系统换算结果放进 physOrigin/physSize，这里验证它以唯一来源生效。
   */
  const MIXED_SECOND = {
    index: 1,
    displayId: '3858962195',
    primary: false,
    bounds: { x: 1920, y: 0, width: 1280, height: 854 },
    scaleFactor: 1.5,
    physOrigin: { x: 3840, y: 0 },
    physSize: { width: 1920, height: 1281 }
  };

  it('physOrigin/physSize 优先于 DIP × scaleFactor（混合 DPI 不再偏 960px）', () => {
    expect(displayPhysicalOrigin(MIXED_SECOND)).toEqual({ x: 3840, y: 0 });
    expect(displayPhysicalSize(MIXED_SECOND)).toEqual({ width: 1920, height: 1281 });
    // 副屏左上角 (0,0) 就落在全局物理 3840
    expect(viewPointToScreenPhysical(fullView(MIXED_SECOND), [0, 0])).toEqual({ x: 3840, y: 0 });
    // 无系统几何时退回旧算法（2880）—— 只作为非 Windows / 旧 Electron 的兜底
    const legacy = { bounds: MIXED_SECOND.bounds, scaleFactor: MIXED_SECOND.scaleFactor };
    expect(displayPhysicalOrigin(legacy)).toEqual({ x: 2880, y: 0 });
  });

  it('光标回报按图尺寸缩回图空间（与正向换算互逆）', () => {
    // 图被放大到 3840×2562（desktopCapturer 按框内等比缩放）
    const view = fullView(MIXED_SECOND, { width: 3840, height: 2562 });
    const phys = viewPointToScreenPhysical(view, [960, 640]);
    expect(phys).toEqual({ x: 3840 + 480, y: 320 });
    expect(screenPhysicalToViewPoint(view, phys)).toEqual({ x: 960, y: 640 });
  });

  describe('region（裁剪视图）', () => {
    it('视图坐标里的矩形 → 全局物理矩形（1:1）', () => {
      const view = fullView(DISPLAY_1080P, { width: 1920, height: 1080 });
      expect(viewRectToPhysicalRect(view, [100, 80, 400, 300])).toEqual({
        x: 100,
        y: 80,
        width: 400,
        height: 300
      });
    });

    it('图被缩放过时矩形同样按比例放大', () => {
      const view = fullView(DISPLAY_1080P, { width: 960, height: 540 });
      expect(viewRectToPhysicalRect(view, [480, 270, 100, 50])).toEqual({
        x: 960,
        y: 540,
        width: 200,
        height: 100
      });
    });

    it('越界矩形钳制在视图内（不裁到屏外去）', () => {
      const view = fullView(DISPLAY_1080P, { width: 1920, height: 1080 });
      expect(viewRectToPhysicalRect(view, [1900, 1000, 500, 500])).toEqual({
        x: 1900,
        y: 1000,
        width: 20,
        height: 80
      });
    });

    it('裁剪后的新视图：坐标从裁剪块的左上角算起，落点仍在原来的地方', () => {
      // 全屏 1920x1080，模型在 [100,80] 起 400x300 处裁剪，得到 400x300 的图
      const regionView = { originX: 100, originY: 80, nativeWidth: 400, nativeHeight: 300, width: 400, height: 300 };
      // 在裁剪图里点 [10, 20] == 全屏 [110, 100]
      expect(viewPointToScreenPhysical(regionView, [10, 20])).toEqual({ x: 110, y: 100 });
      // 光标回报也换算回这块裁剪图的坐标
      expect(screenPhysicalToViewPoint(regionView, { x: 110, y: 100 })).toEqual({ x: 10, y: 20 });
      // 裁剪块之外的点被钳制在块内（不会点到别的窗口去）
      expect(viewPointToScreenPhysical(regionView, [999, 999])).toEqual({ x: 499, y: 379 });
    });

    it('sameViewRect 只看屏幕矩形，sameViewSpace 还要求图尺寸一致', () => {
      const a = { originX: 0, originY: 0, nativeWidth: 100, nativeHeight: 100, width: 100, height: 100 };
      const b = { originX: 0, originY: 0, nativeWidth: 100, nativeHeight: 100, width: 50, height: 50 };
      const c = { originX: 0, originY: 0, nativeWidth: 100, nativeHeight: 100, width: 100, height: 100 };
      expect(sameViewRect(a, b)).toBe(true);
      expect(sameViewSpace(a, b)).toBe(false);
      expect(sameViewSpace(a, c)).toBe(true);
      const moved = { ...a, originX: 100 };
      expect(sameViewRect(a, moved)).toBe(false);
    });
  });
});
