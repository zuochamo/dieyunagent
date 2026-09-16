'use strict';

/**
 * Window chrome, app lifecycle, tray, logs, and activity stats IPC.
 *
 * @param {import('../context').MainIpcContext & {
 *   getMainWindow: () => import('electron').BrowserWindow | null,
 *   getAutoLaunchState: () => unknown,
 *   setAutoLaunchEnabled: (enabled?: boolean, opts?: object) => unknown,
 *   getPendingUpdateInfo: () => object | null,
 *   getLastAppUpdateState: () => object | null,
 *   showRestartUpdateDialog: (info: object) => void,
 *   checkForUpdatesNow: () => void,
 *   installPendingUpdate: () => unknown,
 *   notifyUpdateTray: (title: string, content: string) => string,
 *   getStats: () => object,
 *   bumpActivityStats: (patch: object) => void,
 *   resetDailyStats: () => void,
 *   normalizeModelUsageKey: (model: unknown) => string,
 *   usageToActivityPatch: (input: object, modelName: string) => object | null,
 *   logsSources: { fetchAllLogs: Function, cleanLogs: Function },
 *   log: { warn: (msg: string, ...args: unknown[]) => void, transports: { file: { getFile: () => { path: string } } } }
 * }} ctx
 */
function registerAppShellIpc(ctx) {
  const {
    ipcMain,
    app,
    getMainWindow,
    getAutoLaunchState,
    setAutoLaunchEnabled,
    getPendingUpdateInfo,
    getLastAppUpdateState,
    showRestartUpdateDialog,
    checkForUpdatesNow,
    installPendingUpdate,
    notifyUpdateTray,
    getStats,
    bumpActivityStats,
    resetDailyStats,
    normalizeModelUsageKey,
    usageToActivityPatch,
    logsSources,
    log
  } = ctx;

  ipcMain.on('window:minimize', () => {
    const mainWindow = getMainWindow();
    if (mainWindow) mainWindow.minimize();
  });

  ipcMain.on('window:maximize-toggle', () => {
    const mainWindow = getMainWindow();
    if (!mainWindow) return;
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
  });

  ipcMain.on('window:hide', () => {
    const mainWindow = getMainWindow();
    if (mainWindow) mainWindow.hide();
  });

  ipcMain.on('window:set-opacity', (_evt, value) => {
    const mainWindow = getMainWindow();
    if (!mainWindow) return;
    const v = Number(value);
    if (!Number.isFinite(v)) return;
    mainWindow.setOpacity(Math.min(1, Math.max(0.5, v)));
  });

  ipcMain.on('window:set-zoom', (_evt, value) => {
    const mainWindow = getMainWindow();
    if (!mainWindow) return;
    const v = Number(value);
    if (!Number.isFinite(v)) return;
    const factor = Math.min(1.5, Math.max(0.85, v));
    try {
      mainWindow.webContents.setZoomFactor(factor);
    } catch (e) {
      log.warn('界面缩放设置失败:', e.message);
    }
  });

  ipcMain.handle('window:is-maximized', () => {
    const mainWindow = getMainWindow();
    return !!(mainWindow && mainWindow.isMaximized());
  });

  ipcMain.handle('app:get-auto-launch', () => getAutoLaunchState());
  ipcMain.handle('app:set-auto-launch', (_evt, enabled) =>
    setAutoLaunchEnabled(enabled !== false, { silent: true })
  );

  ipcMain.handle('app:check-updates', () => {
    const pendingUpdateInfo = getPendingUpdateInfo();
    if (pendingUpdateInfo) {
      showRestartUpdateDialog(pendingUpdateInfo);
      return { ok: true, pending: true, version: pendingUpdateInfo.version || null };
    }
    checkForUpdatesNow();
    return { ok: true, pending: false, version: app.getVersion() };
  });

  ipcMain.handle('app:get-update-state', () => {
    const pendingUpdateInfo = getPendingUpdateInfo();
    const lastAppUpdateState = getLastAppUpdateState();
    return {
      currentVersion: app.getVersion(),
      pending: !!pendingUpdateInfo,
      version: pendingUpdateInfo && pendingUpdateInfo.version ? pendingUpdateInfo.version : null,
      ...(lastAppUpdateState || {})
    };
  });

  ipcMain.handle('app:install-update', () => installPendingUpdate());
  ipcMain.handle('app:get-version', () => app.getVersion());

  ipcMain.handle('tray:notify', (_evt, payload) => {
    const title = (payload && payload.title) || '叠云 Agent';
    const content = (payload && payload.content) || '';
    const channel = notifyUpdateTray(title, content);
    return { ok: true, channel };
  });

  ipcMain.handle('logs:fetch-all', (_evt, opts) => {
    const userData = app.getPath('userData');
    let mainLogPath = '';
    try {
      mainLogPath = log.transports.file.getFile().path;
    } catch {
      mainLogPath = '';
    }
    return logsSources.fetchAllLogs(userData, { ...(opts || {}), mainLogPath });
  });

  ipcMain.handle('logs:clean', (_evt, opts) => {
    const userData = app.getPath('userData');
    let mainLogPath = '';
    try {
      mainLogPath = log.transports.file.getFile().path;
    } catch {
      mainLogPath = '';
    }
    return logsSources.cleanLogs(userData, { ...(opts || {}), mainLogPath });
  });

  ipcMain.handle('stats:add-tokens', (_evt, payload) => {
    const stats = getStats();
    const input = payload && typeof payload === 'object' ? payload : { totalTokens: payload };
    const modelName = normalizeModelUsageKey(input.model || input.modelId || input.model_id);
    let patch = usageToActivityPatch(input, modelName);
    if (patch && modelName && !Object.keys(patch.modelUsage || {}).length) {
      const total = patch.tokensToday || 0;
      if (total > 0) patch = { ...patch, modelUsage: { [modelName]: total } };
    }
    if (patch) {
      resetDailyStats();
      bumpActivityStats(patch);
    }
    return {
      tokensToday: stats.tokensToday,
      promptTokensToday: stats.promptTokensToday,
      completionTokensToday: stats.completionTokensToday,
      cachedTokensToday: stats.cachedTokensToday,
      modelUsageToday: stats.modelUsageToday,
      modelUsageMonth: stats.modelUsageMonth
    };
  });
}

module.exports = { registerAppShellIpc };
