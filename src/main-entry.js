/** Electron main: window/tray/lifecycle. New IPC goes in src/main/ipc/ (see src/main/register-ipc.js). */
const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  ipcMain,
  nativeImage,
  dialog,
  Notification,
  safeStorage,
  session,
  clipboard
} = require('electron');
const path = require('path');
const { getDeployConfig, getDeployUiDefaults } = require('./deploy-config');
const {
  getMonitorServerCandidates,
  loadAppConfig
} = require('./main/app-config');
const net = require('net');
const { usageToActivityPatch } = require('./llm-usage-stats');
const { setLlmUsageRecorder } = require('./agent/llm-usage-recorder');
const { ensureAgentHomeDirs, createUserSkill, dieyunHome } = require('./agent-home');
const { migrateAppDataSkills, migrateWorkspaceSkills } = require('./skills/seed-to-dieyun');
const { LocalGateway } = require('./gateway/server');
const { createCoreBridge } = require('./core-bridge');
const { resolveDieyunCoreBinary, isRustCoreEnabled } = require('./core-bridge-path');
const { createStatusOutbox } = require('./monitor/status-outbox');
const { createBrowserService } = require('./browser/service');
const { autoUpdater } = require('electron-updater');
const log = require('electron-log');
const QRCode = require('qrcode');
const logsSources = require('./logs-sources');
const { createGatewayFileLogger } = require('./gateway-file-log');
const { ensurePlanSession } = require('./plans/plan-session');
const { parsePlanFromText } = require('./plans/parser');
const {
  ensureDieyunMdInHome,
  loadDieyunInstructions,
  openDieyunMdInEditor,
  formatDieyunBlock
} = require('./dieyun-instructions');
const { fetchOpenAiModelList } = require('./openai-models');
const { createMcpStore } = require('./mcp/store');
const {
  bootMcpSkillCatalogs,
  bootPlansRuntime,
  createPlansCreateFromText
} = require('./main/mcp-plans-boot');
const { AgentRunCoordinator } = require('./agent/coordinator');
const { AgentService } = require('./agent/service');
const { MobileBridge } = require('./mobile/bridge');
const subagentStore = require('./agent/subagent-store');
const worktreeService = require('./git/worktree-service');
const { createTrayNotify } = require('./main/tray-notify');
const { createAppUpdater } = require('./main/app-updater');
const { createActivityStats } = require('./main/activity-stats');
const { createAutoLaunch } = require('./main/auto-launch');
const { createWorkplaceMonitor } = require('./main/workplace-monitor');
const { createWindowTray } = require('./main/window-tray');
const { createRemoteGatewayRuntime } = require('./main/remote-gateway');
const { bootWorkspaceRemoteRuntime } = require('./main/workspace-remote-runtime');
const { createSshReconnect } = require('./ssh/reconnect');
const { loadModelSettings, saveModelSettings } = require('./model-settings');
const { createMainToolBridge } = require('./agent/tool-bridge-main');
const { clearToolHarnessSessionsForSession } = require('./agent/tool-harness');
const { registerRendererToolDelegateIpc } = require('./agent/renderer-tool-delegate');
const { createMainCompactionAgent, getEffectiveInputBudget } = require('./agent/compaction-main');
const { killActiveShellChildren } = require('./gateway/host-control');
const { registerEarlyMainIpc, registerMainIpc, registerLateMainIpc } = require('./main/register-ipc');
const { registerAgentRuntimeIpc } = require('./main/ipc/agent-runtime');
const { registerCompactionIpc } = require('./main/ipc/compaction');
const { invalidateRemoteAgentClient } = require('./gateway/remote-agent-client');
const { createTerminalPool } = require('./terminal/terminal-pool');

log.transports.file.level = 'info';
log.transports.file.maxSize = 5 * 1024 * 1024;
log.info('应用启动中...');

// 兜底开关：遇到 GPU 花屏（其他窗口像素混入）时可用 DIEYUN_DISABLE_GPU=1 规避
if (process.env.DIEYUN_DISABLE_GPU === '1') {
  log.info('DIEYUN_DISABLE_GPU=1：禁用硬件加速');
  app.disableHardwareAcceleration();
}

