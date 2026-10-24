'use strict';

/**
 * 单页抓取编排：传输 → 内容类型分流 → 正文抽取 → 截断。
 * web_fetch 工具与 web_search 的 fetchTop 共用这一条路径（唯一来源）。
 */

const transport = require('./transport');
const { extractMainContent } = require('./extract');
const { htmlToText, clipText } = require('./text');
const { fetchCache } = require('./cache');

const DEFAULT_MAX_CHARS = 12000;
const MIN_MAX_CHARS = 500;
const MAX_MAX_CHARS = 32000;

function clampMaxChars(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_MAX_CHARS;
  return Math.max(MIN_MAX_CHARS, Math.min(MAX_MAX_CHARS, Math.floor(n)));
}

function isHtmlLike(contentType, body) {
  if (/html/i.test(contentType || '')) return true;
  if (!contentType && /^\s*<(?:!doctype|html)/i.test(String(body || '').slice(0, 200))) return true;
  return false;
}

function isTextLike(contentType) {
  return /json|text|xml|javascript|csv/i.test(contentType || '');
}

/**
 * @param {string} url
 * @param {{ maxChars?: number, timeoutMs?: number, mode?: 'auto'|'main'|'plain', session?: 'browser'|'default', skipCache?: boolean }} [opts]
 */
async function webFetch(url, opts = {}) {
  const target = String(url || '').trim();
  const maxChars = clampMaxChars(opts.maxChars);
  const mode = opts.mode === 'plain' || opts.mode === 'main' ? opts.mode : 'auto';
  const sessionMode = opts.session === 'default' ? 'default' : 'browser';
  const cacheKey = `fetch|${sessionMode}|${target}|${mode}|${maxChars}`;

  if (!opts.skipCache) {
    const hit = fetchCache.get(cacheKey);
    if (hit) return { ...hit, cached: true };
  }

  const res = await transport.request(target, { timeoutMs: opts.timeoutMs, session: sessionMode });
  if (!res.ok) {
    const safetyReject = res.code === 'URL_NOT_ALLOWED' || res.code === 'INVALID_URL';
    return {
      ok: false,
      url: res.url || target,
      status: res.status || 0,
      error: res.error || '抓取失败',
      // 字段名必须是 errorCode / suggestedFix / diagnostics：这三个是工具失败契约
      // （tool-harness.classifyFailure + wrapStructuredError + 遥测）唯一认的名字。
      // 写成 code / hint 会让 web_fetch 的精确错误码在失败信封里丢失，全部塌成 TOOL_ERROR。
      errorCode: res.code || 'FETCH_FAILED',
      transport: res.transport || '',
      retryable: res.code === 'FETCH_FAILED' || res.code === 'NETWORK_ERROR',
      suggestedFix: safetyReject
        ? ''
        : '若是需要登录/JS 渲染/被反爬拦截的站点，改用 browser_navigate 打开同一 URL，再 browser_snapshot 读正文。',
      diagnostics: { url: res.url || target, status: res.status || 0, transport: res.transport || '' }
    };
  }

  if (res.status >= 400) {
    const denied = res.status === 401 || res.status === 403;
    return {
      ok: false,
      url: res.url,
      status: res.status,
      contentType: res.contentType,
      error: `HTTP ${res.status}`,
      errorCode: denied ? 'ACCESS_DENIED' : 'HTTP_ERROR',
      retryable: res.status === 429 || res.status >= 500,
      suggestedFix: denied
        ? '该页需要登录或被反爬拦截，改用 browser_navigate 打开（复用浏览器 cookie），再 browser_snapshot。'
        : res.status === 404
          ? 'URL 不存在，先 web_search 确认正确链接，不要重复抓同一地址。'
          : '',
      diagnostics: { url: res.url, status: res.status, contentType: res.contentType || '' }
    };
  }

  const html = res.body || '';
  const result = {
    ok: true,
    url: res.url,
    status: res.status,
    contentType: res.contentType,
    redirects: res.redirects,
    bytes: res.bytes,
    truncatedBody: !!res.truncatedBody,
    transport: res.transport,
    session: res.session || '',
    cached: false
  };

  if (isHtmlLike(res.contentType, html)) {
    if (mode === 'plain') {
      const text = htmlToText(html);
      const truncated = text.length > maxChars;
      result.mode = 'plain';
      result.text = truncated ? clipText(text, maxChars) : text;
      result.truncated = truncated || !!res.truncatedBody;
    } else {
      const extracted = extractMainContent(html, { maxChars });
      result.mode = extracted.mode;
      result.matched = extracted.matched;
      result.title = extracted.title;
      result.text = extracted.text;
      result.truncated = extracted.truncated || !!res.truncatedBody;
    }
  } else if (isTextLike(res.contentType) || !res.contentType) {
    const text = String(html);
    const truncated = text.length > maxChars;
    result.mode = 'raw';
    result.text = truncated ? clipText(text, maxChars) : text;
    result.truncated = truncated || !!res.truncatedBody;
  } else {
    return {
      ok: false,
      url: res.url,
      status: res.status,
      contentType: res.contentType,
      error: `不支持的内容类型: ${String(res.contentType || '').slice(0, 80)}`,
      errorCode: 'UNSUPPORTED_CONTENT_TYPE',
      retryable: false,
      suggestedFix: '这是二进制/媒体文件，web_fetch 只取正文。需要文件本身请用 host_exec 下载到工作区。',
      diagnostics: { url: res.url, status: res.status, contentType: res.contentType || '' }
    };
  }

  result.length = result.text ? result.text.length : 0;
  if (!result.truncatedBody) fetchCache.set(cacheKey, result);
  return result;
}

module.exports = { webFetch, clampMaxChars, DEFAULT_MAX_CHARS };
