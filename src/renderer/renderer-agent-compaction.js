/* global window, fetch, settings, gwState, gatewayCall, showAgentToast, executeAgentTool, formatToolArgsBrief, summarizeToolResult, TRACE_DESKTOP_THOUGHT_CHARS, getEffectiveInputBudget, getContextWindowTokens, getMaxOutputTokens, getContextReserveTokens, resolveComposerModelForSend, getCustomModelApiConfig, captureTurnBatchCheckpoint, isMutatingAgentTool, currentSessionId, noteContextCompaction, noteComposerSessionUsage, resolveComposerUsageSessionId, streamChatCompletion, fetchChatCompletion, upsertSynthesisTraceRound, getCurrentUndoTurnId, getUndoTurnIdForSession, supplierDisplayName, normalizeAgentToolName, compactDiffForTrace, getAgentLimits, trackArtifactsFromTrace, resolveSessionWorkspacePath, isWeakAssistantReply, AgentRoundText, formatModelFooterLabel, humanizeModelId, dismissAgentContinueRows, maybeShowProposeToolPreview, estimateMessagesTokens */
'use strict';

function estimateContextTokensFallback(msgs) {
  // token 估算单一来源（window.estimateMessagesTokens，见 src/agent/token-estimate.js）
  return estimateMessagesTokens(msgs || []);
}

const ESTIMATE_TOKENS_MESSAGE_CHAR_CAP = 16000;

/** 工具 schema 字符数：不计入 messages，但占真实窗口；交给压缩层从输入预算里扣。 */
function toolsSchemaChars(tools) {
  try {
    return Array.isArray(tools) ? JSON.stringify(tools).length : 0;
  } catch {
    return 0;
  }
}

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
    return estimateMessagesTokens(list);
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
      // 折叠不产出摘要文本（旧 LLM 摘要已删除）：归档只记「何时、省了多少」，
      // 内容本身仍在 messages 里（只是被截短），不需要第二份副本。
      summary:
        cr.level != null
          ? `折叠：${Number(cr.tokensBefore) || 0} → ${Number(cr.tokensAfter) || 0} token（L${cr.level}）`
          : null,
      foldedTranscript: null
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
    toolsChars: Number(opts.toolsChars) || 0,
    sessionId: opts.sessionId || null,
    model: opts.model || '',
    // 服务端 usage 优先（Renderer 上一轮响应带下来的）；没有就是 null，由 Rust 回落到估值
    observedPromptTokens: opts.observedPromptTokens
  });
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
      toolsChars: toolsSchemaChars(body.tools),
      ...opts
    });
  } catch (err) {
    if (isUserAbortError(err) || (err && err.name === 'AbortError')) throw err;
    console.warn('context compaction skipped', err);
    const llmError = String(err && err.message ? err.message : err || 'compaction failed');
    return { compacted: false, skipped: 'error', llmError };
  }
  if (cr.foldSkipped) {
    // 折叠是纯本地 CPU 操作：唯一的失败形态是 core 侧 RPC 出错（不像旧 LLM 摘要会被审核拦截）
    return {
      compacted: false,
      skipped: cr.foldSkipped,
      foldError: cr.foldError ? String(cr.foldError) : undefined
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
        : '较早的工具输出已折叠，可继续当前任务';
    showAgentToast('上下文已压缩', detail, { variant: 'info' });
    return { compacted: true, tokensBefore: cr.tokensBefore, tokensAfter: cr.tokensAfter };
  }
  return { compacted: false };
}