const mcpStore = createMcpStore({ safeStorage });


/** Windows 命名管道：弥补 requestSingleInstanceLock 在带启动参数时偶发失效 */
const SINGLE_INSTANCE_PIPE = '\\\\.\\pipe\\com.pixeloffice.dieyunagent';

function notifyRunningInstanceAndExit() {
  if (process.platform !== 'win32') {
    app.exit(0);
    return;
  }
  const client = net.connect(SINGLE_INSTANCE_PIPE, () => {
    client.write('show');
    client.end();
    setImmediate(() => process.exit(0));
  });
  client.setTimeout(1500, () => {
    try {
      client.destroy();
    } catch {
      // ignore
    }
    process.exit(0);
  });
  client.on('error', () => process.exit(0));
}

const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  notifyRunningInstanceAndExit();
} else {
  app.on('second-instance', (_event, argv) => {
    log.info('second-instance', argv && argv.length ? argv.join(' ') : '');
    if (windowTray) windowTray.showMainWindow();
  });
  app.on('will-finish-launching', () => {
    if (app.isPackaged && autoLaunch) autoLaunch.migrateAutoLaunchRegistration();
  });
}

function bindSingleInstancePipe() {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') {
      resolve('primary');
      return;
    }

    let decided = false;
    const finish = (role) => {
      if (decided) return;
      decided = true;
      resolve(role);
    };

    const startPrimaryServer = () => {
      const server = net.createServer((socket) => {
        socket.on('data', () => {
          if (windowTray) windowTray.showMainWindow();
        });
      });
      server.once('error', (err) => {
        if (err && (err.code === 'EADDRINUSE' || err.code === 'EACCES')) {
          finish('duplicate');
        } else {
          log.warn('单实例管道异常:', err && err.message);
          finish('primary');
        }
      });
      server.listen(SINGLE_INSTANCE_PIPE, () => {
        log.info('单实例管道已就绪');
        finish('primary');
      });
    };

    // 先尝试连接：已有实例在跑则当前进程立即退出，避免开机多条启动项同时 listen 竞态
    const client = net.connect(SINGLE_INSTANCE_PIPE);
    client.setTimeout(600, () => {
      client.destroy();
      startPrimaryServer();
    });
    client.once('connect', () => {
      try {
        client.write('show');
        client.end();
      } catch {
        // ignore
      }
      finish('duplicate');
    });
    client.once('error', () => {
      startPrimaryServer();
    });
  });
}

const deployCfg = getDeployConfig();
const CONFIG = loadAppConfig({ deployCfg });

/** @type {import('./gateway/server').LocalGateway | null} */
let localGateway = null;
/** @type {ReturnType<createCoreBridge> | null} */
let coreBridge = null;
/** @type {Map<string, { runId: string | null, aborted: boolean }>} */
const rustLoopCancels = new Map();
const plannerRunCancels = new Map();
/** 已取消的 cancelToken：防止 waitForAgentAbortable 孤儿续跑复用同一 token 再启 loop */
const abortedAgentCancelTokens = new Set();
/** @type {ReturnType<createMainCompactionAgent> | null} */
let mainCompactionAgent = null;
let sshSessionManager = null;
/** @type {object | null} */
let sshConnectionPool = null;
/** @type {object | null} */
let remoteGatewayPool = null;
let sshCredentialsStore = null;
/** @type {object | null} */
let sessionRemoteTransport = null;
/** @type {object | null} */
let portForwardManager = null;
/** @type {object | null} */
let terminalSession = null;
/** @type {ReturnType<createTerminalPool> | null} */
let terminalPool = null;
let agentCoordinator = null;
/** @type {object | null} */
let mcpRuntime = null;
let mcpCatalog = null;
let skillCatalog = null;
/** @type {import('./agent/service').AgentService | null} */
let agentService = null;
/** @type {import('./mobile/bridge').MobileBridge | null} */
let mobileBridge = null;
/** @type {ReturnType<createBrowserService> | null} */
let browserService = null;
let windowTray = null;
let autoLaunch = null;

