'use strict';
/**
 * 联网搜索：引擎解析、显式失败语义、缓存、正文抽取。
 *
 * 守的是三条踩过的坑：
 * 1. 解析 0 条不能退化成「把所有 <a> 当结果」（旧实现会把百度首页/hao123 当搜索结果）；
 * 2. 中文默认引擎必须是可达且能解析的那个（bing），不能是百度；
 * 3. 百度结果真实 URL 在 .result 容器的 mu 属性上，a[href] 只是 /link?url= 跳转链。
 *
 * 夹具 test/fixtures/web/{baidu,bing}-serp.html 是真实搜索页的裁剪版本（保留结果区块）。
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const transport = require('../../src/gateway/web/transport');
const { webSearch } = require('../../src/gateway/web/search');
const { webFetch } = require('../../src/gateway/web/fetch');
const { extractMainContent } = require('../../src/gateway/web/extract');
const { clearWebCaches } = require('../../src/gateway/web/cache');
const {
  parseSearchResults,
  buildSearchUrl,
  DEFAULT_ENGINE
} = require('../../src/gateway/web/engines');

const FIXTURES = path.join(__dirname, '..', 'fixtures', 'web');
const readFixture = (name) => fs.readFileSync(path.join(FIXTURES, name), 'utf8');

const originalRequest = transport.request;

function stubTransport(handler) {
  transport.request = handler;
}

beforeEach(() => {
  clearWebCaches();
  transport.request = originalRequest;
});

afterAll(() => {
  transport.request = originalRequest;
});

describe('搜索引擎注册表', () => {
  it('默认引擎是 bing（可达 + 可解析）', () => {
    assert.equal(DEFAULT_ENGINE, 'bing');
    const built = buildSearchUrl('上海 天气');
    assert.equal(built.engine, 'bing');
    assert.match(built.url, /^https:\/\/cn\.bing\.com\/search\?/);
  });

  it('site 收敛成 site: 语法，page 转成各引擎的翻页参数', () => {
    const bing = buildSearchUrl('electron ipc', { engine: 'bing', site: 'https://github.com/x', page: 2 });
    assert.ok(bing.url.includes('site%3Agithub.com'));
    assert.ok(bing.url.includes('first=11'));

    const baidu = buildSearchUrl('天气', { engine: 'baidu', page: 3 });
    assert.ok(baidu.url.includes('pn=20'));
  });
});

describe('结果解析（真实页面夹具）', () => {
  it('百度：解析出结果，且 URL 已从 /link?url= 跳转链解包', () => {
    const results = parseSearchResults(readFixture('baidu-serp.html'), 'baidu', {
      baseUrl: 'https://www.baidu.com/s?wd=x'
    });
    assert.equal(results.length, 5);
    assert.equal(results[0].rank, 1);
    for (const r of results) {
      assert.ok(r.title.length > 0, '标题不能为空');
      assert.doesNotMatch(r.url, /baidu\.com\/link\?/, `跳转链未解包：${r.url}`);
      assert.match(r.url, /^https?:\/\//);
    }
    assert.equal(results[0].url, 'https://e.weather.com.cn/d/15days/101020100.shtml');
  });

  it('Bing：解析出结果，URL 不指向引擎自身', () => {
    const results = parseSearchResults(readFixture('bing-serp.html'), 'bing', {
      baseUrl: 'https://cn.bing.com/search?q=x'
    });
    assert.equal(results.length, 5);
    for (const r of results) {
      assert.doesNotMatch(r.url, /bing\.com/);
    }
    assert.ok(results[0].url.startsWith('https://'));
  });

  it('拒绝 javascript:/内网 URL（SSRF 白名单同样作用于结果）', () => {
    const html = `<ol><li class="b_algo"><h2><a href="javascript:alert(1)">坏</a></h2></li>
      <li class="b_algo"><h2><a href="http://127.0.0.1/admin">内网</a></h2></li>
      <li class="b_algo"><h2><a href="https://ok.example.com/a">好</a></h2></li></ol>`;
    const results = parseSearchResults(html, 'bing', { baseUrl: 'https://cn.bing.com/search?q=x' });
    assert.equal(results.length, 1);
    assert.equal(results[0].url, 'https://ok.example.com/a');
  });
});

describe('显式失败语义（不允许静默降级）', () => {
  const okBody = (body, url = 'https://cn.bing.com/search?q=x') => ({
    ok: true,
    url,
    status: 200,
    contentType: 'text/html; charset=utf-8',
    redirects: 0,
    bytes: body.length,
    truncatedBody: false,
    body,
    transport: 'test'
  });

  it('页面拿到但没有结果块 → SERP_PARSE_FAILED，且结果为空', async () => {
    stubTransport(async () => okBody('<html><body><div>nothing here</div></body></html>'));
    const res = await webSearch('不会命中的查询-a', { engine: 'bing' });
    assert.equal(res.ok, false);
    assert.equal(res.errorCode, 'SERP_PARSE_FAILED');
    assert.equal(res.resultCount, 0);
    assert.deepEqual(res.results, []);
    assert.match(res.suggestedFix, /换 engine|换更具体/);
  });

  it('被重定向到首页 → REDIRECTED_TO_HOME', async () => {
    stubTransport(async () => okBody('<html><body>home</body></html>', 'https://cn.bing.com/'));
    const res = await webSearch('不会命中的查询-b', { engine: 'bing' });
    assert.equal(res.ok, false);
    assert.equal(res.errorCode, 'REDIRECTED_TO_HOME');
  });

  it('人机验证页 → BLOCKED_BY_CAPTCHA', async () => {
    stubTransport(async () => okBody('<html><body>请输入验证码后继续</body></html>'));
    const res = await webSearch('不会命中的查询-c', { engine: 'baidu' });
    assert.equal(res.ok, false);
    assert.equal(res.errorCode, 'BLOCKED_BY_CAPTCHA');
  });

  it('未知引擎直接报错，不静默回退成默认引擎', async () => {
    const res = await webSearch('任意查询', { engine: 'sogou' });
    assert.equal(res.ok, false);
    assert.equal(res.errorCode, 'INVALID_ENGINE');
    assert.match(res.suggestedFix, /bing/);
  });

  it('HTTP 429 → RATE_LIMITED', async () => {
    stubTransport(async () => ({ ok: true, url: 'https://www.google.com/search?q=x', status: 429, contentType: 'text/html', body: '' }));
    const res = await webSearch('任意查询-d', { engine: 'google' });
    assert.equal(res.ok, false);
    assert.equal(res.errorCode, 'RATE_LIMITED');
  });

  it('网络层失败保留错误码', async () => {
    stubTransport(async () => ({ ok: false, url: 'https://cn.bing.com/search?q=x', status: 0, code: 'NETWORK_ERROR', error: 'fetch failed' }));
    const res = await webSearch('任意查询-e', { engine: 'bing' });
    assert.equal(res.ok, false);
    assert.equal(res.errorCode, 'NETWORK_ERROR');
    assert.match(res.error, /搜索请求失败/);
  });
});

describe('成功路径与缓存', () => {
  it('解析成功时返回结构化结果 + 可复用 guidance', async () => {
    const html = readFixture('bing-serp.html');
    stubTransport(async () => ({
      ok: true,
      url: 'https://cn.bing.com/search?q=x',
      status: 200,
      contentType: 'text/html',
      body: html
    }));
    const res = await webSearch('缓存测试-1', { engine: 'bing' });
    assert.equal(res.ok, true);
    assert.equal(res.resultCount, 5);
    assert.match(res.text, /【结构化搜索结果】/);
    assert.match(res.text, /URL: https:\/\//);
    assert.ok(res.length > 0);
  });

  it('同一 query 第二轮命中缓存，不再出网', async () => {
    let calls = 0;
    stubTransport(async () => {
      calls += 1;
      return { ok: true, url: 'https://cn.bing.com/search?q=x', status: 200, contentType: 'text/html', body: readFixture('bing-serp.html') };
    });
    await webSearch('缓存测试-2', { engine: 'bing' });
    const second = await webSearch('缓存测试-2', { engine: 'bing' });
    assert.equal(calls, 1);
    assert.equal(second.cached, true);
    assert.equal(second.resultCount, 5);
  });

  it('fetchTop 顺手抓正文，正文进 text 与 pages', async () => {
    const serp = readFixture('bing-serp.html');
    const article = `<html><head><title>文章标题</title></head><body>
      <nav><a href="/">首页</a></nav>
      <article><h1>正文标题</h1><p>这是正文第一段，内容足够长以便通过正文阈值判断。</p><p>这是第二段。</p></article>
      <footer>版权所有 © 2026</footer></body></html>`;
    stubTransport(async (url) => {
      if (/bing\.com\/search/.test(url)) {
        return { ok: true, url, status: 200, contentType: 'text/html', body: serp };
      }
      return { ok: true, url, status: 200, contentType: 'text/html', body: article };
    });
    const res = await webSearch('fetchTop 测试', { engine: 'bing', fetchTop: 2 });
    assert.equal(res.ok, true);
    assert.equal(res.pages.length, 2);
    assert.ok(res.pages.every((p) => p.ok));
    assert.match(res.text, /【已抓取页面正文】/);
    assert.match(res.text, /这是正文第一段/);
    assert.doesNotMatch(res.text, /版权所有/);
  });
});

describe('正文抽取', () => {
  it('优先取 article，剔掉导航/页脚', () => {
    const html = `<html><head><title>标题位</title></head><body>
      <nav><a href="/">首页</a><a href="/p">产品</a></nav>
      <div class="sidebar"><a href="/x">侧栏链接</a></div>
      <article><h1>正文标题</h1><p>${'正文内容。'.repeat(40)}</p></article>
      <footer>版权所有</footer></body></html>`;
    const out = extractMainContent(html, { maxChars: 4000 });
    assert.equal(out.mode, 'main');
    assert.equal(out.matched, true);
    assert.equal(out.title, '标题位');
    assert.match(out.text, /正文内容/);
    assert.doesNotMatch(out.text, /首页|侧栏链接|版权所有/);
  });

  it('没有正文容器时回退全页纯文本，不返回空', () => {
    const html = `<html><body><div><p>${'零散文本。'.repeat(30)}</p></div></body></html>`;
    const out = extractMainContent(html, { maxChars: 2000 });
    assert.ok(out.text.length > 100);
    assert.equal(out.mode, 'plain');
  });
});

describe('web_fetch', () => {
  it('HTML 走正文抽取，JSON 原样返回', async () => {
    stubTransport(async (url) => ({
      ok: true,
      url,
      status: 200,
      contentType: url.endsWith('.json') ? 'application/json' : 'text/html',
      body: url.endsWith('.json') ? '{"a":1}' : `<html><body><article><p>${'正文。'.repeat(50)}</p></article></body></html>`
    }));

    const html = await webFetch('https://example.com/page');
    assert.equal(html.ok, true);
    assert.equal(html.mode, 'main');
    assert.match(html.text, /正文/);

    const json = await webFetch('https://example.com/data.json');
    assert.equal(json.ok, true);
    assert.equal(json.mode, 'raw');
    assert.equal(json.text, '{"a":1}');
  });

  it('拒绝内网地址', async () => {
    const res = await webFetch('http://192.168.1.1/');
    assert.equal(res.ok, false);
    assert.equal(res.errorCode, 'URL_NOT_ALLOWED');
  });

  it('401/403 不算成功，且提示改用内置浏览器', async () => {
    stubTransport(async (url) => ({ ok: true, url, status: 403, contentType: 'text/html', body: '<html><body>forbidden</body></html>' }));
    const res = await webFetch('https://example.com/private');
    assert.equal(res.ok, false);
    assert.equal(res.errorCode, 'ACCESS_DENIED');
    assert.match(res.suggestedFix, /browser_navigate/);
  });

  it('browser / default 两条 session 的缓存互不污染', async () => {
    let calls = 0;
    stubTransport(async (url, opts) => {
      calls += 1;
      return {
        ok: true,
        url,
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ via: opts && opts.session })
      };
    });
    const browser = await webFetch('https://example.com/whoami', { session: 'browser' });
    const dflt = await webFetch('https://example.com/whoami', { session: 'default' });
    assert.equal(calls, 2, '两条 session 不能命中同一个缓存条目');
    assert.match(browser.text, /browser/);
    assert.match(dflt.text, /default/);
  });
});
