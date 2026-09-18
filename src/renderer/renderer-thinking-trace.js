/* global document, tracePrefs, entryHasShellTool, entryHasEditTool, isEditToolName, getAgentContinueState, currentSessionId, resumeAgentToolLoop, renderAssistantAnswerContent, hasMermaidBlock, rollbackToBatchCheckpoint, showAgentToast, summarizeToolResult, getCurrentUndoTurnId, toolDiffHasBody, pickDiffDisplayText, compactDiffForTrace, syncLiveWriteFromTrace, normWritePath, followChatStreamGrowth, scheduleStreamingChatFollow, setDetailsOpen, getThinkingUiState, thinkingRunState, traceAnswerPhase, startThinkingTransitionPin, AgentRoundText */
'use strict';

function patchThinkingTrace(
  hostEl,
  trace,
  {
    streaming = false,
    stateHost = null,
    collapseAll = false,
    keepOpen = false,
    undoTurnId = null,
    checkpointRestore = false,
    streamContent = ''
  } = {}
) {
  if (!hostEl || !trace?.length) return false;
  const outer = hostEl.querySelector(':scope > .msg-thinking-outer');
  const body = outer?.querySelector('.msg-thinking-body');
  if (!outer || !body) return false;

  const effectiveCollapseAll = collapseAll || false;
  const uiState = getThinkingUiState(stateHost || hostEl);
  const seen = new Set();

  bindThinkingOuterToggle(outer, uiState);
  setDetailsOpen(
    outer,
    resolveThinkingOuterOpen({
      streaming,
      keepOpen,
      effectiveCollapseAll,
      trace,
      streamContent,
      uiState
    })
  );
  syncThinkingOuterSummary(outer, trace, { streaming, keepOpen });

  if (typeof isPrepOnlyTrace === 'function' && isPrepOnlyTrace(trace)) {
    let panel = body.querySelector('.msg-thinking-prep');
    if (!panel) {
      body.replaceChildren(renderPrepStepsPanel(trace[0].prepSteps || []));
    } else {
      syncPrepStepsPanel(panel, trace[0].prepSteps || []);
      // 排队任务切换时，旧 run 的工具轮次可能残留在同一气泡里
      body.querySelectorAll('.msg-thinking-step, :scope > details[data-step-key]').forEach((node) => node.remove());
    }
    if (streaming && typeof scheduleStreamingChatFollow === 'function') {
      scheduleStreamingChatFollow();
    } else if (streaming && typeof followChatStreamGrowth === 'function') {
      followChatStreamGrowth();
    }
    return true;
  }

  for (let i = 0; i < trace.length; i++) {
    const entry = trace[i];
    const domKey = thinkingStepDomKey(entry, i);
    seen.add(domKey);
    let wrap = body.querySelector(`.msg-thinking-step[data-step-key="${domKey}"]`);
    let details = wrap
      ? wrap.querySelector('details.msg-thinking-round-details')
      : body.querySelector(`:scope > details[data-step-key="${domKey}"]`);
    if (details && !wrap) {
      details.remove();
      details = null;
    }
    const opts = {
      streaming,
      stateHost,
      uiState,
      effectiveCollapseAll,
      keepOpen,
      undoTurnId,
      checkpointRestore,
      streamContent
    };
    if (!details) {
      wrap = mountThinkingRoundDetails(entry, i, trace, opts);
      body.appendChild(wrap);
      if (streaming && typeof startThinkingTransitionPin === 'function') {
        startThinkingTransitionPin();
      }
    } else {
      syncThinkingRoundDetails(details, entry, i, trace, opts);
    }
  }

  body.querySelectorAll('.msg-thinking-step[data-step-key], :scope > details[data-step-key]').forEach((node) => {
    if (!seen.has(node.dataset.stepKey || '')) node.remove();
  });
  if (typeof syncLiveWriteFromTrace === 'function') {
    void syncLiveWriteFromTrace(trace, {
      sessionId: typeof currentSessionId !== 'undefined' ? currentSessionId : undefined
    });
  }
  if (streaming && typeof scheduleStreamingChatFollow === 'function') {
    scheduleStreamingChatFollow();
  } else if (streaming && typeof followChatStreamGrowth === 'function') {
    followChatStreamGrowth();
    const chat = document.getElementById('chat-list');
    if (chat) {
      requestAnimationFrame(() => {
        chat.dataset.streamScrollHeight = String(chat.scrollHeight);
      });
    }
  }
  return true;
}

