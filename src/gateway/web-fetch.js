'use strict';

const { URL } = require('url');

const MAX_BODY_BYTES = 512 * 1024;
const DEFAULT_TIMEOUT_MS = 60000;
const MAX_REDIRECTS = 5;
const DEFAULT_MAX_CHARS = 12000;
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 DieyunAgent/1.3';

const SEARCH_ENGINES = {
  baidu: (q) => `https://www.baidu.com/s?wd=${encodeURIComponent(q)}`,
  bing: (q) => `https://cn.bing.com/search?q=${encodeURIComponent(q)}`,
  bing_int: (q) => `https://cn.bing.com/search?q=${encodeURIComponent(q)}&ensearch=1`,
  google: (q) => `https://www.google.com/search?q=${encodeURIComponent(q)}`,
  duckduckgo: (q) => `https://duckduckgo.com/html/?q=${encodeURIComponent(q)}`
};

function isPrivateIpv4(host) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const a = m.slice(1).map(Number);
  if (a.some((n) => n > 255)) return true;
  if (a[0] === 10) return true;
  if (a[0] === 127) return true;
  if (a[0] === 0) return true;
  if (a[0] === 169 && a[1] === 254) return true;
  if (a[0] === 172 && a[1] >= 16 && a[1] <= 31) return true;
  if (a[0] === 192 && a[1] === 168) return true;
  return false;
}

function assertSafeUrl(rawUrl) {
  let u;
  try {
    u = new URL(String(rawUrl || '').trim());
  } catch {
    const err = new Error('URL 无效');
    err.code = 'INVALID_URL';
    throw err;
  }
  if (!['http:', 'https:'].includes(u.protocol)) {
    const err = new Error('仅允许 http/https');
    err.code = 'URL_NOT_ALLOWED';
    throw err;
  }
  const host = (u.hostname || '').toLowerCase();
  if (!host) {
    const err = new Error('缺少主机名');
    err.code = 'URL_NOT_ALLOWED';
    throw err;
  }
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host === '0.0.0.0' ||
    host === '[::1]' ||
    host === '::1'
  ) {
    const err = new Error('不允许访问本地地址');
    err.code = 'URL_NOT_ALLOWED';
    throw err;
  }
  if (isPrivateIpv4(host)) {
    const err = new Error('不允许访问内网 IP');
    err.code = 'URL_NOT_ALLOWED';
    throw err;
  }
  if (host === '169.254.169.254' || host === 'metadata.google.internal') {
    const err = new Error('不允许访问元数据地址');
    err.code = 'URL_NOT_ALLOWED';
    throw err;
  }
  const port = u.port ? Number(u.port) : u.protocol === 'https:' ? 443 : 80;
  if (![80, 443].includes(port)) {
    const err = new Error('仅允许 80/443 端口');
    err.code = 'URL_NOT_ALLOWED';
    throw err;
  }
  return u.href;
}

function htmlToText(html) {
  let s = String(html || '');
  s = s.replace(/<script[\s\S]*?<\/script>/gi, ' ');
  s = s.replace(/<style[\s\S]*?<\/style>/gi, ' ');
  s = s.replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ');
  s = s.replace(/<!--[\s\S]*?-->/g, ' ');
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<\/(p|div|h[1-6]|li|tr|section|article)>/gi, '\n');
  s = s.replace(/<[^>]+>/g, ' ');
  s = s
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
  s = s.replace(/[ \t\f\v]+/g, ' ');
  s = s.replace(/\n[ \t]+/g, '\n');
  s = s.replace(/\n{3,}/g, '\n\n');
  return s.trim();
}

function decodeHtmlEntities(text) {
  let s = String(text || '');
  s = s
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
  s = s.replace(/&#(\d+);/g, (_m, n) => {
    const code = Number(n);
    return Number.isFinite(code) ? String.fromCodePoint(code) : '';
  });
  s = s.replace(/&#x([0-9a-f]+);/gi, (_m, n) => {
    const code = parseInt(n, 16);
    return Number.isFinite(code) ? String.fromCodePoint(code) : '';
  });
  return s;
}

