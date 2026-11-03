'use strict';

/**
 * 思考通道的**上行回传**单一来源（DeepSeek 思考模式 + tools 的硬校验）：
 *
 * 请求里只要带 tools，历史中的 assistant 消息就必须回传 reasoning_content
 * （含未发起 tool call 的普通回复轮），否则上游 HTTP 400。
 *
 * 值来源分两级（REASONING-ISOLATION §3.5，反转旧「现编占位」）：
 *   1. 该消息已带 `reasoning_content`（同一 run 内 Rust 账本回传的真值）→ 原样保留；
 *   2. 否则取账本真思考字段 `reasoning`（与 `content` 分列，见 memory/schema.rs 的 messages.reasoning）
 *      → 作为 reasoning_content 回传**真值**；
 *   3. 真值不可得（老数据无该列 / 压缩折叠后）才补 `REASONING_PLACEHOLDER` 兜底。
 *
 * `reasoning` 是账本**内部**字段、不是上游协议字段：本模块在出口统一剥离，
 * 保证发给上游的消息里只有 `reasoning_content`，不夹带 `reasoning`。
 *
 * 单一来源：Main（rust-loop-runner.js）直接 require；Renderer（renderer-agent-llm.js）
 * 经 agent-bundle 注册为 window.ReasoningBackfill 消费。
 *
 * 纯函数、零 IO、零 Electron —— 与 token-estimate.js 一样可入 Renderer bundle。
 */

/** 历史轮缺思考真值时的兜底占位串（单一来源，勿在调用点另写字面量）。 */
const REASONING_PLACEHOLDER = '（思考内容未随消息保存）';

/** 账本自有真思考字段名（**不是**上游 `reasoning_content`）。 */
const BOOK_REASONING_FIELD = 'reasoning';

/**
 * 该轮是否需要回传思考。
 * - 带 tools / 该消息带 tool_calls：DeepSeek 硬校验，必须回传；
 * - `echoReasoning`（能力表按模型声明，getChannelPolicy）：显式要求脱工具也回传。
 */
function echoesReasoning(message, hasTools, echoReasoning) {
  const hasToolCalls = Array.isArray(message.tool_calls) && message.tool_calls.length > 0;
  return !!(hasTools || hasToolCalls || echoReasoning);
}

/** 已存在的 reasoning_content（非空字符串）。 */
function existingReasoningContent(message) {
  return typeof message.reasoning_content === 'string' && message.reasoning_content.trim()
    ? message.reasoning_content
    : '';
}

/** 账本真思考（非空字符串，已 trim）。 */
function bookReasoning(message) {
  const raw = message[BOOK_REASONING_FIELD];
  return typeof raw === 'string' ? raw.trim() : '';
}

/**
 * 归一化单条 assistant 消息的思考回传：补真值 / 兜底占位，并剥离账本内部 `reasoning`。
 * 无需改动时返回**原对象**（保持引用，便于上层判断是否变化）。
 * @param {any} message 单条消息
 * @param {boolean} hasTools 本轮请求是否带 tools
 * @param {boolean} [echoReasoning] 能力表声明是否脱工具也回传
 * @returns {any}
 */
function normalizeAssistantReasoning(message, hasTools, echoReasoning) {
  if (!message || message.role !== 'assistant') return message;
  const keepBookField = message[BOOK_REASONING_FIELD] !== undefined;
  const existing = existingReasoningContent(message);
  const wantValue = echoesReasoning(message, hasTools, echoReasoning) && !existing;
  if (!wantValue && !keepBookField) return message;
  const next = { ...message };
  if (keepBookField) delete next[BOOK_REASONING_FIELD];
  if (wantValue) {
    next.reasoning_content = bookReasoning(message) || REASONING_PLACEHOLDER;
  }
  return next;
}

/**
 * 给 assistant 消息补思考回传并剥离账本 `reasoning`。无变化时返回**原数组**（保持引用不变）。
 * @param {any[]} messages
 * @param {boolean} hasTools
 * @param {boolean} [echoReasoning]
 * @returns {any[]}
 */
function backfillReasoningContent(messages, hasTools, echoReasoning) {
  if (!Array.isArray(messages)) return messages;
  let changed = false;
  const next = messages.map((m) => {
    const normalized = normalizeAssistantReasoning(m, hasTools, echoReasoning);
    if (normalized !== m) changed = true;
    return normalized;
  });
  return changed ? next : messages;
}

module.exports = {
  REASONING_PLACEHOLDER,
  backfillReasoningContent
};
