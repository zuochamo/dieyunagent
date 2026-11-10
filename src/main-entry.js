/** Electron main: window/tray/lifecycle. New IPC goes in src/main/ipc/ (see src/main/register-ipc.js). */
const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  ipcMain,
  nativeImage,
  screen,
  dialog,
  Notification,
  safeStorage,
  session,
  clipboard
} = require('electron');
const path = require('path');
const os = require('os');
const { getDeployConfig } = require('./deploy-config');
const {
  getMonitorServerCandidates,
  loadAppConfig
} = require('./main/app-config');
const net = require('net');
const { usageToActivityPatch } = require('./llm-usage-stats');
const { setLlmUsageRecorder } = require('./agent/llm-usage-recorder');
const { ensureAgentHomeDirs, createUserSkill, dieyunHome } = require('./agent-home');
const { scheduleDefaultWorkspaceGc } = require('./default-workspace-gc');
const { migrateAppDataSkills, migrateWorkspaceSkills } = require('./skills/seed-to-dieyun');
const { LocalGateway } = require('./gateway/server');
const { createCoreBridge } = require('./core-bridge');
const { resolveDieyunCoreBinary, isRustCoreEnabled } = require('./core-bridge-path');
const { createStatusOutbox } = require('./monitor/status-outbox');
const { createBrowserService } = require('./browser/service');
const { createComputerService } = require('./computer/service');
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
const { createMcpManager } = require('./mcp/manage');
const {
  bootMcpSkillCatalogs,
  bootPlansRuntime,
  createPlansCreateFromText
} = require('./main/mcp-plans-boot');
const { AgentRunCoordinator } = require('./agent/coordinator');
const { AgentService } = require('./agent/service');
const { MobileBridge } = require('./mobile/bridge');
// 内网 agent 互通（P2P）：身份/发现/WS 直连/会话投递/建议式租约，语义全在 src/peer/；
// 装配（含回合回传接线）唯一实现 `src/peer/boot.js`，headless 调的是同一份。
const { bootPeerRuntime } = require('./peer/boot');
const { getAgentLimits } = require('./agent/agent-limits');
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
const { getSshConfigBlocks } = require('./ssh/ssh-config');
const { createSshActions } = require('./ssh/actions');
const { createWorktreeActions } = require('./worktree/actions');
const { loadModelSettings, saveModelSettings, getEmbeddingConfig } = require('./model-settings');
// 共享记忆（跨机 PostgreSQL）：数据层唯一实现，扩展页签「共享记忆」
const { createSharedMemoryService } = require('./memory-shared/service');
const { createEmbeddingClient } = require('./codebase/embedding-client');
const { createMainToolBridge } = require('./agent/tool-bridge-main');
const { clearToolHarnessSessionsForSession } = require('./agent/tool-harness');
const {
  registerRendererToolDelegateIpc,
  requestSandboxApproval,
  setLateSandboxApprovalHandler
} = require('./agent/renderer-tool-delegate');
const { createMainCompactionAgent } = require('./agent/compaction-main');
const { killActiveShellChildren } = require('./gateway/host-control');
const { registerEarlyMainIpc, registerMainIpc, registerLateMainIpc } = require('./main/register-ipc');
const { registerMediaScheme, attachMediaProtocol } = require('./main/media-protocol');
const { registerAgentRuntimeIpc } = require('./main/ipc/agent-runtime');
const { registerSharedMemoryIpc } = require('./main/ipc/shared-memory');
// 生命感（设置 → 生命）：装配唯一来源 `src/main/alive-boot.js`（headless 用同一份）
const { bootAliveRuntime } = require('./main/alive-boot');
const { registerAliveIpc } = require('./main/ipc/alive');
const { registerChannelIpc } = require('./main/ipc/channels');
const { bootChannelsRuntime } = require('./channels/boot');
const { registerCompactionIpc } = require('./main/ipc/compaction');
const { createRendererFreezeReporter } = require('./main/ipc/renderer-freeze');
const { invalidateRemoteAgentClient } = require('./gateway/remote-agent-client');
const { createTerminalPool } = require('./terminal/terminal-pool');

