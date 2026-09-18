'use strict';

/**
 * 页面内 JavaScript 求值：脚本构建与结果规整（纯字符串处理，零 Electron 依赖，便于单测）。
 *
 * 安全约定：调用方负责授权（当前复用 browserAutomation 权限），并已把
 * browser_evaluate 归入 mutating 工具（串行化 + 计划/只读态拦截）。
 * 这里只保证：错误被捕获成结构化结果（含 stack/line）、返回值可 JSON 化且不丢信息。
 *
 * 「不丢信息」是关键：直接 JSON.stringify(DOM 节点) 得到的是 `{}`，
 * 模型会以为页面上什么都没有。所以先过一遍安全序列化器：
 *   DOM → {__dieyunType:'dom', tag, id, class, text, rect, attrs}
 *   Window / Function / Error / Map / Set → 结构化描述
 *   循环引用 → {__dieyunType:'circular'}，深度/宽度超限 → 明确截断标记
 */

const EVALUATE_RESULT_MAX_CHARS = 32000;
const EVALUATE_RESULT_MIN_CHARS = 1000;
const EVALUATE_SAFE_DEPTH = 6;
const EVALUATE_SAFE_KEYS = 50;
const EVALUATE_SAFE_ARRAY = 100;

/** 安全序列化器源码（内联进注入脚本，不用 new Function，规避 CSP）。 */
const SAFE_SERIALIZER_SOURCE = `
const __dyMaxDepth = ${EVALUATE_SAFE_DEPTH};
const __dyMaxKeys = ${EVALUATE_SAFE_KEYS};
const __dyMaxArray = ${EVALUATE_SAFE_ARRAY};
function __dyCtorName(v) {
  try {
    if (!v || typeof v !== 'object') return '';
    const c = v.constructor;
    return c && c.name ? String(c.name) : '';
  } catch (e) { return ''; }
}
function __dyDescribeNode(node) {
  const out = { __dieyunType: 'dom' };
  try {
    out.nodeType = node.nodeType;
    const el = node.nodeType === 9 ? node.documentElement : node;
    if (!el) return out;
    out.tag = String(el.tagName || '').toLowerCase();
    if (el.id) out.id = String(el.id).slice(0, 200);
    if (typeof el.className === 'string' && el.className) out.class = el.className.slice(0, 240);
    const text = String(el.textContent || '').replace(/\\s+/g, ' ').trim();
    if (text) out.text = text.slice(0, 240);
    try {
      const r = el.getBoundingClientRect();
      out.rect = { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) };
    } catch (e) {}
    if (el.attributes) {
      const attrs = {};
      let n = 0;
      for (let i = 0; i < el.attributes.length && n < 12; i++) {
        const a = el.attributes[i];
        if (!a || String(a.name || '').indexOf('data-dieyun-ref') === 0) continue;
        if (String(a.name || '').indexOf('on') === 0) continue;
        attrs[a.name] = String(a.value == null ? '' : a.value).slice(0, 160);
        n += 1;
      }
      if (n) out.attrs = attrs;
    }
  } catch (e) {}
  return out;
}
function __dySafeValue(value, seen, depth) {
  if (value === null) return null;
  const t = typeof value;
  if (t === 'undefined') return { __dieyunType: 'undefined' };
  if (t === 'string') return value;
  if (t === 'number' || t === 'boolean') return value;
  if (t === 'bigint') return String(value);
  if (t === 'symbol') return { __dieyunType: 'symbol', description: String(value.description || '') };
  if (t === 'function') {
    return { __dieyunType: 'function', name: String(value.name || '(anonymous)'), length: value.length };
  }
  if (depth > __dyMaxDepth) {
    return { __dieyunType: 'truncated', reason: 'max-depth', ctor: __dyCtorName(value) };
  }
  try {
    if (seen.indexOf(value) >= 0) return { __dieyunType: 'circular' };
    seen.push(value);
  } catch (e) {
    return { __dieyunType: 'unserializable' };
  }
  try {
    try {
      if (value.window === value && value.document) {
        return { __dieyunType: 'window', url: String(value.location && value.location.href || '') };
      }
    } catch (e) {}
    if (typeof Node !== 'undefined' && value instanceof Node) return __dyDescribeNode(value);
    if (value instanceof Error || (value.name && value.message && String(value.stack || ''))) {
      return {
        __dieyunType: 'error',
        name: String(value.name || 'Error'),
        message: String(value.message || ''),
        stack: String(value.stack || '').split('\\n').slice(0, 4).join('\\n')
      };
    }
    if (typeof Map !== 'undefined' && value instanceof Map) {
      const entries = [];
      let i = 0;
      value.forEach(function (v, k) {
        if (entries.length < __dyMaxKeys) entries.push([__dySafeValue(k, seen, depth + 1), __dySafeValue(v, seen, depth + 1)]);
        i += 1;
      });
      return { __dieyunType: 'map', size: value.size, truncated: i > __dyMaxKeys, entries };
    }
    if (typeof Set !== 'undefined' && value instanceof Set) {
      const items = [];
      value.forEach(function (v) {
        if (items.length < __dyMaxKeys) items.push(__dySafeValue(v, seen, depth + 1));
      });
      return { __dieyunType: 'set', size: value.size, truncated: value.size > __dyMaxKeys, items };
    }
    if (Array.isArray(value)) {
      const arr = [];
      const limit = Math.min(value.length, __dyMaxArray);
      for (let i = 0; i < limit; i++) arr.push(__dySafeValue(value[i], seen, depth + 1));
      if (value.length > limit) arr.push({ __dieyunType: 'truncated', reason: 'array-length', omitted: value.length - limit });
      return arr;
    }
    const out = {};
    let keys = [];
    try { keys = Object.keys(value); } catch (e) { keys = []; }
    const limit = Math.min(keys.length, __dyMaxKeys);
    for (let i = 0; i < limit; i++) out[keys[i]] = __dySafeValue(value[keys[i]], seen, depth + 1);
    if (keys.length > limit) out.__dieyunTruncatedKeys = keys.length - limit;
    const ctor = __dyCtorName(value);
    if (ctor && ctor !== 'Object') out.__dieyunType = ctor;
    return out;
  } catch (e) {
    return { __dieyunType: 'unserializable', error: String(e && e.message ? e.message : e) };
  } finally {
    try { seen.pop(); } catch (e) {}
  }
}
`;

