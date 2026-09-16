'use strict';

const { BrowserView, app, nativeImage } = require('electron');
const fs = require('fs');
const path = require('path');
const {
  buildSnapshotScript,
  buildClickCoordsScript,
  buildClickCoordsScriptBySelector,
  buildTypePrepareScript,
  buildTypePrepareScriptBySelector,
  buildReadFieldScript,
  buildSelectFieldScript,
  buildSelectOptionScript,
  buildImportLocalStorageScript,
  buildReadLocalStorageScript,
  buildHoverCoordsScript,
  buildHoverCoordsScriptBySelector,
  buildElementBoundsScript,
  buildDragCoordsScript,
  buildWaitConditionScript,
  buildUploadFileScript,
  buildPressKeyScript,
  normalizeModifiers,
  buildA11yDomScanScript,
  buildContextMenuScript
} = require('./snapshot-script');
const { a11ySnapshotBrowserView } = require('./a11y');
const { createNetworkJournal, summarizeHarEntries } = require('./network-collector');
const {
  createConsoleJournal,
  summarizeConsoleEntries,
  classifyConsoleEntry,
  buildConsoleErrorHookScript
} = require('./console-collector');
const { BROWSER_SESSION_PARTITION, browserPartitionForSession } = require('./session-sync');
const { assertBrowserLoadUrl, matchUrlPattern } = require('./url-policy');
const { isBrowserPermissionAllowed } = require('./permission-policy');
const { buildEvaluateScript, normalizeEvaluateResult } = require('./evaluate');
const { normalizeViewport, normalizeEmulation } = require('./viewport');
const { buildExpectScript } = require('./expect');

const CHROME_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function isBrowserCaptureSurfaceError(err) {
  const msg = String(err && err.message ? err.message : err || '');
  return /display surface not available|not available for capture|no current surface/i.test(msg);
}

function assertHttpUrl(url) {
  const u = String(url || '').trim();
  let parsed;
  try {
    parsed = new URL(u);
  } catch {
    const err = new Error('无效的 URL');
    err.code = 'INVALID_URL';
    throw err;
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    const err = new Error('浏览器仅支持 http/https');
    err.code = 'INVALID_URL';
    throw err;
  }
  return parsed.toString();
}

/**
 * @param {{ getMainWindow: () => import('electron').BrowserWindow | null, log?: (msg: string) => void }} deps
 */
