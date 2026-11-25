'use strict';

/**
 * 归纳器的 LLM 这一段：解析一次调用的端点/请求头/超时，发请求，取正文。
 *
 * 为什么单独一个文件：这里只做「怎么问模型」，与「问什么（prompt）」「答案怎么落库（apply）」分开；
 * 传输仍是 core 的 `llm.complete`（端点/请求头/超时/解析/usage 只有 core 那一份实现），
 * 本文件只负责拼参数与注入测试替身。
 *
 * 纯搬移（2026-11-21）：逻辑一行没改，`knowledge-maintainer.js` 继续再导出。
 */

const { completeOnce, currentLlmCompleteBridge } = require('../llm-complete');
const { buildLlmHeadersFromConfig, resolveLlmEndpoint } = require('../llm-request');
const { loadModelSettings, resolveTextApiConfig } = require('../../model-settings');

// ---------------------------------------------------------------------------
// LLM 调用（端点/头唯一来源 llm-request.js）
// ---------------------------------------------------------------------------

function resolveLlmCall(ctx, payload, limits) {
  const model = String((payload && payload.model) || '').trim();
  const cfg = (payload && payload.apiConfig) || {};
  let baseUrl = String(cfg.baseUrl || '').trim();
  let apiKey = cfg.apiKey;
  let headers = cfg.headers;
  let authMode = cfg.authMode;
  let userAgent = cfg.userAgent;
  let modelId = model;
  if (!baseUrl) {
    // 定时归纳没有 Renderer 会话：用设置页的默认文本模型（与定时计划同一条解析）
    const text = resolveTextApiConfig(loadModelSettings(ctx.userData));
    baseUrl = String(text.baseUrl || '').trim();
    apiKey = text.apiKey;
    headers = text.headers;
    authMode = text.authMode;
    userAgent = text.userAgent;
    modelId = modelId || String(text.model || '').trim();
  }
  if (!baseUrl || !modelId) return null;
  const url = resolveLlmEndpoint(baseUrl, 'chat');
  if (!url) return null;
  const head = buildLlmHeadersFromConfig({
    apiKey,
    authMode,
    headers,
    userAgent,
    model: modelId,
    sessionId: ctx.sessionId || ''
  });
  return { url, headers: head, model: modelId, timeoutMs: Number(limits.knowledgeTimeoutMs) || 65000 };
}

/**
 * 一次归纳请求。`fetch` 是测试注入点；不注入就走 core 的 `llm.complete`；
 * 端点/请求头/超时/解析/usage 都只有 core 那一份实现。
 * 测试可注入替身（与 session-title 的 `opts.fetchTitleOnce` 同一手法）。
 */
async function callLlm(llm, body, fetch, coreBridge) {
  const child = new AbortController();
  const timer = setTimeout(() => {
    try {
      child.abort();
    } catch {
      // ignore
    }
  }, llm.timeoutMs);
  try {
    if (typeof fetch === 'function') {
      return await fetch(llm.url, {
        headers: llm.headers,
        body: JSON.stringify(body),
        signal: child.signal
      });
    }
    // 默认传输：core 的 `llm.complete`（端点/请求头/超时/解析/usage 只有 core 那一份）
    return await completeOnce({
      coreBridge: coreBridge || currentLlmCompleteBridge(),
      url: llm.url,
      llm,
      body,
      timeoutMs: llm.timeoutMs,
      signal: child.signal
    });
  } finally {
    clearTimeout(timer);
  }
}

function extractContent(raw) {
  if (typeof raw === 'string') return raw;
  if (raw && typeof raw.content === 'string') return raw.content;
  const choice = raw && Array.isArray(raw.choices) ? raw.choices[0] : null;
  const msg = (choice && choice.message) || {};
  return msg.content != null ? String(msg.content) : '';
}

module.exports = { resolveLlmCall, callLlm, extractContent };
