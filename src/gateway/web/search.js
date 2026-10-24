'use strict';

/**
 * 搜索编排：构造 URL → 取页 → 显式判定失败 → 结构化解析 →（可选）顺手抓 top N 正文。
 *
 * 设计红线（踩过的坑）：
 * 1. 解析 0 条**必须**返回失败。旧实现会退化成「把页面里所有 <a> 当结果」，
 *    于是百度首页/登录/hao123 被当成搜索结果，还附带「请继续 web_fetch」的引导，
 *    静默把垃圾喂给模型 —— 这比直接报错危险得多。
 * 2. 失败信息要能指导下一步（换引擎 / 改关键词 / 稍后重试），不要只说「失败」。
 * 3. 默认引擎只能是本机可达且解析稳定的那个（bing），其余必须显式指定。
 */

const transport = require('./transport');
const {
  buildSearchUrl,
  resolveEngine,
  parseSearchResults,
  DEFAULT_ENGINE,
  ENGINE_NAMES
} = require('./engines');
const { searchCache } = require('./cache');
const { clipText } = require('./text');
const { webFetch, clampMaxChars } = require('./fetch');

const MAX_FETCH_TOP = 3;
const TOTAL_PAGE_CHARS = 12000;
const MAX_PAGE_CHARS_EACH = 4000;
const CAPTCHA_RE = /验证码|安全验证|异常流量|请输入验证码|unusual traffic|verify you are human|captcha/i;

function normalizeArgs(query, engineOrOpts, legacyOpts) {
  const base = typeof engineOrOpts === 'string' ? { engine: engineOrOpts, ...(legacyOpts || {}) } : { ...(engineOrOpts || {}) };
  return {
    query: String(query || '').trim(),
    engine: String(base.engine || '').trim().toLowerCase() || '',
    site: String(base.site || '').trim(),
    page: Math.max(1, Math.floor(Number(base.page) || 1)),
    fetchTop: Math.max(0, Math.min(MAX_FETCH_TOP, Math.floor(Number(base.fetchTop) || 0))),
    maxChars: clampMaxChars(base.maxChars),
    timeoutMs: Number(base.timeoutMs) || 0,
    skipCache: !!base.skipCache,
    session: base.session === 'default' ? 'default' : 'browser'
  };
}

function engineListHint(attempted) {
  const others = ENGINE_NAMES.filter((n) => n !== attempted);
  return `可换 engine=${others.join('|')}，或换更具体的关键词`;
}

/**
 * 搜不动时唯一值得指向的「另一条腿」：内置浏览器。
 * 搜索走 net（无 cookie、不跑 JS），浏览器走 Chromium（有 cookie、能过 JS 挑战），
 * 两者是不同能力层，所以这里只提示，不自动改道（自动改道会抢前台 BrowserView）。
 */
function browserFallbackHint(searchUrl) {
  return `若怀疑是 JS 渲染或需要登录态，可用 browser_navigate 打开 ${searchUrl}，再 browser_snapshot 读结果。`;
}

function searchCacheKey(args, engineName) {
  return `search|${args.session}|${engineName}|${args.query}|${args.site}|${args.page}|${args.fetchTop}`;
}

function formatResultsText({ engineLabel, page, results, pages, maxChars }) {
  const lines = [`【结构化搜索结果】（引擎 ${engineLabel}${page > 1 ? `，第 ${page} 页` : ''}）`];
  for (const r of results) {
    lines.push(`${r.rank}. ${r.title}`);
    lines.push(`URL: ${r.url}`);
    if (r.snippet) lines.push(`摘要: ${r.snippet}`);
  }

  if (pages && pages.length) {
    lines.push('\n【已抓取页面正文】');
    for (const p of pages) {
      const head = `--- #${p.rank} ${p.title || p.url}${p.ok ? '' : `（抓取失败：${p.error || '未知错误'}）`} ---`;
      lines.push(head);
      lines.push(`URL: ${p.url}`);
      if (p.ok && p.text) lines.push(p.text);
      lines.push('');
    }
  } else {
    lines.push('\n建议：需要做推荐、事实核验或引用具体信息时，下一步用 web_fetch 抓取上面 1-3 个最相关 URL。');
  }
  return clipText(lines.join('\n').trim(), maxChars);
}

