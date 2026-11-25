'use strict';

/* globals describe, it, expect */

/**
 * 悬浮窗页面（`src/renderer/pet-window/pet.js`）的两条可见契约：
 *
 * 1. **形态只有运行状态、也要说真话**：没有形态偏好设置（删掉的 `shapeMode` 老存档也不读），
 *    起步是休息形态（球），之后按闲逛日程自己换；每次变化要把当前形态回报给 Main
 *    （`petHost.reportState`），bodyLine 才有真话可说。
 * 2. **`pet_act 'dim'` 必须看得见**：REFUSE 的「暗下去」只压 glow 是无效的
 *    （glow 平时是 0，底色来自 amb），必须乘进最终 alpha。
 *
 * 用「真源码 + 极简 canvas 桩」跑帧，直接量每帧画出来的 alpha 总量。
 */

const fs = require('node:fs');
const path = require('node:path');
const PetShapes = require('../../src/renderer/pet-window/pet-shapes');
const PetCatGait = require('../../src/renderer/pet-window/pet-cat-gait');

const SRC = path.join(__dirname, '..', '..', 'src', 'renderer', 'pet-window', 'pet.js');

function loadPetPage(settings) {
  const canvas = { width: 0, height: 0, clientWidth: 210, clientHeight: 210, style: {} };
  const drawn = { alpha: 0 };
  const ctx = {
    fillStyle: '',
    setTransform() {},
    clearRect() {
      drawn.alpha = 0;
    },
    beginPath() {},
    arc() {},
    fill() {
      const m = /rgba\([^)]*,\s*([0-9.]+)\)/.exec(this.fillStyle);
      if (m) drawn.alpha += Number(m[1]);
    }
  };
  canvas.getContext = () => ctx;

  const clock = { now: 1000 };
  const perf = { now: () => clock.now };
  let rafCb = null;
  /** 页面注册的 window 事件（拖动 / 命中是一条状态机，必须能在这里驱动） */
  const handlers = new Map();
  const window = {
    devicePixelRatio: 1,
    addEventListener(type, fn) {
      if (!handlers.has(type)) handlers.set(type, []);
      handlers.get(type).push(fn);
    },
    removeEventListener(type, fn) {
      const list = handlers.get(type) || [];
      const i = list.indexOf(fn);
      if (i >= 0) list.splice(i, 1);
    },
    requestAnimationFrame(cb) {
      rafCb = cb;
      return 1;
    }
  };

  const reported = [];
  const aliveHandlers = [];
  const applyHandlers = [];
  /** 拖动 IPC 的调用序列（起点/移动/结束），以及每次穿透切换 */
  const drag = [];
  const mousePass = [];
  const petHost = {
    ready: async () => ({ ok: true, settings: { ...settings } }),
    onApply: (fn) => applyHandlers.push(fn),
    onAlive: (fn) => aliveHandlers.push(fn),
    reportState: (state) => reported.push({ ...state }),
    dragStart: (sx, sy) => drag.push({ kind: 'start', sx, sy }),
    dragMoveTo: (sx, sy) => drag.push({ kind: 'move', sx, sy }),
    dragEnd: (moved) => drag.push({ kind: 'end', moved: moved !== false }),
    setMousePass: (pass) => mousePass.push(pass === true)
  };
  const doc = { getElementById: () => canvas };

  const factory = new Function(
    'window',
    'document',
    'performance',
    'PetShapes',
    'PetCatGait',
    'petHost',
    fs.readFileSync(SRC, 'utf8')
  );
  factory(window, doc, perf, PetShapes, PetCatGait, petHost);

  return {
    reported,
    clock,
    drag,
    mousePass,
    async settle() {
      // ready() 的 then 里 applySettings + start()
      await Promise.resolve();
      await Promise.resolve();
    },
    /** 跑一帧，返回这一帧画出来的 alpha 总量 */
    frame(atMs) {
      clock.now = atMs;
      drawn.alpha = 0;
      rafCb(atMs);
      return drawn.alpha;
    },
    apply(patch) {
      for (const fn of applyHandlers) fn({ ...settings, ...patch });
    },
    alive(payload) {
      for (const fn of aliveHandlers) fn(payload);
    },
    /** 驱动页面注册的 window 事件（mousemove / mousedown / mouseup / mouseleave …） */
    emit(type, evt) {
      for (const fn of handlers.get(type) || []) fn(evt);
    }
  };
}