const remoteGatewayRuntime = createRemoteGatewayRuntime({
  app,
  log,
  getLocalGateway: () => localGateway,
  getSshConnectionPool: () => sshConnectionPool,
  getRemoteGatewayPool: () => remoteGatewayPool,
  getSessionRemoteTransport: () => sessionRemoteTransport,
  invalidateRemoteAgentClient,
  broadcastToRenderers: (channel, payload) => broadcastToRenderers(channel, payload)
});
const sshReconnect = createSshReconnect({
  log,
  getLocalGateway: () => localGateway,
  getSshSessionManager: () => sshSessionManager,
  getSshCredentialsStore: () => sshCredentialsStore,
  getSshConnectionPool: () => sshConnectionPool,
  getSessionRemoteTransport: () => sessionRemoteTransport,
  invalidateRemoteAgentClient,
  ensureRemoteGatewayForCurrentWorkspace: () =>
    remoteGatewayRuntime.ensureRemoteGatewayForCurrentWorkspace(),
  getActiveRemoteGatewayInfo: () => remoteGatewayRuntime.getActiveRemoteGatewayInfo(),
  broadcastToRenderers: (channel, payload) => broadcastToRenderers(channel, payload)
});

function broadcastToRenderers(channel, payload) {
  for (const win of BrowserWindow.getAllWindows()) {
    safeWebContentsSend(win && win.webContents, channel, payload);
  }
}

function canSendToWebContents(webContents) {
  if (!webContents || typeof webContents.isDestroyed !== 'function' || webContents.isDestroyed()) {
    return false;
  }
  try {
    const frame = webContents.mainFrame;
    if (frame && typeof frame.isDestroyed === 'function' && frame.isDestroyed()) {
      return false;
    }
  } catch {
    return false;
  }
  return true;
}

function safeWebContentsSend(webContents, channel, payload) {
  if (!canSendToWebContents(webContents)) return false;
  try {
    webContents.send(channel, payload);
    return true;
  } catch {
    return false;
  }
}

let readableDirPath = '';
/** @type {object | null} */
let plansStore = null;
/** @type {object | null} */
let plansScheduler = null;


const earlyIpcCtx = {
  ipcMain,
  app,
  dialog,
  getDeployUiDefaults,
  loadDieyunInstructions,
  openDieyunMdInEditor,
  formatDieyunBlock
};
registerEarlyMainIpc(earlyIpcCtx);

const activityStats = createActivityStats({
  getUserDataPath: () => app.getPath('userData'),
  log,
  onChanged: () => {
    if (windowTray) windowTray.pushStatus();
  }
});

const workplaceMonitor = createWorkplaceMonitor({
  app,
  log,
  createStatusOutbox,
  getComputerId: () => CONFIG.COMPUTER_ID,
  getAppVersion: () => app.getVersion(),
  getMonitorServerCandidates: () => getMonitorServerCandidates({ deployCfg: getDeployConfig() }),
  getStats: () => activityStats.getStats(),
  resetDailyStats: () => activityStats.resetDailyStats(),
  bumpActivityStats: (patch) => activityStats.bumpActivityStats(patch),
  getTray: () => (windowTray ? windowTray.getTray() : null),
  pushStatus: () => {
    if (windowTray) windowTray.pushStatus();
  }
});

autoLaunch = createAutoLaunch({
  app,
  dialog,
  log,
  getMainWindow: () => (windowTray ? windowTray.getMainWindow() : null),
  refreshTrayContextMenu: () => {
    if (windowTray) windowTray.refreshTrayContextMenu();
  }
});

const trayNotify = createTrayNotify({
  app,
  Notification,
  getTray: () => (windowTray ? windowTray.getTray() : null),
  getComputerId: () => CONFIG.COMPUTER_ID,
  showMainWindow: () => {
    if (windowTray) windowTray.showMainWindow();
  },
  log
});

