'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const EMPTY_TRAY_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAABHNCSVQICAgIfAhkiAAAAAlwSFlzAAAA7AAAAOwBeShxvQAAABl0RVh0U29mdHdhcmUAd3d3Lmlua3NjYXBlLm9yZ5vuPBoAAAKsSURBVFiF7ZdNaBNBGIafmU02SZOmP1YpWqSCFBTBixyEIh7E4kEQPIiHBz0IgnjyIAgeBEE8eBQP8iAIHsSDIIhIBBEEQRCkCIp+tkmbZnfHbrLZJJtsmqBN4odhmZ155/3e7OwC/1NYYowxIYTA931EhIgAEYGIt0fEdsxsY7r+6cY/dP0fdP0juv4RDKDr/6Lr/6DrH8H1f1HVd0LddP0juv4RXL8TEXlJVVuAi8APa+0KY8wKY8zKNH6sAhYBC8ASoAWoAGXABGAAKIoqMqgXwACwH9iq6p3W2m1mZsuybIcxZqu1dmMwGNwN/AAsAG4A72Nmfh6w1s6IiA14M7NZe3p6tgPXgXXAtcD1O2Lmx8A2M7uh7/vHgB+11q4EPgLngB+B6z5m5i1gB3ACmA18A+4F7r4hZl4GbgduB27e1Vq7GdiHmfkW0MPMvBm4G7h5R8y8C9gPXA/cvKVm3gVcB+4Gbt7WWrsF2I2Z+S5w/X/Y+w64/4mZeR9wEHgSuHlbzLwHuA7cCdy8o2beB1wH7gZu3tFauxW4gZl5F3A9cPN/tNZuA25gZl4CbgDXAzfvipn3ANeBO4GbP9VauxW4gZl5CbgBXA/cvCtm3g1cB+4Ebv5ca+0W4Dpm5kXABnA9cPOumHk3cB24E7j5c621W4HrmJkXgRvA9cDNu2Lm3cB14E7g5i+11m4BrmNmXgBuANcDN++KmXcD14E7gZt3xcy7gOvAncDNn2qt3QJcx8y8ANwArgdu3hUz7wauA3cCN3+qtXYzcB0z8wJwA7geuHlXzLwbuA7cCdy8I2beA1wH7gRu/lJr7SbgOmbmBeAGcD1w866YeTdwHbgTuPlLa+1W4Dpm5gXgBnA9cPOumHk3cB24E7j5U621m4HrmJkXgBvA9cDNu2Lm3cB14E7g5k+11m4CrmNmngduANcDN++KmXcD14E7gZs/1Vq7CbiOmXkBuAFcD9y8K2beDVwH7gRu/tRauxW4jpl5AbgBXA/cvCtm3g1cB+4Ebv5ca+0W4Dpm5gXgBnA9cPOumHkXcB24E7j5U621m4HrmJkXgBvA9cDNu2LmXcB14E7g5k+11m4CrmNmngduANcDN++KmXcB14E7gZs/1Vq7GbiOmXkBuAFcD9y8K2beBVwH7gRu/lJr7SbgOmbmBeAGcD1w866YeTdwHbgTuPlLa+1W4Dpm5gXgBnA9cPOumHkXcB24E7j5U621m4DrmJkXgBvA9cDNu2LmXcB14E7g5k+11m4CrmNmngduANcDN++KmXcB14E7gZv/0Vp7CLiOmXkBuAFcD9y8K2beBVwH7gRu/lJr7SbgOmbmBeAGcD1w866YeRdwHbgTuPlza+1W4Dpm5gXgBnA9cPOumHkXcB24E7j5c621m4HrmJkXgBvA9cDNu2LmXcB14E7g5k+11m4CrmNmngduANcDN++KmXcB14E7gZvX9D/s+gX4J2bmdeB+4E7g5s+ttVuA65iZF4AbwPXAzbti5l3AdeBO4OZPtdZuAq5jZl4AbgDXAzfvqJl3A9eBO4GbP9Vauxm4jpl5AbgBXA/cvCtm3gVcB+4Ebv5ca+0W4Dpm5gXgBnA9cPOumHkXcB24E7j5c631/7U3/9Mf/wI6D5p7Z2h8ggAAAABJRU5ErkJggg==';

