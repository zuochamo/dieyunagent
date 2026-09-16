'use strict';

const { chatCompletionJson } = require('../llm-proxy');
const { streamChatCompletionMain } = require('../llm-stream-utils');
const { isAbortError, createAbortError } = require('../llm-reconnect-retry');
const { getAgentLimits, AGENT_LIMITS_DEFAULTS } = require('./agent-limits');
const roundText = require('./agent-round-text');

const SYNTHESIS_PHASE = '汇总';
const SYNTHESIS_START = '正在生成最终答复…';
const SYNTHESIS_DONE = '已完成';
const SYNTHESIS_FAILED = '汇总未完成，见下方答复';

function resolveChatUrl(baseUrl) {
  const raw = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!raw) throw new Error('LLM baseUrl 未配置');
  if (/\/chat\/completions(?:\?|$)/i.test(raw)) return raw;
  if (/\/v\d+$/i.test(raw)) return `${raw}/chat/completions`;
  return `${raw}/v1/chat/completions`;
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

function thoughtFallbackFromTrace(trace) {
  const parts = [];
  for (const entry of trace || []) {
    if (String(entry.phase || '').trim() === SYNTHESIS_PHASE) continue;
    const text = String(entry.fullThought || entry.thought || '').trim();
    if (text.length <= 24) continue;
    if (/^(请求中|思考中|生成中|处理中|请求 LLM|正在生成最终答复)/.test(text)) continue;
    parts.push(text);
  }
  if (!parts.length) return '';
  return parts.slice(-4).join('\n\n');
}

function buildSynthesisDigest(trace) {
  const lines = [];
  for (const entry of trace || []) {
    const phase = String(entry.phase || '').trim();
    const prefix = phase ? `[${phase}] ` : '';
    const thought = String(entry.fullThought || entry.thought || '').trim();
    if (thought && thought.length > 16 && !/^(请求中|正在准备|生成中)/.test(thought)) {
      lines.push(`${prefix}${thought.slice(0, 500)}`);
    }
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
  const digest = buildSynthesisDigest(trace);
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
 * 工具轮结束后若无用户向正文，用思考兜底或补一轮无工具汇总。默认不调用；聊天 IPC 打开。
 */
async function applyTurnEndSynthesis(opts) {
  const done = opts.done || {};
  if (!done || done.overflowStopped || done.hitRoundLimit || done.aborted) {
    return done;
  }
  const content = String(done.content || '').trim();
  const trace = Array.isArray(done.trace) ? done.trace : [];
  const messages = Array.isArray(done.messages) ? done.messages : [];
  if (!roundText.needsAssistantReplySynthesis(content, trace)) {
    return done;
  }

  const thought = thoughtFallbackFromTrace(trace);
  if (roundText.thoughtFallbackCoversSynthesis(thought)) {
    return { ...done, content: thought };
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
      try {
        result = await streamChatCompletionMain(synthBody, {
          url,
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
          headers: {
            'Content-Type': 'application/json',
            ...(llm.apiKey ? { Authorization: `Bearer ${llm.apiKey}` } : {})
          },
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
  thoughtFallbackFromTrace,
  upsertSynthesisTraceRound
};