const appUpdater = createAppUpdater({
  app,
  autoUpdater,
  BrowserWindow,
  log,
  getUpdateConfig: () => ({
    UPDATE_URL: CONFIG.UPDATE_URL,
    UPDATE_URL_FALLBACK: CONFIG.UPDATE_URL_FALLBACK,
    UPDATE_CHECK_DELAY_SEC: CONFIG.UPDATE_CHECK_DELAY_SEC,
    UPDATE_CHECK_INTERVAL_MIN: CONFIG.UPDATE_CHECK_INTERVAL_MIN,
    UPDATE_RETRY_MIN: CONFIG.UPDATE_RETRY_MIN
  }),
  refreshTrayContextMenu: () => {
    if (windowTray) windowTray.refreshTrayContextMenu();
  },
  notifyUpdateTray: (title, content, onClick) => trayNotify.notifyUpdateTray(title, content, onClick)
});

windowTray = createWindowTray({
  app,
  BrowserWindow,
  Tray,
  Menu,
  nativeImage,
  log,
  getComputerId: () => CONFIG.COMPUTER_ID,
  isLoginItemLaunch: () => autoLaunch.isLoginItemLaunch(),
  isAutoLaunchEnabled: () => autoLaunch.isAutoLaunchEnabled(),
  toggleAutoLaunch: () => autoLaunch.toggleAutoLaunch(),
  getAppUpdater: () => appUpdater,
  getBrowserService: () => browserService,
  canSendToWebContents,
  safeWebContentsSend,
  isMonitorRegistered: () => workplaceMonitor.isMonitorRegistered(),
  getStats: () => activityStats.getStats()
});

setLlmUsageRecorder((usage, model) => activityStats.recordLlmUsageFromApi(usage, model));

// 子进程（GPU/渲染等）崩溃观测：GPU 崩溃后窗口合成表面可能残留其他窗口像素，强制重绘
app.on('child-process-gone', (_event, details) => {
  log.error('child-process-gone:', JSON.stringify(details));
  if (details.type === 'GPU' && windowTray) {
    windowTray.recoverMainWindowSurface(`gpu-${details.reason}`);
  }
});

