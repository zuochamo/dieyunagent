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

  /** 决策与感官事件（页面只读；`intent` 不在其中） */
  ipcMain.handle('alive:decisions', (_evt, payload = {}) =>
    withRuntime((alive) => {
      const limit = Math.min(200, Math.max(1, Number(payload && payload.limit) || 30));
      return { ok: true, events: alive.runtime.decisions(limit) };
    })
  );

  /** 体征历史（曲线）：窗口内等距抽样后的采样点 + 总行数 */
  ipcMain.handle('alive:history', (_evt, payload = {}) =>
    withRuntime((alive) => {
      const p = payload && typeof payload === 'object' ? payload : {};
      const windowMs = Number(p.windowMs) || 0;
      const points = Math.min(2000, Math.max(2, Number(p.points) || 240));
      return { ok: true, ...alive.runtime.history({ windowMs, points }) };
    })
  );

  /**
   * 主界面徽标用的极轻查询：只读 state.json + 事件流尾部一行。
   *
   * 为什么不复用 `alive:status`：status 会读模型设置与权限文件（为了感官自检），
   * 那是"打开设置页时才需要"的重量；徽标是常驻 30s 轮询，必须便宜。
   *
   * 2026-11-13：多了 `lastWakeText`/`lastWakeTextAt`（没出声的那些唤醒轮写了什么），
   * 少了 `recent`/`recentAt` —— 那两个只为 rail 图标的律动算的，动画去掉后没有消费者了。
   */
  ipcMain.handle('alive:badge', () =>
    withRuntime((alive) => {
      const st = alive.runtime.status();
      if (!st || st.exists === false) return { ok: true, enabled: false };
      const events = alive.runtime.decisions(5);
      const last = events.length ? events[events.length - 1] : null;
      const lastTs = Number((last && last.ts) || 0);
      return {
        ok: true,
        enabled: st.enabled === true,
        running: st.running === true,
        phase: st.phase || '',
        wakeCountToday: Number(st.wakeCountToday) || 0,
        lastKind: last ? String(last.kind || '') : '',
        lastTs,
        /** 它上一次**说了什么**（原话，来自 state.json）：主窗口那条「它说…」就用这两项 */
        lastVoiceText: String(st.lastVoiceText || ''),
        lastVoiceAt: Number(st.lastVoiceAt) || 0,
        /**
         * 它**这一轮醒来写下了什么**（正文压成一行）：没出声的那些唤醒轮，人只能从这一项看见。
         * 主窗口那行在这一项比 `lastVoiceAt` 新时显示「它醒来写了…」（同一处渲染）。
         */
        lastWakeText: String(st.lastWakeText || ''),
        lastWakeTextAt: Number(st.lastWakeTextAt) || 0
      };
    })
  );

  ipcMain.handle('alive:set-enabled', (_evt, payload = {}) =>
    withRuntime((alive) => {
      const res = alive.setEnabled(payload && payload.enabled === true);
      return { ok: true, ...res, status: alive.status() };
    })
  );

  /** 现在叫醒它一次（演示 / 排障）：跳过张力门限跑一轮，事件记 `trigger=manual` */
  ipcMain.handle('alive:wake-once', () =>
    withRuntime((alive) => {
      if (typeof alive.wakeOnce !== 'function') return { ok: false, error: '这个版本没有手动唤醒入口' };
      // 一轮十几秒到几十秒：把 promise 原样交出去，Renderer 自己决定怎么等
      return Promise.resolve(alive.wakeOnce()).then(
        (res) => ({ ok: !!(res && res.ok), ...(res || {}), status: alive.status() }),
        (err) => ({ ok: false, error: (err && err.message) || String(err) })
      );
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
