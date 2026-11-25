'use strict';

/**
 * 宠物（设置 → 宠物 → 点点）的 IPC（桌面端）。
 *
 * 只做传输注册：设置语义在 `src/pet/settings.js`（唯一存取点），窗口语义在
 * `src/main/pet-window.js`。这里不判形状合法性、不夹数字、不决定窗口建不建。
 *
 * 两个渲染进程都从这里过：
 * - 主窗口（设置页）：pet:get-settings / pet:set-settings / pet:set-enabled（handle）
 * - 点点悬浮窗页面：pet:ready（handle，回设置）+ pet:drag-start / pet:drag-move-to / pet:drag-end / pet:mouse-mode（on，单向）
 */

/**
 * @param {{
 *   ipcMain: import('electron').IpcMain,
 *   petWindow: ReturnType<import('../pet-window').createPetWindowManager>,
 *   getSettings: () => object,
 *   patchSettings: (patch: object) => object,
 *   log?: { info?: Function, warn?: Function }
 * }} ctx
 */
function registerPetIpc(ctx) {
  const { ipcMain } = ctx;
  const logInfo = (msg) => {
    try {
      if (ctx.log && typeof ctx.log.info === 'function') ctx.log.info(msg);
    } catch {
      // ignore
    }
  };

  /** 设置页读当前设置 */
  ipcMain.handle('pet:get-settings', () => ({ ok: true, settings: ctx.getSettings() }));

  /** 设置页写 patch：落盘 + 同步窗口（建/销/尺寸）+ 推给悬浮窗页面 */
  ipcMain.handle('pet:set-settings', (_evt, patch) => {
    try {
      const settings = ctx.patchSettings(patch || {});
      ctx.petWindow.syncFromSettings(settings);
      const keys = Object.keys(patch || {}).join('/');
      logInfo(`[pet] 设置已保存：${keys || '（空 patch）'}`);
      return { ok: true, settings };
    } catch (err) {
      return { ok: false, error: (err && err.message) || String(err) };
    }
  });

  /** 设置页总开关 */
  ipcMain.handle('pet:set-enabled', (_evt, payload) => {
    const enabled = !!(payload && payload.enabled);
    try {
      const settings = ctx.patchSettings({ enabled });
      ctx.petWindow.syncFromSettings(settings);
      logInfo(`[pet] 点点${enabled ? '已显示' : '已关闭'}`);
      return { ok: true, settings };
    } catch (err) {
      return { ok: false, error: (err && err.message) || String(err) };
    }
  });

  /** 悬浮窗页面就绪：回一份当前设置 + 生命感快照（绑定后页面据此初始化体征映射） */
  ipcMain.handle('pet:ready', () => {
    ctx.petWindow.markPageReadyAndShow();
    const alive = typeof ctx.getAliveSnapshot === 'function' ? ctx.getAliveSnapshot() : null;
    return { ok: true, settings: ctx.getSettings(), alive };
  });

  /** 拖动开始：Main 记抓取偏移（高频单向消息，不走 invoke） */
  ipcMain.on('pet:drag-start', (_evt, payload) => {
    const p = payload || {};
    ctx.petWindow.dragStart(Number(p.sx), Number(p.sy));
  });

  /** 拖动中：指针屏幕坐标（绝对定位） */
  ipcMain.on('pet:drag-move-to', (_evt, payload) => {
    const p = payload || {};
    ctx.petWindow.dragMoveTo(Number(p.sx), Number(p.sy));
  });

  /** 拖动结束：当前位置落盘（`moved:false` = 只是一次单击，清状态即可） */
  ipcMain.on('pet:drag-end', (_evt, payload) => {
    ctx.petWindow.dragEnd(payload);
  });

  /** 点击穿透切换：指针压在点身上 = 可交互，其余 = 穿透 */
  ipcMain.on('pet:mouse-mode', (_evt, payload) => {
    ctx.petWindow.setMousePass(!!(payload && payload.pass));
  });

  /** 页面回报自己的运行状态（当前形态）：只读，给 bodyLine 用 */
  ipcMain.on('pet:state', (_evt, payload) => {
    ctx.petWindow.notePageState(payload);
  });
}

module.exports = { registerPetIpc };