if (gotSingleInstanceLock) {
process.on('unhandledRejection', (reason) => {
  log.error('Unhandled rejection:', reason && reason.stack ? reason.stack : reason);
});
app.whenReady().then(async () => {
  const pipeRole = await bindSingleInstancePipe();
  if (pipeRole === 'duplicate') {
    log.info('检测到已有实例（命名管道），退出重复进程');
    notifyRunningInstanceAndExit();
    return;
  }

  autoLaunch.migrateAutoLaunchRegistration();
  autoLaunch.ensureAutoLaunchEnabled();

  trayNotify.ensureWindowsNotificationAppId();
  log.info('应用就绪');

  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback, details) => {
    if (permission === 'media') {
      const types = details?.mediaTypes;
      if (!types || types.includes('audio')) {
        callback(true);
        return;
      }
    }
    callback(false);
  });
  session.defaultSession.setPermissionCheckHandler((_wc, permission, _origin, details) => {
    if (permission === 'media') {
      const types = details?.mediaTypes;
      if (!types || types.includes('audio')) return true;
    }
    return false;
  });

  log.info('配置 - 工位监控:', getMonitorServerCandidates().join(' , ') || '(未配置)');
  log.info('配置 - Computer ID:', CONFIG.COMPUTER_ID);
  if (!CONFIG.SERVER_URL) {
    log.info(
      '工位监控未配置（可选 SERVER_URL 或 ~/.dieyun/deploy.json → monitor.serverUrl，见 deploy.defaults.example.json）'
    );
  }
  if (!CONFIG.UPDATE_URL && !CONFIG.UPDATE_URL_FALLBACK) {
    log.info('更新源未配置（可选 UPDATE_URL / deploy.json → updates）');
  }

  const userData = app.getPath('userData');
  activityStats.loadActivityStats();
  const readableDir = path.join(userData, 'gateway-readable');
  readableDirPath = readableDir;
  const extraReadRoots = [];
  if (!app.isPackaged) {
    extraReadRoots.push(process.cwd());
  }
  const gatewayLog = createGatewayFileLogger(readableDir, (m) => log.info(m));
  terminalPool = createTerminalPool({ log: (m) => log.info(m), maxEntries: 8 });
  ({
    remoteGatewayPool,
    portForwardManager,
    sshConnectionPool,
    sshCredentialsStore,
    localGateway,
    sshSessionManager,
    sessionRemoteTransport
  } = bootWorkspaceRemoteRuntime({
    userDataPath: userData,
    readableDir,
    extraReadRoots,
    gatewayLog,
    appVersion: app.getVersion(),
    appRoot: app.getAppPath(),
    safeStorage,
    log,
    getTerminalPool: () => terminalPool,
    remoteGatewayRuntime,
    sshReconnect,
    LocalGateway
  }));
  if (isRustCoreEnabled()) {
    const bin = resolveDieyunCoreBinary();
    if (bin) {
      try {
        coreBridge = createCoreBridge({
          binaryPath: bin,
          log: (m) => log.info(m),
          onNotify: (evt) => {
            if (!evt || evt.method !== 'compaction.progress') return;
            broadcastToRenderers('compaction:progress', evt.params || {});
          }
        });
        await coreBridge.start();
        localGateway.setRustCore(coreBridge);
        log.info(`dieyun-core 已启动: ${bin}`);
      } catch (e) {
        log.warn('dieyun-core 启动失败，Agent/Plan 将不可用（无 JS 回退）:', e && e.message ? e.message : e);
        coreBridge = null;
      }
    }
  }
  try {
    let mainLogPath = '';
    try {
      mainLogPath = log.transports.file.getFile().path;
    } catch {
      mainLogPath = '';
    }
    const pr = logsSources.cleanLogs(userData, { mainLogPath });
    const removed = (pr.results || []).reduce((n, x) => n + (x.removedLines || 0), 0);
    if (removed > 0 || (pr.deletedArchives || []).length) {
      log.info(`日志清理: 删除 ${removed} 行旧记录, 归档 ${(pr.deletedArchives || []).length} 个`);
    }
  } catch (e) {
    log.warn('启动时日志清理失败:', e && e.message);
  }
  browserService = createBrowserService({
    getMainWindow: () => (windowTray ? windowTray.getMainWindow() : null),
    log: (m) => log.info(m),
    confirmBrowserImport: async (summary) => {
      const win = windowTray ? windowTray.getMainWindow() : null;
      const r = await dialog.showMessageBox(win, {
        type: 'question',
        buttons: ['允许导入', '取消'],
        defaultId: 1,
        cancelId: 1,
        noLink: true,
        title: '浏览器登录态导入',
        message: 'Agent 请求写入内嵌浏览器 Cookie / localStorage',
        detail: `${summary}\n\n仅影响叠云内置浏览器（persist:dieyun-browser），不会修改系统 Chrome/Edge。`
      });
      return r.response === 0;
    },
    confirmBrowserExport: async (summary) => {
      const win = windowTray ? windowTray.getMainWindow() : null;
      const r = await dialog.showMessageBox(win, {
        type: 'warning',
        buttons: ['允许导出', '取消'],
        defaultId: 1,
        cancelId: 1,
        noLink: true,
        title: '浏览器登录态导出',
        message: 'Agent 请求读取内嵌浏览器登录态',
        detail: `${summary}\n\n导出的 Cookie / localStorage 含登录态凭据，可能被写入对话上下文。仅影响叠云内置浏览器分区。`
      });
      return r.response === 0;
    }
  });
  try {
    localGateway.setBrowser(browserService);
  } catch (e) {
    log.error('浏览器服务注册失败:', e);
  }
  agentCoordinator = new AgentRunCoordinator();
  agentService = new AgentService({
    gateway: localGateway,
    userDataPath: userData,
    log: (m) => log.info(m)
  });
  agentService.setDesktopExecutor((task) => {
    windowTray.sendRendererAgentService('agent-service:submit-task', task);
  });
  agentService.setDesktopCanceller((payload) => {
    windowTray.sendRendererAgentService('agent-service:cancel-task', payload);
  });
  agentService.on('event', (event) => {
    if (mobileBridge) mobileBridge.broadcast(event);
    windowTray.sendRendererAgentService('agent-service:event', event);
  });
  mobileBridge = new MobileBridge({
    agentService,
    userDataPath: userData,
    log: (m) => log.info(m)
  });
  try {
    mobileBridge.start();
  } catch (e) {
    log.error('手机端桥接启动失败:', e);
  }

  try {
    const ws = localGateway.getWorkspace();
    const localWs = ws && ws.kind === 'local' ? ws.workspacePath : null;
    const home = ensureAgentHomeDirs(userData, localWs);
    try {
      const r = ensureDieyunMdInHome();
      if (r.created) log.info('已创建 dieyun.md:', r.path);
    } catch (e) {
      log.warn('dieyun.md 初始化失败:', e.message);
    }
    log.info('Agent 目录已就绪:', home.dieyunHome);
    if (home.agentsSkillsMigration && home.agentsSkillsMigration.copied > 0) {
      log.info(
        `已从 ~/.agents/skills 合并 ${home.agentsSkillsMigration.copied} 个技能到 ~/.dieyun/skills`
      );
    }
    try {
      const mig = await migrateAppDataSkills(userData);
      if (mig.migrated > 0) {
        log.info(`已从 AppData 合并 ${mig.migrated} 个技能文件到 ~/.dieyun/skills`);
      }
      const wsMig = await migrateWorkspaceSkills(ws);
      if (wsMig.migrated > 0) {
        log.info(`已从工作空间 .dieyun/skills 合并 ${wsMig.migrated} 个技能文件到 ~/.dieyun/skills`);
      }
    } catch (e) {
      log.warn('技能种子/迁移失败:', e.message);
    }
  } catch (e) {
    log.warn('初始化 Agent 目录失败:', e.message);
  }


  const catalogs = bootMcpSkillCatalogs({
    userData,
    mcpStore,
    getLocalGateway: () => localGateway,
    log,
    existingRuntime: mcpRuntime,
    existingMcpCatalog: mcpCatalog,
    existingSkillCatalog: skillCatalog
  });
  mcpRuntime = catalogs.mcpRuntime;
  mcpCatalog = catalogs.mcpCatalog;
  skillCatalog = catalogs.skillCatalog;

  const plansBoot = bootPlansRuntime({
    userData,
    getLocalGateway: () => localGateway,
    getCoreBridge: () => coreBridge,
    getMcpRuntime: () => mcpRuntime,
    getWindowTray: () => windowTray,
    getTrayNotify: () => trayNotify,
    createToolBridge: (webContents) => createRustLoopToolBridge(webContents),
    ensureMainCompactionAgent: () => ensureMainCompactionAgent(),
    getTokenBudget: (model) => getEffectiveInputBudget(loadModelSettings(userData), model),
    log
  });
  plansStore = plansBoot.plansStore;
  plansScheduler = plansBoot.plansScheduler;
  const finishPlanRun = plansBoot.finishPlanRun;
  const listRunningPlans = plansBoot.listRunningPlans;
  const cancelPlanRun = plansBoot.cancelPlanRun;

  registerMainIpc({
    ipcMain,
    app,
    dialog,
    QRCode,
    log,
    logsSources,
    usageToActivityPatch,
    getMainWindow: () => (windowTray ? windowTray.getMainWindow() : null),
    getLocalGateway: () => localGateway,
    getBrowserService: () => browserService,
    getMobileBridge: () => mobileBridge,
    getCoreBridge: () => coreBridge,
    getPlansStore: () => plansStore,
    getPlansScheduler: () => plansScheduler,
    getUserDataPath: () => userData,
    getActiveRemoteGatewayInfo: () => remoteGatewayRuntime.getActiveRemoteGatewayInfo(),
    getDeployUiDefaults,
    resolveDieyunCoreBinary,
    saveModelSettings,
    loadModelSettings,
    fetchOpenAiModelList,
    ensurePlanSession,
    parsePlanFromText,
    finishPlanRun,
    listRunningPlans,
    cancelPlanRun,
    getAutoLaunchState: () => autoLaunch.getAutoLaunchState(),
    setAutoLaunchEnabled: (enabled, opts) => autoLaunch.setAutoLaunchEnabled(enabled, opts),
    getPendingUpdateInfo: () => appUpdater.getPendingUpdateInfo(),
    getLastAppUpdateState: () => appUpdater.getLastAppUpdateState(),
    showRestartUpdateDialog: (info) => appUpdater.showRestartUpdateDialog(info),
    checkForUpdatesNow: () => appUpdater.checkForUpdatesNow(),
    installPendingUpdate: () => appUpdater.installPendingUpdate(),
    notifyUpdateTray: (title, content, onClick) => trayNotify.notifyUpdateTray(title, content, onClick),
    getStats: () => activityStats.getStats(),
    bumpActivityStats: (patch) => activityStats.bumpActivityStats(patch),
    resetDailyStats: () => activityStats.resetDailyStats(),
    normalizeModelUsageKey: activityStats.normalizeModelUsageKey,
    getSessionRemoteTransport: () => sessionRemoteTransport,
    ensureAgentHomeDirs,
    tryReconnectCurrentSshWorkspace: (reason, opts) =>
      sshReconnect.tryReconnectCurrentSshWorkspace(reason, opts),
    getSshSessionManager: () => sshSessionManager,
    getSshCredentialsStore: () => sshCredentialsStore,
    getSshConnectionPool: () => sshConnectionPool,
    getRemoteGatewayPool: () => remoteGatewayPool,
    getPortForwardManager: () => portForwardManager,
    resolveSshConnectSessionStatus: (payload, connectResult) =>
      sshReconnect.resolveSshConnectSessionStatus(payload, connectResult),
    getActiveRemoteGatewayStatus: () => remoteGatewayRuntime.getActiveRemoteGatewayStatus(),
    getRemoteGatewayPackRoot: () => remoteGatewayRuntime.getRemoteGatewayPackRoot(),
    invalidateRemoteAgentClient,
    ensureRemoteGatewayForCurrentWorkspace: () =>
      remoteGatewayRuntime.ensureRemoteGatewayForCurrentWorkspace(),
    suppressSshReconnect: () => sshReconnect.suppressSshReconnect(),
    broadcastToRenderers,
    getTerminalPool: () => terminalPool,
    getTerminalSession: () => terminalSession,
    setTerminalSession: (v) => {
      terminalSession = v;
    }
  });

  function workspaceRootPath() {
    if (!localGateway) return null;
    const ws = localGateway.getWorkspace();
    return ws && ws.workspacePath ? ws.workspacePath : null;
  }

  async function resolveAgentRunWorkspacePath(sessionId) {
    if (!localGateway || !sessionId) return null;
    const sid = String(sessionId);
    await localGateway.hydrateSessionWorkspaceContext(sid);
    return localGateway.getSessionWorkspacePath(sid);
  }

  registerRendererToolDelegateIpc(ipcMain);

  function notifySkillsCatalogChanged(webContents, detail) {
    if (webContents && !webContents.isDestroyed()) {
      webContents.send('dieyun:skills-changed', detail || {});
    }
  }

  function createRustLoopToolBridge(webContents) {
    return createMainToolBridge({
      gateway: localGateway,
      webContents,
      mcpRuntime,
      plansStore,
      userDataPath: userData,
      browserService,
      createUserSkill,
      onSkillsChanged: (created) => notifySkillsCatalogChanged(webContents, created),
      plansCreateFromText: createPlansCreateFromText({
        userData,
        getPlansStore: () => plansStore,
        getPlansScheduler: () => plansScheduler,
        getLocalGateway: () => localGateway,
        parsePlanFromText,
        ensurePlanSession
      })
    });
  }

  function ensureMainCompactionAgent() {
    if (!mainCompactionAgent) {
      mainCompactionAgent = createMainCompactionAgent(userData, coreBridge);
    }
    return mainCompactionAgent;
  }

  registerCompactionIpc({
    ipcMain,
    getUserDataPath: () => userData,
    getCoreBridge: () => coreBridge,
    getMainCompactionAgent: () => mainCompactionAgent,
    setMainCompactionAgent: (v) => {
      mainCompactionAgent = v;
    },
    loadModelSettings
  });

  registerAgentRuntimeIpc({
    ipcMain,
    rustLoopCancels,
    plannerRunCancels,
    abortedAgentCancelTokens,
    getCoreBridge: () => coreBridge,
    getUserDataPath: () => userData,
    getLocalGateway: () => localGateway,
    getAgentCoordinator: () => agentCoordinator,
    getSubagentStore: () => subagentStore,
    getAgentService: () => agentService,
    getWorktreeService: () => worktreeService,
    getMainCompactionAgent: () => mainCompactionAgent,
    setMainCompactionAgent: (v) => {
      mainCompactionAgent = v;
    },
    createRustLoopToolBridge,
    resolveAgentRunWorkspacePath,
    workspaceRootPath,
    dieyunHome,
    loadModelSettings,
    listMcpServersForUi: mcpStore.listMcpServersForUi,
    safeWebContentsSend,
    canSendToWebContents,
    killActiveShellChildren,
    clearToolHarnessSessionsForSession
  });

  registerLateMainIpc({
    ipcMain,
    clipboard,
    getLocalGateway: () => localGateway,
    getUserDataPath: () => userData,
    getReadableDirPath: () => readableDirPath,
    getWorktreeService: () => worktreeService,
    loadModelSettings,
    getMcpCatalog: () => mcpCatalog,
    getMcpRuntime: () => mcpRuntime,
    getSkillCatalog: () => skillCatalog,
    listMcpServersForUi: mcpStore.listMcpServersForUi,
    loadMcpStore: mcpStore.loadMcpStore,
    saveMcpStore: mcpStore.saveMcpStore,
    ensureMcpCredentialsStore: mcpStore.ensureMcpCredentialsStore,
    deleteMcpServer: mcpStore.deleteMcpServer,
    addMcpServer: mcpStore.addMcpServer,
    getMcpServerConfigForUi: mcpStore.getMcpServerConfigForUi,
    updateMcpServerConfig: mcpStore.updateMcpServerConfig,
    checkMcpServerUpdate: mcpStore.checkMcpServerUpdate,
    installMcpServerPackage: mcpStore.installMcpServerPackage,
    repairMcpEnvironment: mcpStore.repairMcpEnvironment,
    upgradeMcpServerPackage: mcpStore.upgradeMcpServerPackage,
    notifySkillsCatalogChanged,
    isWorkplaceMonitorEnabled: () => workplaceMonitor.isWorkplaceMonitorEnabled(),
    applyWorkplaceMonitorEnabled: (enabled) => workplaceMonitor.applyWorkplaceMonitorEnabled(enabled)
  });

  if (!windowTray.getMainWindow()) {
    windowTray.createWindow();
  }
  windowTray.createTray();
  workplaceMonitor.applyLoadedSettings();
  workplaceMonitor.primeCpuSampler().finally(() => {
    void workplaceMonitor.resolvePublicIp(true);
    if (workplaceMonitor.isWorkplaceMonitorEnabled()) {
      workplaceMonitor.ensureWorkplaceMonitorConnection();
    }
    workplaceMonitor.startLocalStatusPushTimer();
  });
  appUpdater.setupAutoUpdater();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      windowTray.createWindow();
    }
  });
});
}

app.on('window-all-closed', () => {
  // 保留托盘后台运行，不在窗口关闭时退出
});

app.on('before-quit', () => {
  app.isQuitting = true;
  if (windowTray) windowTray.destroyTray();
  activityStats.dispose();
  log.info('应用退出');
  if (localGateway) {
    localGateway.stop();
    localGateway = null;
  }
  if (coreBridge) {
    coreBridge.stop().catch(() => {});
    coreBridge = null;
  }
  if (browserService) {
    browserService.close().catch(() => {});
    browserService = null;
  }
  if (mobileBridge) {
    mobileBridge.stop();
    mobileBridge = null;
  }
  workplaceMonitor.dispose();
  appUpdater.disposeTimers();
  sshReconnect.disposeSshReconnectTimer();
  if (mcpRuntime) {
    mcpRuntime.shutdown().catch(() => {});
    mcpRuntime = null;
  }
});

app.on('quit', () => {
  log.info('应用已退出');
});