const BASE = { enabled: true, aliveBind: true, count: 128, size: 0.75, motion: 1, dotScale: 0.5, color: 'white' };

describe('pet window page', () => {
  it('起步是休息形态（球），并把当前形态报给 Main', async () => {
    const page = loadPetPage({ ...BASE });
    await page.settle();
    page.frame(1000);
    expect(page.reported[0]).toEqual({ shape: 'sphere' });
  });

  it('老存档里的 shapeMode 不再能钉死形态，下发也不把身体拽回去', async () => {
    const page = loadPetPage({ ...BASE, shapeMode: 'cat' });
    await page.settle();
    page.frame(1000);
    expect(page.reported[0]).toEqual({ shape: 'sphere' }); // 不照存档摆成猫

    // 拖个滑杆顺带下发同一份旧键：既不该变成猫，也不该多报一次形态
    page.apply({ shapeMode: 'cat', motion: 1.6 });
    page.frame(1400);
    expect(page.reported).toHaveLength(1);
  });

  it('闲逛日程到点会自己换形态（不需要任何设置）', async () => {
    const page = loadPetPage({ ...BASE });
    await page.settle();
    page.frame(1000);
    page.frame(30000); // 首次变身上限 20s，跑过它必然换过
    expect(page.reported.length).toBeGreaterThan(1);
    expect(page.reported[page.reported.length - 1].shape).not.toBe('sphere');
  });

  it('pet_act shape：现在就换过去（瞬时动作，不落设置）', async () => {
    const page = loadPetPage({ ...BASE });
    await page.settle();
    page.frame(1000);
    expect(page.reported[0]).toEqual({ shape: 'sphere' });

    page.alive({ kind: 'shape', shape: 'fish' });
    page.frame(1400);
    expect(page.reported[page.reported.length - 1]).toEqual({ shape: 'fish' });

    // 非法形态不动身体（也不多报一次）
    const reports = page.reported.length;
    page.alive({ kind: 'shape', shape: 'dog' });
    page.frame(1800);
    expect(page.reported).toHaveLength(reports);
  });

  it('pet_act dim（REFUSE）真的把整体压暗，然后自己恢复', async () => {
    const page = loadPetPage({ ...BASE });
    await page.settle();
    const before = page.frame(2000);
    expect(before).toBeGreaterThan(0);

    page.alive({ kind: 'act', effect: 'dim', strength: 1 });
    const during = page.frame(2040); // 隔一帧以上（帧率上限 30fps）
    expect(during).toBeGreaterThan(0);
    expect(during).toBeLessThan(before * 0.6); // 明显暗下去（不是只动 glow 的假动作）

    const later = page.frame(6040); // 几秒后基本恢复
    expect(later).toBeGreaterThan(during * 1.5);
  });
});

/**
 * 拖动的状态机（「宠物抓不住 / 拖不动」的两个真 bug 的回归）。
 *
 * 文档里的用户症状是「位置会卡死，无法移动」。代码上能造成它的只有两条：
 * 1. **按下用了比「进入」更严的命中容差**：光标已是 grab（指针在 1–1.35 环带里），
 *    按下去却什么都不发生 —— 看着能抓、实际拖不动；
 * 2. **mouseup 丢了没有兜底**：`press` 一直挂着，之后既不判命中也不放行穿透，
 *    窗口一直挡着鼠标，拖动状态死在那里。
 */
