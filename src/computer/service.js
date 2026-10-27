'use strict';

/**
 * OS 级电脑控制服务（仅 Main 进程；经 LocalGateway 注入给 computer.* handler）。
 *
 * 职责：把 computer 工具的结构化动作编排成 Win32 输入 + desktopCapturer 截图。
 * 不做档位判定（sandbox-policy）也不做审批（gateway handler）——这里是纯执行体。
 *
 * 动作循环语义：每次调用返回执行后的最新截图，模型「动一下看一眼」，无需再显式
 * 调 screenshot；坐标口径为「模型最近一次看到的截图」的像素（按会话记忆，
 * 多显示器时模型看到的哪块屏，下一步动作就落在哪块屏）。
 */

const { listDisplays, getDisplay, captureDisplay } = require('./capture');
const win32 = require('./win32-input');
const { displayPhysicalSize } = require('./coordinate-map');
const {
  mapDisplayPointToScreenPhysical,
  mapScreenPhysicalToDisplayPoint
} = require('./coordinate-map');
const { AGENT_LIMITS_DEFAULTS } = require('../agent/agent-limits');

/** 定位后等 UI 响应再截图的间隔（弹窗/菜单动画）。 */
const SETTLE_DELAY_MS = 180;

const CLICK_ACTIONS = new Set(['click', 'double_click', 'right_click', 'middle_click']);
const ALL_ACTIONS = new Set([
  ...CLICK_ACTIONS,
  'screenshot',
  'move',
  'drag',
  'type',
  'key',
  'scroll',
  'wait'
]);

const DEFAULT_SCROLL_NOTCHES = 3;
// 等待时长是护栏数字（AGENTS.md §6）：唯一来源在 agent-limits，这里只做别名。
const MIN_WAIT_MS = AGENT_LIMITS_DEFAULTS.computerWaitMinMs;
const MAX_WAIT_MS = AGENT_LIMITS_DEFAULTS.computerWaitMaxMs;

/** 会话视图记忆上限：防长跑进程累积。 */
const MAX_SESSION_VIEWS = 200;

/**
 * @param {{ log?: (msg: string) => void }} [deps]
 */
