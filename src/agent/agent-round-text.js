(function (root) {
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

  /** 思考正文已足够当交付时，跳过额外汇总 LLM */
  function thoughtFallbackCoversSynthesis(thought) {
    const t = String(thought || '').trim();
    return synthesizedReplyIsUsable(t) && t.length >= 48;
  }

  function pickNormalizedAssistantReply(reply, trace, fallbacks) {
    let text = String(reply || '').trim();
    if (text === '(空响应)') text = '';
    const thought = String((fallbacks && fallbacks.thoughtFallback) || '').trim();
    const tool = String((fallbacks && fallbacks.toolFallback) || '').trim();
    if (text && needsAssistantReplySynthesis(text, trace)) {
      if (thoughtFallbackCoversSynthesis(thought)) return thought;
      text = '';
    }
    if (text) return text;
    if (thoughtFallbackCoversSynthesis(thought) || thought.length >= 24) return thought;
    if (tool) return tool;
    return '（模型未生成文字答复。）';
  }

  const api = {
    MIN_DUP_CHARS,
    MIN_RECORDED_PLAN_CHARS,
    parseAgentStatusEnvelope,
    stripAgentStatusLine,
    stripRepeatedAgentPreamble,
    sanitizeAgentThoughtText,
    isPassthroughThought,
    countTraceTools,
    needsAssistantReplySynthesis,
    synthesizedReplyIsUsable,
    thoughtFallbackCoversSynthesis,
    pickNormalizedAssistantReply
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (typeof window !== 'undefined') {
    window.AgentRoundText = api;
  } else if (root) {
    root.AgentRoundText = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