/**
 * 生成可直接交给 executeJavaScript / page.evaluate / CDP Runtime.evaluate 的表达式。
 * 用 async IIFE 包裹，因此脚本里可以用 return 与 await；不依赖 new Function，规避 CSP。
 * @param {string} script
 * @param {{ maxChars?: number }} [opts]
 * @returns {string}
 */
function buildEvaluateScript(script, opts = {}) {
  const src = String(script == null ? '' : script);
  const rawMax = Number(opts.maxChars);
  const maxChars = Math.min(
    EVALUATE_RESULT_MAX_CHARS,
    Math.max(EVALUATE_RESULT_MIN_CHARS, Number.isFinite(rawMax) && rawMax > 0 ? Math.floor(rawMax) : EVALUATE_RESULT_MAX_CHARS)
  );
  return `(async () => {
  try {
${SAFE_SERIALIZER_SOURCE}
    const __dieyunValue = await (async () => {
${src}
    })();
    let __dieyunJson = null;
    try {
      __dieyunJson = JSON.stringify(__dySafeValue(__dieyunValue, [], 0));
    } catch (e) {
      __dieyunJson = null;
    }
    if (__dieyunJson == null && typeof __dieyunValue !== 'undefined') {
      try {
        __dieyunJson = String(__dieyunValue);
      } catch (e) {
        __dieyunJson = null;
      }
    }
    let __dieyunTruncated = false;
    if (typeof __dieyunJson === 'string' && __dieyunJson.length > ${maxChars}) {
      __dieyunJson = __dieyunJson.slice(0, ${maxChars});
      __dieyunTruncated = true;
    }
    const __dieyunType =
      typeof __dieyunValue === 'undefined'
        ? 'undefined'
        : __dieyunValue === null
          ? 'null'
          : Array.isArray(__dieyunValue)
            ? 'array'
            : typeof __dieyunValue;
    return { ok: true, type: __dieyunType, json: __dieyunJson, truncated: __dieyunTruncated };
  } catch (e) {
    const stack = String((e && e.stack) || '');
    const lineMatch = /:(\\d+):(\\d+)\\)?$/.exec(stack.split('\\n')[1] || '');
    return {
      ok: false,
      error: String(e && e.message ? e.message : e),
      name: String((e && e.name) || 'Error'),
      stack: stack.split('\\n').slice(0, 5).join('\\n'),
      line: lineMatch ? Number(lineMatch[1]) : undefined
    };
  }
})()`;
}

/**
 * 等待表达式：把表达式内联进脚本（不经过 new Function，规避 CSP），
 * 由 Node 侧轮询直到为真。
 * @param {string} expr
 */
function buildExpressionProbeScript(expr) {
  const source = String(expr == null ? '' : expr);
  return `(async () => {
  try {
    const __dieyunValue = await (${source});
    return { ok: true, truthy: !!__dieyunValue, value: (function () {
      try { return JSON.stringify(__dieyunValue); } catch (e) { return String(__dieyunValue); }
    })() };
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e), name: String((e && e.name) || 'Error') };
  }
})()`;
}

/**
 * 规整页面返回值为工具结果。
 * @param {unknown} raw
 * @returns {{ ok: boolean, type?: string, json?: string|null, truncated?: boolean, error?: string, errorCode?: string, stack?: string, line?: number }}
 */
function normalizeEvaluateResult(raw) {
  if (!raw || typeof raw !== 'object') {
    return { ok: true, type: typeof raw, json: raw == null ? null : String(raw), truncated: false };
  }
  if (raw.ok === false) {
    return {
      ok: false,
      error: String(raw.error || '脚本执行失败'),
      errorCode: 'SCRIPT_ERROR',
      name: raw.name ? String(raw.name) : undefined,
      stack: raw.stack ? String(raw.stack) : undefined,
      line: raw.line != null ? Number(raw.line) : undefined,
      retryable: false
    };
  }
  return {
    ok: true,
    type: raw.type || 'unknown',
    json: raw.json == null ? null : String(raw.json),
    truncated: !!raw.truncated
  };
}

module.exports = {
  EVALUATE_RESULT_MAX_CHARS,
  EVALUATE_RESULT_MIN_CHARS,
  EVALUATE_SAFE_DEPTH,
  buildEvaluateScript,
  buildExpressionProbeScript,
  normalizeEvaluateResult
};
