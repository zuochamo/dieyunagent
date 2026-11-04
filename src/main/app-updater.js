'use strict';

const path = require('path');
const { launchUpdateBootstrap } = require('../update-bootstrap/launch');
const {
  getSelfNoNewPrivs,
  installDebInCleanTree,
  manualInstallCommand,
  resolveSystemdRun,
  relaunchInCleanTree
} = require('./linux-deb-install');

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
  /**
   * 上一次自动安装失败的原因（重启后消失）。失败后 `pendingUpdateInfo` 仍然在，
   * 于是定时检查会一直走「已下载，跳过」——没有这条记录，用户就永远看不到失败原因。
   * @type {{ message: string, debPath: string|null, command: string, at: number } | null}
   */
  let lastInstallError = null;
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
      // 上次安装已经失败过：继续报同一个错（带手动安装命令），不要退回「已下载，可安装」
      // 把失败咽掉——那正是现场「一直更新失败但看不到原因」的形态。
      if (lastInstallError) {
        sendUpdateUiState(installErrorState(lastInstallError));
        return;
      }
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

  /** 失败态的 UI 快照（含可照抄的手动安装命令）。 */
  function installErrorState(err) {
    const message = err && err.message ? err.message : '更新安装失败';
    return {
      phase: 'error',
      message: err && err.command ? `${message}；可手动安装：${err.command}` : message,
      manualCommand: (err && err.command) || null,
      installerPath: (err && err.debPath) || null,
      percent: null
    };
  }

  /**
   * 记下安装失败：必须让用户看见原因与出口（`sudo dpkg -i <包>`）。
   * @param {string} message
   * @param {string|null} [debPath]
   */
  function failInstall(message, debPath) {
    const command = debPath ? manualInstallCommand(debPath) : '';
    lastInstallError = { message, debPath: debPath || null, command, at: Date.now() };
    log.error('自动更新安装失败:', message);
    if (command) log.error('可手动安装:', command);
    sendUpdateUiState(installErrorState(lastInstallError));
  }

  /**
   * Linux（deb）的安装：**不在本进程里提权**。
   *
   * electron-updater 的 DebUpdater 用 `pkexec → dpkg` 提权，但一旦本进程带
   * `NoNewPrivs=1`，内核不再认 setuid 位，pkexec 直接退 127（`must be setuid root`），
   * sudo 也一样——而 NNP 无法撤销。所以这里改让 systemd 用户实例另起一棵干净进程树去
   * 提权（见 linux-deb-install.js 顶部实测记录）。
   *
   * 没有 systemd 用户实例时按旧行为分流：NNP=0 才让 electron-updater 自己装；
   * NNP=1 则直接给出失败原因与手动命令，不去撞一次必定失败的 pkexec。
   *
   * Windows 那套引导脚本依赖 powershell.exe / explorer.exe，在 Linux 上必然失败，
   * 所以按平台分流，而不是让它先抛错再兜底。
   */
  function installOnLinux() {
    const debPath = getPendingInstallerPath();
    if (!debPath) {
      failInstall('找不到已下载的安装包');
      return false;
    }
    // 只有 deb 需要 root；AppImage 是自己覆盖文件，和提权无关，走下面的旧路径。
    const isDeb = /\.deb$/i.test(debPath);
    if (isDeb && resolveSystemdRun()) {
      // 异步：提权要等用户在 polkit 窗里输密码（可达数十秒），同步等会把窗口和 IPC 一起冻住。
      // 这里返回 true 只表示「已受理」，最终结果通过 UI 状态（installing → error / 重启）告知。
      void installDebInCleanTree({ debPath })
        .then(async (r) => {
          if (!r.ok) {
            const reason = r.stderr || r.error || `退出码 ${r.exitCode}`;
            failInstall(`自动安装失败（${reason}）`, debPath);
            return;
          }
          log.info('deb 安装完成，正在用独立进程树重启应用');
          const relaunch = await relaunchInCleanTree({ exePath: process.execPath });
          if (!relaunch.ok) {
            // 重启没拉起来就别退出：退出后用户面对的是一台「应用消失、更新没生效」的机器。
            failInstall(`安装已完成，但自动重启失败；可手动启动：${relaunch.command}`, debPath);
            return;
          }
          app.isQuitting = true;
          setTimeout(() => {
            try {
              app.quit();
            } catch {
              process.exit(0);
            }
          }, 800);
        })
        .catch((err) => {
          failInstall((err && (err.message || String(err))) || '更新安装失败', debPath);
        });
      return true;
    }
    if (isDeb && getSelfNoNewPrivs() === 1) {
      failInstall(
        '本进程 NoNewPrivs=1（pkexec/sudo 无法提权），且没有可用的 systemd 用户实例',
        debPath
      );
      return false;
    }
    try {
      autoUpdater.quitAndInstall(false, true);
      return true;
    } catch (err) {
      failInstall((err && (err.message || String(err))) || '更新安装失败', debPath);
      return false;
    }
  }

  function installPendingUpdate() {
    if (!pendingUpdateInfo) return false;
    if (process.platform === 'linux') {
      sendUpdateUiState({
        phase: 'installing',
        version: pendingUpdateInfo.version || null,
        message: '正在启动安装程序…',
        percent: null
      });
      return installOnLinux();
    }
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
    // Linux 上安装由 installOnLinux 自己负责（deb 走独立进程树提权）。留 true 的话退出时
    // electron-updater 还会在**本进程**再调一次 pkexec，命中 NNP 就又是一次静默 127。
    autoUpdater.autoInstallOnAppQuit = process.platform !== 'linux';
    autoUpdater.allowDowngrade = false;

    const feedUrl = getActiveUpdateFeedUrl();
    autoUpdater.setFeedURL({ provider: 'generic', url: feedUrl });
    log.info('自动更新源:', feedUrl, `(候选 ${candidates().length} 个，内网优先)`);
    if (process.platform === 'linux') {
      const nnp = getSelfNoNewPrivs();
      log.info(
        `NoNewPrivs=${nnp === null ? '未知' : nnp}，deb 安装方式: ${
          resolveSystemdRun() ? 'systemd 独立进程树 + pkexec' : '进程内 pkexec（electron-updater）'
        }`
      );
    }

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
      lastInstallError = null;
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