function patchStreamingTextOnly(div, trace, content) {
  const uiState = getThinkingUiState(div);
  const contentStr = String(content || '');
  const answerPhase = traceAnswerPhase(trace);
  const outer = div.querySelector(':scope > .msg-thinking-outer');

  if (outer) {
    bindThinkingOuterToggle(outer, uiState);
    syncThinkingOuterSummary(outer, trace, { streaming: true, keepOpen: false });
    const shouldOpen = resolveThinkingOuterOpen({
      streaming: true,
      keepOpen: false,
      effectiveCollapseAll: false,
      trace,
      streamContent: contentStr,
      uiState
    });
    setDetailsOpen(outer, shouldOpen);
  }

  if (!answerPhase && tracePrefs.showReasoning && trace.length) {
    const lastIdx = trace.length - 1;
    const entry = trace[lastIdx];
    const domKey = thinkingStepDomKey(entry, lastIdx);
    const wrap = div.querySelector(`.msg-thinking-step[data-step-key="${domKey}"]`);
    const details =
      wrap?.querySelector('details.msg-thinking-round-details') ||
      div.querySelector(`details[data-step-key="${domKey}"]`);
    const block = details?.querySelector('.msg-thinking-round');
    if (block) {
      const display = visibleThoughtDisplay(entry, lastIdx, trace, true);
      if (display) {
        let thoughtEl = block.querySelector('.msg-thinking-thought');
        if (!thoughtEl) {
          thoughtEl = document.createElement('div');
          thoughtEl.className = 'msg-thinking-thought';
          block.insertBefore(thoughtEl, block.firstChild);
        }
        if (updateIncrementalTextContent(thoughtEl, display) && typeof followChatStreamGrowth === 'function') {
          followChatStreamGrowth();
        }
      } else {
        const thoughtEl = block.querySelector('.msg-thinking-thought');
        if (thoughtEl) thoughtEl.remove();
      }
    }
    // 结构签名不变时走的就是这条快路径：等待备注必须在这里同步，否则永不出现
    if (typeof syncThinkingLiveNote === 'function') syncThinkingLiveNote(block, entry);
    const beat = wrap?.querySelector(':scope > .msg-thinking-beat');
    if (beat && typeof fillThinkingRoundBeat === 'function') {
      fillThinkingRoundBeat(beat, entry, lastIdx, trace, true, contentStr);
    }
  }

  updateStreamingBubbleTail(div, contentStr, true, trace);
}

function updateStreamingBubbleTail(div, content, hasTrace, trace) {
  if (!hasTrace) return;
  const answerPhase = traceAnswerPhase(trace);
  const contentStr = String(content || '');

  let answerPending = div.querySelector(':scope > .msg-answer-pending');
  if (contentStr) {
    if (!answerPending) {
      answerPending = document.createElement('div');
      answerPending.className = 'msg-answer msg-answer-pending';
      div.appendChild(answerPending);
    }
    if (
      updateIncrementalTextContent(answerPending, contentStr) &&
      answerPhase &&
      typeof followChatStreamGrowth === 'function'
    ) {
      followChatStreamGrowth();
    }
  } else if (answerPending) {
    clearIncrementalTextState(answerPending);
    answerPending.remove();
  }

  div.querySelector(':scope > .msg-thinking-live-summary')?.remove();
  div.querySelector(':scope > .msg-thinking-live')?.remove();
}

/** 整轮结束时强制归位：收回思考区并清掉用户覆盖，避免下次重绘又弹开 */
function collapseChatThinkingTraces(opts = {}) {
  const keepLoading = opts.keepLoadingBubble !== false;
  const exceptBubble = opts.exceptBubble || null;
  const chat = document.getElementById('chat-list');
  if (!chat) return;

  chat.querySelectorAll('.msg-thinking-outer').forEach((outer) => {
    const msg = outer.closest('.msg');
    if (exceptBubble && msg === exceptBubble) return;
    const isLoading = !!(msg && msg.classList.contains('loading'));
    if (isLoading && keepLoading) return;
    // run 仍在执行（验收 / 续跑中）不强制收，交给真正结束时统一折叠
    if (msg && typeof thinkingRunState === 'function' && thinkingRunState(msg)) return;

    const uiState = msg ? getThinkingUiState(msg) : null;
    if (uiState) uiState.userOpen = null;
    setDetailsOpen(outer, false);
    outer.querySelectorAll('.msg-thinking-round-details').forEach((details) => {
      setDetailsOpen(details, false);
      details.classList.add('is-collapsed-auto');
    });
  });
}

