'use strict';

const DEFAULT_MAX_ENTRIES = 500;

/**
 * In-memory ring buffer for browser HTTP(S) requests (HAR-lite).
 */
function createNetworkJournal(opts = {}) {
  const maxEntries = Math.max(50, Number(opts.maxEntries) || DEFAULT_MAX_ENTRIES);
  /** @type {Array<object>} */
  let entries = [];
  let seq = 0;

  function add(partial = {}) {
    seq += 1;
    const entry = {
      id: `net-${seq}`,
      ts: Date.now(),
      method: partial.method || 'GET',
      url: partial.url || '',
      status: partial.status,
      statusText: partial.statusText || '',
      resourceType: partial.resourceType || partial.type || '',
      durationMs: partial.durationMs,
      failed: !!partial.failed,
      error: partial.error ? String(partial.error).slice(0, 200) : undefined,
      engine: partial.engine
    };
    entries.push(entry);
    if (entries.length > maxEntries) entries = entries.slice(-maxEntries);
    return entry;
  }

  function clear() {
    entries = [];
  }

  function list(args = {}) {
    const limit = Math.min(200, Math.max(1, Number(args.limit) || 50));
    const urlPattern = args.urlPattern != null ? String(args.urlPattern) : '';
    const types = args.types
      ? (Array.isArray(args.types) ? args.types : [args.types]).map((t) => String(t).toLowerCase())
      : null;
    let out = entries.slice();
    if (urlPattern) {
      try {
        const re = new RegExp(urlPattern, 'i');
        out = out.filter((e) => re.test(e.url || ''));
      } catch {
        const needle = urlPattern.toLowerCase();
        out = out.filter((e) => String(e.url || '').toLowerCase().includes(needle));
      }
    }
    if (types && types.length) {
      const set = new Set(types);
      out = out.filter((e) => set.has(String(e.resourceType || '').toLowerCase()));
    }
    if (args.errorsOnly) {
      out = out.filter((e) => e.failed || (e.status != null && e.status >= 400));
    }
    if (args.sinceMs) {
      const since = Date.now() - Math.max(0, Number(args.sinceMs) || 0);
      out = out.filter((e) => e.ts >= since);
    }
    return out.slice(-limit);
  }

  function status() {
    const tail = entries.slice(-30);
    const failed = tail.filter((e) => e.failed || (e.status != null && e.status >= 400)).length;
    return { total: entries.length, recentFailed: failed };
  }

  return { add, clear, list, status };
}

function summarizeHarEntries(entries) {
  return {
    count: entries.length,
    entries: entries.map((e) => ({
      id: e.id,
      ts: e.ts,
      method: e.method,
      url: String(e.url || '').slice(0, 500),
      status: e.status,
      statusText: e.statusText,
      resourceType: e.resourceType,
      durationMs: e.durationMs,
      failed: !!e.failed,
      error: e.error
    }))
  };
}

/**
 * 把 HAR-lite 记录转成最小可用的 HAR 1.2（每项含必需字段，附加 `_dieyun` 扩展）。
 * 本记录不含请求/响应头与 body，因此 headersSize/bodySize 以 -1 表示"不可用"。
 * @param {Array<object>} entries
 * @param {{ creatorName?: string, creatorVersion?: string }} [opts]
 */
function toHar(entries, opts = {}) {
  const list = Array.isArray(entries) ? entries : [];
  return {
    log: {
      version: '1.2',
      creator: {
        name: String(opts.creatorName || 'dieyunagent'),
        version: String(opts.creatorVersion || '1')
      },
      pages: [],
      entries: list.map((e) => {
        const duration = Number(e && e.durationMs);
        const wait = Number.isFinite(duration) && duration >= 0 ? duration : 0;
        const status = Number(e && e.status);
        return {
          startedDateTime: new Date((e && e.ts) || Date.now()).toISOString(),
          time: wait,
          request: {
            method: String((e && e.method) || 'GET'),
            url: String((e && e.url) || ''),
            httpVersion: '',
            cookies: [],
            headers: [],
            queryString: [],
            headersSize: -1,
            bodySize: -1
          },
          response: {
            status: Number.isFinite(status) ? status : 0,
            statusText: String((e && e.statusText) || ''),
            httpVersion: '',
            cookies: [],
            headers: [],
            content: { size: 0, mimeType: '' },
            redirectURL: '',
            headersSize: -1,
            bodySize: -1
          },
          cache: {},
          timings: { blocked: -1, dns: -1, connect: -1, ssl: -1, send: 0, wait, receive: 0 },
          _dieyun: {
            engine: String((e && e.engine) || ''),
            resourceType: String((e && e.resourceType) || ''),
            failed: !!(e && e.failed),
            error: e && e.error ? String(e.error) : undefined
          }
        };
      })
    }
  };
}

module.exports = { createNetworkJournal, summarizeHarEntries, toHar };
