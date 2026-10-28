'use strict';

function countTraceTools(trace) {
  return (trace || []).reduce((n, e) => n + ((e && e.tools) || []).length, 0);
}

function replyHasToolCallMarkup(text) {
  return /<(?:tool_call|tool_calls|invoke|function=|\uff5cDSML\uff5c|｜DSML｜)/i.test(
    String(text || '')
  );
}

/** 仅当工具轮结束后没有任何用户向正文时才补汇总；有字就用模型原文，不用长度启发式再打一轮 LLM */
function needsAssistantReplySynthesis(reply, trace) {
  const toolCount = countTraceTools(trace);
  if (toolCount < 1) return false;
  let text = String(reply || '').trim();
  if (text === '(空响应)') text = '';
  if (!text) return true;
  if (replyHasToolCallMarkup(text)) return true;
  return false;
}

/** 汇总轮产出：非空且无 tool_call 标记即可采用，不再套工具轮次长度启发式 */
function synthesizedReplyIsUsable(text) {
  const t = String(text || '').trim();
  if (!t || t === '(空响应)') return false;
  if (replyHasToolCallMarkup(t)) return false;
  return t.length >= 8;
}

const TURN_REASONING_FALLBACK_LABEL = '（以下为模型思考，本轮未成文）';
const TURN_EMPTY_REPLY_TEXT = '（模型未生成文字答复。）';
const SYNTHESIS_PHASE = '汇总';
/**
 * 非模型思考的 trace phase：程序动作，不进 `messages.reasoning`。
 * - 汇总：交给汇总 LLM 的合成轮，不是本轮思考；
 * - 完成验收：旧版 Renderer 把静态检查证据伪造成一条 trace 轮次注入（`collectCompletionDiagnosticsForRun`），
 *   曾因此被当成真思考落库并上行回传，模型据此把「完成验收」提示当模板复述（2026-10-17 重复提示事故）。
 *   那条伪轮次已随「完成验收判定搬到 Main」删除，这里保留 phase 名只为兼容历史记录的重放。
 */
const NON_MODEL_PHASES = new Set([SYNTHESIS_PHASE, '完成验收']);

/** 交付用正文：去空白，'(空响应)' 视为空 */
function normalizeDeliverableText(reply) {
  const text = String(reply == null ? '' : reply).trim();
  return text === '(空响应)' ? '' : text;
}

/** 可作为交付的正文：非空且不含残留 tool_call 标记 */
function deliverableAnswer(reply, trace) {
  const text = normalizeDeliverableText(reply);
  if (!text) return '';
  if (needsAssistantReplySynthesis(text, trace)) return '';
  return text;
}

/**
 * 从 trace 取本轮真思考（单一来源）：跳过汇总轮与**占位行**，取最近若干段拼接。
 *
 * 不做长度过滤 —— 「本轮有没有思考」是四态交付的判定输入（§3.4），短思考也是思考；
 * 占位文案由写入处的 `placeholder: true` 结构标记排除（`live-loop-trace` /
 * `plan-run-events` / `renderer-agent-rust-loop`），不再靠中文词表猜。
 * 既用于交付兜底，也用于账本 `reasoning` 落库（§3.5）。
 */
function reasoningTextFromTrace(trace) {
  const parts = [];
  for (const entry of trace || []) {
    const phase = String((entry && entry.phase) || '').trim();
    if (NON_MODEL_PHASES.has(phase)) continue;
    if (entry && entry.placeholder === true) continue;
    const text = String((entry && (entry.fullThought || entry.thought)) || '').trim();
    if (!text) continue;
    parts.push(text);
  }
  if (!parts.length) return '';
  return parts.slice(-4).join('\n\n');
}

/** 思考回退文案：显式标注，绝不伪装成正文 */
function reasoningFallbackText(reasoning) {
  const t = String(reasoning || '').trim();
  return t ? `${TURN_REASONING_FALLBACK_LABEL}\n\n${t}` : '';
}

function isReasoningFallbackText(text) {
  return String(text == null ? '' : text).trim().startsWith(TURN_REASONING_FALLBACK_LABEL);
}

/**
 * 四态交付决策——单一来源（§3.4）。
 * - answer：有用户向正文
 * - reasoning-fallback：无正文、有思考、本轮被截断（预算/轮次/中断）→ 思考原文 + 标签（仅展示，不写账本）
 * - synthesis：无正文、有思考、正常收尾 → 交给汇总 LLM（text=''）
 * - empty：都没有 → 占位
 */
function resolveTurnDelivery(input) {
  const src = input || {};
  const answer = normalizeDeliverableText(src.answer);
  if (answer) return { state: 'answer', text: answer };
  const reasoning = String(src.reasoning || '').trim();
  if (reasoning) {
    if (src.truncated) {
      return { state: 'reasoning-fallback', text: reasoningFallbackText(reasoning) };
    }
    return { state: 'synthesis', text: '' };
  }
  return { state: 'empty', text: TURN_EMPTY_REPLY_TEXT };
}

/** 账本可写文本：思考回退仅用于展示，落库回退为占位（§3.4「不写进 book」） */
function persistableTurnText(reply) {
  const text = String(reply == null ? '' : reply).trim();
  if (!text) return TURN_EMPTY_REPLY_TEXT;
  if (isReasoningFallbackText(text)) return TURN_EMPTY_REPLY_TEXT;
  return text;
}

/**
 * 交付/展示归一：正文优先，无正文时才显式回退（不再用长度启发式）。
 *
 * `fallbacks.reasoningFallback` / `fallbacks.toolFallback` 都是**已提取好的字符串**
 * （思考那项由 `reasoningTextFromTrace()` 这一单一来源产出），不接「函数」回调，
 * 免得再度出现同一策略「一处传函数、一处传字符串」的两套约定。
 */
function pickNormalizedAssistantReply(reply, trace, fallbacks) {
  const answer = deliverableAnswer(reply, trace);
  if (answer) return answer;
  const reasoning = String((fallbacks && fallbacks.reasoningFallback) || '').trim();
  if (reasoning) return reasoningFallbackText(reasoning);
  const tool = String((fallbacks && fallbacks.toolFallback) || '').trim();
  if (tool) return tool;
  return TURN_EMPTY_REPLY_TEXT;
}

const api = {
  TURN_REASONING_FALLBACK_LABEL,
  TURN_EMPTY_REPLY_TEXT,
  countTraceTools,
  needsAssistantReplySynthesis,
  synthesizedReplyIsUsable,
  normalizeDeliverableText,
  deliverableAnswer,
  reasoningTextFromTrace,
  reasoningFallbackText,
  isReasoningFallbackText,
  resolveTurnDelivery,
  persistableTurnText,
  pickNormalizedAssistantReply
};

module.exports = api;
