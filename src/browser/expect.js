'use strict';

/**
 * 结构化断言（browser_expect）：把"我验过了"变成可被护栏识别的 pass/fail 证据。
 *
 * 设计约束：
 * - 只做 DOM/URL 级声明式断言（无任意代码执行），任意脚本仍走 browser_evaluate；
 * - 一次调用在页面内跑完全部断言，只往返一次；
 * - 断言未通过时工具结果返回 ok:false（但不带 error/errorCode），
 *   这样既不会被工具 harness 当成执行失败，又能让 trace 标成 failed，
 *   供完成验收护栏识别。
 *
 * 纯函数，零 Electron 依赖，便于单测。
 */

const { FRAME_HELPERS } = require('./frame-script');

const ASSERTION_KINDS = Object.freeze(['visible', 'hidden', 'text', 'value', 'count', 'url']);
const TARGET_KINDS = Object.freeze(['visible', 'hidden', 'text', 'value']);
const MATCH_KINDS = Object.freeze(['text', 'value', 'url']);
const MAX_ASSERTIONS = 20;
const MAX_ACTUAL_CHARS = 300;
const REF_RE = /^[A-Za-z0-9_-]{1,64}$/;

function invalidAssertion(message) {
  const err = new Error(message);
  err.code = 'INVALID_ASSERTION';
  return err;
}

function normalizeMatch(raw) {
  return String(raw || '').toLowerCase() === 'equals' ? 'equals' : 'contains';
}

function normalizeOp(raw) {
  const op = String(raw || '').toLowerCase();
  return op === 'gte' || op === 'lte' ? op : 'equals';
}

/**
 * 校验并规整断言列表；非法输入直接抛错（让模型能修正），不做静默丢弃。
 * @param {unknown} raw
 * @returns {Array<{ id: string, kind: string, ref?: string, selector?: string, expected?: unknown, match?: string, op?: string }>}
 */
function normalizeAssertions(raw) {
  const list = Array.isArray(raw) ? raw : [];
  if (!list.length) throw invalidAssertion('browser_expect 需要至少一条断言');
  if (list.length > MAX_ASSERTIONS) {
    throw invalidAssertion(`browser_expect 单次最多 ${MAX_ASSERTIONS} 条断言，请分批`);
  }

  const out = [];
  for (let i = 0; i < list.length; i += 1) {
    const a = list[i] && typeof list[i] === 'object' ? list[i] : {};
    const kind = String(a.kind || '').trim().toLowerCase();
    const id = String(a.id || `a${i}`).trim() || `a${i}`;
    if (!ASSERTION_KINDS.includes(kind)) {
      throw invalidAssertion(`第 ${i + 1} 条断言 kind 无效：${kind || '(空)'}，可选 ${ASSERTION_KINDS.join('/')}`);
    }
    const item = { id, kind };

    if (TARGET_KINDS.includes(kind)) {
      const ref = a.ref != null ? String(a.ref).trim() : '';
      const selector = a.selector != null ? String(a.selector).trim() : '';
      if (!ref && !selector) {
        throw invalidAssertion(`第 ${i + 1} 条断言（${kind}）需要 ref 或 selector`);
      }
      if (ref) {
        if (!REF_RE.test(ref)) throw invalidAssertion(`第 ${i + 1} 条断言 ref 非法：${ref}`);
        item.ref = ref;
      } else {
        item.selector = selector;
      }
    }

    if (kind === 'count') {
      const selector = a.selector != null ? String(a.selector).trim() : '';
      if (!selector) throw invalidAssertion(`第 ${i + 1} 条断言（count）需要 selector`);
      item.selector = selector;
      const n = Number(a.expected);
      if (!Number.isFinite(n)) throw invalidAssertion(`第 ${i + 1} 条断言（count）需要数字 expected`);
      item.expected = n;
      item.op = normalizeOp(a.op);
    } else if (MATCH_KINDS.includes(kind)) {
      if (a.expected == null || String(a.expected) === '') {
        throw invalidAssertion(`第 ${i + 1} 条断言（${kind}）需要 expected`);
      }
      item.expected = String(a.expected);
      item.match = normalizeMatch(a.match);
    }

    out.push(item);
  }
  return out;
}