function resolveRendererIndexHtml(opts = {}) {
  const rendererDir = opts.rendererDir || path.join(__dirname, '..', 'renderer');
  const env = opts.env || process.env;
  const isPackaged = !!opts.isPackaged;
  const existsSync = opts.existsSync || ((p) => fs.existsSync(p));
  const forceLegacy = env.DIEYUN_LEGACY_RENDERER_SCRIPTS === '1' || env.DEV_LEGACY_SCRIPTS === '1';
  const forceBundle = env.DIEYUN_USE_RENDERER_BUNDLE === '1';
  const bundled = path.join(rendererDir, 'index.bundled.html');
  const bundleJs = path.join(rendererDir, 'dist', 'bundle.js');
  const preferBundle = forceBundle || isPackaged;
  if (!forceLegacy && preferBundle && existsSync(bundled) && existsSync(bundleJs)) {
    return bundled;
  }
  return path.join(rendererDir, 'index.html');
}

/**
 * 构建输入框 / 选区右键菜单模板。
 * Electron 默认不提供上下文菜单，缺了它用户无法用鼠标右键粘贴（例如 MCP 的 API Key 输入框）。
 * @param {import('electron').ContextMenuParams} params
 * @returns {Array<object>} 空数组表示该位置不弹菜单
 */
function buildEditContextMenuTemplate(params) {
  const flags = (params && params.editFlags) || {};
  const hasSelection = !!String((params && params.selectionText) || '').trim();
  const template = [];
  if (params && params.isEditable) {
    template.push({ label: '剪切', role: 'cut', enabled: flags.canCut !== false });
    template.push({ label: '复制', role: 'copy', enabled: flags.canCopy !== false });
    template.push({ label: '粘贴', role: 'paste', enabled: flags.canPaste !== false });
    template.push({ type: 'separator' });
    template.push({ label: '全选', role: 'selectAll', enabled: flags.canSelectAll !== false });
    return template;
  }
  if (hasSelection) {
    template.push({ label: '复制', role: 'copy' });
    template.push({ type: 'separator' });
    template.push({ label: '全选', role: 'selectAll' });
  }
  return template;
}

/**
 * 托盘槽位是 16 DIP，按屏幕缩放比换成实际像素（100%→16、150%→24、200%→32）。
 * 固定 16px 会让高缩放下的系统把图标放大一倍，托盘必糊。
 * @param {number} scaleFactor
 * @returns {number}
 */
function trayPixelSizeFor(scaleFactor) {
  const factor = Number(scaleFactor) > 0 ? Number(scaleFactor) : 1;
  return Math.max(16, Math.round(16 * factor));
}

/**
 * Main BrowserWindow + system tray.
 * @param {object} deps
 */