function buildThinkingTraceElement(
  trace,
  {
    streaming = false,
    stateHost = null,
    collapseAll = false,
    keepOpen = false,
    undoTurnId = null,
    checkpointRestore = false,
    streamContent = ''
  } = {}
) {
  if (!trace || !trace.length) return null;

  const autoCollapseDone = !streaming && !keepOpen;
  const effectiveCollapseAll = collapseAll || autoCollapseDone;
  const uiState = getThinkingUiState(stateHost);

  const root = document.createElement('details');
  root.className = 'msg-thinking-outer';
  bindThinkingOuterToggle(root, uiState);
  setDetailsOpen(
    root,
    resolveThinkingOuterOpen({
      streaming,
      keepOpen,
      effectiveCollapseAll,
      trace,
      streamContent,
      uiState
    })
  );

  const outerSummary = document.createElement('summary');
  outerSummary.className = 'msg-thinking-outer-summary';
  outerSummary.textContent = thinkingOuterSummaryLabel(trace, { streaming, keepOpen });
  root.appendChild(outerSummary);

  const wrap = document.createElement('div');
  wrap.className = 'msg-thinking';

  const inner = document.createElement('div');
  inner.className = 'msg-thinking-body';

  if (typeof isPrepOnlyTrace === 'function' && isPrepOnlyTrace(trace)) {
    inner.appendChild(renderPrepStepsPanel(trace[0].prepSteps || []));
  } else {
    for (let i = 0; i < trace.length; i++) {
      inner.appendChild(
        mountThinkingRoundDetails(trace[i], i, trace, {
          streaming,
          stateHost,
          uiState,
          effectiveCollapseAll,
          keepOpen,
          undoTurnId,
          checkpointRestore,
          streamContent
        })
      );
    }
  }

  wrap.appendChild(inner);
  root.appendChild(wrap);
  if (typeof syncLiveWriteFromTrace === 'function') {
    void syncLiveWriteFromTrace(trace, {
      sessionId: typeof currentSessionId !== 'undefined' ? currentSessionId : undefined
    });
  }
  return root;
}

function renderThinkingTrace(container, trace, opts = {}) {
  const el = buildThinkingTraceElement(trace, { ...opts, stateHost: opts.stateHost || container });
  if (el) container.appendChild(el);
}

