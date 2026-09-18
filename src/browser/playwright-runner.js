'use strict';

const fs = require('fs/promises');
const path = require('path');

const {
  buildSnapshotScript,
  buildClickPrepareScript,
  buildClickPrepareScriptBySelector,
  buildTypePrepareScript,
  buildTypePrepareScriptBySelector,
  buildWaitConditionScript,
  normalizeSnapshotMode
} = require('./snapshot-script');
const {
  normalizeFrameSpec,
  isMainFrameSpec,
  describeFrameSpec,
  frameDescriptorMatches,
  summarizeFramesForHint,
  buildAnnotateScript,
  buildClearAnnotationScript
} = require('./frame-script');
const {
  createTimelineJournal,
  summarizeTimeline,
  buildTimelineRecorderScript,
  TIMELINE_BINDING
} = require('./timeline');
const { assertBrowserLoadUrl, matchUrlPattern } = require('./url-policy');
const { syncElectronCookiesToPlaywrightContext } = require('./session-sync');
const {
  buildSelectOptionScript,
  buildImportLocalStorageScript,
  buildReadLocalStorageScript,
  normalizeModifiers
} = require('./snapshot-script');
const { a11ySnapshotPlaywright } = require('./a11y');
const { createNetworkJournal, summarizeHarEntries } = require('./network-collector');
const {
  createConsoleJournal,
  summarizeConsoleEntries,
  classifyConsoleEntry
} = require('./console-collector');
const { normalizeViewport, VIEWPORT_DEFAULT, normalizeEmulation } = require('./viewport');
const { buildExpectScript } = require('./expect');
const { buildEvaluateScript, buildExpressionProbeScript, normalizeEvaluateResult } = require('./evaluate');

/**
 * Playwright 后备引擎：优先使用本机 Chrome / Edge（playwright-core，不随安装包下载 Chromium）。
 */