/** 生成在页面内一次性跑完全部断言的表达式。 */
function buildExpectScript(assertionsJson, frameJson) {
  const frameSpecJson = !frameJson || frameJson === 'null' ? 'null' : String(frameJson);
  return `(() => {
  ${FRAME_HELPERS}
  const assertions = ${assertionsJson};
  const frameSpec = ${frameSpecJson};
  const scope = (function () {
    if (__dyFrameSpecIsMain(frameSpec)) {
      const top = __dyTopWindow();
      return { ok: true, doc: document, win: top, path: 'main' };
    }
    return __dyPickFrame(frameSpec);
  })();
  if (!scope.ok) return { ok: false, error: scope.error, errorCode: scope.errorCode, frames: scope.frames, results: [] };
  const isVisible = (el) =>
    !!el && !!(el.offsetWidth || el.offsetHeight || (el.getClientRects && el.getClientRects().length));
  const resolve = (a) => {
    if (a.ref) {
      const resolved = __dyResolveTargetEx(a.ref, '', frameSpec);
      return resolved.ok ? resolved.el : null;
    }
    if (a.selector) {
      try { return scope.doc.querySelector(String(a.selector)); } catch (e) { return null; }
    }
    return null;
  };
  const clip = (v) => {
    const s = v == null ? '' : String(v);
    return s.length > ${MAX_ACTUAL_CHARS} ? s.slice(0, ${MAX_ACTUAL_CHARS}) + '…' : s;
  };
  const hit = (actual, expected, match) => {
    const a = String(actual == null ? '' : actual);
    const e = String(expected == null ? '' : expected);
    return match === 'equals' ? a === e : a.includes(e);
  };
  const results = [];
  for (let i = 0; i < assertions.length; i += 1) {
    const a = assertions[i] || {};
    const row = { id: a.id, kind: a.kind, pass: false, expected: a.expected, actual: '' };
    try {
      if (a.kind === 'url') {
        let url = '';
        try { url = String((scope.win && scope.win.location && scope.win.location.href) || location.href); } catch (e) { url = String(location.href); }
        row.actual = clip(url);
        row.pass = hit(url, a.expected, a.match);
      } else if (a.kind === 'count') {
        let n = 0;
        try { n = scope.doc.querySelectorAll(String(a.selector)).length; } catch (e) { n = 0; }
        row.actual = String(n);
        const exp = Number(a.expected);
        if (a.op === 'gte') row.pass = n >= exp;
        else if (a.op === 'lte') row.pass = n <= exp;
        else row.pass = n === exp;
      } else {
        const el = resolve(a);
        if (a.kind === 'visible') {
          row.actual = isVisible(el) ? 'visible' : (el ? 'hidden' : 'not found');
          row.pass = isVisible(el);
        } else if (a.kind === 'hidden') {
          row.actual = isVisible(el) ? 'visible' : 'hidden';
          row.pass = !isVisible(el);
        } else if (a.kind === 'text') {
          const t = el ? String(el.innerText || el.textContent || '').trim() : '';
          row.actual = clip(t);
          row.pass = !!el && hit(t, a.expected, a.match);
        } else if (a.kind === 'value') {
          const v = el && el.value != null ? String(el.value) : '';
          row.actual = clip(v);
          row.pass = !!el && hit(v, a.expected, a.match);
        }
      }
    } catch (e) {
      row.message = String(e && e.message ? e.message : e);
    }
    results.push(row);
  }
  const failed = results.filter((r) => !r.pass).length;
  return {
    ok: true,
    url: String(location.href),
    total: results.length,
    passed: results.length - failed,
    failed,
    results
  };
})()`;
}

/**
 * 规整为工具结果：断言有失败时 ok:false（不带 error/errorCode，避免被判成执行失败）。
 * @param {unknown} raw
 * @param {{ engine?: string }} [opts]
 */
function shapeExpectResult(raw, opts = {}) {
  const base = { engine: opts.engine };
  if (!raw || typeof raw !== 'object') {
    return { ...base, ok: false, total: 0, passed: 0, failed: 0, results: [], error: '断言未返回结果' };
  }
  const results = Array.isArray(raw.results) ? raw.results : [];
  const failed = Number.isFinite(Number(raw.failed))
    ? Number(raw.failed)
    : results.filter((r) => !r || !r.pass).length;
  const total = Number.isFinite(Number(raw.total)) ? Number(raw.total) : results.length;
  return {
    ...base,
    ok: failed === 0 && total > 0,
    url: raw.url ? String(raw.url) : '',
    total,
    passed: Number.isFinite(Number(raw.passed)) ? Number(raw.passed) : total - failed,
    failed,
    results: results.map((r) => ({
      id: r && r.id != null ? String(r.id) : '',
      kind: r && r.kind ? String(r.kind) : '',
      pass: !!(r && r.pass),
      expected: r ? r.expected : undefined,
      actual: r && r.actual != null ? String(r.actual) : '',
      message: r && r.message ? String(r.message) : undefined
    }))
  };
}

module.exports = {
  ASSERTION_KINDS,
  MAX_ASSERTIONS,
  normalizeAssertions,
  buildExpectScript,
  shapeExpectResult
};
