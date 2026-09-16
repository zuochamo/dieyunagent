'use strict';

/** 列表类工具默认截断条数，避免撑爆 Agent 上下文 */
const DEFAULT_LIST_LIMIT = 50;

const SERVICES = Object.freeze({
  daizhang: {
    label: '叠云代账',
    urlEnv: 'DAIZHANG_API_URL',
    keyEnv: 'DAIZHANG_API_KEY',
    defaultUrl: 'http://192.168.31.62:3011/api/open-api/v1',
    enableHint: '设置 → 对外接口'
  },
  tools: {
    label: '叠云Tools',
    urlEnv: 'TOOLS_API_URL',
    keyEnv: 'TOOLS_API_KEY',
    defaultUrl: 'http://192.168.31.62:5000/api/open-api/v1',
    enableHint: '右上角齿轮 → 对外接口（root 可见）'
  },
  index: {
    label: '叠云Index',
    urlEnv: 'INDEX_API_URL',
    keyEnv: 'INDEX_API_KEY',
    defaultUrl: 'http://192.168.31.62:5018/api/open-api/v1',
    enableHint: '导航页右侧设置抽屉 → 对外接口'
  },
  pixel: {
    label: 'PixelOfficeMonitor',
    urlEnv: 'PIXEL_API_URL',
    keyEnv: 'PIXEL_API_KEY',
    defaultUrl: 'http://192.168.31.62:3003/api/open-api/v1',
    enableHint: 'http://192.168.31.62:3003/open-api.html'
  }
});

/**
 * @param {string} service
 * @returns {typeof SERVICES[keyof typeof SERVICES]}
 */
function getServiceConfig(service) {
  const cfg = SERVICES[service];
  if (!cfg) throw new Error(`未知服务：${service}`);
  return cfg;
}

/**
 * @param {string} service
 * @param {NodeJS.ProcessEnv} [env]
 */
function resolveServiceEndpoint(service, env = process.env) {
  const cfg = getServiceConfig(service);
  const baseUrl = String(env[cfg.urlEnv] || cfg.defaultUrl || '')
    .trim()
    .replace(/\/+$/, '');
  const apiKey = String(env[cfg.keyEnv] || '').trim();
  return { cfg, baseUrl, apiKey };
}

/**
 * @param {Record<string, unknown>} [params]
 * @param {number} [limit]
 */
function truncateListPayload(data, limit = DEFAULT_LIST_LIMIT) {
  if (!data || typeof data !== 'object') return { data, truncated: false };
  const max = Math.max(1, Number(limit) || DEFAULT_LIST_LIMIT);

  if (Array.isArray(data)) {
    if (data.length <= max) return { data, truncated: false };
    return {
      data: data.slice(0, max),
      total: data.length,
      truncated: true,
      returned: max,
      note: `仅返回前 ${max} 条（共 ${data.length} 条）`
    };
  }

  if (Array.isArray(data.items)) {
    const total = Number.isFinite(Number(data.total)) ? Number(data.total) : data.items.length;
    if (data.items.length <= max) {
      // 摘要字段必须排在明细之前：明细很长时下游只保留 JSON 头部，排末尾的字段会被整段截掉
      return { data: { total, ...data }, truncated: false };
    }
    const rest = { ...data };
    delete rest.items;
    return {
      data: {
        total,
        ...rest,
        truncated: true,
        returned: max,
        note: `仅返回前 ${max} 条（共 ${total} 条），请缩小查询条件`,
        items: data.items.slice(0, max)
      },
      truncated: true
    };
  }

  if (Array.isArray(data.bookmarks)) {
    const total = Number.isFinite(Number(data.total)) ? Number(data.total) : data.bookmarks.length;
    if (data.bookmarks.length <= max) {
      // 与 items 分支保持一致：未截断时也补 total，否则「一共有多少条」只能靠模型自己数
      return { data: { total, ...data }, truncated: false };
    }
    const rest = { ...data };
    delete rest.bookmarks;
    return {
      data: {
        total,
        ...rest,
        truncated: true,
        returned: max,
        note: `仅返回前 ${max} 条书签（共 ${total} 条）`,
        bookmarks: data.bookmarks.slice(0, max)
      },
      truncated: true
    };
  }

  // 兜底：其它字段名的列表（sections / computers / customers / invoices …）同样要截断。
  // 早前只认 items / bookmarks，其余字段的超大数组会整包进入上下文。
  let biggestKey = '';
  let biggestLen = 0;
  for (const [key, value] of Object.entries(data)) {
    if (!Array.isArray(value) || value.length <= max) continue;
    if (value.length > biggestLen) {
      biggestKey = key;
      biggestLen = value.length;
    }
  }
  if (biggestKey) {
    const rawTotal = Number(data.total);
    const total = Number.isFinite(rawTotal) ? rawTotal : biggestLen;
    const rest = { ...data };
    delete rest[biggestKey];
    return {
      data: {
        total,
        ...rest,
        truncated: true,
        returned: max,
        note: `仅返回前 ${max} 条（共 ${total} 条）`,
        [biggestKey]: data[biggestKey].slice(0, max)
      },
      truncated: true
    };
  }

  return { data, truncated: false };
}

