'use strict';

/**
 * 联网能力对外接口（Gateway RPC 与工具层只 require 这一层）。
 *
 * 目录职责：
 *   url-safety.js  SSRF 白名单（mcp/skills catalog 也用它）
 *   transport.js   出网取字节（Electron net 优先，跟随系统代理）
 *   text.js        文本清洗
 *   extract.js     正文定位与抽取
 *   cache.js       TTL/LRU
 *   engines/       搜索引擎注册表（一个引擎一个文件）
 *   search.js      搜索编排（含显式失败语义）
 *   fetch.js       单页抓取编排
 */

const { assertSafeUrl, safeUrlOrNull } = require('./url-safety');
const { webSearch } = require('./search');
const { webFetch, clampMaxChars } = require('./fetch');
const {
  ENGINE_NAMES,
  DEFAULT_ENGINE,
  MAX_RESULTS,
  resolveEngine,
  buildSearchUrl,
  parseSearchResults
} = require('./engines');
const { clearWebCaches, searchCache, fetchCache } = require('./cache');
const { htmlToText, cleanInline } = require('./text');
const { extractMainContent } = require('./extract');
const { activeTransport } = require('./transport');

module.exports = {
  assertSafeUrl,
  safeUrlOrNull,
  webSearch,
  webFetch,
  clampMaxChars,
  ENGINE_NAMES,
  DEFAULT_ENGINE,
  MAX_RESULTS,
  resolveEngine,
  buildSearchUrl,
  parseSearchResults,
  clearWebCaches,
  searchCache,
  fetchCache,
  htmlToText,
  cleanInline,
  extractMainContent,
  activeTransport
};
