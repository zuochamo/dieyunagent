'use strict';

/**
 * 第二档强化的行为契约：
 *
 * 1. `screenshot` 的 `region` 会**改变坐标空间**：裁剪出来的那块图就是模型的新坐标图，
 *    之后的 click 坐标相对它（落点仍是屏幕上同一个点）。
 * 2. 一串动作期间保持这块放大区域：动作后返回的仍是同一块的新画面（不用每步重新对全屏坐标）。
 * 3. `changed`：这一下画面变了没有（唯一客观信号）；`stable`：这一帧是否已经稳定。
 * 4. `modifiers`：shift/ctrl 等按住期间的动作（区间选择 / 多选 / 复制）。
 *
 * 断言全部落在「fake win32 收到的物理坐标」和「返回结果的事实字段」上，
 * 不触碰真实键鼠与真实屏幕。
 */

const { createComputerService } = require('../../src/computer/service');
const { normalizeModifiers, MODIFIER_NAMES } = require('../../src/computer/win32-input');
const { validateToolArgs } = require('../../src/agent/tool-validate');
const { makeCapture, makeWin32 } = require('./computer-fakes.cjs');

function makeService(opts = {}) {
  const { capture, state } = makeCapture(opts);
  const { win32, calls } = makeWin32(opts);
  const service = createComputerService({ log: () => {}, capture, win32 });
  return { service, state, calls };
}

describe('region：裁剪即新的坐标空间', () => {
  it('裁剪后 click 的坐标相对裁剪块，落点仍是屏幕上原来的位置', async () => {
    const { service, calls } = makeService();
    const shot = await service.action({ action: 'screenshot', region: [100, 80, 400, 300], sessionId: 's1' });
    // 裁剪出来的图（1:1 像素，小字看得清）就是模型的新坐标图
    expect(shot.screen).toEqual({ width: 400, height: 300 });
    expect(shot.changed).toBeUndefined(); // 第一次看，没有可比对象

    await service.action({ action: 'click', coordinate: [10, 20], sessionId: 's1' });
    // 裁剪图里的 [10,20] == 全屏 [110,100]
    expect(calls.moves).toEqual([[110, 100]]);
  });

  it('裁剪视图下动作后返回的仍是同一块区域（坐标空间不跳回全屏）', async () => {
    const { service } = makeService();
    await service.action({ action: 'screenshot', region: [100, 80, 400, 300], sessionId: 's1' });
    const after = await service.action({ action: 'click', coordinate: [10, 20], sessionId: 's1' });
    expect(after.screen).toEqual({ width: 400, height: 300 });
    // 光标回报也在这块裁剪图的坐标里：(120,240) 相对原点 (100,80)
    expect(after.cursor).toEqual({ x: 20, y: 160 });
  });

  it('再截一次整屏（不带 region）就回到全屏坐标空间', async () => {
    const { service, calls } = makeService();
    await service.action({ action: 'screenshot', region: [100, 80, 400, 300], sessionId: 's1' });
    const full = await service.action({ action: 'screenshot', sessionId: 's1' });
    expect(full.screen).toEqual({ width: 1000, height: 800 });
    await service.action({ action: 'click', coordinate: [10, 20], sessionId: 's1' });
    expect(calls.moves).toEqual([[10, 20]]);
  });

  it('region 越界被钳制在视图内（不会裁到屏外变成空图）', async () => {
    const { service } = makeService();
    // 请求 1900x1500，屏只有 1000x800：钳到右下角那一小块
    const shot = await service.action({ action: 'screenshot', region: [900, 700, 1900, 1500], sessionId: 's1' });
    expect(shot.screen).toEqual({ width: 100, height: 100 });
  });
});

describe('changed：这一下画面变了没有', () => {
  it('第一次动作没有可比对象 → 不报 changed；同帧 → false；换帧 → true', async () => {
    const state = { tag: 1 };
    const { service } = makeService({ tag: () => state.tag });

    const first = await service.action({ action: 'click', coordinate: [10, 20], sessionId: 's1' });
    expect(first.changed).toBeUndefined();

    const same = await service.action({ action: 'click', coordinate: [10, 20], sessionId: 's1' });
    expect(same.changed).toBe(false); // 点了没反应：模型据此换思路，而不是重复点

    state.tag = 2;
    const moved = await service.action({ action: 'click', coordinate: [10, 20], sessionId: 's1' });
    expect(moved.changed).toBe(true);
  });

  it('坐标空间变了（区域 vs 整屏）就不给 changed：宁可不报，也不报假信号', async () => {
    const { service } = makeService();
    await service.action({ action: 'screenshot', sessionId: 's1' });
    const region = await service.action({ action: 'screenshot', region: [0, 0, 200, 200], sessionId: 's1' });
    expect(region.changed).toBeUndefined();
  });
});