function createPlaywrightRunner(deps = {}) {
  const log = deps.log || (() => {});
  const networkJournal = deps.networkJournal || createNetworkJournal();
  const consoleJournal = deps.consoleJournal || createConsoleJournal();
  const timelineJournal = deps.timelineJournal || createTimelineJournal();
  /** @type {import('playwright-core').Browser | null} */
  let browser = null;
  /** @type {Map<string, {
   *   context: import('playwright-core').BrowserContext,
   *   page: import('playwright-core').Page,
   *   lastSessionSyncAt: number,
   *   lastSessionSyncUrl: string
   * }>} */
  const sessions = new Map();
  let activeSessionId = '__default__';
  // ── 对话框 / 请求改写状态（与 BrowserView 侧同构） ──
  const dialogLog = [];
  const routeRulesPw = [];
  const emulationRuntime = { geolocation: null, timezone: '', locale: '', permissions: [] };
  let dialogPolicy = 'auto';
  let pendingDialog = null;
  let pendingDialogRef = null;
  let routeSeqPw = 0;
  const routedContexts = new WeakSet();
  let headless = deps.headless !== false;
  /** @type {string|null} */
  let launchChannel = null;
  /** 视口覆盖（Playwright 只能改尺寸；mobile/DSF 需重建上下文） */
  let viewportOverride = null;
  let downloadSeq = 0;
  const downloads = [];

  function resolveSessionKey(opts = {}) {
    if (opts.sessionId != null && String(opts.sessionId).trim()) {
      return String(opts.sessionId).trim();
    }
    return activeSessionId || '__default__';
  }

  function partitionSessionIdForKey(key) {
    return key && key !== '__default__' ? key : null;
  }

  function getActivePage() {
    const entry = sessions.get(activeSessionId || '__default__');
    return entry && entry.page && !entry.page.isClosed() ? entry.page : null;
  }

  async function syncSessionFromElectron(targetUrl, maybeOpts = {}) {
    const opts = typeof maybeOpts === 'object' && maybeOpts ? maybeOpts : {};
    const key = resolveSessionKey(opts);
    const entry = sessions.get(key);
    if (!entry || !entry.context) return { synced: 0, skipped: true };
    const url =
      typeof targetUrl === 'string'
        ? targetUrl
        : entry.page && !entry.page.isClosed()
          ? entry.page.url()
          : '';
    const now = Date.now();
    if (url && url === entry.lastSessionSyncUrl && now - entry.lastSessionSyncAt < 5000) {
      return { synced: 0, cached: true };
    }
    const r = await syncElectronCookiesToPlaywrightContext(entry.context, {
      url: url || undefined,
      sessionId: partitionSessionIdForKey(key),
      log
    });
    entry.lastSessionSyncAt = now;
    entry.lastSessionSyncUrl = url || '';
    return r;
  }

  function loadPlaywright() {
    try {
      return require('playwright-core');
    } catch {
      try {
        return require('playwright');
      } catch {
        const err = new Error(
          'Playwright 模块缺失。请重新安装叠云 Agent，或在开发目录执行 npm install'
        );
        err.code = 'PLAYWRIGHT_MISSING';
        throw err;
      }
    }
  }

  function platformChannels() {
    if (process.platform === 'win32') return ['msedge', 'chrome'];
    if (process.platform === 'darwin') return ['chrome', 'msedge'];
    return ['chrome', 'msedge'];
  }

  async function launchBrowser(pw) {
    const attempts = [];
    for (const channel of platformChannels()) {
      try {
        log(`Playwright 尝试启动: ${channel}`);
        const b = await pw.chromium.launch({ headless, channel });
        launchChannel = channel;
        return b;
      } catch (e) {
        attempts.push(`${channel}: ${e.message || String(e)}`);
      }
    }
    try {
      log('Playwright 尝试启动: 内置 Chromium');
      const b = await pw.chromium.launch({ headless });
      launchChannel = 'chromium';
      return b;
    } catch (e) {
      attempts.push(`chromium: ${e.message || String(e)}`);
    }
    const err = new Error(
      'Playwright 无法启动浏览器。请安装 Microsoft Edge 或 Google Chrome；开发环境可执行: npx playwright install chromium\n' +
        attempts.map((x) => `· ${x}`).join('\n')
    );
    err.code = 'PLAYWRIGHT_LAUNCH_FAILED';
    throw err;
  }

  async function ensureHeadlessMode(opts = {}) {
    let desired = headless;
    if (opts.headed === true) desired = false;
    else if (opts.headed === false) desired = true;
    else if (opts.headless != null) desired = !!opts.headless;
    if (browser && browser.isConnected() && desired !== headless) {
      await close();
    }
    headless = desired;
  }

  /** 把已记录的视口覆盖应用到指定页面（无覆盖则不动）。 */
  async function applyViewportToPage(page) {
    if (!viewportOverride || !page || page.isClosed()) return false;
    try {
      await page.setViewportSize({ width: viewportOverride.width, height: viewportOverride.height });
      return true;
    } catch {
      return false;
    }
  }

  /** 把尺寸下发到所有已存在的页面（绝不创建页面/上下文）。 */
  async function applyViewportToLivePages(size) {
    for (const [, entry] of sessions) {
      const page = entry && entry.page;
      if (!page || page.isClosed()) continue;
      try {
        await page.setViewportSize({ width: size.width, height: size.height });
      } catch {
        // ignore
      }
    }
  }

  async function ensurePage(opts = {}) {
    await ensureHeadlessMode(opts);
    const key = resolveSessionKey(opts);
    let entry = sessions.get(key);
    if (entry && entry.page && !entry.page.isClosed() && browser && browser.isConnected()) {
      return entry.page;
    }

    if (entry && entry.page && !entry.page.isClosed()) {
      try {
        await entry.page.close();
      } catch {
        // ignore
      }
    }
    if (entry && entry.context) {
      try {
        await entry.context.close();
      } catch {
        // ignore
      }
    }

    const pw = loadPlaywright();
    if (!browser || !browser.isConnected()) {
      for (const [, e] of sessions) {
        if (e.context) {
          try {
            await e.context.close();
          } catch {
            // ignore
          }
        }
      }
      sessions.clear();
      if (browser) {
        try {
          await browser.close();
        } catch {
          // ignore
        }
      }
      browser = await launchBrowser(pw);
    }

    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      locale: emulationRuntime.locale || 'zh-CN',
      timezoneId: emulationRuntime.timezone || undefined,
      ignoreHTTPSErrors: true,
      acceptDownloads: true,
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    });
    if (emulationRuntime.geolocation) {
      await context.setGeolocation(emulationRuntime.geolocation).catch(() => {});
    }
    if (emulationRuntime.permissions.length) {
      await context.grantPermissions(emulationRuntime.permissions).catch(() => {});
    }
    // 页面侧事件时间线：init script 负责挂监听，binding 负责把事件送回 Node
    await context.addInitScript({ content: buildTimelineRecorderScript() }).catch((e) => {
      log('playwright timeline init script: ' + (e && e.message ? e.message : e));
    });
    await context
      .exposeBinding(TIMELINE_BINDING, (_source, payload) => {
        timelineJournal.addBindingPayload(payload);
      })
      .catch((e) => {
        log('playwright timeline binding: ' + (e && e.message ? e.message : e));
      });
    context.on('page', (p) => {
      const e = sessions.get(key);
      if (e) e.page = p;
      applyViewportToPage(p).catch(() => {});
      attachPageEvents(p);
    });
    await applyRoutesToContext(context);
    const page = await context.newPage();
    await applyViewportToPage(page);
    attachPageEvents(page);
    entry = {
      context,
      page,
      lastSessionSyncAt: 0,
      lastSessionSyncUrl: '',
      /** ref id → 所属 frame 路径（snapshot 时登记，跨域 iframe 里的 ref 靠它点得中） */
      refFrames: new Map()
    };
    sessions.set(key, entry);
    await syncSessionFromElectron(opts.url || '', { ...opts, sessionId: key === '__default__' ? opts.sessionId : key });
    return page;
  }

  function activateSession(sessionId) {
    activeSessionId = sessionId ? String(sessionId).trim() : '__default__';
  }

  async function closeSession(sessionId) {
    const key = sessionId ? String(sessionId).trim() : activeSessionId || '__default__';
    const entry = sessions.get(key);
    if (!entry) return { ok: true };
    try {
      if (entry.page && !entry.page.isClosed()) await entry.page.close();
    } catch {
      // ignore
    }
    try {
      if (entry.context) await entry.context.close();
    } catch {
      // ignore
    }
    sessions.delete(key);
    return { ok: true };
  }

  function attachPageEvents(p) {
    if (!p || p.__dieyunEventsAttached) return;
    p.__dieyunEventsAttached = true;
    const pending = new WeakMap();
    p.on('console', (msg) => {
      let classified;
      try {
        classified = classifyConsoleEntry(msg.type(), msg.text());
      } catch {
        return;
      }
      const loc = typeof msg.location === 'function' ? msg.location() : null;
      consoleJournal.add({
        engine: 'playwright',
        source: classified.source,
        level: classified.level,
        text: classified.text,
        url: (loc && loc.url) || p.url(),
        line: loc && loc.lineNumber
      });
    });
    p.on('framenavigated', (frame) => {
      try {
        if (frame !== p.mainFrame()) return;
        recordTimeline('navigate', { url: frame.url() || p.url(), reason: 'page' });
      } catch {
        // ignore
      }
    });
    p.on('pageerror', (err) => {
      consoleJournal.add({
        engine: 'playwright',
        source: 'pageerror',
        level: 'error',
        text: (err && err.message) || String(err || 'pageerror'),
        url: p.url()
      });
    });
    p.on('dialog', (dlg) => {
      const row = {
        type: typeof dlg.type === 'function' ? dlg.type() : 'alert',
        message: typeof dlg.message === 'function' ? dlg.message() : '',
        defaultPrompt: typeof dlg.defaultValue === 'function' ? dlg.defaultValue() : '',
        ts: Date.now()
      };
      pendingDialog = row;
      pendingDialogRef = dlg;
      dialogLog.push(row);
      if (dialogLog.length > 20) dialogLog.shift();
      if (dialogPolicy === 'manual') return;
      const accept = dialogPolicy !== 'dismiss';
      const act = accept ? dlg.accept(row.type === 'prompt' ? row.defaultPrompt : undefined) : dlg.dismiss();
      Promise.resolve(act)
        .then(() => {
          row.handled = accept ? 'accept' : 'dismiss';
          if (pendingDialog === row) pendingDialog = null;
          if (pendingDialogRef === dlg) pendingDialogRef = null;
        })
        .catch((e) => {
          row.handleError = e && e.message ? e.message : String(e);
        });
    });
    p.on('request', (req) => {
      pending.set(req, { ts: Date.now() });
    });
    p.on('requestfailed', (req) => {
      const meta = pending.get(req) || {};
      pending.delete(req);
      networkJournal.add({
        engine: 'playwright',
        method: req.method(),
        url: req.url(),
        failed: true,
        error: req.failure()?.errorText || 'request failed',
        resourceType: req.resourceType(),
        durationMs: meta.ts ? Date.now() - meta.ts : undefined
      });
    });
    p.on('response', (res) => {
      const req = res.request();
      const meta = pending.get(req) || {};
      pending.delete(req);
      const status = res.status();
      networkJournal.add({
        engine: 'playwright',
        method: req.method(),
        url: res.url(),
        status,
        statusText: res.statusText(),
        resourceType: req.resourceType(),
        durationMs: meta.ts ? Date.now() - meta.ts : undefined,
        failed: status >= 400
      });
    });
    p.on('download', async (download) => {
      const id = `pw-dl-${++downloadSeq}`;
      const suggested = download.suggestedFilename ? download.suggestedFilename() : `download-${downloadSeq}`;
      const row = {
        id,
        status: 'in_progress',
        url: download.url ? download.url() : '',
        fileName: suggested,
        path: '',
        startedAt: Date.now(),
        completedAt: null,
        error: null
      };
      downloads.push(row);
      try {
        row.path = await download.path();
        row.status = 'completed';
      } catch (e) {
        row.status = 'failed';
        row.error = e && e.message ? e.message : String(e);
      } finally {
        row.completedAt = Date.now();
      }
    });
  }
  async function navigate(url, opts = {}) {
    const safeUrl = assertBrowserLoadUrl(url);
    const p = await ensurePage(opts);
    await syncSessionFromElectron(safeUrl);
    await p.goto(safeUrl, {
      waitUntil: opts.waitUntil === 'domcontentloaded' ? 'domcontentloaded' : 'load',
      timeout: Number(opts.timeoutMs) || 60000
    });
    recordTimeline('navigate', { url: p.url(), reason: 'navigate' });
    return {
      ok: true,
      url: p.url(),
      title: await p.title(),
      engine: 'playwright',
      headless,
      channel: launchChannel
    };
  }

  /** 事件时间线（page 侧真实事件 + Agent 侧动作）。 */
  function timeline(args = {}) {
    const action = String(args.action || 'list').toLowerCase();
    if (action === 'clear') {
      timelineJournal.clear();
      return { ok: true, engine: 'playwright', cleared: true };
    }
    const entries = timelineJournal.list(args);
    return {
      ok: true,
      engine: 'playwright',
      channel: launchChannel,
      ...summarizeTimeline(entries, { includeInput: args.includeInput === true }),
      stats: timelineJournal.status()
    };
  }

  /** 子 frame 内采集到的相对路径 → 从顶层算起的绝对路径。 */
  function absFramePath(prefix, rel) {
    const base = String(prefix || 'main');
    const r = String(rel == null || rel === '' ? 'main' : rel);
    if (base === 'main') return r;
    return r === 'main' ? base : `${base}.${r}`;
  }

  /**
   * snapshot：逐 frame 采集（跨域 iframe 也进得去），ref 全局唯一并登记所属 frame，
   * 这样 click({ref}) 能自动回到正确的 frame，不需要模型自己算 frame 路径。
   */
  async function snapshot(opts = {}) {
    const p = await ensurePage(opts);
    const delayMs = Math.min(10000, Math.max(0, Number(opts.delayMs) || 0));
    if (delayMs) await p.waitForTimeout(delayMs);
    const mode = normalizeSnapshotMode(opts.mode, opts);
    const maxElements = Number(opts.maxElements) > 0 ? Number(opts.maxElements) : 120;
    const spec = normalizeFrameSpec(opts.frame);
    const list = frameListOf(p);
    let targets = list;
    if (!isMainFrameSpec(spec)) {
      const hit = resolveFrameTarget(p, spec);
      if (!hit.ok) return { ok: false, engine: 'playwright', channel: launchChannel, ...hit };
      targets = [hit.entry];
    }
    const perFrame = Math.max(20, Math.ceil(maxElements / Math.max(1, targets.length)));
    const elements = [];
    const refFrames = new Map();
    const blockedIframes = [];
    const frames = [];
    let textPreview = '';
    let refEpoch = 0;
    let coverage = null;
    let offset = 0;
    for (const entry of targets) {
      // eslint-disable-next-line no-await-in-loop
      const data = await entry.frame
        .evaluate(buildSnapshotScript({ mode, maxElements: perFrame, refOffset: offset, framePath: 'main' }))
        .catch(() => null);
      if (!data) {
        blockedIframes.push({ framePath: entry.path, src: entry.url, crossOrigin: false, error: 'evaluate failed' });
        continue;
      }
      refEpoch = Math.max(refEpoch, Number(data.refEpoch) || 0);
      const rows = Array.isArray(data.elements) ? data.elements : [];
      for (const row of rows) {
        const framePath = absFramePath(entry.path, row.framePath);
        elements.push({ ...row, framePath, frame: framePath === 'main' ? 'main' : 'iframe' });
        refFrames.set(row.ref, { path: framePath, url: entry.url });
      }
      offset += rows.length;
      if (Array.isArray(data.blockedIframes)) {
        for (const b of data.blockedIframes) {
          blockedIframes.push({ ...b, framePath: absFramePath(entry.path, b.framePath) });
        }
      }
      if (Array.isArray(data.frames)) {
        for (const f of data.frames) frames.push({ ...f, path: absFramePath(entry.path, f.path) });
      }
      if (entry.main) textPreview = data.textPreview || '';
      if (!coverage || entry.main) coverage = data.coverage || coverage;
    }
    const entry = sessions.get(resolveSessionKey(opts));
    if (entry) entry.refFrames = refFrames;
    const omitted = coverage ? Number(coverage.omitted) || 0 : 0;
    return {
      ok: true,
      engine: 'playwright',
      channel: launchChannel,
      url: p.url(),
      title: await p.title().catch(() => ''),
      refEpoch,
      mode,
      framePath: isMainFrameSpec(spec) ? 'main' : targets[0].path,
      textPreview,
      elements,
      frames,
      blockedIframes,
      coverage,
      note:
        'ref 在本次 snapshot 内有效；页面跳转或再次 snapshot 后需重新获取' +
        (omitted ? `；另有 ${omitted} 个元素因 maxElements 未纳入` : '') +
        (targets.length > 1 ? `；已跨 ${targets.length} 个 frame 采集（跨域 iframe 也能进）` : '')
    };
  }

  async function resolveTarget(args = {}) {
    if (args.ref) return { kind: 'ref', value: String(args.ref) };
    if (args.selector) return { kind: 'selector', value: String(args.selector) };
    const err = new Error('需要提供 ref 或 selector');
    err.code = 'TARGET_REQUIRED';
    throw err;
  }

  /** Agent 侧动作写进时间线（与页面侧真实事件合流）。 */
  function recordTimeline(type, payload = {}) {
    try {
      timelineJournal.add({ type, source: 'agent', engine: 'playwright', ...payload });
    } catch {
      // 记录失败不影响主流程
    }
  }

  /**
   * frame 树：与 BrowserView 侧同一套 path 语义（文档顺序的点分下标），
   * 由 mainFrame + childFrames 递归得到，保证同一 frame 参数在两个引擎指向同一个 frame。
   */
  function frameListOf(page) {
    const out = [];
    const walk = (frame, path, depth) => {
      out.push({
        frame,
        path: depth === 0 ? 'main' : path,
        depth,
        main: depth === 0,
        name: (() => {
          try {
            return String(frame.name() || '');
          } catch {
            return '';
          }
        })(),
        url: (() => {
          try {
            return String(frame.url() || '');
          } catch {
            return '';
          }
        })()
      });
      const kids = typeof frame.childFrames === 'function' ? frame.childFrames() : [];
      for (let i = 0; i < kids.length; i++) {
        walk(kids[i], depth === 0 ? String(i) : `${path}.${i}`, depth + 1);
      }
    };
    walk(page.mainFrame(), 'main', 0);
    return out;
  }

  function frameDescriptorOf(entry) {
    return { main: entry.main, path: entry.path, name: entry.name, url: entry.url };
  }

  function sameOriginAs(a, b) {
    try {
      return new URL(String(a || '')).origin === new URL(String(b || '')).origin;
    } catch {
      return String(a || '') === String(b || '');
    }
  }

  /** frame 参数 → Playwright Frame（跨域同样可命中）。 */
  function resolveFrameTarget(page, spec) {
    const list = frameListOf(page);
    if (isMainFrameSpec(spec)) return { ok: true, entry: list[0], main: true, path: 'main' };
    for (const entry of list) {
      if (frameDescriptorMatches(frameDescriptorOf(entry), spec)) return { ok: true, entry, main: entry.main, path: entry.path };
    }
    return {
      ok: false,
      errorCode: 'FRAME_NOT_FOUND',
      error: `未找到匹配的 frame（${describeFrameSpec(spec)}）`,
      frames: summarizeFramesForHint(list.map(frameDescriptorOf), 16)
    };
  }

  async function listFrames() {
    const page = getActivePage();
    if (!page) return { ok: false, engine: 'playwright', error: '尚未打开页面，无法列出 frame', frames: [] };
    const list = frameListOf(page);
    const topUrl = page.url();
    const frames = list.map((f) => ({
      path: f.path,
      main: f.main,
      name: f.name,
      url: f.url,
      depth: f.depth,
      sameOrigin: f.main || sameOriginAs(topUrl, f.url),
      accessible: true,
      canEvaluate: true
    }));
    return {
      ok: true,
      engine: 'playwright',
      channel: launchChannel,
      source: 'playwright',
      url: topUrl,
      count: frames.length,
      crossOriginCount: frames.filter((f) => !f.sameOrigin).length,
      frames,
      note: 'Playwright 可进入任意 frame（含跨域）；path 可直接作为其它工具的 frame 参数'
    };
  }

  /**
   * 跨 frame 定位：主 frame 找不到元素时遍历子 frame（含跨域 iframe）。
   * 返回可用 locator 与命中 frame，避免"表单在 iframe 里就完全点不到"。
   */
  async function locateAcrossFrames(page, selector) {
    const main = page.locator(selector).first();
    if ((await main.count().catch(() => 0)) > 0) {
      return { locator: main, frame: page.mainFrame(), crossFrame: false, framePath: 'main' };
    }
    // 只走「主 frame 找不到」的失败路径；仍限制遍历上限，避免重广告页几十个 frame 时逐轮往返过慢
    const frames = page.frames().filter((f) => f !== page.mainFrame());
    const limit = Math.min(frames.length, 12);
    for (let i = 0; i < limit; i++) {
      const frame = frames[i];
      const loc = frame.locator(selector).first();
      if ((await loc.count().catch(() => 0)) > 0) return { locator: loc, frame, crossFrame: true, framePath: '' };
    }
    return { locator: main, frame: page.mainFrame(), crossFrame: false, framePath: 'main' };
  }

  function selectorForTarget(target) {
    return target.kind === 'ref'
      ? `[data-dieyun-ref="${String(target.value).replace(/"/g, '\\"')}"]`
      : String(target.value);
  }

  /**
   * 统一目标定位（frame 感知）：
   *   1) 显式 frame 参数最优先
   *   2) ref 优先用 snapshot 登记过的 frame（跨域 iframe 里的 ref 靠它才点得中）
   *   3) 兜底：主 frame 优先，再遍历子 frame
   */
  async function locateTarget(page, args, target) {
    const selector = selectorForTarget(target);
    const spec = normalizeFrameSpec(args && args.frame);
    if (!isMainFrameSpec(spec)) {
      const hit = resolveFrameTarget(page, spec);
      if (!hit.ok) return hit;
      return {
        ok: true,
        locator: hit.entry.frame.locator(selector).first(),
        frame: hit.entry.frame,
        framePath: hit.entry.path,
        crossFrame: !hit.entry.main
      };
    }
    if (target.kind === 'ref') {
      const entry = sessions.get(resolveSessionKey(args));
      const info = entry && entry.refFrames ? entry.refFrames.get(String(target.value)) : null;
      if (info && info.path && info.path !== 'main') {
        const list = frameListOf(page);
        const hit = list.find((f) => f.path === info.path);
        if (hit) {
          return {
            ok: true,
            locator: hit.frame.locator(selector).first(),
            frame: hit.frame,
            framePath: hit.path,
            crossFrame: true
          };
        }
      }
    }
    return locateAcrossFrames(page, selector);
  }

  /** 诊断：目标为什么点不到（frame 层级、可见性、遮挡者）。 */
  async function diagnoseTarget(page, args, primary) {
    const spec = normalizeFrameSpec(args && args.frame);
    const list = frameListOf(page);
    const out = {
      url: page.url(),
      requestedFrame: isMainFrameSpec(spec) ? 'main' : describeFrameSpec(spec),
      frames: summarizeFramesForHint(list.map(frameDescriptorOf), 16),
      reason: (primary && (primary.error || primary.errorCode)) || '目标不可用'
    };
    if (primary && primary.errorCode === 'FRAME_NOT_FOUND') return { ok: false, ...out };
    try {
      const target = await resolveTarget(args);
      const located = await locateTarget(page, args, target);
      if (!located.ok) return { ok: false, ...out };
      const loc = located.locator;
      const count = await loc.count().catch(() => 0);
      if (!count) return { ok: false, ...out, errorCode: 'TARGET_NOT_FOUND' };
      const box = await loc.boundingBox().catch(() => null);
      const visible = await loc.isVisible().catch(() => false);
      const occluder = await loc
        .evaluate((el) => {
          try {
            const r = el.getBoundingClientRect();
            const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
            if (!hit || hit === el || el.contains(hit) || hit.contains(el)) return null;
            return {
              tag: String(hit.tagName || '').toLowerCase(),
              id: String(hit.id || ''),
              class: typeof hit.className === 'string' ? hit.className.slice(0, 120) : ''
            };
          } catch (e) {
            return null;
          }
        })
        .catch(() => null);
      return {
        ok: true,
        ...out,
        framePath: located.framePath,
        target: { selector: target.kind === 'selector' ? String(target.value) : '', count },
        visible,
        rect: box ? { x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width), height: Math.round(box.height) } : null,
        occluded: !!occluder,
        occludedBy: occluder || undefined
      };
    } catch (e) {
      return { ok: false, ...out, reason: (e && e.message) || String(e) };
    }
  }

  async function click(args = {}) {
    const p = await ensurePage(args);
    const target = await resolveTarget(args);
    const button = args.button === 'right' ? 'right' : args.button === 'middle' ? 'middle' : 'left';
    const clickCount = Number(args.clickCount) >= 2 ? 2 : 1;
    const timeout = Number(args.timeoutMs) || 15000;
    const force = args.force === true;
    try {
      const located = await locateTarget(p, args, target);
      if (!located.ok) return { ok: false, engine: 'playwright', channel: launchChannel, ...located };
      await located.locator.click({ timeout, button, clickCount, force });
      recordTimeline('click', {
        ok: true,
        url: p.url(),
        target: { selector: target.kind === 'selector' ? String(target.value) : '', tag: '' },
        frame: located.framePath || 'main'
      });
      return {
        ok: true,
        engine: 'playwright',
        channel: launchChannel,
        button,
        clickCount,
        clickedVia: 'locator',
        framePath: located.framePath || 'main',
        crossFrame: located.crossFrame
      };
    } catch (e) {
      const diagnostics = await diagnoseTarget(p, args, { error: (e && e.message) || String(e) });
      recordTimeline('click', { ok: false, url: p.url(), error: (e && e.message) || String(e) });
      const err = new Error(
        `${(e && e.message) || '点击失败'}${
          diagnostics.occludedBy
            ? `（被 ${diagnostics.occludedBy.tag || ''}${diagnostics.occludedBy.id ? '#' + diagnostics.occludedBy.id : ''} 遮挡）`
            : ''
        }`
      );
      err.code = diagnostics.occludedBy ? 'TARGET_OCCLUDED' : 'CLICK_FAILED';
      err.diagnostics = diagnostics;
      err.suggestedFix = diagnostics.occludedBy
        ? '先关闭/收起遮挡层，或传 force=true 强行点击'
        : '用 browser_frames 确认 frame，或换 selector/ref';
      throw err;
    }
  }

  async function typeText(args = {}) {
    const p = await ensurePage(args);
    const text = String(args.text ?? '');
    const clear = args.clear === true;
    const timeout = Number(args.timeoutMs) || 15000;
    if (!args.ref && !args.selector) {
      const err = new Error('browser_type 需要 snapshot 返回的 ref 或 selector');
      err.code = 'TARGET_REQUIRED';
      throw err;
    }
    let located = null;
    try {
      const target = await resolveTarget(args);
      located = await locateTarget(p, args, target);
      if (!located.ok) {
        const err = new Error(located.error || '目标 frame/元素未找到');
        err.code = located.errorCode || 'TARGET_NOT_FOUND';
        err.diagnostics = located;
        throw err;
      }
      const loc = located.locator;
      if (clear) await loc.fill(text, { timeout });
      else await loc.pressSequentially(text, { timeout });
      let actual = '';
      try {
        actual = await loc.inputValue({ timeout: 2000 });
      } catch {
        actual = '';
      }
      const matched = actual === text || (!clear && String(actual).endsWith(text));
      if (actual !== '' && !matched) {
        throw new Error('locator fill value mismatch');
      }
      recordTimeline('type', {
        ok: true,
        url: p.url(),
        value: text,
        target: { selector: args.selector ? String(args.selector) : '', tag: '' },
        frame: located.framePath || 'main'
      });
      return {
        ok: true,
        engine: 'playwright',
        channel: launchChannel,
        filledVia: 'locator',
        framePath: located.framePath || 'main',
        crossFrame: located.crossFrame,
        matched: actual === '' || matched
      };
    } catch (e) {
      if (e && e.code && e.code !== 'CLICK_FAILED') throw e;
      const frame = located && located.ok ? located.frame : p.mainFrame();
      const result = args.ref
        ? await frame.evaluate(buildTypePrepareScript(JSON.stringify(String(args.ref)), JSON.stringify(text), clear))
        : await frame.evaluate(
            buildTypePrepareScriptBySelector(JSON.stringify(String(args.selector)), JSON.stringify(text), clear)
          );
      if (!result?.ok) {
        const diagnostics = await diagnoseTarget(p, args, { error: (result && result.error) || (e && e.message) });
        const err = new Error(`${result?.error || (e && e.message) || '输入失败'}`);
        err.code = 'TYPE_FAILED';
        err.diagnostics = diagnostics;
        throw err;
      }
      recordTimeline('type', { ok: true, url: p.url(), value: text, frame: located && located.framePath });
      return { ok: true, engine: 'playwright', channel: launchChannel, filledVia: 'js', ...result };
    }
  }

  async function fill(args = {}) {
    return typeText({ ...args, clear: true });
  }

  async function selectOption(args = {}) {
    const p = await ensurePage();
    await syncSessionFromElectron(p.url());
    const value = args.value != null ? String(args.value) : '';
    const label = args.label != null ? String(args.label) : '';
    if (!value && !label) {
      const err = new Error('browser_select_option 需要 value 或 label');
      err.code = 'TARGET_REQUIRED';
      throw err;
    }
    const target = await resolveTarget(args);
    const located = await locateTarget(p, args, target);
    if (!located.ok) return { ok: false, engine: 'playwright', channel: launchChannel, ...located };
    try {
      if (value) {
        await located.locator.selectOption(value, { timeout: Number(args.timeoutMs) || 15000 });
      } else {
        await located.locator.selectOption({ label }, { timeout: Number(args.timeoutMs) || 15000 });
      }
    } catch (e) {
      const framePath = located.framePath || 'main';
      const fallback = await (located.frame || p.mainFrame())
        .evaluate(
          buildSelectOptionScript(
            args.ref ? JSON.stringify(String(args.ref)) : '""',
            args.selector ? JSON.stringify(String(args.selector)) : '""',
            JSON.stringify(value),
            JSON.stringify(label)
          )
        )
        .catch(() => null);
      if (!fallback || !fallback.ok) {
        const err = new Error((fallback && fallback.error) || (e && e.message) || 'select 失败');
        err.code = 'SELECT_FAILED';
        err.diagnostics = await diagnoseTarget(p, args, { error: err.message });
        throw err;
      }
      recordTimeline('change', { ok: true, url: p.url(), value: value || label, frame: framePath });
      return { ok: true, engine: 'playwright', channel: launchChannel, ...fallback, filledVia: 'js' };
    }
    recordTimeline('change', {
      ok: true,
      url: p.url(),
      value: value || label,
      target: { selector: args.selector ? String(args.selector) : '', tag: 'select' },
      frame: located.framePath || 'main'
    });
    return {
      ok: true,
      engine: 'playwright',
      channel: launchChannel,
      value: value || undefined,
      label: label || undefined,
      framePath: located.framePath || 'main'
    };
  }

  async function scroll(args = {}) {
    const p = await ensurePage();
    const amount = Number(args.amount) || 400;
    const direction = String(args.direction || 'down');
    if (args.ref || args.selector) {
      const target = await resolveTarget(args);
      const sel = target.kind === 'ref' ? `[data-dieyun-ref="${target.value}"]` : target.value;
      await p.locator(sel).evaluate(
        (el, payload) => {
          el.scrollBy(payload.dx, payload.dy);
        },
        {
          dx: direction === 'left' ? -amount : direction === 'right' ? amount : 0,
          dy: direction === 'up' ? -amount : direction === 'down' ? amount : 0
        }
      );
    } else {
      await p.evaluate(
        ({ dx, dy }) => window.scrollBy(dx, dy),
        {
          dx: direction === 'left' ? -amount : direction === 'right' ? amount : 0,
          dy: direction === 'up' ? -amount : direction === 'down' ? amount : 0
        }
      );
    }
    return { ok: true, engine: 'playwright', channel: launchChannel };
  }

  const PLAYWRIGHT_MODIFIER_LABELS = { control: 'Control', shift: 'Shift', alt: 'Alt', meta: 'Meta' };

  function toPlaywrightKeyCombo(key, modifiers) {
    const parts = (modifiers || []).map((m) => PLAYWRIGHT_MODIFIER_LABELS[m]).filter(Boolean);
    const normalized = String(key || 'Enter');
    parts.push(normalized.length === 1 ? normalized.toUpperCase() : normalized);
    return parts.join('+');
  }

  async function pressKey(args = {}) {
    const p = await ensurePage();
    const key = String(args.key || 'Enter');
    const modifiers = normalizeModifiers(args.modifiers);
    const combo = toPlaywrightKeyCombo(key, modifiers);
    await p.keyboard.press(combo);
    return { ok: true, engine: 'playwright', key, modifiers, combo, channel: launchChannel };
  }

  async function hover(args = {}) {
    const p = await ensurePage(args);
    const target = await resolveTarget(args);
    const located = await locateTarget(p, args, target);
    if (!located.ok) return { ok: false, engine: 'playwright', channel: launchChannel, ...located };
    await located.locator.hover({ timeout: Number(args.timeoutMs) || 15000 });
    recordTimeline('hover', {
      ok: true,
      url: p.url(),
      target: { selector: target.kind === 'selector' ? String(target.value) : '', tag: '' },
      frame: located.framePath || 'main'
    });
    return {
      ok: true,
      engine: 'playwright',
      channel: launchChannel,
      selector: selectorForTarget(target),
      framePath: located.framePath || 'main',
      crossFrame: located.crossFrame
    };
  }

  async function drag(args = {}) {
    const p = await ensurePage(args);
    const target = await resolveTarget({ ref: args.ref, selector: args.selector });
    const locatedFrom = await locateTarget(p, args, target);
    if (!locatedFrom.ok) return { ok: false, engine: 'playwright', channel: launchChannel, ...locatedFrom };
    const loc = locatedFrom.locator;
    if (args.toRef || args.toSelector) {
      const to = await resolveTarget({ ref: args.toRef, selector: args.toSelector });
      const toSel = to.kind === 'ref' ? `[data-dieyun-ref="${to.value}"]` : to.value;
      await loc.dragTo(toSel, { timeout: Number(args.timeoutMs) || 15000 });
    } else {
      const dx = Number(args.dx) || 0;
      const dy = Number(args.dy) || 0;
      const box = await loc.boundingBox();
      if (!box) {
        const err = new Error('拖拽起始元素不可见');
        err.code = 'DRAG_FAILED';
        throw err;
      }
      const sx = box.x + box.width / 2;
      const sy = box.y + box.height / 2;
      await p.mouse.move(sx, sy);
      await p.mouse.down();
      await p.mouse.move(sx + dx, sy + dy);
      await p.mouse.up();
    }
    return { ok: true, engine: 'playwright', channel: launchChannel };
  }

  async function screenshot(opts = {}) {
    const p = await ensurePage(opts);
    let buf;
    let width = 0;
    let height = 0;
    const isElementShot = !!(opts.ref || opts.selector);
    // 标注：在每个 frame 内各自画（position:fixed 相对于所在 frame 视口，天然对齐）
    let annotation = null;
    const annotatedFrames = [];
    if (opts.annotate) {
      const targets = isMainFrameSpec(normalizeFrameSpec(opts.frame))
        ? frameListOf(p)
        : [resolveFrameTarget(p, normalizeFrameSpec(opts.frame))].filter((x) => x && x.ok).map((x) => x.entry);
      for (const entry of targets) {
        // eslint-disable-next-line no-await-in-loop
        const drawn = await entry.frame
          .evaluate(
            buildAnnotateScript({
              absolute: false,
              labelInside: isElementShot,
              maxLabels: opts.annotate === true ? undefined : Number(opts.annotate)
            })
          )
          .catch(() => null);
        if (drawn && drawn.ok) annotatedFrames.push(entry.frame);
      }
      if (annotatedFrames.length) annotation = { drawn: true, frames: annotatedFrames.length };
    }
    try {
      if (isElementShot) {
        const target = await resolveTarget({ ref: opts.ref, selector: opts.selector });
        const located = await locateTarget(p, opts, target);
        if (!located.ok) return { ok: false, engine: 'playwright', channel: launchChannel, ...located };
        const loc = located.locator;
        buf = await loc.screenshot({ type: 'png', timeout: Number(opts.timeoutMs) || 15000 });
        const box = await loc.boundingBox();
        width = box ? Math.round(box.width) : 0;
        height = box ? Math.round(box.height) : 0;
      } else {
        buf = await p.screenshot({
          fullPage: !!opts.fullPage,
          type: 'png'
        });
        const viewport = p.viewportSize() || { width: 0, height: 0 };
        width = viewport.width;
        height = viewport.height;
      }
    } finally {
      for (const frame of annotatedFrames) {
        await frame.evaluate(buildClearAnnotationScript()).catch(() => null);
      }
    }
    return {
      ok: true,
      engine: 'playwright',
      channel: launchChannel,
      headless,
      mime: 'image/png',
      base64: Buffer.from(buf).toString('base64'),
      width,
      height,
      fullPage: !!opts.fullPage && !isElementShot,
      element: opts.ref || opts.selector || undefined,
      annotate: annotation || undefined
    };
  }

  async function pdf(opts = {}) {
    if (!headless) {
      const err = new Error(
        'Playwright 仅在无头模式支持导出 PDF；请关闭「可见窗口」或改用 engine=browserview'
      );
      err.code = 'PDF_HEADLESS_ONLY';
      throw err;
    }
    const p = await ensurePage();
    const format = String(opts.format || 'A4').trim() || 'A4';
    const buf = await p.pdf({
      printBackground: opts.printBackground !== false,
      landscape: !!opts.landscape,
      format
    });
    const bytes = Buffer.from(buf);
    return {
      ok: true,
      engine: 'playwright',
      channel: launchChannel,
      mime: 'application/pdf',
      bytes: bytes.length,
      base64: bytes.toString('base64')
    };
  }

  async function evaluateScript(args = {}) {
    const script = String(args.script == null ? '' : args.script);
    if (!script.trim()) {
      const err = new Error('browser_evaluate 需要 script');
      err.code = 'SCRIPT_REQUIRED';
      throw err;
    }
    const p = await ensurePage(args);
    const spec = normalizeFrameSpec(args.frame);
    let target = p;
    let framePath = 'main';
    if (!isMainFrameSpec(spec)) {
      const hit = resolveFrameTarget(p, spec);
      if (!hit.ok) return { ok: false, engine: 'playwright', channel: launchChannel, ...hit };
      target = hit.entry.frame;
      framePath = hit.entry.path;
    }
    const raw = await target.evaluate(buildEvaluateScript(script, { maxChars: args.maxChars }));
    return {
      engine: 'playwright',
      channel: launchChannel,
      url: p.url(),
      frame: framePath === 'main' ? undefined : framePath,
      ...normalizeEvaluateResult(raw)
    };
  }

  async function waitFor(args = {}) {
    const p = await ensurePage(args);
    const kind = String(args.kind || args.type || 'selector').toLowerCase();
    const value = String(args.value || args.text || args.selector || args.url || '');
    const timeout = Number(args.timeoutMs) || 30000;
    const spec = normalizeFrameSpec(args.frame);
    let scope = p;
    let framePath = 'main';
    if (!isMainFrameSpec(spec)) {
      const hit = resolveFrameTarget(p, spec);
      if (!hit.ok) return { ok: false, engine: 'playwright', channel: launchChannel, ...hit };
      scope = hit.entry.frame;
      framePath = hit.entry.path;
    }
    if (kind === 'selector') {
      await scope.waitForSelector(value, { timeout, state: args.state || 'visible' });
      return { ok: true, engine: 'playwright', kind, selector: value, frame: framePath === 'main' ? undefined : framePath, channel: launchChannel };
    }
    if (kind === 'text') {
      await scope.waitForFunction((v) => document.body && document.body.innerText.includes(v), value, { timeout });
      return { ok: true, engine: 'playwright', kind, text: value, frame: framePath === 'main' ? undefined : framePath, channel: launchChannel };
    }
    if (kind === 'url') {
      await p.waitForURL((url) => String(url).includes(value), { timeout });
      return { ok: true, engine: 'playwright', kind, url: p.url(), channel: launchChannel };
    }
    if (kind === 'networkidle' || kind === 'idle') {
      await p.waitForLoadState('networkidle', { timeout });
      return { ok: true, engine: 'playwright', kind: 'networkidle', channel: launchChannel };
    }
    if (kind === 'load') {
      await p.waitForLoadState(args.state || 'load', { timeout });
      return { ok: true, engine: 'playwright', kind: 'load', state: args.state || 'load', channel: launchChannel };
    }
    if (kind === 'expression' || kind === 'expr') {
      if (!value.trim()) {
        const err = new Error('browser_wait_for kind=expression 需要 value（表达式）');
        err.code = 'MISSING_ARG';
        throw err;
      }
      // 表达式内联进脚本（不走页面内 eval，CSP 拦不到），Node 侧轮询到为真
      const started = Date.now();
      let last = null;
      while (Date.now() - started <= timeout) {
        // eslint-disable-next-line no-await-in-loop
        last = await scope.evaluate(buildExpressionProbeScript(value)).catch((e) => ({
          ok: false,
          error: e && e.message ? e.message : String(e)
        }));
        if (last && last.ok && last.truthy) {
          return {
            ok: true,
            engine: 'playwright',
            kind: 'expression',
            elapsedMs: Date.now() - started,
            value: last.value,
            frame: framePath === 'main' ? undefined : framePath,
            channel: launchChannel
          };
        }
        // eslint-disable-next-line no-await-in-loop
        await p.waitForTimeout(Math.min(300, Math.max(50, Number(args.intervalMs) || 200)));
      }
      return {
        ok: false,
        engine: 'playwright',
        kind: 'expression',
        timeout: true,
        elapsedMs: Date.now() - started,
        last,
        errorCode: 'WAIT_TIMEOUT',
        error: '等待表达式超时'
      };
    }
    const data = await scope.evaluate(buildWaitConditionScript({ ...args, state: args.state }));
    return {
      ok: !!data?.ok,
      engine: 'playwright',
      channel: launchChannel,
      frame: framePath === 'main' ? undefined : framePath,
      ...data
    };
  }

  async function tabs(args = {}) {
    const key = resolveSessionKey(args);
    const p = await ensurePage(args);
    const entry = sessions.get(key);
    const context = entry?.context || null;
    let page = p;
    const action = String(args.action || 'list').toLowerCase();
    if ((action === 'new' || action === 'open') && args.url && context) {
      page = await context.newPage();
      await applyViewportToPage(page);
      attachPageEvents(page);
      if (entry) entry.page = page;
      await page.goto(assertBrowserLoadUrl(args.url), {
        waitUntil: args.waitUntil || 'load',
        timeout: Number(args.timeoutMs) || 60000
      });
    } else if (action === 'switch' && args.tabId && context) {
      const pages = context.pages();
      const idx = Number(String(args.tabId).replace(/^tab-/, ''));
      if (Number.isInteger(idx) && pages[idx]) {
        page = pages[idx];
        if (entry) entry.page = page;
        await page.bringToFront().catch(() => {});
      }
    } else if (action === 'close') {
      await p.close().catch(() => {});
      const pages = context ? context.pages().filter((x) => !x.isClosed()) : [];
      page = pages[0] || null;
      if (entry) entry.page = page;
    }
    const pages = context ? context.pages().filter((x) => !x.isClosed()) : page ? [page] : [];
    return {
      ok: true,
      engine: 'playwright',
      activeTabId: page ? `tab-${pages.indexOf(page)}` : '',
      tabs: await Promise.all(pages.map(async (pg, i) => ({
        id: `tab-${i}`,
        active: pg === page,
        url: pg.url(),
        title: await pg.title().catch(() => '')
      }))),
      channel: launchChannel
    };
  }

  async function downloadStatus(args = {}) {
    const action = String(args.action || 'list').toLowerCase();
    if (action === 'clear') {
      downloads.length = 0;
      return { ok: true, engine: 'playwright', downloads: [] };
    }
    if (action === 'wait') {
      await ensurePage();
      const timeout = Math.max(500, Number(args.timeoutMs) || 30000);
      const started = Date.now();
      while (Date.now() - started <= timeout) {
        const latest = downloads.slice().reverse().find((d) => d.status === 'completed');
        if (latest) {
          return { ok: true, engine: 'playwright', download: latest, downloads: downloads.slice(-20), channel: launchChannel };
        }
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
      return { ok: false, engine: 'playwright', timeout: true, downloads: downloads.slice(-20), channel: launchChannel };
    }
    return { ok: true, engine: 'playwright', downloads: downloads.slice(-20), channel: launchChannel };
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

  /** 无 file input 时按 dropzone 处理：构造 DataTransfer 并派发 drag 序列。 */
  async function dropFileOnSelector(page, selector, filePath) {
    const bytes = await fs.readFile(filePath);
    const fileName = path.basename(filePath);
    const handle = await page.evaluateHandle(
      ({ base64, name, type }) => {
        const binary = atob(base64);
        const arr = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) arr[i] = binary.charCodeAt(i);
        const dt = new DataTransfer();
        dt.items.add(new File([arr], name, { type }));
        return dt;
      },
      { base64: bytes.toString('base64'), name: fileName, type: guessMime(filePath) }
    );
    await page.dispatchEvent(selector, 'dragenter', { dataTransfer: handle });
    await page.dispatchEvent(selector, 'dragover', { dataTransfer: handle });
    await page.dispatchEvent(selector, 'drop', { dataTransfer: handle });
    return { ok: true, fileName };
  }

  async function uploadFile(args = {}) {
    const p = await ensurePage();
    const filePath = String(args.filePath || '').trim();
    if (!filePath) {
      const err = new Error('browser_upload_file 需要 filePath');
      err.code = 'FILE_REQUIRED';
      throw err;
    }
    let selector = args.selector;
    if (!selector && args.ref) selector = `[data-dieyun-ref="${String(args.ref).replace(/"/g, '\\"')}"]`;
    if (!selector) {
      const err = new Error('需要提供 ref 或 selector');
      err.code = 'TARGET_REQUIRED';
      throw err;
    }
    try {
      const located = await locateTarget(p, args, { kind: 'selector', value: selector });
      if (!located.ok) return { ok: false, engine: 'playwright', channel: launchChannel, ...located };
      await located.locator.setInputFiles(filePath, { timeout: Number(args.timeoutMs) || 15000 });
      recordTimeline('upload', { ok: true, url: p.url(), value: path.basename(filePath), frame: located.framePath || 'main' });
      return {
        ok: true,
        engine: 'playwright',
        filePath,
        selector,
        via: 'input',
        framePath: located.framePath || 'main',
        crossFrame: located.crossFrame,
        channel: launchChannel
      };
    } catch (inputErr) {
      const dropped = await dropFileOnSelector(p, selector, filePath).catch((err) => ({
        ok: false,
        error: err && err.message ? err.message : String(err)
      }));
      if (!dropped.ok) {
        const err = new Error(
          `上传失败（目标非 file input，drop 兜底也失败）：${
            inputErr && inputErr.message ? inputErr.message : inputErr
          }；${dropped.error}`
        );
        err.code = 'UPLOAD_FAILED';
        throw err;
      }
      return {
        ok: true,
        engine: 'playwright',
        filePath,
        selector,
        via: 'drop',
        fileName: dropped.fileName,
        channel: launchChannel
      };
    }
  }

  async function observe(opts = {}) {
    const p = await ensurePage(opts);
    const snap = await snapshot({
      interactive: opts.interactive !== false,
      mode: opts.mode,
      maxElements: opts.maxElements,
      delayMs: opts.delayMs,
      frame: opts.frame
    });
    if (snap && snap.ok === false) return snap;
    let shot = null;
    let shotError = '';
    if (opts.screenshot !== false) {
      try {
        shot = await screenshot({ fullPage: !!opts.fullPage, annotate: opts.annotate, frame: opts.frame });
      } catch (e) {
        shotError = e && e.message ? e.message : String(e);
      }
    }
    return {
      ok: true,
      engine: 'playwright',
      channel: launchChannel,
      url: p.url(),
      title: await p.title().catch(() => ''),
      mode: snap.mode,
      textPreview: snap.textPreview || '',
      elements: snap.elements || [],
      refEpoch: snap.refEpoch,
      coverage: snap.coverage,
      frames: snap.frames,
      blockedIframes: snap.blockedIframes,
      screenshot: shot
        ? { mime: shot.mime, base64: shot.base64, width: shot.width, height: shot.height, annotate: shot.annotate }
        : null,
      viewport: p.viewportSize() || null,
      warning: shotError ? `截图失败（页面文本与 refs 仍可用）: ${shotError}` : undefined,
      note: [
        'observe 同时返回页面文本、ref、覆盖率与截图；页面变化后 ref 需重新获取',
        snap.coverage && snap.coverage.omitted ? `本次有 ${snap.coverage.omitted} 个元素因 maxElements 未纳入` : null,
        'Playwright 引擎已跨 frame 采集（含跨域 iframe）'
      ]
        .filter(Boolean)
        .join('；')
    };
  }

  async function reload(opts = {}) {
    const p = await ensurePage();
    const waitUntil = opts.waitUntil === 'domcontentloaded' ? 'domcontentloaded' : 'load';
    await p.reload({ waitUntil, timeout: Number(opts.timeoutMs) || 60000 });
    return {
      ok: true,
      engine: 'playwright',
      channel: launchChannel,
      url: p.url(),
      title: await p.title(),
      action: 'reload'
    };
  }

  async function goBack(opts = {}) {
    const p = await ensurePage();
    const response = await p.goBack({
      waitUntil: opts.waitUntil === 'domcontentloaded' ? 'domcontentloaded' : 'load',
      timeout: Number(opts.timeoutMs) || 60000
    });
    if (response === null) {
      return {
        ok: false,
        engine: 'playwright',
        channel: launchChannel,
        action: 'back',
        error: '无法后退（历史记录为空）',
        errorCode: 'HISTORY_EMPTY'
      };
    }
    return {
      ok: true,
      engine: 'playwright',
      channel: launchChannel,
      url: p.url(),
      title: await p.title(),
      action: 'back'
    };
  }

  async function goForward(opts = {}) {
    const p = await ensurePage();
    const response = await p.goForward({
      waitUntil: opts.waitUntil === 'domcontentloaded' ? 'domcontentloaded' : 'load',
      timeout: Number(opts.timeoutMs) || 60000
    });
    if (response === null) {
      return {
        ok: false,
        engine: 'playwright',
        channel: launchChannel,
        action: 'forward',
        error: '无法前进（历史记录为空）',
        errorCode: 'HISTORY_EMPTY'
      };
    }
    return {
      ok: true,
      engine: 'playwright',
      channel: launchChannel,
      url: p.url(),
      title: await p.title(),
      action: 'forward'
    };
  }

  async function importLocalStorage(entries) {
    const p = await ensurePage();
    const payload = entries && typeof entries === 'object' ? entries : {};
    return p.evaluate(buildImportLocalStorageScript(JSON.stringify(payload)));
  }

  async function expect(assertions, opts = {}) {
    const p = await ensurePage(opts);
    const spec = normalizeFrameSpec(opts.frame);
    let scope = p;
    if (!isMainFrameSpec(spec)) {
      const hit = resolveFrameTarget(p, spec);
      if (!hit.ok) return { ok: false, errorCode: hit.errorCode, error: hit.error, frames: hit.frames, results: [] };
      scope = hit.entry.frame;
    }
    // 已经在目标 frame 的上下文里执行，脚本内部的 frameSpec 必须留空（相对路径会错位）
    return scope.evaluate(buildExpectScript(JSON.stringify(assertions || []), 'null'));
  }

  async function readLocalStorage() {
    const p = await ensurePage();
    const url = p.url();
    if (!url || url === 'about:blank') {
      return { ok: false, error: '当前没有已打开的页面，无法读取 localStorage' };
    }
    return p.evaluate(buildReadLocalStorageScript());
  }

  async function setViewport(args = {}) {
    const p = await ensurePage(args);
    const size = normalizeViewport(args);
    if (args.reset) {
      viewportOverride = null;
      await p.setViewportSize({ width: VIEWPORT_DEFAULT.width, height: VIEWPORT_DEFAULT.height });
      return {
        ok: true,
        engine: 'playwright',
        channel: launchChannel,
        viewport: { ...VIEWPORT_DEFAULT },
        reset: true
      };
    }
    if (!size) {
      const err = new Error('browser_viewport 需要合法的 width 与 height');
      err.code = 'VIEWPORT_REQUIRED';
      throw err;
    }
    await p.setViewportSize({ width: size.width, height: size.height });
    viewportOverride = { ...size };
    return {
      ok: true,
      engine: 'playwright',
      channel: launchChannel,
      viewport: { ...size },
      note: 'Playwright 仅支持尺寸覆盖；mobile/deviceScaleFactor 需重建上下文，请用 engine=browserview'
    };
  }

  /**
   * 只记状态：绝不创建页面/上下文，命中已有页面才下发。
   * 供 service 在「另一个引擎」上镜像视口设置 —— 该引擎真正启用（新建页面）时自动生效，
   * 避免 auto 中途换引擎后仍按 1280×800 渲染而 browser_status 却报着旧尺寸。
   */
  async function stageViewport(args = {}) {
    if (args.reset) {
      viewportOverride = null;
      await applyViewportToLivePages(VIEWPORT_DEFAULT);
      return {
        ok: true,
        engine: 'playwright',
        viewport: null,
        reset: true,
        staged: true,
        hasPage: !!getActivePage()
      };
    }
    const size = normalizeViewport(args);
    if (!size) {
      const err = new Error('browser_viewport 需要合法的 width 与 height');
      err.code = 'VIEWPORT_REQUIRED';
      throw err;
    }
    viewportOverride = { ...size };
    await applyViewportToLivePages(size);
    return {
      ok: true,
      engine: 'playwright',
      viewport: { ...size },
      staged: true,
      hasPage: !!getActivePage()
    };
  }

  /** 只清视口状态，不创建页面（供切会话时调用）。 */
  async function resetViewport() {
    viewportOverride = null;
    const entry = sessions.get(activeSessionId || '__default__');
    const page = entry && entry.page && !entry.page.isClosed() ? entry.page : null;
    if (!page) return { ok: true, engine: 'playwright', viewport: null, reset: true };
    try {
      await page.setViewportSize({ width: VIEWPORT_DEFAULT.width, height: VIEWPORT_DEFAULT.height });
    } catch {
      // ignore
    }
    return { ok: true, engine: 'playwright', viewport: { ...VIEWPORT_DEFAULT }, reset: true };
  }

  async function setHeaded(headed) {
    const wantHeadless = !headed;
    const changed = wantHeadless !== headless;
    headless = wantHeadless;
    if (changed && browser) await close();
    return { ok: true, headless, headed: !headless, changed };
  }

  function status() {
    let available = false;
    try {
      loadPlaywright();
      available = true;
    } catch {
      available = false;
    }
    const page = getActivePage();
    return {
      ok: true,
      engine: 'playwright',
      available,
      url: page ? page.url() : '',
      headless,
      headed: !headless,
      channel: launchChannel,
      hasPage: !!page,
      viewport: viewportOverride,
      hasBrowser: !!(browser && browser.isConnected()),
      activeSessionId: activeSessionId || '__default__',
      sessionCount: sessions.size
    };
  }

  async function close() {
    for (const key of [...sessions.keys()]) {
      await closeSession(key);
    }
    try {
      if (browser) await browser.close();
    } catch (e) {
      log('playwright browser close: ' + (e && e.message));
    }
    browser = null;
    launchChannel = null;
    return { ok: true };
  }

  async function a11ySnapshot(opts = {}) {
    const p = await ensurePage(opts);
    const result = await a11ySnapshotPlaywright(p, opts);
    return {
      ...result,
      url: p.url(),
      note: 'a11y 树列出可访问性角色与名称；复杂页面可配合 browser_snapshot 的 ref 点击'
    };
  }

  function network(args = {}) {
    if (String(args.action || 'list').toLowerCase() === 'clear') {
      networkJournal.clear();
      return { ok: true, engine: 'playwright', cleared: true };
    }
    const entries = networkJournal.list(args);
    return {
      ok: true,
      engine: 'playwright',
      ...summarizeHarEntries(entries),
      stats: networkJournal.status()
    };
  }

  function consoleMessages(args = {}) {
    if (String(args.action || 'list').toLowerCase() === 'clear') {
      consoleJournal.clear();
      return { ok: true, engine: 'playwright', cleared: true };
    }
    const entries = consoleJournal.list(args);
    return {
      ok: true,
      engine: 'playwright',
      ...summarizeConsoleEntries(entries),
      stats: consoleJournal.status()
    };
  }

  /** 规则清空后必须把 context 上的 route 摘掉，否则会永久拦截所有请求（只是全部 continue）。 */
  async function unrouteAllContexts() {
    for (const [, entry] of sessions) {
      const ctx = entry && entry.context;
      if (!ctx) continue;
      routedContexts.delete(ctx);
      try {
        await ctx.unroute('**/*');
      } catch {
        // ignore
      }
    }
  }

  /** 把当前路由规则挂到上下文（幂等，每个 context 只挂一次）。 */
  async function applyRoutesToContext(context) {
    if (!context || !routeRulesPw.length || routedContexts.has(context)) return;
    routedContexts.add(context);
    try {
      await context.route('**/*', async (route) => {
        const url = route.request().url();
        const rule = routeRulesPw.find((r) => r.enabled !== false && matchUrlPattern(r.urlPattern, url));
        if (!rule) return route.continue().catch(() => {});
        rule.hits = (rule.hits || 0) + 1;
        try {
          if (rule.type === 'abort') return await route.abort(rule.errorReason || 'failed');
          if (rule.type === 'fulfill') {
            return await route.fulfill({
              status: Number(rule.status) || 200,
              headers: rule.headers,
              contentType: rule.contentType || undefined,
              body: rule.body != null ? String(rule.body) : ''
            });
          }
          if (rule.type === 'modifyHeaders') {
            return await route.continue({
              headers: { ...route.request().headers(), ...(rule.headers || {}) }
            });
          }
          return await route.continue();
        } catch {
          return route.continue().catch(() => {});
        }
      });
    } catch (e) {
      log('browser playwright route: ' + (e && e.message ? e.message : e));
    }
  }

  /** 对话框：list（默认）| handle | policy。 */
  async function dialog(args = {}) {
    const action = String(args.action || 'list').toLowerCase();
    if (action === 'policy') {
      const next = String(args.policy || 'auto').toLowerCase();
      dialogPolicy = ['auto', 'accept', 'dismiss', 'manual'].indexOf(next) >= 0 ? next : 'auto';
      return { ok: true, engine: 'playwright', action, policy: dialogPolicy, channel: launchChannel };
    }
    if (action === 'handle') {
      const dlg = pendingDialogRef;
      if (!dlg) return { ok: false, engine: 'playwright', action, error: '当前没有挂起的对话框' };
      const accept = args.accept !== false;
      try {
        await (accept
          ? dlg.accept(args.promptText != null ? String(args.promptText) : undefined)
          : dlg.dismiss());
        pendingDialogRef = null;
        pendingDialog = null;
        return { ok: true, engine: 'playwright', action, accepted: accept };
      } catch (e) {
        return { ok: false, engine: 'playwright', action, error: e && e.message ? e.message : String(e) };
      }
    }
    return {
      ok: true,
      engine: 'playwright',
      action: 'list',
      policy: dialogPolicy,
      pending: pendingDialog,
      count: dialogLog.length,
      dialogs: dialogLog.slice(-10),
      channel: launchChannel
    };
  }

  /** 请求改写：list（默认）| add | remove | clear。 */
  async function route(args = {}) {
    const action = String(args.action || 'list').toLowerCase();
    if (action === 'clear') {
      routeRulesPw.length = 0;
      await unrouteAllContexts();
      return { ok: true, engine: 'playwright', action, routes: [], interception: false, channel: launchChannel };
    }
    if (action === 'remove') {
      const id = String(args.id || '');
      const idx = routeRulesPw.findIndex((r) => r.id === id);
      if (idx < 0) return { ok: false, engine: 'playwright', action, error: '未找到规则 ' + id };
      routeRulesPw.splice(idx, 1);
      if (!routeRulesPw.length) await unrouteAllContexts();
      return {
        ok: true,
        engine: 'playwright',
        action,
        removed: id,
        routes: routeRulesPw,
        interception: routeRulesPw.length > 0
      };
    }
    if (action === 'add') {
      const type = String(args.type || 'fulfill').toLowerCase();
      const rule = {
        id: 'route-' + routeSeqPw++,
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
      routeRulesPw.push(rule);
      const page = await ensurePage(args);
      await applyRoutesToContext(page.context());
      return {
        ok: true,
        engine: 'playwright',
        action,
        added: rule,
        routes: routeRulesPw,
        interception: true,
        channel: launchChannel
      };
    }
    return {
      ok: true,
      engine: 'playwright',
      action: 'list',
      routes: routeRulesPw,
      interception: routeRulesPw.length > 0,
      channel: launchChannel
    };
  }

  /**
   * 设备/权限模拟：set | reset | status。
   * geolocation/permissions 可动态生效；timezone/locale 是上下文级参数，新建页面时应用。
   */
  async function emulate(args = {}) {
    const action = String(args.action || 'set').toLowerCase();
    const want = normalizeEmulation(args);
    const page = await ensurePage(args);
    const context = page.context();

    if (action === 'reset') {
      emulationRuntime.geolocation = null;
      emulationRuntime.timezone = '';
      emulationRuntime.locale = '';
      emulationRuntime.permissions = [];
      await context.setGeolocation(null).catch(() => {});
      await context.clearPermissions().catch(() => {});
      return {
        ok: true,
        engine: 'playwright',
        action,
        geolocation: null,
        timezone: '',
        locale: '',
        permissions: [],
        channel: launchChannel
      };
    }

    if (action === 'status') {
      return {
        ok: true,
        engine: 'playwright',
        action,
        geolocation: emulationRuntime.geolocation,
        timezone: emulationRuntime.timezone,
        locale: emulationRuntime.locale,
        permissions: [...emulationRuntime.permissions],
        channel: launchChannel
      };
    }

    const applied = { geolocation: false, timezone: false, locale: false, permissions: 0 };
    const errors = [];

    if (want.geolocation) {
      try {
        await context.setGeolocation(want.geolocation);
        emulationRuntime.geolocation = { ...want.geolocation };
        applied.geolocation = true;
      } catch (e) {
        errors.push('geolocation: ' + (e && e.message ? e.message : e));
      }
    }
    if (want.timezone) {
      emulationRuntime.timezone = want.timezone;
      applied.timezone = true;
    }
    if (want.locale) {
      emulationRuntime.locale = want.locale;
      applied.locale = true;
    }
    if (want.permissions.length) {
      try {
        await context.grantPermissions(want.permissions);
        for (const name of want.permissions) {
          if (emulationRuntime.permissions.indexOf(name) < 0) emulationRuntime.permissions.push(name);
        }
        applied.permissions = want.permissions.length;
      } catch (e) {
        errors.push('permissions: ' + (e && e.message ? e.message : e));
      }
    }

    const deferred = [];
    if (applied.timezone) deferred.push('timezone');
    if (applied.locale) deferred.push('locale');

    return {
      ok: errors.length === 0,
      engine: 'playwright',
      action,
      applied,
      errors: errors.length ? errors : undefined,
      geolocation: emulationRuntime.geolocation,
      timezone: emulationRuntime.timezone,
      locale: emulationRuntime.locale,
      permissions: [...emulationRuntime.permissions],
      channel: launchChannel,
      note: deferred.length
        ? `${deferred.join('/')} 是上下文级参数，需新建页面（browser_tabs action=new）后生效`
        : undefined
    };
  }

  /** 切会话时清掉模拟状态（避免定位/权限模拟泄漏到另一个会话）。 */
  function resetEmulation() {
    emulationRuntime.geolocation = null;
    emulationRuntime.timezone = '';
    emulationRuntime.locale = '';
    emulationRuntime.permissions = [];
    return { ok: true, engine: 'playwright' };
  }

  /** 清空当前会话上下文的 Cookie（Cookie 删除后与 Electron 分区重新对齐使用）。 */
  async function clearCookies(args = {}) {
    const key = resolveSessionKey(args);
    const entry = sessions.get(key);
    if (!entry || !entry.context) return { ok: true, engine: 'playwright', cleared: false };
    try {
      await entry.context.clearCookies();
      return { ok: true, engine: 'playwright', cleared: true };
    } catch (e) {
      return {
        ok: false,
        engine: 'playwright',
        cleared: false,
        error: e && e.message ? e.message : String(e)
      };
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
    frames: listFrames,
    timeline,
    waitFor,
    tabs,
    downloads: downloadStatus,
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
    status,
    close,
    syncSessionFromElectron,
    setHeaded,
    activateSession,
    closeSession,
    clearCookies,
    dialog,
    route,
    emulate,
    resetEmulation
  };
}

module.exports = { createPlaywrightRunner };
