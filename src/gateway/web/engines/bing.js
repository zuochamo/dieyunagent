'use strict';

/**
 * Bing（cn.bing.com）。
 * 结构：li.b_algo > h2 > a[href]，摘要 .b_caption p。
 * 国内可直连、返回真结果，是默认引擎。
 */

const { absoluteSafeUrl, unwrapBing, normalizeQuery, clampPage, makeResult } = require('./util');

const BASE = 'https://cn.bing.com';

function buildUrl({ query, site, page }) {
  const q = normalizeQuery(query, site);
  if (!q) throw new Error('query 必填');
  const p = clampPage(page);
  const url = new URL('/search', BASE);
  url.searchParams.set('q', q);
  url.searchParams.set('form', 'QBLH');
  if (p > 1) url.searchParams.set('first', String((p - 1) * 10 + 1));
  return url.href;
}

function parse(root, { baseUrl }) {
  const out = [];
  for (const li of root.querySelectorAll('li.b_algo')) {
    const a = li.querySelector('h2 a') || li.querySelector('a');
    if (!a) continue;
    const href = a.getAttribute('href') || '';
    const url = absoluteSafeUrl(unwrapBing(href), baseUrl);
    if (!url) continue;
    const caption = li.querySelector('.b_caption p') || li.querySelector('p') || li.querySelector('.b_snippet');
    out.push(
      makeResult({
        title: a.textContent || '',
        url,
        snippet: caption ? caption.textContent : ''
      })
    );
  }
  return out;
}

module.exports = {
  name: 'bing',
  label: 'Bing',
  supportsPaging: true,
  buildUrl,
  parse
};
