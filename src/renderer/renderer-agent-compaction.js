/* global window, fetch, settings, gwState, gatewayCall, showAgentToast, executeAgentTool, formatToolArgsBrief, summarizeToolResult, TRACE_DESKTOP_THOUGHT_CHARS, getEffectiveInputBudget, getContextWindowTokens, getMaxOutputTokens, getContextReserveTokens, resolveComposerModelForSend, getCustomModelApiConfig, captureTurnBatchCheckpoint, isMutatingAgentTool, currentSessionId, shouldBlockRepeatToolCall, recordToolCallFingerprint, repeatToolBlockMessage, noteContextCompaction, noteComposerSessionUsage, resolveComposerUsageSessionId, streamChatCompletion, fetchChatCompletion, upsertSynthesisTraceRound, getComposerLongHorizon, getCurrentUndoTurnId, getUndoTurnIdForSession, supplierDisplayName, normalizeAgentToolName, syncLiveWriteFromTrace, compactDiffForTrace, getAgentLimits, trackArtifactsFromTrace, resolveSessionWorkspacePath, isWeakAssistantReply, AgentRoundText, formatModelFooterLabel, humanizeModelId, scaleLimitForLongHorizon, dismissAgentContinueRows, maybeShowProposeToolPreview */
'use strict';

function estimateContextTokensFallback(msgs) {
  return (msgs || []).reduce((sum, m) => {
    const content = Array.isArray(m.content)
      ? m.content
          .map((part) => {
            if (typeof part === 'string') return part;
            if (part && typeof part === 'object') return part.text || part.content || '';
            return '';
          })
          .join('\n')
      : m.content;
    return sum + Math.ceil(String(content || '').length / 3.2) + 6;
  }, 0);
}

const ESTIMATE_TOKENS_MESSAGE_CHAR_CAP = 16000;

function truncateMessagesForContextEstimate(messages) {
  const cap = ESTIMATE_TOKENS_MESSAGE_CHAR_CAP;
  return (messages || []).map((m) => {
    let content = m.content;
    if (Array.isArray(content)) {
      content = content
        .map((part) => {
          if (typeof part === 'string') return part;
          if (part && typeof part === 'object') return part.text || part.content || '';
          return '';
        })
        .join('\n');
    }
    const text = String(content || '');
    if (text.length <= cap) return { role: m.role, content: text };
    return { role: m.role, content: `${text.slice(0, cap)}…` };
  });
}

async function estimateMessagesTokensViaMain(messages) {
  const list = Array.isArray(messages) ? messages : [];
  let chars = 0;
  for (const m of list) {
    chars += String(
      Array.isArray(m && m.content)
        ? m.content.map((p) => (typeof p === 'string' ? p : (p && (p.text || p.content)) || '')).join('\n')
        : (m && m.content) || ''
    ).length;
  }
  if (chars > 48000) {
    return Math.ceil(chars / 3.2) + list.length * 6;
  }
  const msgs = truncateMessagesForContextEstimate(list);
  if (typeof window.diecloud?.compactionEstimateTokens === 'function') {
    try {
      const r = await window.diecloud.compactionEstimateTokens({ messages: msgs });
      const n = Number(r && r.tokens);
      if (Number.isFinite(n) && n >= 0) return n;
    } catch {
      // sidecar 忙/超时：UI 圆环走本地启发式
    }
  }
  return estimateContextTokensFallback(msgs);
}

function resetCompactionStateSafe(sessionId) {
  try {
    const sid =
      sessionId != null && String(sessionId).trim()
        ? String(sessionId).trim()
        : currentSessionId || null;
    if (typeof window.diecloud?.compactionResetState === 'function') {
      window.diecloud.compactionResetState(sid).catch(() => {});
    }
  } catch {
    // ignore
  }
}

function resetCompactionInstances() {
  resetCompactionStateSafe();
}

async function persistCompactionArchive(cr, opts = {}) {
  const sid =
    opts.sessionId != null && String(opts.sessionId).trim()
      ? String(opts.sessionId).trim()
      : null;
  if (!gwState.authed || !sid || !cr || !cr.compacted) return;
  try {
    let workspacePath = opts.workspacePath || opts.runWorkspaceRoot || null;
    if (!workspacePath && typeof resolveSessionWorkspacePath === 'function') {
      try {
        workspacePath = await resolveSessionWorkspacePath(sid);
      } catch {
        workspacePath = null;
      }
    }
    // 有 sessionId 时禁止回落到当前视图工作区
    if (!workspacePath && !opts.sessionId && agentApi.getWorkspace) {
      const ws = await agentApi.getWorkspace().catch(() => null);
      workspacePath = ws && ws.workspacePath ? ws.workspacePath : null;
    }
    await gatewayCall('memory.compaction_archive', {
      sessionId: sid,
      workspacePath,
      tokensBefore: cr.tokensBefore,
      tokensAfter: cr.tokensAfter,
      summary: cr.summary || null,
      foldedTranscript: cr.foldedTranscript || null
    });
  } catch (e) {
    console.warn('compaction archive failed', e);
  }
}

