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
 * `total` 是否真的是「行数」语义。
 *
 * 后端并不统一：`/invoices` 的 `total` 是行数，而 `/tax/burden` 的 `total`
 * 是一整个期间汇总对象（销售额/应纳/税负率…）。早前这里无条件
 * `total = items.length`，一旦税负区间超过 50 个月触发裁剪，汇总对象就会被
 * 覆盖成一个数字 —— Agent 拿到的「总应纳增值税」直接消失。所以只在 `total`
 * 本来就是数字（或数字字符串）时才前置/改写，否则原样留给 `...rest` 带出去。
 *
 * @param {unknown} raw
 * @returns {boolean}
 */
function isNumericTotal(raw) {
  if (typeof raw === 'number') return Number.isFinite(raw);
  if (typeof raw === 'string') return raw.trim() !== '' && Number.isFinite(Number(raw));
  return false;
}

/**
 * 算出「本次可前置到 JSON 头部的 total 数值」。
 *
 * - 缺失（undefined / null）→ 用数组长度兜底（保持「没给的话模型自己数不清」的旧行为）
 * - 数字 / 数字字符串 → 原值
 * - 其它（对象等）→ 返回 null，表示**不许改写**，原样留给 `...data` 带出去
 *
 * @param {unknown} rawTotal
 * @param {number} fallback
 * @returns {number|null}
 */
function resolvePayloadTotal(rawTotal, fallback) {
  if (rawTotal === undefined || rawTotal === null) return fallback;
  return isNumericTotal(rawTotal) ? Number(rawTotal) : null;
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
    const numericTotal = resolvePayloadTotal(data.total, data.items.length);
    if (data.items.length <= max) {
      // 摘要字段必须排在明细之前：明细很长时下游只保留 JSON 头部，排末尾的字段会被整段截掉
      return {
        data: { ...(numericTotal == null ? {} : { total: numericTotal }), ...data },
        truncated: false
      };
    }
    const rest = { ...data };
    delete rest.items;
    const total = numericTotal == null ? data.items.length : numericTotal;
    return {
      data: {
        ...(numericTotal == null ? {} : { total: numericTotal }),
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
    const numericTotal = resolvePayloadTotal(data.total, data.bookmarks.length);
    if (data.bookmarks.length <= max) {
      // 与 items 分支保持一致：未截断时也补 total，否则「一共有多少条」只能靠模型自己数
      return {
        data: {
          ...(numericTotal == null ? {} : { total: numericTotal }),
          ...data
        },
        truncated: false
      };
    }
    const rest = { ...data };
    delete rest.bookmarks;
    const total = numericTotal == null ? data.bookmarks.length : numericTotal;
    return {
      data: {
        ...(numericTotal == null ? {} : { total: numericTotal }),
        ...rest,
        truncated: true,
        returned: max,
        note: `仅返回前 ${max} 条书签（共 ${total} 条）`,
        bookmarks: data.bookmarks.slice(0, max)
      },
      truncated: true
    };
  }

  // 兜底：其它字段名的列表（sections / computers / customers / months …）同样要截断。
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
    const numericTotal = resolvePayloadTotal(data.total, biggestLen);
    const total = numericTotal == null ? biggestLen : numericTotal;
    const rest = { ...data };
    delete rest[biggestKey];
    return {
      data: {
        ...(numericTotal == null ? {} : { total: numericTotal }),
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
 * 出参截断上限的唯一解析口径。
 *
 * 优先级：显式 `opts.listLimit` > 本次请求的 `params.pageSize` > `DEFAULT_LIST_LIMIT`。
 *
 * 为什么必须让 `pageSize` 参与：调用方已经明确要了 N 条，后端也按 N 条返回，
 * 再在本地按 50 二次裁剪就是「schema 说能拿 51、实际只给 50」，且 `truncated`
 * 会被伪造为 true —— 调用方以为还有下一页，逐页翻却永远差一截。这条曾经真实存在：
 * `list_invoices({ pageSize: 51 })` 返回 50。
 *
 * @param {Record<string, unknown>} [params]
 * @param {number} [explicitLimit]
 * @returns {number|undefined} undefined 表示交给 `truncateListPayload` 用默认值
 */
function resolveListLimit(params, explicitLimit) {
  if (Number.isFinite(Number(explicitLimit)) && Number(explicitLimit) > 0) {
    return Math.floor(Number(explicitLimit));
  }
  const fromPageSize = Number(params && params.pageSize);
  if (Number.isFinite(fromPageSize) && fromPageSize > 0) return Math.floor(fromPageSize);
  return undefined;
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
    // 403 有两种完全不同的成因，混成一句「Open API 已关闭」会把人带偏
    // （总开关明明开着，真正缺的是这个 Key 的 tax / invoices 作用域）。
    const code = body && body.code ? String(body.code) : '';
    const detail = (body && (body.message || body.error)) || text.slice(0, 200) || '';
    const scopeish = /scope|作用域|permission|权限/i.test(`${code} ${detail}`);
    throw new Error(
      scopeish
        ? `${cfg.label} 该 API Key 缺少此接口的作用域（403${code ? ` ${code}` : ''}）：${detail || '未提供原因'}。请到 ${cfg.enableHint} 勾选对应权限。`
        : `${cfg.label} 拒绝访问（403${code ? ` ${code}` : ''}）：${detail || '未提供原因'}。可能是 Open API 总开关未打开，或该 Key 缺少此接口的作用域 —— 两者都在 ${cfg.enableHint} 处理。`
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
  const { data } = truncateListPayload(payload, resolveListLimit(params, opts.listLimit));
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
  resolveListLimit,
  resolvePayloadTotal,
  truncateListPayload,
  callApi
};
