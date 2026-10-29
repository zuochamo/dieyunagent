'use strict';

/**
 * 第三档：动作枚举单一来源、`wait_until`（用看代替猜）、窗口清单/切前台。
 *
 * 这些用例的共同立场：模型能看到的事实必须与执行端的真实状态一致 ——
 * 等不到就说等不到（timedOut），判断不了就说判断不了（无帧指纹），
 * 切前台失败就不能回 ok（否则后续点击全打在错的窗口上）。
 */

const { createComputerService } = require('../../src/computer/service');
const { COMPUTER_ACTIONS, COMPUTER_ACTIONS_TEXT, READ_ONLY_ACTIONS } = require('../../src/computer/actions');
const { validateToolArgs } = require('../../src/agent/tool-validate');
const { COMPUTER_TOOL } = require('../../src/agent/tool-catalog');
const { decideOsControlAction } = require('../../src/gateway/sandbox-policy');
const { invalidWindowError, activateFailedError } = require('../../src/computer/win32-input');
const { AGENT_LIMITS_DEFAULTS } = require('../../src/agent/agent-limits');
const { makeCapture, makeWin32, makeDisplay } = require('./computer-fakes.cjs');

function makeService(opts = {}) {
  const { capture, state } = makeCapture(opts);
  const { win32, calls } = makeWin32(opts);
  const service = createComputerService({ log: () => {}, capture, win32 });
  return { service, state, calls };
}

describe('动作枚举单一来源', () => {
  it('schema 里的 action 取值就是 actions.js 的枚举文本', () => {
    const props = COMPUTER_TOOL.function.parameters.properties;
    expect(props.action.description).toBe(COMPUTER_ACTIONS_TEXT);
    for (const name of COMPUTER_ACTIONS) expect(COMPUTER_TOOL.function.description).toContain(name);
  });

  it('每个动作都能通过校验层（不会出现「schema 允许、校验拒绝」）', () => {
    const minimal = {
      screenshot: {},
      click: { coordinate: [1, 2] },
      double_click: { coordinate: [1, 2] },
      right_click: { coordinate: [1, 2] },
      middle_click: { coordinate: [1, 2] },
      move: { coordinate: [1, 2] },
      drag: { coordinate: [1, 2], to: [3, 4] },
      type: { text: 'x' },
      key: { key: 'enter' },
      scroll: {},
      wait: { ms: 100 },
      wait_until: { condition: 'changed' },
      list_windows: {},
      activate_window: { handle: 1 }
    };
    expect(Object.keys(minimal).sort()).toEqual([...COMPUTER_ACTIONS].sort());
    for (const [action, extra] of Object.entries(minimal)) {
      const r = validateToolArgs('computer', { action, ...extra });
      expect({ action, ok: r.ok, err: r.error }).toEqual({ action, ok: true, err: undefined });
    }
  });

  it('沙箱只读集合与 actions.js 的 mutates:false 一致（倒置白名单仍生效）', () => {
    for (const action of COMPUTER_ACTIONS) {
      const d = decideOsControlAction(action, { mode: 'read-only' });
      expect({ action, action2: d.action }).toEqual({
        action,
        action2: READ_ONLY_ACTIONS.has(action) ? 'allow' : 'ask'
      });
      // danger-full-access 下一律放行
      expect(decideOsControlAction(action, { mode: 'danger-full-access' }).action).toBe('allow');
    }
  });
});

describe('wait_until：等到了没有是可观测事实', () => {
  it('condition=changed：画面变了就返回 changed:true（不靠猜毫秒数）', async () => {
    const state = { tag: 1 };
    const { service } = makeService({ tag: () => state.tag });
    // 先看一眼，建立基线
    await service.action({ action: 'screenshot', sessionId: 's1' });
    state.tag = 2; // 界面变化了（比如加载完成）
    const r = await service.action({ action: 'wait_until', condition: 'changed', sessionId: 's1' });
    expect(r.ok).toBe(true);
    expect(r.changed).toBe(true);
    expect(r.timedOut).toBe(false);
    expect(r.waitedMs).toBeGreaterThanOrEqual(0);
    expect(r.note).toContain('已经变化');
  });

  it('condition=changed 但画面一直没变：timedOut:true + changed:false + 明说「没发生」', async () => {
    const { service } = makeService({ tag: 1 });
    await service.action({ action: 'screenshot', sessionId: 's1' });
    const r = await service.action({ action: 'wait_until', condition: 'changed', ms: 300, sessionId: 's1' });
    expect(r.changed).toBe(false);
    expect(r.timedOut).toBe(true);
    // 这是「上一步大概没生效」的信号，必须写清楚，否则模型会原样重试
    expect(r.note).toContain('没有任何变化');
    expect(r.note).toContain('不要原样重复');
  });

  it('condition=stable：连续两帧相同即返回 stable:true', async () => {
    const { service } = makeService({ tag: 1 });
    const r = await service.action({ action: 'wait_until', condition: 'stable', sessionId: 's1' });
    expect(r.stable).toBe(true);
    expect(r.timedOut).toBe(false);
    expect(r.note).toContain('已稳定');
  });

  it('平台给不出帧指纹：不烧预算假装在等，直接说「判断不了」', async () => {
    const { capture, state } = makeCapture({ tag: 1 });
    capture.frameSignature = () => null;
    const { win32 } = makeWin32();
    const service = createComputerService({ log: () => {}, capture, win32 });
    const r = await service.action({ action: 'wait_until', condition: 'changed', sessionId: 's1' });
    expect(r.ok).toBe(true);
    expect(r.changed).toBeUndefined();
    expect(r.note).toContain('帧指纹');
    expect(state.grabs()).toBe(1); // 只抓了一帧就停手
  });
});

