/* global document, tracePrefs, entryHasShellTool, entryHasEditTool, isEditToolName, getAgentContinueState, getPendingResumeCheckpoint, requestResumeInterruptedTurn, currentSessionId, resumeAgentToolLoop, renderAssistantAnswerContent, rollbackToBatchCheckpoint, showAgentToast, summarizeToolResult, getCurrentUndoTurnId, toolDiffHasBody, pickDiffDisplayText, compactDiffForTrace, normWritePath, followChatStreamGrowth, scheduleStreamingChatFollow, setDetailsOpen, getThinkingUiState, thinkingRunState, traceAnswerPhase, startThinkingTransitionPin, AgentRoundText, shouldShowTraceTitle, attachAnswerFigures, revokeAnswerFigureBlobs */
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

  // 先把现有节点按 key 建索引再逐轮对账：原来每轮都 `body.querySelector` 全子树，
  // 轮次多时是「轮次 × 子树节点」；现在两遍 querySelectorAll + O(1) 查找，收尾复用同一索引。
  const stepByKey = new Map();
  body.querySelectorAll('.msg-thinking-step[data-step-key]').forEach((node) => {
    const key = node.dataset.stepKey || '';
    if (!stepByKey.has(key)) stepByKey.set(key, node);
  });
  const orphanDetailsByKey = new Map();
  body.querySelectorAll(':scope > details[data-step-key]').forEach((node) => {
    const key = node.dataset.stepKey || '';
    if (!orphanDetailsByKey.has(key)) orphanDetailsByKey.set(key, node);
  });

  for (let i = 0; i < trace.length; i++) {
    const entry = trace[i];
    const domKey = thinkingStepDomKey(entry, i);
    seen.add(domKey);
    let wrap = stepByKey.get(domKey) || null;
    let details = wrap
      ? wrap.querySelector('details.msg-thinking-round-details')
      : orphanDetailsByKey.get(domKey) || null;
    if (details && !wrap) {
      details.remove();
      orphanDetailsByKey.delete(domKey);
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
      // 登记回索引：同一 key 若在本轮之后再出现，行为与「实时查询 DOM」一致。
      stepByKey.set(domKey, wrap);
      if (streaming && typeof startThinkingTransitionPin === 'function') {
        startThinkingTransitionPin();
      }
    } else {
      syncThinkingRoundDetails(details, entry, i, trace, opts);
    }
  }

  for (const [key, node] of stepByKey) {
    if (!seen.has(key)) node.remove();
  }
  for (const [key, node] of orphanDetailsByKey) {
    if (!seen.has(key)) node.remove();
  }
  if (streaming) {
    if (typeof scheduleStreamingChatFollow === 'function') scheduleStreamingChatFollow();
    else if (typeof followChatStreamGrowth === 'function') followChatStreamGrowth();
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
    if (typeof isIsolatedCardEntry === 'function' && isIsolatedCardEntry(entry)) {
      // 子 Agent 卡片：内容全在卡片内部，直接按 rounds 重刷卡片正文
      const cardBody = details?.querySelector('.msg-thinking-round.msg-thinking-subagent-body');
      if (cardBody && typeof fillIsolatedCardBody === 'function') {
        fillIsolatedCardBody(cardBody, entry);
      }
      if (details) {
        details.classList.toggle('is-running', isolatedCardRunning(entry));
        // 摘要行的序号标题是稳定的，但「思考预览 / 运行中…→已完成」会随流式变化，
        // 这里按内容变化才重刷，避免每个 tick 重建 span。
        const cardSummary = details.querySelector('.msg-thinking-round-summary');
        if (cardSummary && shouldShowTraceTitle(entry) && typeof thinkingRoundSummaryLabel === 'function') {
          const label = thinkingRoundSummaryLabel(entry, lastIdx, trace);
          if (cardSummary.title !== label) {
            cardSummary.title = label;
            if (typeof syncThinkingRoundSummaryLabel === 'function') {
              syncThinkingRoundSummaryLabel(cardSummary, entry, lastIdx, trace);
            }
          }
        }
      }
    } else {
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
          if (
            updateIncrementalTextContent(thoughtEl, display) &&
            typeof followChatStreamGrowth === 'function'
          ) {
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
    // 含子 Agent 过程卡片的思考区不自动收回：卡片就是「要看的过程」，仍可手动折叠
    if (outer.querySelector('.msg-thinking-subagent')) return;

    const uiState = msg ? getThinkingUiState(msg) : null;
    if (uiState) uiState.userOpen = null;
    setDetailsOpen(outer, false);
    outer.querySelectorAll('.msg-thinking-round-details').forEach((details) => {
      if (details.classList.contains('msg-thinking-subagent')) return;
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

  // 正文整块重绘前先回收回答图 blob，否则每次重绘都漏一个 blob（见 renderer-answer-figures.js）
  if (typeof revokeAnswerFigureBlobs === 'function') revokeAnswerFigureBlobs(div);
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
    // 正文照常渲染：`hitRoundLimit` 只决定「要不要补一行『继续』」，
    // **不是**「把已经产出的正文藏起来」。以前 `content && !hitRoundLimit` 会在撞上限时
    // 把正文整段吞掉（plan 尤其致命：它的正文往往就是这一轮唯一的交付）。
    if (content) {
      const answer = document.createElement('div');
      answer.className = 'msg-answer';
      div.appendChild(answer);
      // 复制/导出读 rawContent（渲染成 HTML 后 textContent 会丢语法）
      answer.dataset.rawContent = content;
      // 富文本（Markdown / 顶层 mermaid）由一个入口判定；不接管就用纯文本直出
      if (typeof renderAssistantAnswerContent !== 'function' || !renderAssistantAnswerContent(answer, content)) {
        answer.textContent = content;
      }
    }
    // 本轮产图（截图 / 模型生成的图）：正文下方一条，数据只来自 trace 的结构信号，
    // 不解析任何文案；模型在正文里显式写的 ![]() 由图内的 bindAnswerMarkdownImages 负责。
    if (typeof attachAnswerFigures === 'function') attachAnswerFigures(div, effectiveTrace);
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

/**
 * plan 的续跑入口不是 chat 段状态，而是一份**断点**（`setPendingResumeCheckpoint`）。
 *
 * 以前这里只认 `getAgentContinueState`，于是 plan 撞上限时：正文被藏、按钮也不出现，
 * 用户只能自己猜「回车继续」。现在两条入口共用同一行「继续」。
 */
function resolvePlannerResumeForView() {
  if (typeof getPendingResumeCheckpoint !== 'function' || typeof currentSessionId === 'undefined') {
    return null;
  }
  const checkpoint = getPendingResumeCheckpoint(currentSessionId);
  return checkpoint && checkpoint.runId ? checkpoint : null;
}

function appendAgentContinueRow(div) {
  const continueState = resolveAgentContinueStateForView();
  const plannerResume = continueState ? null : resolvePlannerResumeForView();
  if ((!continueState && !plannerResume) || !div) return;
  dismissAgentContinueRows(div);
  const row = document.createElement('div');
  row.className = 'msg-continue-row';
  const link = document.createElement('button');
  link.type = 'button';
  link.className = 'msg-continue-link';
  link.textContent = '继续';
  link.title = '从当前进度接着执行';
  link.addEventListener('click', () => {
    if (continueState) {
      if (typeof resumeAgentToolLoop === 'function') resumeAgentToolLoop();
      return;
    }
    // plan：走「续跑唯一入口」（`requestResumeInterruptedTurn` 自己会消费 planner 断点）
    if (typeof requestResumeInterruptedTurn === 'function') {
      requestResumeInterruptedTurn(currentSessionId);
    }
  });
  row.appendChild(link);
  const hint = document.createElement('span');
  hint.className = 'msg-continue-hint';
  hint.textContent = continueState
    ? formatAgentContinueHint(continueState, true)
    : '本段预算用完，点击「继续」或直接回车从断点接着跑。';
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
  return `本段预算用完${details.length ? `（${details.join('，')}）` : ''}，${action}`;
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

// 汇总步骤的 phase 名与文案：单一来源 agent-round-text（Main 的 agent-synthesis 用同一组常量）
if (typeof AgentRoundText === 'undefined' || !AgentRoundText.SYNTHESIS_PHASE) {
  throw new Error('agent-bundle 必须先于 renderer-thinking-trace.js 加载（缺 AgentRoundText）');
}
var SYNTHESIS_TRACE_PHASE = AgentRoundText.SYNTHESIS_PHASE;
var SYNTHESIS_TRACE_START = AgentRoundText.SYNTHESIS_START;
var SYNTHESIS_TRACE_DONE = AgentRoundText.SYNTHESIS_DONE;
var SYNTHESIS_TRACE_FAILED = AgentRoundText.SYNTHESIS_FAILED;

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

/**
 * 汇总（synthesis）请求体的唯一实现在 Main：`src/agent/agent-synthesis.js`
 * （由 rust-loop-runner 在空回复时调用，见 AGENTS.md「空回复才 synthesis，Renderer 只展示」）。
 * Renderer 侧此前有一份逐字重复的 buildAgentSynthesisBody / digest / 取最后用户消息，
 * 且无任何调用点 —— 已删除，避免改一处漏一处。
 */

/** 工具轮结束后仅空回复/残留 tool XML 才补汇总；有正文即交付（判定单一来源 AgentRoundText） */
function needsAssistantReplySynthesis(reply, trace) {
  const text = stripAssistantVisibleToolCallMarkup(String(reply || '').trim());
  return AgentRoundText.needsAssistantReplySynthesis(text, trace);
}

function synthesizedReplyIsUsable(text) {
  const t = stripAssistantVisibleToolCallMarkup(String(text || '').trim());
  return AgentRoundText.synthesizedReplyIsUsable(t);
}

/**
 * 展示层剥 tool_call XML：与 `renderer-agent-continue.js#stripVisibleToolCallMarkup` 一样，
 * 唯一实现在 `src/llm-tool-call-fallback.js#stripToolCallMarkup`（经 agent-bundle 暴露）。
 * 以前这里与那边各有一份逐字相同的副本，两份都少「裸 `<calls>` / DSML 半角竖线」归一。
 */
function stripAssistantVisibleToolCallMarkup(text) {
  const fn = typeof window !== 'undefined' ? window.stripToolCallMarkup : null;
  if (typeof fn !== 'function') {
    throw new Error('agent-bundle 未加载：需要 window.stripToolCallMarkup（llm-tool-call-fallback）');
  }
  return fn(text);
}

/**
 * 交付/展示归一（**不负责落库**）：给气泡与后续落库输入一个「正文优先」的文本。
 * - 正文优先，无正文时才显式回退；思考兜底取单一来源 `agent-round-text.reasoningTextFromTrace`
 *   （带「思考回退」标签，仅展示）；
 * - 落库另有收口：`persistAssistantTranscriptText → persistableAssistantText → persistableTurnText`
 *   会把该标签与空串统一换成占位，保证思考回退永远进不了账本（REASONING-ISOLATION §3.4）。
 */
function normalizeAssistantReplyForStorage(reply, trace) {
  const text = stripAssistantVisibleToolCallMarkup(String(reply || '').trim());
  const toolFallback = buildToolTraceFallbackReply(trace);
  return AgentRoundText.pickNormalizedAssistantReply(text, trace, {
    reasoningFallback: AgentRoundText.reasoningTextFromTrace(trace),
    toolFallback
  });
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
