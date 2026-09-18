'use strict';

const { FRAME_HELPERS } = require('./frame-script');

const INTERACTIVE_SEL =
  'a, button, input, textarea, select, label, [role="button"], [role="link"], [role="textbox"], [role="combobox"], [onclick], input[type="submit"], input[type="button"], [tabindex]:not([tabindex="-1"])';

/**
 * snapshot 收录模式：
 *   interactive（默认）— 语义化可交互元素，等价于旧行为
 *   all               — 再加 heading / role / tabindex / aria-* / cursor:pointer 的容器元素
 *                       （Vue `@click` 的 div、element-ui 的 .menu-item 这类"无 role 的可点元素"靠它才可见）
 *   dom               — 所有可见元素，纯结构视图
 */
const SNAPSHOT_MODES = ['interactive', 'all', 'dom'];
const SNAPSHOT_SCAN_LIMIT = 20000;
const SNAPSHOT_SAMPLE_LIMIT = 5;

function normalizeSnapshotMode(raw, opts = {}) {
  const value = String(raw == null ? '' : raw).toLowerCase();
  if (SNAPSHOT_MODES.includes(value)) return value;
  // 兼容旧参数：interactive=false 过去只额外加 heading，现在升格为 all（仍是超集）
  if (opts.interactive === false) return 'all';
  return 'interactive';
}

