'use strict';

/**
 * 独立 Reviewer 的**执行侧**（Main only）：读配置 → 组请求 → 调模型 → 解析 → 判结论。
 *
 * 为什么在 Main：Reviewer 的结论是交付状态的一部分（不通过 → 气泡终态 + 托盘文案），
 * 属于「完成验收」这条判定链。判定（`turn-reviewer.js`）与请求（本文件）都在 Main，
 * Renderer 只剩「把 readiness.note 渲染进正文」一件事。
 *
 * 配置来源：`model-settings.json` 的 `reviewer*` 四个字段（设置页保存时随整份 settings
 * 镜像进 Main，见 `src/model-settings.js#normalize`）。**不再从 Renderer 现取** ——
 * 那会让验收这条链依赖窗口是否开着。
 *
 * 硬约束（与「验收只提示、不挡交付」一致）：
 *   1. 任何失败都返回 `{ok:true, skipped:true}`，绝不把这一轮判成失败；
 *   2. 没有文件 diff / 没启用 / 端点解析不出来 → 直接跳过，不发请求；
 *   3. 超时 60s（`REVIEWER_TIMEOUT_MS`）即放弃，验收不该拖住收尾。
 */

const { completeOnce, currentLlmCompleteBridge } = require('./llm-complete');
// 响应体 → 正文：与标题生成同一个解析口径（`session-title.js` 已导出，别再写一份）
const { extractCompletionContent } = require('./session-title');
const { buildLlmHeadersFromConfig, resolveLlmEndpoint } = require('./llm-request');
const { extractReviewerJson, collectReviewerFileDiffs } = require('./reviewer-json');
const {
  resolveReviewerConfig,
  shouldRunReviewer,
  buildReviewerPayload,
  buildReviewerMessages,
  buildRepairMessages,
  judgeReviewerOutcome,
  REVIEWER_TIMEOUT_MS,
  REVIEWER_MAX_FILES,
  REVIEWER_MAX_SNIPPET_CHARS
} = require('./turn-reviewer');

/**
 * 一次 Reviewer 请求的 URL / 请求头 / body（纯函数，便于单测：端点与请求头只认 `llm-request`）。
 *
 * @param {{model: string, apiConfig: {baseUrl: string, apiKey: string}}} config
 * @param {{messages: any[], maxTokens?: number, jsonMode?: boolean}} opts
 * @returns {{url: string, headers: object, body: any} | null} 端点解析不出来时返回 null
 */
function buildReviewerRequest(config, opts = {}) {
  const baseUrl = String((config && config.apiConfig && config.apiConfig.baseUrl) || '').trim();
  const url = resolveLlmEndpoint(baseUrl, 'chat');
  if (!url) return null;
  const headers = buildLlmHeadersFromConfig({ ...(config.apiConfig || {}), model: config.model });
  const body = {
    model: config.model,
    temperature: 0,
    max_tokens: Math.max(200, Number(opts.maxTokens) || 1600),
    messages: Array.isArray(opts.messages) ? opts.messages : []
  };
  // JSON 模式只是「尽量」：不少兼容端点不认 response_format，调用侧会退回普通模式重发一次。
  if (opts.jsonMode !== false) body.response_format = { type: 'json_object' };
  // `llm` 一起带出去：请求由 core 发，端点/鉴权原样交给它（不在这里再算一次头）
  const llm = { ...(config.apiConfig || {}), model: config.model, headers };
  return { url, headers, body, llm };
}

function isJsonModeUnsupported(err) {
  const text = String((err && err.message) || err || '').toLowerCase();
  return text.includes('response_format') || text.includes('json_object') || text.includes('unsupported parameter');
}

/**
 * 带超时的一次请求：返回模型输出的原始文本。
 * `fetchReviewerOnce` 只给测试注入（不注入就走 core 的 `llm.complete`）。
 */
async function fetchOnce(request, { signal, fetchReviewerOnce, coreBridge }) {
  if (typeof fetchReviewerOnce === 'function') {
    return fetchReviewerOnce({ url: request.url, headers: request.headers, body: request.body, signal });
  }
  // 请求由 core 发：评审也走同一份端点/请求头/超时/解析实现（Node 不再有第二份 HTTP 客户端）
  const result = await completeOnce({
    coreBridge: coreBridge || currentLlmCompleteBridge(),
    url: request.url,
    llm: request.llm,
    body: request.body
  });
  return extractCompletionContent(result);
}