function cleanText(text) {
  return decodeHtmlEntities(htmlToText(text)).replace(/\s+/g, ' ').trim();
}

function extractAttr(tag, attr) {
  const re = new RegExp(`${attr}\\s*=\\s*["']([^"']+)["']`, 'i');
  const m = re.exec(String(tag || ''));
  return m ? decodeHtmlEntities(m[1]) : '';
}

function resolveSearchResultUrl(rawHref, baseUrl, engine) {
  if (!rawHref) return '';
  let href = decodeHtmlEntities(String(rawHref || '').trim());
  try {
    href = new URL(href, baseUrl).href;
  } catch {
    return '';
  }
  try {
    const u = new URL(href);
    if (engine === 'google' && u.pathname === '/url' && u.searchParams.get('q')) {
      return assertSafeUrl(u.searchParams.get('q'));
    }
    if (engine === 'duckduckgo' && u.searchParams.get('uddg')) {
      return assertSafeUrl(u.searchParams.get('uddg'));
    }
    return assertSafeUrl(href);
  } catch {
    return '';
  }
}

function dedupeSearchResults(results) {
  const seen = new Set();
  const out = [];
  for (const item of results || []) {
    const url = item && item.url ? String(item.url) : '';
    const title = item && item.title ? String(item.title) : '';
    if (!url || !title) continue;
    const key = url.replace(/#.*$/, '');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      rank: out.length + 1,
      title: title.slice(0, 180),
      url,
      snippet: String(item.snippet || '').slice(0, 360)
    });
    if (out.length >= 10) break;
  }
  return out;
}

function extractAround(html, start, end, fallbackLen = 1000) {
  const s = Math.max(0, start);
  const e = end > s ? end : Math.min(html.length, s + fallbackLen);
  return html.slice(s, e);
}