/** Shared in-page helpers (embedded as string for evaluate) */
const SNAPSHOT_HELPERS = `
${FRAME_HELPERS}
function __dieyunMatchesInteractive(el) {
  if (!el || el.nodeType !== 1) return false;
  try {
    if (el.matches(INTERACTIVE_SEL)) return true;
  } catch (_) {}
  const tag = el.tagName ? el.tagName.toLowerCase() : '';
  return tag === 'a' || tag === 'button' || tag === 'input' || tag === 'textarea' || tag === 'select' || tag === 'label';
}
function __dieyunVisible(el) {
  const style = window.getComputedStyle(el);
  if (style.display === 'none' || style.visibility === 'hidden') return false;
  const rect = el.getBoundingClientRect();
  if (rect.width < 1 && rect.height < 1 && el.tagName !== 'INPUT') return false;
  return true;
}
function __dieyunLabel(el) {
  return (
    el.getAttribute('aria-label') ||
    el.getAttribute('placeholder') ||
    el.getAttribute('title') ||
    el.getAttribute('name') ||
    (el.innerText || '').trim().slice(0, 120) ||
    el.value ||
    ''
  ).trim();
}
function __dieyunAssignRef(el, id, frame) {
  el.setAttribute('data-dieyun-ref', id);
  window.__dieyunRefs[id] = el;
  const tag = el.tagName.toLowerCase();
  const row = {
    ref: id,
    tag,
    role: el.getAttribute('role') || '',
    type: el.type || '',
    name: __dieyunLabel(el),
    href: el.href || '',
    value: el.value != null ? String(el.value).slice(0, 80) : '',
    frame: frame || 'main'
  };
  if (tag === 'select') {
    row.options = Array.from(el.options || []).slice(0, 30).map(function(o) {
      return {
        value: o.value,
        label: (o.textContent || o.label || '').trim().slice(0, 80),
        selected: !!o.selected
      };
    });
  }
  return row;
}
function __dieyunResolveTarget(ref, selector, frameSpec) {
  const resolved = __dyResolveTargetEx(ref, selector, frameSpec);
  return resolved && resolved.ok ? resolved.el : null;
}
/** 非语义化可点元素（无 role / 无 inline onclick / 无 tabindex，只有 cursor:pointer）。 */
function __dieyunLikelyClickable(el) {
  try {
    const style = window.getComputedStyle(el);
    return !!style && style.cursor === 'pointer';
  } catch (_) {
    return false;
  }
}
function __dieyunIsHeading(el) {
  const tag = (el.tagName || '').toLowerCase();
  if (tag === 'h1' || tag === 'h2' || tag === 'h3' || tag === 'h4' || tag === 'h5' || tag === 'h6') return true;
  return !!el.getAttribute && el.getAttribute('role') === 'heading';
}
function __dieyunHasSemanticSignal(el) {
  if (!el.getAttribute) return false;
  if (el.getAttribute('role')) return true;
  if (el.getAttribute('tabindex') != null) return true;
  const attrs = el.attributes || [];
  for (let i = 0; i < attrs.length; i++) {
    if (String(attrs[i].name || '').indexOf('aria-') === 0) return true;
  }
  return false;
}
/** 收录判定：单一来源，供 snapshot 统计与筛选共用。 */
function __dieyunMatchesMode(el, mode) {
  if (mode === 'dom') return true;
  if (__dieyunMatchesInteractive(el)) return true;
  if (mode !== 'all') return false;
  if (__dieyunIsHeading(el)) return true;
  if (__dieyunHasSemanticSignal(el)) return true;
  if (__dieyunLikelyClickable(el)) return true;
  try {
    const parentRole = el.parentElement && el.parentElement.getAttribute
      ? String(el.parentElement.getAttribute('role') || '')
      : '';
    if (parentRole === 'menu' || parentRole === 'menubar' || parentRole === 'tablist' || parentRole === 'listbox') return true;
  } catch (_) {}
  return false;
}
/** all/dom 模式下补结构信息，帮助模型判断"这是什么东西、怎么直接定位"。 */
function __dieyunExtraRow(el, mode) {
  const row = {};
  if (mode !== 'interactive') {
    row.selector = __dySelectorHint(el);
    try {
      const style = window.getComputedStyle(el);
      if (style && style.cursor === 'pointer') row.clickable = true;
    } catch (_) {}
    if (__dieyunIsHeading(el)) row.heading = true;
  }
  const occluded = __dyOcclusion(el);
  if (occluded && occluded.occluded && occluded.hit) row.occludedBy = occluded.hit.selector || occluded.hit.tag || '';
  return row;
}
function __dieyunSetNativeValue(el, next) {
  const tag = (el.tagName || '').toLowerCase();
  const proto = tag === 'textarea' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value') && Object.getOwnPropertyDescriptor(proto, 'value').set;
  const prev = el.value;
  try {
    const tracker = el._valueTracker;
    if (tracker && typeof tracker.setValue === 'function') tracker.setValue(prev);
  } catch (_) {}
  if (setter) setter.call(el, next);
  else el.value = next;
}
function __dieyunDispatchInputEvents(el, data) {
  try {
    el.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertText', data: data }));
  } catch (_) {}
  try {
    el.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, inputType: 'insertText', data: data }));
  } catch (_) {
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }
  el.dispatchEvent(new Event('change', { bubbles: true }));
}
function __dieyunSetFieldValue(el, text, clear) {
  if (!el) return { ok: false, error: '元素未找到' };
  el.scrollIntoView({ block: 'center', inline: 'center' });
  try { el.focus(); } catch (_) {}
  const tag = (el.tagName || '').toLowerCase();
  const want = String(text == null ? '' : text);
  if (tag === 'input' || tag === 'textarea') {
    const next = clear ? want : String(el.value || '') + want;
    __dieyunSetNativeValue(el, next);
    __dieyunDispatchInputEvents(el, want);
    return { ok: true, value: el.value != null ? String(el.value) : '', tag: tag, type: el.type || '' };
  }
  if (el.isContentEditable) {
    if (clear) el.textContent = '';
    el.textContent = (clear ? '' : String(el.textContent || '')) + want;
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: want }));
    return { ok: true, value: String(el.textContent || ''), tag: tag, type: el.type || '' };
  }
  if (clear) el.textContent = '';
  el.textContent = (clear ? '' : String(el.textContent || '')) + want;
  return { ok: true, value: String(el.textContent || ''), tag: tag, type: el.type || '' };
}
function __dieyunSelectOption(el, value, label) {
  if (!el || (el.tagName || '').toLowerCase() !== 'select') {
    return { ok: false, error: '目标不是 select 下拉框' };
  }
  el.scrollIntoView({ block: 'center', inline: 'center' });
  try { el.focus(); } catch (_) {}
  const opts = Array.from(el.options || []);
  let target = null;
  if (value) target = opts.find(function(o) { return String(o.value) === String(value); });
  if (!target && label) {
    const want = String(label).trim().toLowerCase();
    target = opts.find(function(o) {
      return (o.textContent || o.label || '').trim().toLowerCase() === want;
    });
  }
  if (!target) return { ok: false, error: '未找到匹配的 option（请传 value 或 label）' };
  el.value = target.value;
  target.selected = true;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return { ok: true, value: target.value, label: (target.textContent || target.label || '').trim() };
}
function __dieyunResolveRef(ref) {
  let el = (window.__dieyunRefs || {})[ref];
  if (el && el.isConnected) return el;
  el = document.querySelector('[data-dieyun-ref="' + ref + '"]');
  if (el) {
    window.__dieyunRefs = window.__dieyunRefs || {};
    window.__dieyunRefs[ref] = el;
    return el;
  }
  return null;
}
/**
 * 递归采集（含同源 iframe，深度/节点数双上限）。
 * 覆盖率统计是硬要求：宁可多回一条"另有 N 个元素未纳入"，也不能让模型
 * 把"snapshot 只给了 7 个元素"误读成"页面就这么点东西"。
 */
function __dieyunCollectRoot(root, out, state, framePath, mode, depth) {
  if (!root || state.depth > 10) return;
  const walk = (node, nodePath, nodeDepth) => {
    if (!node || state.scanned >= state.scanLimit) return;
    if (nodeDepth > 10) return;
    if (node.nodeType === 1) {
      state.scanned += 1;
      const visible = __dieyunVisible(node);
      if (visible && __dieyunMatchesMode(node, mode)) {
        if (out.length >= state.maxElements) {
          state.omittedToMax += 1;
          if (state.samples.length < state.sampleLimit) {
            state.samples.push({
              reason: 'maxElements',
              tag: String(node.tagName || '').toLowerCase(),
              selector: __dySelectorHint(node),
              framePath: nodePath
            });
          }
        } else {
          const id = 'ref-' + (state.ref++);
          const row = __dieyunAssignRef(node, id, nodePath === 'main' ? 'main' : 'iframe');
          row.framePath = nodePath;
          const extra = __dieyunExtraRow(node, mode);
          for (const k in extra) {
            if (Object.prototype.hasOwnProperty.call(extra, k)) row[k] = extra[k];
          }
          out.push(row);
          state.included += 1;
        }
      } else if (visible) {
        state.filteredVisible += 1;
        if (state.filteredSamples.length < 3 && state.filteredVisible <= 400) {
          state.filteredSamples.push({
            reason: 'mode=' + mode,
            tag: String(node.tagName || '').toLowerCase(),
            selector: __dySelectorHint(node),
            framePath: nodePath
          });
        }
      }
      if (node.shadowRoot) {
        state.scanned += 1;
        walk(node.shadowRoot, nodePath, nodeDepth + 1);
      }
      const children = node.children || [];
      for (let i = 0; i < children.length; i++) walk(children[i], nodePath, nodeDepth + 1);
    } else if (node.nodeType === 11) {
      const kids = node.childNodes || [];
      for (let i = 0; i < kids.length; i++) {
        if (kids[i].nodeType === 1) walk(kids[i], nodePath, nodeDepth + 1);
      }
    }
  };
  walk(root, framePath, depth);
  // 同源 iframe 继续下钻；跨域只登记（内容不可读，只能由 Playwright 引擎接管）
  let iframes = [];
  try {
    iframes = root.querySelectorAll ? root.querySelectorAll('iframe, frame') : [];
  } catch (_) {
    iframes = [];
  }
  for (let i = 0; i < iframes.length; i++) {
    if (state.scanned >= state.scanLimit) {
      state.scanLimitHit = true;
      break;
    }
    const iframe = iframes[i];
    const childPath = framePath === 'main' ? String(i) : framePath + '.' + i;
    let doc = null;
    try {
      doc = iframe.contentDocument;
    } catch (_) {
      doc = null;
    }
    const crossOrigin = !(doc && doc.body);
    if (crossOrigin) {
      state.blockedIframes.push({
        framePath: childPath,
        src: String(iframe.getAttribute('src') || iframe.src || ''),
        id: String(iframe.id || ''),
        name: String(iframe.name || iframe.getAttribute('name') || ''),
        crossOrigin: true,
        selectors: __dyIframeSelectors(iframe)
      });
      continue;
    }
    state.frameCount += 1;
    state.frames.push({
      path: childPath,
      name: String(iframe.name || iframe.getAttribute('name') || ''),
      id: String(iframe.id || ''),
      src: String(iframe.getAttribute('src') || ''),
      sameOrigin: true
    });
    __dieyunCollectRoot(doc.body, out, state, childPath, mode, depth + 1);
  }
}
/** 给跨域 iframe 生成几个可用的选择器示例，方便模型直接借道 Playwright。 */
function __dyIframeSelectors(iframe) {
  const out = [];
  try {
    if (iframe.id) out.push('#' + iframe.id);
  } catch (_) {}
  try {
    const name = iframe.getAttribute('name');
    if (name) out.push('iframe[name="' + name + '"]');
  } catch (_) {}
  try {
    const src = String(iframe.getAttribute('src') || '');
    if (src) {
      const tail = src.split('?')[0].split('/').filter(function (x) { return !!x; }).pop();
      if (tail) out.push('iframe[src*="' + tail + '"]');
    }
  } catch (_) {}
  return out;
}
/**
 * 目标中心点（顶层视口坐标，跨 iframe 累加偏移）+ 遮挡检测。
 * 旧实现只取元素自身 rect：同源 iframe 内的元素会点到错误位置（差了一个 frame 偏移）。
 */
function __dieyunClickTargetCoords(el) {
  try {
    el.scrollIntoView({ block: 'center', inline: 'center' });
  } catch (_) {}
  const abs = __dyAbsoluteRect(el);
  if (abs.width < 1 && abs.height < 1 && el.tagName !== 'INPUT') {
    return { ok: false, error: '元素不可见', errorCode: 'TARGET_INVISIBLE' };
  }
  const occlusion = __dyOcclusion(el);
  const out = {
    ok: true,
    x: abs.x + abs.width / 2,
    y: abs.y + abs.height / 2,
    tag: String(el.tagName || '').toLowerCase(),
    framePath: __dyFramePathOf(el) || 'main'
  };
  if (abs.offsetPartial) out.offsetPartial = true;
  if (occlusion && occlusion.occluded && occlusion.hit) {
    out.occludedBy = occlusion.hit;
    out.errorCode = 'TARGET_OCCLUDED';
  }
  if (occlusion && occlusion.crossOriginFrame) out.crossOriginFrame = true;
  return out;
}
function __dieyunSimulatePointerClick(el) {
  const coords = __dieyunClickTargetCoords(el);
  if (!coords.ok) return coords;
  const cx = coords.x;
  const cy = coords.y;
  const base = { bubbles: true, cancelable: true, view: window, clientX: cx, clientY: cy, button: 0 };
  try {
    if (window.PointerEvent) {
      el.dispatchEvent(new PointerEvent('pointerdown', { ...base, pointerId: 1, pointerType: 'mouse' }));
      el.dispatchEvent(new PointerEvent('pointerup', { ...base, pointerId: 1, pointerType: 'mouse' }));
    }
    el.dispatchEvent(new MouseEvent('mousedown', base));
    el.dispatchEvent(new MouseEvent('mouseup', base));
    el.dispatchEvent(new MouseEvent('click', base));
  } catch (_) {}
  if (typeof el.click === 'function') {
    try { el.click(); } catch (_) {}
  }
  return { ok: true, x: cx, y: cy, tag: el.tagName.toLowerCase() };
}
`.replace(/INTERACTIVE_SEL/g, JSON.stringify(INTERACTIVE_SEL));

