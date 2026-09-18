'use strict';

/**
 * iframe / 多 frame 上下文：frame 描述、匹配、页面内遍历与坐标换算。
 *
 * 纯字符串 + 纯函数（零 Electron 依赖），便于在 VM 里单测。
 *
 * 寻址约定（两个引擎共用同一套语义，保证「同一条 frame 参数」在
 * BrowserView 与 Playwright 上指向同一个 frame）：
 *   · 省略 / "main" / ""      → 顶层 frame
 *   · "0" / "0.1" / 0 / {path} → frame 路径（按文档顺序的 iframe 下标链）
 *   · "/re/flags"              → 匹配 frame URL 的正则
 *   · "url:<子串>" / 含 "/" 或 "://" → frame URL 子串
 *   · 其它                     → frame 的 name 属性
 */

const FRAME_MAX_DEPTH = 6;
const FRAME_MAX_COUNT = 60;

/** frame 路径的字符串表示；'' 表示顶层。 */
function normalizeFramePath(raw) {
  const parts = String(raw == null ? '' : raw)
    .split(/[./]/)
    .map((x) => x.trim())
    .filter((x) => x !== '');
  if (!parts.length) return [];
  if (!parts.every((x) => /^\d+$/.test(x))) return null;
  return parts;
}

/**
 * 把模型给的 frame 参数规整成描述对象。
 * @param {unknown} raw
 * @returns {{ kind: 'main' | 'path' | 'name' | 'url' | 'urlRegex', path?: string[], value?: string }}
 */
function normalizeFrameSpec(raw) {
  if (raw == null) return { kind: 'main' };
  if (typeof raw === 'object' && !Array.isArray(raw)) {
    if (Array.isArray(raw.path)) {
      const path = normalizeFramePath(raw.path.join('.'));
      return path ? { kind: 'path', path } : { kind: 'main' };
    }
    if (raw.path != null) {
      const path = normalizeFramePath(raw.path);
      if (path) return { kind: 'path', path };
    }
    if (raw.index != null) {
      const path = normalizeFramePath(raw.index);
      if (path) return { kind: 'path', path };
    }
    if (raw.name) return { kind: 'name', value: String(raw.name) };
    if (raw.regex || raw.urlRegex) return { kind: 'urlRegex', value: String(raw.regex || raw.urlRegex) };
    if (raw.url) return { kind: 'url', value: String(raw.url) };
    return { kind: 'main' };
  }
  if (typeof raw === 'number') {
    const path = normalizeFramePath(raw);
    return path ? { kind: 'path', path } : { kind: 'main' };
  }
  const s = String(raw).trim();
  if (!s || s === 'main' || s === 'top' || s === 'self') return { kind: 'main' };
  const regexForm = /^\/(.+)\/[gimsuy]*$/.exec(s);
  if (regexForm) return { kind: 'urlRegex', value: regexForm[1] };
  if (s.startsWith('url:')) return { kind: 'url', value: s.slice(4) };
  const path = normalizeFramePath(s);
  if (path) return { kind: 'path', path };
  if (s.includes('://') || s.includes('/')) return { kind: 'url', value: s };
  return { kind: 'name', value: s };
}

function isMainFrameSpec(spec) {
  return !spec || spec.kind === 'main';
}

/**
 * 单一实现：Node 侧（Playwright / 单测）与页面内（注入脚本）共用同一份源码，
 * 由 toString() 拼进注入字符串，避免两套匹配逻辑漂移。
 * 注意：本函数不得引用外部变量、不得使用模板字符串与正则转义（会被拼进模板字面量）。
 * @param {{ main?: boolean, path?: string, name?: string, url?: string }} desc
 * @param {{ kind?: string, path?: string[], value?: string }} spec
 */
