'use strict';

/**
 * 点点悬浮窗（桌面端）：透明置顶 BrowserWindow 的唯一生命周期管理者。
 *
 * 职责只有窗口本身：创建/销毁、尺寸随设置、拖动移动、点击穿透切换、位置持久化。
 * 宠物长什么样（128 个点的动画）全在悬浮窗页面（`src/renderer/pet-window/pet.js`），
 * 这里不碰动画、不碰形态语义 —— 页面收到设置后自己画。
 *
 * 关键机制：
 * - 透明窗口整块矩形默认挡鼠标；页面在 mousemove 里做「指针是否压在点身上」的命中检测，
 *   压到了才关穿透（可拖/可点），其余位置 `setIgnoreMouseEvents(true, {forward:true})`
 *   让桌面点击直接穿透。forward 让页面在穿透态仍收得到 mousemove（Windows 支持）。
 * - 拖动用「页面报指针的屏幕绝对坐标 + Main setPosition」：窗口追指针，没有增量反馈回路。全程不抢焦点。
 * - 窗口 focusable=false：点点点不抢当前输入焦点（桌面宠物的底线）。
 */

const path = require('path');
const { BrowserWindow, screen } = require('electron');
/** 拖动的位置算账（纯函数，单测直测那一份）：这里只调屏幕 API 不自己算 */
const petDrag = require('../pet/drag');

/** size=1.0 时的窗口边长（CSS px / DIP）。合法区间在 settings.js（size 夹取的唯一来源） */
const PET_WINDOW_BASE_PX = 280;
/** 默认停靠：主屏工作区右下角的留白 */
const PET_DOCK_MARGIN = 24;

