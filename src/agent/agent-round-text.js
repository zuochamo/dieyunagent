'use strict';

function countTraceTools(trace) {
  return (trace || []).reduce((n, e) => n + ((e && e.tools) || []).length, 0);
}

/**
 * 残留 tool_call 标记 —— 上游把「工具调用」当文本发回来时，content 里会留下这些标记。
 *
 * 只认**结构形态**，不认中英文词表：
 * 1. 明文 XML：`<tool_call>` / `</invoke>` / `<function_call>`；
 * 2. 渠道特殊 token：`<|tool_calls|>`、`<| |DSML| | invoke name=…>`（DeepSeek chat template
 *    的特殊标记，正常应由上游转成结构化 `tool_calls`；一旦落进 content 就是泄漏）；
 * 3. 历史兼容：`<function=`、全角 `｜DSML｜`。
 *
 * 为什么 `<` 与关键字之间要允许 `|` / 空格：真实的泄漏形态是 `<| |DSML| | invoke`，旧正则
 * 要求 `<` 紧跟关键字，于是整段标记被当成正文交付（2026-11-19 子 Agent 事故：那条
 * `host_exec` 从未执行，泄漏文本却被回注主上下文当结论）。
 *
 * 为什么 `function=` **不能**单独成一枝：它是标记里才有的形态，但正文里也会出现
 * （`GET /api/x?function=getUser`、讲代码时说「把 function= 这一项删掉」）—— 裸匹配会让
 * 正常结论被判成泄漏，planner 汇总轮于是把整段正文换成空串再重问一遍。
 */
const TOOL_CALL_MARKUP_RE = new RegExp(
  [
    '</?(?:tool_calls?|invoke|function_call)\\b',
    '<\\s*function=',
    '<\\/?\\s*[|｜]?\\s*[|｜]?\\s*(?:tool_calls?|invoke|parameter|DSML|antml)\\b',
    '[|｜]DSML[|｜]'
  ].join('|'),
  'i'
);

/** 首个残留标记的位置（-1 = 没有）。需要「标记之前的正文」的调用方用它，别另写正则。 */
function toolCallMarkupIndex(text) {
  const match = TOOL_CALL_MARKUP_RE.exec(String(text || ''));
  return match ? match.index : -1;
}