function frameDescriptorMatches(desc, spec) {
  var d = desc || {};
  if (!spec || !spec.kind || spec.kind === 'main') return d.main === true;
  if (spec.kind === 'path') {
    var want = spec.path || [];
    var got = String(d.path == null ? '' : d.path).split('.').filter(function (x) { return x !== ''; });
    if (want.length !== got.length) return false;
    for (var i = 0; i < want.length; i++) {
      if (String(want[i]) !== String(got[i])) return false;
    }
    return true;
  }
  if (spec.kind === 'name') return String(d.name || '') === String(spec.value || '');
  if (spec.kind === 'url') return String(d.url || '').indexOf(String(spec.value || '')) >= 0;
  if (spec.kind === 'urlRegex') {
    try {
      return new RegExp(String(spec.value || '')).test(String(d.url || ''));
    } catch (e) {
      return false;
    }
  }
  return false;
}

/** 人话描述，用于错误信息。 */
function describeFrameSpec(spec) {
  if (isMainFrameSpec(spec)) return 'main';
  if (spec.kind === 'path') return 'path=' + spec.path.join('.');
  if (spec.kind === 'name') return 'name=' + spec.value;
  if (spec.kind === 'url') return 'url~' + spec.value;
  return 'url=/' + spec.value + '/';
}

/** 给 frame 列表去重 + 截断，作为「可用的 frame」提示。 */
function summarizeFramesForHint(frames, limit = 12) {
  return (Array.isArray(frames) ? frames : []).slice(0, limit).map((f) => ({
    path: f.path || 'main',
    name: f.name || '',
    url: String(f.url || '').slice(0, 160),
    accessible: f.accessible !== false
  }));
}

const FRAME_MATCH_SOURCE = frameDescriptorMatches.toString();

/**
 * 页面内 frame 工具集。会被拼进其他注入脚本（snapshot / click / evaluate 等）。
 * 全部使用字符串拼接与函数声明，避免在模板字面量里踩转义坑。
 */
