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
const { summarizeHarEntries, toHar } = require('./network-collector');
const { summarizeConsoleEntries } = require('./console-collector');
const { summarizeTimeline } = require('./timeline');
const { createJournalScope } = require('./journal-scope');
const { normalizeAssertions, shapeExpectResult } = require('./expect');
const { diffBitmaps, clampRatio, stableKey, DEFAULT_RATIO_THRESHOLD } = require('./visual-diff');
const { buildContentSignalsScript, classifyBitmapRenderHealth } = require('./render-health');
const { createBrowserSessionScope } = require('./session-scope');
const { mintSnapshotId, normalizeSnapshotId, isRefFailureError, enrichRefFailure } = require('./ref-namespace');
const {
  ENGINE_AUTO,
  ENGINE_BROWSERVIEW,
  ENGINE_PLAYWRIGHT,
  REASON,
  isEngine,
  resolveTarget,
  applyTarget,
  retarget
} = require('./engine-target');

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
  /**
   * 观察账本（network / console / timeline）按会话归位，两个引擎共用同一份。
   * 引擎不再决定「这条观察属于谁」：写入时给会话 id，读取时用同一个 key。
   */
  const journals = createJournalScope({
    resolveDefaultSessionId: () => sessionScope.getActiveViewSessionId()
  });
  const viewCtrl = createBrowserViewController({ ...deps, journals });
  const pwRunner = createPlaywrightRunner({ log, journals });
  let playwrightHeaded = false;

  /**
   * 会话 → 「当前页面归属引擎」（navigation owner）。
   * 唯一来源：session-scope meta.engine。auto 的语义就是跟随归属，不再比较 URL 字符串。
   * 归属键本身由 journal-scope 归一（同一 key 供账本读写两侧使用）。
   */
  function ownerKey(sessionId) {
    return journals.keyOf(sessionId);
  }

  function ownerEngine(sessionId) {
    const meta = sessionScope.getMeta(ownerKey(sessionId));
    return isEngine(meta && meta.engine) ? meta.engine : ENGINE_BROWSERVIEW;
  }

  /** 记录归属：engine 用已决策的引擎，不读结果自报。 */
  function setOwner(sessionId, engine, result) {
    const patch = { engine };
    if (result && result.url != null) patch.url = result.url;
    if (result && result.title != null) patch.title = result.title;
    sessionScope.updateMeta(ownerKey(sessionId), patch);
  }

  /**
   * 解析唯一执行目标：只有这里能决定引擎。
   * 会话身份走 session-scope 的单一规则（显式 sessionId → 前台 BrowserView 会话）：
   * 实例名、归属引擎与观察账本必须同名，否则 auto 调用（不带 sessionId）会得到
   * `browserview#default`，显式调用得到 `browserview#s-…`，看起来像两个实例。
   */
  function targetFor(args = {}) {
    const sessionId = sessionScope.resolveEffectiveSessionId(args.sessionId);
    return resolveTarget({
      requested: args.engine,
      sessionId,
      ownerEngine: ownerEngine(sessionId),
      isBackgroundSession: !!(sessionId && sessionScope.isBackgroundSession(sessionId))
    });
  }

  function withPwOpts(opts = {}) {
    const out = { ...(opts || {}) };
    if (out.headed == null && playwrightHeaded) out.headed = true;
    return out;
  }

  function runnerArgs(engine, args = {}) {
    return engine === ENGINE_PLAYWRIGHT ? withPwOpts(args) : args;
  }

  function getRunner(engine) {
    return engine === ENGINE_PLAYWRIGHT ? pwRunner : viewCtrl;
  }

  /** playwright → BrowserView 的显示镜像。仅前台会话，且绝不改变归属。 */
  function mirrorToView(target, result, opts = {}) {
    if (!result || !result.url || target.backgroundSession) return;
    viewCtrl.navigate(result.url, { waitUntil: 'domcontentloaded', timeoutMs: opts.timeoutMs }).catch(() => {});
  }

  /**
   * 只有「确认空白」才允许改道：像素全黑 **且** 页面无可见内容（render-health 唯一判定）。
   * 深色主题页面（全黑像素但有内容）不是空白，绝不改道 —— 改道会丢掉 ref / Cookie / 登录态。
   */
  function isBlankBrowserViewResult(result) {
    return result?.engine === ENGINE_BROWSERVIEW && !!result?.renderHealth?.likelyBlank;
  }

  /**
   * 把会话账本里的事实（实例身份 / 页面 / snapshot 世代 / 是否导航过）喂给 ref-namespace 的
   * enrichRefFailure —— 错误体本身由那边唯一组装，这里只负责取数。
   */
  function withRefFailureDiagnostics(result, target, sessionId) {
    if (!result || result.ok !== false || !isRefFailureError(result)) return result;
    const key = ownerKey(sessionId);
    const snapshot = sessionScope.getSnapshot(key);
    const meta = sessionScope.getMeta(key);
    // 引擎在失败体里自报的 url 是「页面当场在哪」的第一手证据：页面自己跳转
    // （表单提交 / JS 重定向）不经过 navigate 工具，账本里没有导航事件，
    // 只有这个 url 能证明 snapshot 之后的这次跳转。
    const currentUrl = result.url || (meta && meta.url);
    return enrichRefFailure(result, {
      engine: target.engine,
      instanceId: target.instanceId,
      url: currentUrl,
      refEpoch: snapshot ? snapshot.epoch : undefined,
      navigatedSinceSnapshot: sessionScope.navigatedSinceSnapshot(key, { currentUrl })
    });
  }

  /**
   * 引擎无关的「页面有没有内容」探测：统一走 browser_evaluate 的脚本包装，
   * 两个引擎同一份脚本（render-health.buildContentSignalsScript）。取不到返回 null（= 未知）。
   * 返回页面原始信号，规整交给 render-health（避免两处各写一遍字段解读）。
   */
  async function probePageContent(engine, opts = {}) {
    try {
      const res = await getRunner(engine).evaluateScript(
        runnerArgs(engine, { script: buildContentSignalsScript(), timeoutMs: opts.timeoutMs, sessionId: opts.sessionId })
      );
      if (!res || res.ok === false || typeof res.json !== 'string') return null;
      const raw = JSON.parse(res.json);
      return raw && typeof raw === 'object' ? raw : null;
    } catch (e) {
      log('Browser content probe: ' + (e && e.message ? e.message : e));
      return null;
    }
  }

  /**
   * BrowserView 确认未渲染（全黑且无可见内容）时改用 Playwright 重跑。
   * 这是运行期改道，必须回填 target，让模型看见实际执行者换了。
   */
  async function fallbackToPlaywrightAfterBlank(opts, invoke, target) {
    const viewStatus = viewCtrl.status();
    const url = viewStatus.url || viewStatus.renderHealth?.page?.url || '';
    if (!url) return null;
    const sessionSync = await ensurePlaywrightSessionSynced(opts?.sessionId);
    await pwRunner.navigate(url, {
      waitUntil: 'domcontentloaded',
      timeoutMs: opts?.timeoutMs || 30000
    });
    setOwner(opts?.sessionId, ENGINE_PLAYWRIGHT, { url });
    const result = await invoke();
    return {
      ...retarget(result, target, { engine: ENGINE_PLAYWRIGHT, reason: REASON.BLANK_CAPTURE }),
      fallbackFrom: ENGINE_BROWSERVIEW,
      fallbackReason: 'browserview_blank',
      sessionSync,
      note: [
        result?.note,
        'BrowserView 画面全黑且页面无可见内容（确认未渲染），已改用 Playwright 重试。',
        sessionSync.synced ? `已从 BrowserView 同步 ${sessionSync.synced} 条 Cookie 到 Playwright。` : null,
        playwrightHeaded ? 'Playwright 可见窗口已启用。' : null
      ]
        .filter(Boolean)
        .join('；')
    };
  }

  async function ensurePlaywrightSessionSynced(sessionId) {
    if (typeof pwRunner.syncSessionFromElectron !== 'function') return { synced: 0 };
    const sid = sessionScope.resolveEffectiveSessionId(sessionId);
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

  /** 派发结果统一收尾：回填 target + 记录本会话归属。 */
  function settle(result, target, args = {}) {
    setOwner(args.sessionId, target.engine, result);
    return applyTarget(result, target);
  }

  /**
   * 单次引擎派发：解析唯一 target → 调用对应 runner → 回填 target。
   * 所有 browser_* 都必须走这里；方法体内禁止再自己决策引擎。
   */
  async function dispatch(method, args = {}) {
    const target = targetFor(args);
    if (target.engine === ENGINE_PLAYWRIGHT) await ensurePlaywrightSessionSynced(args.sessionId);
    const result = await getRunner(target.engine)[method](runnerArgs(target.engine, args));
    return settle(withRefFailureDiagnostics(result, target, args.sessionId), target, args);
  }

  /**
   * 交互类派发：browserview 目标未找到且页面存在跨域 frame 时，改道 Playwright 重试。
   * 重试成功的结果已回填 target（downgraded + cross_frame_iframe）。
   */
  async function dispatchInteraction(method, args = {}) {
    const target = targetFor(args);
    if (target.engine === ENGINE_PLAYWRIGHT) await ensurePlaywrightSessionSynced(args.sessionId);
    const result = await getRunner(target.engine)[method](runnerArgs(target.engine, args));
    setOwner(args.sessionId, target.engine, result);
    if (target.engine === ENGINE_BROWSERVIEW) {
      const retried = await retryOnPlaywrightForIframe(method, args, result, target);
      if (retried) return retried;
    }
    return applyTarget(withRefFailureDiagnostics(result, target, args.sessionId), target);
  }

  /**
   * 带 BrowserView 兜底的派发（snapshot / screenshot / waitFor / observe）。
   * 兜底只在 auto 请求下触发：显式指定 browserview 时失败即失败，不改道。
   *   1. 结果确认空白（全黑像素 + 页面无可见内容，见 render-health；单纯深色主题不改道）；
   *   2. 抛抓取面不可用错误（硬失败）。
   */
  async function dispatchWithBlankFallback(method, args = {}) {
    const target = targetFor(args);
    const engine = target.engine;
    if (engine === ENGINE_PLAYWRIGHT) await ensurePlaywrightSessionSynced(args.sessionId);
    const canFallback = engine === ENGINE_BROWSERVIEW && !target.explicit;
    let fallbackError = '';
    const tryFallback = async () => {
      try {
        return await fallbackToPlaywrightAfterBlank(
          args,
          () => pwRunner[method](runnerArgs(ENGINE_PLAYWRIGHT, args)),
          target
        );
      } catch (e) {
        fallbackError = (e && e.message) || String(e);
        return null;
      }
    };
    const keepResult = () => {
      const out = applyTarget(result, target);
      return fallbackError ? { ...out, fallbackError } : out;
    };
    let result;
    try {
      result = await getRunner(engine)[method](runnerArgs(engine, args));
    } catch (e) {
      if (canFallback && isBrowserCaptureSurfaceError(e)) {
        const fb = await tryFallback();
        if (fb) return fb;
      }
      throw e;
    }
    setOwner(args.sessionId, engine, result);
    if (canFallback && isBlankBrowserViewResult(result)) {
      const fb = await tryFallback();
      if (fb) return fb;
    }
    return keepResult();
  }

  async function navigate(url, opts = {}) {
    const target = targetFor(opts);
    const engine = target.engine;
    if (engine === ENGINE_PLAYWRIGHT) await ensurePlaywrightSessionSynced(opts.sessionId);
    try {
      const result = await getRunner(engine).navigate(url, runnerArgs(engine, opts));
      setOwner(opts.sessionId, engine, result);
      // 导航是 ref 失效的主因：记下「这次 snapshot 之后确实跳转过」。
      // 失败的导航不算 —— 页面没动，旧 ref 仍可能有效，不能给模型一个假前提。
      if (!result || result.ok !== false) {
        sessionScope.recordNavigation(ownerKey(opts.sessionId), { url: (result && result.url) || url });
      }
      mirrorToView(target, result, opts);
      return applyTarget(result, target);
    } catch (err) {
      // 硬失败兜底：playwright 侧失败无处可退（模块缺失 / 启动失败）
      if (engine !== ENGINE_BROWSERVIEW) throw err;
      if (String(err?.code || '') === 'PLAYWRIGHT_MISSING' || String(err?.code || '') === 'PLAYWRIGHT_LAUNCH_FAILED') {
        throw err;
      }
      log('BrowserView 导航失败，回退 Playwright: ' + (err.message || err));
      const sessionSync = await ensurePlaywrightSessionSynced(opts.sessionId);
      const pwResult = await pwRunner.navigate(url, runnerArgs(ENGINE_PLAYWRIGHT, opts));
      setOwner(opts.sessionId, ENGINE_PLAYWRIGHT, pwResult);
      if (!pwResult || pwResult.ok !== false) {
        sessionScope.recordNavigation(ownerKey(opts.sessionId), { url: (pwResult && pwResult.url) || url });
      }
      return {
        ...retarget(pwResult, target, { engine: ENGINE_PLAYWRIGHT, reason: REASON.NAVIGATE_FAILED }),
        fallbackFrom: ENGINE_BROWSERVIEW,
        fallbackReason: err.message || String(err),
        sessionSync
      };
    }
  }

  /**
   * 回填 snapshot 的 origin 身份：写进 session-scope（该会话的「当前 snapshot」）并回灌到结果。
   * snapshotId / refEpoch 只在这里产生——同一次 snapshot 的多个 frame 共享同一个 id，
   * refEpoch 是「本会话第几次 snapshot」，因此 ref 的失效判定与展示口径完全一致。
   */
  function stampSnapshotIdentity(result, args = {}, fallbackSnapshotId) {
    if (!result || result.ok === false) return result;
    const id = normalizeSnapshotId(result.snapshotId) || normalizeSnapshotId(fallbackSnapshotId);
    if (!id) return result;
    const recorded = sessionScope.recordSnapshot(ownerKey(args.sessionId), {
      id,
      engine: result.engine || '',
      url: result.url || ''
    });
    return recorded ? { ...result, snapshotId: recorded.id, refEpoch: recorded.epoch } : result;
  }

  async function snapshot(opts = {}) {
    // origin 身份在这里铸造：两个引擎（含兜底改道）拿到的是同一个 id
    const snapshotId = mintSnapshotId();
    const result = await dispatchWithBlankFallback('snapshot', { ...opts, snapshotId });
    return stampSnapshotIdentity(result, opts, snapshotId);
  }

  /**
   * 元素在主 frame 找不到、且页面存在跨域 iframe 时，改用 Playwright 重试
   * （Playwright 侧支持跨 frame 定位）。命中返回重试结果（已回填 target），否则返回 null。
   */
  async function retryOnPlaywrightForIframe(method, args, result, target) {
    if (!result || result.ok !== false || !result.crossFrameHint) return null;
    // ref 失效不是「换个引擎就能找到」的问题：ref 属于某一次 snapshot，
    // 换引擎只会命中另一个 DOM 的旧状态，正是本方案要消灭的「静默打到另一个元素」
    if (isRefFailureError(result)) return null;
    try {
      await ensurePlaywrightSessionSynced(args.sessionId);
      const retry = await pwRunner[method](runnerArgs(ENGINE_PLAYWRIGHT, args));
      if (retry && retry.ok) {
        setOwner(args.sessionId, ENGINE_PLAYWRIGHT, retry);
        return {
          ...retarget(retry, target, { engine: ENGINE_PLAYWRIGHT, reason: REASON.CROSS_FRAME }),
          fallbackFrom: ENGINE_BROWSERVIEW,
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
    return dispatchInteraction('click', args);
  }

  async function typeText(args = {}) {
    return dispatchInteraction('typeText', args);
  }

  async function fill(args = {}) {
    return typeText({ ...args, clear: true });
  }

  async function selectOption(args = {}) {
    return dispatchInteraction('selectOption', args);
  }

  async function hover(args = {}) {
    return dispatchInteraction('hover', args);
  }

  async function drag(args = {}) {
    return dispatch('drag', args);
  }

  async function scroll(args = {}) {
    return dispatch('scroll', args);
  }

  async function pressKey(args = {}) {
    return dispatch('pressKey', args);
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
    return saveScreenshotIfRequested(await dispatchWithBlankFallback('screenshot', opts), opts);
  }

  /**
   * 视口/设备仿真覆盖：让两个引擎在同一尺寸下渲染，避免验收结论漂移。
   * 同时把设置镜像到另一个引擎（只记状态，不创建页面/视图）：auto 中途换引擎后，
   * 新页面/视图会按同一尺寸渲染，不会出现"browser_status 报 390×844、实际 1280×800"。
   * 例外：后台会话不该镜像 —— BrowserView 是前台会话共享的单例，镜像过去等于改别人的页面。
   */
  async function setViewport(args = {}) {
    const target = targetFor(args);
    const engine = target.engine;
    if (engine === ENGINE_PLAYWRIGHT) await ensurePlaywrightSessionSynced(args.sessionId);
    const result = await getRunner(engine).setViewport(args);
    setOwner(args.sessionId, engine, result);
    const mirrorEngine = engine === ENGINE_PLAYWRIGHT ? ENGINE_BROWSERVIEW : ENGINE_PLAYWRIGHT;
    let mirrored = false;
    const mirror = target.backgroundSession ? null : getRunner(mirrorEngine);
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
    return applyTarget({ ...result, mirroredTo: mirrored ? mirrorEngine : null, note: note || undefined }, target);
  }

  /** 结构化断言：把「验过了」变成可被完成验收护栏识别的 pass/fail 证据。 */
  async function expect(args = {}) {
    const assertions = normalizeAssertions(args.assertions);
    const target = targetFor(args);
    const engine = target.engine;
    if (engine === ENGINE_PLAYWRIGHT) await ensurePlaywrightSessionSynced(args.sessionId);
    const timeoutMs = Math.min(60000, Math.max(1000, Number(args.timeoutMs) || 15000));
    const raw = await withTimeout(
      getRunner(engine).expect(assertions, { frame: args.frame, sessionId: args.sessionId }),
      timeoutMs,
      '断言执行'
    );
    if (raw && raw.ok === false && raw.errorCode) {
      return applyTarget(
        withRefFailureDiagnostics(
          {
            engine,
            ok: false,
            error: raw.error,
            errorCode: raw.errorCode,
            snapshotId: raw.snapshotId,
            currentSnapshotId: raw.currentSnapshotId,
            frames: raw.frames,
            results: []
          },
          target,
          args.sessionId
        ),
        target
      );
    }
    return applyTarget(shapeExpectResult(raw, { engine }), target);
  }

  /** frame 树：让 Agent 一眼看出内容在哪一层（含跨域 frame）。 */
  async function frames(args = {}) {
    const target = targetFor(args);
    const engine = target.engine;
    if (engine === ENGINE_PLAYWRIGHT) await ensurePlaywrightSessionSynced(args.sessionId);
    const runner = getRunner(engine);
    if (typeof runner.frames !== 'function') {
      return applyTarget({ ok: false, engine, error: '当前引擎不支持 frame 列表' }, target);
    }
    return applyTarget(await runner.frames(args), target);
  }

  /**
   * 事件时间线：page 侧真实事件 + Agent 侧动作，按会话归位（与 network/console 同一账本来源）。
   */
  function timeline(opts = {}) {
    return journalQuery(opts, {
      kind: 'timeline',
      summarize: (entries) => summarizeTimeline(entries, { includeInput: opts.includeInput === true }),
      limitMax: 300,
      defaultLimit: 80,
      note:
        '时间线 = 页面侧真实事件（capture 阶段，含 iframe 内）+ Agent 侧动作；' +
        '"点了没反应"先看这里有没有 click，再看 browser_console / browser_network'
    });
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
    const target = targetFor(params);
    return applyTarget(await runVisualDiff(params, target), target);
  }

  async function runVisualDiff(params, target) {
    const engine = target.engine;
    if (engine === ENGINE_PLAYWRIGHT) await ensurePlaywrightSessionSynced(params.sessionId);

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

    // 空白截图不能作为基准，也不能参与比较：否则会把"全黑"当成"没变化"。
    // 判据与运行时同源（render-health）：Playwright 截图不带 renderHealth，所以这里
    // 自己取位图 + 页面内容，但合成结论仍走 classifyBitmapRenderHealth —— 深色主题页面
    // （全黑像素但有可见内容）是合法基准，不允许被判成空白。
    const { nativeImage } = require('electron');
    const nextImg = nativeImage.createFromBuffer(currentBuf);
    const nextSize = nextImg.getSize();
    const nextBitmap = nextImg.toBitmap();
    const pageSignals = await probePageContent(engine, params);
    const captureHealth = classifyBitmapRenderHealth(
      nextBitmap,
      nextSize.width,
      nextSize.height,
      pageSignals
    );
    if (!captureHealth.bitmapUsable) {
      return {
        ok: false,
        engine,
        errorCode: 'CAPTURE_INVALID',
        error: '当前截图的像素数据不可用（尺寸或长度异常），无法作为基准比较，请重试或换 engine。',
        baselinePath
      };
    }
    if (captureHealth.likelyBlank) {
      return {
        ok: false,
        engine,
        errorCode: 'BLANK_CAPTURE',
        error:
          '当前截图全黑且页面无可见内容（确认未渲染），视觉比较无意义。请先 browser_status 确认渲染状态；确实要换实现再用 engine=playwright。',
        baselinePath,
        renderHealth: captureHealth
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
   * 只清「发起该轮次的会话」：不清会让上一轮的残留错误触发本轮完成验收提示，
   * 但清别人的会话又会让另一个会话的请求/日志凭空消失（这正是「登录请求查不到」的来源）。
   * 清空时间会被记录，查询时会明说，避免把「已清空」误读成「没发出去」。
   */
  function resetLogs(opts = {}) {
    return journals.clear(opts.sessionId, ['console', 'network']);
  }

  async function waitFor(args = {}) {
    return dispatchWithBlankFallback('waitFor', args);
  }

  async function tabs(args = {}) {
    return dispatch('tabs', args);
  }

  async function downloads(args = {}) {
    return dispatch('downloads', args);
  }

  async function uploadFile(args = {}) {
    return dispatch('uploadFile', args);
  }

  async function observe(opts = {}) {
    const result = await dispatchWithBlankFallback('observe', opts);
    // observe 内部也做了一次 snapshot，其 origin 同样要落进会话账本（ref 失效判定靠它）
    return stampSnapshotIdentity(result, opts);
  }

  /** 刷新 / 后退 / 前进：派发 + 归属 + 前台镜像，三处同一流程。 */
  async function historyDispatch(method, opts = {}) {
    const target = targetFor(opts);
    if (target.engine === ENGINE_PLAYWRIGHT) await ensurePlaywrightSessionSynced(opts.sessionId);
    const result = await getRunner(target.engine)[method](runnerArgs(target.engine, opts));
    setOwner(opts.sessionId, target.engine, result);
    // 刷新 / 后退 / 前进同属导航：同样会让旧 ref 失效
    if (!result || result.ok !== false) {
      sessionScope.recordNavigation(ownerKey(opts.sessionId), { url: (result && result.url) || '' });
    }
    mirrorToView(target, result, opts);
    return applyTarget(result, target);
  }

  async function reload(opts = {}) {
    return historyDispatch('reload', opts);
  }

  async function goBack(opts = {}) {
    return historyDispatch('goBack', opts);
  }

  async function goForward(opts = {}) {
    return historyDispatch('goForward', opts);
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
          sessionId: sessionScope.resolveEffectiveSessionId(params.sessionId)
        })
      : { applied: 0, failed: 0, total: 0 };
    let localStorageResult = { ok: true, applied: 0 };
    if (lsKeys.length) {
      const target = targetFor(params);
      if (target.engine === ENGINE_PLAYWRIGHT) await ensurePlaywrightSessionSynced(params.sessionId);
      localStorageResult = await getRunner(target.engine).importLocalStorage(ls);
    }
    await ensurePlaywrightSessionSynced(params.sessionId);
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
    const target = targetFor(params);
    let activeForCall = target.engine;
    let result;
    try {
      result = await getRunner(activeForCall).pdf(runnerArgs(activeForCall, params));
    } catch (e) {
      // 后台会话的 Playwright 属于另一个页面，回退到 BrowserView 会打印错页面
      const canFallback =
        !target.explicit &&
        activeForCall === ENGINE_PLAYWRIGHT &&
        !target.backgroundSession &&
        String(e && e.code) === 'PDF_HEADLESS_ONLY';
      if (!canFallback) throw e;
      activeForCall = ENGINE_BROWSERVIEW;
      result = await getRunner(ENGINE_BROWSERVIEW).pdf(params);
    }
    const outPath = resolveOutputPath(params.filePath, 'pdf', 'dieyun-page');
    await fs.mkdir(path.dirname(outPath), { recursive: true });
    await fs.writeFile(outPath, Buffer.from(result.base64, 'base64'));
    const payload = {
      ok: true,
      engine: activeForCall,
      path: outPath,
      bytes: result.bytes || 0,
      mime: 'application/pdf',
      note: 'PDF 已保存到本地路径；需要内容时用 fs_read_file（base64）或 PDF 技能解析该文件。'
    };
    return activeForCall === target.engine
      ? applyTarget(payload, target)
      : retarget(payload, target, { engine: activeForCall, reason: REASON.PDF_HEADLESS });
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

    const sessionId = sessionScope.resolveEffectiveSessionId(params.sessionId);
    const target = targetFor(params);
    const out = { ok: true, engine: target.engine };

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
    return applyTarget(out, target);
  }

  /** 对话框：list（默认）| handle | policy。避免 alert/confirm 卡死页面。 */
  async function dialog(args = {}) {
    return dispatch('dialog', args);
  }

  /** 请求改写：list（默认）| add | remove | clear；用于 mock 接口 / 改请求头 / 阻断资源。 */
  async function route(args = {}) {
    return dispatch('route', args);
  }

  /** 设备/权限模拟：set（默认）| reset | status（定位/时区/语言/权限授权）。 */
  async function emulate(args = {}) {
    return dispatch('emulate', args);
  }

  /**
   * Cookie 细粒度读写：list / set / delete。
   * 写入与删除作用于 BrowserView 分区，并同步到 Playwright 后备上下文。
   */
  async function cookies(params = {}) {
    const action = String(params.action || 'list').toLowerCase();
    const sessionId = sessionScope.resolveEffectiveSessionId(params.sessionId) || undefined;
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
    const target = targetFor(params);
    // 导出的是「本会话」的请求缓冲（engine 只作过滤），与 browser_network 读到的是同一份。
    const entries = journals.network(params.sessionId).list({
      limit: 200,
      engine: target.requested === ENGINE_AUTO ? undefined : target.engine
    });
    const har = toHar(entries);
    const outPath = resolveOutputPath(params.filePath, 'har', 'dieyun-network');
    await fs.mkdir(path.dirname(outPath), { recursive: true });
    const text = JSON.stringify(har, null, 2);
    await fs.writeFile(outPath, text, 'utf8');
    return applyTarget(
      {
        ok: true,
        engine: target.engine,
        path: outPath,
        count: entries.length,
        bytes: Buffer.byteLength(text, 'utf8'),
        note: 'HAR 仅含方法与状态摘要（无请求/响应头与 body）；可用浏览器 DevTools 打开。'
      },
      target
    );
  }

  /** 模型侧任意 JS 执行（授权复用 browserAutomation；工具层已归入 mutating）。 */
  async function evaluate(args = {}) {
    const target = targetFor(args);
    if (target.engine === ENGINE_PLAYWRIGHT) await ensurePlaywrightSessionSynced(args.sessionId);
    const timeoutMs = Math.min(60000, Math.max(1000, Number(args.timeoutMs) || 15000));
    return applyTarget(
      await withTimeout(
        getRunner(target.engine).evaluateScript(runnerArgs(target.engine, args)),
        timeoutMs,
        '脚本执行'
      ),
      target
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
      activeEngine: ownerEngine(params.sessionId),
      browserview: viewCtrl.status(),
      playwright: pwRunner.status()
    };
  }

  async function a11ySnapshot(opts = {}) {
    return dispatch('a11ySnapshot', opts);
  }

  /**
   * 日志类查询（timeline / network / console）的唯一实现：按会话取账本、引擎只作过滤、清理与 target 回填。
   * 归属键是会话（journal-scope），所以 auto 不再需要「合并两个引擎的缓冲」：
   * 读的就是本会话的全部条目（每条自带 engine），跨引擎改道也不会把记录丢在另一个桶里。
   */
  function journalQuery(opts, { kind, summarize, note, limitMax = 200, defaultLimit = 50 }) {
    const target = targetFor(opts);
    const { requested, engine } = target;
    const sessionKey = ownerKey(opts.sessionId);
    const journal = journals[kind](opts.sessionId);
    // auto = 只看会话归属，不按引擎过滤；显式引擎才把 engine 当过滤条件交给 journal。
    const scoped = { ...opts, engine: requested === ENGINE_AUTO ? undefined : engine };
    if (String(opts.action || 'list').toLowerCase() === 'clear') {
      journals.clear(opts.sessionId, [kind]);
      return applyTarget({ ok: true, engine, cleared: true, sessionKey, clearedAt: journals.clearedAt(opts.sessionId) }, target);
    }
    const limit = Math.min(limitMax, Math.max(1, Number(opts.limit) || defaultLimit));
    const entries = journal.list({ ...scoped, limit });
    return applyTarget(
      {
        ok: true,
        engine,
        ...summarize(entries),
        stats: {
          [ENGINE_BROWSERVIEW]: journal.status({ engine: ENGINE_BROWSERVIEW }),
          [ENGINE_PLAYWRIGHT]: journal.status({ engine: ENGINE_PLAYWRIGHT })
        },
        sessionKey,
        note: withClearedNote(note, opts.sessionId)
      },
      target
    );
  }

  /**
   * 缓冲被清空过就明说，避免「上一轮的登录请求查不到」被误判成「请求没发出去」。
   * 清空只作用于本会话（Agent 每轮开始 reset），别的会话的记录不受影响。
   */
  function withClearedNote(note, sessionId) {
    const at = journals.clearedAt(sessionId);
    if (!at) return note;
    return `${note}；注意：本会话缓冲已于 ${new Date(at).toISOString()} 清空（Agent 轮次开始 reset_logs），更早的记录不再保留`;
  }

  function network(opts = {}) {
    return journalQuery(opts, {
      kind: 'network',
      summarize: summarizeHarEntries,
      note: 'HAR-lite：记录最近 HTTP(S) 请求（按会话保存，engine 为条目属性）；action=clear 可清空本会话缓冲'
    });
  }

  function consoleMessages(opts = {}) {
    return journalQuery(opts, {
      kind: 'console',
      summarize: summarizeConsoleEntries,
      note: 'console-lite：记录页面 console 调用与未捕获异常/未处理拒绝（按会话保存）；action=clear 可清空本会话缓冲'
    });
  }

  /**
   * 全局状态：前台会话归属引擎、会话映射、各引擎可用性。
   * activeEngine 是前台会话的归属引擎（兼容字段，renderer 摘要仍在使用）。
   * target 说明「不带 engine 的调用会打到哪个引擎、为什么」。
   */
  function status(opts = {}) {
    // 与 targetFor 同一份会话身份：摘要里的 target.instanceId 必须和真实调用一致
    const sessionId = sessionScope.resolveEffectiveSessionId(opts.sessionId);
    const viewSessionId = sessionScope.getActiveViewSessionId();
    const backgroundSession = !!sessionId && sessionScope.isBackgroundSession(sessionId);
    const target = resolveTarget({
      requested: undefined,
      sessionId,
      ownerEngine: ownerEngine(sessionId),
      isBackgroundSession: backgroundSession
    });
    return {
      ok: true,
      activeEngine: ownerEngine(null),
      target,
      viewSessionId,
      backgroundSession,
      snapshot: sessionScope.getSnapshot(ownerKey(sessionId)),
      playwrightHeaded,
      browserview: viewCtrl.status(),
      playwright: pwRunner.status()
    };
  }

  async function close() {
    await pwRunner.close();
    viewCtrl.close();
    sessionScope.clearEngineOwners();
    // 页面没了，旧 snapshot 的 ref 必须判为失效，不能继续命中残留 DOM
    sessionScope.clearSnapshots();
    // 观察账本随浏览器一起丢弃：页面都没了，旧记录只会在下一轮被误读成本轮证据
    journals.reset();
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
    frames,
    timeline,
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
    /**
     * 切换「可见 BrowserView 承载哪个会话」。只影响视图与 playwright 的默认会话，
     * 不再影响任何调用的引擎选择（引擎由 engine-target.resolveTarget 按请求与归属决定）。
     */
    setActiveViewSessionId: (sessionId) => {
      const prev = sessionScope.getActiveViewSessionId();
      const sid = sessionId ? String(sessionId).trim() : null;
      const prevOwner = ownerEngine(prev);
      sessionScope.setActiveViewSessionId(sid);
      if (prev && prev !== sid) {
        const st = viewCtrl.status();
        sessionScope.updateMeta(prev, { url: st.url, title: st.title, engine: prevOwner });
      }
      const swap = viewCtrl.activateSession(sid);
      if (swap.swapped && sid) {
        const meta = sessionScope.getMeta(sid);
        if (meta?.url) {
          viewCtrl.navigate(meta.url, { waitUntil: 'domcontentloaded' }).catch(() => {});
        }
      }
      // playwright 的默认会话跟随视图会话；显式传 sessionId 的调用不受影响
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
