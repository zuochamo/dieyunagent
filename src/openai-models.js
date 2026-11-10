'use strict';

const { buildLlmHeaders, resolveLlmEndpoint } = require('./agent/llm-request');

const DEFAULT_PROBE_CONCURRENCY = 5;
const DEFAULT_PROBE_TIMEOUT_MS = 8000;
const MAX_MODELS_TO_PROBE = 48;

/**
 * @param {string} baseUrl
 */
function resolveModelsUrl(baseUrl) {
  // 端点拼接单一来源 llm-request.js；此处只保留「必填」语义
  const url = resolveLlmEndpoint(baseUrl, 'models');
  if (!url) throw new Error('未配置接口地址');
  return url;
}

/**
 * @param {string} baseUrl
 */
function resolveChatCompletionsUrl(baseUrl) {
  const url = resolveLlmEndpoint(baseUrl, 'chat');
  if (!url) throw new Error('未配置接口地址');
  return url;
}

/**
 * 根据 /v1/models 返回字段剔除明显不可用项（仍可能需探测确认）。
 * @param {object} m
 */
function isListedModelCandidate(m) {
  if (!m || !m.id) return false;
  if (m.active === false || m.available === false || m.enabled === false) return false;
  if (m.deprecated === true) return false;
  const status = String(m.status || m.state || '').toLowerCase();
  if (status === 'deprecated' || status === 'disabled' || status === 'inactive' || status === 'offline') {
    return false;
  }
  const id = String(m.id).toLowerCase();
  if (id.includes('deprecated') || id.endsWith('-legacy') || id.includes('unavailable')) {
    return false;
  }
  return true;
}

/**
 * @param {string} status
 * @param {string} body
 */
function isModelUnavailableResponse(status, body) {
  const text = String(body || '').toLowerCase();
  if (status === 404) return true;
  if (status !== 400 && status !== 403 && status !== 422) return false;
  return (
    /model.*(not found|does not exist|unavailable|disabled|deprecated|invalid)/i.test(text) ||
    /invalid.*model/i.test(text) ||
    /no such model/i.test(text) ||
    /模型.*(不存在|不可用|已下线|已取消|无效|停用)/.test(text) ||
    /(已下线|已取消|不可用)/.test(text)
  );
}

/**
 * @param {string} chatUrl
 * @param {string} apiKey
 * @param {string} modelId
 * @param {number} timeoutMs
 * @param {{ authMode?: string, headers?: object, userAgent?: string }} [requestOptions]
 */