function renderAssistantBubbleContent(
  div,
  { content, trace, hitRoundLimit, loading, stopped, undoTurnId, checkpointRestore }
) {
  const streaming = !!loading;
  let effectiveTrace = trace;
  if (
    !streaming &&
    stopped &&
    typeof isPrepOnlyTrace === 'function' &&
    isPrepOnlyTrace(trace)
  ) {
    effectiveTrace = [];
  }
  const hasTrace = effectiveTrace && effectiveTrace.length > 0;
  if (!streaming) {
    resetThinkingUiState(div);
  }
  if (typeof applyThinkingLiveState === 'function') applyThinkingLiveState(div);
  const patchOpts = {
    streaming,
    stateHost: div,
    collapseAll: !loading && !stopped,
    keepOpen: !!stopped,
    undoTurnId: undoTurnId || null,
    checkpointRestore: !!checkpointRestore,
    streamContent: content || ''
  };

  if (streaming) dismissAgentContinueRows(div);

  if (streaming && hasTrace) {
    const outer = div.querySelector(':scope > .msg-thinking-outer');
    const nextSig = thinkingTraceStructureSig(effectiveTrace);
    const prevSig = div.dataset.thinkingTraceSig || '';
    if (outer && prevSig && prevSig === nextSig) {
      patchStreamingTextOnly(div, effectiveTrace, content || '');
      if (typeof scheduleStreamingChatFollow === 'function') scheduleStreamingChatFollow();
      return;
    }
    if (patchThinkingTrace(div, effectiveTrace, patchOpts)) {
      div.dataset.thinkingTraceSig = nextSig;
      updateStreamingBubbleTail(div, content, true, effectiveTrace);
      if (typeof scheduleStreamingChatFollow === 'function') scheduleStreamingChatFollow();
      return;
    }
  }

  delete div.dataset.thinkingTraceSig;
  div.replaceChildren();
  if (hasTrace) {
    renderThinkingTrace(div, effectiveTrace, patchOpts);
    if (streaming) {
      div.dataset.thinkingTraceSig = thinkingTraceStructureSig(effectiveTrace);
      if (typeof scheduleStreamingChatFollow === 'function') scheduleStreamingChatFollow();
    }
  }
  if (loading && !hasTrace) {
    const p = document.createElement('div');
    p.className = 'msg-answer';
    p.textContent = '叠云Agent 正在思考…';
    div.appendChild(p);
    if (typeof scheduleStreamingChatFollow === 'function') scheduleStreamingChatFollow();
    return;
  }
  if (loading && hasTrace) {
    if (content) {
      const answer = document.createElement('div');
      answer.className = 'msg-answer msg-answer-pending';
      div.appendChild(answer);
      updateIncrementalTextContent(answer, content);
    }
    return;
  }
  if (!loading) {
    if (content && !hitRoundLimit) {
      const answer = document.createElement('div');
      answer.className = 'msg-answer';
      div.appendChild(answer);
      if (typeof renderAssistantAnswerContent === 'function' && hasMermaidBlock(content)) {
        void renderAssistantAnswerContent(answer, content).then((rendered) => {
          if (!rendered) answer.textContent = content;
        });
      } else {
        answer.textContent = content;
        if (content) answer.dataset.rawContent = content;
      }
    }
    if (hitRoundLimit) {
      appendAgentContinueRow(div);
    }
    const changeSummary = buildTraceFileChangeSummary(trace);
    if (changeSummary) {
      const meta = document.createElement('div');
      meta.className = 'msg-file-change-summary';
      meta.textContent = changeSummary;
      div.appendChild(meta);
    }
  }
}

function dismissAgentContinueRows(host) {
  const root = host || (typeof document !== 'undefined' ? document.getElementById('chat-list') : null);
  if (!root) return;
  root.querySelectorAll(host ? ':scope > .msg-continue-row' : '.msg-continue-row').forEach((n) => n.remove());
}

function resolveAgentContinueStateForView() {
  if (typeof getAgentContinueState !== 'function' || typeof currentSessionId === 'undefined') return null;
  const continueState = getAgentContinueState(currentSessionId);
  if (!continueState || continueState.sessionId !== currentSessionId) return null;
  return continueState;
}

function appendAgentContinueRow(div) {
  const continueState = resolveAgentContinueStateForView();
  if (!continueState || !div) return;
  dismissAgentContinueRows(div);
  const row = document.createElement('div');
  row.className = 'msg-continue-row';
  const link = document.createElement('button');
  link.type = 'button';
  link.className = 'msg-continue-link';
  link.textContent = '继续';
  link.title = '从当前进度接着执行';
  link.addEventListener('click', () => {
    if (typeof resumeAgentToolLoop === 'function') resumeAgentToolLoop();
  });
  row.appendChild(link);
  const hint = document.createElement('span');
  hint.className = 'msg-continue-hint';
  hint.textContent = formatAgentContinueHint(continueState, true);
  row.appendChild(hint);
  div.appendChild(row);
}

function formatAgentContinueHint(continueState, canClick) {
  if (continueState?.reason === 'network') {
    return canClick
      ? '连接中断，点击「继续」或发送「继续」从断点恢复。'
      : '连接中断，可在输入框发送「继续」从断点恢复。';
  }

  const info = continueState?.limitInfo || {};
  const mode = info.mode || 'Agent';
  const used = Number(info.toolCallsUsed);
  const maxTools = Number(info.maxToolCalls);
  const maxRounds = Number(info.maxRounds);
  const details = [];
  if (Number.isFinite(used) && Number.isFinite(maxTools) && maxTools > 0) {
    details.push(`工具 ${Math.min(used, maxTools)}/${maxTools}`);
  } else if (Number.isFinite(maxTools) && maxTools > 0) {
    details.push(`工具上限 ${maxTools}`);
  }
  if (Number.isFinite(maxRounds) && maxRounds > 0) {
    details.push(`最多 ${maxRounds} 轮`);
  }
  const action = canClick ? '点击「继续」从断点恢复。' : '可在输入框发送「继续」。';
  return `${mode} 本段预算用完${details.length ? `（${details.join('，')}）` : ''}，${action}`;
}

