'use strict';

/**
 * 渲染进程冻结取证（问题 B / B2）—— Main 侧唯一来源。
 *
 * 两条 IPC（单向 send，见 src/preload.js）：
 * - `renderer:freeze-beat`   心跳，只更新内存时间戳，**不落盘**（否则每 10s 一条噪声）
 * - `renderer:freeze-report` 可疑快照，落盘 main.log
 *
 * 窗口生命周期事件（unresponsive / render-process-gone）由 src/main/window-tray.js 调
 * `reportRendererFreeze()` 落盘 —— 那里的现场采集一律走本模块，避免出现两份实现。
 *
 * 移除条件：根因定位并修复后，删除本文件、preload 两个方法与 window-tray 的调用；
 * unresponsive / render-process-gone 两条落盘日志可保留（只依赖主进程同步可得的进程指标）。
 */

/** 取证日志前缀（docs/LOGGING.md 的 [dieyun:renderer] 域） */
const RENDERER_FREEZE_PREFIX = '[dieyun:renderer] freeze';
/** 单条 payload 上限（字符）：取证不该拖慢写盘、撑爆日志 */
const RENDERER_FREEZE_PAYLOAD_LIMIT = 4000;

/**
 * 主进程同步可得的渲染进程现场。
 *
 * 刻意不用 `webContents.getProcessMemoryInfo()`：它是 Promise，而冻结/崩溃场景下
 * 渲染进程不保证回包；`app.getAppMetrics()` 是同步快照，卡死时一定拿得到。
 *
 * @param {object} app Electron app
 * @param {object|null} webContents 主窗口 webContents
 */
function collectRendererProcessMetrics(app, webContents) {
  const metrics = { pid: 0, cpuPercent: null, workingSetMB: null, privateMB: null };
  try {
    if (webContents && !webContents.isDestroyed() && typeof webContents.getOSProcessId === 'function') {
      metrics.pid = webContents.getOSProcessId();
    }
    const list = app && typeof app.getAppMetrics === 'function' ? app.getAppMetrics() : [];
    const hit =
      (metrics.pid && list.find((m) => m.pid === metrics.pid)) || list.find((m) => m.type === 'Tab');
    if (hit) {
      metrics.cpuPercent = Math.round(((hit.cpu && hit.cpu.percentCPUUsage) || 0) * 10) / 10;
      metrics.workingSetMB = Math.round(((hit.memory && hit.memory.workingSetSize) || 0) / 1024);
      metrics.privateMB = Math.round(((hit.memory && hit.memory.privateBytes) || 0) / 1024);
    }
  } catch {
    // 指标缺失不影响取证落盘
  }
  return metrics;
}

/**
 * 组装一行取证日志：单行、前缀固定，便于 grep 与日志面板按前缀过滤。
 *
 * @param {string} tag 事件名（snapshot / unresponsive / render-process-gone）
 * @param {*} payload 渲染侧快照或 Electron 的 details
 * @param {object} metrics collectRendererProcessMetrics 的结果
 * @param {number|null} silentMs 距渲染进程最后一次心跳的毫秒数；null 表示无基准
 */
function formatRendererFreezeReport(tag, payload, metrics, silentMs) {
  let body = '';
  try {
    body = JSON.stringify(payload === undefined ? {} : payload);
  } catch {
    body = '"[unserializable]"';
  }
  if (typeof body !== 'string') body = '"[unserializable]"';
  if (body.length > RENDERER_FREEZE_PAYLOAD_LIMIT) {
    body = `${body.slice(0, RENDERER_FREEZE_PAYLOAD_LIMIT)}…`;
  }
  const silent = silentMs == null ? 'n/a' : String(silentMs);
  return `${RENDERER_FREEZE_PREFIX} ${tag} silentMs=${silent} metrics=${JSON.stringify(metrics)} payload=${body}`;
}

/**
 * @param {{ app: object, log: object, getMainWindow: () => object|null }} deps
 */
function createRendererFreezeReporter(deps) {
  const { app, log, getMainWindow } = deps || {};
  /** 最后一次渲染进程心跳时刻；0 表示尚无基准（空闲窗口无法据此判定） */
  let lastBeatAt = 0;

  function currentWebContents() {
    try {
      const win = typeof getMainWindow === 'function' ? getMainWindow() : null;
      if (!win || win.isDestroyed()) return null;
      return win.webContents || null;
    } catch {
      return null;
    }
  }

  /**
   * 落盘一条取证：窗口生命周期事件与渲染侧上报共用同一份现场采集。
   * @returns {string} 写入的日志行（测试/调试可直接读取）
   */
  function reportRendererFreeze(tag, payload) {
    const silentMs = lastBeatAt ? Date.now() - lastBeatAt : null;
    const line = formatRendererFreezeReport(
      tag,
      payload,
      collectRendererProcessMetrics(app, currentWebContents()),
      silentMs
    );
    try {
      if (log && typeof log.error === 'function') log.error(line);
    } catch {
      // 落盘失败不得影响窗口恢复
    }
    return line;
  }

  /** 心跳：只更新时间戳，不落盘 */
  function markRendererBeat() {
    lastBeatAt = Date.now();
  }

  /** 窗口加载/重载后归零：新页面的第一秒不该被算作「很久没心跳」 */
  function resetRendererBeat() {
    lastBeatAt = 0;
  }

  function registerIpc(ipcMain) {
    if (!ipcMain || typeof ipcMain.on !== 'function') return false;
    // 只收主窗口渲染进程的上报：取证日志是证据，不能被其它 webContents 污染
    const fromMainWindow = (event) => {
      const wc = currentWebContents();
      return Boolean(wc) && event.sender === wc;
    };
    ipcMain.on('renderer:freeze-beat', (event) => {
      if (!fromMainWindow(event)) return;
      markRendererBeat();
    });
    ipcMain.on('renderer:freeze-report', (event, payload) => {
      if (!fromMainWindow(event)) return;
      reportRendererFreeze('snapshot', payload);
    });
    return true;
  }

  return {
    registerIpc,
    markRendererBeat,
    resetRendererBeat,
    reportRendererFreeze,
    getLastBeatAt: () => lastBeatAt
  };
}

module.exports = {
  createRendererFreezeReporter,
  collectRendererProcessMetrics,
  formatRendererFreezeReport,
  RENDERER_FREEZE_PREFIX,
  RENDERER_FREEZE_PAYLOAD_LIMIT
};