const FRAME_HELPERS = `
var __dyFrameMaxDepth = ${FRAME_MAX_DEPTH};
var __dyFrameMaxCount = ${FRAME_MAX_COUNT};
var __dyFrameMatches = ${FRAME_MATCH_SOURCE};
/** 顶层 window；VM/测试环境没有 window 时返回 null（不抛）。 */
function __dyTopWindow() {
  try { return typeof window !== 'undefined' ? window : null; } catch (e) { return null; }
}
function __dyIsWindow(w) {
  try { return !!(w && w.document && w.location); } catch (e) { return false; }
}
function __dyFrameUrlOf(el, win) {
  try { if (win && win.location && win.location.href) return String(win.location.href); } catch (e) {}
  try { return String(el.src || el.getAttribute('src') || ''); } catch (e) {}
  return '';
}
function __dyFrameNameOf(el) {
  try {
    return String(el.name || el.getAttribute('name') || el.id || '');
  } catch (e) { return ''; }
}
function __dyCollectFrameEntries(win, path, out, depth) {
  if (!__dyIsWindow(win) || depth > __dyFrameMaxDepth || out.length > __dyFrameMaxCount) return out;
  var doc = win.document;
  var nodes = [];
  try { nodes = doc.querySelectorAll('iframe, frame'); } catch (e) { nodes = []; }
  for (var i = 0; i < nodes.length; i++) {
    if (out.length > __dyFrameMaxCount) break;
    var el = nodes[i];
    var childPath = path ? path + '.' + i : String(i);
    var childWin = null;
    var accessible = false;
    try { childWin = el.contentWindow; } catch (e) { childWin = null; }
    if (childWin) {
      try { accessible = !!(childWin.document && childWin.document.body !== undefined); } catch (e) { accessible = false; }
    }
    var rect = null;
    try {
      var r = el.getBoundingClientRect();
      rect = { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) };
    } catch (e) { rect = null; }
    var entry = {
      win: accessible ? childWin : null,
      desc: {
        main: false,
        path: childPath,
        index: i,
        name: __dyFrameNameOf(el),
        url: __dyFrameUrlOf(el, accessible ? childWin : null)
      },
      accessible: accessible,
      rect: rect,
      id: (function () { try { return String(el.id || ''); } catch (e) { return ''; } })(),
      src: (function () { try { return String(el.getAttribute('src') || ''); } catch (e) { return ''; } })()
    };
    out.push(entry);
    if (accessible) __dyCollectFrameEntries(childWin, childPath, out, depth + 1);
  }
  return out;
}
function __dyFrameEntries() {
  var top = __dyTopWindow();
  var out = [{ win: top, desc: { main: true, path: '', index: -1, name: '', url: String((top && top.location && top.location.href) || '') }, accessible: true, rect: null, id: '', src: '' }];
  return __dyCollectFrameEntries(top, '', out, 0);
}
function __dyFrameSummary(entries) {
  return entries.slice(0, 16).map(function (e) {
    return { path: e.desc.main ? 'main' : e.desc.path, name: e.desc.name || '', url: String(e.desc.url || '').slice(0, 160), accessible: e.accessible !== false };
  });
}
function __dyFrameSpecIsMain(spec) {
  return !spec || !spec.kind || spec.kind === 'main';
}
function __dyPickFrame(spec) {
  var entries = __dyFrameEntries();
  if (__dyFrameSpecIsMain(spec)) {
    var top = __dyTopWindow();
    return { ok: true, win: top, doc: document, path: 'main', url: String((top && top.location && top.location.href) || ''), name: '' };
  }
  for (var i = 0; i < entries.length; i++) {
    if (!entries[i].accessible) continue;
    if (__dyFrameMatches(entries[i].desc, spec)) {
      return {
        ok: true,
        win: entries[i].win,
        doc: entries[i].win.document,
        path: entries[i].desc.path,
        url: entries[i].desc.url,
        name: entries[i].desc.name
      };
    }
  }
  return {
    ok: false,
    error: '未找到匹配的 frame',
    errorCode: 'FRAME_NOT_FOUND',
    frames: __dyFrameSummary(entries),
    note: '跨域 iframe 内部无法用本引擎访问；改用 engine=playwright，或用 browser_frames 查看完整 frame 树'
  };
}
function __dyFrameOffset(win) {
  var x = 0;
  var y = 0;
  var w = win;
  var guard = 0;
  try {
    while (w && w !== w.parent && guard++ < 12) {
      var fe = w.frameElement;
      if (!fe) break;
      var r = fe.getBoundingClientRect();
      x += r.left;
      y += r.top;
      var owner = fe.ownerDocument;
      var ow = owner ? owner.defaultView : null;
      if (!ow) break;
      w = ow;
    }
  } catch (e) {
    return { x: x, y: y, partial: true };
  }
  return { x: x, y: y, partial: false };
}
function __dyAbsoluteRect(el) {
  var r = el.getBoundingClientRect();
  var doc = el.ownerDocument;
  var win = doc ? doc.defaultView : null;
  var off = win ? __dyFrameOffset(win) : { x: 0, y: 0, partial: false };
  return {
    x: r.left + off.x,
    y: r.top + off.y,
    width: r.width,
    height: r.height,
    localX: r.left,
    localY: r.top,
    frame: win && win !== __dyTopWindow() ? 'iframe' : 'main',
    offsetPartial: !!off.partial
  };
}
/** 元素所在 frame 的路径（'' / 'main' 表示顶层）。 */
function __dyFramePathOf(el) {
  try {
    var win = el && el.ownerDocument ? el.ownerDocument.defaultView : null;
    if (!win || win === __dyTopWindow()) return 'main';
    var idx = [];
    var w = win;
    var guard = 0;
    while (w && w !== w.parent && guard++ < 12) {
      var fe = w.frameElement;
      if (!fe) break;
      var parentDoc = fe.ownerDocument;
      var siblings = parentDoc ? parentDoc.querySelectorAll('iframe, frame') : [];
      var pos = -1;
      for (var i = 0; i < siblings.length; i++) {
        if (siblings[i] === fe) { pos = i; break; }
      }
      if (pos < 0) { idx = []; break; }
      idx.unshift(String(pos));
      var ow = parentDoc ? parentDoc.defaultView : null;
      if (!ow) break;
      w = ow;
    }
    return idx.length ? idx.join('.') : 'main';
  } catch (e) {
    return '';
  }
}
function __dySelectorHint(el) {
  try {
    if (!el || el.nodeType !== 1) return '';
    if (el.id) return '#' + el.id;
    var parts = [];
    var node = el;
    var guard = 0;
    while (node && node.nodeType === 1 && guard++ < 4) {
      var tag = String(node.tagName || '').toLowerCase();
      if (node.id) { parts.unshift('#' + node.id); break; }
      var cls = '';
      if (typeof node.className === 'string' && node.className.trim()) {
        var names = node.className.trim().split(' ').filter(function (x) { return !!x; });
        if (names.length) cls = '.' + names.slice(0, 2).join('.');
      }
      var nth = '';
      try {
        var parent = node.parentElement;
        if (parent) {
          var same = [];
          for (var i = 0; i < parent.children.length; i++) {
            if (parent.children[i].tagName === node.tagName) same.push(parent.children[i]);
          }
          if (same.length > 1) nth = ':nth-of-type(' + (same.indexOf(node) + 1) + ')';
        }
      } catch (e) {}
      parts.unshift(tag + cls + nth);
      node = node.parentElement;
    }
    return parts.join(' > ');
  } catch (e) { return ''; }
}
function __dyDescribeEl(el) {
  if (!el || el.nodeType !== 1) return null;
  var out = { tag: String(el.tagName || '').toLowerCase() };
  try { if (el.id) out.id = String(el.id); } catch (e) {}
  try { if (typeof el.className === 'string' && el.className) out.class = el.className.slice(0, 160); } catch (e) {}
  try {
    var text = String(el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim();
    if (text) out.text = text.slice(0, 120);
  } catch (e) {}
  try {
    var rect = el.getBoundingClientRect();
    out.rect = { x: Math.round(rect.left), y: Math.round(rect.top), width: Math.round(rect.width), height: Math.round(rect.height) };
  } catch (e) {}
  out.selector = __dySelectorHint(el);
  return out;
}
/** 命中点上的真实元素（逐层穿过 iframe）；返回 null 表示点不在任何元素上。 */
function __dyHitTestAt(absX, absY) {
  var doc = document;
  var x = absX;
  var y = absY;
  var guard = 0;
  while (doc && guard++ < 12) {
    var hit = null;
    try { hit = doc.elementFromPoint(x, y); } catch (e) { hit = null; }
    if (!hit) return null;
    var tag = String(hit.tagName || '').toLowerCase();
    if (tag === 'iframe' || tag === 'frame') {
      var inner = null;
      try { inner = hit.contentWindow; } catch (e) { inner = null; }
      var accessible = false;
      if (inner) {
        try { accessible = !!(inner.document && inner.document.body !== undefined); } catch (e) { accessible = false; }
      }
      if (!accessible) return { el: hit, tag: tag, crossOriginFrame: true };
      var r = hit.getBoundingClientRect();
      x -= r.left;
      y -= r.top;
      doc = inner.document;
      continue;
    }
    return { el: hit, tag: tag, crossOriginFrame: false };
  }
  return null;
}
function __dyContains(ancestor, node) {
  try {
    if (!ancestor || !node) return false;
    if (ancestor === node) return true;
    return !!(ancestor.contains && ancestor.contains(node));
  } catch (e) { return false; }
}
/**
 * 目标是否被别的元素遮住。命中元素是目标自身、其后代或祖先（如 label > input）都算未被遮挡。
 */
function __dyOcclusion(el) {
  var rect = __dyAbsoluteRect(el);
  if (rect.width < 1 || rect.height < 1) return { occluded: false, invisible: true };
  var hit = __dyHitTestAt(rect.x + rect.width / 2, rect.y + rect.height / 2);
  if (!hit) return { occluded: false, point: { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 } };
  if (hit.crossOriginFrame) {
    return { occluded: false, crossOriginFrame: true, hit: { tag: 'iframe' } };
  }
  if (__dyContains(el, hit.el) || __dyContains(hit.el, el)) return { occluded: false };
  return {
    occluded: true,
    point: { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) },
    hit: __dyDescribeEl(hit.el),
    errorCode: 'TARGET_OCCLUDED'
  };
}
function __dyFindElByRef(ref) {
  var direct = null;
  try { direct = (window.__dieyunRefs || {})[ref]; } catch (e) { direct = null; }
  if (direct && direct.isConnected) return { el: direct, frame: 'main' };
  var topEl = null;
  try { topEl = document.querySelector('[data-dieyun-ref="' + ref + '"]'); } catch (e) { topEl = null; }
  if (topEl) return { el: topEl, frame: 'main' };
  var entries = __dyFrameEntries();
  for (var i = 0; i < entries.length; i++) {
    if (!entries[i].accessible) continue;
    var el = null;
    try { el = entries[i].win.document.querySelector('[data-dieyun-ref="' + ref + '"]'); } catch (e) { el = null; }
    if (el) return { el: el, frame: entries[i].desc.main ? 'main' : entries[i].desc.path };
  }
  if (direct) return { el: direct, frame: 'main' };
  return { el: null, frame: '' };
}
/**
 * 目标解析（frame 感知）：
 *   · 给了 frame spec → 只在该 frame 内查找
 *   · 未给 frame → 先在顶层找，再按需遍历同源子 frame（ref 优先，其次 selector）
 */
function __dyResolveTargetEx(ref, selector, frameSpec) {
  if (!__dyFrameSpecIsMain(frameSpec)) {
    var picked = __dyPickFrame(frameSpec);
    if (!picked.ok) return picked;
    var found = null;
    if (ref) {
      try { found = (picked.win.__dieyunRefs || {})[ref] || picked.doc.querySelector('[data-dieyun-ref="' + ref + '"]'); } catch (e) { found = null; }
    }
    if (!found && selector) {
      try { found = picked.doc.querySelector(selector); } catch (e) { found = null; }
    }
    if (!found) {
      return {
        ok: false,
        error: '元素未找到（目标 frame ' + picked.path + ' 内无匹配）',
        errorCode: 'TARGET_NOT_FOUND',
        framePath: picked.path,
        frameUrl: picked.url,
        selector: selector || '',
        frames: __dyFrameSummary(__dyFrameEntries())
      };
    }
    return { ok: true, el: found, framePath: picked.path, frameUrl: picked.url, frame: picked.path === 'main' ? 'main' : 'iframe' };
  }
  if (ref) {
    var byRef = __dyFindElByRef(ref);
    if (byRef.el) {
      var ownerWin = null;
      try { ownerWin = byRef.el.ownerDocument ? byRef.el.ownerDocument.defaultView : null; } catch (e) { ownerWin = null; }
      var isTop = ownerWin === __dyTopWindow();
      return { ok: true, el: byRef.el, framePath: isTop ? 'main' : byRef.frame, frame: isTop ? 'main' : 'iframe' };
    }
    return {
      ok: false,
      error: '元素未找到（ref 已过期，请重新 browser_snapshot）',
      errorCode: 'TARGET_NOT_FOUND',
      ref: ref,
      frames: __dyFrameSummary(__dyFrameEntries())
    };
  }
  if (selector) {
    var mainEl = null;
    try { mainEl = document.querySelector(selector); } catch (e) { mainEl = null; }
    if (mainEl) return { ok: true, el: mainEl, framePath: 'main', frame: 'main' };
    var all = __dyFrameEntries();
    for (var j = 0; j < all.length; j++) {
      if (!all[j].accessible) continue;
      var sub = null;
      try { sub = all[j].win.document.querySelector(selector); } catch (e) { sub = null; }
      if (sub) {
        return { ok: true, el: sub, framePath: all[j].desc.main ? 'main' : all[j].desc.path, frame: all[j].desc.main ? 'main' : 'iframe' };
      }
    }
    return {
      ok: false,
      error: '元素未找到',
      errorCode: 'TARGET_NOT_FOUND',
      selector: selector,
      frames: __dyFrameSummary(all)
    };
  }
  return { ok: false, error: '需要提供 ref 或 selector', errorCode: 'TARGET_REQUIRED' };
}
`.trim();