/** @returns {string} IIFE body for in-page snapshot (BrowserView / Playwright evaluate) */
function buildSnapshotScript(options = {}) {
  const mode = normalizeSnapshotMode(options.mode, options);
  const maxElements = Number(options.maxElements) > 0 ? Number(options.maxElements) : 120;
  const refOffset = Math.max(0, Number(options.refOffset) || 0);
  const rootPath = JSON.stringify(String(options.framePath == null ? 'main' : options.framePath));
  const scanLimit = Math.min(SNAPSHOT_SCAN_LIMIT, Math.max(500, Number(options.scanLimit) || SNAPSHOT_SCAN_LIMIT));
  const sampleLimit = Math.min(10, Math.max(1, Number(options.sampleLimit) || SNAPSHOT_SAMPLE_LIMIT));
  return `(() => {
    ${SNAPSHOT_HELPERS}
    const mode = ${JSON.stringify(mode)};
    const maxElements = ${maxElements};
    const rootPath = ${rootPath};
    const scanLimit = ${scanLimit};
    const sampleLimit = ${sampleLimit};
    const initialRef = ${refOffset};
    document.querySelectorAll('[data-dieyun-ref]').forEach(el => el.removeAttribute('data-dieyun-ref'));
    window.__dieyunRefs = {};
    window.__dieyunRefEpoch = (window.__dieyunRefEpoch || 0) + 1;
    const refEpoch = window.__dieyunRefEpoch;
    const elements = [];
    const state = {
      ref: initialRef,
      maxElements,
      depth: 0,
      scanned: 0,
      included: 0,
      omittedToMax: 0,
      filteredVisible: 0,
      frameCount: 1,
      scanLimitHit: false,
      sampleLimit,
      samples: [],
      filteredSamples: [],
      frames: [{ path: 'main', name: '', id: '', src: '', sameOrigin: true }],
      blockedIframes: []
    };
    __dieyunCollectRoot(document.body, elements, state, rootPath, mode, 0);
    const omitted = state.omittedToMax;
    const coverage = {
      mode,
      included: elements.length,
      omitted,
      filteredVisible: state.filteredVisible,
      scanned: state.scanned,
      maxElements,
      scanLimitHit: state.scanLimitHit,
      frames: state.frameCount,
      blockedFrames: state.blockedIframes.length
    };
    if (omitted > 0) {
      coverage.omittedBy = 'maxElements';
      coverage.samples = state.samples;
    }
    if (state.filteredVisible > 0 && mode === 'interactive') {
      coverage.filteredSamples = state.filteredSamples;
    }
    let note = 'ref 在本次 snapshot 内有效；页面跳转或再次 snapshot 后需重新获取';
    if (omitted > 0) {
      note += '；因 maxElements=' + maxElements + ' 还有 ' + omitted + ' 个匹配元素未纳入（可提高 maxElements，或用 ref 定位到更小的容器后重新 snapshot）';
    }
    if (mode === 'interactive' && state.filteredVisible > 0) {
      note += '；另有 ' + state.filteredVisible + ' 个可见元素不符合 interactive 判定（多为无 role 的容器/菜单项），'
        + '若目标在其中请用 mode=all 重新 snapshot，或直接用 CSS selector 操作（示例：'
        + (state.filteredSamples[0] && state.filteredSamples[0].selector ? state.filteredSamples[0].selector : 'div.menu-item') + '）';
    }
    if (state.blockedIframes.length) {
      note += '；存在 ' + state.blockedIframes.length + ' 个跨域 iframe，其内部元素在当前引擎不可读；'
        + '请用 browser_frames 查看 frame 树，并改用 engine=playwright（支持跨 frame 定位）。';
    }
    if (rootPath !== 'main') {
      note += '；本次仅在 frame ' + rootPath + ' 内采集。';
    }
    return {
      url: location.href,
      title: document.title || '',
      refEpoch,
      mode,
      framePath: rootPath,
      textPreview: (document.body && document.body.innerText ? document.body.innerText : '').slice(0, 6000),
      elements,
      frames: state.frames,
      blockedIframes: state.blockedIframes,
      coverage,
      note
    };
  })()`;
}