function createComputerService(deps = {}) {
  const log = typeof deps.log === 'function' ? deps.log : () => {};

  /** sessionId → { displayIndex, width, height }（模型最近一次看到的截图）。 */
  const viewBySession = new Map();

  function input() {
    // koffi 在 win32-input 内部惰性加载；非 Windows 在这一步就报 OS_CONTROL_UNSUPPORTED，
    // 而不是「截屏成功之后再炸在光标回报上」。
    if (!win32.isSupported()) throw win32.unsupportedError();
    return win32;
  }

  function rememberView(sessionId, displayIndex, width, height) {
    const sid = String(sessionId || '').trim() || '-';
    if (viewBySession.has(sid)) viewBySession.delete(sid);
    viewBySession.set(sid, { displayIndex, width, height });
    while (viewBySession.size > MAX_SESSION_VIEWS) {
      const oldest = viewBySession.keys().next().value;
      viewBySession.delete(oldest);
    }
  }

  function lastView(sessionId) {
    return viewBySession.get(String(sessionId || '').trim() || '-') || null;
  }

  /**
   * 目标屏解析：显式 display 越界要报错（让模型自己纠正）；视图记忆里的屏可能
   * 已经被拔掉，失效时回落到主屏，不能把后续每个动作都卡死。
   */
  function resolveDisplay(explicit, rememberedIndex) {
    if (explicit != null) return getDisplay(explicit);
    if (rememberedIndex != null) {
      try {
        return getDisplay(rememberedIndex);
      } catch {
        /* 屏拔了：忽略记忆 */
      }
    }
    return getDisplay(undefined);
  }

  function clampPoint(point, size) {
    return [
      Math.min(Math.max(0, Math.round(point[0])), Math.max(0, size.width - 1)),
      Math.min(Math.max(0, Math.round(point[1])), Math.max(0, size.height - 1))
    ];
  }

  function buildResult(action, display, shot, cursorPhys, extra = {}) {
    const out = {
      ok: true,
      action,
      display: display.index,
      primary: display.primary,
      screen: { width: shot.width, height: shot.height },
      // 光标回报必须落在「模型看到的那套像素」里：同一张截图的尺寸参与换算，
      // 否则截图被放大/缩小过时，cursor 与 coordinate 不是同一个空间。
      cursor: mapScreenPhysicalToDisplayPoint(display, cursorPhys, {
        width: shot.width,
        height: shot.height
      }),
      activeWindow: extra.activeWindow || ''
    };
    if (extra.typed != null) out.typed = extra.typed;
    return { ...out, ...shot };
  }

  async function screenshot(params = {}) {
    const inp = input();
    // 没显式指定屏幕时沿用「模型最近一次看到的那块屏」—— 多显示器下截图跳回主屏会
    // 让模型与自己记忆的坐标脱节（与输入动作同一口径）。
    const remembered = lastView(params.sessionId);
    const display = resolveDisplay(params.display, remembered ? remembered.displayIndex : null);
    const shot = await captureDisplay(display);
    rememberView(params.sessionId, display.index, shot.width, shot.height);
    log(`COMPUTER_SHOT display=${display.index} ${shot.width}x${shot.height}`);
    return buildResult('screenshot', display, shot, inp.getPhysicalCursorPos(), {
      activeWindow: inp.foregroundWindowTitle()
    });
  }

  /** 定位到模型坐标（目标屏物理空间）；返回全局物理坐标。 */
  async function locate(inp, display, viewSize, point) {
    const p = clampPoint(point, viewSize);
    const phys = mapDisplayPointToScreenPhysical(display, viewSize, p);
    inp.moveMouseToPhysical(phys.x, phys.y);
    await inp.sleep(40);
    return phys;
  }

  async function performInputAction(act, a, inp, display, viewSize) {
    let touched = null;
    switch (true) {
      case act === 'move': {
        touched = await locate(inp, display, viewSize, a.coordinate);
        break;
      }
      case CLICK_ACTIONS.has(act): {
        const button = act === 'right_click' ? 'right' : act === 'middle_click' ? 'middle' : a.button || 'left';
        if (a.coordinate) touched = await locate(inp, display, viewSize, a.coordinate);
        inp.clickMouseButton(button);
        if (act === 'double_click') {
          await inp.sleep(80);
          inp.clickMouseButton(button);
        }
        break;
      }
      case act === 'drag': {
        const from = await locate(inp, display, viewSize, a.coordinate);
        const to = mapDisplayPointToScreenPhysical(
          display,
          viewSize,
          clampPoint(a.to, viewSize)
        );
        await inp.dragMouse(from, to, a.button || 'left');
        touched = to;
        break;
      }
      case act === 'type': {
        const sent = await inp.typeText(a.text);
        touched = { typed: sent };
        break;
      }
      case act === 'key': {
        inp.pressKeyCombo(inp.parseKeyCombo(a.key));
        break;
      }
      case act === 'scroll': {
        if (a.coordinate) await locate(inp, display, viewSize, a.coordinate);
        inp.scrollWheel(a.direction || 'down', Number(a.amount) || DEFAULT_SCROLL_NOTCHES);
        break;
      }
      default:
        break;
    }
    return touched;
  }

  /**
   * 执行一个动作并返回最新画面。
   * @param {{ action: string, coordinate?: number[], to?: number[], button?: string, text?: string, key?: string, direction?: string, amount?: number, ms?: number, display?: number, sessionId?: string }} params
   */
  async function action(params = {}) {
    const act = String(params.action || '');
    if (!ALL_ACTIONS.has(act)) {
      const e = new Error(`未知动作「${act}」`);
      e.code = 'INVALID_ACTION';
      e.retryable = false;
      throw e;
    }
    const inp = input();
    const sessionId = params.sessionId || '';
    if (act === 'screenshot') return screenshot(params);

    const view = lastView(sessionId);
    const display = resolveDisplay(params.display, view ? view.displayIndex : null);
    // 模型没看过这个屏（无视图记忆）时，按显示器物理尺寸当作坐标系——
    // 不能钳到 0：那是「首动作就带坐标」的合法路径，坐标必须原样换算。
    const viewSize =
      view && view.displayIndex === display.index
        ? { width: view.width, height: view.height }
        : displayPhysicalSize(display);

    let typed = null;
    if (act === 'wait') {
      const raw = Number(params.ms);
      if (!Number.isFinite(raw) || raw <= 0) {
        const e = new Error(`wait 需要 ms（${MIN_WAIT_MS}–${MAX_WAIT_MS}）`);
        e.code = 'INVALID_ACTION';
        e.retryable = false;
        throw e;
      }
      await inp.sleep(Math.min(MAX_WAIT_MS, Math.max(MIN_WAIT_MS, Math.round(raw))));
    } else {
      const touched = await performInputAction(act, params, inp, display, viewSize);
      if (touched && Number.isFinite(touched.typed)) typed = touched.typed;
    }

    await inp.sleep(SETTLE_DELAY_MS);
    const shot = await captureDisplay(display);
    rememberView(sessionId, display.index, shot.width, shot.height);
    log(`COMPUTER_ACTION ${act} display=${display.index}`);
    return buildResult(act, display, shot, inp.getPhysicalCursorPos(), {
      activeWindow: inp.foregroundWindowTitle(),
      typed
    });
  }

  return {
    action,
    screenshot,
    /** 多显示器清单（模型问「有几块屏」时可用，暂未出 schema）。 */
    listDisplays,
    supported: win32.isSupported()
  };
}

module.exports = { createComputerService };
