'use strict';

/**
 * 百度。
 * 结构：#content_left .result（老版 .c-container，新版可能套 .cosc-card）。
 * 关键点：结果块根节点的 mu 属性是**真实 URL**，a[href] 是 /link?url= 加密跳转链，
 * 所以必须优先取 mu，否则下游抓到的是一层跳转。
 * 百度返回 1MB 级 HTML（内联样式占大半），传输层上限必须留够。
 */

const { absoluteSafeUrl, normalizeQuery, clampPage, makeResult } = require('./util');

const BASE = 'https://www.baidu.com';
const SNIPPET_SELECTORS = ['.c-abstract', '[class*="content-right"]', '.cos-line-clamp-3', '.c-span-last'];

function buildUrl({ query, site, page }) {
  const q = normalizeQuery(query, site);
  if (!q) throw new Error('query 必填');
  const p = clampPage(page);
  const url = new URL('/s', BASE);
  url.searchParams.set('wd', q);
  url.searchParams.set('ie', 'utf-8');
  if (p > 1) url.searchParams.set('pn', String((p - 1) * 10));
  return url.href;
}

function pickSnippet(block) {
  for (const sel of SNIPPET_SELECTORS) {
    const node = block.querySelector(sel);
    if (node && node.textContent.trim()) return node.textContent;
  }
  return '';
}

function parse(root, { baseUrl }) {
  const out = [];
  const blocks = root.querySelectorAll('#content_left .result');
  for (const block of blocks) {
    const a = block.querySelector('h3 a') || block.querySelector('a');
    if (!a) continue;
    const mu = block.getAttribute('mu') || block.getAttribute('data-landurl') || '';
    const href = mu || a.getAttribute('href') || '';
    const url = absoluteSafeUrl(href, baseUrl);
    if (!url) continue;
    out.push(
      makeResult({
        title: a.textContent || block.querySelector('h3')?.textContent || '',
        url,
        snippet: pickSnippet(block)
      })
    );
  }
  return out;
}

module.exports = {
  name: 'baidu',
  label: '百度',
  supportsPaging: true,
  buildUrl,
  parse
};
