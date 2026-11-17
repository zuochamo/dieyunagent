'use strict';

/**
 * 通用一次 LLM 调用的**唯一宿主入口**（RPC `llm.complete`）。
 *
 * 为什么要有它：Node 侧曾有第二份 HTTP 客户端（`llm-proxy.js` 的 `chatCompletionJson` /
 * `streamChatCompletionMain`）供标题 / 汇总 / 评审 / 计划 / 记忆提炼使用，与 core 的
 * `agent/llm.rs` 各维护一份端点、请求头、超时、SSE 解析、错误分类 —— 改一处漏一处就漂移
 * （历史上出现过「对话正常、压缩一跑就 400」）。
 *
 * 现在这些辅助任务一律走这里：**请求的发出、流式解析、usage、抓包都在 core**，
 * 宿主只负责「决定问什么」（拼 body、选模型）与「失败怎么降级」。
 *
 * 端点与请求头仍然只由 `src/agent/llm-request.js` 给（Rust 不推导端点）。
 */

const { buildLlmHeadersFromConfig, resolveLlmEndpoint } = require('./llm-request');

/** @type {{ invoke: Function } | null} */
let coreBridge = null;

/** 装配：入口处调一次即可（与 `setEmbeddingCoreBridge` 同一手法）。 */
function setLlmCompleteBridge(bridge) {
  coreBridge = bridge && typeof bridge.invoke === 'function' ? bridge : null;
}

function currentLlmCompleteBridge() {
  return coreBridge;
}

/**
 * 发一次调用并等结果。
 *
 * @param {object} opts
 * @param {object} opts.llm `{ baseUrl, apiKey, model?, headers?, authMode? }`
 * @param {object} opts.body OpenAI 形态的请求体（含 `model` / `messages`）
 * @param {boolean} [opts.stream] 是否流式；流式时**必须**给 `runId` 才能收到增量事件
 * @param {string} [opts.runId] 给了就把增量推到事件通道（`agent.delta`）
 * @param {boolean} [opts.includeRaw] 调试抓包：把响应原文一并回传
 * @param {string} [opts.url] 已解析好的端点（调用方已经用 `llm-request.js` 算过就传它，避免二次推导）
 * @param {{ invoke: Function }} [opts.coreBridge] 覆盖装配里的桥（测试用）
 * @returns {Promise<{content:string, reasoning:?string, toolCalls:object[], finishReason:?string,
 *                    usage:?object, model:?string, raw:?string}>}
 */
async function completeOnce(opts) {
  const bridge = (opts && opts.coreBridge) || coreBridge;
  if (!bridge || typeof bridge.invoke !== 'function') {
    throw new Error('llm.complete 需要 core 桥（先 setLlmCompleteBridge）');
  }
  const llm = (opts && opts.llm) || {};
  const body = (opts && opts.body) || {};
  const model = String(body.model || llm.model || '');
  const url = String((opts && opts.url) || '').trim() || resolveLlmEndpoint(llm && llm.baseUrl);
  const pending = bridge.invoke(
    'llm.complete',
    {
      url,
      body,
      stream: !!(opts && opts.stream),
      includeRaw: !!(opts && opts.includeRaw),
      runId: (opts && opts.runId) || '',
      // 端点与鉴权原样交给 core：调用方给过 headers 就用它的，没给才在这里按同一份
      // `llm-request.js` 算一次（鉴权头仍然只有一个来源）
      llm: {
        ...llm,
        model,
        headers: (llm && llm.headers) || buildLlmHeadersFromConfig(llm)
      }
    },
    (opts && opts.timeoutMs) || undefined
  );
  // 调用方的 abort 语义：立刻返回，core 侧那次请求自己跑完就丢。
  // （没有 cancel RPC：一次性调用的结果已经没人要了，专门为它加一条取消协议是加法。）
  const signal = opts && opts.signal;
  if (!signal) return pending;
  if (signal.aborted) throw abortError();
  return Promise.race([
    pending,
    new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(abortError()), { once: true });
    })
  ]);
}

function abortError() {
  const err = new Error('已取消');
  err.name = 'AbortError';
  return err;
}

module.exports = {
  setLlmCompleteBridge,
  currentLlmCompleteBridge,
  completeOnce
};