/** frame 参数统一入口：未指定（undefined / 'null'）视为顶层。 */
function frameJsonOf(frameJson) {
  const raw = frameJson == null ? '' : String(frameJson);
  return !raw || raw === 'null' ? 'null' : raw;
}

/** 目标解析 + 失败诊断（frame 未命中、元素未找到都带上可用 frame 列表）。 */
function resolveDiagnostic(prefix) {
  return `if (!resolved.ok) {
      return Object.assign({ ok: false }, resolved, { __dieyunStep: ${JSON.stringify(prefix)} });
    }
    const el = resolved.el;`;
}

/** @param {string} refJson JSON-stringified ref id */
function buildClickPrepareScript(refJson, frameJson) {
  return `(() => {
    ${SNAPSHOT_HELPERS}
    const frameSpec = ${frameJsonOf(frameJson)};
    const resolved = __dyResolveTargetEx(${refJson}, '', frameSpec);
    ${resolveDiagnostic('resolve')}
    return __dieyunSimulatePointerClick(el);
  })()`;
}

/** @param {string} selectorJson JSON-stringified CSS selector */
function buildClickPrepareScriptBySelector(selectorJson, frameJson) {
  return `(() => {
    ${SNAPSHOT_HELPERS}
    const frameSpec = ${frameJsonOf(frameJson)};
    const resolved = __dyResolveTargetEx('', ${selectorJson}, frameSpec);
    ${resolveDiagnostic('resolve')}
    return __dieyunSimulatePointerClick(el);
  })()`;
}

