'use strict';

function joinUrl(base, pathPart, query) {
  const baseClean = String(base || '').replace(/\/+$/, '');
  let path = String(pathPart || '').trim();
  if (!path.startsWith('/')) path = `/${path}`;
  let url = `${baseClean}${path}`;
  if (query && typeof query === 'object' && Object.keys(query).length) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
      if (v != null) qs.append(k, String(v));
    }
    url += `?${qs.toString()}`;
  }
  return url;
}

function activate(ctx) {
  const http = typeof ctx.fetch === 'function' ? ctx.fetch.bind(ctx) : fetch;

  function buildHeaders(extra) {
    const cfg = ctx.readConfig();
    const headers = { Accept: 'application/json', ...extra };
    const name = String(cfg.authHeaderName || '').trim();
    const value = String(cfg.authHeaderValue || '').trim();
    if (name && value) headers[name] = value;
    return headers;
  }

  function request(method, pathPart, { query, body } = {}) {
    const cfg = ctx.readConfig();
    const baseUrl = String(cfg.baseUrl || '').trim();
    if (!baseUrl) {
      const err = new Error('请在插件设置中配置 API 基址');
      err.code = 'HTTP_API_NOT_CONFIGURED';
      throw err;
    }
    const timeoutMs = Math.max(5000, Math.min(120000, Number(cfg.timeoutMs) || 30000));
    const url = joinUrl(baseUrl, pathPart, query);
    const init = {
      method,
      headers: buildHeaders(method === 'POST' ? { 'Content-Type': 'application/json' } : {}),
      signal: AbortSignal.timeout(timeoutMs)
    };
    if (method === 'POST' && body != null) {
      init.body = JSON.stringify(body);
    }
    return http(url, init).then(async (res) => {
      const text = await res.text().catch(() => '');
      let json = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        json = null;
      }
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
      }
      return {
        ok: true,
        status: res.status,
        url,
        body: json != null ? json : text.slice(0, 8000)
      };
    });
  }

  return {
    handleTool(name, args) {
      const a = args || {};
      if (name === 'get') return request('GET', a.path, { query: a.query });
      if (name === 'post') return request('POST', a.path, { body: a.body });
      throw new Error(`未知工具: ${name}`);
    }
  };
}

module.exports = { activate };
