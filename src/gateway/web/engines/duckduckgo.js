'use strict';

/**
 * DuckDuckGo（html 版，无 JS）。
 * 结构：.result > a.result__a[href]，摘要 .result__snippet。
 * 国内不可直连，需系统代理；分页参数不可靠，故 supportsPaging=false。
 */

const { absoluteSafeUrl, unwrapDuckDuckGo, normalizeQuery, makeResult } = require('./util');

const BASE = 'https://duckduckgo.com';

function buildUrl({ query, site }) {
  const q = normalizeQuery(query, site);
  if (!q) throw new Error('query 必填');
  const url = new URL('/html/', BASE);
  url.searchParams.set('q', q);
  url.searchParams.set('kl', 'cn-zh');
  return url.href;
}

function parse(root, { baseUrl }) {
  const out = [];
  for (const block of root.querySelectorAll('.result')) {
    const a = block.querySelector('a.result__a') || block.querySelector('a');
    if (!a) continue;
    const url = absoluteSafeUrl(unwrapDuckDuckGo(a.getAttribute('href') || ''), baseUrl);
    if (!url) continue;
    const sn = block.querySelector('.result__snippet');
    out.push(
      makeResult({
        title: a.textContent || '',
        url,
        snippet: sn ? sn.textContent : ''
      })
    );
  }
  return out;
}

module.exports = {
  name: 'duckduckgo',
  label: 'DuckDuckGo',
  supportsPaging: false,
  buildUrl,
  parse
};