/** BrowserView：仅定位元素并返回视口坐标（由 sendInputEvent 执行真实点击） */
function buildClickCoordsScript(refJson, frameJson) {
  return `(() => {
    ${SNAPSHOT_HELPERS}
    const frameSpec = ${frameJsonOf(frameJson)};
    const resolved = __dyResolveTargetEx(${refJson}, '', frameSpec);
    ${resolveDiagnostic('resolve')}
    return Object.assign(__dieyunClickTargetCoords(el), { ref: ${refJson} });
  })()`;
}

function buildClickCoordsScriptBySelector(selectorJson, frameJson) {
  return `(() => {
    ${SNAPSHOT_HELPERS}
    const frameSpec = ${frameJsonOf(frameJson)};
    const resolved = __dyResolveTargetEx('', ${selectorJson}, frameSpec);
    ${resolveDiagnostic('resolve')}
    return Object.assign(__dieyunClickTargetCoords(el), { selector: ${selectorJson} });
  })()`;
}

/** @param {string} refJson @param {string} textJson @param {boolean} clear */
function buildTypePrepareScript(refJson, textJson, clear, frameJson) {
  return `(() => {
    ${SNAPSHOT_HELPERS}
    const frameSpec = ${frameJsonOf(frameJson)};
    const text = ${textJson};
    const clear = ${clear ? 'true' : 'false'};
    const resolved = __dyResolveTargetEx(${refJson}, '', frameSpec);
    ${resolveDiagnostic('resolve')}
    return __dieyunSetFieldValue(el, text, clear);
  })()`;
}

/** @param {string} selectorJson @param {string} textJson @param {boolean} clear */
function buildTypePrepareScriptBySelector(selectorJson, textJson, clear, frameJson) {
  return `(() => {
    ${SNAPSHOT_HELPERS}
    const frameSpec = ${frameJsonOf(frameJson)};
    const text = ${textJson};
    const clear = ${clear ? 'true' : 'false'};
    const resolved = __dyResolveTargetEx('', ${selectorJson}, frameSpec);
    ${resolveDiagnostic('resolve')}
    return __dieyunSetFieldValue(el, text, clear);
  })()`;
}

/** @param {string} refJson @param {string} selectorJson */
function buildReadFieldScript(refJson, selectorJson, frameJson) {
  return `(() => {
    ${SNAPSHOT_HELPERS}
    const frameSpec = ${frameJsonOf(frameJson)};
    const resolved = __dyResolveTargetEx(${refJson}, ${selectorJson}, frameSpec);
    ${resolveDiagnostic('resolve')}
    const tag = (el.tagName || '').toLowerCase();
    const value = (tag === 'input' || tag === 'textarea')
      ? (el.value != null ? String(el.value) : '')
      : String(el.textContent || '');
    return { ok: true, value: value, tag: tag, type: el.type || '' };
  })()`;
}

/** Focus and select so CDP Input.insertText replaces the current value. */
function buildSelectFieldScript(refJson, selectorJson, frameJson) {
  return `(() => {
    ${SNAPSHOT_HELPERS}
    const frameSpec = ${frameJsonOf(frameJson)};
    const resolved = __dyResolveTargetEx(${refJson}, ${selectorJson}, frameSpec);
    ${resolveDiagnostic('resolve')}
    el.scrollIntoView({ block: 'center', inline: 'center' });
    try { el.focus(); } catch (_) {}
    try { if (typeof el.select === 'function') el.select(); } catch (_) {}
    return { ok: true, tag: (el.tagName || '').toLowerCase(), type: el.type || '' };
  })()`;
}

/** @param {string} refJson @param {string} valueJson @param {string} labelJson */
function buildSelectOptionScript(refJson, selectorJson, valueJson, labelJson, frameJson) {
  return `(() => {
    ${SNAPSHOT_HELPERS}
    const frameSpec = ${frameJsonOf(frameJson)};
    const value = ${valueJson};
    const label = ${labelJson};
    const resolved = __dyResolveTargetEx(${refJson}, ${selectorJson}, frameSpec);
    ${resolveDiagnostic('resolve')}
    return __dieyunSelectOption(el, value, label);
  })()`;
}