describe('pet window drag', () => {
  const OFFSET = 1000; // client 坐标 + 这个偏移 = 屏幕绝对坐标（模拟真实窗口位置）

  function mk(x, y, buttons, extra) {
    return {
      clientX: x,
      clientY: y,
      screenX: x + OFFSET,
      screenY: y + OFFSET,
      button: 0,
      buttons: buttons === undefined ? 0 : buttons,
      ...(extra || {})
    };
  }

  /** 找一个真的压在点身上的窗口内坐标（用页面自己的命中结果观测，不重算几何） */
  function findBodyPoint(page) {
    for (let y = 6; y < 204; y += 3) {
      for (let x = 6; x < 204; x += 3) {
        page.emit('mouseleave'); // 每次探测前回到「穿透态、不在身上」
        page.mousePass.length = 0;
        page.emit('mousemove', mk(x, y, 0));
        if (page.mousePass.includes(false)) return { x, y };
      }
    }
    return null;
  }

  async function ready() {
    const page = loadPetPage({ ...BASE });
    await page.settle();
    page.frame(1000);
    return page;
  }

  it('窗口已可交互时，按在点云空隙上也能抓住（严格命中会失败）', async () => {
    const page = await ready();
    const body = findBodyPoint(page);
    expect(body).not.toBeNull();

    // 光标在身体上：窗口关掉穿透（可交互）
    page.emit('mouseleave');
    page.mousePass.length = 0;
    page.emit('mousemove', mk(body.x, body.y, 0));
    expect(page.mousePass[page.mousePass.length - 1]).toBe(false);

    // 按在窗口角上（离任何点都远）：窗口此刻已经是可交互的，按下就该能拖
    page.emit('mousedown', mk(3, 3, 1));
    expect(page.drag).toEqual([{ kind: 'start', sx: 3 + OFFSET, sy: 3 + OFFSET }]);

    // 拖动期间照旧报绝对坐标（不是增量）
    page.emit('mousemove', mk(23, 13, 1));
    expect(page.drag[page.drag.length - 1]).toEqual({ kind: 'move', sx: 23 + OFFSET, sy: 13 + OFFSET });

    page.emit('mouseup', mk(23, 13, 0));
    expect(page.drag[page.drag.length - 1]).toEqual({ kind: 'end', moved: true });
  });

  it('mouseup 丢了：靠「按键已松开」自愈，拖动状态不残留', async () => {
    const page = await ready();
    const body = findBodyPoint(page);
    expect(body).not.toBeNull();

    page.emit('mouseleave');
    page.mousePass.length = 0;
    page.emit('mousemove', mk(body.x, body.y, 0));
    page.emit('mousedown', mk(body.x, body.y, 1));
    expect(page.drag.filter((d) => d.kind === 'start')).toHaveLength(1);

    // mouseup 丢了：下一次移动 buttons 已经是 0（松开），必须收尾
    page.emit('mousemove', mk(body.x + 40, body.y + 40, 0));
    expect(page.drag[page.drag.length - 1].kind).toBe('end');
    // 这之前没有有效移动（moved 未置位）→ 按单击处理，不落盘
    expect(page.drag[page.drag.length - 1].moved).toBe(false);

    // 自愈之后还能正常拖第二次（状态没被卡住）
    page.emit('mouseleave');
    page.emit('mousemove', mk(body.x, body.y, 0));
    page.emit('mousedown', mk(body.x, body.y, 1));
    page.emit('mousemove', mk(body.x + 30, body.y + 30, 1));
    page.emit('mouseup', mk(body.x + 30, body.y + 30, 0));
    expect(page.drag[page.drag.length - 1]).toEqual({ kind: 'end', moved: true });
  });

  it('单击不落盘：mousedown + mouseup 只有 start/end(moved:false)', async () => {
    const page = await ready();
    const body = findBodyPoint(page);
    expect(body).not.toBeNull();

    page.emit('mouseleave');
    page.emit('mousemove', mk(body.x, body.y, 0));
    page.emit('mousedown', mk(body.x, body.y, 1));
    page.emit('mouseup', mk(body.x, body.y, 0));

    expect(page.drag.map((d) => d.kind)).toEqual(['start', 'end']);
    expect(page.drag[1].moved).toBe(false);
  });
});