function createPetWindowManager(ctx) {
  const getSettings = () => (typeof ctx.getSettings === 'function' ? ctx.getSettings() : null);
  const patchSettings = (patch) =>
    typeof ctx.patchSettings === 'function' ? ctx.patchSettings(patch) : null;
  const logInfo = (msg) => {
    try {
      if (typeof ctx.log === 'function') ctx.log(msg);
    } catch {
      // 日志失败不影响窗口
    }
  };

  let win = null;
  let pageReady = false;
  let mousePass = true;
  let dragOffset = null; // 拖动中：指针相对窗口左上角的抓取偏移（DIP）
  /** 页面回报的运行状态（当前形态）——形态是它自己的状态，Main 不能猜 */
  let pageShape = '';

  function windowEdge(settings) {
    return Math.round(PET_WINDOW_BASE_PX * (settings ? settings.size : 1));
  }

  function defaultPosition(edge) {
    const wa = (screen.getPrimaryDisplay() || {}).workArea || { x: 0, y: 0, width: 1280, height: 800 };
    return {
      x: wa.x + wa.width - edge - PET_DOCK_MARGIN,
      y: wa.y + wa.height - edge - PET_DOCK_MARGIN
    };
  }

  /** 当前所有显示器的工作区（DIP）与主屏工作区：夹取算在 `pet/drag.js`（纯函数，有直测） */
  function workAreas() {
    const list = screen.getAllDisplays() || [];
    const areas = list.map((d) => d.workArea || d.bounds || null).filter(Boolean);
    const primary = (screen.getPrimaryDisplay() || {}).workArea || null;
    return { areas, primary };
  }

  /** 把窗口矩形夹进它中心所在的显示器工作区（多显示器拖动后不丢） */
  function clampIntoWorkArea(x, y, edge) {
    const { areas, primary } = workAreas();
    return petDrag.clampIntoWorkArea(areas, x, y, edge, primary);
  }

  /**
   * 显示器增删/分辨率变化后把窗口夹回可视区并落盘：否则拔掉那台显示器，
   * 点点就停在一块不存在的屏幕上（进程还在跑，用户再也看不到它）。
   */
  function reclampToWorkArea() {
    const w = activeWindow();
    if (!w) return;
    const b = w.getBounds();
    const pos = clampIntoWorkArea(b.x, b.y, Math.max(1, b.width));
    if (pos.x === b.x && pos.y === b.y) return;
    w.setPosition(pos.x, pos.y, false);
    try {
      patchSettings({ x: pos.x, y: pos.y });
    } catch (err) {
      logInfo(`[pet] 位置落盘失败：${(err && err.message) || err}`);
    }
  }

  let displaysHooked = false;
  let displayChangeHandler = null;
  function hookDisplayChanges() {
    if (displaysHooked) return;
    displaysHooked = true;
    const onChange = () => reclampToWorkArea();
    for (const evt of ['display-added', 'display-removed', 'display-metrics-changed']) {
      try {
        screen.on(evt, onChange);
      } catch {
        // 拿不到 screen 事件就退化为「下次拖动时夹取」
      }
    }
    displayChangeHandler = onChange;
  }

  function ensureWindow() {
    if (win && !win.isDestroyed()) return win;
    pageReady = false;
    mousePass = true;
    dragOffset = null; // 新窗口没有「上一次拖动」的抓取偏移
    pageShape = '';
    const settings = getSettings() || {};
    const edge = windowEdge(settings);
    const start =
      settings.x !== null && settings.y !== null
        ? clampIntoWorkArea(Number(settings.x), Number(settings.y), edge)
        : defaultPosition(edge);
    win = new BrowserWindow({
      width: edge,
      height: edge,
      x: start.x,
      y: start.y,
      show: false,
      frame: false,
      transparent: true,
      hasShadow: false,
      thickFrame: false,
      roundedCorners: false,
      resizable: false,
      maximizable: false,
      minimizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      focusable: false,
      backgroundColor: '#00000000',
      title: '点点',
      webPreferences: {
        preload: path.join(__dirname, '..', 'renderer', 'pet-window', 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        // 被遮挡时也保持动画节律（节律本身由页面控：30fps 上限 + 页面不可见时暂停）
        backgroundThrottling: false
      }
    });
    try {
      // 'screen-saver' 档：压过任务栏之外的普通置顶窗口；普通 alwaysOnTop 会被同级窗口盖住
      win.setAlwaysOnTop(true, 'screen-saver');
    } catch {
      // 个别平台不支持档位参数，普通置顶也够用
    }
    try {
      win.setIgnoreMouseEvents(true, { forward: true });
    } catch {
      // forward 不支持时退化为整体穿透：宠物暂时不可点，但不挡桌面
    }
    win.on('closed', () => {
      win = null;
      pageReady = false;
    });
    // 页面崩溃：不拖垮主进程，销毁后由下一次 syncFromSettings 重建
    win.webContents.on('render-process-gone', () => {
      logInfo('[pet] 悬浮窗渲染进程退出，销毁待重建');
      if (win && !win.isDestroyed()) win.destroy();
      win = null;
      pageReady = false;
    });
    win.loadFile(path.join(__dirname, '..', 'renderer', 'pet-window', 'index.html'));
    hookDisplayChanges();
    return win;
  }

  function activeWindow() {
    return win && !win.isDestroyed() ? win : null;
  }

  /** 页面已就绪：首次 show 用 showInactive —— 宠物出现不能抢用户正在打的字 */
  function markPageReadyAndShow() {
    pageReady = true;
    const w = activeWindow();
    if (!w) return;
    const settings = getSettings();
    if (settings && settings.enabled && !w.isVisible()) w.showInactive();
  }

  /** 设置变化后的唯一入口：按 enabled 建/销窗，尺寸/位置对齐，再把设置推给页面 */
  function syncFromSettings(settings) {
    if (!settings || !settings.enabled) {
      destroyWindow();
      return;
    }
    const w = ensureWindow();
    const edge = windowEdge(settings);
    const b = w.getBounds();
    if (b.width !== edge || b.height !== edge) {
      // 尺寸变化保持中心不动
      const cx = b.x + b.width / 2;
      const cy = b.y + b.height / 2;
      const pos = clampIntoWorkArea(Math.round(cx - edge / 2), Math.round(cy - edge / 2), edge);
      w.setBounds({ x: pos.x, y: pos.y, width: edge, height: edge });
    }
    w.webContents.send('pet:apply', settings);
    if (pageReady && !w.isVisible()) w.showInactive();
  }

  function destroyWindow() {
    const w = activeWindow();
    if (!w) return;
    // 拖动后的位置在 drag-end 已落盘；这里只负责拆窗（拖动状态一并清掉，别留给下一个窗口）
    dragOffset = null;
    w.destroy();
    win = null;
    pageReady = false;
    pageShape = '';
  }

  /** 拖动开始：记「指针相对窗口」的抓取偏移（此后窗口 = 指针 − 偏移，无增量反馈回路） */
  function dragStart(sx, sy) {
    const w = activeWindow();
    // 每次按下都从「没有偏移」开始：旧偏移留着只会在下一次移动里把窗口推到错的位置
    dragOffset = null;
    if (!w) {
      logInfo('[pet] 拖动开始被丢弃：窗口正在重建（页面会继续发移动，下一次移动自愈）');
      return;
    }
    try {
      const cursor = screen.getCursorScreenPoint();
      const b = w.getBounds();
      dragOffset = petDrag.offsetForPointer(b, {
        x: Number.isFinite(cursor.x) ? cursor.x : sx,
        y: Number.isFinite(cursor.y) ? cursor.y : sy
      });
      /**
       * 诊断：页面报的坐标与系统口径**应该**是同一个物理点（都为 DIP）。
       * 明显不一致时（混合 DPI 老版本 / 缩放变化瞬间）按系统口径拖，并留一行日志 ——
       * 这种偏差会表现为「拖一下窗口就跳到边上」，下次现场直接看日志就能确认。
       */
      if (Number.isFinite(sx) && Number.isFinite(sy)) {
        const dx = Math.abs(cursor.x - sx);
        const dy = Math.abs(cursor.y - sy);
        if (dx > 8 || dy > 8) {
          logInfo(
            `[pet] 指针坐标口径不一致：页面 ${Math.round(sx)},${Math.round(sy)} vs 系统 ${cursor.x},${cursor.y}（按系统口径拖）`
          );
        }
      }
    } catch (err) {
      logInfo(`[pet] 抓取偏移算不出来（${(err && err.message) || err}），改由第一次移动自愈`);
    }
  }

  /** 拖动中：指针当前屏幕坐标（DIP）→ 窗口绝对定位，夹进工作区 */
  function dragMoveTo(sx, sy) {
    const w = activeWindow();
    if (!w || !Number.isFinite(sx) || !Number.isFinite(sy)) return;
    const b = w.getBounds();
    if (!dragOffset) {
      // 自愈：偏移丢了（dragStart 没拿到窗口 / getBounds 抛错 / 窗口刚重建）时**不要丢弃整轮拖动**。
      // 静默 return 过的后果就是「拖不动」：页面在拖、Main 一个位置都不写，窗口一动不动。
      // 现补一份偏移后「新位置 = 指针 − 新偏移 = 当前位置」，窗口不跳，拖动照常继续。
      dragOffset = petDrag.offsetForPointer(b, { x: sx, y: sy });
      logInfo('[pet] 抓取偏移缺失，按当前指针自愈（这次拖动继续）');
    }
    const { areas, primary } = workAreas();
    const pos = petDrag.positionForPointer(areas, b, dragOffset, { x: sx, y: sy }, primary);
    w.setPosition(pos.x, pos.y, false);
  }

  /** 拖动结束：把当前位置落盘（此后重启/重建都回到这里）。没移动过（单击）只清状态，不写盘 */
  function dragEnd(payload) {
    const moved = !(payload && payload.moved === false);
    dragOffset = null;
    const w = activeWindow();
    if (!w || !moved) return;
    const b = w.getBounds();
    try {
      patchSettings({ x: b.x, y: b.y });
      logInfo('[pet] 位置已保存');
    } catch (err) {
      logInfo(`[pet] 位置保存失败：${(err && err.message) || err}`);
    }
  }

  function setMousePass(pass) {
    const w = activeWindow();
    if (!w) return;
    const next = pass !== false;
    if (next === mousePass) return;
    mousePass = next;
    try {
      w.setIgnoreMouseEvents(next, { forward: true });
    } catch {
      // ignore
    }
  }

  /** 页面回报的当前形态（球/猫）；窗口没建/还没回报时是空串 */
  function notePageState(state) {
    const shape = state && typeof state.shape === 'string' ? state.shape : '';
    if (shape && shape !== pageShape) pageShape = shape;
  }

  function getLiveShape() {
    return pageShape;
  }

  /** 生命感 → 悬浮窗的只读推送（体征快照 / 事件 / 模型瞬时动作），页面自己决定怎么表现 */
  function forwardAlive(payload) {
    const w = activeWindow();
    if (!w) return;
    try {
      w.webContents.send('pet:alive', payload || {});
    } catch {
      // 窗口正在销毁时推送失败不影响生命感
    }
  }

  function dispose() {
    if (displayChangeHandler) {
      for (const evt of ['display-added', 'display-removed', 'display-metrics-changed']) {
        try {
          screen.removeListener(evt, displayChangeHandler);
        } catch {
          // ignore
        }
      }
      displayChangeHandler = null;
      displaysHooked = false;
    }
    destroyWindow();
  }

  return {
    syncFromSettings,
    markPageReadyAndShow,
    dragStart,
    dragMoveTo,
    dragEnd,
    setMousePass,
    notePageState,
    getLiveShape,
    forwardAlive,
    dispose
  };
}

module.exports = { createPetWindowManager, PET_WINDOW_BASE_PX };
