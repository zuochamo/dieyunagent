'use strict';

const { resolveLlmEndpoint, buildLlmHeadersFromConfig } = require('../../agent/llm-request');

/**
 * 探针超时：设置页的「测试」按钮，用户正盯着等，不该拖到默认 RPC 超时。
 * 端点真的慢（部分聚合网关冷启动要十几秒）时也够用 —— 失败文案会照实显示状态码。
 */
const PROBE_TIMEOUT_MS = 20000;

/** 直连向量端点（`.../embed`）吃 `texts[]`，OpenAI 兼容端点吃 `input`。 */
function isDirectEmbedEndpoint(baseUrl) {
  return /\/embed$/i.test(String(baseUrl || '').trim().replace(/\/+$/, ''));
}

/**
 * 模型 / 向量端点的连通性探针（设置页那两个「测试」按钮）。
 *
 * **为什么在 Main 而不是 Renderer**：这些请求打的是用户随手填的地址，无法枚举，
 * 渲染层一旦自己发 HTTP，CSP 的 `connect-src` 就只能写成 `*`（等于把出网限制放开）。
 * 请求装配本来就有单一来源（`agent/llm-request.js` 的端点与请求头），这里只把它跑一次；
 * 端点语义（音频模型 / 维度 / 报错文案）仍由 Renderer 解释 —— 那是 UI 的事。
 *
 * 返回原始响应文本：同样的失败在 OpenAI 兼容端点与直连端点上一句人话都不一样，
 * 由调用方按上下文解释，比在这里猜一遍更准。
 *
 * @param {{
 *   kind?: 'chat'|'embedding',
 *   model?: string,
 *   baseUrl?: string,
 *   apiKey?: string,
 *   authMode?: string,
 *   headers?: object|string,
 *   userAgent?: string,
 *   dimensions?: number,
 *   sessionId?: string,
 *   timeoutMs?: number
 * }} params
 * @returns {Promise<{ status: number, ok: boolean, text: string }>}
 */
async function probeModel(params = {}) {
  const kind = params.kind === 'embedding' ? 'embedding' : 'chat';
  const baseUrl = String(params.baseUrl || '').trim();
  if (!baseUrl) {
    const e = new Error('未配置 API Base URL');
    e.code = 'MISSING_BASE_URL';
    throw e;
  }
  const model = String(params.model || '').trim();
  if (!model) {
    const e = new Error('未配置模型名称');
    e.code = 'MISSING_MODEL';
    throw e;
  }
  const url = resolveLlmEndpoint(baseUrl, kind === 'embedding' ? 'embeddings' : 'chat');
  if (!url) {
    const e = new Error('接口地址无效');
    e.code = 'INVALID_BASE_URL';
    throw e;
  }
  const headers = buildLlmHeadersFromConfig(
    {
      apiKey: params.apiKey,
      authMode: params.authMode,
      headers: params.headers,
      userAgent: params.userAgent
    },
    { sessionId: params.sessionId, model }
  );
  let body;
  if (kind === 'embedding') {
    body = isDirectEmbedEndpoint(baseUrl)
      ? { texts: ['叠云向量模型测试'], model, dimensions: params.dimensions }
      : { model, input: '叠云向量模型测试', dimensions: params.dimensions };
  } else {
    body = {
      model,
      messages: [{ role: 'user', content: '叠云模型连接测试。请只回复 OK。' }],
      temperature: 0,
      max_tokens: 16
    };
  }

  const timeoutMs = Number(params.timeoutMs) > 0 ? Number(params.timeoutMs) : PROBE_TIMEOUT_MS;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  if (timer && typeof timer.unref === 'function') timer.unref();
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: ac.signal
    });
    const text = await res.text();
    return { status: res.status, ok: res.ok, text };
  } catch (err) {
    // 网络层失败（DNS / 拒连 / 超时）与「服务端返回了错误码」是两件事：
    // 前者原文只有 fetch failed，必须自己补一句人话，否则用户看不出是哪一步出错。
    const aborted = err && err.name === 'AbortError';
    const e = new Error(
      aborted ? `测试超时（${Math.round(timeoutMs / 1000)}s 无响应）` : `无法连接：${err && err.message ? err.message : err}`
    );
    e.code = aborted ? 'PROBE_TIMEOUT' : 'PROBE_UNREACHABLE';
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

function createModelHandlers(_deps) {
  return {
    'model.probe': async (params) => probeModel(params || {})
  };
}

module.exports = { createModelHandlers, probeModel };
