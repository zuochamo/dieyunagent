'use strict';

const STATUS_VALUES = 'continue|final|blocked|ask_user';
const STATUS_LINE_RE = new RegExp(
  '^\\s*(?:\\[)?agent_status(?:\\])?\\s*[:=]\\s*(' + STATUS_VALUES + ')\\s*(?:\\])?\\s*(?:\\r?\\n|$)',
  'i'
);
const STATUS_TAG_RE = new RegExp(
  '^\\s*<agent_status>\\s*(' + STATUS_VALUES + ')\\s*</agent_status>\\s*',
  'i'
);
const STATUS_LINE_PREFIX_RE = /^\s*(?:\[)?agent_status(?:\])?\s*[:=]/i;
const MIN_DUP_CHARS = 12;
const MIN_RECORDED_PLAN_CHARS = 80;

function collapseWs(text) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function splitParas(text) {
  return String(text || '')
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
}

function isPassthroughThought(text) {
  const t = String(text || '').trim();
  if (!t || t === '…') return true;
  return /^(请求中|思考中|生成中|处理中|启动|等待|连接中断|请求 LLM|多模态识图|执行工具)/.test(t);
}

function parseAgentStatusEnvelope(content) {
  const raw = String(content || '').trim();
  const empty = { status: '', content: raw };
  if (!raw) return empty;

  const line = raw.match(STATUS_LINE_RE);
  if (line) {
    return {
      status: line[1].toLowerCase(),
      content: raw.slice(line[0].length).trim()
    };
  }

  const tag = raw.match(STATUS_TAG_RE);
  if (tag) {
    return {
      status: tag[1].toLowerCase(),
      content: raw.slice(tag[0].length).trim()
    };
  }

  const firstNl = raw.search(/\r?\n/);
  const firstLine = firstNl >= 0 ? raw.slice(0, firstNl) : raw;
  if (STATUS_LINE_PREFIX_RE.test(firstLine) && firstNl < 0) {
    return { status: '', content: '' };
  }

  return empty;
}

function stripAgentStatusLine(text) {
  return parseAgentStatusEnvelope(text).content;
}

function remainderAfterPrefix(current, previous) {
  const cur = String(current || '').trim();
  const prev = String(previous || '').trim();
  if (!prev || !cur) return cur;
  if (cur === prev) return '';
  if (cur.startsWith(prev)) return cur.slice(prev.length).trim();
  const curN = collapseWs(cur);
  const prevN = collapseWs(prev);
  if (curN === prevN) return '';
  if (prevN.startsWith(curN) && curN.length >= MIN_DUP_CHARS) return '';
  if (curN.startsWith(prevN) && prevN.length >= MIN_DUP_CHARS) {
    const paras = splitParas(cur);
    const prevParas = splitParas(prev);
    let i = 0;
    while (i < paras.length && i < prevParas.length && collapseWs(paras[i]) === collapseWs(prevParas[i])) {
      i += 1;
    }
    if (i > 0) return paras.slice(i).join('\n\n').trim();
  }
  return cur;
}

function stripRepeatedAgentPreamble(current, previous) {
  const cur = stripAgentStatusLine(current).trim();
  const prev = stripAgentStatusLine(previous).trim();
  if (!cur) return '';
  if (!prev) return cur;

  const afterPrefix = remainderAfterPrefix(cur, prev);
  if (afterPrefix !== cur) return afterPrefix;

  const prevN = collapseWs(prev);
  const paras = splitParas(cur);
  let i = 0;
  while (i < paras.length) {
    const p = paras[i];
    const pN = collapseWs(p);
    if (pN.length < MIN_DUP_CHARS) {
      if (prevN.includes(pN)) {
        i += 1;
        continue;
      }
      break;
    }
    if (prevN.includes(pN)) {
      i += 1;
      continue;
    }
    break;
  }
  if (i === 0) return cur;
  return paras.slice(i).join('\n\n').trim();
}

function sanitizeAgentThoughtText(text, previousTexts) {
  const raw = String(text || '');
  if (isPassthroughThought(raw)) return raw.trim();
  let out = stripAgentStatusLine(raw).trim();
  const prevList = Array.isArray(previousTexts) ? previousTexts : [];
  for (const prev of prevList) {
    if (!prev || isPassthroughThought(prev)) continue;
    out = stripRepeatedAgentPreamble(out, prev);
    if (!out) break;
  }
  return out;
}

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
 * 从 trace 取本轮真思考（单一来源）：跳过汇总轮与占位思考，取最近若干段拼接。
 *
 * 不做长度过滤 —— 「本轮有没有思考」是四态交付的判定输入（§3.4），短思考也是思考；
 * 噪声由 `isPassthroughThought`（UI 占位文案）拦住，而不是靠长度阈值。
 * 既用于交付兜底，也用于账本 `reasoning` 落库（§3.5）。
 */
function reasoningTextFromTrace(trace) {
  const parts = [];
  for (const entry of trace || []) {
    const phase = String((entry && entry.phase) || '').trim();
    if (phase === SYNTHESIS_PHASE) continue;
    const text = String((entry && (entry.fullThought || entry.thought)) || '').trim();
    if (!text) continue;
    if (isPassthroughThought(text)) continue;
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
  MIN_DUP_CHARS,
  MIN_RECORDED_PLAN_CHARS,
  TURN_REASONING_FALLBACK_LABEL,
  TURN_EMPTY_REPLY_TEXT,
  parseAgentStatusEnvelope,
  stripAgentStatusLine,
  stripRepeatedAgentPreamble,
  sanitizeAgentThoughtText,
  isPassthroughThought,
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
