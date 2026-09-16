'use strict';

const fs = require('fs');
const path = require('path');

/** 开机登录启动时传入，仅后台托盘不弹窗（兼容旧版 --hidden） */
const LOGIN_LAUNCH_ARGS = ['--open-at-login', '--hidden'];

/**
 * @param {{
 *   app: import('electron').App,
 *   dialog: import('electron').Dialog,
 *   log: { info: Function, warn: Function, error: Function },
 *   getMainWindow: () => import('electron').BrowserWindow | null,
 *   refreshTrayContextMenu: () => void
 * }} deps
 */
function createAutoLaunch(deps) {
  const { app, dialog, log, getMainWindow, refreshTrayContextMenu } = deps;

  function isLoginItemLaunch() {
    return LOGIN_LAUNCH_ARGS.some((flag) => process.argv.includes(flag));
  }

  function getLoginItemExePath() {
    return app.isPackaged ? app.getPath('exe') : process.execPath;
  }

  /** @returns {string[][]} 历史版本可能写入的启动参数组合，清理时全部移除 */
  function loginItemArgsVariants() {
    return [['--open-at-login', '--hidden'], ['--open-at-login'], ['--hidden'], []];
  }

  function clearAllLoginItems() {
    try {
      app.setLoginItemSettings({ openAtLogin: false });
    } catch {
      // ignore
    }
    if (!app.isPackaged) return;
    const exePath = getLoginItemExePath();
    for (const args of loginItemArgsVariants()) {
      try {
        app.setLoginItemSettings({ openAtLogin: false, path: exePath, args });
      } catch {
        // ignore
      }
    }
  }

  function isAutoLaunchEnabled() {
    if (!app.isPackaged) return false;
    if (app.getLoginItemSettings().openAtLogin) return true;
    const exePath = getLoginItemExePath();
    return loginItemArgsVariants().some((args) => app.getLoginItemSettings({ path: exePath, args }).openAtLogin);
  }

  function applyAutoLaunchRegistration(enabled) {
    const exePath = getLoginItemExePath();
    clearAllLoginItems();
    if (enabled) {
      app.setLoginItemSettings({
        openAtLogin: true,
        path: exePath,
        args: ['--open-at-login', '--hidden']
      });
    }
  }

  function autoLaunchPrefsPath() {
    return path.join(app.getPath('userData'), 'auto-launch-prefs.json');
  }

  function loadAutoLaunchPrefs() {
    try {
      const raw = JSON.parse(fs.readFileSync(autoLaunchPrefsPath(), 'utf8'));
      return { userOptOut: raw.userOptOut === true };
    } catch {
      return { userOptOut: false };
    }
  }

  function saveAutoLaunchPrefs(prefs) {
    try {
      fs.mkdirSync(path.dirname(autoLaunchPrefsPath()), { recursive: true });
      fs.writeFileSync(autoLaunchPrefsPath(), JSON.stringify(prefs), 'utf8');
    } catch (err) {
      log.warn('保存开机自启偏好失败:', err);
    }
  }

  function hasUserOptedOutAutoLaunch() {
    return loadAutoLaunchPrefs().userOptOut === true;
  }

  function getAutoLaunchState() {
    return {
      available: app.isPackaged,
      enabled: app.isPackaged ? isAutoLaunchEnabled() : false,
      userOptOut: hasUserOptedOutAutoLaunch()
    };
  }

  function notifyAutoLaunchStateChanged() {
    const mainWindow = getMainWindow();
    if (!mainWindow || mainWindow.isDestroyed()) return;
    try {
      mainWindow.webContents.send('app:auto-launch-changed', getAutoLaunchState());
    } catch {
      // ignore
    }
  }

  function migrateAutoLaunchRegistration() {
    if (!app.isPackaged) return;
    const enabled = isAutoLaunchEnabled();
    applyAutoLaunchRegistration(enabled);
    if (enabled) log.info('开机自启注册表已整理为单一条目');
  }

  /** 每次启动检测；未开启则自动开启（仅安装版，用户未主动关闭时） */
  function ensureAutoLaunchEnabled() {
    if (!app.isPackaged) return;
    if (hasUserOptedOutAutoLaunch()) return;
    try {
      if (!isAutoLaunchEnabled()) {
        applyAutoLaunchRegistration(true);
        if (isAutoLaunchEnabled()) {
          log.info('检测到未开启开机自启，已自动开启');
          refreshTrayContextMenu();
        } else {
          log.warn('尝试自动开启开机自启后仍未生效，请检查系统权限或安装路径');
        }
      }
    } catch (err) {
      log.error('自动开启开机自启失败:', err);
    }
  }

  function setAutoLaunchEnabled(enabled, opts = {}) {
    const { silent = false } = opts;
    if (!app.isPackaged) {
      if (!silent) {
        dialog.showMessageBoxSync({
          type: 'info',
          title: '叠云 Agent',
          message: '开机自启仅支持安装版',
          detail: '开发模式下无法设置开机自启，请使用安装包安装后再试。'
        });
      }
      return { ok: false, ...getAutoLaunchState() };
    }
    const exePath = getLoginItemExePath();
    try {
      applyAutoLaunchRegistration(enabled);
      saveAutoLaunchPrefs({ userOptOut: !enabled });
      log.info('开机自启:', enabled ? '已开启' : '已关闭', exePath);
      refreshTrayContextMenu();
      notifyAutoLaunchStateChanged();
      return { ok: true, ...getAutoLaunchState() };
    } catch (err) {
      log.error('设置开机自启失败:', err);
      if (!silent) {
        dialog.showErrorBox('开机自启', err && err.message ? err.message : String(err));
      }
      return { ok: false, ...getAutoLaunchState() };
    }
  }

  function toggleAutoLaunch() {
    setAutoLaunchEnabled(!isAutoLaunchEnabled());
  }

  return {
    isLoginItemLaunch,
    isAutoLaunchEnabled,
    getAutoLaunchState,
    setAutoLaunchEnabled,
    toggleAutoLaunch,
    migrateAutoLaunchRegistration,
    ensureAutoLaunchEnabled
  };
}

module.exports = { createAutoLaunch, LOGIN_LAUNCH_ARGS };
