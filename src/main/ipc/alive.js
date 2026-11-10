'use strict';

/**
 * 「设置 → 生命」的 IPC（桌面端）。
 *
 * 这里**只做传输注册**：语义全在 `src/alive/`（运行时）与 `src/main/alive-boot.js`（装配）。
 * 不在这里判生死、不在这里算张力、不在这里决定「要不要唤醒」—— Renderer 只读结果。
 */

/**
 * @param {{
 *   ipcMain: import('electron').IpcMain,
 *   getAlive: () => any,
 *   log?: { info?: Function, warn?: Function }
 * }} ctx
 */
function registerAliveIpc(ctx) {
  const { ipcMain } = ctx;
  const getAlive = () => (typeof ctx.getAlive === 'function' ? ctx.getAlive() : null);

  function withRuntime(fn) {
    const alive = getAlive();
    if (!alive) {
      return { ok: false, error: '生命感运行时尚未装配（桌面主进程未启用）' };
    }
    try {
      return fn(alive);
    } catch (err) {
      return { ok: false, error: (err && err.message) || String(err) };
    }
  }

  ipcMain.handle('alive:status', () => withRuntime((alive) => ({ ok: true, status: alive.status() })));

  ipcMain.handle('alive:decisions', (_evt, payload = {}) =>
    withRuntime((alive) => {
      const limit = Math.min(200, Math.max(1, Number(payload && payload.limit) || 30));
      return { ok: true, events: alive.runtime.decisions(limit) };
    })
  );

  ipcMain.handle('alive:set-enabled', (_evt, payload = {}) =>
    withRuntime((alive) => {
      const res = alive.setEnabled(payload && payload.enabled === true);
      return { ok: true, ...res, status: alive.status() };
    })
  );

  ipcMain.handle('alive:reset', () =>
    withRuntime((alive) => {
      alive.reset();
      return { ok: true, status: alive.status() };
    })
  );

  /** 三个感官开关（抽屉 / 眼睛 / 嘴与耳）：立即生效 */
  ipcMain.handle('alive:set-sense', (_evt, payload = {}) =>
    withRuntime((alive) => {
      const res = alive.setSense(payload && payload.name, payload && payload.enabled === true);
      if (!res || res.ok === false) return res || { ok: false, error: '切换失败' };
      return { ok: true, senses: res.senses, status: alive.status() };
    })
  );

  /** 感官的其它选项：主动出声授权 / 麦克风 / 摄像头（值类型不同，所以与 set-sense 分开） */
  ipcMain.handle('alive:set-option', (_evt, payload = {}) =>
    withRuntime((alive) => {
      const res = alive.setOption(payload && payload.name, payload && payload.value);
      if (!res || res.ok === false) return res || { ok: false, error: '保存失败' };
      return { ok: true, ...res, status: alive.status() };
    })
  );

  /** 枚举本机麦克风 / 摄像头（会 spawn 一次 ffmpeg，所以只在点「刷新设备」时调） */
  ipcMain.handle('alive:devices', () =>
    withRuntime((alive) => {
      const p = alive.listDevices();
      // listDevices 是 async（要等 ffmpeg 打印设备表）：把错误也包成结构化返回
      return Promise.resolve(p).catch((err) => ({ ok: false, error: (err && err.message) || String(err) }));
    })
  );

  /** 抽屉内容（只读预览；没有写入通道 —— 写只发生在它自己的心跳轮里） */
  ipcMain.handle('alive:note', () => withRuntime((alive) => alive.note()));
}

module.exports = { registerAliveIpc };
