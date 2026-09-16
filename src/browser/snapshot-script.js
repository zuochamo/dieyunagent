'use strict';

const INTERACTIVE_SEL =
  'a, button, input, textarea, select, label, [role="button"], [role="link"], [role="textbox"], [role="combobox"], [onclick], input[type="submit"], input[type="button"], [tabindex]:not([tabindex="-1"])';

/** Shared in-page helpers (embedded as string for evaluate) */
const SNAPSHOT_HELPERS = `
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
function __dieyunResolveTarget(ref, selector) {
  if (ref) {
    const el = __dieyunResolveRef(ref);
    if (el) return el;
  }
  if (selector) return document.querySelector(selector);
  return null;
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
function __dieyunCollectRoot(root, out, state, frame) {
  if (!root || out.length >= state.maxElements || state.depth > 10) return;
  const walk = (node) => {
    if (!node || out.length >= state.maxElements || state.depth > 10) return;
    if (node.nodeType === 1) {
      if (__dieyunMatchesInteractive(node) && __dieyunVisible(node)) {
        const id = 'ref-' + (state.ref++);
        out.push(__dieyunAssignRef(node, id, frame));
      }
      if (node.shadowRoot) {
        state.depth++;
        walk(node.shadowRoot);
        state.depth--;
      }
      for (const child of node.children || []) walk(child);
    } else if (node.nodeType === 11) {
      for (const child of node.childNodes || []) {
        if (child.nodeType === 1) walk(child);
      }
    }
  };
  walk(root);
  if (frame === 'main') {
    const iframes = root.querySelectorAll ? root.querySelectorAll('iframe') : [];
    for (const iframe of iframes) {
      if (out.length >= state.maxElements) break;
      try {
        const doc = iframe.contentDocument;
        if (doc && doc.body) {
          state.depth++;
          __dieyunCollectRoot(doc.body, out, state, 'iframe');
          state.depth--;
        }
      } catch (_) {}
    }
  }
}
function __dieyunClickTargetCoords(el) {
  el.scrollIntoView({ block: 'center', inline: 'center' });
  const rect = el.getBoundingClientRect();
  if (rect.width < 1 && rect.height < 1 && el.tagName !== 'INPUT') {
    return { ok: false, error: '元素不可见' };
  }
  return {
    ok: true,
    x: rect.left + rect.width / 2,
    y: rect.top + rect.height / 2,
    tag: el.tagName.toLowerCase()
  };
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
  const interactiveOnly = !!options.interactive;
  const maxElements = Number(options.maxElements) > 0 ? Number(options.maxElements) : 120;
  return `(() => {
    ${SNAPSHOT_HELPERS}
    const interactiveOnly = ${interactiveOnly};
    const maxElements = ${maxElements};
    document.querySelectorAll('[data-dieyun-ref]').forEach(el => el.removeAttribute('data-dieyun-ref'));
    window.__dieyunRefs = {};
    window.__dieyunRefEpoch = (window.__dieyunRefEpoch || 0) + 1;
    const refEpoch = window.__dieyunRefEpoch;
    const elements = [];
    const state = { ref: 0, maxElements, depth: 0 };
    __dieyunCollectRoot(document.body, elements, state, 'main');
    if (!interactiveOnly) {
      document.querySelectorAll('h1, h2, h3, [role="heading"]').forEach(el => {
        if (elements.length >= maxElements) return;
        if (!__dieyunVisible(el)) return;
        const id = 'ref-' + (state.ref++);
        elements.push(__dieyunAssignRef(el, id, 'main'));
      });
    }
    const blockedIframes = [];
    document.querySelectorAll('iframe').forEach(function(iframe) {
      let accessible = false;
      try {
        accessible = !!(iframe.contentDocument && iframe.contentDocument.body);
      } catch (_) {}
      if (!accessible) {
        blockedIframes.push({
          src: iframe.src || iframe.getAttribute('src') || '',
          id: iframe.id || '',
          name: iframe.name || '',
          crossOrigin: true
        });
      }
    });
    let note = 'ref 在本次 snapshot 内有效；页面跳转或再次 snapshot 后需重新获取';
    if (blockedIframes.length) {
      note += '；存在 ' + blockedIframes.length + ' 个跨域 iframe，其内部元素在当前引擎不可操作；若目标表单在该 iframe 内，请改用 engine=playwright（支持跨 frame 定位）。';
    }
    return {
      url: location.href,
      title: document.title || '',
      refEpoch,
      textPreview: (document.body && document.body.innerText ? document.body.innerText : '').slice(0, 6000),
      elements,
      blockedIframes,
      note
    };
  })()`;
}

/** @param {string} refJson JSON-stringified ref id */
function buildClickPrepareScript(refJson) {
  return `(() => {
    ${SNAPSHOT_HELPERS}
    const ref = ${refJson};
    const el = __dieyunResolveRef(ref);
    if (!el) return { ok: false, error: '元素未找到（ref 已过期，请重新 browser_snapshot）' };
    return __dieyunSimulatePointerClick(el);
  })()`;
}

/** @param {string} selectorJson JSON-stringified CSS selector */
function buildClickPrepareScriptBySelector(selectorJson) {
  return `(() => {
    ${SNAPSHOT_HELPERS}
    const el = document.querySelector(${selectorJson});
    if (!el) return { ok: false, error: '元素未找到' };
    return __dieyunSimulatePointerClick(el);
  })()`;
}

/** BrowserView：仅定位元素并返回视口坐标（由 sendInputEvent 执行真实点击） */
function buildClickCoordsScript(refJson) {
  return `(() => {
    ${SNAPSHOT_HELPERS}
    const ref = ${refJson};
    const el = __dieyunResolveRef(ref);
    if (!el) return { ok: false, error: '元素未找到（ref 已过期，请重新 browser_snapshot）' };
    return __dieyunClickTargetCoords(el);
  })()`;
}

function buildClickCoordsScriptBySelector(selectorJson) {
  return `(() => {
    ${SNAPSHOT_HELPERS}
    const el = document.querySelector(${selectorJson});
    if (!el) return { ok: false, error: '元素未找到' };
    return __dieyunClickTargetCoords(el);
  })()`;
}

/** @param {string} refJson @param {string} textJson @param {boolean} clear */
function buildTypePrepareScript(refJson, textJson, clear) {
  return `(() => {
    ${SNAPSHOT_HELPERS}
    const ref = ${refJson};
    const text = ${textJson};
    const clear = ${clear ? 'true' : 'false'};
    const el = __dieyunResolveRef(ref);
    if (!el) return { ok: false, error: '元素未找到（ref 已过期，请重新 browser_snapshot）' };
    return __dieyunSetFieldValue(el, text, clear);
  })()`;
}

/** @param {string} selectorJson @param {string} textJson @param {boolean} clear */
function buildTypePrepareScriptBySelector(selectorJson, textJson, clear) {
  return `(() => {
    ${SNAPSHOT_HELPERS}
    const selector = ${selectorJson};
    const text = ${textJson};
    const clear = ${clear ? 'true' : 'false'};
    const el = document.querySelector(selector);
    if (!el) return { ok: false, error: '元素未找到' };
    return __dieyunSetFieldValue(el, text, clear);
  })()`;
}

/** @param {string} refJson @param {string} selectorJson */
function buildReadFieldScript(refJson, selectorJson) {
  return `(() => {
    ${SNAPSHOT_HELPERS}
    const el = __dieyunResolveTarget(${refJson}, ${selectorJson});
    if (!el) return { ok: false, error: '元素未找到（ref 已过期，请重新 browser_snapshot）' };
    const tag = (el.tagName || '').toLowerCase();
    const value = (tag === 'input' || tag === 'textarea')
      ? (el.value != null ? String(el.value) : '')
      : String(el.textContent || '');
    return { ok: true, value: value, tag: tag, type: el.type || '' };
  })()`;
}

/** Focus and select so CDP Input.insertText replaces the current value. */
function buildSelectFieldScript(refJson, selectorJson) {
  return `(() => {
    ${SNAPSHOT_HELPERS}
    const el = __dieyunResolveTarget(${refJson}, ${selectorJson});
    if (!el) return { ok: false, error: '元素未找到' };
    el.scrollIntoView({ block: 'center', inline: 'center' });
    try { el.focus(); } catch (_) {}
    try { if (typeof el.select === 'function') el.select(); } catch (_) {}
    return { ok: true, tag: (el.tagName || '').toLowerCase(), type: el.type || '' };
  })()`;
}

/** @param {string} refJson @param {string} valueJson @param {string} labelJson */
function buildSelectOptionScript(refJson, selectorJson, valueJson, labelJson) {
  return `(() => {
    ${SNAPSHOT_HELPERS}
    const ref = ${refJson};
    const selector = ${selectorJson};
    const value = ${valueJson};
    const label = ${labelJson};
    const el = __dieyunResolveTarget(ref, selector);
    if (!el) return { ok: false, error: '元素未找到（ref 已过期，请重新 browser_snapshot）' };
    return __dieyunSelectOption(el, value, label);
  })()`;
}

function buildWaitConditionScript(options = {}) {
  const kind = JSON.stringify(String(options.kind || options.type || 'selector'));
  const value = JSON.stringify(String(options.value || options.text || options.selector || options.url || ''));
  return `(() => {
    const kind = ${kind};
    const value = ${value};
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
    const el = value ? document.querySelector(value) : null;
    if (!el) return { ok: false, error: '元素未找到', selector: value };
    const style = window.getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    const visible = style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    return { ok: true, selector: value, visible, text: (el.innerText || el.value || '').slice(0, 300) };
  })()`;
}

function buildUploadFileScript(options = {}) {
  const refJson = JSON.stringify(String(options.ref || ''));
  const selectorJson = JSON.stringify(String(options.selector || ''));
  const fileNameJson = JSON.stringify(String(options.fileName || 'upload.bin'));
  const mimeJson = JSON.stringify(String(options.mime || 'application/octet-stream'));
  const base64Json = JSON.stringify(String(options.base64 || ''));
  return `(() => {
    ${SNAPSHOT_HELPERS}
    const ref = ${refJson};
    const selector = ${selectorJson};
    const fileName = ${fileNameJson};
    const mime = ${mimeJson};
    const base64 = ${base64Json};
    const el = ref ? __dieyunResolveRef(ref) : document.querySelector(selector);
    if (!el) return { ok: false, error: '元素未找到（ref 可能过期，请重新 browser_snapshot）' };
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
function buildHoverCoordsScript(refJson) {
  return `(() => {
    ${SNAPSHOT_HELPERS}
    const ref = ${refJson};
    const el = __dieyunResolveRef(ref);
    if (!el) return { ok: false, error: '元素未找到（ref 已过期，请重新 browser_snapshot）' };
    return __dieyunClickTargetCoords(el);
  })()`;
}

function buildHoverCoordsScriptBySelector(selectorJson) {
  return `(() => {
    ${SNAPSHOT_HELPERS}
    const el = document.querySelector(${selectorJson});
    if (!el) return { ok: false, error: '元素未找到' };
    return __dieyunClickTargetCoords(el);
  })()`;
}

function buildElementBoundsScript(refJson, selectorJson) {
  return `(() => {
    ${SNAPSHOT_HELPERS}
    const ref = ${refJson};
    const selector = ${selectorJson};
    const el = __dieyunResolveTarget(ref, selector);
    if (!el) return { ok: false, error: '元素未找到（ref 已过期，请重新 browser_snapshot）' };
    el.scrollIntoView({ block: 'center', inline: 'center' });
    const rect = el.getBoundingClientRect();
    if (rect.width < 1 && rect.height < 1) return { ok: false, error: '元素不可见' };
    return {
      ok: true,
      x: Math.max(0, Math.floor(rect.left)),
      y: Math.max(0, Math.floor(rect.top)),
      width: Math.max(1, Math.ceil(rect.width)),
      height: Math.max(1, Math.ceil(rect.height))
    };
  })()`;
}

function buildDragCoordsScript(refJson, selectorJson, toRefJson, toSelectorJson, dx, dy) {
  return `(() => {
    ${SNAPSHOT_HELPERS}
    const ref = ${refJson};
    const selector = ${selectorJson};
    const toRef = ${toRefJson};
    const toSelector = ${toSelectorJson};
    const dx = Number(${dx}) || 0;
    const dy = Number(${dy}) || 0;
    const fromEl = __dieyunResolveTarget(ref, selector);
    if (!fromEl) return { ok: false, error: '起始元素未找到（ref 已过期，请重新 browser_snapshot）' };
    const start = __dieyunClickTargetCoords(fromEl);
    if (!start.ok) return start;
    let endX = start.x + dx;
    let endY = start.y + dy;
    if (toRef || toSelector) {
      const toEl = __dieyunResolveTarget(toRef, toSelector);
      if (!toEl) return { ok: false, error: '目标元素未找到' };
      const end = __dieyunClickTargetCoords(toEl);
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
    function walk(el, depth) {
      if (!el || el.nodeType !== 1 || nodes.length >= MAX) return;
      if (visible(el)) {
        const role = roleOf(el);
        const name = nameOf(el);
        const value = el.value != null ? String(el.value).slice(0, 120) : '';
        const interesting = name || value || ['button','link','textbox','combobox','checkbox','radio','menuitem','tab','heading'].includes(role);
        if (interesting) {
          const row = { role, name: name.slice(0, 200), depth };
          if (value) row.value = value;
          if (el.getAttribute('aria-checked') != null) row.states = { checked: el.getAttribute('aria-checked') === 'true' };
          if (el.getAttribute('aria-expanded') != null) row.states = Object.assign(row.states || {}, { expanded: el.getAttribute('aria-expanded') === 'true' });
          nodes.push(row);
        }
      }
      for (const child of el.children || []) walk(child, depth + 1);
    }
    walk(document.body || document.documentElement, 0);
    return { nodes, count: nodes.length, source: 'dom' };
  })()`;
}

function buildContextMenuScript(refJson, selectorJson) {
  return `(() => {
    ${SNAPSHOT_HELPERS}
    const el = __dieyunResolveTarget(${refJson}, ${selectorJson});
    if (!el) return { ok: false, error: '元素未找到（ref 已过期，请重新 browser_snapshot）' };
    el.scrollIntoView({ block: 'center', inline: 'center' });
    const rect = el.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const base = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y, button: 2 };
    el.dispatchEvent(new MouseEvent('contextmenu', base));
    return { ok: true, x, y, tag: (el.tagName || '').toLowerCase() };
  })()`;
}

module.exports = {
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
  buildDragCoordsScript,
  buildWaitConditionScript,
  buildUploadFileScript,
  buildPressKeyScript,
  normalizeModifiers,
  buildA11yDomScanScript,
  buildContextMenuScript
};
