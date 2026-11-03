'use strict';

const { chatCompletionJson } = require('../llm-proxy');
const { streamChatCompletionMain } = require('../llm-stream-utils');
const { isAbortError, createAbortError } = require('../llm-reconnect-retry');
const { getAgentLimits, AGENT_LIMITS_DEFAULTS } = require('./agent-limits');
const { buildLlmHeadersFromConfig, resolveLlmEndpoint } = require('./llm-request');
const roundText = require('./agent-round-text');

// 汇总步骤的 phase 名与展示文案：单一来源 agent-round-text（Renderer 展示同一个常量）
const {
  SYNTHESIS_PHASE,
  SYNTHESIS_START,
  SYNTHESIS_DONE,
  SYNTHESIS_FAILED
} = roundText;

function resolveChatUrl(baseUrl) {
  // 端点拼接单一来源 llm-request.js；此处只保留「必填」语义
  const url = resolveLlmEndpoint(baseUrl, 'chat');
  if (!url) throw new Error('LLM baseUrl 未配置');
  return url;
}

function extractLastUserMessageText(messages) {
  for (let i = (messages || []).length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m || m.role !== 'user') continue;
    const c = m.content;
    let text = '';
    if (typeof c === 'string') text = c.trim();
    else if (Array.isArray(c)) {
      text = c
        .filter((x) => x && x.type === 'text' && x.text)
        .map((x) => String(x.text))
        .join('\n')
        .trim();
    }
    if (!text) continue;
    if (text.startsWith('[系统]') || text.startsWith('【完成验收】')) continue;
    return text;
  }
  return '';
}

/**
 * 工具事实摘要：**只由工具调用记录构成，不含思考**。
 *
 * 这是跨边界文本（回注协调者 / 作为汇总 LLM 的输入）的唯一构造口，契约见
 * `docs/REASONING-ISOLATION-PLAN.md` §3.7：跨边界只允许「正文 ∪ 工具事实」——
 * 思考是私有推理（含过程猜测与元评论），越界就会被下游当成事实使用，
 * 且会经由「汇总 LLM 写正文」间接把思考写进用户可见答复。
 *
 * 材料只有 `entry.tools[]` 的 `name` / `summary` / `error` / `argsBrief`（工具层已归纳的事实），
 * 不读 `entry.thought` / `entry.fullThought`，也不依赖任何过场文案正则。
 */
function buildTraceFactsDigest(trace) {
  const lines = [];
  for (const entry of trace || []) {
    for (const t of entry.tools || []) {
      const name = String(t.name || 'tool').trim();
      const sum = String(t.summary || t.error || t.argsBrief || '已执行').trim();
      lines.push(`- 工具 ${name}: ${sum.slice(0, 240)}`);
    }
  }
  return lines.join('\n').slice(0, 8000);
}

function buildAgentSynthesisBody({ model, messages, trace, maxOutputTokens }) {
  const userText = extractLastUserMessageText(messages).slice(0, 2500);
  const digest = buildTraceFactsDigest(trace);
  const userParts = [];
  if (userText) userParts.push(`【用户任务】\n${userText}`);
  userParts.push(`【Agent 执行过程摘要】\n${digest || '(无详细 trace)'}`);
  userParts.push('请根据以上信息，用面向用户的 Markdown 写出最终答复。');
  const maxTokens =
    typeof maxOutputTokens === 'number' && maxOutputTokens > 0
      ? Math.min(2048, maxOutputTokens)
      : 2048;
  return {
    model,
    messages: [
      {
        role: 'system',
        content:
          '你是叠云 Agent 的最终汇总助手。工具执行细节已在上方折叠区展示；你的任务是写用户直接阅读的最终答复。\n\n' +
          '要求：\n' +
          '- 必须直接回答【用户任务】里的问题，禁止只写「已完成。」或空话\n' +
          '- 说明完成了什么、关键结果；如有代码/文件变更请简要列出\n' +
          '- 若写不了文件或工具失败，如实说明是否权限/路径/工作区问题，不要假装成功\n' +
          '- 若适合，用简短 Markdown 列表或表格\n' +
          '- 不要粘贴原始命令输出、大段日志或 tool_call XML\n' +
          '- 不要写「已完成工具调用」类系统提示\n' +
          '- 若任务未完成或失败，如实说明卡点与建议下一步'
      },
      { role: 'user', content: userParts.join('\n\n') }
    ],
    temperature: 0.3,
    max_tokens: maxTokens
  };
}

function upsertSynthesisTraceRound(trace, { streaming, failed }) {
  const next = Array.isArray(trace) ? trace.map((e) => ({ ...e, tools: (e.tools || []).slice() })) : [];
  let idx = -1;
  for (let i = next.length - 1; i >= 0; i--) {
    if (String(next[i].phase || '').trim() === SYNTHESIS_PHASE) {
      idx = i;
      break;
    }
  }
  let entry;
  if (idx >= 0) {
    entry = next[idx];
  } else {
    entry = {
      round: next.length + 1,
      phase: SYNTHESIS_PHASE,
      thought: SYNTHESIS_START,
      fullThought: SYNTHESIS_START,
      tools: []
    };
    next.push(entry);
  }
  if (streaming) {
    entry.thought = SYNTHESIS_START;
    entry.fullThought = SYNTHESIS_START;
  } else if (failed) {
    entry.thought = SYNTHESIS_FAILED;
    entry.fullThought = SYNTHESIS_FAILED;
  } else {
    entry.thought = SYNTHESIS_DONE;
    entry.fullThought = SYNTHESIS_DONE;
  }
  return next;
}