describe('窗口清单 / 切前台', () => {
  const secondDisplay = makeDisplay({ index: 1, primary: false, physOrigin: { x: 1000, y: 0 } });
  const windows = [
    { handle: 101, title: '记事本', rect: { x: 100, y: 80, width: 400, height: 300 }, minimized: false, active: true },
    { handle: 202, title: '副屏浏览器', rect: { x: 1200, y: 0, width: 600, height: 400 }, minimized: false, active: false }
  ];

  it('list_windows：标题/句柄/所在屏齐全，rect 换算成与 click 同一套像素', async () => {
    const { service, calls } = makeService({ windows, displays: [makeDisplay(), secondDisplay] });
    const r = await service.action({ action: 'list_windows', sessionId: 's1' });
    expect(r.ok).toBe(true);
    expect(r.action).toBe('list_windows');
    expect(r.count).toBe(2);
    expect(r.activeWindow).toBe('记事本');
    expect(r.windows[0]).toMatchObject({ handle: 101, title: '记事本', display: 0, rect: { x: 100, y: 80, width: 400, height: 300 } });
    // 副屏窗口落在屏 1
    expect(r.windows[1]).toMatchObject({ handle: 202, display: 1 });
    // 条数上限走 agent-limits（数字唯一来源）
    expect(calls.windowListOpts[0]).toEqual({ max: AGENT_LIMITS_DEFAULTS.computerWindowListMax });
    expect(r.note).toContain('activate_window');
  });

  it('list_windows 不出图：省掉一次全屏截图', async () => {
    const { service, state } = makeService({ windows });
    const r = await service.action({ action: 'list_windows', sessionId: 's1' });
    expect(r.base64).toBeUndefined();
    expect(r.screen).toBeUndefined();
    expect(state.grabs()).toBe(0);
  });

  it('最小化窗口位置报 null（不编坐标，免得模型照着点屏外）', async () => {
    const minimized = [
      { handle: 303, title: '最小化的记事本', rect: null, minimized: true, active: false }
    ];
    const { service } = makeService({ windows: minimized });
    const r = await service.action({ action: 'list_windows', sessionId: 's1' });
    expect(r.windows[0]).toMatchObject({ handle: 303, rect: null, display: -1, minimized: true });
    expect(r.note).toContain('最小化');
  });

  it('activate_window：切成功后返回 applied + 新画面', async () => {
    const { service, calls } = makeService({ windows });
    const r = await service.action({ action: 'activate_window', handle: 101, sessionId: 's1' });
    expect(calls.activations).toEqual([101]);
    expect(r.applied).toBe(true);
    expect(r.screen).toEqual({ width: 1000, height: 800 });
    expect(r.note).toContain('已切到');
  });

  it('activate_window：句柄不在清单里（编的/已失效）直接被拒，不调用注入', async () => {
    const { service, calls } = makeService({ windows });
    await expect(service.action({ action: 'activate_window', handle: 999, sessionId: 's1' })).rejects.toMatchObject({
      code: 'INVALID_WINDOW'
    });
    expect(calls.activations).toEqual([]);
  });

  it('activate_window：前台抢不到就如实失败（不假装成功）', async () => {
    const { service } = makeService({ windows, activateBoom: true });
    await expect(service.action({ action: 'activate_window', handle: 101, sessionId: 's1' })).rejects.toMatchObject({
      code: 'ACTIVATE_FAILED'
    });
  });

  it('注入层的窗口错误契约：code / retryable=false / 给出替代路径', () => {
    const bad = invalidWindowError(42, '窗口已不存在');
    expect(bad.code).toBe('INVALID_WINDOW');
    expect(bad.retryable).toBe(false);
    expect(bad.suggestedFix).toContain('list_windows');

    const failed = activateFailedError('记事本');
    expect(failed.code).toBe('ACTIVATE_FAILED');
    expect(failed.retryable).toBe(false);
    expect(failed.message).toContain('记事本');
    expect(failed.suggestedFix).toContain('click');
  });
});