async function fetchTopPages(results, { count, timeoutMs, budget }) {
  const targets = results.slice(0, count);
  const perPage = Math.max(800, Math.min(MAX_PAGE_CHARS_EACH, Math.floor(budget / Math.max(targets.length, 1))));
  const settled = await Promise.all(
    targets.map(async (r) => {
      try {
        const page = await webFetch(r.url, { maxChars: perPage, timeoutMs });
        return {
          rank: r.rank,
          url: page.url || r.url,
          title: page.title || r.title,
          ok: !!page.ok,
          error: page.ok ? '' : page.error,
          mode: page.mode || '',
          length: page.length || 0,
          text: page.ok ? page.text : ''
        };
      } catch (err) {
        return { rank: r.rank, url: r.url, title: r.title, ok: false, error: err.message, text: '', length: 0 };
      }
    })
  );
  return settled;
}

/**
 * @param {string} query
 * @param {string|object} [engineOrOpts] 引擎名（旧签名）或 options 对象
 * @param {object} [legacyOpts]
 */
async function webSearch(query, engineOrOpts, legacyOpts) {
  const args = normalizeArgs(query, engineOrOpts, legacyOpts);
  if (!args.query) {
    return {
      ok: false,
      query: '',
      engine: args.engine || DEFAULT_ENGINE,
      resultCount: 0,
      results: [],
      text: '',
      length: 0,
      truncated: false,
      error: 'query 必填',
      errorCode: 'INVALID_QUERY'
    };
  }

  if (args.engine && !ENGINE_NAMES.includes(args.engine)) {
    return {
      ok: false,
      query: args.query,
      engine: args.engine,
      resultCount: 0,
      results: [],
      text: '',
      length: 0,
      truncated: false,
      error: `未知搜索引擎：${args.engine}`,
      errorCode: 'INVALID_ENGINE',
      suggestedFix: `可选 engine=${ENGINE_NAMES.join('|')}（默认 ${DEFAULT_ENGINE}）`,
      diagnostics: { engine: args.engine, knownEngines: ENGINE_NAMES }
    };
  }

  const { engine: engineName, url: searchUrl } = buildSearchUrl(args.query, {
    engine: args.engine,
    site: args.site,
    page: args.page
  });
  const engine = resolveEngine(engineName);
  const cacheKey = searchCacheKey(args, engineName);

  if (!args.skipCache) {
    const hit = searchCache.get(cacheKey);
    if (hit) return { ...hit, cached: true };
  }

  const res = await transport.request(searchUrl, { timeoutMs: args.timeoutMs, session: args.session });
  const base = {
    query: args.query,
    engine: engineName,
    searchUrl,
    url: res.url || searchUrl,
    status: res.status || 0,
    contentType: res.contentType || '',
    redirects: res.redirects || 0,
    transport: res.transport || '',
    session: res.session || '',
    resultCount: 0,
    results: [],
    pages: [],
    text: '',
    length: 0,
    truncated: false,
    cached: false
  };

  if (!res.ok) {
    return {
      ...base,
      ok: false,
      errorCode: res.code || 'NETWORK_ERROR',
      retryable: true,
      error: `搜索请求失败：${res.error || '未知网络错误'}`,
      suggestedFix: `网络层不通。${engineName === 'google' || engineName === 'duckduckgo' ? '该引擎国内需代理，建议改用 engine=bing。' : engineListHint(engineName)}`,
      diagnostics: { engine: engineName, searchUrl, status: res.status || 0, transport: res.transport || '' }
    };
  }

  if (res.status === 429) {
    return {
      ...base,
      ok: false,
      errorCode: 'RATE_LIMITED',
      retryable: false,
      error: `引擎限流（HTTP 429）`,
      suggestedFix: `等待一段时间，或换 engine=${ENGINE_NAMES.filter((n) => n !== engineName).join('|')}`,
      diagnostics: { engine: engineName, searchUrl, status: 429 }
    };
  }

  if (res.status >= 400) {
    return {
      ...base,
      ok: false,
      errorCode: 'HTTP_ERROR',
      retryable: res.status >= 500,
      error: `引擎返回 HTTP ${res.status}`,
      suggestedFix: engineListHint(engineName),
      diagnostics: { engine: engineName, searchUrl, status: res.status }
    };
  }

  const head = String(res.body || '').slice(0, 30000);
  if (CAPTCHA_RE.test(head)) {
    return {
      ...base,
      ok: false,
      errorCode: 'BLOCKED_BY_CAPTCHA',
      retryable: false,
      error: '引擎要求验证码/人机验证',
      suggestedFix: `换引擎或稍后重试；${browserFallbackHint(searchUrl)}；不要重复同一 query`,
      diagnostics: { engine: engineName, searchUrl, status: res.status || 0 }
    };
  }

  // 只按「路径退化成首页」判定重定向：引擎改版/地区域名会让 homepage 正则误伤，
  // 但 /、/home、/index、/webhp 一定是被踢回首页了。
  const pagePath = (() => {
    try {
      return new URL(res.url || searchUrl).pathname;
    } catch {
      return '';
    }
  })();
  if (/^\/(?:home|index\.html?|webhp)?$/i.test(pagePath)) {
    return {
      ...base,
      ok: false,
      errorCode: 'REDIRECTED_TO_HOME',
      retryable: false,
      error: `引擎没有返回结果页（被重定向到 ${res.url}），通常是反爬或 cookie 缺失`,
      suggestedFix: `换 engine=${ENGINE_NAMES.filter((n) => n !== engineName).join('|')}，或稍后重试；${browserFallbackHint(searchUrl)}`,
      diagnostics: { engine: engineName, searchUrl, finalUrl: res.url || '', status: res.status || 0 }
    };
  }

  const results = parseSearchResults(res.body || '', engineName, { baseUrl: res.url || searchUrl });
  if (!results.length) {
    return {
      ...base,
      ok: false,
      errorCode: 'SERP_PARSE_FAILED',
      retryable: false,
      error: `页面已取到（${res.bytes || 0} 字节）但未解析出任何结果`,
      suggestedFix: `可能是引擎改版或返回了空结果页。${engineListHint(engineName)}；${browserFallbackHint(searchUrl)}；不要重复同一 query`,
      diagnostics: { engine: engineName, searchUrl, bytes: res.bytes || 0, status: res.status || 0 }
    };
  }

  const pages = args.fetchTop
    ? await fetchTopPages(results, {
        count: args.fetchTop,
        timeoutMs: args.timeoutMs,
        budget: Math.min(TOTAL_PAGE_CHARS, Math.max(args.maxChars - 2000, 2000))
      })
    : [];

  const text = formatResultsText({
    engineLabel: engine.label,
    page: args.page,
    results,
    pages,
    maxChars: args.maxChars
  });

  const payload = {
    ...base,
    ok: true,
    errorCode: '',
    error: '',
    bytes: res.bytes || 0,
    resultCount: results.length,
    results,
    pages,
    text,
    length: text.length,
    truncated: text.length >= args.maxChars,
    // 判「正文已附」要看有没有**真抓到**的正文：fetchTop 全失败（403/超时/反爬）时
    // pages.length 仍非 0，按长度判会让模型以为手上有正文、直接开始编。
    guidance: pages.some((p) => p.ok && p.text)
      ? '正文已附在上面，可直接基于它回答；信息不足再 web_fetch 具体 URL。'
      : '已返回结构化 URL。需要具体推荐/事实核验时，请继续 web_fetch 1-3 个最相关 URL 后再回答。'
  };

  searchCache.set(cacheKey, payload);
  return payload;
}

module.exports = { webSearch, MAX_FETCH_TOP, TOTAL_PAGE_CHARS };
