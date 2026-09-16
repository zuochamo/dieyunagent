'use strict';

const {
  buildSnapshotScript,
  buildTypePrepareScript,
  buildTypePrepareScriptBySelector,
  buildSelectOptionScript,
  buildImportLocalStorageScript,
  buildHoverCoordsScript,
  buildHoverCoordsScriptBySelector,
  buildElementBoundsScript,
  buildDragCoordsScript
} = require('../src/browser/snapshot-script');

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed');
}

async function main() {
  const vm = require('vm');
  const snap = buildSnapshotScript({ interactive: true, maxElements: 10 });
  assert(snap.includes('blockedIframes'), 'snapshot includes blocked iframe scan');
  assert(snap.includes('__dieyunSetFieldValue'), 'snapshot helpers include controlled input setter');
  assert(snap.includes('options'), 'select options in assign ref');

  const typeScript = buildTypePrepareScript('"ref-0"', '"hello"', true);
  assert(typeScript.includes('__dieyunSetFieldValue'), 'type script uses setter helper');
  assert(typeScript.includes('_valueTracker'), 'type script notifies React value tracker');
  assert(typeScript.includes('beforeinput'), 'type script dispatches beforeinput');

  const { buildReadFieldScript, buildSelectFieldScript, buildPressKeyScript, normalizeModifiers } = require('../src/browser/snapshot-script');
  const readScript = buildReadFieldScript('"ref-0"', '""');
  assert(readScript.includes('__dieyunResolveTarget'), 'read field script');
  const selectField = buildSelectFieldScript('"ref-0"', '""');
  assert(selectField.includes('.select('), 'select field script');

  assert(normalizeModifiers('Ctrl+Shift').join(',') === 'control,shift', 'normalizeModifiers parses string');
  assert(
    normalizeModifiers(['cmd', 'option', 'ctrl']).join(',') === 'meta,alt,control',
    'normalizeModifiers maps aliases'
  );
  assert(normalizeModifiers(undefined).length === 0, 'normalizeModifiers tolerates undefined');
  const comboScript = buildPressKeyScript('"A"', '["control"]');
  assert(comboScript.includes('const modifiers = ["control"]'), 'press key script embeds modifiers');
  assert(comboScript.includes('ctrlKey: modifiers.indexOf'), 'press key script sets ctrlKey');

  const typeSel = buildTypePrepareScriptBySelector('"input#q"', '"x"', false);
  assert(typeSel.includes('document.querySelector'), 'type by selector');

  const selectScript = buildSelectOptionScript('"ref-1"', '""', '"cn"', '""');
  assert(selectScript.includes('__dieyunSelectOption'), 'select option script');

  const lsScript = buildImportLocalStorageScript('{"token":"abc"}');
  assert(lsScript.includes('localStorage.setItem'), 'import localStorage script');

  const hoverRef = buildHoverCoordsScript('"ref-2"');
  assert(hoverRef.includes('mouseMove') || hoverRef.includes('getBoundingClientRect'), 'hover ref script');

  const hoverSel = buildHoverCoordsScriptBySelector('"button.menu"');
  assert(hoverSel.includes('querySelector'), 'hover selector script');

  const bounds = buildElementBoundsScript('"ref-3"', '""');
  assert(bounds.includes('width') && bounds.includes('height'), 'element bounds script');

  const drag = buildDragCoordsScript('"ref-4"', '""', '"ref-5"', '""', 0, 0);
  assert(drag.includes('startX') && drag.includes('endX'), 'drag coords script');

  const { buildA11yDomScanScript, buildContextMenuScript } = require('../src/browser/snapshot-script');
  const a11y = buildA11yDomScanScript({ maxNodes: 50 });
  assert(a11y.includes('roleOf') && a11y.includes('nodes'), 'a11y dom scan script');

  const ctx = buildContextMenuScript('"ref-6"', '""');
  assert(ctx.includes('contextmenu'), 'context menu script');

  const { simplifyCdpAxNodes } = require('../src/browser/a11y');
  const flat = simplifyCdpAxNodes([{ role: { value: 'button' }, name: { value: 'OK' } }], 10);
  assert(flat.length === 1 && flat[0].role === 'button', 'simplify cdp ax nodes');

  const { createNetworkJournal, summarizeHarEntries, toHar } = require('../src/browser/network-collector');
  const journal = createNetworkJournal({ maxEntries: 10 });
  journal.add({ url: 'https://example.com/api', status: 200, method: 'GET' });
  const listed = journal.list({ limit: 5 });
  assert(listed.length === 1, 'network journal list');
  assert(summarizeHarEntries(listed).count === 1, 'summarize har');

  const har = toHar(listed, { creatorName: 'test', creatorVersion: '9' });
  assert(har.log.version === '1.2' && har.log.creator.name === 'test', 'har header');
  assert(har.log.entries.length === 1, 'har entry count');
  const harEntry = har.log.entries[0];
  assert(/^\d{4}-\d{2}-\d{2}T/.test(harEntry.startedDateTime), 'har startedDateTime iso');
  assert(harEntry.request.method === 'GET' && harEntry.request.url === 'https://example.com/api', 'har request');
  assert(harEntry.response.status === 200, 'har response status');
  assert(harEntry._dieyun && harEntry._dieyun.failed === false, 'har keeps dieyun extension');
  assert(
    harEntry.time === 0 && harEntry.timings.wait === 0,
    'har missing duration falls back to 0'
  );
  const failedHar = toHar([{ url: 'https://x/y', method: 'POST', ts: Date.now(), durationMs: 12, failed: true, error: 'boom' }]);
  assert(failedHar.log.entries[0].time === 12, 'har keeps duration');
  assert(failedHar.log.entries[0]._dieyun.error === 'boom', 'har keeps error');

  const { buildReadLocalStorageScript } = require('../src/browser/snapshot-script');
  const readLsScript = buildReadLocalStorageScript();
  assert(
    readLsScript.includes('localStorage.key') && readLsScript.includes('location.origin'),
    'read localStorage script'
  );
  const lsItems = { token: 'abc', theme: 'dark' };
  const lsKeys = Object.keys(lsItems);
  const fakeLocalStorage = {
    get length() {
      return lsKeys.length;
    },
    key: (i) => (i in lsKeys ? lsKeys[i] : null),
    getItem: (k) => (Object.prototype.hasOwnProperty.call(lsItems, k) ? lsItems[k] : null)
  };
  const lsRaw = await vm.runInNewContext(readLsScript, {
    localStorage: fakeLocalStorage,
    location: { origin: 'https://app.test' }
  });
  assert(lsRaw.ok === true && lsRaw.count === 2, 'read localStorage item count');
  assert(lsRaw.items.token === 'abc' && lsRaw.origin === 'https://app.test', 'read localStorage values');
  const lsErr = await vm.runInNewContext(readLsScript, {});
  assert(lsErr.ok === false && typeof lsErr.error === 'string', 'read localStorage without storage fails soft');

  const { isBrowserPermissionAllowed } = require('../src/browser/permission-policy');
  assert(!isBrowserPermissionAllowed('geolocation'), 'geolocation denied by default');
  assert(!isBrowserPermissionAllowed('notifications'), 'notifications denied by default');
  assert(!isBrowserPermissionAllowed('camera'), 'camera denied by default');
  assert(!isBrowserPermissionAllowed('openExternal'), 'openExternal denied');
  assert(
    !isBrowserPermissionAllowed('media', { mediaTypes: ['video'] }),
    'video capture denied'
  );
  assert(isBrowserPermissionAllowed('media', { mediaTypes: ['audio'] }), 'audio allowed');
  assert(isBrowserPermissionAllowed('fullscreen'), 'fullscreen allowed');
  assert(isBrowserPermissionAllowed('clipboard-sanitized-write'), 'clipboard write allowed');

  const { buildEvaluateScript, normalizeEvaluateResult } = require('../src/browser/evaluate');

  const valueExpr = buildEvaluateScript('return 40 + 2;');
  const promise = vm.runInNewContext(valueExpr, {});
  assert(promise && typeof promise.then === 'function', 'evaluate script returns a promise');
  const valueRaw = await promise;
  assert(valueRaw.ok === true && valueRaw.json === '42' && valueRaw.type === 'number', 'evaluate returns value');

  const asyncExpr = buildEvaluateScript('const x = await Promise.resolve("a"); return x + "b";');
  const asyncRaw = await vm.runInNewContext(asyncExpr, {});
  assert(asyncRaw.json === '"ab"', 'evaluate supports await');

  const errRaw = await vm.runInNewContext(buildEvaluateScript('throw new Error("boom");'), {});
  assert(errRaw.ok === false && /boom/.test(errRaw.error), 'evaluate captures thrown error');
  const normalizedErr = normalizeEvaluateResult(errRaw);
  assert(normalizedErr.ok === false && normalizedErr.errorCode === 'SCRIPT_ERROR', 'normalize error result');

  const bigRaw = await vm.runInNewContext(
    buildEvaluateScript('return "x".repeat(5000);', { maxChars: 1000 }),
    {}
  );
  assert(bigRaw.truncated === true && bigRaw.json.length === 1000, 'evaluate truncates long json');

  const fnRaw = await vm.runInNewContext(buildEvaluateScript('return () => {};'), {});
  assert(fnRaw.type === 'function' && typeof fnRaw.json === 'string', 'non-json value falls back to string');

  const {
    normalizeLevel,
    buildConsoleErrorHookScript,
    classifyConsoleEntry,
    createConsoleJournal,
    summarizeConsoleEntries,
    PAGE_ERROR_MARKER
  } = require('../src/browser/console-collector');

  assert(normalizeLevel(3) === 'error', 'numeric electron level maps to error');
  assert(normalizeLevel(2) === 'warn', 'numeric electron level maps to warn');
  assert(normalizeLevel('warning') === 'warn', 'warning aliases warn');
  assert(normalizeLevel('nope') === 'log', 'unknown level falls back to log');

  const pageErr = classifyConsoleEntry('error', `${PAGE_ERROR_MARKER} boom @ a.js:1`);
  assert(
    pageErr.source === 'pageerror' && pageErr.level === 'error' && pageErr.text === 'boom @ a.js:1',
    'classify pageerror marker'
  );
  assert(classifyConsoleEntry('log', 'hello').source === 'console', 'classify plain console');

  const conJournal = createConsoleJournal({ maxEntries: 50 });
  conJournal.add({ level: 'log', text: 'a' });
  conJournal.add({ level: 'error', text: 'b' });
  conJournal.add({ level: 'warn', text: 'c' });
  assert(conJournal.list({}).length === 3, 'console journal keeps entries');
  assert(conJournal.list({ errorsOnly: true }).length === 1, 'console errorsOnly filter');
  assert(conJournal.list({ level: 'warn' }).length === 1, 'console level filter');
  assert(conJournal.status().total === 3 && conJournal.status().recentErrors === 1, 'console journal status');
  assert(summarizeConsoleEntries([{ level: 'error' }, { level: 'log' }]).errorCount === 1, 'summarize console');
  conJournal.clear();
  assert(conJournal.status().total === 0, 'console journal clear');

  const hookListeners = {};
  const hookLogged = [];
  const fakeWindow = {
    addEventListener: (type, fn) => {
      hookListeners[type] = hookListeners[type] || [];
      hookListeners[type].push(fn);
    }
  };
  const hookCtx = { window: fakeWindow, console: { error: (m) => hookLogged.push(m) } };
  const hookScript = buildConsoleErrorHookScript();
  assert(vm.runInNewContext(hookScript, hookCtx) === 'installed', 'console hook installs');
  assert(vm.runInNewContext(hookScript, hookCtx) === 'already', 'console hook installs once');
  hookListeners.error[0]({ message: 'kaboom', filename: 'app.js', lineno: 7 });
  assert(
    hookLogged[0] && hookLogged[0].startsWith(PAGE_ERROR_MARKER) && hookLogged[0].includes('kaboom'),
    'console hook forwards window error'
  );
  assert(hookLogged[0].includes('app.js:7'), 'console hook keeps source location');
  hookListeners.unhandledrejection[0]({ reason: new Error('rejected') });
  assert(hookLogged[1] && hookLogged[1].includes('rejected'), 'console hook forwards unhandled rejection');

  const { normalizeEmulation } = require('../src/browser/viewport');
  const emu = normalizeEmulation({
    geolocation: { latitude: 31.2, longitude: 121.5 },
    timezone: 'Asia/Shanghai',
    locale: 'zh-CN',
    permissions: ['geolocation', 'nope']
  });
  assert(emu.geolocation && emu.geolocation.accuracy === 100, 'normalizeEmulation default accuracy');
  assert(emu.timezone === 'Asia/Shanghai' && emu.locale === 'zh-CN', 'normalizeEmulation keeps tz/locale');
  assert(emu.permissions.join(',') === 'geolocation', 'normalizeEmulation filters unknown permissions');
  assert(
    normalizeEmulation({ geolocation: { latitude: 999, longitude: 0 } }).geolocation === null,
    'normalizeEmulation rejects out-of-range latitude'
  );

  const { matchUrlPattern } = require('../src/browser/url-policy');
  assert(matchUrlPattern('*', 'https://x/y') === true, 'matchUrlPattern wildcard-all');
  assert(matchUrlPattern('*/api/*', 'https://x.com/api/user') === true, 'matchUrlPattern glob');
  assert(matchUrlPattern('https://x.com/a', 'https://x.com/a') === true, 'matchUrlPattern exact');
  assert(matchUrlPattern('api', 'https://x.com/api/user') === true, 'matchUrlPattern substring');
  assert(matchUrlPattern('*/api/*', 'https://x.com/other') === false, 'matchUrlPattern mismatch');

  const { resolveBrowserNavigateUrl } = require('../src/browser/url-policy');
  assert(
    (await resolveBrowserNavigateUrl('www.baidu.com')) === 'https://www.baidu.com/',
    'bare host gets https'
  );
  assert(
    (await resolveBrowserNavigateUrl('baidu.com/search?wd=x')) === 'https://baidu.com/search?wd=x',
    'bare host keeps path/query'
  );
  assert(
    (await resolveBrowserNavigateUrl('localhost:3000')) === 'http://localhost:3000/',
    'localhost gets http'
  );
  assert(
    (await resolveBrowserNavigateUrl('http://example.com/x')) === 'http://example.com/x',
    'explicit scheme untouched'
  );
  let htmlLooksLocal = '';
  try {
    htmlLooksLocal = await resolveBrowserNavigateUrl('index.html', { allowedRoots: [] });
  } catch (e) {
    htmlLooksLocal = 'threw:' + e.code;
  }
  assert(htmlLooksLocal.startsWith('threw:'), 'index.html stays a local path, not a domain');

  const { buildUploadFileScript } = require('../src/browser/snapshot-script');
  const uploadScript = buildUploadFileScript({
    selector: '#drop',
    fileName: 'a.txt',
    mime: 'text/plain',
    base64: 'AA=='
  });
  assert(uploadScript.includes('DataTransfer'), 'upload script builds DataTransfer');
  assert(uploadScript.includes('DragEvent'), 'upload script supports dropzone drop');
  assert(uploadScript.includes('input[type="file"]'), 'upload script finds nested file input');

  // Explore 只读边界：读类浏览器工具必须可用，写类/高危必须排除
  const { BROWSER_TOOLS } = require('../src/agent/tool-catalog');
  const { buildExploreTools } = require('../src/agent/planner-tool-filters');
  const exploreNames = buildExploreTools(BROWSER_TOOLS).map((t) => t.function.name);
  const exploreAllowed = [
    'browser_snapshot',
    'browser_observe',
    'browser_wait_for',
    'browser_status',
    'browser_a11y_snapshot',
    'browser_network',
    'browser_console',
    'browser_expect'
  ];
  for (const n of exploreAllowed) {
    assert(exploreNames.includes(n), `explore keeps read-only ${n}`);
  }
  const exploreDenied = [
    'browser_click',
    'browser_type',
    'browser_navigate',
    'browser_evaluate',
    // screenshot 支持 filePath 落盘 → 不再属于纯只读
    'browser_screenshot',
    'browser_viewport',
    'browser_visual_diff',
    'browser_pdf',
    'browser_har_export',
    'browser_export_storage',
    'browser_import_storage',
    'browser_upload_file'
  ];
  for (const n of exploreDenied) {
    assert(!exploreNames.includes(n), `explore excludes ${n}`);
  }

  const { normalizeViewport, VIEWPORT_MIN, VIEWPORT_MAX } = require('../src/browser/viewport');
  const mobileVp = normalizeViewport({ width: 390, height: 844, mobile: true });
  assert(mobileVp.width === 390 && mobileVp.height === 844 && mobileVp.mobile === true, 'viewport keeps size/mobile');
  assert(normalizeViewport({ width: 390, height: 844 }).deviceScaleFactor === 1, 'viewport default dsf');
  assert(
    normalizeViewport({ width: 390, height: 844, deviceScaleFactor: 9 }).deviceScaleFactor === 4,
    'viewport clamps dsf'
  );
  assert(normalizeViewport({ width: 10, height: 10 }).width === VIEWPORT_MIN, 'viewport clamps min size');
  assert(normalizeViewport({ width: 99999, height: 99999 }).width === VIEWPORT_MAX, 'viewport clamps max size');
  assert(normalizeViewport({ width: 800 }) === null, 'viewport requires both width and height');
  assert(normalizeViewport({}) === null, 'viewport requires explicit size');
  assert(normalizeViewport({ width: 'abc', height: 'def' }) === null, 'viewport rejects non-numeric size');

  // --- 视口镜像暂存：stageViewport 只记状态，绝不创建视图/页面 ---
  const { createBrowserViewController } = require('../src/browser/controller');
  const bvStage = createBrowserViewController({ getMainWindow: () => null, log: () => {} });
  assert(bvStage.status().viewport === null, 'browserview viewport starts unset');
  const bvStaged = await bvStage.stageViewport({ width: 390, height: 844, mobile: true });
  assert(bvStaged.staged === true && bvStaged.applied === false, 'browserview stage reports not applied');
  assert(bvStaged.viewport.mobile === true, 'browserview stage keeps mobile flag');
  assert(bvStage.status().hasView === false, 'browserview stage creates no view');
  assert(
    bvStage.status().viewport && bvStage.status().viewport.width === 390,
    'browserview remembers staged viewport'
  );
  let bvBadStage = null;
  try {
    await bvStage.stageViewport({ width: 390 });
  } catch (e) {
    bvBadStage = e;
  }
  assert(bvBadStage && bvBadStage.code === 'VIEWPORT_REQUIRED', 'browserview stage rejects partial size');
  assert(bvStage.status().viewport.width === 390, 'browserview keeps viewport after invalid stage');
  await bvStage.stageViewport({ reset: true });
  assert(bvStage.status().viewport === null, 'browserview stage reset clears viewport');

  const { createPlaywrightRunner } = require('../src/browser/playwright-runner');
  const pwStage = createPlaywrightRunner({ log: () => {} });
  assert(pwStage.status().viewport === null, 'playwright viewport starts unset');
  const pwStaged = await pwStage.stageViewport({ width: 390, height: 844, mobile: true });
  assert(pwStaged.staged === true && pwStaged.hasPage === false, 'playwright stage creates no page');
  assert(pwStaged.viewport.width === 390 && pwStaged.viewport.height === 844, 'playwright stage returns size');
  const pwStatus = pwStage.status();
  assert(pwStatus.viewport && pwStatus.viewport.width === 390, 'playwright remembers staged viewport');
  assert(pwStatus.hasPage === false && pwStatus.sessionCount === 0, 'playwright staging opens no session');
  let pwBadStage = null;
  try {
    await pwStage.stageViewport({ height: 844 });
  } catch (e) {
    pwBadStage = e;
  }
  assert(pwBadStage && pwBadStage.code === 'VIEWPORT_REQUIRED', 'playwright stage rejects partial size');
  assert(pwStage.status().viewport.width === 390, 'playwright keeps viewport after invalid stage');
  const pwReset = await pwStage.stageViewport({ reset: true });
  assert(pwReset.reset === true && pwReset.viewport === null, 'playwright stage reset clears state');
  assert(pwStage.status().viewport === null, 'playwright reset leaves no viewport');

  // --- browser_expect：断言规整 / 页面执行 / 结果整形 ---
  const {
    normalizeAssertions,
    buildExpectScript,
    shapeExpectResult,
    MAX_ASSERTIONS
  } = require('../src/browser/expect');

  function assertThrows(fn, msg) {
    let threw = false;
    try {
      fn();
    } catch {
      threw = true;
    }
    assert(threw, msg);
  }

  assertThrows(() => normalizeAssertions([]), 'expect rejects empty list');
  assertThrows(() => normalizeAssertions(null), 'expect rejects missing list');
  assertThrows(() => normalizeAssertions([{ kind: 'nope' }]), 'expect rejects unknown kind');
  assertThrows(() => normalizeAssertions([{ kind: 'visible' }]), 'expect requires ref or selector');
  assertThrows(() => normalizeAssertions([{ kind: 'count', selector: '.a' }]), 'expect count needs numeric expected');
  assertThrows(() => normalizeAssertions([{ kind: 'url' }]), 'expect url needs expected');
  assertThrows(
    () => normalizeAssertions([{ kind: 'visible', ref: 'a"b' }]),
    'expect rejects unsafe ref'
  );
  assert(
    normalizeAssertions([{ kind: 'text', selector: '#a', expected: 'x', match: 'EQUALS' }])[0].match === 'equals',
    'expect normalizes match mode'
  );
  assert(
    normalizeAssertions([{ kind: 'count', selector: '.a', expected: 2, op: 'GTE' }])[0].op === 'gte',
    'expect normalizes count op'
  );

  const visibleEl = { innerText: 'Hello World', value: 'abc', offsetWidth: 100, offsetHeight: 20, getClientRects: () => [1] };
  const hiddenEl = { innerText: 'gone', offsetWidth: 0, offsetHeight: 0, getClientRects: () => [] };
  const fakeDom = {
    '#ok': visibleEl,
    '#hidden': hiddenEl,
    '#inp': visibleEl
  };
  const expectCtx = {
    document: {
      querySelector: (sel) =>
        String(sel).startsWith('[data-dieyun-ref=') ? visibleEl : fakeDom[sel] || null,
      querySelectorAll: (sel) => (sel === '.item' ? [visibleEl, hiddenEl] : [])
    },
    location: { href: 'https://app.test/checkout' }
  };

  const passList = normalizeAssertions([
    { kind: 'visible', selector: '#ok' },
    { kind: 'text', selector: '#ok', expected: 'Hello' },
    { kind: 'hidden', selector: '#hidden' },
    { kind: 'value', selector: '#inp', expected: 'abc', match: 'equals' },
    { kind: 'count', selector: '.item', expected: 2 },
    { kind: 'url', expected: '/checkout' }
  ]);
  const passRaw = await vm.runInNewContext(buildExpectScript(JSON.stringify(passList)), expectCtx);
  const passShaped = shapeExpectResult(passRaw, { engine: 'browserview' });
  assert(passShaped.ok === true && passShaped.total === 6 && passShaped.failed === 0, 'expect all pass');

  const failList = normalizeAssertions([{ kind: 'text', selector: '#ok', expected: 'Nope' }]);
  const failRaw = await vm.runInNewContext(buildExpectScript(JSON.stringify(failList)), expectCtx);
  const failShaped = shapeExpectResult(failRaw, { engine: 'playwright' });
  assert(failShaped.ok === false && failShaped.failed === 1, 'expect failure yields ok:false');
  assert(failShaped.results[0].actual === 'Hello World', 'expect keeps actual value');
  assert(
    failShaped.error === undefined && failShaped.errorCode === undefined,
    'expect failure carries no error fields (harness must not treat it as tool failure)'
  );

  assert(
    normalizeAssertions(Array.from({ length: MAX_ASSERTIONS }, () => ({ kind: 'visible', selector: '#ok' }))).length ===
      MAX_ASSERTIONS,
    'expect accepts max assertions'
  );
  assertThrows(
    () => normalizeAssertions(Array.from({ length: MAX_ASSERTIONS + 1 }, () => ({ kind: 'visible', selector: '#ok' }))),
    'expect rejects over-limit assertions'
  );

  // --- 视觉差异（纯像素比较）---
  const {
    diffBitmaps,
    stableKey,
    clampRatio,
    DEFAULT_PIXEL_TOLERANCE,
    DEFAULT_RATIO_THRESHOLD
  } = require('../src/browser/visual-diff');

  const toBitmap = (pixels) => Buffer.from(pixels.flat());
  const baseBitmap = toBitmap([
    [0, 0, 0, 255],
    [10, 10, 10, 255],
    [20, 20, 20, 255],
    [30, 30, 30, 255]
  ]);

  const identical = diffBitmaps(baseBitmap, Buffer.from(baseBitmap), { width: 4, height: 1 });
  assert(identical.ok === true && identical.changedPixels === 0 && identical.changed === false, 'diff identical');

  const noisy = Buffer.from(baseBitmap);
  noisy[4] = 10 + DEFAULT_PIXEL_TOLERANCE; // 差值 == 容差，不应算变化
  assert(
    diffBitmaps(baseBitmap, noisy, { width: 4, height: 1 }).changedPixels === 0,
    'diff ignores sub-tolerance noise'
  );

  const changedBitmap = toBitmap([
    [0, 0, 0, 255],
    [255, 255, 255, 255],
    [20, 20, 20, 255],
    [30, 30, 30, 255]
  ]);
  const changedRes = diffBitmaps(baseBitmap, changedBitmap, { width: 4, height: 1 });
  assert(changedRes.changedPixels === 1, 'diff counts changed pixel');
  assert(Math.abs(changedRes.ratio - 0.25) < 1e-9, 'diff computes ratio');
  assert(changedRes.changed === true, 'diff flags change above threshold');
  assert(
    changedRes.diffBitmap[4] === 0 && changedRes.diffBitmap[6] === 255 && changedRes.diffBitmap[7] === 255,
    'diff highlights changed pixel as opaque red (BGRA)'
  );
  assert(
    diffBitmaps(baseBitmap, changedBitmap, { width: 4, height: 1, ratioThreshold: 0.5 }).changed === false,
    'diff respects ratio threshold'
  );

  const sizeMismatch = diffBitmaps(baseBitmap, Buffer.alloc(8), { width: 4, height: 1 });
  assert(
    sizeMismatch.ok === false && sizeMismatch.errorCode === 'BITMAP_SIZE_MISMATCH',
    'diff reports bitmap size mismatch'
  );
  assert(diffBitmaps(Buffer.alloc(0), Buffer.alloc(0), { width: 0, height: 0 }).ok === false, 'diff rejects empty');

  assert(
    clampRatio(0.5, 0.01) === 0.5 && clampRatio(-1, 0.01) === 0.01 && clampRatio(9, 0.01) === 1,
    'clampRatio bounds'
  );
  assert(
    stableKey('a|b') === stableKey('a|b') && stableKey('a|b') !== stableKey('a|c'),
    'stableKey is deterministic and distinct'
  );
  assert(DEFAULT_RATIO_THRESHOLD === 0.005 && DEFAULT_PIXEL_TOLERANCE === 12, 'visual diff defaults');

  const { isLikelyBlankBitmap } = require('../src/browser/visual-diff');
  const blackBitmap = Buffer.alloc(16, 0);
  for (let i = 3; i < 16; i += 4) blackBitmap[i] = 255; // BGRA：alpha=255、RGB=0
  assert(isLikelyBlankBitmap(blackBitmap, 2, 2) === true, 'blank detector flags all-black bitmap');
  assert(isLikelyBlankBitmap(Buffer.alloc(16, 255), 2, 2) === false, 'blank detector ignores white page');
  assert(isLikelyBlankBitmap(Buffer.alloc(4), 2, 2) === true, 'blank detector flags truncated bitmap');
  assert(isLikelyBlankBitmap(Buffer.alloc(0), 0, 0) === true, 'blank detector flags empty bitmap');

  const { parseRemotePreviewTarget } = require('../src/browser/url-policy');
  assert(parseRemotePreviewTarget('http://localhost:5000/').remotePort === 5000, 'localhost is preview target');
  assert(parseRemotePreviewTarget('http://127.0.0.1:5173/#/x').remotePort === 5173, 'loopback is preview target');
  assert(parseRemotePreviewTarget('https://localhost').remotePort === 443, 'https default port is previewed');
  assert(parseRemotePreviewTarget('http://0.0.0.0:8000').remoteHost === '127.0.0.1', 'any-addr maps to loopback');
  assert(parseRemotePreviewTarget('http://example.com:5000/') === null, 'public host is not a preview target');
  assert(parseRemotePreviewTarget('https://10.0.0.5:8080/') === null, 'lan host is not a preview target');
  assert(parseRemotePreviewTarget('file:///tmp/a.html') === null, 'file url is not a preview target');
  assert(parseRemotePreviewTarget('not a url') === null, 'garbage is not a preview target');

  const net = require('net');
  const { createPortForwardManager } = require('../src/ssh/port-forward-manager');
  /** 记录 ssh2 client 的生命周期监听，测试可手动触发"SSH 断开" */
  const fakeSshListeners = { close: [], end: [], error: [] };
  const fakeChannelError = new Error('connect failed: ECONNREFUSED 127.0.0.1:45999');
  const fakeSshClient = {
    on(evt, fn) {
      (fakeSshListeners[evt] = fakeSshListeners[evt] || []).push(fn);
    },
    removeListener(evt, fn) {
      fakeSshListeners[evt] = (fakeSshListeners[evt] || []).filter((f) => f !== fn);
    },
    forwardOut(_host, _port, _remoteHost, _remotePort, cb) {
      cb(fakeChannelError);
    }
  };
  const fakeSshManager = {
    assertConnected() {},
    getClient: () => fakeSshClient,
    status: () => ({ connected: true })
  };
  const forwards = createPortForwardManager({});
  const firstForward = await forwards.findOrAddForward(fakeSshManager, {
    hostKey: 'u@h1:22',
    remotePort: 45999,
    localPort: 0
  });
  assert(firstForward.reused === false && firstForward.localPort > 0, 'preview forward opens a listener');
  const reusedForward = await forwards.findOrAddForward(fakeSshManager, {
    hostKey: 'u@h1:22',
    remotePort: 45999,
    localPort: 0
  });
  assert(reusedForward.reused === true, 'preview forward reuses same target');
  assert(reusedForward.id === firstForward.id, 'reuse keeps the same forward id');
  const otherHostForward = await forwards.findOrAddForward(fakeSshManager, {
    hostKey: 'u@h2:22',
    remotePort: 45999,
    localPort: 0
  });
  assert(otherHostForward.id !== firstForward.id, 'preview forwards are isolated per ssh target');
  assert(forwards.listForwards().length === 2, 'listForwards reports both preview forwards');

  const squatter = net.createServer();
  await new Promise((resolve) => squatter.listen(0, '127.0.0.1', resolve));
  const busyPort = squatter.address().port;
  const fallbackForward = await forwards.findOrAddForward(fakeSshManager, {
    hostKey: 'u@h1:22',
    remotePort: busyPort,
    localPort: busyPort
  });
  assert(fallbackForward.localPortFallback === true, 'busy preferred port falls back');
  assert(fallbackForward.localPort !== busyPort, 'fallback picks a different local port');
  const { probeForwardedHttp } = require('../src/ssh/tunnel');
  const httpServer = net.createServer((socket) => {
    socket.once('data', () => {
      socket.end('HTTP/1.1 302 Found\r\nLocation: /login\r\nContent-Length: 0\r\n\r\n');
    });
  });
  await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const probeOk = await probeForwardedHttp({ port: httpServer.address().port, timeoutMs: 2000 });
  assert(probeOk.ok === true && probeOk.status === 302, 'probe reports http status (302 login) as reachable');

  const silentServer = net.createServer((socket) => socket.destroy());
  await new Promise((resolve) => silentServer.listen(0, '127.0.0.1', resolve));
  const silentProbe = await probeForwardedHttp({ port: silentServer.address().port, timeoutMs: 2000 });
  assert(silentProbe.ok === false, 'probe flags silent tcp peer as failure');
  assert(
    silentProbe.error === 'empty_response' || silentProbe.error === 'ECONNRESET',
    'silent tcp peer is reported as empty response, not as success'
  );

  await new Promise((resolve) => squatter.close(resolve));
  const refusedProbe = await probeForwardedHttp({ port: busyPort, timeoutMs: 2000 });
  assert(refusedProbe.ok === false, 'probe fails when the local port is closed');

  await forwards.removeAll();
  assert(forwards.listForwards().length === 0, 'removeAll clears preview forwards');
  assert(typeof forwards.probeHttp === 'function', 'port forward manager exposes the probe');
  assert(typeof forwards.getForward === 'function', 'port forward manager exposes forward health');

  // 通道打不开时真实原因必须留痕：浏览器侧只会看到"连接被关闭"（ERR_EMPTY_RESPONSE）
  const channelForward = await forwards.findOrAddForward(fakeSshManager, {
    hostKey: 'u@h3:22',
    remotePort: 45999,
    localPort: 0
  });
  await new Promise((resolve) => {
    const s = net.connect(channelForward.localPort, '127.0.0.1');
    s.on('close', resolve);
    s.on('error', resolve);
    setTimeout(resolve, 800);
  });
  const channelHealth = forwards.getForward(channelForward.id);
  assert(channelHealth && channelHealth.alive === true, 'live forward reports alive');
  assert(
    String(channelHealth.lastChannelError).includes('ECONNREFUSED'),
    'channel error is recorded for diagnosis'
  );

  // SSH 断开 → 旧隧道必须摘掉；否则重连后复用死隧道，预览永远无法自愈
  fakeSshListeners.close.forEach((fn) => fn());
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert(forwards.listForwards().length === 0, 'disconnected tunnels are dropped from the table');
  assert(forwards.getForward(channelForward.id) === null, 'dropped forward is gone');

  const rebuiltForward = await forwards.findOrAddForward(fakeSshManager, {
    hostKey: 'u@h3:22',
    remotePort: 45999,
    localPort: 0
  });
  assert(rebuiltForward.id !== channelForward.id, 'forward is recreated after ssh disconnect');
  assert(forwards.getForward(rebuiltForward.id).alive === true, 'recreated forward is alive');
  await forwards.removeAll();
  await new Promise((resolve) => httpServer.close(resolve));
  await new Promise((resolve) => silentServer.close(resolve));

  console.log('test-browser-smoke.cjs ok');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