function buildWaitConditionScript(options = {}) {
  const kind = JSON.stringify(String(options.kind || options.type || 'selector'));
  const value = JSON.stringify(String(options.value || options.text || options.selector || options.url || ''));
  const frameSpecJson = frameJsonOf(
    options.frameSpec == null ? null : JSON.stringify(options.frameSpec)
  );
  const state = JSON.stringify(String(options.state || 'visible'));
  return `(() => {
    ${SNAPSHOT_HELPERS}
    const kind = ${kind};
    const value = ${value};
    const frameSpec = ${frameSpecJson};
    const wantState = ${state};
    if (kind === 'load') {
      return { ok: document.readyState === 'complete' || document.readyState === 'interactive', readyState: document.readyState };
    }
    if (kind === 'url') {
      return { ok: value ? location.href.includes(value) : true, url: location.href };
    }
    if (kind === 'text') {
      const text = document.body && document.body.innerText ? document.body.innerText : '';
      return { ok: value ? text.includes(value) : !!text, matched: value };
    }
    if (kind === 'expression' || kind === 'expr') {
      // 表达式等待由 Node 侧轮询 buildExpressionProbeScript 完成：
      // 页面内 new Function 会被 CSP 拦，而表达式内联进脚本再交给 CDP 求值则不受限。
      return { ok: false, error: 'expression 需由 Node 侧轮询求值', errorCode: 'WAIT_KIND_DELEGATED' };
    }
    const resolved = __dyResolveTargetEx('', value, frameSpec);
    if (!resolved.ok) {
      // state=attached 时"还没出现"只是未满足条件，不是错误
      if (wantState === 'attached') return { ok: false, pending: true, selector: value, frames: resolved.frames };
      return Object.assign({}, resolved, { selector: value });
    }
    const el = resolved.el;
    const style = window.getComputedStyle(el);
    const rect = __dyAbsoluteRect(el);
    const visible = style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    const ok = wantState === 'attached' ? true : visible;
    return {
      ok: ok,
      pending: !ok,
      selector: value,
      framePath: resolved.framePath,
      attached: true,
      visible: visible,
      text: (el.innerText || el.value || '').slice(0, 300)
    };
  })()`;
}

function buildUploadFileScript(options = {}) {
  const refJson = JSON.stringify(String(options.ref || ''));
  const selectorJson = JSON.stringify(String(options.selector || ''));
  const fileNameJson = JSON.stringify(String(options.fileName || 'upload.bin'));
  const mimeJson = JSON.stringify(String(options.mime || 'application/octet-stream'));
  const base64Json = JSON.stringify(String(options.base64 || ''));
  const frameSpecJson = frameJsonOf(options.frameSpec == null ? null : JSON.stringify(options.frameSpec));
  return `(() => {
    ${SNAPSHOT_HELPERS}
    const ref = ${refJson};
    const selector = ${selectorJson};
    const frameSpec = ${frameSpecJson};
    const fileName = ${fileNameJson};
    const mime = ${mimeJson};
    const base64 = ${base64Json};
    const picked = __dyResolveTargetEx(ref, selector, frameSpec);
    if (!picked.ok) return picked;
    const el = picked.el;
    const isFileInput = function(node) {
      return !!node && String(node.tagName || '').toLowerCase() === 'input' &&
        String(node.type || '').toLowerCase() === 'file';
    };
    const target = isFileInput(el)
      ? el
      : (el.querySelector ? el.querySelector('input[type="file"]') : null);
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const file = new File([bytes], fileName, { type: mime });
    const dt = new DataTransfer();
    dt.items.add(file);
    if (target) {
      target.files = dt.files;
      target.dispatchEvent(new Event('input', { bubbles: true }));
      target.dispatchEvent(new Event('change', { bubbles: true }));
      return {
        ok: true,
        mode: isFileInput(el) ? 'input' : 'nested-input',
        fileName,
        fileCount: target.files ? target.files.length : 0
      };
    }
    const rect = el.getBoundingClientRect ? el.getBoundingClientRect() : { width: 0, height: 0 };
    const dragOpts = { bubbles: true, cancelable: true, dataTransfer: dt };
    try {
      el.dispatchEvent(new DragEvent('dragenter', dragOpts));
      el.dispatchEvent(new DragEvent('dragover', dragOpts));
    } catch (_) {}
    try {
      el.dispatchEvent(new DragEvent('drop', dragOpts));
    } catch (e) {
      return {
        ok: false,
        mode: 'dropzone',
        error: '目标不是 file input 且无法接收 drop：' + (e && e.message ? e.message : String(e))
      };
    }
    return {
      ok: true,
      mode: 'dropzone',
      fileName,
      width: Math.round(rect.width || 0),
      height: Math.round(rect.height || 0)
    };
  })()`;
}
const KEY_MODIFIER_ALIASES = {
  ctrl: 'control',
  control: 'control',
  cmdorctrl: 'control',
  cmd: 'meta',
  command: 'meta',
  meta: 'meta',
  super: 'meta',
  win: 'meta',
  alt: 'alt',
  option: 'alt',
  shift: 'shift'
};

/** 归一化修饰键：数组或 "Ctrl+Shift" 字符串 → ['control','shift'] */
function normalizeModifiers(input) {
  const raw = Array.isArray(input)
    ? input
    : typeof input === 'string'
      ? input.split(/[+,\s]+/)
      : [];
  const out = [];
  for (const item of raw) {
    const mapped = KEY_MODIFIER_ALIASES[String(item || '').trim().toLowerCase()];
    if (mapped && !out.includes(mapped)) out.push(mapped);
  }
  return out;
}

