'use strict';

const fs = require('fs/promises');
const path = require('path');
const { createBrowserViewController, isBrowserCaptureSurfaceError } = require('./controller');
const { createPlaywrightRunner } = require('./playwright-runner');
const {
  importCookiesToElectron,
  exportCookiesForPlaywright,
  removeCookiesFromElectron
} = require('./session-sync');
const { createNetworkJournal, summarizeHarEntries, toHar } = require('./network-collector');
const { createConsoleJournal, summarizeConsoleEntries } = require('./console-collector');
const { normalizeAssertions, shapeExpectResult } = require('./expect');
const {
  diffBitmaps,
  clampRatio,
  stableKey,
  isLikelyBlankBitmap,
  DEFAULT_RATIO_THRESHOLD
} = require('./visual-diff');
const { createBrowserSessionScope } = require('./session-scope');

const MAX_EXPORT_COOKIES = 300;

function defaultDownloadDir() {
  try {
    const { app } = require('electron');
    if (app && typeof app.getPath === 'function') return app.getPath('downloads');
  } catch {
    // 非 Electron 环境（理论上不会走到）回退到 cwd
  }
  return process.cwd();
}

function ensureExtension(filePath, ext) {
  const p = String(filePath || '');
  return new RegExp(`\\.${ext}$`, 'i').test(p) ? p : `${p}.${ext}`;
}

function resolveOutputPath(filePath, ext, prefix) {
  const raw = String(filePath || '').trim();
  if (raw) return ensureExtension(path.resolve(raw), ext);
  return path.join(defaultDownloadDir(), `${prefix}-${Date.now()}.${ext}`);
}

/** 给不支持的底层调用加超时，避免页面内死循环拖死整个 Agent 轮次。 */
function withTimeout(promise, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const err = new Error(`${label}超时（${timeoutMs}ms）`);
      err.code = 'EVALUATE_TIMEOUT';
      reject(err);
    }, timeoutMs);
    Promise.resolve(promise).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

/**
 * 统一浏览器服务：默认 BrowserView（可见），复杂场景 fallback Playwright。
 * @param {{
 *   getMainWindow: () => import('electron').BrowserWindow | null,
 *   log?: (m: string) => void,
 *   confirmBrowserImport?: (summary: string) => Promise<boolean>,
 *   confirmBrowserExport?: (summary: string) => Promise<boolean>
 * }} deps
 */