log.transports.file.level = 'info';
log.transports.file.maxSize = 5 * 1024 * 1024;
log.info('应用启动中...');
// 写类工具串行队列的 stall 告警必须进 main.log：队列被一个不返回的调用钉住时，
// 其它地方一行痕迹都没有（读类工具与 Gateway 照常工作），只能靠这条日志定位。
require('./agent/mutate-queue').setMutateQueueLog((m) => log.warn(m));
// 循环停滞（RUN_STALL / RUN_STALL_ABORT）同样必须进 main.log：
// run 卡在某个 await 上时，除了这一行没有任何痕迹（无下一轮请求、无 trace、无报错）。
require('./agent/rust-loop-runner').setLoopRunnerLog((m) => log.warn(m));

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
/** 生命感运行时（设置 → 生命；开关关掉时也存在，只是不起心跳） */
/** @type {any} */
let aliveRuntime = null;
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
/** @type {ReturnType<import('./peer').createPeerCoordinator> | null} */
let peerCoordinator = null;
/** @type {ReturnType<createBrowserService> | null} */
let browserService = null;
/** @type {ReturnType<import('./computer/service').createComputerService> | null} */
let computerService = null;
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
  getSshConfigBlocks: () => getSshConfigBlocks(),
  getSshConnectionPool: () => sshConnectionPool,
  getSessionRemoteTransport: () => sessionRemoteTransport,
  invalidateRemoteAgentClient,
  ensureRemoteGatewayForCurrentWorkspace: () =>
    remoteGatewayRuntime.ensureRemoteGatewayForCurrentWorkspace(),
  getActiveRemoteGatewayWireInfo: () => remoteGatewayRuntime.getActiveRemoteGatewayWireInfo(),
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
/** @type {object | null} 频道（企业微信等外部入口）配置存储 */
let channelStore = null;
/** @type {object | null} 频道长连接与调度 */
let channelRuntime = null;


const earlyIpcCtx = {
  ipcMain,
  app,
  dialog,
  loadDieyunInstructions,
  openDieyunMdInEditor,
  formatDieyunBlock
};
registerEarlyMainIpc(earlyIpcCtx);

// 媒体协议必须在 app ready 之前注册（Electron 硬性要求）；真正的请求处理在 whenReady 里挂。
registerMediaScheme();

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

// 渲染进程冻结取证（问题 B）：心跳时间戳与取证落盘的唯一来源。
// 取证期临时机制 —— 根因定位并修复后删除本行、下方注入项与 registerIpc 调用。
const rendererFreezeReporter = createRendererFreezeReporter({
  app,
  log,
  getMainWindow: () => (windowTray ? windowTray.getMainWindow() : null)
});

