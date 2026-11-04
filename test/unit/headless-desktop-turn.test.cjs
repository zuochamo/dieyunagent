'use strict';

/* globals describe, it, expect, vi */
/**
 * 浏览器桌面界面的「一轮」：`src/headless/desktop-turn.js`
 *
 * 这层的存在理由只有一条：**循环只有一份实现**（`runRustAgentLoop`）。所以测试重点不是
 * 重复验证循环行为，而是验证这层的边界：
 *  - 没有 dieyun-core 就明确失败（别静默跑一半）；
 *  - 取消 / 断线要真的中止，而不是留个循环在后台烧模型；
 *  - 未知方法要报错，别让线协议悄悄吞掉。
 */
const { createDesktopTurn } = require('../../src/headless/desktop-turn');

function makeTurn(overrides = {}) {
  return createDesktopTurn({
    gateway: { invokeRpc: vi.fn(async () => ({})) },
    getCoreBridge: () => ({ isReady: () => true }),
    createToolBridge: () => ({ executeAgentTool: vi.fn(async () => ({ ok: true })) }),
    getCompactionAgent: () => null,
    userData: '/tmp/dieyun-test-userdata',
    loadModelSettings: () => ({ textModel: 'test-model', baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'k' }),
    log: () => {},
    ...overrides
  });
}

describe('headless 桌面界面的一轮（desktop-turn）', () => {
  it('没有 dieyun-core 时明确失败，而不是跑一半', async () => {
    const turn = makeTurn({ getCoreBridge: () => ({ isReady: () => false }) });
    const send = vi.fn();
    await expect(turn.handleCall('desktop.loop_run', { payload: {} }, send, null)).rejects.toThrow('dieyun-core');
    // 失败前不该往页面推任何 phase（否则 UI 会显示「开始了」然后卡住）
    expect(send).not.toHaveBeenCalled();
  });

  it('未知方法要报错', async () => {
    const turn = makeTurn();
    await expect(turn.handleCall('desktop.nope', {}, vi.fn(), null)).rejects.toThrow('未知方法');
  });

  it('取消一个不存在的轮次返回 stopped=false（幂等，不抛）', async () => {
    const turn = makeTurn();
    await expect(turn.handleCall('desktop.loop_cancel', { cancelToken: 'nope' }, vi.fn(), null)).resolves.toEqual({
      stopped: false
    });
  });

  it('页面断开时中止它发起的那一轮', () => {
    const turn = makeTurn();
    const abortController = { aborted: false, abort() {}, signal: null };
    const abort = vi.spyOn(abortController, 'abort');
    const fakeWs = { id: 'ws-1' };
    turn.running.set('tok-1', { abortController, sessionId: 's', ws: fakeWs });
    turn.running.set('tok-2', { abortController: { abort() {} }, sessionId: 's', ws: { id: 'ws-2' } });

    turn.cancelForSocket(fakeWs);

    expect(abort).toHaveBeenCalled();
    expect(turn.running.has('tok-1')).toBe(false);
    // 别的连接上的那一轮不能被他人的断开牵连
    expect(turn.running.has('tok-2')).toBe(true);
  });
});