function createBrowserService(deps) {
  const log = deps.log || (() => {});
  const sessionScope = createBrowserSessionScope();
  const bvNetwork = createNetworkJournal();
  const pwNetwork = createNetworkJournal();
  const bvConsole = createConsoleJournal();
  const pwConsole = createConsoleJournal();
  const viewCtrl = createBrowserViewController({
    ...deps,
    networkJournal: bvNetwork,
    consoleJournal: bvConsole
  });
  const pwRunner = createPlaywrightRunner({
    log,
    networkJournal: pwNetwork,
    consoleJournal: pwConsole
  });
  /** @type {'browserview' | 'playwright'} */
  let activeEngine = 'browserview';
  let forcePlaywrightUrl = '';
  let playwrightHeaded = false;

  function withPwOpts(opts = {}) {
    const out = { ...(opts || {}) };
    if (out.headed == null && playwrightHeaded) out.headed = true;
    return out;
  }

  function runnerArgs(engine, args = {}) {
    return engine === 'playwright' ? withPwOpts(args) : args;
  }

  function pickEngine(requested) {
    const e = String(requested || 'auto').toLowerCase();
    if (e === 'playwright') return 'playwright';
    if (e === 'browserview' || e === 'embedded') return 'browserview';
    if (e === 'auto') return 'auto';
    return activeEngine;
  }

  function getRunner(engine) {
    return engine === 'playwright' ? pwRunner : viewCtrl;
  }

  function stripHash(url) {
    return String(url || '').replace(/#.*$/, '');
  }

  function isBlankBrowserViewResult(result) {
    return result?.engine === 'browserview' && !!result?.renderHealth?.likelyBlank;
  }

  async function fallbackToPlaywrightAfterBlank(opts, invoke) {
    const viewStatus = viewCtrl.status();
    const url = viewStatus.url || viewStatus.renderHealth?.page?.url || '';
    if (!url) return null;
    let sessionSync = { synced: 0 };
    if (typeof pwRunner.syncSessionFromElectron === 'function') {
      try {
        sessionSync = await pwRunner.syncSessionFromElectron(url);
      } catch (e) {
        log('Browser session-sync before fallback: ' + (e.message || e));
      }
    }
    await pwRunner.navigate(url, {
      waitUntil: 'domcontentloaded',
      timeoutMs: opts?.timeoutMs || 30000
    });
    activeEngine = 'playwright';
    forcePlaywrightUrl = stripHash(url);
    const result = await invoke();
    return {
      ...result,
      fallbackFrom: 'browserview',
      fallbackReason: 'browserview_blank',
      sessionSync,
      note: [
        result?.note,
        'BrowserView 画面疑似全黑，auto 模式已切到 Playwright。',
        sessionSync.synced ? `已从 BrowserView 同步 ${sessionSync.synced} 条 Cookie 到 Playwright。` : null,
        playwrightHeaded ? 'Playwright 可见窗口已启用。' : null
      ]
        .filter(Boolean)
        .join('；')
    };
  }

  async function ensurePlaywrightSessionSynced(sessionId) {
    if (typeof pwRunner.syncSessionFromElectron !== 'function') return { synced: 0 };
    const sid = sessionId || sessionScope.getActiveViewSessionId();
    const viewUrl = viewCtrl.status().url || '';
    const pwUrl = pwRunner.status().url || '';
    const url = viewUrl || pwUrl;
    try {
      return await pwRunner.syncSessionFromElectron(url, sid ? { sessionId: sid } : {});
    } catch (e) {
      log('Browser session-sync: ' + (e.message || e));
      return { synced: 0, error: e.message || String(e) };
    }
  }

  /** auto 模式下交互操作使用的引擎（不 silent 跨引擎 fallback） */
  function resolveAutoInteractionEngine() {
    if (activeEngine === 'playwright') {
      const vs = viewCtrl.status();
      const ps = pwRunner.status();
      const vu = stripHash(vs.url || '');
      const pu = stripHash(ps.url || '');
      if (forcePlaywrightUrl && pu && pu === forcePlaywrightUrl) return 'playwright';
      if (vu && pu && vu === pu) return 'browserview';
      return 'playwright';
    }
    return 'browserview';
  }

  function resolveEngine(requested, { interaction = false, sessionId } = {}) {
    if (sessionId && sessionScope.isBackgroundSession(sessionId)) {
      return 'playwright';
    }
    const e = pickEngine(requested);
    if (e === 'auto') {
      return interaction ? resolveAutoInteractionEngine() : activeEngine;
    }
    return e;
  }

  function recordSessionMeta(sessionId, result) {
    const sid = sessionId ? String(sessionId) : sessionScope.getActiveViewSessionId();
    if (!sid || !result) return;
    sessionScope.updateMeta(sid, {
      url: result.url,
      title: result.title,
      engine: result.engine || activeEngine
    });
  }

  async function navigate(url, opts = {}) {
    const sessionId = opts.sessionId ? String(opts.sessionId) : null;
    if (sessionId && sessionScope.isBackgroundSession(sessionId)) {
      sessionScope.updateMeta(sessionId, { url });
      await ensurePlaywrightSessionSynced(sessionId);
      const pwResult = await pwRunner.navigate(url, withPwOpts({ ...opts, engine: 'playwright', sessionId }));
      activeEngine = 'playwright';
      const merged = {
        ...pwResult,
        engine: 'playwright',
        backgroundSession: true,
        note: '后台会话浏览器操作使用 Playwright，不会切换当前可见 BrowserView。'
      };
      recordSessionMeta(sessionId, merged);
      return merged;
    }
    const engine = pickEngine(opts.engine);
    if (engine === 'auto') {
      try {
        const result = await viewCtrl.navigate(url, opts);
        activeEngine = 'browserview';
        forcePlaywrightUrl = '';
        return result;
      } catch (err) {
        if (String(err?.code || '') === 'PLAYWRIGHT_MISSING' || String(err?.code || '') === 'PLAYWRIGHT_LAUNCH_FAILED') {
          throw err;
        }
        log('BrowserView 失败，尝试 Playwright: ' + (err.message || err));
        let sessionSync = { synced: 0 };
        if (typeof pwRunner.syncSessionFromElectron === 'function') {
          try {
            sessionSync = await pwRunner.syncSessionFromElectron(url);
          } catch (syncErr) {
            log('Browser session-sync before PW navigate: ' + (syncErr.message || syncErr));
          }
        }
        const pwResult = await pwRunner.navigate(url, opts);
        try {
          await viewCtrl.navigate(pwResult.url || url, {
            waitUntil: 'domcontentloaded',
            timeoutMs: opts.timeoutMs
          });
          activeEngine = 'browserview';
          forcePlaywrightUrl = '';
        } catch (syncErr) {
          activeEngine = 'playwright';
          forcePlaywrightUrl = stripHash(pwResult.url || url);
          log('BrowserView 同步失败，后续操作走 Playwright: ' + (syncErr.message || syncErr));
        }
        return {
          ...pwResult,
          activeEngine,
          sessionSync,
          fallbackFrom: 'browserview',
          fallbackReason: err.message || String(err),
          note: sessionSync.synced
            ? `已从 BrowserView 同步 ${sessionSync.synced} 条 Cookie 到 Playwright。`
            : undefined
        };
      }
    }
    if (engine === 'playwright') {
      await ensurePlaywrightSessionSynced();
    }
    const result = await getRunner(engine).navigate(url, opts);
    if (engine === 'playwright' && result?.url) {
      viewCtrl.navigate(result.url, { waitUntil: 'domcontentloaded', timeoutMs: opts.timeoutMs }).catch(() => {});
    }
    activeEngine = engine;
    forcePlaywrightUrl = engine === 'playwright' ? stripHash(result?.url || url) : '';
    recordSessionMeta(sessionId, result);
    return result;
  }

  async function snapshot(opts = {}) {
    const sessionId = opts.sessionId ? String(opts.sessionId) : null;
    const engine = resolveEngine(opts.engine, { interaction: true, sessionId });
    if (engine === 'playwright') await ensurePlaywrightSessionSynced();
    const result = await getRunner(engine).snapshot(opts);
    if (engine === 'browserview' && pickEngine(opts.engine) === 'auto' && isBlankBrowserViewResult(result)) {
      return fallbackToPlaywrightAfterBlank(opts, () => pwRunner.snapshot(opts)).catch((e) => ({
        ...result,
        fallbackError: e && e.message ? e.message : String(e)
      }));
    }
    return result;
  }

  /**
   * 元素在主 frame 找不到、且页面存在跨域 iframe 时，自动改用 Playwright 重试
   * （Playwright 侧支持跨 frame 定位）。命中返回重试结果，否则返回 null。
   */
  async function retryOnPlaywrightForIframe(method, args, result) {
    if (!result || result.ok !== false || !result.crossFrameHint) return null;
    try {
      await ensurePlaywrightSessionSynced();
      const retry = await pwRunner[method](withPwOpts({ ...args, engine: 'playwright' }));
      if (retry && retry.ok) {
        activeEngine = 'playwright';
        return {
          ...retry,
          fallbackFrom: 'browserview',
          fallbackReason: 'cross_frame_iframe',
          note: '元素在主 frame 未找到且页面存在跨域 iframe，已自动改用 Playwright（支持跨 frame 定位）。'
        };
      }
    } catch (e) {
      log('browser iframe fallback: ' + (e && e.message ? e.message : e));
    }
    return null;
  }

  async function click(args = {}) {
    const engine = resolveEngine(args.engine, { interaction: true, sessionId: args.sessionId });
    if (engine === 'playwright') await ensurePlaywrightSessionSynced();
    const result = await getRunner(engine).click(runnerArgs(engine, args));
    if (engine === 'browserview') {
      const retried = await retryOnPlaywrightForIframe('click', args, result);
      if (retried) return retried;
    }
    return result;
  }

  async function typeText(args = {}) {
    const engine = resolveEngine(args.engine, { interaction: true, sessionId: args.sessionId });
    if (engine === 'playwright') await ensurePlaywrightSessionSynced();
    const result = await getRunner(engine).typeText(runnerArgs(engine, args));
    if (engine === 'browserview') {
      const retried = await retryOnPlaywrightForIframe('typeText', args, result);
      if (retried) return retried;
    }
    return result;
  }

  async function fill(args = {}) {
    return typeText({ ...args, clear: true });
  }

  async function selectOption(args = {}) {
    const engine = resolveEngine(args.engine, { interaction: true, sessionId: args.sessionId });
    if (engine === 'playwright') await ensurePlaywrightSessionSynced();
    const result = await getRunner(engine).selectOption(runnerArgs(engine, args));
    if (engine === 'browserview') {
      const retried = await retryOnPlaywrightForIframe('selectOption', args, result);
      if (retried) return retried;
    }
    return result;
  }

  async function hover(args = {}) {
    const engine = resolveEngine(args.engine, { interaction: true, sessionId: args.sessionId });
    if (engine === 'playwright') await ensurePlaywrightSessionSynced();
    const result = await getRunner(engine).hover(runnerArgs(engine, args));
    if (engine === 'browserview') {
      const retried = await retryOnPlaywrightForIframe('hover', args, result);
      if (retried) return retried;
    }
    return result;
  }

  async function drag(args = {}) {
    const engine = resolveEngine(args.engine, { interaction: true, sessionId: args.sessionId });
    if (engine === 'playwright') await ensurePlaywrightSessionSynced();
    return getRunner(engine).drag(runnerArgs(engine, args));
  }

  async function scroll(args = {}) {
    const engine = resolveEngine(args.engine, { interaction: true, sessionId: args.sessionId });
    return getRunner(engine).scroll(runnerArgs(engine, args));
  }

  async function pressKey(args = {}) {
    const engine = resolveEngine(args.engine, { interaction: true, sessionId: args.sessionId });
    return getRunner(engine).pressKey(runnerArgs(engine, args));
  }

  /** 验收留证：给了 filePath 就把 PNG 落盘（base64 仍保留，供多模态注入使用）。 */
  async function saveScreenshotIfRequested(result, opts = {}) {
    if (!result || !result.base64) return result;
    const raw = String(opts.filePath || '').trim();
    if (!raw) return result;
    const target = ensureExtension(path.resolve(raw), 'png');
    try {
      await fs.mkdir(path.dirname(target), { recursive: true });
      const buf = Buffer.from(result.base64, 'base64');
      await fs.writeFile(target, buf);
      return { ...result, path: target, bytes: buf.length };
    } catch (e) {
      return { ...result, savePath: target, saveError: (e && e.message) || String(e) };
    }
  }

  async function screenshot(opts = {}) {
    const engine = resolveEngine(opts.engine, { interaction: true, sessionId: opts.sessionId });
    const pwOpts = runnerArgs(engine, opts);
    let result;
    try {
      result = await getRunner(engine).screenshot(pwOpts);
      if (engine === 'browserview' && pickEngine(opts.engine) === 'auto' && isBlankBrowserViewResult(result)) {
        result = await fallbackToPlaywrightAfterBlank(opts, () => pwRunner.screenshot(withPwOpts(opts))).catch(
          (e) => ({
            ...result,
            fallbackError: e && e.message ? e.message : String(e)
          })
        );
      }
    } catch (e) {
      if (engine === 'browserview' && pickEngine(opts.engine) === 'auto' && isBrowserCaptureSurfaceError(e)) {
        const fb = await fallbackToPlaywrightAfterBlank(opts, () => pwRunner.screenshot(withPwOpts(opts))).catch(
          () => null
        );
        if (!fb) throw e;
        result = fb;
      } else {
        throw e;
      }
    }
    return saveScreenshotIfRequested(result, opts);
  }

  /**
   * 视口/设备仿真覆盖：让两个引擎在同一尺寸下渲染，避免验收结论漂移。
   * 同时把设置镜像到另一个引擎（只记状态，不创建页面/视图）：auto 中途换引擎后，
   * 新页面/视图会按同一尺寸渲染，不会出现"browser_status 报 390×844、实际 1280×800"。
   * 例外：后台会话不该镜像 —— BrowserView 是前台会话共享的单例，镜像过去等于改别人的页面。
   */
  async function setViewport(args = {}) {
    const engine = resolveEngine(args.engine, { interaction: true, sessionId: args.sessionId });
    if (engine === 'playwright') await ensurePlaywrightSessionSynced();
    const result = await getRunner(engine).setViewport(args);
    const mirrorEngine = engine === 'playwright' ? 'browserview' : 'playwright';
    const background = !!(args.sessionId && sessionScope.isBackgroundSession(args.sessionId));
    let mirrored = false;
    const mirror = background ? null : getRunner(mirrorEngine);
    if (mirror && typeof mirror.stageViewport === 'function') {
      try {
        await mirror.stageViewport(args);
        mirrored = true;
      } catch (e) {
        log('browser viewport mirror (' + mirrorEngine + '): ' + (e && e.message ? e.message : e));
      }
    }
    const note = [
      result && result.note,
      mirrored ? `视口已同步到 ${mirrorEngine}，换引擎后仍按同一尺寸渲染。` : null
    ]
      .filter(Boolean)
      .join('；');
    return { ...result, mirroredTo: mirrored ? mirrorEngine : null, note: note || undefined };
  }

  /** 结构化断言：把「验过了」变成可被完成验收护栏识别的 pass/fail 证据。 */
  async function expect(args = {}) {
    const assertions = normalizeAssertions(args.assertions);
    const engine = resolveEngine(args.engine, { interaction: true, sessionId: args.sessionId });
    if (engine === 'playwright') await ensurePlaywrightSessionSynced();
    const timeoutMs = Math.min(60000, Math.max(1000, Number(args.timeoutMs) || 15000));
    const raw = await withTimeout(getRunner(engine).expect(assertions), timeoutMs, '断言执行');
    return shapeExpectResult(raw, { engine });
  }

  /** 默认基准文件名：按引擎+目标派生稳定 key，保证多次调用比的是同一个文件。 */
  function defaultBaselinePath(engine, params = {}) {
    const key = stableKey(
      [engine, params.ref || '', params.selector || '', params.fullPage ? 'full' : 'viewport'].join('|')
    );
    return path.join(defaultDownloadDir(), `dieyun-visual-baseline-${key}.png`);
  }

  /**
   * 视觉差异（回归验收）：无基准则创建基准；有基准则逐像素比较并输出 diff 图。
   * 硬约束：基准元信息里的引擎必须与当前引擎一致 —— 跨引擎像素必然不同，比较无意义。
   */
  async function visualDiff(params = {}) {
    const engine = resolveEngine(params.engine, { sessionId: params.sessionId });
    if (engine === 'playwright') await ensurePlaywrightSessionSynced();

    const shot = await screenshot({
      engine,
      ref: params.ref,
      selector: params.selector,
      fullPage: params.fullPage,
      sessionId: params.sessionId
    });
    if (!shot || !shot.base64) {
      const err = new Error('视觉差异需要先拿到当前截图');
      err.code = 'DIFF_NO_SCREENSHOT';
      throw err;
    }
    const currentBuf = Buffer.from(shot.base64, 'base64');
    const explicitBaseline = String(params.baselinePath || '').trim();
    const baselinePath = explicitBaseline
      ? ensureExtension(path.resolve(explicitBaseline), 'png')
      : defaultBaselinePath(engine, params);
    const metaPath = `${baselinePath}.meta.json`;

    // 空白截图不能作为基准，也不能参与比较：否则会把"全黑"当成"没变化"
    // 用位图判定而不是 renderHealth：对两个引擎一致（Playwright 截图不带 renderHealth）
    const { nativeImage } = require('electron');
    const nextImg = nativeImage.createFromBuffer(currentBuf);
    const nextSize = nextImg.getSize();
    const nextBitmap = nextImg.toBitmap();
    if (isLikelyBlankBitmap(nextBitmap, nextSize.width, nextSize.height)) {
      return {
        ok: false,
        engine,
        errorCode: 'BLANK_CAPTURE',
        error:
          '当前截图疑似全黑，视觉比较无意义。请改用 engine=playwright，或先 browser_status 确认渲染状态。',
        baselinePath
      };
    }

    let baselineBuf = null;
    try {
      baselineBuf = await fs.readFile(baselinePath);
    } catch {
      baselineBuf = null;
    }

    if (!baselineBuf || params.reset === true) {
      await fs.mkdir(path.dirname(baselinePath), { recursive: true });
      await fs.writeFile(baselinePath, currentBuf);
      await fs.writeFile(
        metaPath,
        JSON.stringify(
          {
            engine,
            width: shot.width,
            height: shot.height,
            fullPage: !!params.fullPage,
            element: params.ref || params.selector || '',
            createdAt: new Date().toISOString()
          },
          null,
          2
        )
      );
      return {
        ok: true,
        engine,
        baselineCreated: true,
        baselinePath,
        width: shot.width,
        height: shot.height,
        note: params.reset ? '已用当前截图重建基准。' : '已保存为新基准；再次调用即可比较差异。'
      };
    }

    let meta = null;
    try {
      meta = JSON.parse(await fs.readFile(metaPath, 'utf8'));
    } catch {
      meta = null;
    }
    if (meta && meta.engine && meta.engine !== engine) {
      return {
        ok: false,
        engine,
        errorCode: 'BASELINE_ENGINE_MISMATCH',
        error: `基准由 ${meta.engine} 引擎创建，当前是 ${engine}；跨引擎像素必然不同，请用同一引擎重跑，或 reset=true 重建基准。`,
        baselinePath
      };
    }

    const prevImg = nativeImage.createFromBuffer(baselineBuf);
    const prevSize = prevImg.getSize();

    if (prevSize.width !== nextSize.width || prevSize.height !== nextSize.height) {
      const diffPath = resolveOutputPath(params.filePath, 'png', 'dieyun-visual-diff');
      await fs.mkdir(path.dirname(diffPath), { recursive: true });
      await fs.writeFile(diffPath, currentBuf);
      return {
        ok: true,
        engine,
        changed: true,
        dimensionChanged: true,
        baselinePath,
        diffPath,
        baselineSize: { width: prevSize.width, height: prevSize.height },
        currentSize: { width: nextSize.width, height: nextSize.height },
        note: '尺寸变化（视口或内容高度不同），已把当前截图写出作为参考；建议先用 browser_viewport 统一视口。'
      };
    }

    const diff = diffBitmaps(prevImg.toBitmap(), nextBitmap, {
      width: nextSize.width,
      height: nextSize.height,
      ratioThreshold: clampRatio(params.threshold, DEFAULT_RATIO_THRESHOLD)
    });
    const diffPath = resolveOutputPath(params.filePath, 'png', 'dieyun-visual-diff');
    await fs.mkdir(path.dirname(diffPath), { recursive: true });
    const diffPng = nativeImage
      .createFromBitmap(diff.diffBitmap, { width: nextSize.width, height: nextSize.height })
      .toPNG();
    await fs.writeFile(diffPath, diffPng);

    return {
      ok: true,
      engine,
      changed: !!diff.changed,
      bitmapMismatch: !diff.ok,
      changedPixels: diff.changedPixels,
      totalPixels: diff.totalPixels,
      changedRatio: Number(diff.ratio.toFixed(5)),
      changedPercent: Number((diff.ratio * 100).toFixed(3)),
      threshold: diff.ratioThreshold,
      baselinePath,
      diffPath,
      width: nextSize.width,
      height: nextSize.height,
      note: '红色为变化像素、浅灰为未变化；只有同引擎 + 同视口的比较才有意义。'
    };
  }

  /**
   * 清空日志缓冲（console + network），供 Agent 轮次开始时调用。
   * 缓冲是引擎级全局，不清会让上一轮/别的会话的残留错误触发本轮完成验收提示。
   */
  function resetLogs() {
    bvConsole.clear();
    pwConsole.clear();
    bvNetwork.clear();
    pwNetwork.clear();
    return { ok: true, cleared: ['console', 'network'] };
  }

  async function waitFor(args = {}) {
    const engine = resolveEngine(args.engine, { interaction: true, sessionId: args.sessionId });
    const result = await getRunner(engine).waitFor(runnerArgs(engine, args));
    if (engine === 'browserview' && pickEngine(args.engine) === 'auto' && isBlankBrowserViewResult(result)) {
      return fallbackToPlaywrightAfterBlank(args, () => pwRunner.waitFor(withPwOpts(args))).catch((e) => ({
        ...result,
        fallbackError: e && e.message ? e.message : String(e)
      }));
    }
    return result;
  }

  async function tabs(args = {}) {
    const engine = resolveEngine(args.engine, { interaction: true, sessionId: args.sessionId });
    const result = await getRunner(engine).tabs(args);
    activeEngine = engine;
    return result;
  }

  async function downloads(args = {}) {
    const engine = resolveEngine(args.engine, { interaction: true, sessionId: args.sessionId });
    return getRunner(engine).downloads(args);
  }

  async function uploadFile(args = {}) {
    const requested = pickEngine(args.engine);
    const engine = requested === 'auto'
      ? (args.ref ? resolveAutoInteractionEngine() : 'playwright')
      : requested;
    const result = await getRunner(engine).uploadFile(args);
    activeEngine = engine;
    return result;
  }

  async function observe(opts = {}) {
    const engine = resolveEngine(opts.engine, { interaction: true, sessionId: opts.sessionId });
    try {
      const result = await getRunner(engine).observe(opts);
      if (engine === 'browserview' && pickEngine(opts.engine) === 'auto' && isBlankBrowserViewResult(result)) {
        return fallbackToPlaywrightAfterBlank(opts, () => pwRunner.observe(opts)).catch((e) => ({
          ...result,
          fallbackError: e && e.message ? e.message : String(e)
        }));
      }
      return result;
    } catch (e) {
      if (engine === 'browserview' && pickEngine(opts.engine) === 'auto' && isBrowserCaptureSurfaceError(e)) {
        const fb = await fallbackToPlaywrightAfterBlank(opts, () => pwRunner.observe(withPwOpts(opts))).catch(
          () => null
        );
        if (fb) return fb;
      }
      throw e;
    }
  }

  async function reload(opts = {}) {
    const engine = resolveEngine(opts.engine, { interaction: true, sessionId: opts.sessionId });
    if (engine === 'playwright') await ensurePlaywrightSessionSynced();
    const result = await getRunner(engine).reload(opts);
    if (result?.url && engine === 'playwright') {
      viewCtrl.navigate(result.url, { waitUntil: 'domcontentloaded', timeoutMs: opts.timeoutMs }).catch(() => {});
    }
    activeEngine = engine;
    return result;
  }

  async function goBack(opts = {}) {
    const engine = resolveEngine(opts.engine, { interaction: true, sessionId: opts.sessionId });
    if (engine === 'playwright') await ensurePlaywrightSessionSynced();
    const result = await getRunner(engine).goBack(opts);
    if (result?.ok && result.url && engine === 'playwright') {
      viewCtrl.navigate(result.url, { waitUntil: 'domcontentloaded', timeoutMs: opts.timeoutMs }).catch(() => {});
    }
    activeEngine = engine;
    return result;
  }

  async function goForward(opts = {}) {
    const engine = resolveEngine(opts.engine, { interaction: true, sessionId: opts.sessionId });
    if (engine === 'playwright') await ensurePlaywrightSessionSynced();
    const result = await getRunner(engine).goForward(opts);
    if (result?.ok && result.url && engine === 'playwright') {
      viewCtrl.navigate(result.url, { waitUntil: 'domcontentloaded', timeoutMs: opts.timeoutMs }).catch(() => {});
    }
    activeEngine = engine;
    return result;
  }

  async function importStorage(params = {}) {
    const cookies = Array.isArray(params.cookies) ? params.cookies : [];
    const ls =
      params.localStorage && typeof params.localStorage === 'object' && !Array.isArray(params.localStorage)
        ? params.localStorage
        : null;
    const lsKeys = ls ? Object.keys(ls) : [];
    if (!cookies.length && !lsKeys.length) {
      const err = new Error('browser_import_storage 需要 cookies 数组或 localStorage 对象');
      err.code = 'IMPORT_EMPTY';
      throw err;
    }
    const summary = [
      cookies.length ? `Cookie ${cookies.length} 条` : null,
      lsKeys.length ? `localStorage ${lsKeys.length} 项（写入当前页同源）` : null
    ]
      .filter(Boolean)
      .join('；');
    if (typeof deps.confirmBrowserImport !== 'function') {
      const err = new Error('登录态导入确认不可用');
      err.code = 'IMPORT_CONFIRM_UNAVAILABLE';
      throw err;
    }
    const approved = await deps.confirmBrowserImport(summary);
    if (!approved) {
      return { ok: false, cancelled: true, error: '用户取消了登录态导入', errorCode: 'IMPORT_CANCELLED' };
    }
    const cookieResult = cookies.length
      ? await importCookiesToElectron(cookies, {
          sessionId: params.sessionId || sessionScope.getActiveViewSessionId()
        })
      : { applied: 0, failed: 0, total: 0 };
    let localStorageResult = { ok: true, applied: 0 };
    if (lsKeys.length) {
      const engine = resolveEngine(params.engine, { interaction: true, sessionId: params.sessionId });
      if (engine === 'playwright') await ensurePlaywrightSessionSynced();
      localStorageResult = await getRunner(engine).importLocalStorage(ls);
    }
    await ensurePlaywrightSessionSynced();
    return {
      ok: true,
      cookies: cookieResult,
      localStorage: localStorageResult,
      note: '登录态已写入 BrowserView 分区；若页面未刷新请调用 browser_reload。Playwright 后备引擎 Cookie 已同步。'
    };
  }

  /**
   * 导出当前页面为 PDF 并落盘（base64 不进模型上下文，只返回路径）。
   * auto 模式下若 Playwright 处于可见窗口，自动回退到 BrowserView。
   */
  async function pdf(params = {}) {
    const engine = resolveEngine(params.engine, { sessionId: params.sessionId });
    let activeForCall = engine;
    let result;
    try {
      result = await getRunner(engine).pdf(runnerArgs(engine, params));
    } catch (e) {
      // 后台会话的 Playwright 属于另一个页面，回退到 BrowserView 会打印错页面
      const isBackground = !!(params.sessionId && sessionScope.isBackgroundSession(params.sessionId));
      const canFallback =
        pickEngine(params.engine) === 'auto' &&
        engine === 'playwright' &&
        !isBackground &&
        String(e && e.code) === 'PDF_HEADLESS_ONLY';
      if (!canFallback) throw e;
      activeForCall = 'browserview';
      result = await getRunner('browserview').pdf(params);
    }
    const target = resolveOutputPath(params.filePath, 'pdf', 'dieyun-page');
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, Buffer.from(result.base64, 'base64'));
    return {
      ok: true,
      engine: activeForCall,
      path: target,
      bytes: result.bytes || 0,
      mime: 'application/pdf',
      note: 'PDF 已保存到本地路径；需要内容时用 fs_read_file（base64）或 PDF 技能解析该文件。'
    };
  }

  /**
   * 导出当前浏览器分区的登录态（Cookie + localStorage），须用户本机弹窗确认。
   * 是 browser_import_storage 的反向操作。
   */
  async function exportStorage(params = {}) {
    const wantCookies = params.cookies !== false;
    const wantLocalStorage = params.localStorage !== false;
    if (!wantCookies && !wantLocalStorage) {
      const err = new Error('browser_export_storage 至少需要导出 cookies 或 localStorage 之一');
      err.code = 'EXPORT_EMPTY';
      throw err;
    }
    if (typeof deps.confirmBrowserExport !== 'function') {
      const err = new Error('登录态导出确认不可用');
      err.code = 'EXPORT_CONFIRM_UNAVAILABLE';
      throw err;
    }
    const url = params.url ? String(params.url) : '';
    const scope = url ? `同源 ${url}` : '当前浏览器分区';
    const approved = await deps.confirmBrowserExport(
      `${scope}的 ${[wantCookies ? 'Cookie' : null, wantLocalStorage ? 'localStorage' : null]
        .filter(Boolean)
        .join(' + ')}`
    );
    if (!approved) {
      return { ok: false, cancelled: true, error: '用户取消了登录态导出', errorCode: 'EXPORT_CANCELLED' };
    }

    const sessionId = params.sessionId ? String(params.sessionId) : sessionScope.getActiveViewSessionId();
    const engine = resolveEngine(params.engine, { sessionId: params.sessionId });
    const out = { ok: true, engine };

    if (wantCookies) {
      const cookies = await exportCookiesForPlaywright({
        url: url || undefined,
        sessionId: sessionId || undefined
      });
      out.cookieCount = cookies.length;
      out.cookies = cookies.slice(0, MAX_EXPORT_COOKIES);
      out.truncated = cookies.length > MAX_EXPORT_COOKIES;
    }

    if (wantLocalStorage) {
      if (engine === 'playwright') await ensurePlaywrightSessionSynced();
      const ls = await getRunner(engine).readLocalStorage();
      if (ls && ls.ok) {
        out.localStorageOrigin = ls.origin || '';
        out.localStorageCount = Number(ls.count) || 0;
        out.localStorage = ls.items && typeof ls.items === 'object' ? ls.items : {};
      } else {
        out.localStorageError = (ls && ls.error) || '读取 localStorage 失败';
      }
    }

    out.note =
      '导出的 Cookie / localStorage 含登录态，请勿写入日志或提交版本库；可与 browser_import_storage 配对使用。';
    return out;
  }

  /** 对话框：list（默认）| handle | policy。避免 alert/confirm 卡死页面。 */
  async function dialog(args = {}) {
    const engine = resolveEngine(args.engine, { interaction: true, sessionId: args.sessionId });
    if (engine === 'playwright') await ensurePlaywrightSessionSynced();
    return getRunner(engine).dialog(args);
  }

  /** 请求改写：list（默认）| add | remove | clear；用于 mock 接口 / 改请求头 / 阻断资源。 */
  async function route(args = {}) {
    const engine = resolveEngine(args.engine, { interaction: true, sessionId: args.sessionId });
    if (engine === 'playwright') await ensurePlaywrightSessionSynced();
    return getRunner(engine).route(runnerArgs(engine, args));
  }

  /** 设备/权限模拟：set（默认）| reset | status（定位/时区/语言/权限授权）。 */
  async function emulate(args = {}) {
    const engine = resolveEngine(args.engine, { interaction: true, sessionId: args.sessionId });
    if (engine === 'playwright') await ensurePlaywrightSessionSynced();
    return getRunner(engine).emulate(runnerArgs(engine, args));
  }

  /**
   * Cookie 细粒度读写：list / set / delete。
   * 写入与删除作用于 BrowserView 分区，并同步到 Playwright 后备上下文。
   */
  async function cookies(params = {}) {
    const action = String(params.action || 'list').toLowerCase();
    const sessionId = params.sessionId
      ? String(params.sessionId)
      : sessionScope.getActiveViewSessionId() || undefined;
    const url = params.url ? String(params.url) : '';

    const collectRows = () => {
      if (Array.isArray(params.cookies) && params.cookies.length) return params.cookies;
      if (!params.name) return [];
      const row = { name: params.name };
      if (params.value != null) row.value = params.value;
      if (url) row.url = url;
      if (params.domain) row.domain = params.domain;
      if (params.path) row.path = params.path;
      if (params.secure != null) row.secure = !!params.secure;
      if (params.httpOnly != null) row.httpOnly = !!params.httpOnly;
      if (params.sameSite) row.sameSite = params.sameSite;
      return [row];
    };

    if (action === 'list') {
      const list = await exportCookiesForPlaywright({ url: url || undefined, sessionId });
      return {
        ok: true,
        action,
        url: url || '',
        count: list.length,
        cookies: list.slice(0, MAX_EXPORT_COOKIES),
        truncated: list.length > MAX_EXPORT_COOKIES,
        note: 'Cookie 含登录态，勿写入日志或版本库；仅返回当前浏览器分区。'
      };
    }

    const rows = collectRows();
    if (!rows.length) {
      const err = new Error(`browser_cookies ${action} 需要 cookies 数组或 name`);
      err.code = 'COOKIE_TARGET_REQUIRED';
      throw err;
    }

    if (action === 'set') {
      const applied = await importCookiesToElectron(rows, { sessionId });
      await ensurePlaywrightSessionSynced(sessionId);
      return {
        ok: applied.failed === 0,
        action,
        ...applied,
        note: '已写入 BrowserView 分区并同步到 Playwright；如页面未生效请调用 browser_reload。'
      };
    }

    if (action === 'delete' || action === 'remove') {
      const removed = await removeCookiesFromElectron(rows, { sessionId });
      if (typeof pwRunner.clearCookies === 'function') {
        await pwRunner.clearCookies(sessionId ? { sessionId } : {});
      }
      await ensurePlaywrightSessionSynced(sessionId);
      return { ok: removed.failed === 0, action: 'delete', ...removed };
    }

    const err = new Error(`browser_cookies 不支持的 action: ${action}（list | set | delete）`);
    err.code = 'COOKIE_ACTION_INVALID';
    throw err;
  }

  /**
   * 把当前网络记录（HAR-lite 缓冲）导出为 HAR 1.2 文件，返回路径。
   * 仅含方法与状态等摘要字段，不含请求/响应头与 body。
   */
  async function exportHar(params = {}) {
    const requested = pickEngine(params.engine);
    const engine = resolveEngine(params.engine, { sessionId: params.sessionId });
    const entries =
      requested === 'auto'
        ? [...bvNetwork.list({ limit: 200 }), ...pwNetwork.list({ limit: 200 })].sort(
            (a, b) => (a.ts || 0) - (b.ts || 0)
          )
        : (engine === 'playwright' ? pwNetwork : bvNetwork).list({ limit: 200 });
    const har = toHar(entries);
    const target = resolveOutputPath(params.filePath, 'har', 'dieyun-network');
    await fs.mkdir(path.dirname(target), { recursive: true });
    const text = JSON.stringify(har, null, 2);
    await fs.writeFile(target, text, 'utf8');
    return {
      ok: true,
      engine,
      path: target,
      count: entries.length,
      bytes: Buffer.byteLength(text, 'utf8'),
      note: 'HAR 仅含方法与状态摘要（无请求/响应头与 body）；可用浏览器 DevTools 打开。'
    };
  }

  /** 模型侧任意 JS 执行（授权复用 browserAutomation；工具层已归入 mutating）。 */
  async function evaluate(args = {}) {
    const engine = resolveEngine(args.engine, { interaction: true, sessionId: args.sessionId });
    if (engine === 'playwright') await ensurePlaywrightSessionSynced();
    const timeoutMs = Math.min(60000, Math.max(1000, Number(args.timeoutMs) || 15000));
    return withTimeout(
      getRunner(engine).evaluateScript(runnerArgs(engine, args)),
      timeoutMs,
      '脚本执行'
    );
  }

  function setPanelState(state) {
    return viewCtrl.setPanelState(state);
  }

  async function configure(params = {}) {
    if (params.playwrightHeaded != null) {
      playwrightHeaded = !!params.playwrightHeaded;
      await pwRunner.setHeaded(playwrightHeaded);
    }
    return {
      ok: true,
      playwrightHeaded,
      activeEngine,
      interactionEngine: resolveAutoInteractionEngine(),
      browserview: viewCtrl.status(),
      playwright: pwRunner.status()
    };
  }

  async function a11ySnapshot(opts = {}) {
    const engine = resolveEngine(opts.engine, { interaction: true, sessionId: opts.sessionId });
    if (engine === 'playwright') await ensurePlaywrightSessionSynced();
    return getRunner(engine).a11ySnapshot(runnerArgs(engine, opts));
  }

  function network(opts = {}) {
    const requested = pickEngine(opts.engine);
    const engine = resolveEngine(opts.engine, { interaction: true, sessionId: opts.sessionId });
    const action = String(opts.action || 'list').toLowerCase();
    if (action === 'clear') {
      if (requested === 'auto') {
        bvNetwork.clear();
        pwNetwork.clear();
      } else {
        (engine === 'playwright' ? pwNetwork : bvNetwork).clear();
      }
      return { ok: true, engine, cleared: true };
    }
    let entries;
    if (requested === 'auto') {
      const merged = [
        ...bvNetwork.list({ ...opts, limit: 200 }),
        ...pwNetwork.list({ ...opts, limit: 200 })
      ].sort((a, b) => (a.ts || 0) - (b.ts || 0));
      const limit = Math.min(200, Math.max(1, Number(opts.limit) || 50));
      entries = merged.slice(-limit);
    } else {
      entries = (engine === 'playwright' ? pwNetwork : bvNetwork).list(opts);
    }
    return {
      ok: true,
      engine,
      ...summarizeHarEntries(entries),
      stats: { browserview: bvNetwork.status(), playwright: pwNetwork.status() },
      note: 'HAR-lite：记录最近 HTTP(S) 请求；action=clear 可清空缓冲'
    };
  }

  function consoleMessages(opts = {}) {
    const requested = pickEngine(opts.engine);
    const engine = resolveEngine(opts.engine, { interaction: true, sessionId: opts.sessionId });
    if (String(opts.action || 'list').toLowerCase() === 'clear') {
      if (requested === 'auto') {
        bvConsole.clear();
        pwConsole.clear();
      } else {
        (engine === 'playwright' ? pwConsole : bvConsole).clear();
      }
      return { ok: true, engine, cleared: true };
    }
    let entries;
    if (requested === 'auto') {
      const merged = [
        ...bvConsole.list({ ...opts, limit: 200 }),
        ...pwConsole.list({ ...opts, limit: 200 })
      ].sort((a, b) => (a.ts || 0) - (b.ts || 0));
      const limit = Math.min(200, Math.max(1, Number(opts.limit) || 50));
      entries = merged.slice(-limit);
    } else {
      entries = (engine === 'playwright' ? pwConsole : bvConsole).list(opts);
    }
    return {
      ok: true,
      engine,
      ...summarizeConsoleEntries(entries),
      stats: { browserview: bvConsole.status(), playwright: pwConsole.status() },
      note: 'console-lite：记录页面 console 调用与未捕获异常/未处理拒绝；action=clear 可清空缓冲'
    };
  }

  function status() {
    const viewStatus = viewCtrl.status();
    const pwStatus = pwRunner.status();
    return {
      ok: true,
      activeEngine,
      interactionEngine: resolveAutoInteractionEngine(),
      forcePlaywrightUrl,
      playwrightHeaded,
      browserview: viewStatus,
      playwright: pwStatus
    };
  }

  async function close() {
    await pwRunner.close();
    viewCtrl.close();
    activeEngine = 'browserview';
    forcePlaywrightUrl = '';
    return { ok: true };
  }

  function hideForOverlay() {
    viewCtrl.hideForOverlay();
  }

  function restoreAfterOverlay() {
    viewCtrl.restoreAfterOverlay();
  }

  function onWindowResize() {
    viewCtrl.onWindowResize();
  }

  return {
    navigate,
    snapshot,
    click,
    type: typeText,
    fill,
    selectOption,
    scroll,
    pressKey,
    screenshot,
    waitFor,
    tabs,
    downloads,
    uploadFile,
    observe,
    reload,
    goBack,
    goForward,
    importStorage,
    pdf,
    exportStorage,
    cookies,
    dialog,
    route,
    emulate,
    exportHar,
    evaluate,
    hover,
    drag,
    configure,
    a11ySnapshot,
    network,
    consoleMessages,
    setViewport,
    expect,
    visualDiff,
    resetLogs,
    setPanelState,
    status,
    close,
    hideForOverlay,
    restoreAfterOverlay,
    onWindowResize,
    setActiveViewSessionId: (sessionId) => {
      const prev = sessionScope.getActiveViewSessionId();
      const sid = sessionId ? String(sessionId).trim() : null;
      sessionScope.setActiveViewSessionId(sid);
      if (prev && prev !== sid) {
        const st = viewCtrl.status();
        sessionScope.updateMeta(prev, { url: st.url, title: st.title, engine: activeEngine });
      }
      const swap = viewCtrl.activateSession(sid);
      if (swap.swapped && sid) {
        const meta = sessionScope.getMeta(sid);
        if (meta?.url) {
          viewCtrl.navigate(meta.url, { waitUntil: 'domcontentloaded' }).catch(() => {});
        }
      }
      if (typeof pwRunner.activateSession === 'function') {
        pwRunner.activateSession(sid);
      }
      // 视口覆盖是引擎级全局状态；切会话后它不再代表当前页，清掉以免 browser_status 与实际不一致
      Promise.resolve(viewCtrl.resetViewport()).catch(() => {});
      Promise.resolve(pwRunner.resetViewport()).catch(() => {});
      // 定位/权限模拟同样是引擎级状态，切会话必须清掉，否则会泄漏到另一个会话的页面
      Promise.resolve(viewCtrl.resetEmulation()).catch(() => {});
      Promise.resolve(pwRunner.resetEmulation()).catch(() => {});
      return swap;
    },
    getSessionBrowserMeta: (sessionId) => sessionScope.getMeta(sessionId)
  };
}

module.exports = { createBrowserService };
