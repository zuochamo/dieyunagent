'use strict';

/**
 * Google。
 * 结构：a > h3（外层 a 带 /url?q= 跳转链）。
 * 注意：国内必须走系统代理，且高频请求会返回 429（无结果页）。
 * 因此这里只在解析出 0 条时显式报错，不做任何兜底。
 */

const { absoluteSafeUrl, unwrapGoogle, normalizeQuery, clampPage, makeResult } = require('./util');

const BASE = 'https://www.google.com';

function buildUrl({ query, site, page }) {
  const q = normalizeQuery(query, site);
  if (!q) throw new Error('query 必填');
  const p = clampPage(page);
  const url = new URL('/search', BASE);
  url.searchParams.set('q', q);
  url.searchParams.set('num', '10');
  url.searchParams.set('hl', 'zh-CN');
  if (p > 1) url.searchParams.set('start', String((p - 1) * 10));
  return url.href;
}

function parse(root, { baseUrl }) {
  const out = [];
  for (const h3 of root.querySelectorAll('h3')) {
    const anchor = h3.closest('a') || (h3.parentNode && h3.parentNode.rawTagName === 'a' ? h3.parentNode : null);
    if (!anchor) continue;
    const url = absoluteSafeUrl(unwrapGoogle(anchor.getAttribute('href') || ''), baseUrl);
    if (!url) continue;
    const container = h3.closest('div') || anchor.parentNode;
    const snippetNode =
      (container && container.querySelector('[data-sncf], .VwiC3b, .IsZvec')) || null;
    out.push(
      makeResult({
        title: h3.textContent || '',
        url,
        snippet: snippetNode ? snippetNode.textContent : ''
      })
    );
  }
  return out;
}

module.exports = {
  name: 'google',
  label: 'Google',
  supportsPaging: true,
  buildUrl,
  parse
};
