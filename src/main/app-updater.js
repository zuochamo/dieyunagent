'use strict';

const path = require('path');
const { launchUpdateBootstrap } = require('../update-bootstrap/launch');

function normalizeUpdateFeedUrl(url) {
  const u = String(url || '').trim();
  return u.endsWith('/') ? u : u + '/';
}

function getUpdateFeedCandidates(primaryUrl, fallbackUrl) {
  const primary = normalizeUpdateFeedUrl(primaryUrl);
  const fallback = normalizeUpdateFeedUrl(fallbackUrl);
  const list = [primary];
  if (fallback && fallback !== primary) list.push(fallback);
  return list;
}

/**
 * electron-updater wiring (feed fallback, UI state, bootstrap install).
 * @param {object} deps
 */
function createAppUpdater(deps) {
  const {
    app,
    autoUpdater,
    BrowserWindow,
    log,
    getUpdateConfig,
    refreshTrayContextMenu,
    notifyUpdateTray
  } = deps;

  let activeUpdateFeedIndex = 0;
  let updateCheckTimer = null;
  let updateRetryTimer = null;
  let updateProgressBucket = -1;
  /** @type {import('electron-updater').UpdateInfo | null} */
  let pendingUpdateInfo = null;
  /** @type {Record<string, unknown> | null} */
  let lastAppUpdateState = null;

  function cfg() {
    return getUpdateConfig() || {};
  }

  function candidates() {
    const c = cfg();
    return getUpdateFeedCandidates(c.UPDATE_URL, c.UPDATE_URL_FALLBACK);
  }

  function getActiveUpdateFeedUrl() {
    const feeds = candidates();
    return feeds[Math.min(activeUpdateFeedIndex, feeds.length - 1)] || feeds[0];
  }

  function switchToFallbackUpdateFeed() {
    const feeds = candidates();
    if (activeUpdateFeedIndex >= feeds.length - 1) return false;
    activeUpdateFeedIndex += 1;
    autoUpdater.setFeedURL({ provider: 'generic', url: getActiveUpdateFeedUrl() });
    log.info('切换备用更新源:', getActiveUpdateFeedUrl());
    return true;
  }

  function clearUpdateRetryTimer() {
    if (updateRetryTimer) {
      clearTimeout(updateRetryTimer);
      updateRetryTimer = null;
    }
  }

  function disposeTimers() {
    if (updateCheckTimer) {
      clearInterval(updateCheckTimer);
      updateCheckTimer = null;
    }
    clearUpdateRetryTimer();
  }

  function scheduleUpdateRetry() {
    if (!app.isPackaged) return;
    clearUpdateRetryTimer();
    const retryMin = Math.max(1, Number(cfg().UPDATE_RETRY_MIN) || 15);
    const ms = retryMin * 60 * 1000;
    updateRetryTimer = setTimeout(() => {
      updateRetryTimer = null;
      checkForUpdatesNow();
    }, ms);
    log.info(`将在 ${retryMin} 分钟后重试检查更新`);
  }

  function broadcastAppUpdateState(payload) {
    const data = { ...payload, at: Date.now() };
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed()) continue;
      try {
        win.webContents.send('app:update-state', data);
      } catch {
        // ignore
      }
    }
  }

  function sendUpdateUiState(patch) {
    lastAppUpdateState = {
      currentVersion: app.getVersion(),
      ...(lastAppUpdateState || {}),
      ...patch,
      at: Date.now()
    };
    broadcastAppUpdateState(lastAppUpdateState);
  }

  function checkForUpdatesNow() {
    if (!app.isPackaged) {
      log.info('开发模式，跳过更新检查');
      return;
    }
    if (pendingUpdateInfo) {
      log.info('更新安装包已下载，跳过本次更新检查');
      sendUpdateUiState({
        phase: 'ready',
        version: pendingUpdateInfo.version || null,
        message: pendingUpdateInfo.version
          ? `新版本 v${pendingUpdateInfo.version} 已下载，可安装并重启`
          : '更新包已下载，可安装并重启',
        percent: 100
      });
      return;
    }
    autoUpdater.checkForUpdates().catch((err) => {
      log.error('检查更新失败:', err && (err.message || err));
      if (switchToFallbackUpdateFeed()) {
        log.info('将使用备用源重试检查更新');
        autoUpdater.checkForUpdates().catch((err2) => {
          log.error('备用源检查更新失败:', err2 && (err2.message || err2));
          scheduleUpdateRetry();
        });
        return;
      }
      scheduleUpdateRetry();
    });
  }

  function getPendingInstallerPath() {
    try {
      if (typeof autoUpdater.installerPath === 'string' && autoUpdater.installerPath) {
        return autoUpdater.installerPath;
      }
      if (autoUpdater.downloadedUpdateHelper && autoUpdater.downloadedUpdateHelper.file) {
        return autoUpdater.downloadedUpdateHelper.file;
      }
    } catch {
      // ignore
    }
    return null;
  }

  function showRestartUpdateDialog(info) {
    pendingUpdateInfo = info || pendingUpdateInfo;
    refreshTrayContextMenu();
    const ver = pendingUpdateInfo && pendingUpdateInfo.version ? pendingUpdateInfo.version : '';
    log.info('更新已下载', ver ? `v${ver}` : '', '，等待用户确认安装');
    sendUpdateUiState({
      phase: 'ready',
      version: ver,
      message: ver ? `新版本 v${ver} 已下载，可安装并重启` : '更新包已下载，可安装并重启',
      percent: 100
    });
    notifyUpdateTray(
      '叠云 Agent',
      ver ? `新版本 v${ver} 已就绪，点击安装` : '更新已下载，点击安装',
      () => installPendingUpdate()
    );
  }

  function installPendingUpdate() {
    if (!pendingUpdateInfo) return false;
    const installerPath = getPendingInstallerPath();
    if (!installerPath) {
      sendUpdateUiState({ phase: 'error', message: '找不到已下载的安装包' });
      return false;
    }
    sendUpdateUiState({
      phase: 'installing',
      version: pendingUpdateInfo.version || null,
      message: '正在启动安装程序…',
      percent: null
    });
    try {
      autoUpdater.autoInstallOnAppQuit = false;
      launchUpdateBootstrap({
        installerPath,
        version: pendingUpdateInfo.version || '',
        fromVersion: app.getVersion(),
        installDir: path.dirname(process.execPath)
      });
    } catch (err) {
      log.error('启动安装引导失败，尝试 quitAndInstall:', err && (err.message || err));
      try {
        autoUpdater.quitAndInstall(false, true);
        return true;
      } catch (err2) {
        sendUpdateUiState({
          phase: 'error',
          message: err && (err.message || String(err))
        });
        return false;
      }
    }
    app.isQuitting = true;
    setTimeout(() => {
      try {
        app.quit();
      } catch {
        try {
          app.exit(0);
        } catch {
          process.exit(0);
        }
      }
    }, 800);
    return true;
  }

  function startPeriodicUpdateChecks() {
    if (!app.isPackaged) return;
    if (updateCheckTimer) clearInterval(updateCheckTimer);
    const intervalMin = Math.max(15, Number(cfg().UPDATE_CHECK_INTERVAL_MIN) || 20);
    const ms = intervalMin * 60 * 1000;
    updateCheckTimer = setInterval(checkForUpdatesNow, ms);
    log.info(`已启用定时更新检查，间隔 ${intervalMin} 分钟`);
  }

  function setupAutoUpdater() {
    autoUpdater.logger = log;
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.allowDowngrade = false;

    const feedUrl = getActiveUpdateFeedUrl();
    autoUpdater.setFeedURL({ provider: 'generic', url: feedUrl });
    log.info('自动更新源:', feedUrl, `(候选 ${candidates().length} 个，内网优先)`);

    autoUpdater.on('checking-for-update', () => {
      log.info('检查更新中...');
      sendUpdateUiState({ phase: 'checking', message: '正在检查更新…', percent: null });
    });

    autoUpdater.on('update-available', (info) => {
      clearUpdateRetryTimer();
      updateProgressBucket = -1;
      const ver = info && info.version ? info.version : '未知';
      log.info('发现新版本:', ver, '，正在自动下载');
      sendUpdateUiState({
        phase: 'downloading',
        version: ver,
        message: `正在下载 v${ver}…`,
        percent: 0,
        transferred: 0,
        total: 0
      });
    });

    autoUpdater.on('update-not-available', () => {
      clearUpdateRetryTimer();
      log.info('已是最新版本:', app.getVersion());
      sendUpdateUiState({ phase: 'idle', message: '已是最新版本' });
    });

    autoUpdater.on('download-progress', (progress) => {
      const pct = progress && Number.isFinite(progress.percent) ? progress.percent : 0;
      const transferred = progress && progress.transferred;
      const total = progress && progress.total;
      const bucket = Math.min(10, Math.floor(pct / 10));
      if (bucket !== updateProgressBucket) {
        updateProgressBucket = bucket;
        log.info(`更新下载进度: ${pct.toFixed(1)}%`);
      }
      sendUpdateUiState({
        phase: 'downloading',
        percent: pct,
        transferred: transferred || 0,
        total: total || 0,
        message: '正在下载更新…'
      });
    });

    autoUpdater.on('update-downloaded', (info) => {
      clearUpdateRetryTimer();
      pendingUpdateInfo = info;
      showRestartUpdateDialog(info);
    });

    autoUpdater.on('error', (err) => {
      const msg = err && (err.message || String(err));
      log.error('自动更新错误:', msg);
      sendUpdateUiState({ phase: 'error', message: msg || '更新失败' });
      if (switchToFallbackUpdateFeed()) {
        checkForUpdatesNow();
        return;
      }
      scheduleUpdateRetry();
    });

    if (!app.isPackaged) {
      log.info('开发模式，跳过自动更新检查');
      return;
    }

    const delaySec = Math.max(0, Number(cfg().UPDATE_CHECK_DELAY_SEC) || 0);
    const delayMs = delaySec * 1000;
    const runInitialCheck = () => {
      log.info(delayMs > 0 ? `启动 ${delaySec} 秒后检查更新` : '启动后立即检查更新');
      checkForUpdatesNow();
      startPeriodicUpdateChecks();
    };
    if (delayMs > 0) setTimeout(runInitialCheck, delayMs);
    else runInitialCheck();
  }

  return {
    checkForUpdatesNow,
    installPendingUpdate,
    showRestartUpdateDialog,
    setupAutoUpdater,
    disposeTimers,
    getPendingUpdateInfo: () => pendingUpdateInfo,
    getLastAppUpdateState: () => lastAppUpdateState,
    getActiveUpdateFeedUrl
  };
}

module.exports = {
  createAppUpdater,
  normalizeUpdateFeedUrl,
  getUpdateFeedCandidates
};