windowTray = createWindowTray({
  app,
  BrowserWindow,
  Tray,
  Menu,
  nativeImage,
  screen,
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
  getStats: () => activityStats.getStats(),
  rendererFreeze: rendererFreezeReporter
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
  // Gateway 的低噪心跳（LSP watch 空批次等）：只进 electron-log 的 debug（file level=info 时被过滤），
  // 不写 gateway.log —— 否则换个文件继续当噪声。
  const gatewayLogDebug = (m) => log.debug(m);
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
    gatewayLogDebug,
    appVersion: app.getVersion(),
    appRoot: app.getAppPath(),
    safeStorage,
    log,
    getTerminalPool: () => terminalPool,
    remoteGatewayRuntime,
    sshReconnect,
    LocalGateway
  }));
  // 沙箱审批通道：越界操作（写工作区外 / read-only 档下写文件）弹一次窗问用户。
  // 未注入时 Gateway 的 broker 走 fail-closed（一律拒），不会静默放行。
  if (localGateway && typeof localGateway.setSandboxApprovalChannel === 'function') {
    localGateway.setSandboxApprovalChannel((payload) =>
      requestSandboxApproval(windowTray ? windowTray.getMainWindow() : null, payload)
    );
  }
  // 迟到的批准（用户离开超过 2 分钟才点「允许」）：不重放工具调用，只把批准记进本会话的 grant。
  if (localGateway && typeof localGateway.applyLateSandboxApproval === 'function') {
    setLateSandboxApprovalHandler((requestId, decision) =>
      localGateway.applyLateSandboxApproval(requestId, decision)
    );
  }
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
  try {
    computerService = createComputerService({ log: (m) => log.info(m) });
    localGateway.setComputer(computerService);
  } catch (e) {
    log.error('电脑控制服务注册失败:', e);
    computerService = null;
  }
  agentCoordinator = new AgentRunCoordinator();
  agentService = new AgentService({
    gateway: localGateway,
    userDataPath: userData,
    log: (m) => log.info(m)
  });
  agentService.setExecutor((task) => {
    windowTray.sendRendererAgentService('agent-service:submit-task', task);
  });
  agentService.setCanceller((payload) => {
    windowTray.sendRendererAgentService('agent-service:cancel-task', payload);
  });
  agentService.on('event', (event) => {
    if (mobileBridge) mobileBridge.broadcast(event);
    windowTray.sendRendererAgentService('agent-service:event', event);
    // 跨机回合的回传订阅不在这里：它跟互通同生共死，唯一实现在 `src/peer/boot.js`
    // （headless 那一侧装配的是同一份，否则「答复回不去」只会在其中一边出现）。
  });
  mobileBridge = new MobileBridge({
    agentService,
    userDataPath: userData,
    log: (m) => log.info(m)
  });
  try {
    // `start()` 是 async（listen 失败会 reject）：不 await 的话端口被占会变成未处理拒绝
    await mobileBridge.start();
  } catch (e) {
    log.error('手机端桥接启动失败:', e);
  }

  // 内网 agent 互通：与手机桥同级（都是 Main 持有的一扇网络门），但方向相反 ——
  // 手机桥是「外部前端连进来」，peer 是「别的 agent 连进来 + 本机连出去」。
  // 装配（含回合回传接线）的唯一实现在 `src/peer/boot.js`，headless 调的是同一份；
  // 这里只提供依赖。启动失败只关掉互通，不影响本地 agent。
  peerCoordinator = bootPeerRuntime({
    userDataPath: userData,
    getWorkspace: () => {
      try {
        const ws = localGateway.getWorkspace();
        return { workspacePath: ws && ws.workspacePath ? String(ws.workspacePath) : '' };
      } catch {
        return { workspacePath: '' };
      }
    },
    rpc: (method, params) => localGateway.invokeRpc(method, params),
    submitTask: (task) => agentService.submitTask(task),
    agentService,
    limits: () => getAgentLimits(userData),
    onEvent: (event) => {
      if (windowTray) windowTray.sendRendererEvent('peer:event', event);
    },
    log
  });

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
    // 默认工作区回收：未选工作空间时所有产物都落 ~/.dieyun/workspace，没有任何会话负责清理，
    // 不回收就单调增长。语义全在 src/default-workspace-gc.js（headless 那边同一份）。
    scheduleDefaultWorkspaceGc({ log, limits: getAgentLimits(userData, 'default') });
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

  // MCP 配置变更的唯一入口（IPC 与 Agent 工具 mcp_manage 共用）：写 store + 重挂运行时。
  const mcpManager = createMcpManager({
    userDataPath: userData,
    mcpStore,
    getRuntime: () => mcpRuntime
  });

  const plansBoot = bootPlansRuntime({
    userData,
    getLocalGateway: () => localGateway,
    getCoreBridge: () => coreBridge,
    getMcpRuntime: () => mcpRuntime,
    getWindowTray: () => windowTray,
    getTrayNotify: () => trayNotify,
    createToolBridge: (webContents) => createRustLoopToolBridge(webContents),
    ensureMainCompactionAgent: () => ensureMainCompactionAgent(),
    log
  });
  plansStore = plansBoot.plansStore;
  plansScheduler = plansBoot.plansScheduler;
  const finishPlanRun = plansBoot.finishPlanRun;
  const listRunningPlans = plansBoot.listRunningPlans;
  const cancelPlanRun = plansBoot.cancelPlanRun;

  // 频道（企业微信等外部入口）：自己的会话、自己的工作空间，在 Main 后台跑一轮，
  // 与桌面当前会话无关（见 issue/2026-10-30-agent-channel-and-workspace-binding.md）。
  // 共享记忆（跨机）实例在下面创建；这里用 getter，频道跑轮次时早已就绪。
  // **必须提前声明**：`const` 在赋值前是 TDZ，getter 一旦在启动早期被调用就是
  // ReferenceError（不是「还没好」），用 `let` + null 起始把这一格变成「暂不可用」。
  let sharedMemory = null;
  const channelsBoot = bootChannelsRuntime({
    userData,
    safeStorage,
    getLocalGateway: () => localGateway,
    getCoreBridge: () => coreBridge,
    getMcpRuntime: () => mcpRuntime,
    getCompactionAgent: () => ensureMainCompactionAgent(),
    createToolBridge: (webContents) => createRustLoopToolBridge(webContents),
    listMcpServers: mcpStore.listMcpServersForUi,
    // 共享记忆（跨机）实例在下面创建；这里用 getter，频道跑轮次时早已就绪
    getSharedMemory: () => sharedMemory,
    // 频道在 Main 后台写会话账本，桌面历史列表得知道有新会话（只刷新列表，不切当前会话）
    notifySessionsChanged: (payload) => broadcastToRenderers('channels:sessions-changed', payload),
    log
  });
  channelStore = channelsBoot.channelStore;
  channelRuntime = channelsBoot.channelRuntime;

  // SSH 动作的唯一实现：IPC（设置页 / 连接面板）与 Agent 工具 `ssh` 共用这份 getter 绑定，
  // 谁也不许再把「连/断/端口转发」写第二遍。晚绑定（取值函数）避免捕获启动期的 null。
  const sshActions = createSshActions({
    log,
    getLocalGateway: () => localGateway,
    getSessionRemoteTransport: () => sessionRemoteTransport,
    tryReconnectCurrentSshWorkspace: (reason, opts) =>
      sshReconnect.tryReconnectCurrentSshWorkspace(reason, opts),
    getSshSessionManager: () => sshSessionManager,
    getSshCredentialsStore: () => sshCredentialsStore,
    getSshConfigBlocks: () => getSshConfigBlocks(),
    getSshConnectionPool: () => sshConnectionPool,
    getRemoteGatewayPool: () => remoteGatewayPool,
    getPortForwardManager: () => portForwardManager,
    resolveSshConnectSessionStatus: (payload, connectResult) =>
      sshReconnect.resolveSshConnectSessionStatus(payload, connectResult),
    getActiveRemoteGatewayStatus: () => remoteGatewayRuntime.getActiveRemoteGatewayStatus(),
    invalidateRemoteAgentClient,
    suppressSshReconnect: () => sshReconnect.suppressSshReconnect()
  });

  // Worktree 副本：设置页「副本」面板与 Agent 工具 `worktree` 共用这一份实例。
  const worktreeActions = createWorktreeActions({
    getLocalGateway: () => localGateway,
    getWorktreeService: () => worktreeService
  });

  registerMainIpc({
    ipcMain,
    app,
    dialog,
    QRCode,
    log,
    logsSources,
    usageToActivityPatch,
    sshActions,
    worktreeActions,
    getMainWindow: () => (windowTray ? windowTray.getMainWindow() : null),
    getLocalGateway: () => localGateway,
    getBrowserService: () => browserService,
    getMobileBridge: () => mobileBridge,
    getAgentService: () => agentService,
    getPeerCoordinator: () => peerCoordinator,
    getCoreBridge: () => coreBridge,
    getPlansStore: () => plansStore,
    getPlansScheduler: () => plansScheduler,
    getUserDataPath: () => userData,
    getActiveRemoteGatewayWireInfo: () => remoteGatewayRuntime.getActiveRemoteGatewayWireInfo(),
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
    clearActivityStats: () => activityStats.clearAllStats(),
    pushStatus: () => {
      if (windowTray) windowTray.pushStatus();
    },
    normalizeModelUsageKey: activityStats.normalizeModelUsageKey,
    getSessionRemoteTransport: () => sessionRemoteTransport,
    ensureAgentHomeDirs,
    tryReconnectCurrentSshWorkspace: (reason, opts) =>
      sshReconnect.tryReconnectCurrentSshWorkspace(reason, opts),
    getSshSessionManager: () => sshSessionManager,
    getSshCredentialsStore: () => sshCredentialsStore,
    getSshConfigBlocks: () => getSshConfigBlocks(),
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
    getTerminalPool: () => terminalPool
  });

  // 渲染进程冻结取证通道（问题 B，取证期临时）：心跳/快照经 preload 单向上报 → main.log
  rendererFreezeReporter.registerIpc(ipcMain);

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
      mcpManager,
      plansStore,
      sshActions,
      worktreeActions,
      // 计划的「立即执行 / 中止」与 IPC plans:run-now / plans:cancel 共用同一套调度实例
      getPlansScheduler: () => plansScheduler,
      finishPlanRun,
      cancelPlanRun,
      userDataPath: userData,
      peerCoordinator,
      // 手机摄像头（camera_look）：工具层只要「现在连着哪台手机」，不自己管桥。
      getMobileBridge: () => mobileBridge,
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
    ensureMainCompactionAgent,
    loadModelSettings
  });

  // 共享记忆（跨机 PostgreSQL，扩展页签「共享记忆」）：
  // 数据层唯一实现 `src/memory-shared/service.js`；默认开启，口令由用户在扩展页签里填。
  // 探活失败 = 本轮及以后按关闭处理（不重试、不阻塞对话），设置页显示原因。
  sharedMemory = createSharedMemoryService({
    userDataPath: userData,
    safeStorage,
    nodeId: os.hostname(),
    hostname: os.hostname(),
    clientVersion: app.getVersion(),
    limits: () => getAgentLimits(userData),
    // 向量复用「设置 → 模型 → 向量索引」里那个端点：没配就没有向量，召回自动落到文本排名
    embedding: () => {
      try {
        const settings = loadModelSettings(userData);
        return createEmbeddingClient(getEmbeddingConfig(settings));
      } catch {
        return null;
      }
    },
    log: {
      info: (msg) => log.info(msg),
      warn: (msg) => log.warn(msg)
    }
  });
  void sharedMemory.probe();

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
    getSharedMemory: () => sharedMemory,
    ensureMainCompactionAgent,
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

  // 扩展页签「共享记忆」：设置读写 / 测试连接 / 探活 / 立即提炼。
  // 归纳器实例从 `getActiveKnowledgeMaintainer()` 取（同一个实例，避免第二套队列与定时器）。
  registerSharedMemoryIpc({
    ipcMain,
    getSharedMemory: () => sharedMemory,
    getKnowledgeMaintainer: () =>
      require('./agent/knowledge-maintainer').getActiveKnowledgeMaintainer(),
    log
  });

  registerChannelIpc({
    ipcMain,
    getChannelStore: () => channelStore,
    getChannelRuntime: () => channelRuntime,
    log: (msg) => log.info(msg)
  });

  // 生命感（设置 → 生命）：一个心跳、一套体征；唤醒轮与用户轮走同一份 runner。
  // 装配只有一份（`src/main/alive-boot.js`），headless 用同一份，只是宿主不同。
  aliveRuntime = bootAliveRuntime({
    userData,
    getGateway: () => localGateway,
    getCoreBridge: () => coreBridge,
    getMcpRuntime: () => mcpRuntime,
    getCompactionAgent: () => ensureMainCompactionAgent(),
    // 后台心跳没有 Renderer：Renderer-only 工具会 fail-fast（与 headless 一致）
    createToolBridge: () => createRustLoopToolBridge(null),
    listMcpServers: mcpStore.listMcpServersForUi,
    // 「正在听一段」必须当场可见（托盘/系统通知）：麦克风被占用 15 秒不能悄悄发生
    notifyTray: (title, body) => {
      try {
        trayNotify.notifyUpdateTray(title, body);
      } catch {
        // 通知失败不影响感官
      }
    },
    log: (msg) => log.info(msg)
  });
  registerAliveIpc({ ipcMain, getAlive: () => aliveRuntime, log });
  // 开关持久在 `<userData>/alive/settings.json`：按上次的意图起停（默认关 = 不起心跳）
  if (aliveRuntime.enabled()) aliveRuntime.setEnabled(true);
  registerLateMainIpc({
    ipcMain,
    clipboard,
    getLocalGateway: () => localGateway,
    getSshConnectionPool: () => sshConnectionPool,
    getUserDataPath: () => userData,
    getReadableDirPath: () => readableDirPath,
    getWorktreeService: () => worktreeService,
    loadModelSettings,
    getMcpCatalog: () => mcpCatalog,
    getMcpRuntime: () => mcpRuntime,
    mcpManager,
    getSkillCatalog: () => skillCatalog,
    listMcpServersForUi: mcpStore.listMcpServersForUi,
    loadMcpStore: mcpStore.loadMcpStore,
    saveMcpStore: mcpStore.saveMcpStore,
    ensureMcpCredentialsStore: mcpStore.ensureMcpCredentialsStore,
    deleteMcpServer: mcpStore.deleteMcpServer,
    addMcpServer: mcpStore.addMcpServer,
    setMcpServerEnabled: mcpStore.setMcpServerEnabled,
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

  // 媒体直出协议：字节仍由 Gateway（artifact.read_file）按 Range 分块提供，
  // 这里只负责把 Range 请求翻译成分块读。见 src/main/media-protocol.js
  attachMediaProtocol({
    getLocalGateway: () => localGateway,
    log: (m) => log.info(m)
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

  // 频道（企业微信等）：只连「已启用且有凭据」的那些；连接失败只记日志，
  // 用户能在设置页看到状态并自行修凭据（不做静默重试风暴）。
  if (channelRuntime) {
    try {
      channelRuntime.startEnabled();
    } catch (e) {
      log.warn('频道启动失败:', e && e.message);
    }
  }

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
  // 生命感：停表并落一次盘（关窗口 ≠ 退出；这里才是进程退出，体征留着）
  if (aliveRuntime) {
    try {
      aliveRuntime.stop();
    } catch {
      // 退出路径不因关闭失败而卡住
    }
    aliveRuntime = null;
  }
  log.info('应用退出');
  // 频道长连接先断：它是外部系统的连接，不能等 Gateway/core 停完再断，
  // 否则退出瞬间的来电消息会写进一个正在关闭的会话。
  if (channelRuntime) {
    try {
      channelRuntime.stopAll();
    } catch {
      // 退出路径不因关闭失败而卡住
    }
    channelRuntime = null;
  }
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
  if (peerCoordinator) {
    try {
      peerCoordinator.stop();
    } catch {
      // 退出路径不因关闭失败而卡住
    }
    peerCoordinator = null;
  }
  workplaceMonitor.dispose();
  appUpdater.disposeTimers();
  sshReconnect.disposeSshReconnectTimer();
  // 远端 agent 必须跟着退出一起收：它们是 nohup 起的独立进程，不管就变成远端孤儿
  // （占端口 + 占 <workspace>/.dieyun/index.sqlite，下次启动要先清孤儿）。
  if (remoteGatewayPool) {
    remoteGatewayPool
      .stopAll(() => (sshConnectionPool ? sshConnectionPool.disconnectAll() : undefined))
      .catch(() => {});
    remoteGatewayPool = null;
  } else if (sshConnectionPool) {
    sshConnectionPool.disconnectAll().catch(() => {});
  }
  sshConnectionPool = null;
  if (mcpRuntime) {
    mcpRuntime.shutdown().catch(() => {});
    mcpRuntime = null;
  }
});

app.on('quit', () => {
  log.info('应用已退出');
});
