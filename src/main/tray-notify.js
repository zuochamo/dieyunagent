'use strict';

const fs = require('fs');
const path = require('path');

const APP_USER_MODEL_ID = 'com.pixeloffice.agent';

/**
 * Windows toast / tray balloon notifications.
 * @param {{
 *   app: import('electron').App,
 *   Notification: typeof import('electron').Notification,
 *   getTray: () => import('electron').Tray | null,
 *   getComputerId: () => string,
 *   showMainWindow: () => void,
 *   log: { info: Function, warn: Function }
 * }} deps
 */
function createTrayNotify(deps) {
  const { app, Notification, getTray, getComputerId, showMainWindow, log } = deps;
  let notificationAppIdReady = false;

  function getTrayIconPath() {
    return path.join(__dirname, '..', '..', 'assets', 'icon.png');
  }

  function ensureWindowsNotificationAppId() {
    if (process.platform !== 'win32' || notificationAppIdReady) return;
    try {
      app.setAppUserModelId(APP_USER_MODEL_ID);
      notificationAppIdReady = true;
    } catch (e) {
      log.warn('setAppUserModelId 失败:', e.message);
    }
  }

  function notifyUpdateTray(title, content, onClick) {
    const tray = getTray();
    const t = String(title || '叠云 Agent').slice(0, 64);
    const body = String(content || t || '').slice(0, 256);

    if (tray) {
      const line = body && body !== t ? `${t} — ${body}` : t;
      tray.setToolTip(`叠云Agent · ${getComputerId()}\n${line}`);
    }

    ensureWindowsNotificationAppId();

    if (Notification.isSupported()) {
      try {
        const opts = { title: t, body };
        const iconPath = getTrayIconPath();
        if (fs.existsSync(iconPath)) opts.icon = iconPath;
        const n = new Notification(opts);
        n.on('click', () => {
          if (typeof onClick === 'function') {
            onClick();
            return;
          }
          showMainWindow();
        });
        n.on('failed', (_event, error) => {
          log.warn('系统通知展示失败:', error);
        });
        n.show();
        return 'notification';
      } catch (e) {
        log.warn('Notification.show 异常:', e.message);
      }
    }

    if (tray && process.platform === 'win32' && typeof tray.displayBalloon === 'function') {
      try {
        const balloonOpts = { title: t, content: body, iconType: 'info' };
        if (typeof onClick === 'function') tray.once('balloon-click', onClick);
        const iconPath = getTrayIconPath();
        if (fs.existsSync(iconPath)) balloonOpts.icon = iconPath;
        tray.displayBalloon(balloonOpts);
        return 'balloon';
      } catch (e) {
        log.warn('displayBalloon 异常:', e.message);
      }
    }

    log.info('[托盘通知]', t, body);
    return 'tooltip-only';
  }

  function notifyScheduledPlanTray(plan, result) {
    const name = (plan && plan.name) || '计划';
    const title = result && result.ok ? `计划完成 · ${name}` : `计划失败 · ${name}`;
    const body =
      result && result.ok
        ? String(result.summary || '执行完成').slice(0, 200)
        : String((result && result.error) || '未知错误').slice(0, 200);
    notifyUpdateTray(title, body);
  }

  return {
    APP_USER_MODEL_ID,
    getTrayIconPath,
    ensureWindowsNotificationAppId,
    notifyUpdateTray,
    notifyScheduledPlanTray
  };
}

module.exports = { createTrayNotify, APP_USER_MODEL_ID };