/**
 * 跑一次 Reviewer。
 *
 * @param {{
 *   settings?: object|null,
 *   facts?: { userTask?: string, trace?: any[], sessionChanges?: any[], diagnostics?: any, planSummary?: string, browser?: any, files?: any[] },
 *   signal?: any,
 *   fetchReviewerOnce?: Function,
 *   log?: Function
 * }} opts
 * @returns {Promise<{ok: boolean, skipped?: boolean, reason?: string, note?: string, reviewer?: any, model?: string, error?: any}>}
 */
async function runTurnReviewer(opts = {}) {
  const settings = opts.settings || null;
  const facts = opts.facts || {};
  const files = Array.isArray(facts.files)
    ? facts.files
    : collectReviewerFileDiffs(facts.sessionChanges || [], facts.trace || [], {
        maxFiles: REVIEWER_MAX_FILES,
        maxSnippetChars: REVIEWER_MAX_SNIPPET_CHARS
      });
  const config = resolveReviewerConfig(settings);
  // 两种跳过原因必须分开：混成 `reviewer_disabled` 会让「配置开了但拿不到 diff」
  // 这种真问题看起来像「用户没开」，排查时完全走偏。
  if (!config || !shouldRunReviewer({ settings, files })) {
    const reason = !config || config.enabled !== true ? 'reviewer_disabled' : 'reviewer_no_diff';
    if (typeof opts.log === 'function' && reason === 'reviewer_no_diff') {
      opts.log('[dieyun:reviewer] 跳过验收：本轮没有可用的文件 diff');
    }
    return { ok: true, skipped: true, reason };
  }
  const first = buildReviewerRequest(config, {
    maxTokens: 1600,
    messages: buildReviewerMessages(
      buildReviewerPayload({
        userTask: facts.userTask || '',
        files,
        diagnostics: facts.diagnostics || null,
        planSummary: facts.planSummary || '',
        browser: facts.browser || null
      })
    )
  });
  if (!first) return { ok: true, skipped: true, reason: 'reviewer_no_endpoint' };

  const parent = opts.signal || null;
  if (parent && parent.aborted) return { ok: true, skipped: true, reason: 'reviewer_aborted' };
  const child = new AbortController();
  const onParentAbort = () => {
    try {
      child.abort();
    } catch {
      // ignore
    }
  };
  if (parent && typeof parent.addEventListener === 'function') {
    parent.addEventListener('abort', onParentAbort, { once: true });
  }
  const timer = setTimeout(() => {
    try {
      child.abort();
    } catch {
      // ignore
    }
  }, REVIEWER_TIMEOUT_MS);

  const callOpts = {
    signal: child.signal,
    fetchReviewerOnce: opts.fetchReviewerOnce,
    coreBridge: opts.coreBridge
  };
  let raw = '';
  try {
    try {
      raw = await fetchOnce(first, callOpts);
    } catch (err) {
      // 端点不认 JSON 模式 → 退回普通模式再发一次（不算失败）
      if (!isJsonModeUnsupported(err)) throw err;
      const plain = buildReviewerRequest(config, {
        maxTokens: 1600,
        messages: first.body.messages,
        jsonMode: false
      });
      if (!plain) throw err;
      raw = await fetchOnce(plain, callOpts);
    }
    let parsed = extractReviewerJson(raw);
    if (!parsed || typeof parsed !== 'object') {
      // 一次格式修复：只让它把原文改写成 JSON，不重新判断。
      // 修复请求**不再带 response_format**：走到这里往往正是因为端点不认它；
      // 修复提示词本身已要求「只输出 JSON」，不需要协议层再强制一次。
      const repair = buildReviewerRequest(config, {
        maxTokens: 1200,
        messages: buildRepairMessages(raw),
        jsonMode: false
      });
      const repairedRaw = repair ? await fetchOnce(repair, callOpts) : '';
      parsed = extractReviewerJson(repairedRaw);
    }
    const verdict = judgeReviewerOutcome(parsed);
    return { ...verdict, model: config.model };
  } catch (err) {
    const message = String((err && err.message) || err || '');
    if (typeof opts.log === 'function') opts.log(`[dieyun:reviewer] 跳过验收：${message}`);
    return { ok: true, skipped: true, reason: 'reviewer_error', error: err };
  } finally {
    clearTimeout(timer);
    if (parent && typeof parent.removeEventListener === 'function') {
      parent.removeEventListener('abort', onParentAbort);
    }
  }
}

module.exports = {
  buildReviewerRequest,
  isJsonModeUnsupported,
  runTurnReviewer
};
