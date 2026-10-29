'use strict';

/**
 * 电脑控制的「结果诚实性」三条契约（模型只能靠工具结果判断现实）：
 *
 * 1. 注入被系统丢弃（UIPI / 锁屏 / UAC 安全桌面）：SendInput 返回 0 而**不报错**。
 *    过去调用点忽略返回值 → 回 ok:true + 一张没变化的截图，模型以为点到了。
 *    现在统一走 win32-input.sendInputs 校验投递数，不等就抛 INPUT_DROPPED。
 * 2. 动作已执行但动作后截图失败：过去抛 CAPTURE_FAILED → 模型原样重试
 *    → 重复点击 / 重复输入。现在是 applied:true + screenshotError，并明说不要重复。
 * 3. 画面事实（changed / stable）必须如实回报或干脆不报，不能给假信号。
 *
 * 这里不注入任何真实键鼠事件（那会动到跑测试的机器的鼠标），只测契约与装配。
 */

const { createComputerService } = require('../../src/computer/service');
const { droppedInputError } = require('../../src/computer/win32-input');
const { sanitizeToolResultForApi } = require('../../src/agent/tool-bridge-main');
const { makeCapture, makeWin32 } = require('./computer-fakes.cjs');

function makeService(opts = {}) {
  const { capture, state } = makeCapture(opts);
  const { win32, calls } = makeWin32(opts);
  const service = createComputerService({ log: () => {}, capture, win32 });
  return { service, state, calls };
}

describe('注入被系统丢弃（INPUT_DROPPED）', () => {
  it('错误契约：带 code / retryable=false / 明确的 suggestedFix 与原因', () => {
    const e = droppedInputError('鼠标按下（left）', 1, 0);
    expect(e.code).toBe('INPUT_DROPPED');
    expect(e.retryable).toBe(false);
    expect(e.message).toContain('没有被系统接收');
    expect(e.message).toContain('期望投递 1 个事件');
    expect(e.message).toContain('实际 0');
    // 三个真实原因都写清：模型据此判断是「等用户解锁」还是「请用户重开窗口」
    expect(e.message).toMatch(/UIPI|管理员权限/);
    expect(e.message).toContain('锁定');
    expect(e.suggestedFix).toContain('不要原样重复');
    expect(e.suggestedFix).toContain('screenshot');
  });

  it('service 不吞掉丢弃：调用直接失败，绝不回 ok:true', async () => {
    const { service } = makeService({ clickDrop: true });
    await expect(service.action({ action: 'click', coordinate: [10, 20], sessionId: 's1' })).rejects.toMatchObject({
      code: 'INPUT_DROPPED'
    });
  });

  it('鼠标移动被丢弃同样失败（不会在错的落点上继续点）', async () => {
    const { service } = makeService({ moveDrop: true });
    await expect(service.action({ action: 'move', coordinate: [10, 20], sessionId: 's1' })).rejects.toMatchObject({
      code: 'INPUT_DROPPED'
    });
  });
});

describe('动作已执行但截图失败（applied + screenshotError）', () => {
  it('不抛错、不伪装成截图成功：applied:true + screenshotError + 明确不要重复', async () => {
    const { service, calls } = makeService({ failGrab: true });
    const r = await service.action({ action: 'click', coordinate: [10, 20], sessionId: 's1' });
    expect(r.ok).toBe(true);
    expect(r.applied).toBe(true);
    expect(r.action).toBe('click');
    // 动作确实执行了（点过了）
    expect(calls.clicks).toEqual(['left']);
    expect(r.screenshotErrorCode).toBe('CAPTURE_FAILED');
    expect(r.screenshotError).toContain('空图像');
    // 没有截图就没有 base64 / 尺寸字段：别让视觉管线以为有一张图可注入
    expect(r.base64).toBeUndefined();
    expect(r.mime).toBeUndefined();
    expect(r.screen).toBeUndefined();
    expect(r.note).toContain('已经执行');
    expect(r.note).toContain('不要重复执行同一个动作');
  });

  it('没有截图时 cursor 退回整屏物理像素（口径不含缩放）', async () => {
    const { service } = makeService({ failGrab: true });
    const r = await service.action({ action: 'move', coordinate: [10, 20], sessionId: 's1' });
    // 全局物理 (120,240) - 原点 (0,0)，本屏物理 1000x800 → 同值
    expect(r.cursor).toEqual({ x: 120, y: 240 });
  });

  it('截图成功的一次动作：applied:true，且没有 screenshotError 字段', async () => {
    const { service } = makeService();
    const r = await service.action({ action: 'click', coordinate: [10, 20], sessionId: 's1' });
    expect(r.ok).toBe(true);
    expect(r.applied).toBe(true);
    expect(r.screenshotError).toBeUndefined();
    expect(r.screen).toEqual({ width: 1000, height: 800 });
    expect(r.base64).toBe('aGVsbG8=');
    // 有截图时光标换算到「模型看到的那套像素」
    expect(r.cursor).toEqual({ x: 120, y: 240 });
  });

  it('截图失败只属于输入动作：action=screenshot 失败仍然抛错（没有动作被执行）', async () => {
    const { service } = makeService({ failGrab: true });
    await expect(service.action({ action: 'screenshot', sessionId: 's1' })).rejects.toMatchObject({
      code: 'CAPTURE_FAILED'
    });
  });

  it('回报类探测失败（光标/前台窗口）不会把已执行的动作变成错误', async () => {
    const { service } = makeService({ probeBoom: true });
    const r = await service.action({ action: 'click', coordinate: [10, 20], sessionId: 's1' });
    expect(r.ok).toBe(true);
    expect(r.applied).toBe(true);
    expect(r.cursor).toBeUndefined();
    expect(r.activeWindow).toBe('');
  });

  it('type 回报实际投递字符数（不是「打算输入多少」）', async () => {
    const { service } = makeService({ typeText: async () => 2 });
    const r = await service.action({ action: 'type', text: 'abcd', sessionId: 's1' });
    expect(r.typed).toBe(2);
  });
});

describe('出站净化保留诚实字段', () => {
  it('applied / changed / stable 不被 sanitize 掉（模型要能判断动作生效与画面事实）', () => {
    const out = sanitizeToolResultForApi('computer', {
      ok: true,
      action: 'click',
      applied: true,
      changed: false,
      stable: true,
      display: 0,
      primary: true,
      screen: { width: 1000, height: 800 },
      cursor: { x: 1, y: 2 },
      activeWindow: '记事本',
      mime: 'image/png',
      base64: 'aGVsbG8=',
      width: 1000,
      height: 800
    });
    expect(out.applied).toBe(true);
    expect(out.changed).toBe(false);
    expect(out.stable).toBe(true);
    expect(out.base64).toBeUndefined();
    expect(out.base64Omitted).toBe(true);
  });
});