function createWindowTray(deps) {
  const {
    app,
    BrowserWindow,
    Tray,
    Menu,
    nativeImage,
    screen,
    log,
    getComputerId,
    isLoginItemLaunch,
    isAutoLaunchEnabled,
    toggleAutoLaunch,
    getAppUpdater,
    getBrowserService,
    canSendToWebContents,
    safeWebContentsSend,
    isMonitorRegistered,
    getStats,
    rendererFreeze
  } = deps;

  let mainWindow = null;
  let tray = null;
  let showMainWindowPending = false;

  function showMainWindow() {
    if (!mainWindow || mainWindow.isDestroyed()) {
      showMainWindowPending = true;
      return;
    }
    if (mainWindow.isMinimized()) mainWindow.restore();
    if (!mainWindow.isVisible()) mainWindow.show();
    mainWindow.focus();
    showMainWindowPending = false;
  }

  function pushStatus() {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    // 窗口不可见时不必唤醒渲染进程；show 时会补推一次
    const minimized = typeof mainWindow.isMinimized === 'function' && mainWindow.isMinimized();
    const visible = typeof mainWindow.isVisible !== 'function' || mainWindow.isVisible();
    if (minimized || !visible) return;
    const wc = mainWindow.webContents;
    if (!canSendToWebContents(wc)) return;
    const stats = getStats();
    const payload = {
      registered: isMonitorRegistered(),
      computerId: getComputerId(),
      hostname: os.hostname(),
      keystrokesToday: stats.keystrokesToday,
      mouseClicksToday: stats.mouseClicksToday,
      tokensToday: stats.tokensToday,
      tokensTotal: stats.tokensTotal,
      promptTokensToday: stats.promptTokensToday,
      completionTokensToday: stats.completionTokensToday,
      cachedTokensToday: stats.cachedTokensToday,
      cachedTokensTotal: stats.cachedTokensTotal,
      cacheHitPromptTokensToday: stats.cacheHitPromptTokensToday,
      cacheHitPromptTokensMonth: stats.cacheHitPromptTokensMonth,
      promptTokensMonth: stats.promptTokensMonth,
      completionTokensMonth: stats.completionTokensMonth,
      cachedTokensMonth: stats.cachedTokensMonth,
      modelUsageToday: stats.modelUsageToday,
      modelUsageMonth: stats.modelUsageMonth,
      statsMonth: stats.lastResetMonth,
      version: app.getVersion()
    };
    safeWebContentsSend(wc, 'status', payload);
  }

  function buildTrayContextMenu() {
    const appUpdater = getAppUpdater();
    return Menu.buildFromTemplate([
      { label: `叠云Agent v${app.getVersion()}`, enabled: false },
      { type: 'separator' },
      { label: '打开叠云Agent', click: () => showMainWindow() },
      { label: '隐藏窗口', click: () => mainWindow && mainWindow.hide() },
      { type: 'separator' },
      { label: '开机自启: ' + (isAutoLaunchEnabled() ? '已开启' : '已关闭'), click: () => toggleAutoLaunch() },
      { type: 'separator' },
      {
        label: appUpdater.getPendingUpdateInfo() ? '安装更新并重启' : '检查更新',
        click: () =>
          appUpdater.getPendingUpdateInfo() ? appUpdater.installPendingUpdate() : appUpdater.checkForUpdatesNow()
      },
      {
        label: '退出',
        click: () => {
          app.isQuitting = true;
          app.quit();
        }
      }
    ]);
  }

  function refreshTrayContextMenu() {
    if (!tray) return;
    tray.setContextMenu(buildTrayContextMenu());
  }

  function destroyTray() {
    if (!tray) return;
    try {
      tray.destroy();
    } catch {
      // ignore
    }
    tray = null;
  }

  // Windows 用多尺寸 ICO：任务栏/托盘/Alt-Tab 各自按当前 DPI 直接取到 16/20/24/32/40/48/64 帧，
  // 而不是拿一张 256 PNG 让系统自己缩（实测那样窗口 HICON 是 256x256，任务栏必然发虚）。
  function resolveAppIconPath() {
    const icoPath = path.join(__dirname, '..', '..', 'assets', 'icon.ico');
    if (process.platform === 'win32' && fs.existsSync(icoPath)) return icoPath;
    return path.join(__dirname, '..', '..', 'assets', 'icon.png');
  }

  // 托盘单独走实心版 PNG：小尺寸（≤32px）用实心剪影才看得清，而 Electron 的
  // nativeImage 读 ICO 只拿得到最大帧（256），取不到 32px 帧。这张图由
  // scripts/generate-icons.py 从同一份美术出（TRAY_PX=64，供这里按 DPI 缩下去）。
  function resolveTrayIconPath() {
    const trayPath = path.join(__dirname, '..', '..', 'assets', 'icon-tray.png');
    return fs.existsSync(trayPath) ? trayPath : resolveAppIconPath();
  }

  function loadTrayNativeImage() {
    let trayIcon;
    try {
      trayIcon = nativeImage.createFromPath(resolveTrayIconPath());
      if (trayIcon.isEmpty()) {
        trayIcon = nativeImage.createEmpty();
      }
    } catch {
      trayIcon = nativeImage.createEmpty();
    }
    if (!trayIcon.isEmpty()) {
      const px = trayPixelSizeFor(screen.getPrimaryDisplay().scaleFactor);
      trayIcon = trayIcon.resize({ width: px, height: px, quality: 'best' });
    }
    return trayIcon;
  }

  function createTray() {
    destroyTray();
    const trayIcon = loadTrayNativeImage();

    tray = new Tray(trayIcon.isEmpty() ? nativeImage.createFromDataURL(EMPTY_TRAY_PNG) : trayIcon);

    tray.setToolTip(`叠云Agent - ${getComputerId()}`);
    tray.setContextMenu(buildTrayContextMenu());

    tray.on('double-click', () => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      if (mainWindow.isVisible()) {
        mainWindow.hide();
      } else {
        showMainWindow();
      }
    });
  }

  function createWindow() {
    // 无边框窗口没有任何菜单 UI，但 Electron 在不调用 setApplicationMenu 时会装一份
    // **默认应用菜单**，它的 accelerator（Ctrl+M 最小化、Ctrl+W 关窗、Ctrl+R 重载…）
    // 是浏览器进程级的原生快捷键：渲染端只有在 keydown 里 preventDefault 才能压住，
    // 一旦漏掉（按键重复 repeat、焦点不在页面等）就会命中。本应用的最小化/关闭都走
    // titlebar 的 IPC，没有代码依赖这些 accelerator —— 直接摘掉整份菜单是唯一来源。
    Menu.setApplicationMenu(null);
    const iconPath = resolveAppIconPath();
    mainWindow = new BrowserWindow({
      width: 1475,
      height: 953,
      minWidth: 1238,
      minHeight: 778,
      show: false,
      frame: false,
      roundedCorners: false,
      backgroundColor: '#000000',
      title: '叠云 Agent',
      icon: iconPath,
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        // 保持全速：渲染端多处 await requestAnimationFrame / chained setTimeout(0)，
        // 打开后台节流（默认值）会让这些 await 在窗口隐藏或最小化时永久挂起/被钳到 1s。
        // 若要改回节流省电，需先把这些等待点改成隐藏安全实现（与 renderer-chat-render 的
        // document.hidden 守卫同理）。
        backgroundThrottling: false
      }
    });

    try {
      if (mainWindow.webContents && typeof mainWindow.webContents.setBackgroundThrottling === 'function') {
        mainWindow.webContents.setBackgroundThrottling(false);
      }
    } catch {
      // ignore
    }

    const pushMaxState = () => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      try {
        mainWindow.webContents.send('window-max-state', mainWindow.isMaximized());
      } catch {
        // ignore
      }
    };
    mainWindow.on('maximize', pushMaxState);
    mainWindow.on('unmaximize', pushMaxState);

    mainWindow.setMenuBarVisibility(false);
    mainWindow.webContents.on('context-menu', (_event, params) => {
      const template = buildEditContextMenuTemplate(params);
      if (!template.length) return;
      Menu.buildFromTemplate(template).popup({ window: mainWindow });
    });
    mainWindow.loadFile(resolveRendererIndexHtml({ isPackaged: app.isPackaged }));

    // 渲染进程崩溃：先落现场，再自动重载恢复显示（崩溃后 DOM 已丢失，任务状态在 Main 进程不受影响）
    mainWindow.webContents.on('render-process-gone', (_event, details) => {
      // 现场必须先于 reload 落盘：reload 会重建 DOM，之后再无现场可取证
      reportRendererFreezeEvent('render-process-gone', details);
      if (details.reason === 'clean-exit') return;
      setTimeout(() => {
        if (!mainWindow || mainWindow.isDestroyed()) return;
        try {
          mainWindow.webContents.reloadIgnoringCache();
        } catch (err) {
          log.error('渲染进程崩溃后重载失败', err);
        }
      }, 300);
    });
    mainWindow.on('unresponsive', () => {
      // 此刻渲染主线程已堵、抓不到 DOM；能拿的是「距最后一次心跳多久」+ 进程 CPU/内存
      reportRendererFreezeEvent('unresponsive', { note: 'renderer main thread blocked' });
    });

    // 心跳基准随页面重载归零，否则新页面第一秒会被算成「很久没心跳」
    mainWindow.webContents.on('did-finish-load', () => {
      if (rendererFreeze && typeof rendererFreeze.resetRendererBeat === 'function') {
        rendererFreeze.resetRendererBeat();
      }
    });

    mainWindow.once('ready-to-show', () => {
      if (!isLoginItemLaunch() || showMainWindowPending) {
        mainWindow.show();
      }
      showMainWindowPending = false;
      pushStatus();
      pushMaxState();
    });

    mainWindow.on('close', (e) => {
      if (!app.isQuitting) {
        e.preventDefault();
        mainWindow.hide();
      }
    });

    mainWindow.on('show', () => {
      try {
        mainWindow.webContents.send('window-max-state', mainWindow.isMaximized());
      } catch {
        // ignore
      }
      // 无框窗口从托盘隐藏/恢复后可能残留旧帧（Windows DWM），强制重绘
      recoverMainWindowSurface('window-show');
      // 隐藏期间跳过了状态推送，恢复显示时补一次
      pushStatus();
    });

    mainWindow.on('resize', () => {
      const browserService = getBrowserService && getBrowserService();
      if (browserService) browserService.onWindowResize();
    });
  }

  function sendRendererAgentService(channel, payload) {
    if (!mainWindow || mainWindow.isDestroyed()) {
      createWindow();
    }
    const win = mainWindow;
    if (!win || win.isDestroyed()) return false;
    const send = () => {
      safeWebContentsSend(win.webContents, channel, payload);
    };
    if (win.webContents.isLoading()) {
      win.webContents.once('did-finish-load', send);
    } else {
      send();
    }
    return true;
  }

  function getMainWindow() {
    return mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
  }

  /**
   * 只推给「已经存在的窗口」，**不创建窗口**。
   *
   * 与 `sendRendererAgentService` 的差别只在这一点：前者是手机端发起任务，必须把窗口叫出来；
   * 而内网 peer 的收信通知不该因为同事发来一条消息就把用户藏起来的主窗口弹出来。
   */
  function sendRendererEvent(channel, payload) {
    const win = getMainWindow();
    if (!win) return false;
    safeWebContentsSend(win.webContents, channel, payload);
    return true;
  }

  /**
   * 渲染进程冻结/崩溃取证落盘（问题 B）。现场采集在 src/main/ipc/renderer-freeze.js，
   * 这里只负责「何时取」；只读渲染侧快照由该模块经 IPC 直接落盘。
   */
  function reportRendererFreezeEvent(tag, payload) {
    if (rendererFreeze && typeof rendererFreeze.reportRendererFreeze === 'function') {
      rendererFreeze.reportRendererFreeze(tag, payload);
      return;
    }
    // 取证模块未注入（如单测直接调 createWindowTray）：保留原有的最小落盘，避免崩溃日志整体丢失
    log.error(`${tag}:`, JSON.stringify(payload));
  }

  /**
   * 强制主窗口整帧重绘：GPU 进程崩溃 / 托盘恢复后，Windows 上无框窗口
   * 可能残留其他窗口像素（DWM 合成表面破损），invalidate 可修复花屏。
   */
  function recoverMainWindowSurface(reason) {
    const win = getMainWindow();
    if (!win) return;
    try {
      if (win.webContents.isLoadingMainFrame()) return;
      // 这是每次 window-show 都走的既定兜底（不是异常）：warn 留给真问题，
      // GPU 崩溃那条路径自己有 child-process-gone 的 error 日志。
      log.info(`强制重绘主窗口表面（${reason}）`);
      win.webContents.invalidate();
    } catch (err) {
      log.error('主窗口重绘失败', err);
    }
  }

  return {
    showMainWindow,
    createWindow,
    createTray,
    destroyTray,
    refreshTrayContextMenu,
    pushStatus,
    sendRendererAgentService,
    sendRendererEvent,
    getMainWindow,
    recoverMainWindowSurface,
    getTray: () => tray
  };
}

module.exports = { createWindowTray, resolveRendererIndexHtml, buildEditContextMenuTemplate, trayPixelSizeFor };