/** @param {string} keyJson @param {string} modifiersJson */
function buildPressKeyScript(keyJson, modifiersJson = '[]') {
  return `(() => {
    const key = ${keyJson};
    const modifiers = ${modifiersJson};
    const el = document.activeElement || document.body;
    const opts = {
      key,
      code: key,
      bubbles: true,
      cancelable: true,
      view: window,
      ctrlKey: modifiers.indexOf('control') >= 0,
      shiftKey: modifiers.indexOf('shift') >= 0,
      altKey: modifiers.indexOf('alt') >= 0,
      metaKey: modifiers.indexOf('meta') >= 0
    };
    el.dispatchEvent(new KeyboardEvent('keydown', opts));
    el.dispatchEvent(new KeyboardEvent('keypress', opts));
    if (key === 'Enter') {
      if (el && el.form && typeof el.form.requestSubmit === 'function') el.form.requestSubmit();
      else if (el && el.tagName === 'TEXTAREA') el.dispatchEvent(new KeyboardEvent('keyup', opts));
      else el.dispatchEvent(new KeyboardEvent('keyup', opts));
    } else {
      el.dispatchEvent(new KeyboardEvent('keyup', opts));
    }
    return { ok: true, key, modifiers };
  })()`;
}

/** @param {string} refJson */
function buildHoverCoordsScript(refJson, frameJson) {
  return `(() => {
    ${SNAPSHOT_HELPERS}
    const frameSpec = ${frameJsonOf(frameJson)};
    const resolved = __dyResolveTargetEx(${refJson}, '', frameSpec);
    ${resolveDiagnostic('resolve')}
    return __dieyunClickTargetCoords(el);
  })()`;
}

function buildHoverCoordsScriptBySelector(selectorJson, frameJson) {
  return `(() => {
    ${SNAPSHOT_HELPERS}
    const frameSpec = ${frameJsonOf(frameJson)};
    const resolved = __dyResolveTargetEx('', ${selectorJson}, frameSpec);
    ${resolveDiagnostic('resolve')}
    return __dieyunClickTargetCoords(el);
  })()`;
}

function buildElementBoundsScript(refJson, selectorJson, frameJson) {
  return `(() => {
    ${SNAPSHOT_HELPERS}
    const frameSpec = ${frameJsonOf(frameJson)};
    const resolved = __dyResolveTargetEx(${refJson}, ${selectorJson}, frameSpec);
    ${resolveDiagnostic('resolve')}
    try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch (_) {}
    const abs = __dyAbsoluteRect(el);
    if (abs.width < 1 && abs.height < 1) return { ok: false, error: '元素不可见', errorCode: 'TARGET_INVISIBLE' };
    return {
      ok: true,
      x: Math.max(0, Math.floor(abs.x)),
      y: Math.max(0, Math.floor(abs.y)),
      width: Math.max(1, Math.ceil(abs.width)),
      height: Math.max(1, Math.ceil(abs.height)),
      framePath: resolved.framePath
    };
  })()`;
}

/** 滚动目标元素（而不是整页）：frame 感知。 */
function buildScrollTargetScript(refJson, selectorJson, dx, dy, frameJson) {
  return `(() => {
    ${SNAPSHOT_HELPERS}
    const frameSpec = ${frameJsonOf(frameJson)};
    const resolved = __dyResolveTargetEx(${refJson}, ${selectorJson}, frameSpec);
    ${resolveDiagnostic('resolve')}
    try { el.scrollBy(${Number(dx) || 0}, ${Number(dy) || 0}); } catch (_) {}
    return { ok: true, framePath: resolved.framePath, tag: String(el.tagName || '').toLowerCase() };
  })()`;
}

function buildDragCoordsScript(refJson, selectorJson, toRefJson, toSelectorJson, dx, dy, frameJson) {
  return `(() => {
    ${SNAPSHOT_HELPERS}
    const toRef = ${toRefJson};
    const toSelector = ${toSelectorJson};
    const dx = Number(${dx}) || 0;
    const dy = Number(${dy}) || 0;
    const frameSpec = ${frameJsonOf(frameJson)};
    const resolvedFrom = __dyResolveTargetEx(${refJson}, ${selectorJson}, frameSpec);
    if (!resolvedFrom.ok) return Object.assign({}, resolvedFrom, { error: '起始元素未找到：' + (resolvedFrom.error || '') });
    const start = __dieyunClickTargetCoords(resolvedFrom.el);
    if (!start.ok) return start;
    let endX = start.x + dx;
    let endY = start.y + dy;
    if (toRef || toSelector) {
      const resolvedTo = __dyResolveTargetEx(toRef, toSelector, frameSpec);
      if (!resolvedTo.ok) return Object.assign({}, resolvedTo, { error: '目标元素未找到：' + (resolvedTo.error || '') });
      const end = __dieyunClickTargetCoords(resolvedTo.el);
      if (!end.ok) return end;
      endX = end.x;
      endY = end.y;
    }
    return { ok: true, startX: start.x, startY: start.y, endX, endY };
  })()`;
}

/** @param {string} entriesJson JSON object string */
function buildImportLocalStorageScript(entriesJson) {
  return `(() => {
    const entries = ${entriesJson};
    if (!entries || typeof entries !== 'object' || Array.isArray(entries)) {
      return { ok: false, error: 'localStorage 必须是键值对象' };
    }
    let applied = 0;
    for (const [k, v] of Object.entries(entries)) {
      try {
        localStorage.setItem(String(k), v == null ? '' : String(v));
        applied += 1;
      } catch (_) {}
    }
    return { ok: true, applied, origin: location.origin };
  })()`;
}

