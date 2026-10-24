'use strict';

/**
 * 引擎解析公用工具：URL 归一化 + 各家跳转链解包。
 * 跳转链不在这里解掉，下游 web_fetch 会白跑一次重定向，甚至被反爬挡住。
 */

const { cleanInline } = require('../text');
const { safeUrlOrNull, assertSafeUrl } = require('../url-safety');

/** 把 href 变成绝对 URL，并过 SSRF 白名单；不合规则返回空串。 */
function absoluteSafeUrl(href, baseUrl) {
  const raw = String(href || '').trim();
  if (!raw || /^(javascript|data|mailto|tel|about|blob):/i.test(raw)) return '';
  try {
    return assertSafeUrl(new URL(raw, baseUrl || undefined).href);
  } catch {
    return '';
  }
}

/** Bing 的 /ck/a?u=a1<base64url> 跳转链。 */
function unwrapBing(href) {
  try {
    const u = new URL(href);
    if (!/(^|\.)bing\.com$/i.test(u.hostname) || u.pathname !== '/ck/a') return href;
    const raw = u.searchParams.get('u') || '';
    if (!/^a1/i.test(raw)) return href;
    const b64 = raw.slice(2).replace(/-/g, '+').replace(/_/g, '/');
    const decoded = Buffer.from(b64, 'base64').toString('utf8');
    return /^https?:\/\//i.test(decoded) ? decoded : href;
  } catch {
    return href;
  }
}

/** Google 的 /url?q= 跳转链。 */
function unwrapGoogle(href) {
  try {
    const u = new URL(href);
    if (!/(^|\.)google\.[a-z.]+$/i.test(u.hostname)) return href;
    if (u.pathname !== '/url') return href;
    const target = u.searchParams.get('q') || u.searchParams.get('url') || '';
    return /^https?:\/\//i.test(target) ? target : href;
  } catch {
    return href;
  }
}

/** DuckDuckGo 的 /l/?uddg= 跳转链。 */
function unwrapDuckDuckGo(href) {
  try {
    const u = new URL(href);
    if (!/(^|\.)duckduckgo\.com$/i.test(u.hostname)) return href;
    const target = u.searchParams.get('uddg') || '';
    return /^https?:\/\//i.test(target) ? target : href;
  } catch {
    return href;
  }
}

function hostOfSafe(url) {
  const safe = safeUrlOrNull(url);
  if (!safe) return '';
  try {
    return new URL(safe).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function normalizeQuery(query, site) {
  const q = String(query || '').trim();
  const s = String(site || '').trim();
  if (!q) return '';
  if (!s) return q;
  const host = s.replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
  if (!host) return q;
  return /site:/i.test(q) ? q : `${q} site:${host}`;
}

function clampPage(page) {
  const n = Number(page);
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(10, Math.floor(n));
}

/** 统一的结果对象：title/url/snippet 都可为空，由上层决定去留。 */
function makeResult({ title, url, snippet }) {
  return {
    title: cleanInline(title).slice(0, 180),
    url: String(url || ''),
    snippet: cleanInline(snippet).slice(0, 360)
  };
}

module.exports = {
  absoluteSafeUrl,
  unwrapBing,
  unwrapGoogle,
  unwrapDuckDuckGo,
  hostOfSafe,
  normalizeQuery,
  clampPage,
  makeResult
};