function extractSearchResults(html, engine, baseUrl) {
  const source = String(html || '');
  const results = [];

  if (engine === 'bing' || engine === 'bing_int') {
    const blockRe = /<li\b[^>]*class=["'][^"']*\bb_algo\b[^"']*["'][\s\S]*?<\/li>/gi;
    let m;
    while ((m = blockRe.exec(source))) {
      const block = m[0];
      const a = /<h2\b[^>]*>\s*<a\b([^>]*)>([\s\S]*?)<\/a>\s*<\/h2>/i.exec(block) ||
        /<a\b([^>]*)>([\s\S]*?)<\/a>/i.exec(block);
      if (!a) continue;
      const url = resolveSearchResultUrl(extractAttr(a[1], 'href'), baseUrl, engine);
      const title = cleanText(a[2]);
      const p = /<p\b[^>]*>([\s\S]*?)<\/p>/i.exec(block);
      results.push({ title, url, snippet: p ? cleanText(p[1]) : '' });
    }
  } else if (engine === 'duckduckgo') {
    const blockRe = /<div\b[^>]*class=["'][^"']*\bresult\b[^"']*["'][\s\S]*?(?=<div\b[^>]*class=["'][^"']*\bresult\b|<\/body>)/gi;
    let m;
    while ((m = blockRe.exec(source))) {
      const block = m[0];
      const a = /<a\b([^>]*)class=["'][^"']*\bresult__a\b[^"']*["'][^>]*>([\s\S]*?)<\/a>/i.exec(block) ||
        /<a\b([^>]*)>([\s\S]*?)<\/a>/i.exec(block);
      if (!a) continue;
      const url = resolveSearchResultUrl(extractAttr(a[1], 'href'), baseUrl, engine);
      const title = cleanText(a[2]);
      const sn = /<a\b[^>]*class=["'][^"']*\bresult__snippet\b[^"']*["'][^>]*>([\s\S]*?)<\/a>/i.exec(block) ||
        /<div\b[^>]*class=["'][^"']*\bresult__snippet\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/i.exec(block);
      results.push({ title, url, snippet: sn ? cleanText(sn[1]) : '' });
    }
  } else if (engine === 'baidu') {
    const headingRe = /<h3\b[^>]*>\s*<a\b([^>]*)>([\s\S]*?)<\/a>\s*<\/h3>/gi;
    let m;
    while ((m = headingRe.exec(source))) {
      const url = resolveSearchResultUrl(extractAttr(m[1], 'href'), baseUrl, engine);
      const title = cleanText(m[2]);
      const nextHeading = source.slice(headingRe.lastIndex).search(/<h3\b/i);
      const end = nextHeading >= 0 ? headingRe.lastIndex + nextHeading : headingRe.lastIndex + 1200;
      const block = extractAround(source, headingRe.lastIndex, end);
      const snippet = cleanText(block).replace(title, '').trim();
      results.push({ title, url, snippet });
    }
  } else if (engine === 'google') {
    const headingRe = /<a\b([^>]*)>\s*<h3\b[^>]*>([\s\S]*?)<\/h3>\s*<\/a>/gi;
    let m;
    while ((m = headingRe.exec(source))) {
      const url = resolveSearchResultUrl(extractAttr(m[1], 'href'), baseUrl, engine);
      const title = cleanText(m[2]);
      const nextHeading = source.slice(headingRe.lastIndex).search(/<a\b[^>]*>\s*<h3\b/i);
      const end = nextHeading >= 0 ? headingRe.lastIndex + nextHeading : headingRe.lastIndex + 1000;
      const snippet = cleanText(extractAround(source, headingRe.lastIndex, end)).replace(title, '').trim();
      results.push({ title, url, snippet });
    }
  }

  if (!results.length) {
    const genericA = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
    let m;
    while ((m = genericA.exec(source))) {
      const url = resolveSearchResultUrl(extractAttr(m[1], 'href'), baseUrl, engine);
      const title = cleanText(m[2]);
      if (url && title.length >= 4 && !/^(网页|图片|视频|地图|新闻|更多|登录|下一页)$/i.test(title)) {
        results.push({ title, url, snippet: '' });
      }
      if (results.length >= 20) break;
    }
  }

  return dedupeSearchResults(results);
}

function detectSearchBlockers(text) {
  const t = String(text || '');
  if (/验证码|安全验证|异常流量|verify|captcha/i.test(t)) return '搜索页要求验证码或安全验证';
  if (/登录后|请登录|sign in|login/i.test(t)) return '页面要求登录';
  return '';
}

function formatStructuredSearchText(fetched, results, blocker) {
  const lines = [];
  lines.push('【结构化搜索结果】');
  if (blocker) lines.push(`提示：${blocker}`);
  if (!results.length) {
    lines.push('未提取到可直接抓取的搜索结果 URL。请换搜索引擎或换关键词；不要重复同一关键词。');
  } else {
    for (const r of results) {
      lines.push(`${r.rank}. ${r.title}`);
      lines.push(`URL: ${r.url}`);
      if (r.snippet) lines.push(`摘要: ${r.snippet}`);
    }
    lines.push('建议：需要做推荐、事实核验或引用具体信息时，下一步用 web_fetch 抓取上面 1-3 个最相关 URL。');
  }
  const pageText = String(fetched.text || '').trim();
  if (pageText) {
    lines.push('\n【搜索页正文摘录】');
    lines.push(pageText);
  }
  return lines.join('\n');
}

function truncateText(text, maxChars) {
  const limit = Math.max(500, Math.min(32000, Number(maxChars) || DEFAULT_MAX_CHARS));
  const t = String(text || '');
  if (t.length <= limit) return { text: t, truncated: false };
  return { text: `${t.slice(0, limit)}…`, truncated: true };
}

async function fetchWithRedirects(startUrl, opts = {}) {
  const timeoutMs = Math.max(3000, Math.min(120000, Number(opts.timeoutMs) || DEFAULT_TIMEOUT_MS));
  let current = assertSafeUrl(startUrl);
  let redirects = 0;

  while (true) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const resp = await fetch(current, {
        method: 'GET',
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          'User-Agent': USER_AGENT,
          Accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8',
          'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8'
        }
      });

      if (resp.status >= 300 && resp.status < 400) {
        const loc = resp.headers.get('location');
        if (!loc) {
          return { ok: false, url: current, status: resp.status, error: '重定向缺少 Location' };
        }
        if (redirects >= MAX_REDIRECTS) {
          return { ok: false, url: current, status: resp.status, error: '重定向次数过多' };
        }
        redirects += 1;
        current = assertSafeUrl(new URL(loc, current).href);
        continue;
      }

      if (!resp.ok) {
        return {
          ok: false,
          url: current,
          status: resp.status,
          error: `HTTP ${resp.status}`
        };
      }

      const buf = Buffer.from(await resp.arrayBuffer());
      const clipped =
        buf.length > MAX_BODY_BYTES ? buf.subarray(0, MAX_BODY_BYTES) : buf;
      const contentType = resp.headers.get('content-type') || '';
      let raw = clipped.toString('utf8');
      if (!contentType.includes('text') && !contentType.includes('html') && !contentType.includes('json')) {
        return {
          ok: false,
          url: current,
          status: resp.status,
          error: `不支持的内容类型: ${contentType.slice(0, 80)}`
        };
      }

      const isHtml = /html/i.test(contentType) || /<html/i.test(raw);
      const text = isHtml ? htmlToText(raw) : raw;
      const { text: body, truncated } = truncateText(text, opts.maxChars);

      const result = {
        ok: true,
        url: current,
        status: resp.status,
        contentType,
        redirects,
        truncated,
        length: body.length,
        text: body
      };
      if (opts.includeRawHtml) result.rawHtml = raw;
      return result;
    } catch (err) {
      if (err.name === 'AbortError') {
        return { ok: false, url: current, error: '请求超时' };
      }
      if (err.code === 'URL_NOT_ALLOWED' || err.code === 'INVALID_URL') {
        return { ok: false, url: current, error: err.message };
      }
      return { ok: false, url: current, error: err.message || String(err) };
    } finally {
      clearTimeout(timer);
    }
  }
}