/** frame 树脚本：BrowserView 无 CDP 时的同源回退（跨域 frame 只能列出，进不去）。 */
function buildFrameTreeScript() {
  return `(() => {
    ${FRAME_HELPERS}
    const entries = __dyFrameEntries();
    return {
      ok: true,
      url: location.href,
      title: document.title || '',
      frames: entries.map(function (e) {
        return {
          path: e.desc.main ? 'main' : e.desc.path,
          main: !!e.desc.main,
          name: e.desc.name || '',
          url: e.desc.url || '',
          id: e.id || '',
          src: e.src || '',
          rect: e.rect,
          accessible: e.accessible !== false,
          crossOrigin: e.accessible === false
        };
      }),
      truncated: entries.length > __dyFrameMaxCount
    };
  })()`;
}

/** 目标诊断脚本：失败时回传「当前 URL / frame 层级 / 遮挡者是谁」。 */
function buildTargetDiagnosticsScript(refJson, selectorJson, frameJson) {
  return `(() => {
    ${FRAME_HELPERS}
    const ref = ${refJson};
    const selector = ${selectorJson};
    const frameSpec = ${frameJson};
    const resolved = __dyResolveTargetEx(ref, selector, frameSpec);
    const out = {
      url: location.href,
      title: document.title || '',
      mainFrame: { url: location.href, readyState: document.readyState },
      framePath: resolved.ok ? resolved.framePath : (frameSpec && frameSpec.kind === 'path' ? frameSpec.path.join('.') : 'main'),
      requestedFrame: frameSpec && frameSpec.kind !== 'main' ? frameSpec : undefined,
      frames: __dyFrameSummary(__dyFrameEntries())
    };
    if (!resolved.ok) {
      return Object.assign({ ok: false, reason: 'target-not-found' }, out, {
        error: resolved.error,
        errorCode: resolved.errorCode || 'TARGET_NOT_FOUND',
        selector: selector || '',
        ref: ref || ''
      });
    }
    const el = resolved.el;
    const rect = __dyAbsoluteRect(el);
    const style = (function () {
      try {
        const win = el.ownerDocument.defaultView;
        const cs = win.getComputedStyle(el);
        return { display: cs.display, visibility: cs.visibility, opacity: cs.opacity, pointerEvents: cs.pointerEvents };
      } catch (e) { return null; }
    })();
    const occlusion = __dyOcclusion(el);
    return Object.assign({ ok: true }, out, {
      framePath: resolved.framePath,
      target: __dyDescribeEl(el),
      rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
      style: style,
      occluded: !!occlusion.occluded,
      occludedBy: occlusion.occluded ? occlusion.hit : undefined,
      hitPoint: occlusion.point
    });
  })()`;
}