function createBrowserViewController(deps) {
  const log = deps.log || (() => {});
  const networkJournal = deps.networkJournal || createNetworkJournal();
  const consoleJournal = deps.consoleJournal || createConsoleJournal();
  const installedNetworkSessions = new WeakSet();
  /** @type {import('electron').BrowserView | null} */
  let view = null;
  let panelOpen = false;
  /** @type {{ x: number, y: number, width: number, height: number } | null} */
  let bounds = null;
  let currentUrl = '';
  let currentTitle = '';
  let loading = false;
  /** @type {{ errorCode: number, errorDescription: string, url: string } | null} */
  let lastLoadError = null;
  let lastRenderHealth = null;
  /** 设备仿真覆盖（BrowserView 走 CDP Emulation.setDeviceMetricsOverride） */
  let viewportOverride = null;
  /** console 异常钩子的 init script 注册状态（按 webContents 记忆） */
  let consoleInitScriptWc = null;
  let consoleInitScriptId = null;
  let renderProbeTimer = null;
  let recoveringBlankPaint = false;
  let lastBlankRecoveryAt = 0;
  let lastBlankRecoveryUrl = '';
  /**
   * 每个分区只安装一次证书放行。
   * 分区按会话区分（persist:dieyun-browser-<sessionId>），所以不能用全局布尔：
   * 那样只有第一个会话生效，其余会话会因证书错误直接加载失败。
   */
  const certProcSessions = new WeakSet();
  /** 每个分区只安装一次权限策略（持久分区会跨 view 复用） */
  const permissionSessions = new WeakSet();
  let downloadSeq = 0;
  const downloads = [];
  const downloadWaiters = [];
  let downloadListenerInstalled = false;
  /** @type {string | null} */
  let activePartitionSessionId = null;
  /** 多标签：id -> { id, view, url, title }；view 为 null 表示待打开的 popup */
  const tabEntries = new Map();
  let activeTabId = null;
  let tabSeq = 0;
  /** 模拟授权的权限集合（由 browser_emulate 写入，permission handler 会放行） */
  const emulatedPermissions = new Set();
  let emulationState = { geolocation: null, timezone: '', locale: '' };
  /** 上次 snapshot 检出的跨域 iframe 数量：元素找不到时用于提示/自动降级 */
  let lastBlockedIframes = 0;

  function partitionForView() {
    return browserPartitionForSession(activePartitionSessionId);
  }

  function activateSession(sessionId) {
    const next = sessionId ? String(sessionId).trim() : null;
    if (next === activePartitionSessionId && hasLiveView()) {
      return { ok: true, swapped: false, partition: partitionForView() };
    }
    const prev = activePartitionSessionId;
    close();
    activePartitionSessionId = next;
    return { ok: true, swapped: prev !== next, partition: partitionForView() };
  }

  function getActivePartitionSessionId() {
    return activePartitionSessionId;
  }


  function installNetworkCapture(wc) {
    const ses = wc.session;
    if (installedNetworkSessions.has(ses)) return;
    installedNetworkSessions.add(ses);
    const pending = new Map();
    const filter = { urls: ['http://*/*', 'https://*/*'] };
    ses.webRequest.onBeforeRequest(filter, (details, cb) => {
      pending.set(details.id, {
        method: details.method,
        url: details.url,
        ts: Date.now(),
        resourceType: details.resourceType
      });
      cb({});
    });
    ses.webRequest.onCompleted(filter, (details) => {
      const p = pending.get(details.id) || {};
      pending.delete(details.id);
      networkJournal.add({
        engine: 'browserview',
        method: p.method || details.method,
        url: details.url,
        status: details.statusCode,
        resourceType: p.resourceType || details.resourceType,
        durationMs: p.ts ? Date.now() - p.ts : undefined,
        failed: details.statusCode >= 400
      });
    });
    ses.webRequest.onErrorOccurred(filter, (details) => {
      const p = pending.get(details.id) || {};
      pending.delete(details.id);
      networkJournal.add({
        engine: 'browserview',
        method: p.method || details.method,
        url: details.url,
        failed: true,
        error: details.error,
        resourceType: p.resourceType || details.resourceType,
        durationMs: p.ts ? Date.now() - p.ts : undefined
      });
    });
  }

  /**
   * 采集页面 console 与未捕获异常。
   * BrowserView 没有 page.on('pageerror')，靠 dom-ready 注入钩子把
   * 'error' / 'unhandledrejection' 转发到 console.error 再由这里捕获。
   */
  /**
   * 把异常钩子注册成"新文档即注入"（Electron 侧的 addInitScript）。
   * 这样 dom-ready 之前抛的早期错误也能采到；注册失败就退回 dom-ready 注入。
   * 注意：CDP 的 Page.addScriptToEvaluateOnNewDocument 需要 debugger 常驻。
   */
  async function ensureConsoleInitScript(wc) {
    if (!wc || wc.isDestroyed()) return;
    if (consoleInitScriptWc === wc && consoleInitScriptId) return;
    try {
      if (!wc.debugger.isAttached()) wc.debugger.attach('1.3');
      await wc.debugger.sendCommand('Page.enable');
      const res = await wc.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument', {
        source: buildConsoleErrorHookScript()
      });
      consoleInitScriptWc = wc;
      consoleInitScriptId = (res && res.identifier) || 'registered';
    } catch (e) {
      consoleInitScriptWc = null;
      consoleInitScriptId = null;
      log('browser console init script: ' + (e && e.message ? e.message : e));
    }
  }

  function installConsoleCapture(wc) {
    if (!wc || wc.isDestroyed()) return;
    ensureConsoleInitScript(wc).catch(() => {});
    wc.on('console-message', (event, level, message, line, sourceId) => {
      // Electron 新版把参数收进 event 对象；旧版为 (event, level, message, line, sourceId)
      const packed = event && typeof event === 'object' && typeof event.message === 'string';
      const classified = classifyConsoleEntry(
        packed ? event.level : level,
        packed ? event.message : message
      );
      const source = packed ? event.sourceId : sourceId;
      consoleJournal.add({
        engine: 'browserview',
        source: classified.source,
        level: classified.level,
        text: classified.text,
        url: typeof source === 'string' && source ? source : currentUrl,
        line: packed ? event.lineNumber : line
      });
    });
    wc.on('dom-ready', () => {
      if (wc.isDestroyed()) return;
      wc.executeJavaScript(buildConsoleErrorHookScript(), false).catch(() => {});
    });
  }

  function normalizeClickButton(raw) {
    const b = String(raw || 'left').toLowerCase();
    if (b === 'right' || b === 'middle') return b;
    return 'left';
  }

  function normalizeClickCount(raw) {
    const n = Number(raw) || 1;
    return n >= 2 ? 2 : 1;
  }

  function safeDownloadDir() {
    try {
      return app && typeof app.getPath === 'function' ? app.getPath('downloads') : process.cwd();
    } catch {
      return process.cwd();
    }
  }

  function guessMime(filePath) {
    const ext = path.extname(String(filePath || '')).toLowerCase();
    if (ext === '.png') return 'image/png';
    if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
    if (ext === '.gif') return 'image/gif';
    if (ext === '.webp') return 'image/webp';
    if (ext === '.pdf') return 'application/pdf';
    if (ext === '.txt' || ext === '.md') return 'text/plain';
    if (ext === '.csv') return 'text/csv';
    if (ext === '.json') return 'application/json';
    return 'application/octet-stream';
  }

  function notifyDownloadWaiters(row) {
    for (let i = downloadWaiters.length - 1; i >= 0; i--) {
      const waiter = downloadWaiters[i];
      if (!waiter || row.status !== 'completed') continue;
      clearTimeout(waiter.timer);
      downloadWaiters.splice(i, 1);
      waiter.resolve({ ok: true, engine: 'browserview', download: row });
    }
  }

  function installDownloadListener(wc) {
    if (!wc || wc.isDestroyed() || downloadListenerInstalled) return;
    downloadListenerInstalled = true;
    try {
      wc.session.on('will-download', (_event, item) => {
        const id = `bv-dl-${++downloadSeq}`;
        const fileName = item.getFilename() || `download-${downloadSeq}`;
        const savePath = path.join(safeDownloadDir(), fileName);
        const row = {
          id,
          status: 'in_progress',
          url: item.getURL() || '',
          fileName,
          path: savePath,
          receivedBytes: 0,
          totalBytes: item.getTotalBytes ? item.getTotalBytes() : 0,
          startedAt: Date.now(),
          completedAt: null,
          error: null
        };
        downloads.push(row);
        try { item.setSavePath(savePath); } catch { /* ignore */ }
        item.on('updated', (_e, state) => {
          row.status = state === 'interrupted' ? 'interrupted' : 'in_progress';
          row.receivedBytes = item.getReceivedBytes ? item.getReceivedBytes() : row.receivedBytes;
          row.totalBytes = item.getTotalBytes ? item.getTotalBytes() : row.totalBytes;
        });
        item.once('done', (_e, state) => {
          row.status = state === 'completed' ? 'completed' : state || 'failed';
          row.receivedBytes = item.getReceivedBytes ? item.getReceivedBytes() : row.receivedBytes;
          row.totalBytes = item.getTotalBytes ? item.getTotalBytes() : row.totalBytes;
          row.completedAt = Date.now();
          if (row.status !== 'completed') row.error = row.status;
          notifyDownloadWaiters(row);
        });
      });
    } catch (e) {
      log('browser download listener: ' + (e && e.message));
    }
  }
  function getWin() {
    const win = deps.getMainWindow();
    if (!win || win.isDestroyed()) return null;
    return win;
  }

  function viewWebContents(v = view) {
    if (!v) return null;
    try {
      const wc = v.webContents;
      if (!wc || wc.isDestroyed()) return null;
      return wc;
    } catch {
      return null;
    }
  }

  function hasLiveView(v = view) {
    return viewWebContents(v) != null;
  }

  function emitState() {
    const win = getWin();
    if (!win || win.isDestroyed()) return;
    try {
      win.webContents.send('browser:state', {
        url: currentUrl,
        title: currentTitle,
        loading,
        engine: 'browserview',
        panelOpen,
        loadError: lastLoadError,
        bounds,
        hasView: hasLiveView(),
        renderHealth: lastRenderHealth
      });
    } catch {
      // ignore
    }
  }

  function requestAutoOpenPanel() {
    const win = getWin();
    if (!win || win.isDestroyed()) return;
    try {
      win.webContents.send('browser:auto-open');
    } catch {
      // ignore
    }
  }

  function hasPaintableSurface() {
    return !!(panelOpen && bounds && bounds.width >= 8 && bounds.height >= 8 && hasLiveView());
  }

  async function ensurePaintableSurface() {
    const win = getWin();
    if (win && !win.isDestroyed() && typeof win.isMinimized === 'function' && win.isMinimized()) {
      try {
        win.restore();
      } catch {
        // ignore
      }
    }
    requestAutoOpenPanel();
    const deadline = Date.now() + 1800;
    while (Date.now() < deadline) {
      applyBounds();
      if (hasPaintableSurface()) {
        if (hasLiveView() && typeof view.webContents.invalidate === 'function') {
          try {
            view.webContents.invalidate();
          } catch {
            // ignore
          }
        }
        return true;
      }
      await waitQuiet(80);
    }
    applyBounds();
    return hasPaintableSurface();
  }

  async function withDebugger(wc, fn) {
    let attachedHere = false;
    try {
      if (!wc.debugger.isAttached()) {
        wc.debugger.attach('1.3');
        attachedHere = true;
      }
      return await fn();
    } finally {
      if (attachedHere && wc.debugger.isAttached()) {
        try {
          wc.debugger.detach();
        } catch {
          // ignore
        }
      }
    }
  }

  async function insertTextTrusted(wc, text) {
    const value = String(text ?? '');
    try {
      await withDebugger(wc, async () => {
        await wc.debugger.sendCommand('Input.insertText', { text: value });
      });
      return true;
    } catch (e) {
      log('browser Input.insertText: ' + (e && e.message ? e.message : String(e)));
    }
    try {
      wc.focus();
      const limit = Math.min(value.length, 4000);
      for (let i = 0; i < limit; i++) {
        wc.sendInputEvent({ type: 'char', keyCode: value[i] });
      }
      return true;
    } catch (e) {
      log('browser char input: ' + (e && e.message ? e.message : String(e)));
      return false;
    }
  }

  function installPermissionPolicy(ses) {
    if (!ses || permissionSessions.has(ses)) return;
    permissionSessions.add(ses);
    try {
      ses.setPermissionRequestHandler((_wc, permission, callback, details) => {
        callback(
          isBrowserPermissionAllowed(permission, details) ||
            emulatedPermissions.has(String(permission || ''))
        );
      });
    } catch (e) {
      log('browser permission request handler: ' + (e && e.message));
    }
    try {
      ses.setPermissionCheckHandler((_wc, permission, _origin, details) =>
        isBrowserPermissionAllowed(permission, details) ||
        emulatedPermissions.has(String(permission || ''))
      );
    } catch (e) {
      log('browser permission check handler: ' + (e && e.message));
    }
  }

  function installSessionPolicies(wc) {
    if (!wc || wc.isDestroyed()) return;
    const ses = wc.session;
    installPermissionPolicy(ses);
    if (certProcSessions.has(ses)) return;
    certProcSessions.add(ses);
    try {
      ses.setCertificateVerifyProc((_request, callback) => {
        callback(0);
      });
    } catch (e) {
      log('browser cert verify proc: ' + (e && e.message));
    }
  }

  function loadURLWithTimeout(wc, url, opts = {}) {
    const timeoutMs = Math.min(120000, Math.max(3000, Number(opts.timeoutMs) || 60000));
    const waitUntil = opts.waitUntil === 'domcontentloaded' ? 'domcontentloaded' : 'load';
    let timer = null;
    const loadPromise = wc.loadURL(url, { waitUntil });
    const timeoutPromise = new Promise((_resolve, reject) => {
      timer = setTimeout(() => {
        try {
          wc.stop();
        } catch {
          // ignore
        }
        const err = new Error(`导航超时（${timeoutMs}ms）: ${url}`);
        err.code = 'NAV_TIMEOUT';
        reject(err);
      }, timeoutMs);
    });
    return Promise.race([loadPromise, timeoutPromise]).finally(() => {
      if (timer) clearTimeout(timer);
    });
  }

  function applyBounds() {
    if (!hasLiveView()) return;
    const win = getWin();
    if (!win) return;
    if (win.getBrowserView() !== view) {
      win.setBrowserView(view);
    }
    if (!panelOpen || !bounds || bounds.width < 8 || bounds.height < 8) {
      view.setBounds({ x: 0, y: 0, width: 0, height: 0 });
      return;
    }
    view.setBounds({
      x: Math.max(0, Math.round(bounds.x)),
      y: Math.max(0, Math.round(bounds.y)),
      width: Math.max(0, Math.round(bounds.width)),
      height: Math.max(0, Math.round(bounds.height))
    });
  }

  function analyzeImage(image) {
    const size = image && image.getSize ? image.getSize() : { width: 0, height: 0 };
    const width = Number(size.width) || 0;
    const height = Number(size.height) || 0;
    if (width <= 0 || height <= 0) {
      return { width, height, sampleCount: 0, avgBrightness: 0, darkRatio: 1, blankBlack: true };
    }
    const bitmap = image.toBitmap();
    const pixels = width * height;
    const step = Math.max(1, Math.floor(pixels / 4096));
    let samples = 0;
    let dark = 0;
    let sum = 0;
    let min = 255;
    let max = 0;
    for (let p = 0; p < pixels; p += step) {
      const i = p * 4;
      const b = bitmap[i] || 0;
      const g = bitmap[i + 1] || 0;
      const r = bitmap[i + 2] || 0;
      const brightness = (r + g + b) / 3;
      samples += 1;
      sum += brightness;
      if (brightness < 8) dark += 1;
      if (brightness < min) min = brightness;
      if (brightness > max) max = brightness;
    }
    const avgBrightness = samples ? sum / samples : 0;
    const darkRatio = samples ? dark / samples : 1;
    return {
      width,
      height,
      sampleCount: samples,
      avgBrightness: Math.round(avgBrightness * 10) / 10,
      darkRatio: Math.round(darkRatio * 1000) / 1000,
      contrast: Math.round((max - min) * 10) / 10,
      blankBlack: darkRatio > 0.985 && avgBrightness < 8
    };
  }

  async function probeRenderHealth(reason = '') {
    if (!hasLiveView()) {
      lastRenderHealth = { ok: false, reason, error: 'no_view', at: Date.now() };
      return lastRenderHealth;
    }
    try {
      const image = await view.webContents.capturePage();
      const visual = analyzeImage(image);
      let page = null;
      try {
        page = await view.webContents.executeJavaScript(
          `(() => {
            const body = document.body;
            const root = document.documentElement;
            const bodyStyle = body ? getComputedStyle(body) : null;
            return {
              readyState: document.readyState,
              title: document.title || '',
              textLength: ((body && body.innerText) || '').trim().length,
              canvasCount: document.querySelectorAll('canvas').length,
              imageCount: document.images ? document.images.length : 0,
              bodyBackground: bodyStyle ? bodyStyle.backgroundColor : '',
              url: location.href
            };
          })()`,
          true
        );
      } catch {
        page = null;
      }
      lastRenderHealth = {
        ok: true,
        reason,
        at: Date.now(),
        visual,
        page,
        likelyBlank: !!visual.blankBlack
      };
      return lastRenderHealth;
    } catch (e) {
      lastRenderHealth = {
        ok: false,
        reason,
        at: Date.now(),
        error: e && e.message ? e.message : String(e)
      };
      return lastRenderHealth;
    }
  }

  function scheduleRenderProbe(reason, delayMs = 500) {
    if (renderProbeTimer) clearTimeout(renderProbeTimer);
    renderProbeTimer = setTimeout(() => {
      renderProbeTimer = null;
      probeAndRecoverBlankPaint(reason).catch((e) => {
        log('browser render probe: ' + (e && e.message ? e.message : String(e)));
      });
    }, Math.max(0, Number(delayMs) || 0));
  }

  async function probeAndRecoverBlankPaint(reason) {
    if (!panelOpen || !bounds || !hasLiveView()) return;
    const health = await probeRenderHealth(reason);
    emitState();
    if (!health?.visual?.blankBlack || recoveringBlankPaint) return;
    const recoveryUrl = String(currentUrl || (health.page && health.page.url) || '');
    const now = Date.now();
    if (recoveryUrl && recoveryUrl === lastBlankRecoveryUrl && now - lastBlankRecoveryAt < 10000) {
      return;
    }
    lastBlankRecoveryAt = now;
    lastBlankRecoveryUrl = recoveryUrl;
    recoveringBlankPaint = true;
    try {
      const win = getWin();
      if (win && !win.isDestroyed() && win.getBrowserView() !== view) {
        win.setBrowserView(view);
      }
      view.setBounds({ x: 0, y: 0, width: 0, height: 0 });
      await waitQuiet(80);
      applyBounds();
      if (typeof view.webContents.invalidate === 'function') {
        try { view.webContents.invalidate(); } catch { /* ignore */ }
      }
      await waitQuiet(350);
      const after = await probeRenderHealth(reason + ':recovered');
      if (after?.visual?.blankBlack && !loading && currentUrl) {
        log('browser blank paint persists after reattach: ' + currentUrl);
      }
      emitState();
    } finally {
      recoveringBlankPaint = false;
    }
  }

  /** 把当前活动视图的 URL/标题写回标签表（切标签/关标签前调用）。 */
  function persistActiveTab() {
    const entry = activeTabId ? tabEntries.get(activeTabId) : null;
    if (entry && hasLiveView()) {
      entry.view = view;
      entry.url = currentUrl;
      entry.title = currentTitle;
    }
  }

  function tabListResult() {
    const list = [];
    for (const [id, e] of tabEntries) {
      const active = id === activeTabId;
      list.push({
        id,
        active,
        pending: !e.view,
        url: active ? currentUrl : e.url || '',
        title: active ? currentTitle : e.title || ''
      });
    }
    return { ok: true, engine: 'browserview', activeTabId, tabs: list };
  }

  function closeTab(id) {
    const win = getWin();
    const entry = id ? tabEntries.get(String(id)) : null;
    if (!entry) return false;
    tabEntries.delete(entry.id);
    const v = entry.view;
    if (v && !v.webContents.isDestroyed()) {
      try {
        if (win && !win.isDestroyed() && win.getBrowserView() === v) win.removeBrowserView(v);
        v.webContents.destroy();
      } catch (e) {
        log('browser tab destroy: ' + (e && e.message ? e.message : e));
      }
    }
    if (activeTabId === entry.id) {
      view = null;
      cdpDetach();
      const rest = [...tabEntries.values()].filter((e) => e.view && !e.view.webContents.isDestroyed());
      const next = rest[rest.length - 1];
      activeTabId = next ? next.id : null;
      view = next ? next.view : null;
      currentUrl = next ? next.url || '' : '';
      currentTitle = next ? next.title || '' : '';
      if (view) {
        try {
          if (win && !win.isDestroyed() && win.getBrowserView() !== view) win.setBrowserView(view);
        } catch {
          // ignore
        }
        applyBounds();
      }
    }
    emitState();
    return true;
  }

  function ensureView() {
    const win = getWin();
    if (!win) {
      const err = new Error('主窗口不可用');
      err.code = 'NO_WINDOW';
      throw err;
    }
    // 多标签：活动标签仍有存活视图（在后台）时切回它，不重建
    const activeEntry = activeTabId ? tabEntries.get(activeTabId) : null;
    if (activeEntry && activeEntry.view && !activeEntry.view.webContents.isDestroyed()) {
      if (view !== activeEntry.view) {
        view = activeEntry.view;
        if (win.getBrowserView() !== view) win.setBrowserView(view);
        currentUrl = activeEntry.url || currentUrl;
        currentTitle = activeEntry.title || currentTitle;
      }
      // 切回后台标签：ensureCdp 只在「真的需要重新 attach」时才重放仿真状态，已 attach 时是 no-op，
      // 避免每次 ensureView（几乎每个操作）都重复下发 CDP 覆盖。
      ensureCdp(activeEntry.view.webContents).catch(() => {});
      applyBounds();
      return view;
    }
    if (!hasLiveView()) {
      if (view) {
        try {
          if (win.getBrowserView() === view) win.removeBrowserView(view);
        } catch {
          // ignore
        }
        view = null;
      }
      view = new BrowserView({
        webPreferences: {
          partition: partitionForView(),
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true
        }
      });
      const wc = view.webContents;
      win.setBrowserView(view);
      // 新窗口不再劫持当前页：登记为待打开标签，由 browser_tabs(action=open) 显式打开，原页面保留
      wc.setWindowOpenHandler(({ url }) => {
        if (/^https?:/i.test(url)) {
          const popupId = 'tab-' + tabSeq++;
          tabEntries.set(popupId, { id: popupId, view: null, url: String(url), title: '', popup: true });
          emitState();
        }
        return { action: 'deny' };
      });
      wc.on('did-start-loading', () => {
        if (wc.isDestroyed()) return;
        loading = true;
        emitState();
      });
      wc.on('did-stop-loading', () => {
        if (wc.isDestroyed()) return;
        loading = false;
        currentUrl = wc.getURL() || currentUrl;
        currentTitle = wc.getTitle() || currentTitle;
        emitState();
      });
      wc.on('page-title-updated', (_e, title) => {
        if (wc.isDestroyed()) return;
        currentTitle = title || '';
        emitState();
      });
      wc.on('did-navigate', (_e, url) => {
        if (wc.isDestroyed()) return;
        currentUrl = url || '';
        emitState();
      });
      wc.on('did-navigate-in-page', (_e, url) => {
        if (wc.isDestroyed()) return;
        currentUrl = url || '';
        emitState();
      });
      wc.setUserAgent(CHROME_USER_AGENT);
      installSessionPolicies(wc);
      installDownloadListener(wc);
      installNetworkCapture(wc);
      installConsoleCapture(wc);
      // 持久 CDP：对话框拦截（避免 alert/confirm 卡死）+ 请求改写规则重放
      ensureCdp(wc).catch((e) => log('browser CDP init: ' + (e && e.message ? e.message : e)));
      wc.on('did-fail-load', (_e, errorCode, errorDescription, validatedURL, isMainFrame) => {
        if (wc.isDestroyed() || !isMainFrame) return;
        lastLoadError = {
          errorCode,
          errorDescription: String(errorDescription || ''),
          url: String(validatedURL || '')
        };
        loading = false;
        emitState();
      });
      // 新视图是全新 webContents，CDP 覆盖不会继承 → 重放已记录的视口，
      // 否则 auto 从 Playwright 切回 BrowserView 后会退回面板尺寸，与状态不符。
      if (viewportOverride) {
        applyViewportToWebContents(wc, viewportOverride).catch((e) => {
          log('browser viewport replay: ' + (e && e.message ? e.message : e));
        });
      }
      // 注册标签：重建已有活动标签时复用槽位，否则新建
      const slot = activeTabId ? tabEntries.get(activeTabId) : null;
      if (slot) {
        slot.view = view;
      } else {
        const tabId = 'tab-' + tabSeq++;
        tabEntries.set(tabId, { id: tabId, view, url: '', title: '' });
        activeTabId = tabId;
      }
    } else if (win.getBrowserView() !== view) {
      win.setBrowserView(view);
    }
    applyBounds();
    return view;
  }

  function hideForOverlay() {
    if (!hasLiveView()) return;
    view.setBounds({ x: 0, y: 0, width: 0, height: 0 });
  }

  function restoreAfterOverlay() {
    applyBounds();
  }

  async function navigate(url, opts = {}) {
    const safeUrl = assertBrowserLoadUrl(url);
    const v = ensureView();
    installSessionPolicies(v.webContents);
    requestAutoOpenPanel();
    loading = true;
    lastLoadError = null;
    currentUrl = safeUrl;
    emitState();
    try {
      await loadURLWithTimeout(v.webContents, safeUrl, opts);
    } catch (err) {
      loading = false;
      emitState();
      throw err;
    }
    lastLoadError = null;
    currentUrl = v.webContents.getURL() || safeUrl;
    currentTitle = v.webContents.getTitle() || '';
    loading = false;
    emitState();
    scheduleRenderProbe('navigate', 700);
    return { ok: true, url: currentUrl, title: currentTitle, engine: 'browserview' };
  }

  async function evaluate(script) {
    const v = ensureView();
    return v.webContents.executeJavaScript(script, true);
  }

  /** 模型侧任意 JS：结果结构化 + 截断，错误不抛出而是回传。 */
  async function evaluateScript(args = {}) {
    const script = String(args.script == null ? '' : args.script);
    if (!script.trim()) {
      const err = new Error('browser_evaluate 需要 script');
      err.code = 'SCRIPT_REQUIRED';
      throw err;
    }
    const raw = await evaluate(buildEvaluateScript(script, { maxChars: args.maxChars }));
    return { engine: 'browserview', url: currentUrl, ...normalizeEvaluateResult(raw) };
  }

  async function snapshot(opts = {}) {
    ensureView();
    await ensurePaintableSurface();
    const delayMs = Math.min(10000, Math.max(0, Number(opts.delayMs) || 0));
    if (delayMs) await waitQuiet(delayMs);
    const data = await evaluate(buildSnapshotScript(opts));
    lastBlockedIframes = Array.isArray(data && data.blockedIframes) ? data.blockedIframes.length : 0;
    const renderHealth = await probeRenderHealth('snapshot');
    return {
      ok: true,
      engine: 'browserview',
      ...data,
      renderHealth,
      warning: renderHealth?.likelyBlank
        ? 'BrowserView 截图接近全黑；如果页面不是故意黑屏，请改用 engine=playwright 或调用 browser_status 查看状态。'
        : undefined
    };
  }

  async function resolveTarget(args = {}) {
    if (args.ref) {
      const ref = String(args.ref).replace(/"/g, '\\"');
      return `[data-dieyun-ref="${ref}"]`;
    }
    if (args.selector) return String(args.selector);
    const err = new Error('需要提供 ref 或 selector');
    err.code = 'TARGET_REQUIRED';
    throw err;
  }

  function sendMouseClickAt(v, x, y, opts = {}) {
    const ix = Math.max(0, Math.round(Number(x) || 0));
    const iy = Math.max(0, Math.round(Number(y) || 0));
    const button = normalizeClickButton(opts.button);
    const clickCount = normalizeClickCount(opts.clickCount);
    v.webContents.focus();
    v.webContents.sendInputEvent({ type: 'mouseMove', x: ix, y: iy });
    v.webContents.sendInputEvent({ type: 'mouseDown', x: ix, y: iy, button, clickCount });
    v.webContents.sendInputEvent({ type: 'mouseUp', x: ix, y: iy, button, clickCount });
  }

  async function click(args = {}) {
    const v = ensureView();
    await ensurePaintableSurface();
    const timeoutMs = Math.min(30000, Math.max(500, Number(args.timeoutMs) || 8000));
    const started = Date.now();
    let result = null;
    let evalScript;
    if (args.ref) {
      evalScript = buildClickCoordsScript(JSON.stringify(String(args.ref)));
    } else {
      const selector = await resolveTarget(args);
      evalScript = buildClickCoordsScriptBySelector(JSON.stringify(selector));
    }
    while (Date.now() - started < timeoutMs) {
      result = await evaluate(evalScript);
      if (result?.ok) break;
      await waitQuiet(200);
    }
    if (!result?.ok) {
      return { ok: false, ...result, engine: 'browserview', crossFrameHint: lastBlockedIframes > 0 };
    }
    const clickOpts = {
      button: normalizeClickButton(args.button),
      clickCount: normalizeClickCount(args.clickCount)
    };
    sendMouseClickAt(v, result.x, result.y, clickOpts);
    if (clickOpts.button === 'right') {
      const refJson = args.ref ? JSON.stringify(String(args.ref)) : '""';
      const selectorJson = args.selector ? JSON.stringify(String(args.selector)) : '""';
      await evaluate(buildContextMenuScript(refJson, selectorJson));
    }
    await waitQuiet(clickOpts.clickCount >= 2 ? 350 : 300);
    return {
      ok: true,
      engine: 'browserview',
      tag: result.tag || '',
      button: clickOpts.button,
      clickCount: clickOpts.clickCount
    };
  }

  async function typeText(args = {}) {
    const v = ensureView();
    await ensurePaintableSurface();
    const wc = v.webContents;
    const text = String(args.text ?? '');
    const clear = args.clear === true;
    if (!args.ref && !args.selector) {
      const err = new Error('browser_type 需要 snapshot 返回的 ref 或 selector');
      err.code = 'TARGET_REQUIRED';
      throw err;
    }
    const refJson = args.ref ? JSON.stringify(String(args.ref)) : '""';
    const selectorJson = args.selector ? JSON.stringify(String(args.selector)) : '""';
    const before = await evaluate(buildReadFieldScript(refJson, selectorJson)).catch(() => null);
    const prev = before && before.ok ? String(before.value || '') : '';
    const expected = clear ? text : prev + text;
    let coords = null;
    try {
      coords = args.ref
        ? await evaluate(buildClickCoordsScript(JSON.stringify(String(args.ref))))
        : await evaluate(buildClickCoordsScriptBySelector(JSON.stringify(String(args.selector))));
    } catch {
      coords = null;
    }
    if (coords && coords.ok) {
      sendMouseClickAt(v, coords.x, coords.y);
      await waitQuiet(60);
    }
    if (clear) {
      await evaluate(buildSelectFieldScript(refJson, selectorJson)).catch(() => null);
    }
    const trusted = await insertTextTrusted(wc, text);
    await waitQuiet(50);
    let read = await evaluate(buildReadFieldScript(refJson, selectorJson)).catch(() => null);
    const trustedMatched = !!(read && read.ok && String(read.value) === expected);
    if (!trustedMatched) {
      read = args.ref
        ? await evaluate(buildTypePrepareScript(JSON.stringify(String(args.ref)), JSON.stringify(expected), true))
        : await evaluate(
            buildTypePrepareScriptBySelector(JSON.stringify(String(args.selector)), JSON.stringify(expected), true)
          );
    }
    const actual = read && read.ok ? String(read.value || '') : '';
    const matched = actual === expected;
    const isField = read && (read.tag === 'input' || read.tag === 'textarea');
    if (isField && !matched) {
      return {
        ok: false,
        retryable: true,
        errorCode: 'TRANSIENT',
        error: `输入未写入控件（期望 ${expected.length} 字，实际 ${actual.length} 字）`,
        engine: 'browserview',
        tag: read.tag,
        type: read.type || '',
        filledVia: trusted ? 'trusted+js' : 'js'
      };
    }
    return {
      ok: !!read?.ok,
      engine: 'browserview',
      error: read && !read.ok ? read.error : undefined,
      tag: read?.tag || '',
      type: read?.type || '',
      matched,
      filledVia: trustedMatched ? 'trusted' : 'js',
      crossFrameHint: !!read && !read.ok && lastBlockedIframes > 0
    };
  }

  async function selectOption(args = {}) {
    ensureView();
    const value = args.value != null ? String(args.value) : '';
    const label = args.label != null ? String(args.label) : '';
    if (!value && !label) {
      const err = new Error('browser_select_option 需要 value 或 label');
      err.code = 'TARGET_REQUIRED';
      throw err;
    }
    const refJson = args.ref ? JSON.stringify(String(args.ref)) : '""';
    const selectorJson = args.selector ? JSON.stringify(String(args.selector)) : '""';
    const result = await evaluate(
      buildSelectOptionScript(refJson, selectorJson, JSON.stringify(value), JSON.stringify(label))
    );
    return { ok: !!result?.ok, ...result, engine: 'browserview' };
  }

  async function fill(args = {}) {
    return typeText({ ...args, clear: true });
  }

  async function scroll(args = {}) {
    ensureView();
    const amount = Number(args.amount) || 400;
    const direction = String(args.direction || 'down');
    let dx = 0;
    let dy = 0;
    if (direction === 'up') dy = -amount;
    else if (direction === 'down') dy = amount;
    else if (direction === 'left') dx = -amount;
    else if (direction === 'right') dx = amount;
    if (args.ref || args.selector) {
      const selector = await resolveTarget(args);
      const sel = JSON.stringify(selector);
      await evaluate(`(() => {
        const el = document.querySelector(${sel});
        if (el) el.scrollBy(${dx}, ${dy});
      })()`);
    } else {
      await evaluate(`(() => { window.scrollBy(${dx}, ${dy}); })()`);
    }
    return { ok: true, engine: 'browserview' };
  }

  async function pressKey(args = {}) {
    const v = ensureView();
    await ensurePaintableSurface();
    const key = String(args.key || 'Enter');
    const modifiers = normalizeModifiers(args.modifiers);
    v.webContents.focus();
    const result = await evaluate(buildPressKeyScript(JSON.stringify(key), JSON.stringify(modifiers)));
    const code = key.length === 1 ? key.toUpperCase() : key;
    const hasAccel = modifiers.includes('control') || modifiers.includes('meta');
    try {
      v.webContents.sendInputEvent({ type: 'keyDown', keyCode: code, modifiers });
      if (key.length === 1 && key !== 'Enter' && !hasAccel) {
        v.webContents.sendInputEvent({ type: 'char', keyCode: code, modifiers });
      }
      v.webContents.sendInputEvent({ type: 'keyUp', keyCode: code, modifiers });
    } catch {
      // ignore
    }
    return { ok: !!result?.ok, key, modifiers, engine: 'browserview' };
  }

  function sendMouseDragAt(v, startX, startY, endX, endY) {
    const sx = Math.max(0, Math.round(Number(startX) || 0));
    const sy = Math.max(0, Math.round(Number(startY) || 0));
    const ex = Math.max(0, Math.round(Number(endX) || 0));
    const ey = Math.max(0, Math.round(Number(endY) || 0));
    v.webContents.focus();
    v.webContents.sendInputEvent({ type: 'mouseMove', x: sx, y: sy });
    v.webContents.sendInputEvent({ type: 'mouseDown', x: sx, y: sy, button: 'left', clickCount: 1 });
    v.webContents.sendInputEvent({ type: 'mouseMove', x: ex, y: ey });
    v.webContents.sendInputEvent({ type: 'mouseUp', x: ex, y: ey, button: 'left', clickCount: 1 });
  }

  async function resolveElementClip(args = {}) {
    if (!args.ref && !args.selector) return null;
    const refJson = args.ref ? JSON.stringify(String(args.ref)) : '""';
    const selectorJson = args.selector ? JSON.stringify(String(args.selector)) : '""';
    const bounds = await evaluate(buildElementBoundsScript(refJson, selectorJson));
    if (!bounds?.ok) {
      const err = new Error(bounds?.error || '元素区域未找到');
      err.code = 'TARGET_REQUIRED';
      throw err;
    }
    return {
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height
    };
  }

  async function hover(args = {}) {
    const v = ensureView();
    let evalScript;
    if (args.ref) {
      evalScript = buildHoverCoordsScript(JSON.stringify(String(args.ref)));
    } else if (args.selector) {
      evalScript = buildHoverCoordsScriptBySelector(JSON.stringify(String(args.selector)));
    } else {
      const err = new Error('browser_hover 需要 ref 或 selector');
      err.code = 'TARGET_REQUIRED';
      throw err;
    }
    const result = await evaluate(evalScript);
    if (!result?.ok) return { ok: false, ...result, engine: 'browserview' };
    v.webContents.focus();
    v.webContents.sendInputEvent({
      type: 'mouseMove',
      x: Math.round(result.x),
      y: Math.round(result.y)
    });
    await waitQuiet(120);
    return { ok: true, engine: 'browserview', x: result.x, y: result.y };
  }

  async function drag(args = {}) {
    const v = ensureView();
    const refJson = args.ref ? JSON.stringify(String(args.ref)) : '""';
    const selectorJson = args.selector ? JSON.stringify(String(args.selector)) : '""';
    const toRefJson = args.toRef ? JSON.stringify(String(args.toRef)) : '""';
    const toSelectorJson = args.toSelector ? JSON.stringify(String(args.toSelector)) : '""';
    const dx = Number(args.dx) || 0;
    const dy = Number(args.dy) || 0;
    if (!args.ref && !args.selector) {
      const err = new Error('browser_drag 需要起始 ref 或 selector');
      err.code = 'TARGET_REQUIRED';
      throw err;
    }
    if (!args.toRef && !args.toSelector && !dx && !dy) {
      const err = new Error('browser_drag 需要 toRef/toSelector 或 dx/dy');
      err.code = 'TARGET_REQUIRED';
      throw err;
    }
    const result = await evaluate(buildDragCoordsScript(refJson, selectorJson, toRefJson, toSelectorJson, dx, dy));
    if (!result?.ok) return { ok: false, ...result, engine: 'browserview' };
    sendMouseDragAt(v, result.startX, result.startY, result.endX, result.endY);
    await waitQuiet(200);
    return { ok: true, engine: 'browserview', ...result };
  }

  async function screenshot(opts = {}) {
    const v = ensureView();
    await ensurePaintableSurface();
    const wc = v.webContents;
    const shotOpts = { ...opts };
    if (opts.ref || opts.selector) {
      shotOpts.clip = await resolveElementClip(opts);
      shotOpts.fullPage = false;
    }
    const image = await capturePageImage(wc, shotOpts);
    const png = image.toPNG();
    const visual = analyzeImage(image);
    const size = image.getSize();
    lastRenderHealth = {
      ok: true,
      reason: 'screenshot',
      at: Date.now(),
      visual,
      likelyBlank: visual.blankBlack
    };
    return {
      ok: true,
      engine: 'browserview',
      mime: 'image/png',
      base64: png.toString('base64'),
      width: size.width,
      height: size.height,
      fullPage: !!opts.fullPage && !opts.ref && !opts.selector,
      element: opts.ref || opts.selector || undefined,
      renderHealth: lastRenderHealth,
      warning: visual.blankBlack
        ? 'BrowserView 截图接近全黑；如果页面不是故意黑屏，请改用 engine=playwright。'
        : undefined
    };
  }

  const PDF_PAGE_SIZES = ['A3', 'A4', 'A5', 'Legal', 'Letter', 'Tabloid'];

  function normalizePdfPageSize(format) {
    const f = String(format || '').trim();
    if (!f) return 'A4';
    return PDF_PAGE_SIZES.find((x) => x.toLowerCase() === f.toLowerCase()) || 'A4';
  }

  async function pdf(opts = {}) {
    const v = ensureView();
    const wc = v.webContents;
    const buf = await wc.printToPDF({
      printBackground: opts.printBackground !== false,
      landscape: !!opts.landscape,
      pageSize: normalizePdfPageSize(opts.format),
      marginsType: 0
    });
    const bytes = Buffer.from(buf);
    return {
      ok: true,
      engine: 'browserview',
      mime: 'application/pdf',
      bytes: bytes.length,
      base64: bytes.toString('base64')
    };
  }

  async function reload(opts = {}) {
    const v = ensureView();
    const wc = v.webContents;
    loading = true;
    emitState();
    wc.reload();
    try {
      await waitForNavigation(wc, opts.timeoutMs);
    } catch (e) {
      loading = false;
      emitState();
      throw e;
    }
    lastLoadError = null;
    currentUrl = wc.getURL() || currentUrl;
    currentTitle = wc.getTitle() || currentTitle;
    loading = false;
    emitState();
    return { ok: true, url: currentUrl, title: currentTitle, engine: 'browserview', action: 'reload' };
  }

  async function goBack(opts = {}) {
    const v = ensureView();
    const wc = v.webContents;
    if (!wc.canGoBack()) {
      return { ok: false, engine: 'browserview', action: 'back', error: '无法后退（历史记录为空）', errorCode: 'HISTORY_EMPTY' };
    }
    loading = true;
    emitState();
    wc.goBack();
    try {
      await waitForNavigation(wc, opts.timeoutMs);
    } catch (e) {
      loading = false;
      emitState();
      throw e;
    }
    currentUrl = wc.getURL() || currentUrl;
    currentTitle = wc.getTitle() || currentTitle;
    loading = false;
    emitState();
    return { ok: true, url: currentUrl, title: currentTitle, engine: 'browserview', action: 'back' };
  }

  async function goForward(opts = {}) {
    const v = ensureView();
    const wc = v.webContents;
    if (!wc.canGoForward()) {
      return {
        ok: false,
        engine: 'browserview',
        action: 'forward',
        error: '无法前进（历史记录为空）',
        errorCode: 'HISTORY_EMPTY'
      };
    }
    loading = true;
    emitState();
    wc.goForward();
    try {
      await waitForNavigation(wc, opts.timeoutMs);
    } catch (e) {
      loading = false;
      emitState();
      throw e;
    }
    currentUrl = wc.getURL() || currentUrl;
    currentTitle = wc.getTitle() || currentTitle;
    loading = false;
    emitState();
    return { ok: true, url: currentUrl, title: currentTitle, engine: 'browserview', action: 'forward' };
  }

  async function importLocalStorage(entries) {
    ensureView();
    const payload = entries && typeof entries === 'object' ? entries : {};
    const result = await evaluate(buildImportLocalStorageScript(JSON.stringify(payload)));
    return result;
  }

  /** 结构化断言（一次往返跑完全部断言） */
  async function expect(assertions) {
    ensureView();
    return evaluate(buildExpectScript(JSON.stringify(assertions || [])));
  }

  async function readLocalStorage() {
    if (!hasLiveView() || !currentUrl) {
      return { ok: false, error: '当前没有已打开的页面，无法读取 localStorage' };
    }
    const result = await evaluate(buildReadLocalStorageScript());
    return result || { ok: false, error: '读取 localStorage 失败' };
  }

  async function waitFor(args = {}) {
    ensureView();
    const timeoutMs = Math.min(120000, Math.max(500, Number(args.timeoutMs) || 30000));
    const intervalMs = Math.min(3000, Math.max(100, Number(args.intervalMs) || 300));
    const started = Date.now();
    let last = null;
    while (Date.now() - started <= timeoutMs) {
      if (String(args.kind || args.type || '') === 'networkidle' || String(args.kind || args.type || '') === 'idle') {
        if (!loading) return { ok: true, engine: 'browserview', kind: 'networkidle', elapsedMs: Date.now() - started };
      } else {
        last = await evaluate(buildWaitConditionScript(args));
        if (last?.ok) return { ok: true, engine: 'browserview', elapsedMs: Date.now() - started, ...last };
      }
      await waitQuiet(intervalMs);
    }
    const renderHealth = await probeRenderHealth('wait_for_timeout');
    const blank = !!renderHealth?.likelyBlank;
    return {
      ok: false,
      engine: 'browserview',
      timeout: true,
      elapsedMs: Date.now() - started,
      last,
      renderHealth,
      errorCode: blank ? 'BROWSER_BLANK_VIEW' : 'WAIT_TIMEOUT',
      error: blank
        ? 'BrowserView 画面疑似全黑，等待条件未命中。请切换 engine=playwright 重新 observe/snapshot，或向用户说明页面渲染异常。'
        : '等待条件超时',
      retryable: false,
      suggestedFix: blank
        ? '调用 browser_observe({engine:"playwright"}) 或 browser_snapshot({engine:"playwright"})；不要继续重复相同 wait_for。'
        : '先 browser_observe 查看当前页面状态，再决定下一步。'
    };
  }

  async function tabs(args = {}) {
    const action = String(args.action || 'list').toLowerCase();
    if (action === 'new' || action === 'open') {
      let target = String(args.url || '').trim();
      const tabId = args.tabId ? String(args.tabId) : '';
      if (!target && tabId && tabEntries.has(tabId)) {
        target = tabEntries.get(tabId).url || '';
      }
      if (!target) {
        return { ok: false, engine: 'browserview', action, error: '需要 url（或有效的 tabId）' };
      }
      if (tabId) {
        const existing = tabEntries.get(tabId);
        // 已有活视图的标签：等价于切过去，不能删条目（否则 BrowserView 泄漏）
        if (existing && existing.view && !existing.view.webContents.isDestroyed()) {
          return tabs({ ...args, action: 'switch', tabId });
        }
        if (existing) tabEntries.delete(tabId);
      }
      persistActiveTab();
      view = null;
      activeTabId = null;
      ensureView();
      await navigate(target, args);
      persistActiveTab();
      return tabListResult();
    }
    if (action === 'switch') {
      const id = String(args.tabId || '');
      const entry = tabEntries.get(id);
      if (!entry) return { ok: false, engine: 'browserview', action, error: '未找到标签 ' + id };
      if (entry.view && !entry.view.webContents.isDestroyed()) {
        persistActiveTab();
        const win = getWin();
        activeTabId = id;
        view = entry.view;
        currentUrl = entry.url || '';
        currentTitle = entry.title || '';
        if (win && !win.isDestroyed() && win.getBrowserView() !== view) win.setBrowserView(view);
        applyBounds();
        emitState();
        return tabListResult();
      }
      if (entry.url) return tabs({ ...args, action: 'open', tabId: id });
      return { ok: false, engine: 'browserview', action, error: '标签没有可打开的地址' };
    }
    if (action === 'close') {
      const id = args.tabId ? String(args.tabId) : activeTabId;
      if (!id || !tabEntries.has(id)) {
        close();
        return tabListResult();
      }
      closeTab(id);
      return tabListResult();
    }
    return tabListResult();
  }

  // ────────── CDP：对话框拦截 + 请求改写（持久 attach，与 withDebugger 共存） ──────────
  const dialogLog = [];
  const routeRules = [];
  let dialogPolicy = 'auto';
  let pendingDialog = null;
  let routeSeq = 0;
  let cdpWc = null;
  /** 已绑定 message 监听的 webContents（多标签下每个 wc 各自绑定，避免切标签互相 detach） */
  const cdpBoundWcs = new WeakSet();
  let fetchEnabled = false;
  /** 首次 attach 失败的 webContents：本次视图生命周期内降级，不再反复重试 */
  let cdpFailedWc = null;
  let cdpLastError = '';

  function cdpStatus() {
    return {
      cdpAvailable: !!cdpWc && !cdpWc.isDestroyed(),
      cdpError: cdpLastError || undefined
    };
  }

  /** 每个 webContents 单独绑定 message 监听（多标签并存的前提）。detach 时自动解绑。 */
  function bindCdpMessage(wc) {
    if (cdpBoundWcs.has(wc)) return;
    cdpBoundWcs.add(wc);
    wc.debugger.on('message', (_event, method, params) => onCdpMessage(wc, method, params));
    wc.debugger.on('detach', () => {
      cdpBoundWcs.delete(wc);
      if (cdpWc === wc) cdpWc = null;
    });
  }

  /** 遍历所有标签中仍存活的 webContents（用于批量 Fetch.disable 等）。 */
  function forEachLiveWc(fn) {
    for (const [, entry] of tabEntries) {
      const wc = entry.view ? viewWebContents(entry.view) : null;
      if (wc) fn(wc);
    }
  }

  /** 规则清空后必须把每个标签的 Fetch 拦截都关掉，否则会永久拦截（只是全部 continue）。 */
  async function disableFetchOnAllWcs() {
    fetchEnabled = false;
    const targets = [];
    forEachLiveWc((w) => targets.push(w));
    for (const w of targets) {
      if (w.debugger.isAttached()) {
        await w.debugger.sendCommand('Fetch.disable').catch(() => {});
      }
    }
  }

  function toHeaderList(headers) {
    if (!headers || typeof headers !== 'object') return [];
    return Object.keys(headers).map((k) => ({ name: k, value: String(headers[k]) }));
  }

  /** 只断开指定 webContents（默认当前活动 wc）；不影响其它标签的 CDP。 */
  function cdpDetach(wc = cdpWc) {
    if (cdpWc === wc) cdpWc = null;
    fetchEnabled = false;
    if (!wc) return;
    cdpBoundWcs.delete(wc);
    try {
      if (!wc.isDestroyed() && wc.debugger.isAttached()) wc.debugger.detach();
    } catch {
      // ignore
    }
  }

  async function ensureCdp(wc) {
    if (!wc || wc.isDestroyed()) return null;
    // 该 webContents 首次 attach 失败过 → 本次视图生命周期内降级运行，不再反复重试
    if (cdpFailedWc === wc) return null;
    const bound = cdpBoundWcs.has(wc);
    if (wc.debugger.isAttached() && bound && cdpWc === wc) return wc.debugger;
    if (!wc.debugger.isAttached()) {
      try {
        wc.debugger.attach('1.3');
      } catch (e) {
        // 视口下发 / 整页截图也会 attach：并发时抛 "Another debugger is already attached"，
        // 但此时其实已 attach 成功，不能误判为降级（否则对话框/请求改写永久失效）。
        if (!wc.debugger.isAttached()) {
          cdpFailedWc = wc;
          cdpLastError = e && e.message ? e.message : String(e);
          log(
            'browser CDP attach 失败，已降级（对话框拦截 / 请求改写不可用；关闭 DevTools 或重开浏览器面板可恢复）: ' +
              cdpLastError
          );
          return null;
        }
      }
    }
    cdpWc = wc;
    bindCdpMessage(wc);
    await wc.debugger.sendCommand('Page.enable').catch(() => {});
    // 重新 attach 后 CDP 覆盖会丢失（切标签 / 外部 debugger detach），把已记录的仿真状态重放回去
    replayEmulationOn(wc).catch(() => {});
    if (routeRules.some((r) => r.enabled !== false)) {
      try {
        await wc.debugger.sendCommand('Fetch.enable', {
          patterns: [{ urlPattern: '*', requestStage: 'Request' }]
        });
        fetchEnabled = true;
      } catch (e) {
        log('browser CDP Fetch.enable: ' + (e && e.message ? e.message : e));
      }
    }
    return wc.debugger;
  }

  function onCdpMessage(wc, method, params) {
    if (method === 'Page.javascriptDialogOpening') {
      handleDialogOpening(wc, params || {});
      return;
    }
    if (method === 'Page.javascriptDialogClosed') {
      pendingDialog = null;
      return;
    }
    if (method === 'Fetch.requestPaused') {
      resolvePausedRequest(wc, params || {}).catch(() => {});
    }
  }

  function handleDialogOpening(wc, params) {
    const row = {
      type: String(params.type || 'alert'),
      message: String(params.message || ''),
      defaultPrompt: String(params.defaultPrompt || ''),
      url: String(params.url || ''),
      ts: Date.now()
    };
    pendingDialog = row;
    dialogLog.push(row);
    if (dialogLog.length > 20) dialogLog.shift();
    if (dialogPolicy !== 'manual' && wc && !wc.isDestroyed() && wc.debugger.isAttached()) {
      const accept = dialogPolicy !== 'dismiss';
      wc.debugger
        .sendCommand('Page.handleJavaScriptDialog', {
          accept,
          promptText: row.type === 'prompt' ? row.defaultPrompt : undefined
        })
        .then(() => {
          row.handled = accept ? 'accept' : 'dismiss';
          if (pendingDialog === row) pendingDialog = null;
        })
        .catch((e) => {
          row.handleError = e && e.message ? e.message : String(e);
        });
    }
    emitState();
  }

  async function resolvePausedRequest(wc, params) {
    const requestId = params.requestId;
    if (!wc || wc.isDestroyed() || !wc.debugger.isAttached() || !requestId) return;
    const url = String((params.request && params.request.url) || '');
    const rule = routeRules.find((r) => r.enabled !== false && matchUrlPattern(r.urlPattern, url));
    const send = (method, payload) => wc.debugger.sendCommand(method, payload);
    try {
      if (!rule) {
        await send('Fetch.continueRequest', { requestId });
        return;
      }
      const headerList = toHeaderList(rule.headers);
      rule.hits = (rule.hits || 0) + 1;
      if (rule.type === 'abort') {
        await send('Fetch.failRequest', { requestId, errorReason: rule.errorReason || 'Failed' });
        return;
      }
      if (rule.type === 'fulfill') {
        const body = rule.body != null ? Buffer.from(String(rule.body), 'utf8').toString('base64') : '';
        await send('Fetch.fulfillRequest', {
          requestId,
          responseCode: Number(rule.status) || 200,
          responseHeaders: headerList.length
            ? headerList
            : [{ name: 'Content-Type', value: rule.contentType || 'application/json; charset=utf-8' }],
          body
        });
        return;
      }
      await send('Fetch.continueRequest', {
        requestId,
        headers: headerList.length ? headerList : undefined
      });
    } catch (e) {
      log('browser route resolve: ' + (e && e.message ? e.message : e));
      try {
        await send('Fetch.continueRequest', { requestId });
      } catch {
        // ignore
      }
    }
  }

  /** 对话框：list（默认）| handle | policy。 */
  async function dialog(args = {}) {
    const action = String(args.action || 'list').toLowerCase();
    if (action === 'policy') {
      const next = String(args.policy || 'auto').toLowerCase();
      dialogPolicy = ['auto', 'accept', 'dismiss', 'manual'].indexOf(next) >= 0 ? next : 'auto';
      return { ok: true, engine: 'browserview', action, policy: dialogPolicy };
    }
    if (action === 'handle') {
      const wc = cdpWc;
      if (!wc || wc.isDestroyed() || !wc.debugger.isAttached()) {
        return {
          ok: false,
          engine: 'browserview',
          action,
          ...cdpStatus(),
          error: cdpLastError
            ? `CDP 不可用，无法手动处理对话框：${cdpLastError}`
            : '当前没有可处理的对话框（CDP 未连接）'
        };
      }
      const accept = args.accept !== false;
      try {
        await wc.debugger.sendCommand('Page.handleJavaScriptDialog', {
          accept,
          promptText: args.promptText != null ? String(args.promptText) : undefined
        });
        if (pendingDialog) pendingDialog.handled = accept ? 'accept' : 'dismiss';
        pendingDialog = null;
        return { ok: true, engine: 'browserview', action, accepted: accept };
      } catch (e) {
        return { ok: false, engine: 'browserview', action, error: e && e.message ? e.message : String(e) };
      }
    }
    return {
      ok: true,
      engine: 'browserview',
      action: 'list',
      policy: dialogPolicy,
      pending: pendingDialog,
      count: dialogLog.length,
      dialogs: dialogLog.slice(-10),
      ...cdpStatus()
    };
  }

  /** 请求改写：list（默认）| add | remove | clear。 */
  async function route(args = {}) {
    const action = String(args.action || 'list').toLowerCase();
    const live = hasLiveView() ? view : null;
    const wc = live ? live.webContents : null;
    if (action === 'clear') {
      routeRules.length = 0;
      await disableFetchOnAllWcs();
      return { ok: true, engine: 'browserview', action, routes: [], interception: false };
    }
    if (action === 'remove') {
      const id = String(args.id || '');
      const idx = routeRules.findIndex((r) => r.id === id);
      if (idx < 0) return { ok: false, engine: 'browserview', action, error: '未找到规则 ' + id };
      routeRules.splice(idx, 1);
      if (!routeRules.length) await disableFetchOnAllWcs();
      return { ok: true, engine: 'browserview', action, removed: id, routes: routeRules, interception: fetchEnabled };
    }
    if (action === 'add') {
      const type = String(args.type || 'fulfill').toLowerCase();
      const rule = {
        id: 'route-' + routeSeq++,
        urlPattern: String(args.urlPattern || args.pattern || '*'),
        type: ['abort', 'fulfill', 'continue', 'modifyHeaders'].indexOf(type) >= 0 ? type : 'fulfill',
        status: args.status != null ? Number(args.status) : undefined,
        body: args.body != null ? String(args.body) : undefined,
        headers: args.headers && typeof args.headers === 'object' ? args.headers : undefined,
        contentType: args.contentType ? String(args.contentType) : undefined,
        errorReason: args.errorReason ? String(args.errorReason) : undefined,
        enabled: true,
        hits: 0
      };
      routeRules.push(rule);
      const target = ensureView();
      await ensureCdp(target.webContents);
      return {
        ok: true,
        engine: 'browserview',
        action,
        added: rule,
        routes: routeRules,
        interception: fetchEnabled,
        ...cdpStatus(),
        note: fetchEnabled
          ? undefined
          : 'CDP 不可用，规则已保存但未生效；请关闭 DevTools 或重开浏览器面板后重试'
      };
    }
    if (wc && !wc.isDestroyed()) await ensureCdp(wc);
    return {
      ok: true,
      engine: 'browserview',
      action: 'list',
      routes: routeRules,
      interception: fetchEnabled,
      ...cdpStatus()
    };
  }

  function originOf(url) {
    try {
      return new URL(String(url || '')).origin;
    } catch {
      return '';
    }
  }

  /**
   * 重新下发已记录的仿真状态到指定 webContents。
   * CDP 覆盖是 per-webContents 且会在 detach 时清除，切标签/重新 attach 后需要重放，
   * 否则会出现「切回标签后视口/定位/时区悄悄失效」。幂等，无记录时零开销。
   */
  async function replayEmulationOn(wc) {
    if (!wc || wc.isDestroyed()) return;
    if (viewportOverride) {
      await applyViewportToWebContents(wc, viewportOverride).catch(() => {});
    }
    if (!wc.debugger || !wc.debugger.isAttached()) return;
    if (emulationState.geolocation) {
      await wc.debugger
        .sendCommand('Emulation.setGeolocationOverride', {
          latitude: emulationState.geolocation.latitude,
          longitude: emulationState.geolocation.longitude,
          accuracy: emulationState.geolocation.accuracy
        })
        .catch(() => {});
    }
    if (emulationState.timezone) {
      await wc.debugger
        .sendCommand('Emulation.setTimezoneOverride', { timezoneId: emulationState.timezone })
        .catch(() => {});
    }
    if (emulationState.locale) {
      await wc.debugger
        .sendCommand('Emulation.setLocaleOverride', { locale: emulationState.locale })
        .catch(() => {});
    }
    if (emulatedPermissions.size) {
      const origin = originOf(currentUrl);
      const cdpPerms = [...emulatedPermissions].filter(
        (p) => ['geolocation', 'notifications'].indexOf(p) >= 0
      );
      if (origin && cdpPerms.length) {
        await wc.debugger
          .sendCommand('Browser.grantPermissions', { origin, permissions: cdpPerms })
          .catch(() => {});
      }
    }
  }

  /**
   * 设备/权限模拟：set | reset | status。
   * geolocation / timezone / locale 走 CDP Emulation；permissions 同时影响 Electron 权限处理器。
   */
  async function emulate(args = {}) {
    const action = String(args.action || 'set').toLowerCase();
    const v = ensureView();
    const wc = v.webContents;
    const dbg = await ensureCdp(wc);
    const want = normalizeEmulation(args);

    if (action === 'reset') {
      emulatedPermissions.clear();
      emulationState = { geolocation: null, timezone: '', locale: '' };
      if (dbg) {
        await dbg.sendCommand('Emulation.clearGeolocationOverride').catch(() => {});
        await dbg.sendCommand('Emulation.setTimezoneOverride', { timezoneId: '' }).catch(() => {});
        await dbg.sendCommand('Emulation.setLocaleOverride', { locale: '' }).catch(() => {});
        await dbg.sendCommand('Browser.resetPermissions', {}).catch(() => {});
      }
      return { ok: true, engine: 'browserview', action, ...emulationState, cdpAvailable: !!dbg };
    }

    if (action === 'status') {
      return {
        ok: true,
        engine: 'browserview',
        action,
        ...emulationState,
        permissions: [...emulatedPermissions],
        cdpAvailable: !!dbg
      };
    }

    if (!dbg) {
      return {
        ok: false,
        engine: 'browserview',
        action,
        ...cdpStatus(),
        error: 'CDP 不可用，无法模拟设备/权限（请关闭 DevTools 或重开浏览器面板）'
      };
    }

    const applied = { geolocation: false, timezone: false, locale: false, permissions: 0 };
    const errors = [];

    if (want.geolocation) {
      try {
        await dbg.sendCommand('Emulation.setGeolocationOverride', {
          latitude: want.geolocation.latitude,
          longitude: want.geolocation.longitude,
          accuracy: want.geolocation.accuracy
        });
        applied.geolocation = true;
        emulationState.geolocation = { ...want.geolocation };
      } catch (e) {
        errors.push('geolocation: ' + (e && e.message ? e.message : e));
      }
    }
    if (want.timezone) {
      try {
        await dbg.sendCommand('Emulation.setTimezoneOverride', { timezoneId: want.timezone });
        applied.timezone = true;
        emulationState.timezone = want.timezone;
      } catch (e) {
        errors.push('timezone: ' + (e && e.message ? e.message : e));
      }
    }
    if (want.locale) {
      try {
        await dbg.sendCommand('Emulation.setLocaleOverride', { locale: want.locale });
        applied.locale = true;
        emulationState.locale = want.locale;
      } catch (e) {
        errors.push('locale: ' + (e && e.message ? e.message : e));
      }
    }
    if (want.permissions.length) {
      for (const name of want.permissions) emulatedPermissions.add(name);
      applied.permissions = want.permissions.length;
      const origin = originOf(currentUrl);
      const cdpPerms = want.permissions.filter((p) => ['geolocation', 'notifications'].indexOf(p) >= 0);
      if (origin && cdpPerms.length) {
        await dbg
          .sendCommand('Browser.grantPermissions', { origin, permissions: cdpPerms })
          .catch((e) => errors.push('grantPermissions: ' + (e && e.message ? e.message : e)));
      }
    }

    return {
      ok: errors.length === 0,
      engine: 'browserview',
      action,
      applied,
      errors: errors.length ? errors : undefined,
      ...emulationState,
      permissions: [...emulatedPermissions],
      cdpAvailable: true,
      note: want.permissions.length ? '权限模拟对已加载页面需 browser_reload 后生效' : undefined
    };
  }

  /**
   * 清掉模拟状态（不创建视图、不碰 debugger）。
   * 供切会话时调用，避免定位/权限模拟泄漏到另一个会话的页面上。
   */
  function resetEmulation() {
    emulatedPermissions.clear();
    emulationState = { geolocation: null, timezone: '', locale: '' };
    return { ok: true, engine: 'browserview' };
  }

  async function downloadStatus(args = {}) {
    const action = String(args.action || 'list').toLowerCase();
    if (action === 'clear') {
      downloads.length = 0;
      return { ok: true, engine: 'browserview', downloads: [] };
    }
    if (action === 'wait') {
      const completed = downloads.slice().reverse().find((d) => d.status === 'completed');
      if (completed) return { ok: true, engine: 'browserview', download: completed, downloads: downloads.slice(-20) };
      const timeoutMs = Math.min(120000, Math.max(500, Number(args.timeoutMs) || 30000));
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          const idx = downloadWaiters.findIndex((w) => w.resolve === resolve);
          if (idx >= 0) downloadWaiters.splice(idx, 1);
          resolve({ ok: false, engine: 'browserview', timeout: true, downloads: downloads.slice(-20) });
        }, timeoutMs);
        downloadWaiters.push({ resolve, timer });
      });
    }
    return { ok: true, engine: 'browserview', downloads: downloads.slice(-20) };
  }

  async function uploadFile(args = {}) {
    ensureView();
    const filePath = String(args.filePath || '').trim();
    if (!filePath) {
      const err = new Error('browser_upload_file 需要 filePath');
      err.code = 'FILE_REQUIRED';
      throw err;
    }
    const bytes = fs.readFileSync(filePath);
    const result = await evaluate(buildUploadFileScript({
      ref: args.ref,
      selector: args.selector,
      fileName: path.basename(filePath),
      mime: args.mime || guessMime(filePath),
      base64: bytes.toString('base64')
    }));
    return { ok: !!result?.ok, engine: 'browserview', path: filePath, ...result };
  }

  async function observe(opts = {}) {
    const snap = await snapshot({
      interactive: opts.interactive !== false,
      maxElements: opts.maxElements,
      delayMs: opts.delayMs
    });
    let shot = null;
    let shotError = '';
    if (opts.screenshot !== false) {
      try {
        shot = await screenshot({ fullPage: !!opts.fullPage });
      } catch (e) {
        shotError = e && e.message ? e.message : String(e);
        log('browser observe screenshot: ' + shotError);
      }
    }
    const blankWarning = (shot?.renderHealth || snap.renderHealth || lastRenderHealth)?.likelyBlank
      ? 'BrowserView 画面疑似全黑；如果不是页面自身黑色背景，请改用 engine=playwright。'
      : '';
    const shotWarning = shotError
      ? `截图失败（页面文本与 refs 仍可用）: ${shotError}`
      : '';
    return {
      ok: true,
      engine: 'browserview',
      url: snap.url || currentUrl,
      title: snap.title || currentTitle,
      textPreview: snap.textPreview || '',
      elements: snap.elements || [],
      refEpoch: snap.refEpoch,
      screenshot: shot
        ? { mime: shot.mime, base64: shot.base64, width: shot.width, height: shot.height }
        : null,
      viewport: bounds ? { width: bounds.width, height: bounds.height } : null,
      renderHealth: shot?.renderHealth || snap.renderHealth || lastRenderHealth,
      warning: shotWarning || blankWarning || undefined,
      note: 'observe 同时返回页面文本、可交互 ref 与截图；页面变化后 ref 需重新获取'
    };
  }

  function waitQuiet(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function waitForNavigation(wc, timeoutMs = 60000) {
    const ms = Math.min(120000, Math.max(1000, Number(timeoutMs) || 60000));
    return new Promise((resolve, reject) => {
      if (!wc || wc.isDestroyed()) {
        reject(new Error('浏览器视图不可用'));
        return;
      }
      if (!wc.isLoading()) {
        resolve();
        return;
      }
      let timer = null;
      const cleanup = () => {
        if (timer) clearTimeout(timer);
        wc.removeListener('did-stop-loading', onStop);
        wc.removeListener('did-fail-load', onFail);
      };
      const onStop = () => {
        cleanup();
        resolve();
      };
      const onFail = () => {
        cleanup();
        resolve();
      };
      timer = setTimeout(() => {
        cleanup();
        reject(Object.assign(new Error('导航超时'), { code: 'NAV_TIMEOUT' }));
      }, ms);
      wc.once('did-stop-loading', onStop);
      wc.once('did-fail-load', onFail);
    });
  }

  async function capturePageImage(wc, opts = {}) {
    const tryOnce = async () => {
      if (opts.clip && typeof opts.clip === 'object') {
        return wc.capturePage({
          x: Math.round(opts.clip.x || 0),
          y: Math.round(opts.clip.y || 0),
          width: Math.max(1, Math.round(opts.clip.width || 1)),
          height: Math.max(1, Math.round(opts.clip.height || 1))
        });
      }
      if (!opts.fullPage) {
        return wc.capturePage();
      }
      let attachedHere = false;
      try {
        if (!wc.debugger.isAttached()) {
          wc.debugger.attach('1.3');
          attachedHere = true;
        }
        await wc.debugger.sendCommand('Page.enable');
        const metrics = await wc.debugger.sendCommand('Page.getLayoutMetrics');
        const width = Math.max(1, Math.ceil(metrics?.contentSize?.width || 0));
        const height = Math.max(1, Math.ceil(metrics?.contentSize?.height || 0));
        const { data } = await wc.debugger.sendCommand('Page.captureScreenshot', {
          format: 'png',
          captureBeyondViewport: true,
          clip: { x: 0, y: 0, width, height, scale: 1 }
        });
        return nativeImage.createFromBuffer(Buffer.from(data, 'base64'));
      } catch (e) {
        log('browser fullPage CDP fallback to viewport: ' + (e && e.message ? e.message : String(e)));
        return wc.capturePage();
      } finally {
        if (attachedHere && wc.debugger.isAttached()) {
          try {
            wc.debugger.detach();
          } catch {
            // ignore
          }
        }
      }
    };
    let lastErr = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        if (attempt > 0) {
          await ensurePaintableSurface();
          await waitQuiet(160 * attempt);
        }
        return await tryOnce();
      } catch (e) {
        lastErr = e;
        if (!isBrowserCaptureSurfaceError(e)) throw e;
        log('browser capture retry ' + (attempt + 1) + ': ' + (e && e.message ? e.message : String(e)));
      }
    }
    throw lastErr;
  }

  /** 把视口覆盖下发到指定 webContents（CDP Emulation）。 */
  async function applyViewportToWebContents(wc, size) {
    if (!wc || wc.isDestroyed()) return false;
    if (!wc.debugger.isAttached()) {
      try {
        wc.debugger.attach('1.3');
      } catch (e) {
        const err = new Error('无法覆盖视口（调试器附加失败）：' + (e && e.message ? e.message : e));
        err.code = 'VIEWPORT_FAILED';
        throw err;
      }
    }
    try {
      await wc.debugger.sendCommand('Emulation.setDeviceMetricsOverride', {
        width: size.width,
        height: size.height,
        deviceScaleFactor: size.deviceScaleFactor,
        mobile: size.mobile
      });
    } catch (e) {
      const err = new Error('设置视口失败：' + (e && e.message ? e.message : e));
      err.code = 'VIEWPORT_FAILED';
      throw err;
    }
    return true;
  }

  async function clearViewportOnWebContents(wc) {
    if (!wc || wc.isDestroyed()) return;
    if (!wc.debugger.isAttached()) return;
    try {
      await wc.debugger.sendCommand('Emulation.clearDeviceMetricsOverride');
    } catch {
      // ignore
    }
  }

  /**
   * 覆盖布局视口（设备仿真）。
   * 注意：CDP 覆盖在 debugger detach 后会被清除，所以这里保持 attached，
   * 直到 reset 时 clearOverride + detach；其他 withDebugger 调用不会误 detach。
   */
  async function setViewport(args = {}) {
    const v = ensureView();
    const wc = v.webContents;

    if (args.reset) {
      // 只清覆盖，不 detach：debugger 可能还挂着 console 的 init script
      await clearViewportOnWebContents(wc);
      viewportOverride = null;
      emitState();
      return { ok: true, engine: 'browserview', viewport: null, reset: true };
    }

    const size = normalizeViewport(args);
    if (!size) {
      const err = new Error('browser_viewport 需要合法的 width 与 height');
      err.code = 'VIEWPORT_REQUIRED';
      throw err;
    }
    await applyViewportToWebContents(wc, size);
    viewportOverride = { ...size };
    emitState();
    return { ok: true, engine: 'browserview', viewport: { ...viewportOverride } };
  }

  /**
   * 只记状态：绝不创建视图，命中已有视图才下发。
   * 供 service 在「另一个引擎」上镜像视口设置 —— 等该引擎真正被启用
   * （新建视图时由 ensureView 重放）再生效，避免 auto 中途换引擎后尺寸失配。
   */
  async function stageViewport(args = {}) {
    if (args.reset) {
      viewportOverride = null;
      if (hasLiveView()) await clearViewportOnWebContents(view.webContents);
      emitState();
      return { ok: true, engine: 'browserview', viewport: null, reset: true, staged: true };
    }
    const size = normalizeViewport(args);
    if (!size) {
      const err = new Error('browser_viewport 需要合法的 width 与 height');
      err.code = 'VIEWPORT_REQUIRED';
      throw err;
    }
    viewportOverride = { ...size };
    const applied = hasLiveView() ? await applyViewportToWebContents(view.webContents, size) : false;
    emitState();
    return {
      ok: true,
      engine: 'browserview',
      viewport: { ...size },
      staged: true,
      applied
    };
  }

  /** 只清视口状态，不创建视图、不碰 debugger（供切会话时调用）。 */
  async function resetViewport() {
    viewportOverride = null;
    if (!hasLiveView()) return { ok: true, engine: 'browserview', viewport: null, reset: true };
    const wc = view.webContents;
    if (wc.debugger.isAttached()) {
      try {
        await wc.debugger.sendCommand('Emulation.clearDeviceMetricsOverride');
      } catch {
        // ignore
      }
    }
    emitState();
    return { ok: true, engine: 'browserview', viewport: null, reset: true };
  }

  function setPanelState(state = {}) {
    const nextOpen = state.open !== undefined ? state.open : state.visible;
    if (nextOpen !== undefined) panelOpen = !!nextOpen;
    if (state.bounds && typeof state.bounds === 'object') {
      bounds = {
        x: Number(state.bounds.x) || 0,
        y: Number(state.bounds.y) || 0,
        width: Number(state.bounds.width) || 0,
        height: Number(state.bounds.height) || 0
      };
    }
    applyBounds();
    if (panelOpen) scheduleRenderProbe('panel-open', 450);
    emitState();
    return { ok: true, panelOpen };
  }

  function status() {
    return {
      ok: true,
      engine: 'browserview',
      url: currentUrl,
      title: currentTitle,
      loading,
      panelOpen,
      hasView: hasLiveView(),
      bounds,
      loadError: lastLoadError,
      renderHealth: lastRenderHealth,
      viewport: viewportOverride,
      emulation: { ...emulationState, permissions: [...emulatedPermissions] },
      cdp: cdpStatus()
    };
  }

  function close() {
    const win = getWin();
    persistActiveTab();
    for (const [, entry] of tabEntries) {
      const tabView = entry.view;
      if (!tabView || tabView.webContents.isDestroyed()) continue;
      try {
        if (win && !win.isDestroyed() && win.getBrowserView() === tabView) win.removeBrowserView(tabView);
        tabView.webContents.destroy();
      } catch (e) {
        log('browser tab destroy: ' + (e && e.message ? e.message : e));
      }
    }
    tabEntries.clear();
    activeTabId = null;
    const v = view;
    view = null;
    loading = false;
    currentUrl = '';
    currentTitle = '';
    // 视图销毁后 CDP 覆盖物理失效，但覆盖状态要保留（与 Playwright 侧一致）：
    // 下次创建视图时由 ensureView 重放，避免"关浏览器再打开"后退回面板尺寸而与状态不符。
    // 需要显式清掉时走 resetViewport（切会话、browser_viewport reset 都会调用）。
    consoleInitScriptWc = null;
    consoleInitScriptId = null;
    cdpDetach();
    cdpFailedWc = null;
    cdpLastError = '';
    const wc = viewWebContents(v);
    if (wc && !wc.isDestroyed()) {
      try {
        if (win && !win.isDestroyed()) win.removeBrowserView(v);
        wc.destroy();
      } catch (e) {
        log('browser view destroy: ' + (e && e.message));
      }
    }
    emitState();
    return { ok: true };
  }

  async function a11ySnapshot(opts = {}) {
    const v = ensureView();
    const delayMs = Math.min(10000, Math.max(0, Number(opts.delayMs) || 0));
    if (delayMs) await waitQuiet(delayMs);
    const result = await a11ySnapshotBrowserView(v.webContents, opts, (maxNodes) =>
      evaluate(buildA11yDomScanScript({ maxNodes }))
    );
    return {
      ...result,
      url: currentUrl,
      title: currentTitle,
      note: 'a11y 树列出可访问性角色与名称；复杂页面可配合 browser_snapshot 的 ref 点击'
    };
  }

  function network(args = {}) {
    if (String(args.action || 'list').toLowerCase() === 'clear') {
      networkJournal.clear();
      return { ok: true, engine: 'browserview', cleared: true };
    }
    const entries = networkJournal.list(args);
    return {
      ok: true,
      engine: 'browserview',
      ...summarizeHarEntries(entries),
      stats: networkJournal.status()
    };
  }

  function consoleMessages(args = {}) {
    if (String(args.action || 'list').toLowerCase() === 'clear') {
      consoleJournal.clear();
      return { ok: true, engine: 'browserview', cleared: true };
    }
    const entries = consoleJournal.list(args);
    return {
      ok: true,
      engine: 'browserview',
      ...summarizeConsoleEntries(entries),
      stats: consoleJournal.status()
    };
  }

  function onWindowResize() {
    try {
      applyBounds();
    } catch (e) {
      log('browser resize: ' + (e && e.message ? e.message : String(e)));
    }
  }

  return {
    navigate,
    snapshot,
    click,
    typeText,
    fill,
    selectOption,
    scroll,
    pressKey,
    screenshot,
    pdf,
    evaluateScript,
    waitFor,
    tabs,
    downloads: downloadStatus,
    dialog,
    route,
    emulate,
    resetEmulation,
    uploadFile,
    observe,
    reload,
    goBack,
    goForward,
    importLocalStorage,
    readLocalStorage,
    expect,
    hover,
    drag,
    a11ySnapshot,
    network,
    consoleMessages,
    setViewport,
    stageViewport,
    resetViewport,
    setPanelState,
    status,
    close,
    hideForOverlay,
    restoreAfterOverlay,
    onWindowResize,
    requestAutoOpenPanel,
    activateSession,
    getActivePartitionSessionId
  };
}

module.exports = { createBrowserViewController, assertHttpUrl, isBrowserCaptureSurfaceError };
