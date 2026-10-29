'use strict';

/**
 * computer 服务的测试替身：「外部世界」只有两件事 —— desktopCapturer 抓帧、koffi 注入键鼠。
 * 生产实现（src/computer/capture.js、win32-input.js）在这里被替换，好让 service 的编排逻辑
 * （稳定帧 / changed / region / 修饰键 / 诚实契约）能在不碰真实屏幕和真实鼠标的情况下被测。
 *
 * 文件名不带 .test.cjs，vitest 的 include 只收 `test/unit/**\/*.test.cjs`，不会被当用例跑。
 */

const captureModule = require('../../src/computer/capture');
const { droppedInputError } = require('../../src/computer/win32-input');

/** 假 nativeImage：getSize / resize / toBitmap / crop / isEmpty 都是真身用到的接口。 */
function fakeImage(width, height, tag = 0) {
  const size = { width: Math.max(1, Math.round(width)), height: Math.max(1, Math.round(height)) };
  return {
    getSize: () => ({ ...size }),
    isEmpty: () => false,
    resize: ({ width: w }) => fakeImage(w || size.width, Math.round(((w || size.width) * size.height) / size.width), tag),
    // 指纹只看这几个字节：tag 不同 → 指纹不同（模拟「画面变了」）
    toBitmap: () => Buffer.from([tag & 0xff, (tag >> 8) & 0xff, size.width & 0xff, size.height & 0xff]),
    crop: (rect) => fakeImage(rect.width, rect.height, tag)
  };
}

function makeDisplay(over = {}) {
  return {
    index: 0,
    id: 1,
    displayId: '1',
    primary: true,
    bounds: { x: 0, y: 0, width: 1000, height: 800 },
    scaleFactor: 1,
    physOrigin: { x: 0, y: 0 },
    physSize: { width: 1000, height: 800 },
    ...over
  };
}

/**
 * @param {{ failGrab?: boolean, tag?: number|(() => number), frameSize?: {width:number,height:number},
 *   display?: object, displays?: object[] }} [opts]
 */
function makeCapture(opts = {}) {
  const displays = opts.displays || [opts.display || makeDisplay()];
  const display = displays[0];
  const frameSize = opts.frameSize || { width: 1000, height: 800 };
  let grabs = 0;
  const encoded = [];
  const api = {
    listDisplays: () => displays,
    getDisplay: (index) => {
      if (index == null || index === '') return displays[0];
      const hit = displays.find((d) => d.index === Number(index));
      if (!hit) {
        const e = new Error(`display=${index} 不存在`);
        e.code = 'DISPLAY_NOT_FOUND';
        throw e;
      }
      return hit;
    },
    grabDisplay: async () => {
      grabs += 1;
      if (opts.failGrab) {
        const e = new Error('屏幕 0 捕获失败（desktopCapturer 返回空图像）');
        e.code = 'CAPTURE_FAILED';
        throw e;
      }
      const tag = typeof opts.tag === 'function' ? opts.tag() : opts.tag == null ? 1 : opts.tag;
      return {
        image: fakeImage(frameSize.width, frameSize.height, tag),
        width: frameSize.width,
        height: frameSize.height
      };
    },
    // 真身签名是 frameSignature(image)：传的是 nativeImage，不是 {image,...} 包装
    frameSignature: (image) => captureModule.frameSignature(image),
    encodeShot: (image) => {
      const size = image.getSize();
      encoded.push({ ...size });
      return {
        mime: 'image/png',
        base64: 'aGVsbG8=',
        width: size.width,
        height: size.height,
        nativeWidth: size.width,
        nativeHeight: size.height
      };
    }
  };
  return { capture: api, state: { grabs: () => grabs, encoded } };
}

/** @param {{ clickDrop?: boolean, moveDrop?: boolean, probeBoom?: boolean, typeText?: Function,
 *   windows?: object[], activateBoom?: boolean }} [opts] */
function makeWin32(opts = {}) {
  const boom = () => {
    throw new Error('koffi 不可用');
  };
  const calls = { moves: [], clicks: [], drags: [], modifierHolds: [], types: [], windowListOpts: [], activations: [] };
  const api = {
    isSupported: () => true,
    unsupportedError: () => new Error('OS_CONTROL_UNSUPPORTED'),
    sleep: async () => {},
    parseKeyCombo: (k) => ({ modifiers: [], key: k, vk: 0x41, extended: false }),
    moveMouseToPhysical: (x, y) => {
      if (opts.moveDrop) throw droppedInputError(`鼠标移动到 (${x}, ${y})`, 1, 0);
      calls.moves.push([x, y]);
      return 1;
    },
    clickMouseButton: (button) => {
      if (opts.clickDrop) throw droppedInputError(`鼠标按下（${button || 'left'}）`, 1, 0);
      calls.clicks.push(button || 'left');
      return true;
    },
    dragMouse: async (from, to, button) => {
      calls.drags.push({ from, to, button });
      return true;
    },
    scrollWheel: () => 1,
    pressKeyCombo: () => 1,
    withModifiers: async (modifiers, fn) => {
      calls.modifierHolds.push(modifiers == null ? null : modifiers);
      return fn();
    },
    typeText: (text) => {
      calls.types.push(text);
      return (opts.typeText || (async (t) => String(t).length))(text);
    },
    getPhysicalCursorPos: opts.probeBoom ? boom : () => ({ x: 120, y: 240 }),
    foregroundWindowTitle: opts.probeBoom ? boom : () => '记事本',
    // 窗口清单：默认空表（不设 windows 时就是「什么窗口也没有」）
    listWindows: (listOpts) => {
      calls.windowListOpts.push(listOpts);
      return Array.isArray(opts.windows) ? opts.windows : [];
    },
    activateWindow: async (handle) => {
      calls.activations.push(Number(handle));
      if (opts.activateBoom) {
        const e = new Error('切换前台失败：「记事本」没有成为前台窗口。');
        e.code = 'ACTIVATE_FAILED';
        e.retryable = false;
        throw e;
      }
      const hit = (opts.windows || []).find((w) => Number(w.handle) === Number(handle));
      return hit ? hit.title : '';
    }
  };
  return { win32: api, calls };
}

module.exports = { fakeImage, makeDisplay, makeCapture, makeWin32 };
