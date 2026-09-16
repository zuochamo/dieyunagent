'use strict';

/**
 * 页面内 JavaScript 求值：脚本构建与结果规整（纯字符串处理，零 Electron 依赖，便于单测）。
 *
 * 安全约定：调用方负责授权（当前复用 browserAutomation 权限），并已把
 * browser_evaluate 归入 mutating 工具（串行化 + 计划/只读态拦截）。
 * 这里只保证：错误被捕获成结构化结果、返回值被截断、结果可 JSON 化。
 */

const EVALUATE_RESULT_MAX_CHARS = 32000;
const EVALUATE_RESULT_MIN_CHARS = 1000;

/**
 * 生成可直接交给 executeJavaScript / page.evaluate 的表达式。
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
    const __dieyunValue = await (async () => {
${src}
    })();
    let __dieyunJson = null;
    try {
      __dieyunJson = JSON.stringify(__dieyunValue);
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
    return { ok: false, error: String(e && e.message ? e.message : e) };
  }
})()`;
}

/**
 * 规整页面返回值为工具结果。
 * @param {unknown} raw
 * @returns {{ ok: boolean, type?: string, json?: string|null, truncated?: boolean, error?: string, errorCode?: string }}
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
  buildEvaluateScript,
  normalizeEvaluateResult
};