/** 读取当前页同源 localStorage 全部键值（导出的反向操作） */
function buildReadLocalStorageScript() {
  return `(() => {
    try {
      const items = {};
      for (let i = 0; i < localStorage.length; i += 1) {
        const k = localStorage.key(i);
        if (k == null) continue;
        items[k] = localStorage.getItem(k);
      }
      return { ok: true, origin: location.origin, count: Object.keys(items).length, items };
    } catch (e) {
      return { ok: false, error: String(e && e.message ? e.message : e) };
    }
  })()`;
}

/** DOM fallback a11y scan when CDP Accessibility tree unavailable */
function buildA11yDomScanScript(opts = {}) {
  const maxNodes = Math.min(400, Math.max(20, Number(opts.maxNodes) || 200));
  return `(() => {
    const MAX = ${maxNodes};
    const nodes = [];
    function roleOf(el) {
      const explicit = el.getAttribute && el.getAttribute('role');
      if (explicit) return explicit;
      const tag = (el.tagName || '').toLowerCase();
      if (tag === 'button') return 'button';
      if (tag === 'a' && el.href) return 'link';
      if (tag === 'input') return el.type === 'checkbox' ? 'checkbox' : el.type === 'radio' ? 'radio' : 'textbox';
      if (tag === 'textarea') return 'textbox';
      if (tag === 'select') return 'combobox';
      if (tag === 'img' && el.alt) return 'image';
      if (tag === 'h1' || tag === 'h2' || tag === 'h3') return 'heading';
      return tag || 'generic';
    }
    function nameOf(el) {
      return (
        el.getAttribute('aria-label') ||
        el.getAttribute('aria-labelledby') && document.getElementById(el.getAttribute('aria-labelledby'))?.textContent ||
        el.getAttribute('title') ||
        el.getAttribute('placeholder') ||
        el.getAttribute('alt') ||
        (el.innerText || el.textContent || '').trim().slice(0, 200) ||
        el.getAttribute('name') ||
        ''
      ).trim();
    }
    function visible(el) {
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 0 || rect.height > 0;
    }
    function walk(el, depth, framePath) {
      if (!el || el.nodeType !== 1 || nodes.length >= MAX) return;
      if (visible(el)) {
        const role = roleOf(el);
        const name = nameOf(el);
        const value = el.value != null ? String(el.value).slice(0, 120) : '';
        const interesting = name || value || ['button','link','textbox','combobox','checkbox','radio','menuitem','tab','heading'].includes(role);
        if (interesting) {
          const row = { role, name: name.slice(0, 200), depth, framePath: framePath || 'main' };
          if (value) row.value = value;
          if (el.getAttribute('aria-checked') != null) row.states = { checked: el.getAttribute('aria-checked') === 'true' };
          if (el.getAttribute('aria-expanded') != null) row.states = Object.assign(row.states || {}, { expanded: el.getAttribute('aria-expanded') === 'true' });
          row.selector = __dySelectorHint(el);
          nodes.push(row);
        }
      }
      if (el.shadowRoot) walk(el.shadowRoot, depth + 1, framePath);
      for (const child of el.children || []) walk(child, depth + 1, framePath);
    }
    walk(document.body || document.documentElement, 0, 'main');
    // 同源 iframe 一并纳入（跨域 frame 读不到，交给 browser_frames / Playwright）
    const frameEntries = __dyFrameEntries();
    const blocked = [];
    for (let i = 0; i < frameEntries.length; i++) {
      const entry = frameEntries[i];
      if (nodes.length >= MAX) break;
      if (!entry.accessible) {
        blocked.push({ path: entry.desc.path, src: entry.src, name: entry.desc.name, crossOrigin: true });
        continue;
      }
      if (entry.desc.main) continue;
      walk(entry.win.document.body || entry.win.document.documentElement, 1, entry.desc.path);
    }
    return { nodes, count: nodes.length, source: 'dom', blockedFrames: blocked };
  })()`;
}

function buildContextMenuScript(refJson, selectorJson, frameJson) {
  return `(() => {
    ${SNAPSHOT_HELPERS}
    const frameSpec = ${frameJsonOf(frameJson)};
    const resolved = __dyResolveTargetEx(${refJson}, ${selectorJson}, frameSpec);
    ${resolveDiagnostic('resolve')}
    try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch (_) {}
    const abs = __dyAbsoluteRect(el);
    const x = abs.x + abs.width / 2;
    const y = abs.y + abs.height / 2;
    const ownerWin = el.ownerDocument && el.ownerDocument.defaultView ? el.ownerDocument.defaultView : window;
    const base = { bubbles: true, cancelable: true, view: ownerWin, clientX: abs.localX + abs.width / 2, clientY: abs.localY + abs.height / 2, button: 2 };
    el.dispatchEvent(new MouseEvent('contextmenu', base));
    return { ok: true, x, y, framePath: resolved.framePath, tag: (el.tagName || '').toLowerCase() };
  })()`;
}

module.exports = {
  SNAPSHOT_MODES,
  normalizeSnapshotMode,
  frameJsonOf,
  buildSnapshotScript,
  buildClickPrepareScript,
  buildClickPrepareScriptBySelector,
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
  buildScrollTargetScript,
  buildDragCoordsScript,
  buildWaitConditionScript,
  buildUploadFileScript,
  buildPressKeyScript,
  normalizeModifiers,
  buildA11yDomScanScript,
  buildContextMenuScript
};
