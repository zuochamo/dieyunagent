'use strict';

/**
 * 抓取传输层：全仓唯一的「出网取字节」实现。
 *
 * 为什么优先 Electron net：
 * Node 内置 fetch（undici）**不读系统代理，也不读 HTTP(S)_PROXY**，
 * 于是「用户开了 Clash 就能上外网」这件事在 fetch 路径上完全不成立
 * （实测 google / duckduckgo 直接 fetch failed，而 Chromium 栈 200）。
 * 本产品是 Electron 应用，系统代理是用户已配置的单一来源，
 * 所以主路径走 net.request，只在纯 Node（单测/CLI）下退回 fetch。
 *
 * session 策略：默认挂在 `persist:dieyun-browser` 分区（与内置浏览器同一个 cookie jar），
 * 这样用户在浏览器里登录过 / 人工过完验证码，搜索与抓取能直接复用；
 * 需要隔离时传 `{ session: 'default' }`。
 */

const { assertSafeUrl } = require('./url-safety');

const MAX_BODY_BYTES = 3 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 60000;
const MAX_REDIRECTS = 5;
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 DieyunAgent/1.4';

function loadElectronNet() {
  try {
    // 纯 Node / ELECTRON_RUN_AS_NODE 下 require('electron') 不可用或无 net
    const electron = require('electron');
    const net = electron && electron.net;
    const app = electron && electron.app;
    if (!net || typeof net.request !== 'function') return null;
    if (app && typeof app.isReady === 'function' && !app.isReady()) return null;
    return net;
  } catch {
    return null;
  }
}

/**
 * 浏览器分区的 session（与内置浏览器共用同一个 cookie jar）。
 *
 * 为什么需要：搜索/抓取原先走 defaultSession，而内置浏览器走
 * `persist:dieyun-browser`，两边 cookie 不互通 —— 人在浏览器里登录过、
 * 或人工过完 Google 验证码，搜索链路一点都借不到。这里把请求挂到浏览器分区上，
 * 才能让「浏览器里能打开」真正传导到 web_search / web_fetch。
 *
 * 分区名的唯一来源仍是 src/browser/session-sync.js，这里只做延迟加载
 * （纯 Node 环境下 session 不存在 → 返回 null，退回 defaultSession）。
 */
function loadBrowserSession() {
  try {
    const electron = require('electron');
    const sessionApi = electron && electron.session;
    if (!sessionApi || typeof sessionApi.fromPartition !== 'function') return null;
    const { BROWSER_SESSION_PARTITION } = require('../../browser/session-sync');
    return sessionApi.fromPartition(BROWSER_SESSION_PARTITION);
  } catch {
    return null;
  }
}

function headerValue(headers, name) {
  if (!headers) return '';
  const raw = headers[name] || headers[name.toLowerCase()] || headers[name.toUpperCase()];
  if (Array.isArray(raw)) return String(raw[0] || '');
  return raw == null ? '' : String(raw);
}

function normalizeCharset(charset) {
  const c = String(charset || '').trim().toLowerCase();
  if (!c) return '';
  if (c === 'gb2312' || c === 'gbk' || c === 'gb18030' || c === 'x-gbk') return 'gb18030';
  return c;
}