function pickDefaultEngine(query) {
  return /[\u4e00-\u9fff]/.test(String(query || '')) ? 'baidu' : 'bing';
}

function buildSearchUrl(query, engine) {
  const q = String(query || '').trim();
  if (!q) throw new Error('query 必填');
  const eng = String(engine || pickDefaultEngine(q)).toLowerCase();
  const fn = SEARCH_ENGINES[eng] || SEARCH_ENGINES[pickDefaultEngine(q)];
  return { engine: eng in SEARCH_ENGINES ? eng : pickDefaultEngine(q), url: fn(q) };
}

async function webSearch(query, engine, opts = {}) {
  const { engine: used, url } = buildSearchUrl(query, engine);
  const fetched = await fetchWithRedirects(url, { ...opts, includeRawHtml: true });
  const rawHtml = fetched.rawHtml || '';
  delete fetched.rawHtml;
  const results = fetched.ok ? extractSearchResults(rawHtml, used, fetched.url || url) : [];
  const blocker = detectSearchBlockers(fetched.text || fetched.error || '');
  const text = fetched.ok ? formatStructuredSearchText(fetched, results, blocker) : fetched.text;
  const { text: body, truncated } = truncateText(text, opts.maxChars);
  return {
    ...fetched,
    text: body,
    length: body ? body.length : 0,
    truncated: !!(fetched.truncated || truncated),
    query: String(query || '').trim(),
    engine: used,
    searchUrl: url,
    resultCount: results.length,
    results,
    guidance: results.length
      ? '已返回结构化 URL。需要具体推荐/事实核验时，请继续 web_fetch 1-3 个最相关 URL 后再回答。'
      : '没有提取到可抓取 URL；请换搜索引擎或更具体关键词，避免重复同一搜索。'
  };
}

module.exports = {
  assertSafeUrl,
  htmlToText,
  fetchWithRedirects,
  buildSearchUrl,
  webSearch,
  SEARCH_ENGINES
};