/** 标注叠加层：给 ref 元素画框 + 编号（absolute 模式用跨帧绝对坐标，local 模式用本帧视口坐标）。 */
function buildAnnotateScript(opts = {}) {
  const absolute = opts.absolute !== false;
  const labelInside = opts.labelInside === true;
  const maxLabels = Math.max(1, Math.min(200, Number(opts.maxLabels) || 120));
  return `(() => {
    ${FRAME_HELPERS}
    const absolute = ${absolute ? 'true' : 'false'};
    const labelInside = ${labelInside ? 'true' : 'false'};
    const maxLabels = ${maxLabels};
    const OVERLAY_ID = '__dieyun_annotate_overlay';
    const prev = document.getElementById(OVERLAY_ID);
    if (prev && prev.parentNode) prev.parentNode.removeChild(prev);
    const root = document.createElement('div');
    root.id = OVERLAY_ID;
    root.setAttribute('data-dieyun-overlay', '1');
    root.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;z-index:2147483647;pointer-events:none;';
    const targets = [];
    if (absolute) {
      const entries = __dyFrameEntries();
      for (let i = 0; i < entries.length; i++) {
        if (!entries[i].accessible) continue;
        let list = [];
        try { list = entries[i].win.document.querySelectorAll('[data-dieyun-ref]'); } catch (e) { list = []; }
        for (let j = 0; j < list.length; j++) targets.push(list[j]);
      }
    } else {
      try {
        const list = document.querySelectorAll('[data-dieyun-ref]');
        for (let j = 0; j < list.length; j++) targets.push(list[j]);
      } catch (e) {}
    }
    let drawn = 0;
    for (let i = 0; i < targets.length && drawn < maxLabels; i++) {
      const el = targets[i];
      let rect = null;
      try {
        rect = absolute ? __dyAbsoluteRect(el) : el.getBoundingClientRect();
      } catch (e) { rect = null; }
      if (!rect || rect.width < 1 || rect.height < 1) continue;
      const box = document.createElement('div');
      box.style.cssText = 'position:fixed;box-sizing:border-box;border:2px solid #e11d48;background:rgba(225,29,72,0.08);'
        + 'left:' + Math.round(rect.x) + 'px;top:' + Math.round(rect.y) + 'px;'
        + 'width:' + Math.round(rect.width) + 'px;height:' + Math.round(rect.height) + 'px;pointer-events:none;';
      const ref = (function () { try { return String(el.getAttribute('data-dieyun-ref') || ''); } catch (e) { return ''; } })();
      const label = document.createElement('div');
      label.textContent = ref;
      const labelTop = labelInside ? Math.round(rect.y) + 2 : Math.max(0, Math.round(rect.y) - 16);
      const labelLeft = labelInside ? Math.round(rect.x) + 2 : Math.round(rect.x);
      label.style.cssText = 'position:fixed;left:' + labelLeft + 'px;top:' + labelTop + 'px;'
        + 'font:11px/16px monospace;color:#fff;background:#e11d48;padding:0 4px;border-radius:3px;pointer-events:none;white-space:nowrap;';
      root.appendChild(box);
      root.appendChild(label);
      drawn += 1;
    }
    document.documentElement.appendChild(root);
    return { ok: true, drawn: drawn, total: targets.length, absolute: absolute };
  })()`;
}

function buildClearAnnotationScript() {
  return `(() => {
    const OVERLAY_ID = '__dieyun_annotate_overlay';
    const nodes = document.querySelectorAll('#' + OVERLAY_ID);
    for (let i = 0; i < nodes.length; i++) {
      if (nodes[i].parentNode) nodes[i].parentNode.removeChild(nodes[i]);
    }
    return { ok: true, removed: nodes.length };
  })()`;
}

module.exports = {
  FRAME_MAX_DEPTH,
  FRAME_MAX_COUNT,
  FRAME_HELPERS,
  normalizeFrameSpec,
  isMainFrameSpec,
  normalizeFramePath,
  frameDescriptorMatches,
  describeFrameSpec,
  summarizeFramesForHint,
  buildFrameTreeScript,
  buildTargetDiagnosticsScript,
  buildAnnotateScript,
  buildClearAnnotationScript
};