describe('stable：交付的那一帧是否已经稳定', () => {
  it('连续两帧相同 → stable:true，且不额外狂拍', async () => {
    const { service, state } = makeService({ tag: 1 });
    const r = await service.action({ action: 'click', coordinate: [10, 20], sessionId: 's1' });
    expect(r.stable).toBe(true);
    expect(state.grabs()).toBe(2); // 起步一帧 + 一次确认
  });

  it('画面一直变 → stable:false，且拍屏次数有上限', async () => {
    let n = 0;
    const { service, state } = makeService({ tag: () => (n += 1) });
    const r = await service.action({ action: 'click', coordinate: [10, 20], sessionId: 's1' });
    expect(r.stable).toBe(false);
    expect(state.grabs()).toBeLessThanOrEqual(11); // 1 + ceil(900/100)
  });
});

describe('modifiers：按住修饰键的动作', () => {
  it('click 期间按住 shift（区间选择）', async () => {
    const { service, calls } = makeService();
    await service.action({ action: 'click', coordinate: [10, 20], modifiers: ['shift'], sessionId: 's1' });
    expect(calls.modifierHolds).toEqual([['shift']]);
    expect(calls.moves).toEqual([[10, 20]]);
  });

  it('drag 期间按住 ctrl（复制拖拽）', async () => {
    const { service, calls } = makeService();
    await service.action({ action: 'drag', coordinate: [10, 20], to: [30, 40], modifiers: ['ctrl'], sessionId: 's1' });
    expect(calls.modifierHolds).toEqual([['ctrl']]);
    expect(calls.drags).toEqual([{ from: { x: 10, y: 20 }, to: { x: 30, y: 40 }, button: 'left' }]);
  });

  it('没给 modifiers 时也走同一条路径（不做特殊判断）', async () => {
    const { service, calls } = makeService();
    await service.action({ action: 'click', coordinate: [10, 20], sessionId: 's1' });
    expect(calls.modifierHolds).toEqual([null]);
    expect(calls.clicks).toEqual(['left']);
  });

  it('注入层归一化：大小写/空格/去重照收，拼错的名字直接报错', () => {
    expect(MODIFIER_NAMES).toEqual(['win', 'ctrl', 'alt', 'shift']);
    expect(normalizeModifiers([' SHIFT ', 'ctrl', 'shift'])).toEqual(['shift', 'ctrl']);
    expect(normalizeModifiers(undefined)).toEqual([]);
    expect(() => normalizeModifiers(['shfit'])).toThrow(/不支持的修饰键/);
  });

  it('校验层：拼错的修饰键 / region 挂错动作 / region 形状不对都被拒', () => {
    const badMod = validateToolArgs('computer', { action: 'click', coordinate: [1, 2], modifiers: ['shfit'] });
    expect(badMod.ok).toBe(false);
    expect(badMod.suggestedFix).toContain('shift');

    const wrongOwner = validateToolArgs('computer', { action: 'type', text: 'x', modifiers: ['ctrl'] });
    expect(wrongOwner.ok).toBe(false);
    expect(wrongOwner.suggestedFix).toContain('action=key');

    const regionOnClick = validateToolArgs('computer', { action: 'click', coordinate: [1, 2], region: [0, 0, 10, 10] });
    expect(regionOnClick.ok).toBe(false);
    expect(regionOnClick.suggestedFix).toContain('screenshot');

    const badRegion = validateToolArgs('computer', { action: 'screenshot', region: [0, 0, 10] });
    expect(badRegion.ok).toBe(false);
    const zeroRegion = validateToolArgs('computer', { action: 'screenshot', region: [0, 0, 0, 10] });
    expect(zeroRegion.ok).toBe(false);

    expect(validateToolArgs('computer', { action: 'screenshot', region: [0, 0, 100, 100] }).ok).toBe(true);
    expect(validateToolArgs('computer', { action: 'drag', coordinate: [1, 2], to: [3, 4], modifiers: ['alt'] }).ok).toBe(
      true
    );
  });
});