function usableSynth(text) {
  return roundText.synthesizedReplyIsUsable(String(text || '').trim());
}

/**
 * 工具轮结束后若无用户向正文：交付由 `resolveTurnDelivery()`（§3.4）决定 ——
 * 截断且只有思考 → 带标签的思考引用（仅展示）；正常收尾且有工具轮 → 补一轮无工具汇总 LLM。
 * 默认不调用；聊天 IPC 打开。
 */
async function applyTurnEndSynthesis(opts) {
  const done = opts.done || {};
  const content = String(done.content || '').trim();
  const trace = Array.isArray(done.trace) ? done.trace : [];
  const messages = Array.isArray(done.messages) ? done.messages : [];
  const truncated = !!(done.overflowStopped || done.hitRoundLimit || done.aborted);
  // 四态交付决策单一来源（§3.4）：answer 直接交付；截断轮显式思考回退；
  // 正常收尾且确有工具轮时，才走无工具汇总 LLM。
  const delivery = roundText.resolveTurnDelivery({
    answer: roundText.deliverableAnswer(content, trace),
    reasoning: roundText.reasoningTextFromTrace(trace),
    truncated
  });
  if (delivery.state === 'reasoning-fallback') {
    return { ...done, content: delivery.text };
  }
  if (delivery.state !== 'synthesis') {
    return done;
  }
  if (!roundText.needsAssistantReplySynthesis(content, trace)) {
    return done;
  }

  const onPhase = typeof opts.onPhase === 'function' ? opts.onPhase : () => {};
  const llm = opts.llm || {};
  const signal = opts.signal || null;
  const limits = getAgentLimits(opts.userData);
  const timeoutMs = Number(limits.synthesisTimeoutMs) || AGENT_LIMITS_DEFAULTS.synthesisTimeoutMs;
  const model = String(opts.model || done.model || '').trim();
  const synthBody = buildAgentSynthesisBody({
    model: model || 'unknown',
    messages,
    trace,
    maxOutputTokens: 2048
  });

  onPhase('synthesis_start', { runId: done.runId, trace: upsertSynthesisTraceRound(trace, { streaming: true }) });

  const child = new AbortController();
  const onParentAbort = () => {
    try {
      child.abort();
    } catch {
      // ignore
    }
  };
  if (signal) {
    if (signal.aborted) child.abort();
    else if (typeof signal.addEventListener === 'function') {
      signal.addEventListener('abort', onParentAbort, { once: true });
    }
  }
  const timer = setTimeout(() => {
    try {
      child.abort();
    } catch {
      // ignore
    }
  }, timeoutMs);

  let live = '';
  try {
    let result;
    if (typeof opts.fetchSynthesisOnce === 'function') {
      result = await opts.fetchSynthesisOnce({ body: synthBody, signal: child.signal });
    } else {
      const url = resolveChatUrl(llm.baseUrl);
      const headers = buildLlmHeadersFromConfig(llm, { runId: done.runId });
      try {
        result = await streamChatCompletionMain(synthBody, {
          url,
          headers,
          apiKey: llm.apiKey,
          signal: child.signal,
          onDelta: (delta) => {
            live = String((delta && delta.content) || '').trim();
            onPhase('synthesis_delta', { runId: done.runId, content: live });
          }
        });
      } catch (streamErr) {
        if (isAbortError(streamErr) || (streamErr && streamErr.name === 'AbortError')) {
          throw streamErr;
        }
        const json = await chatCompletionJson(url, {
          headers,
          body: JSON.stringify({ ...synthBody, stream: false }),
          signal: child.signal
        });
        const choice = json && json.choices && json.choices[0];
        const msg = (choice && choice.message) || {};
        result = { content: msg.content != null ? String(msg.content) : '' };
      }
    }
    const synthesized = String((result && result.content) || live || '').trim();
    if (usableSynth(synthesized)) {
      const nextTrace = upsertSynthesisTraceRound(trace, { streaming: false });
      onPhase('synthesis_done', { runId: done.runId, content: synthesized, trace: nextTrace });
      return { ...done, content: synthesized, trace: nextTrace };
    }
    const failedTrace = upsertSynthesisTraceRound(trace, { streaming: false, failed: true });
    onPhase('synthesis_done', { runId: done.runId, failed: true, trace: failedTrace });
    return { ...done, trace: failedTrace };
  } catch (err) {
    if (isAbortError(err) || (err && err.name === 'AbortError')) {
      throw createAbortError();
    }
    const failedTrace = upsertSynthesisTraceRound(trace, { streaming: false, failed: true });
    onPhase('synthesis_done', { runId: done.runId, failed: true, trace: failedTrace });
    if (usableSynth(live)) {
      return { ...done, content: live, trace: failedTrace };
    }
    return { ...done, trace: failedTrace };
  } finally {
    clearTimeout(timer);
    if (signal && typeof signal.removeEventListener === 'function') {
      signal.removeEventListener('abort', onParentAbort);
    }
  }
}

module.exports = {
  applyTurnEndSynthesis,
  buildAgentSynthesisBody,
  buildTraceFactsDigest,
  extractLastUserMessageText,
  upsertSynthesisTraceRound
};