async function maybeCompactMessagesViaMain(messages, opts = {}) {
  if (typeof window.diecloud?.compactionMaybeCompact !== 'function') {
    const e = new Error('compaction IPC 不可用');
    e.code = 'COMPACTION_IPC_UNAVAILABLE';
    throw e;
  }
  return window.diecloud.compactionMaybeCompact({
    messages,
    tokenBudget: opts.tokenBudget || getEffectiveInputBudget(),
    force: !!opts.force,
    sessionId: opts.sessionId || null,
    model: opts.model || '',
    apiConfig: opts.apiConfig || {
      baseUrl: settings?.baseUrl,
      apiKey: settings?.apiKey
    }
  });
}

function shortenCompactionLlmMessage(raw) {
  let s = String(raw || '').trim();
  if (!s) return '模型请求失败';
  const jsonIdx = s.indexOf('{');
  if (jsonIdx > 24) s = s.slice(0, jsonIdx).trim().replace(/[:\s]+$/, '');
  if (/504|gateway timeout|provider request timeout/i.test(s)) {
    return '模型网关超时 (HTTP 504)';
  }
  if (/503|service unavailable/i.test(s)) return '模型服务暂不可用 (HTTP 503)';
  if (/502|bad gateway/i.test(s)) return '模型网关错误 (HTTP 502)';
  if (/429|rate limit|too many requests/i.test(s)) return '模型请求过于频繁 (HTTP 429)';
  if (/timeout|timed?\s*out|超时/i.test(s)) return '模型请求超时';
  return s.slice(0, 140);
}

function formatCompactionProgressNote(payload) {
  if (!payload || typeof payload !== 'object') return '';
  const kind = String(payload.kind || '');
  const msg = shortenCompactionLlmMessage(payload.message || '');
  if (kind === 'llm_retry') {
    const waitSec = Math.max(1, Math.round(Number(payload.waitMs || 0) / 1000) || 1);
    const attempt = Number(payload.attempt);
    const attemptLabel = Number.isFinite(attempt) && attempt > 0 ? `第 ${attempt} 次` : '重试';
    return `${msg}，${waitSec}s 后重试（${attemptLabel}）`;
  }
  if (kind === 'llm_skip') {
    return `已跳过压缩：${msg}`;
  }
  return msg;
}

function applyCompactionProgressToThinking(payload) {
  const note = formatCompactionProgressNote(payload);
  if (!note || typeof agentPrepStepNote !== 'function') return note;
  if (typeof sessionActiveRuns !== 'undefined' && sessionActiveRuns && typeof sessionActiveRuns.entries === 'function') {
    for (const [sid, live] of sessionActiveRuns.entries()) {
      if (!live || live.finished) continue;
      const step = (live.prepSteps || []).find((s) => s && s.id === 'compact' && s.status === 'active');
      if (step) agentPrepStepNote(sid, 'compact', note);
    }
  } else if (currentSessionId) {
    agentPrepStepNote(currentSessionId, 'compact', note);
  }
  return note;
}

async function applyContextCompaction(body, opts = {}) {
  if (!body || !Array.isArray(body.messages)) {
    return { compacted: false };
  }
  let cr;
  try {
    cr = await maybeCompactMessagesViaMain(body.messages, {
      tokenBudget: getEffectiveInputBudget(),
      model: body.model,
      sessionId: opts.sessionId || undefined,
      ...opts
    });
  } catch (err) {
    if (isUserAbortError(err) || (err && err.name === 'AbortError')) throw err;
    console.warn('context compaction skipped', err);
    const llmError = String(err && err.message ? err.message : err || 'compaction failed');
    return { compacted: false, skipped: 'error', llmError };
  }
  if (cr.compactionSkipped === 'content_policy') {
    showAgentToast(
      '上下文压缩被供应商拦截',
      '内容审核未通过，已跳过压缩继续请求。建议新开对话或换中转；若仍失败请缩短历史。',
      { variant: 'warn' }
    );
    return { compacted: false, skipped: 'content_policy' };
  }
  if (cr.compactionSkipped === 'llm_error' || cr.llmError) {
    return {
      compacted: false,
      skipped: 'llm_error',
      llmError: String(cr.llmError || 'compaction LLM failed')
    };
  }
  if (cr.compacted) {
    body.messages = cr.messages;
    persistCompactionArchive(cr, opts).catch(() => {});
    if (typeof noteContextCompaction === 'function') {
      noteContextCompaction(cr, opts.sessionId);
    }
    const before = Number(cr.tokensBefore);
    const after = Number(cr.tokensAfter);
    const detail =
      Number.isFinite(before) && Number.isFinite(after)
        ? `messages 约 ${Math.round(before).toLocaleString()} → ${Math.round(after).toLocaleString()} tokens；工具定义另计，圆环仍可能偏红`
        : '较早对话已摘要归档，可继续当前任务';
    showAgentToast('上下文已压缩', detail, { variant: 'info' });
    return { compacted: true, tokensBefore: cr.tokensBefore, tokensAfter: cr.tokensAfter };
  }
  return { compacted: false };
}

async function maybeCompactBodyIfHeavy(body, opts = {}) {
  if (!body || !Array.isArray(body.messages) || body.messages.length < 8) {
    return { compacted: false };
  }
  try {
    return await applyContextCompaction(body, opts);
  } catch (err) {
    if (isUserAbortError(err) || (err && err.name === 'AbortError')) throw err;
    console.warn('mid-loop compaction skipped', err);
    return { compacted: false, skipped: 'error', llmError: String(err && err.message ? err.message : err) };
  }
}
