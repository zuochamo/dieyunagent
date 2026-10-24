'use strict';

/**
 * 搜索引擎注册表：新增引擎 = 新增一个 engines/<name>.js + 这里登记一行。
 * 不在编排层写 if/else 分支，也不在别处再实现一份 URL 拼接/结果解析。
 */

const bing = require('./bing');
const baidu = require('./baidu');
const google = require('./google');
const duckduckgo = require('./duckduckgo');
const { parseHtml } = require('../extract');

const ENGINES = { bing, baidu, google, duckduckgo };

/** 默认引擎必须是「本机可达且解析稳定」的那个：cn.bing.com。 */
const DEFAULT_ENGINE = 'bing';
const ENGINE_NAMES = Object.keys(ENGINES);
const MAX_RESULTS = 10;

function resolveEngine(name) {
  const key = String(name || '').trim().toLowerCase();
  return ENGINES[key] || ENGINES[DEFAULT_ENGINE];
}

/**
 * @param {string} query
 * @param {string|{ engine?: string, site?: string, page?: number }} [options]
 * @returns {{ engine: string, url: string, page: number, supportsPaging: boolean }}
 */
function buildSearchUrl(query, options = {}) {
  const opts = typeof options === 'string' ? { engine: options } : options || {};
  const engine = resolveEngine(opts.engine);
  const page = Math.max(1, Number(opts.page) || 1);
  return {
    engine: engine.name,
    url: engine.buildUrl({ query, site: opts.site, page }),
    page: engine.supportsPaging ? page : 1,
    supportsPaging: engine.supportsPaging
  };
}

function dedupeResults(list) {
  const seen = new Set();
  const out = [];
  for (const item of list || []) {
    const url = String(item.url || '');
    const title = String(item.title || '');
    if (!url || !title) continue;
    const key = url.replace(/#.*$/, '');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ rank: out.length + 1, title, url, snippet: String(item.snippet || '') });
    if (out.length >= MAX_RESULTS) break;
  }
  return out;
}

/**
 * @param {string} html
 * @param {string} engineName
 * @param {{ baseUrl: string }} ctx
 */
function parseSearchResults(html, engineName, ctx) {
  const engine = resolveEngine(engineName);
  const root = parseHtml(html);
  return dedupeResults(engine.parse(root, { baseUrl: (ctx && ctx.baseUrl) || engine.name }));
}

module.exports = {
  ENGINES,
  ENGINE_NAMES,
  DEFAULT_ENGINE,
  MAX_RESULTS,
  resolveEngine,
  buildSearchUrl,
  parseSearchResults,
  dedupeResults
};