/**
 * @param {string} service
 * @param {string} apiPath
 * @param {Record<string, string|number|boolean|undefined|null>} [params]
 * @param {{ env?: NodeJS.ProcessEnv, fetchImpl?: typeof fetch, listLimit?: number }} [opts]
 */
async function callApi(service, apiPath, params = {}, opts = {}) {
  const env = opts.env || process.env;
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new Error('当前运行时不支持 fetch');
  }

  const { cfg, baseUrl, apiKey } = resolveServiceEndpoint(service, env);
  if (!baseUrl) {
    throw new Error(`${cfg.label} 未配置 Base URL（环境变量 ${cfg.urlEnv}）`);
  }
  if (!apiKey) {
    throw new Error(
      `${cfg.label} 缺少 API Key。请设置环境变量 ${cfg.keyEnv}（或在 MCP 凭据中写入同名变量）。`
    );
  }

  const pathPart = String(apiPath || '').startsWith('/') ? String(apiPath) : `/${apiPath || ''}`;
  const url = new URL(`${baseUrl}${pathPart}`);
  for (const [key, value] of Object.entries(params || {})) {
    if (value == null || value === '') continue;
    url.searchParams.set(key, String(value));
  }

  let response;
  try {
    response = await fetchImpl(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'X-API-Key': apiKey
      }
    });
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    throw new Error(`${cfg.label} 请求失败：${msg}（${url.origin}）`);
  }

  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }

  if (response.status === 401) {
    throw new Error(`${cfg.label} 鉴权失败（UNAUTHORIZED）。请检查 ${cfg.keyEnv} 是否正确或已轮换。`);
  }
  if (response.status === 403) {
    throw new Error(
      `${cfg.label} Open API 已关闭（OPEN_API_DISABLED）。请到对应设置页打开开关：${cfg.enableHint}`
    );
  }
  if (!response.ok) {
    const code = body && body.code ? String(body.code) : '';
    const errMsg =
      (body && (body.error || body.message)) || text.slice(0, 300) || response.statusText || '请求失败';
    throw new Error(`${cfg.label} HTTP ${response.status}${code ? ` ${code}` : ''}：${errMsg}`);
  }

  if (body && typeof body === 'object' && body.ok === false) {
    const errMsg = body.error || body.message || 'ok=false';
    throw new Error(`${cfg.label} 返回错误：${errMsg}`);
  }

  const payload = body && typeof body === 'object' && 'data' in body ? body.data : body;
  const { data } = truncateListPayload(payload, opts.listLimit);
  return {
    ok: true,
    service,
    path: pathPart,
    ts: body && body.ts ? body.ts : new Date().toISOString(),
    data
  };
}

module.exports = {
  DEFAULT_LIST_LIMIT,
  SERVICES,
  getServiceConfig,
  resolveServiceEndpoint,
  truncateListPayload,
  callApi
};