async function probeModelAvailable(
  chatUrl,
  apiKey,
  modelId,
  timeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
  requestOptions = {}
) {
  // 探测也要带上供应商的自定义头 / User-Agent，否则「列表能拉、模型不可用」的假阴性
  const headers = buildLlmHeaders({
    apiKey,
    authMode: requestOptions.authMode,
    headers: requestOptions.headers,
    userAgent: requestOptions.userAgent,
    accept: 'application/json'
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(chatUrl, {
      method: 'POST',
      headers,
      signal: controller.signal,
      body: JSON.stringify({
        model: modelId,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 1,
        stream: false
      })
    });
    const body = await res.text().catch(() => '');
    if (res.ok) return true;
    if (isModelUnavailableResponse(res.status, body)) return false;
    // 参数兼容、鉴权、限流等错误不能证明模型不存在，保留在列表中。
    return true;
  } catch (e) {
    // 超时或网络抖动不能证明模型不存在，保留，避免误删。
    return true;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @param {Array<{ id: string }>} models
 * @param {string} chatUrl
 * @param {string} apiKey
 * @param {{ concurrency?: number, maxProbe?: number, requestOptions?: object }} [opts]
 */
async function filterModelsByProbe(models, chatUrl, apiKey, opts = {}) {
  const concurrency = Math.max(1, opts.concurrency || DEFAULT_PROBE_CONCURRENCY);
  const maxProbe = Math.max(1, opts.maxProbe || MAX_MODELS_TO_PROBE);
  const requestOptions = opts.requestOptions || {};
  const list = models.slice(0, maxProbe);
  const skipped = models.length - list.length;
  const valid = [];
  let removed = 0;

  let index = 0;
  async function worker() {
    while (index < list.length) {
      const i = index++;
      const m = list[i];
      // 探测请求与列表请求必须用同一套头，否则会出现「列表可见但探测全删」的假阴性
      const ok = await probeModelAvailable(chatUrl, apiKey, m.id, undefined, requestOptions);
      if (ok) valid.push(m);
      else removed += 1;
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, list.length) }, () => worker());
  await Promise.all(workers);

  // 超出探测上限的模型：仅保留元数据过滤通过的项（不探测）
  if (skipped > 0) {
    valid.push(...models.slice(maxProbe));
  }

  valid.sort((a, b) => a.id.localeCompare(b.id, 'zh-CN'));
  return { models: valid, probed: list.length, removed, skipped };
}

/**
 * @param {string} baseUrl
 * @param {string} apiKey
 * @param {{ validate?: boolean, concurrency?: number, authMode?: string, headers?: object, userAgent?: string }} [opts]
 */
async function fetchOpenAiModelList(baseUrl, apiKey, opts = {}) {
  const validate = opts.validate !== false;
  const modelsUrl = resolveModelsUrl(baseUrl);
  const chatUrl = resolveChatCompletionsUrl(baseUrl);
  const requestOptions = {
    authMode: opts.authMode,
    headers: opts.headers,
    userAgent: opts.userAgent
  };

  // GET 请求不设 Content-Type
  const headers = buildLlmHeaders({
    apiKey,
    ...requestOptions,
    accept: 'application/json',
    json: false
  });

  const res = await fetch(modelsUrl, { headers, signal: AbortSignal.timeout(15000) });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`模型列表 HTTP ${res.status}${body ? `: ${body.slice(0, 200)}` : ''}`);
  }
  const json = await res.json();
  const raw = Array.isArray(json?.data) ? json.data : Array.isArray(json) ? json : [];
  const models = raw
    .map((m) => {
      const id = String(m?.id || m?.name || '').trim();
      if (!id) return null;
      return {
        id,
        owned_by: m?.owned_by ? String(m.owned_by) : '',
        created: m?.created || null,
        status: m?.status != null ? String(m.status) : '',
        deprecated: !!m?.deprecated
      };
    })
    .filter(Boolean)
    .filter(isListedModelCandidate);

  const seen = new Set();
  const unique = [];
  for (const m of models) {
    if (seen.has(m.id)) continue;
    seen.add(m.id);
    unique.push(m);
  }

  let listed = unique.length;
  let validated = listed;
  let removed = 0;
  let probed = 0;
  let out = unique;

  if (validate && unique.length && apiKey) {
    const r = await filterModelsByProbe(unique, chatUrl, apiKey, {
      concurrency: opts.concurrency,
      requestOptions
    });
    out = r.models;
    probed = r.probed;
    removed = r.removed;
    validated = out.length;
  }

  out.sort((a, b) => a.id.localeCompare(b.id, 'zh-CN'));
  return {
    models: out,
    modelsUrl,
    chatUrl,
    listed,
    validated,
    removed,
    probed
  };
}

/**
 * 设置页「检测」的**唯一语义实现**：`payload → 结果`。
 *
 * 两个执行者共用这一份：桌面端 `models:fetch-list`（Main IPC）与服务器版
 * `desktop.fetch_models`（`src/headless/desktop-turn.js`）。渲染层只判 `res.ok`，
 * 不区分是谁跑的 —— 所以形状必须固定在同一个地方，别在两处各包一层。
 *
 * payload 来自 `renderer-model-settings.js`：
 *   `{ baseUrl, apiKey, validate, authMode, headers, userAgent }`
 * 返回 `{ ok: true, models, modelsUrl, chatUrl, listed, validated, removed, probed }`
 * 或 `{ ok: false, error, models: [] }`（失败不抛，界面要的是可读原因）。
 *
 * @param {{ baseUrl?: string, apiKey?: string, validate?: boolean, authMode?: string, headers?: object, userAgent?: string }} [payload]
 */
async function detectModelsFromPayload(payload) {
  const p = payload && typeof payload === 'object' ? payload : {};
  const baseUrl = p.baseUrl ? String(p.baseUrl).trim() : '';
  const apiKey = p.apiKey ? String(p.apiKey).trim() : '';
  const validate = p.validate !== false;
  // 请求修饰随 payload 透传：检测请求必须与真实请求同一套头，
  // 否则会出现「检测失败但聊天正常」或反之。
  try {
    const result = await fetchOpenAiModelList(baseUrl, apiKey, {
      validate,
      authMode: p.authMode ? String(p.authMode).trim() : '',
      headers: p.headers && typeof p.headers === 'object' ? p.headers : undefined,
      userAgent: p.userAgent ? String(p.userAgent).trim() : ''
    });
    return { ok: true, ...result };
  } catch (err) {
    return { ok: false, error: (err && (err.message || String(err))) || '拉取模型列表失败', models: [] };
  }
}

module.exports = {
  fetchOpenAiModelList,
  detectModelsFromPayload
};