function decodeBody(buf, contentType) {
  let charset = normalizeCharset(/charset\s*=\s*["']?([\w-]+)/i.exec(contentType || '')?.[1]);
  if (!charset) {
    const head = buf.subarray(0, 4096).toString('latin1');
    charset = normalizeCharset(/<meta[^>]+charset\s*=\s*["']?([\w-]+)/i.exec(head)?.[1]);
  }
  if (!charset || charset === 'utf-8' || charset === 'utf8') return buf.toString('utf8');
  try {
    return new TextDecoder(charset).decode(buf);
  } catch {
    return buf.toString('utf8');
  }
}

function failResult(url, code, error, extra = {}) {
  return { ok: false, url, status: 0, code, error, ...extra };
}

/**
 * Electron net 实现：跟随重定向时逐跳做 SSRF 校验（与 fetch 路径同规则）。
 */
function requestViaNet(net, url, { timeoutMs, maxBytes, session, sessionMode }) {
  return new Promise((resolve) => {
    let req;
    try {
      req = net.request({
        url,
        method: 'GET',
        redirect: 'manual',
        session: session || undefined,
        // 必须显式 include：net.request 默认 omit cookie，
        // 光传 session 不会带浏览器分区里的登录态/反爬凭证（实测 httpbin 回显为空）。
        credentials: 'include',
        headers: {
          'User-Agent': USER_AGENT,
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,application/json;q=0.9,*/*;q=0.8',
          'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8'
        }
      });
    } catch (err) {
      resolve(failResult(url, 'TRANSPORT_INIT', err.message));
      return;
    }

    let settled = false;
    let redirects = 0;
    let finalUrl = url;
    const timer = setTimeout(() => finish(failResult(finalUrl, 'TIMEOUT', '请求超时', { redirects })), timeoutMs);

    function finish(value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        req.abort();
      } catch {
        /* already gone */
      }
      resolve(value);
    }

    req.on('redirect', (_status, _method, redirectUrl) => {
      if (redirects >= MAX_REDIRECTS) {
        finish(failResult(finalUrl, 'TOO_MANY_REDIRECTS', '重定向次数过多', { redirects }));
        return;
      }
      try {
        finalUrl = assertSafeUrl(new URL(redirectUrl, finalUrl).href);
      } catch (err) {
        finish(failResult(finalUrl, err.code || 'URL_NOT_ALLOWED', err.message, { redirects }));
        return;
      }
      redirects += 1;
      try {
        req.followRedirect();
      } catch (err) {
        finish(failResult(finalUrl, 'REDIRECT_FAILED', err.message, { redirects }));
      }
    });

    req.on('response', (res) => {
      const status = Number(res.statusCode) || 0;
      const contentType = headerValue(res.headers, 'content-type');
      const chunks = [];
      let bytes = 0;
      let truncatedBody = false;

      res.on('data', (chunk) => {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytes += buf.length;
        if (bytes > maxBytes) {
          truncatedBody = true;
          finish({
            ok: true,
            url: finalUrl,
            status,
            contentType,
            redirects,
            bytes,
            truncatedBody,
            body: decodeBody(Buffer.concat(chunks), contentType),
            transport: 'electron-net',
            session: sessionMode || 'default'
          });
          return;
        }
        chunks.push(buf);
      });
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        finish({
          ok: true,
          url: finalUrl,
          status,
          contentType,
          redirects,
          bytes: buf.length,
          truncatedBody,
          body: decodeBody(buf, contentType),
          transport: 'electron-net',
          session: sessionMode || 'default'
        });
      });
      res.on('error', (err) => finish(failResult(finalUrl, 'RESPONSE_ERROR', err.message, { status, redirects })));
    });

    req.on('error', (err) => {
      const code = err && err.code ? String(err.code) : 'NETWORK_ERROR';
      finish(failResult(finalUrl, code, (err && err.message) || String(err), { redirects }));
    });

    req.end();
  });
}

/**
 * global fetch 实现：纯 Node 环境（单测 / CLI）用。
 * 逐跳校验重定向，与 net 路径保持同一安全语义。
 */
async function requestViaFetch(url, { timeoutMs, maxBytes }) {
  let current = url;
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
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,application/json;q=0.9,*/*;q=0.8',
          'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8'
        }
      });

      if (resp.status >= 300 && resp.status < 400) {
        const loc = resp.headers.get('location');
        if (!loc) return failResult(current, 'REDIRECT_NO_LOCATION', '重定向缺少 Location', { status: resp.status, redirects });
        if (redirects >= MAX_REDIRECTS) {
          return failResult(current, 'TOO_MANY_REDIRECTS', '重定向次数过多', { status: resp.status, redirects });
        }
        redirects += 1;
        current = assertSafeUrl(new URL(loc, current).href);
        continue;
      }

      const contentType = resp.headers.get('content-type') || '';
      const buf = Buffer.from(await resp.arrayBuffer());
      const truncatedBody = buf.length > maxBytes;
      const clipped = truncatedBody ? buf.subarray(0, maxBytes) : buf;
      return {
        ok: true,
        url: current,
        status: resp.status,
        contentType,
        redirects,
        bytes: buf.length,
        truncatedBody,
        body: decodeBody(clipped, contentType),
        transport: 'fetch',
        session: 'none'
      };
    } catch (err) {
      if (err.name === 'AbortError') return failResult(current, 'TIMEOUT', '请求超时', { redirects });
      if (err.code === 'URL_NOT_ALLOWED' || err.code === 'INVALID_URL') {
        return failResult(current, err.code, err.message, { redirects });
      }
      const cause = err.cause && (err.cause.code || err.cause.message);
      return failResult(current, 'NETWORK_ERROR', cause ? `${err.message} (${cause})` : err.message, { redirects });
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * @param {string} rawUrl
 * @param {{ timeoutMs?: number, maxBytes?: number }} [opts]
 */
async function request(rawUrl, opts = {}) {
  let url;
  try {
    url = assertSafeUrl(rawUrl);
  } catch (err) {
    return failResult(String(rawUrl || ''), err.code || 'INVALID_URL', err.message);
  }
  const timeoutMs = Math.max(3000, Math.min(120000, Number(opts.timeoutMs) || DEFAULT_TIMEOUT_MS));
  const maxBytes = Math.max(64 * 1024, Math.min(MAX_BODY_BYTES, Number(opts.maxBytes) || MAX_BODY_BYTES));

  const net = loadElectronNet();
  if (net) {
    // 默认借用内置浏览器分区的 cookie（登录态 / 人工过验证码后的凭证）：
    // 这是「浏览器里能打开、搜索链路却被拦」的唯一解法。opts.session='default'
    // 是诊断逃生口（怀疑 cookie 污染某站点时用）。
    const browserSession = opts.session === 'default' ? null : loadBrowserSession();
    return requestViaNet(net, url, {
      timeoutMs,
      maxBytes,
      session: browserSession,
      sessionMode: browserSession ? 'browser' : 'default'
    });
  }
  return requestViaFetch(url, { timeoutMs, maxBytes });
}

/** 当前会走哪条传输（诊断用；不触发请求）。 */
function activeTransport() {
  return loadElectronNet() ? 'electron-net' : 'fetch';
}

module.exports = {
  request,
  activeTransport,
  DEFAULT_TIMEOUT_MS};