function replyHasToolCallMarkup(text) {
  return toolCallMarkupIndex(text) >= 0;
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

/**
 * 汇总轮产出：非空且无 tool_call 标记即可采用。
 *
 * 这里**没有长度门槛**：以前是 `t.length >= 8`，会把「已完成。」「修好了。」这种短但完整的
 * 汇总判成不可用、再退回占位文案 —— 判据是「有没有正文」，不是「正文够不够长」。
 */
function synthesizedReplyIsUsable(text) {
  const t = String(text || '').trim();
  if (!t || t === '(空响应)') return false;
  if (replyHasToolCallMarkup(t)) return false;
  return true;
}

const TURN_REASONING_FALLBACK_LABEL = '（以下为模型思考，本轮未成文）';
const TURN_EMPTY_REPLY_TEXT = '（模型未生成文字答复。）';

/**
 * 汇总（synthesis）步骤的 phase 名与三句展示文案的**唯一来源**。
 *
 * 以前 Main（`agent-synthesis.js`）与 Renderer（`renderer-thinking-trace.js`）各写一份，
 * 改一处文案另一处不改就会出现「同一轮汇总在两侧说法不同」。它们只描述「汇总这一步」，
 * 与「汇总要不要跑」的判定无关，所以落在交付文本模块而不是 agent-synthesis（后者带着
 * core 桥 / 出网依赖，进不了 renderer bundle）。
 */
const SYNTHESIS_PHASE = '汇总';
const SYNTHESIS_START = '正在生成最终答复…';
const SYNTHESIS_DONE = '已完成';
const SYNTHESIS_FAILED = '汇总未完成，见下方答复';
/**
 * planner 前置判定（「这一轮要不要拆成多路并行」）在思考区的那一张卡的 phase 名。
 *
 * 唯一来源：planner 侧（`rust-planner-runner.js`，判定为「拆」时写）与 Renderer 侧
 * （`renderer-agent-send.js`，判定为「不拆」时补同一张卡）都用它 —— 两边各写一份中文
 * 就会变成「同一件事在思考区有两个名字」。
 */
const PLANNER_ROUTE_PHASE = '调度 · 侧模型判定';
/**
 * 「模型执行途中自己要求改道」（`fan_out`）在思考区的那一张卡的 phase 名。
 *
 * 与 `PLANNER_ROUTE_PHASE` 分开是有意的：一个是「开跑前判定器说不拆/拆」，
 * 一个是「跑到一半模型自己说该拆」—— 两者的责任方不同，混成一个名字就查不出是谁拍的板。
 */
const PLANNER_HANDOFF_PHASE = '调度 · 中途改道';
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
 * 中途改道工具名（模型在执行途中声明「这活该拆成多路并行写入」）。
 *
 * 声明与执行分居两侧：工具本身只在 `main-tools/agent-mode.js` 里登记意图，
 * 真正的切换由 Renderer 读到本轮 trace 里的这次调用后完成（`findFanOutRequest`）。
 */
const FAN_OUT_TOOL_NAME = 'fan_out';

/**
 * 从本轮 trace 里读「模型要求中途改道」。
 *
 * 只认**结构化调用记录**（`entry.tools[]` 的 name + 参数），不扫正文、不看措辞 ——
 * 模型在文字里说「我要拆开做」不算数，只有真的调用了工具才算（否则就是在替它猜）。
 *
 * @param {Array} trace
 * @returns {{reason: string, subtasks: Array} | null}
 */
function findFanOutRequest(trace) {
  for (const entry of trace || []) {
    for (const t of (entry && entry.tools) || []) {
      if (String((t && t.name) || '').trim() !== FAN_OUT_TOOL_NAME) continue;
      const args = (t && (t.toolArgs || t.args)) || {};
      const reason = String(args.reason || '').replace(/\s+/g, ' ').trim();
      const subtasks = Array.isArray(args.subtasks) ? args.subtasks : [];
      return {
        reason: reason || '模型判断这件事需要拆成多路并行执行',
        subtasks
      };
    }
  }
  return null;
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
 * 落库前的 trace 瘦身：只去掉**纯展示用**的字段（`liveNote` = 流式期间的临时旁注）。
 *
 * 为什么要有单一实现：桌面聊天（Renderer 的 `agent/trace-store.js`）与 Main 侧轮次
 * （心跳 / 频道 / headless 的 `main-turn-runner.js`）都要把同一份结构化 trace 写进
 * `agent_traces`；两处各写一份 map，迟早一边漏字段、一边把展示字段也存进库。
 * 唯一入口在这里，两侧都调它。
 */
function stripTraceUiOnlyFields(trace) {
  return (Array.isArray(trace) ? trace : []).map((entry) => {
    if (!entry || typeof entry !== 'object' || entry.liveNote == null) return entry;
    const next = { ...entry };
    delete next.liveNote;
    return next;
  });
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

/**
 * 「这一轮什么都没交付」的失败文案 —— **唯一措辞**。
 *
 * 计划执行器（`plans/plan-agent-runner`）与 Main 跑一轮（`main-turn-runner`：频道 / headless）
 * 都用它。同一件事以前两种说法（一边「请查看日志后重跑」、一边「请查看日志后重试」），
 * 而这句话是直接给用户看的。
 *
 * @param {number} toolCount 本轮实际发生的工具调用次数（>0 说明模型动了手却没写正文）
 */
function emptyTurnFailureMessage(toolCount) {
  const n = Math.max(0, Number(toolCount) || 0);
  return n
    ? `模型执行了 ${n} 次工具调用但未生成任何正文，请查看日志后重试`
    : '模型未返回任何正文（上游可能拒绝请求或额度已用尽），请稍后重试';
}

const api = {
  TURN_REASONING_FALLBACK_LABEL,
  TURN_EMPTY_REPLY_TEXT,
  SYNTHESIS_PHASE,
  SYNTHESIS_START,
  SYNTHESIS_DONE,
  SYNTHESIS_FAILED,
  PLANNER_ROUTE_PHASE,
  PLANNER_HANDOFF_PHASE,
  FAN_OUT_TOOL_NAME,
  findFanOutRequest,
  TOOL_CALL_MARKUP_RE,
  countTraceTools,
  toolCallMarkupIndex,
  replyHasToolCallMarkup,
  needsAssistantReplySynthesis,
  synthesizedReplyIsUsable,
  normalizeDeliverableText,
  deliverableAnswer,
  reasoningTextFromTrace,
  reasoningFallbackText,
  isReasoningFallbackText,
  resolveTurnDelivery,
  persistableTurnText,
  stripTraceUiOnlyFields,
  pickNormalizedAssistantReply,
  emptyTurnFailureMessage
};

module.exports = api;