function buildTraceFileChangeSummary(trace) {
  let files = 0;
  let added = 0;
  let removed = 0;
  for (const entry of trace || []) {
    for (const t of entry.tools || []) {
      const s = String(t.summary || '');
      const m = s.match(/\+(\d+)\s+-(\d+)/);
      if (isEditToolName(t.name) && m) {
        files += 1;
        added += Number(m[1]) || 0;
        removed += Number(m[2]) || 0;
      }
    }
  }
  if (!files) return '';
  return `变更：${files} 个文件 · +${added} -${removed}`;
}
function formatTracePlain(trace) {
  if (!trace || !trace.length) return '';
  const lines = [];
  for (let i = 0; i < trace.length; i++) {
    const entry = trace[i];
    lines.push(entry.phase || '思考');
    const thought = thoughtTextForDisplay(entry, i, trace);
    if (thought) lines.push(thought);
    for (const t of entry.tools || []) {
      const arg = t.argsBrief ? `(${t.argsBrief})` : '';
      lines.push(`  · ${t.name}${arg} → ${t.summary}`);
    }
  }
  return lines.join('\n');
}

function buildPersistedAssistantContent(reply) {
  return String(reply || '');
}

function shortenToolSummaryForReply(name, summary) {
  let s = String(summary || '')
    .replace(/\uFFFD/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!s) return '已执行';
  const exitM = s.match(/exit\s+(-?\d+)/i);
  if (name === 'host_exec') {
    const garbled = s.length > 48 && (s.match(/[^\x20-\x7E\u4e00-\u9fff]/g) || []).length > s.length * 0.15;
    if (garbled) return exitM ? `exit ${exitM[1]}` : '已执行（输出含乱码，详见思考区工具行）';
    if (s.length > 120 && /\/\*|^#|^import |^<!DOCTYPE|^<html[\s>]/i.test(s)) {
      return exitM ? `exit ${exitM[1]} · 输出 ${s.length} 字` : `输出 ${s.length} 字`;
    }
  }
  return s.length > 88 ? `${s.slice(0, 88)}…` : s;
}

