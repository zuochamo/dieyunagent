'use strict';

const DEFAULT_PROBE_CONCURRENCY = 5;
const DEFAULT_PROBE_TIMEOUT_MS = 8000;
const MAX_MODELS_TO_PROBE = 48;

/**
 * @param {string} baseUrl
 */
function resolveModelsUrl(baseUrl) {
  const trimmed = String(baseUrl || '')
    .trim()
    .replace(/\/+$/, '');
  if (!trimmed) throw new Error('未配置接口地址');
  if (/\/models$/i.test(trimmed)) return trimmed;
  if (/\/v\d+$/i.test(trimmed)) return `${trimmed}/models`;
  return `${trimmed}/v1/models`;
}

/**
 * @param {string} baseUrl
 */
function resolveChatCompletionsUrl(baseUrl) {
  const trimmed = String(baseUrl || '')
    .trim()
    .replace(/\/+$/, '');
  if (!trimmed) throw new Error('未配置接口地址');
  if (/\/chat\/completions$/i.test(trimmed)) return trimmed;
  if (/\/v\d+$/i.test(trimmed)) return `${trimmed}/chat/completions`;
  return `${trimmed}/v1/chat/completions`;
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
 */
async function probeModelAvailable(chatUrl, apiKey, modelId, timeoutMs = DEFAULT_PROBE_TIMEOUT_MS) {
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

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
 * @param {{ concurrency?: number, maxProbe?: number }} [opts]
 */
async function filterModelsByProbe(models, chatUrl, apiKey, opts = {}) {
  const concurrency = Math.max(1, opts.concurrency || DEFAULT_PROBE_CONCURRENCY);
  const maxProbe = Math.max(1, opts.maxProbe || MAX_MODELS_TO_PROBE);
  const list = models.slice(0, maxProbe);
  const skipped = models.length - list.length;
  const valid = [];
  let removed = 0;

  let index = 0;
  async function worker() {
    while (index < list.length) {
      const i = index++;
      const m = list[i];
      const ok = await probeModelAvailable(chatUrl, apiKey, m.id);
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
 * @param {{ validate?: boolean, concurrency?: number }} [opts]
 */
async function fetchOpenAiModelList(baseUrl, apiKey, opts = {}) {
  const validate = opts.validate !== false;
  const modelsUrl = resolveModelsUrl(baseUrl);
  const chatUrl = resolveChatCompletionsUrl(baseUrl);

  const headers = { Accept: 'application/json' };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

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
      concurrency: opts.concurrency
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

module.exports = {
  fetchOpenAiModelList,
  resolveModelsUrl,
  resolveChatCompletionsUrl,
  probeModelAvailable,
  isListedModelCandidate
};
