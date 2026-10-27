'use strict';

/**
 * 电脑控制坐标换算（coordinate-map 纯函数）。
 * 口径：模型坐标 = 截图像素（显示器左上原点的物理像素）；
 * 注入 = 全局物理像素（primary 左上原点）。
 */

const {
  displayPhysicalSize,
  displayPhysicalOrigin,
  mapDisplayPointToScreenPhysical,
  mapScreenPhysicalToDisplayPoint
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

describe('computer coordinate-map', () => {
  it('displayPhysicalSize：DIP × scaleFactor', () => {
    expect(displayPhysicalSize(DISPLAY_1080P)).toEqual({ width: 1920, height: 1080 });
    expect(displayPhysicalSize(DISPLAY_150)).toEqual({ width: 1920, height: 1080 });
  });

  it('displayPhysicalOrigin：副屏原点随 bounds × scaleFactor', () => {
    const second = {
      index: 1,
      primary: false,
      bounds: { x: 1920, y: 0, width: 1920, height: 1080 },
      scaleFactor: 1
    };
    expect(displayPhysicalOrigin(DISPLAY_1080P)).toEqual({ x: 0, y: 0 });
    expect(displayPhysicalOrigin(second)).toEqual({ x: 1920, y: 0 });
  });

  it('主屏 1:1：截图像素即物理像素', () => {
    const out = mapDisplayPointToScreenPhysical(DISPLAY_1080P, { width: 1920, height: 1080 }, [960, 540]);
    expect(out).toEqual({ x: 960, y: 540 });
  });

  it('capture 尺寸与物理尺寸不一致时按比例校正', () => {
    // 模型看到的是 960x540 的截图（被降采样一半）
    const out = mapDisplayPointToScreenPhysical(DISPLAY_1080P, { width: 960, height: 540 }, [480, 270]);
    expect(out).toEqual({ x: 960, y: 540 });
  });

  it('150% 缩放屏：截图像素 → 全局物理', () => {
    const out = mapDisplayPointToScreenPhysical(DISPLAY_150, { width: 1920, height: 1080 }, [100, 50]);
    expect(out).toEqual({ x: 100, y: 50 });
    // 截图被缩到 960x540 时，坐标要翻倍
    const half = mapDisplayPointToScreenPhysical(DISPLAY_150, { width: 960, height: 540 }, [50, 25]);
    expect(half).toEqual({ x: 100, y: 50 });
  });

  it('副屏偏移叠加', () => {
    const second = {
      index: 1,
      primary: false,
      bounds: { x: 1920, y: 0, width: 1920, height: 1080 },
      scaleFactor: 1
    };
    const out = mapDisplayPointToScreenPhysical(second, { width: 1920, height: 1080 }, [10, 20]);
    expect(out).toEqual({ x: 1930, y: 20 });
  });

  it('物理 → 显示器截图像素空间（光标回报）与正向换算互逆', () => {
    const second = {
      index: 1,
      primary: false,
      bounds: { x: 1920, y: 0, width: 1920, height: 1080 },
      scaleFactor: 1
    };
    const back = mapScreenPhysicalToDisplayPoint(second, { x: 1930, y: 20 });
    expect(back).toEqual({ x: 10, y: 20 });
  });

  it('越界坐标由调用方钳制，换算本身不抛', () => {
    const out = mapDisplayPointToScreenPhysical(DISPLAY_1080P, { width: 1920, height: 1080 }, [-5, 2000]);
    expect(out).toEqual({ x: -5, y: 2000 });
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
    expect(mapDisplayPointToScreenPhysical(MIXED_SECOND, { width: 1920, height: 1281 }, [0, 0])).toEqual({
      x: 3840,
      y: 0
    });
    // 无系统几何时退回旧算法（2880）—— 只作为非 Windows / 旧 Electron 的兜底
    const legacy = { bounds: MIXED_SECOND.bounds, scaleFactor: MIXED_SECOND.scaleFactor };
    expect(displayPhysicalOrigin(legacy)).toEqual({ x: 2880, y: 0 });
  });

  it('光标回报按截图尺寸缩回截图空间（与正向换算互逆）', () => {
    // 截图被放大到 3840×2562（desktopCapturer 按框内等比缩放）
    const captureSize = { width: 3840, height: 2562 };
    const phys = mapDisplayPointToScreenPhysical(MIXED_SECOND, captureSize, [960, 640]);
    expect(phys).toEqual({ x: 3840 + 480, y: 320 });
    expect(mapScreenPhysicalToDisplayPoint(MIXED_SECOND, phys, captureSize)).toEqual({ x: 960, y: 640 });
  });
});