function buildToolTraceFallbackReply(trace) {
  const rows = [];
  const seen = new Set();
  let toolCount = 0;
  for (const entry of trace || []) {
    for (const t of entry.tools || []) {
      toolCount += 1;
      const name = String(t.name || '').trim();
      const summary = shortenToolSummaryForReply(name, t.summary);
      const key = `${name}\0${summary.slice(0, 80)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (name || summary) rows.push(`- ${name || '工具'}：${summary || '已执行'}`);
    }
  }
  if (!rows.length) return '';
  const changeSummary = buildTraceFileChangeSummary(trace);
  const lines = [
    `本轮 Agent 已执行 ${toolCount} 次工具，但未能生成最终文字总结。`,
    '详细过程见上方「思考」折叠区；最近几步摘要：',
    ...rows.slice(-5)
  ];
  if (changeSummary) lines.push('', changeSummary);
  lines.push('', '如需说明，可在输入框发送：「总结一下刚才做了什么」。');
  return lines.join('\n');
}

var SYNTHESIS_TRACE_PHASE = '汇总';
var SYNTHESIS_TRACE_START = '正在生成最终答复…';
var SYNTHESIS_TRACE_DONE = '已完成';
var SYNTHESIS_TRACE_FAILED = '汇总未完成，见下方答复';

/** 空回复时用 trace 思考正文当交付兜底；过滤 phase 级固定文案（非意图词表） */
function buildTraceThoughtFallbackReply(trace) {
  const parts = [];
  const rows = Array.isArray(trace) ? trace : [];
  for (let index = 0; index < rows.length; index++) {
    const entry = rows[index];
    const phase = String(entry.phase || '').trim();
    const thought = thoughtTextForDisplay(entry, index, rows);
    let text =
      thought.length > phase.length + 8 ? thought : [phase, thought].filter(Boolean).join('\n');
    text = text.trim();
    if (text.length <= 24) continue;
    if (phase && (text === phase || text === `${phase}。` || text === `${phase}…`)) continue;
    if (
      text === SYNTHESIS_TRACE_START ||
      text === SYNTHESIS_TRACE_DONE ||
      text === SYNTHESIS_TRACE_FAILED
    ) {
      continue;
    }
    parts.push(text);
  }
  if (!parts.length) return '';
  return parts.slice(-4).join('\n\n');
}

function cloneTraceEntryForUi(entry) {
  return {
    ...entry,
    tools: (entry.tools || []).map((t) => ({ ...t }))
  };
}

function findSynthesisTraceIndex(trace) {
  for (let i = (trace || []).length - 1; i >= 0; i--) {
    if (String(trace[i].phase || '').trim() === SYNTHESIS_TRACE_PHASE) return i;
  }
  return -1;
}

/** 追加或更新「汇总」步骤（对齐 Planner need_synthesize_llm trace） */
function upsertSynthesisTraceRound(trace, { streaming, failed }) {
  const next = (trace || []).map(cloneTraceEntryForUi);
  let entry;
  const idx = findSynthesisTraceIndex(next);
  if (idx >= 0) {
    entry = next[idx];
  } else {
    entry = {
      round: next.length + 1,
      phase: SYNTHESIS_TRACE_PHASE,
      thought: SYNTHESIS_TRACE_START,
      fullThought: SYNTHESIS_TRACE_START,
      tools: [],
      synthesisRound: true,
      // 合成阶段就是「不再调工具、正文进回答区」：思考区据此折叠
      answerPhase: true
    };
    next.push(entry);
  }
  if (streaming) {
    entry.thought = SYNTHESIS_TRACE_START;
    entry.fullThought = SYNTHESIS_TRACE_START;
  } else if (failed) {
    entry.thought = SYNTHESIS_TRACE_FAILED;
    entry.fullThought = SYNTHESIS_TRACE_FAILED;
  } else {
    entry.thought = SYNTHESIS_TRACE_DONE;
    entry.fullThought = SYNTHESIS_TRACE_DONE;
  }
  return next;
}

function countTraceTools(trace) {
  return (trace || []).reduce((n, e) => n + (e.tools || []).length, 0);
}

/**
 * 汇总（synthesis）请求体的唯一实现在 Main：`src/agent/agent-synthesis.js`
 * （由 rust-loop-runner 在空回复时调用，见 AGENTS.md「空回复才 synthesis，Renderer 只展示」）。
 * Renderer 侧此前有一份逐字重复的 buildAgentSynthesisBody / digest / 取最后用户消息，
 * 且无任何调用点 —— 已删除，避免改一处漏一处。
 */

/** 工具轮结束后仅空回复/残留 tool XML 才补汇总；有正文即交付 */
function needsAssistantReplySynthesis(reply, trace) {
  const text = stripAssistantVisibleToolCallMarkup(String(reply || '').trim());
  if (typeof AgentRoundText !== 'undefined' && typeof AgentRoundText.needsAssistantReplySynthesis === 'function') {
    return AgentRoundText.needsAssistantReplySynthesis(text, trace);
  }
  const toolCount = countTraceTools(trace);
  if (toolCount < 1) return false;
  if (!text || text === '(空响应)') return true;
  if (/<(?:tool_call|tool_calls|invoke|function=|\uff5cDSML\uff5c|｜DSML｜)/i.test(text)) return true;
  return false;
}

function synthesizedReplyIsUsable(text) {
  const t = stripAssistantVisibleToolCallMarkup(String(text || '').trim());
  if (typeof AgentRoundText !== 'undefined' && typeof AgentRoundText.synthesizedReplyIsUsable === 'function') {
    return AgentRoundText.synthesizedReplyIsUsable(t);
  }
  return !!(t && t !== '(空响应)' && t.length >= 8 && !/<(?:tool_call|tool_calls|invoke|function=)/i.test(t));
}

function thoughtFallbackCoversSynthesis(trace) {
  const thought = buildTraceThoughtFallbackReply(trace);
  if (typeof AgentRoundText !== 'undefined' && typeof AgentRoundText.thoughtFallbackCoversSynthesis === 'function') {
    return AgentRoundText.thoughtFallbackCoversSynthesis(thought);
  }
  return synthesizedReplyIsUsable(thought) && thought.length >= 48;
}

function stripAssistantVisibleToolCallMarkup(text) {
  const normalized = String(text || '')
    .replace(/<\uff5cDSML\uff5c/gi, '<')
    .replace(/<\/\uff5cDSML\uff5c/gi, '</')
    .replace(/<tool[\s_]+calls>/gi, '<tool_calls>')
    .replace(/<\/tool[\s_]+calls>/gi, '</tool_calls>')
    .replace(/<tool[\s_]+call>/gi, '<tool_call>')
    .replace(/<\/tool[\s_]+call>/gi, '</tool_call>')
    .replace(/<\/function\s*>/gi, '')
    .replace(/<function\s*>/gi, '');
  return normalized
    .replace(/<tool_calls>[\s\S]*?(?=<tool_calls>|$)/gi, '')
    .replace(/<\/tool_calls>/gi, '')
    .replace(/<invoke\s+name="[^"]+"[^>]*>[\s\S]*?(?=<invoke\s+name=|<\/tool_calls>|$)/gi, '')
    .replace(/<\/invoke>/gi, '')
    .replace(/<invoke\s+name="[^"]+"[^>]*\/?>/gi, '')
    .replace(/<tool_call>[\s\S]*?(?=<tool_call>|$)/gi, '')
    .replace(/<\/tool_call>/gi, '')
    .replace(/<function=[^>\n/]+>\s*/gi, '')
    .replace(/<parameter\s+name="[^"]+"[^>]*>[\s\S]*?<\/parameter>/gi, '')
    .replace(/<parameter\s+name="[^"]+"[^>]*\/\s*>/gi, '')
    .replace(/<parameter=[^>\n/]+>[\s\S]*?<\/parameter>/gi, '')
    .replace(/<parameter=[^>\n/]+>[\s\S]*?(?=<parameter=|<function=|<tool_call>|<invoke|<\/tool_calls>|$)/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function normalizeAssistantReplyForStorage(reply, trace) {
  const text = stripAssistantVisibleToolCallMarkup(String(reply || '').trim());
  const thoughtFallback = buildTraceThoughtFallbackReply(trace);
  const toolFallback = buildToolTraceFallbackReply(trace);
  if (typeof AgentRoundText !== 'undefined' && typeof AgentRoundText.pickNormalizedAssistantReply === 'function') {
    return AgentRoundText.pickNormalizedAssistantReply(text, trace, {
      thoughtFallback,
      toolFallback
    });
  }
  if (text && text !== '(空响应)' && !needsAssistantReplySynthesis(text, trace)) return text;
  if (thoughtFallback) return thoughtFallback;
  if (toolFallback) return toolFallback;
  return '（模型未生成文字答复。）';
}

function splitPersistedAssistantTrace(raw, opts) {
  const text = String(raw || '');
  const split = text.includes('\n\n---\n\n') ? text.split('\n\n---\n\n') : null;
  if (split && split[0].startsWith('【思考过程】')) {
    const skipParse = !!(opts && opts.skipParse);
    return {
      content: split.slice(1).join('\n\n---\n\n'),
      trace: skipParse ? null : parseTraceFromPersisted(split[0]),
      thinkingRaw: split[0]
    };
  }
  return { content: text, trace: null, thinkingRaw: null };
}

function parseTraceFromPersisted(thinkingBlock) {
  const text = String(thinkingBlock || '').replace(/^【思考过程】\n?/, '');
  const trace = [];
  let current = null;
  for (const line of text.split('\n')) {
    // 兼容旧格式 "第 N 轮" 标记
    const roundM = line.match(/^第 (\d+) 轮$/);
    if (roundM) {
      current = { round: Number(roundM[1]), thought: '', tools: [] };
      trace.push(current);
      continue;
    }
    // 新行 = 新 phase 标题
    if (line.startsWith('  · ')) {
      if (!current) continue;
      const body = line.slice(4);
      const arrow = body.lastIndexOf(' \u2192 ');
      if (arrow === -1) continue;
      const summary = body.slice(arrow + 3);
      const left = body.slice(0, arrow);
      const paren = left.indexOf('(');
      if (paren > 0 && left.endsWith(')')) {
        current.tools.push({
          name: left.slice(0, paren),
          argsBrief: left.slice(paren + 1, -1),
          summary
        });
      } else {
        current.tools.push({ name: left, argsBrief: '', summary });
      }
      continue;
    }
    if (!current && line.trim()) {
      current = { round: trace.length + 1, phase: line.trim(), thought: '', tools: [] };
      trace.push(current);
      continue;
    }
    if (current && line.trim()) {
      current.thought = current.thought ? current.thought + '\n' + line : line;
    }
  }
  return trace;
}
