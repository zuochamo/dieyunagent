/* global document, tracePrefs, entryHasShellTool, entryHasEditTool, isEditToolName, getAgentContinueState, currentSessionId, resumeAgentToolLoop, renderAssistantAnswerContent, hasMermaidBlock, rollbackToBatchCheckpoint, showAgentToast, summarizeToolResult, getCurrentUndoTurnId, toolDiffHasBody, pickDiffDisplayText, compactDiffForTrace, syncLiveWriteFromTrace, normWritePath, followChatStreamGrowth, scheduleStreamingChatFollow, setStreamingDetailsOpen, startThinkingTransitionPin, AgentRoundText, sessionActiveRuns */
'use strict';

/** 结构签名：不含 thought 正文，用于区分「仅流式文本」与「trace 结构变化」 */
function thinkingTraceStructureSig(trace) {
  if (!trace || !trace.length) return '';
  return trace
    .map((entry, index) => {
      const tools = entry.tools || [];
      const toolSig = tools
        .map((t) => {
          const parts = [
            t.id || '',
            t.name || '',
            t.pending ? '1' : '0',
            t.failed ? '1' : '0'
          ];
          parts.push(t.summary || '');
          parts.push(t.diff ? `${Number(t.diff.added) || 0}:${Number(t.diff.removed) || 0}` : '');
          return parts.join(':');
        })
        .join(';');
      const prepSig =
        entry.phase === 'prep' && Array.isArray(entry.prepSteps)
          ? typeof agentPrepStepsSig === 'function'
            ? agentPrepStepsSig(entry.prepSteps)
            : entry.prepSteps.map((s) => `${s.id}:${s.status}`).join(',')
          : '';
      const bootSig =
        Array.isArray(entry.bootSteps) && entry.bootSteps.length
          ? typeof rustBootStepsSig === 'function'
            ? rustBootStepsSig(entry.bootSteps)
            : entry.bootSteps.map((s) => `${s.id}:${s.status}`).join(',')
          : '';
      return [
        index,
        entry.round != null ? entry.round : '',
        entry.phase || '',
        prepSig,
        bootSig,
        entry.subagentId || '',
        entry.isolated ? '1' : '0',
        String(entry.visibleContent || '').trim() ? 'v' : '',
        tools.length,
        toolSig
      ].join('#');
    })
    .join('|');
}

/** 增量追加文本，避免整段 textContent 替换导致布局跳动 */
function updateIncrementalTextContent(el, nextText) {
  if (!el) return false;
  const next = String(nextText ?? '');
  const prev = el.dataset.streamRendered ?? '';
  if (next === prev) return false;
  if (!prev || !next.startsWith(prev)) {
    el.textContent = next;
  } else {
    el.append(document.createTextNode(next.slice(prev.length)));
  }
  el.dataset.streamRendered = next;
  return true;
}

function clearIncrementalTextState(el) {
  if (!el) return;
  delete el.dataset.streamRendered;
}

function entryHasPendingTools(entry) {
  return (entry?.tools || []).some((t) => t && t.pending);
}

function isPlaceholderThoughtText(text) {
  const t = String(text || '').trim();
  return (
    !t ||
    t === '…' ||
    /^(请求中|思考中|生成中|处理中|启动|等待|连接中断|请求 LLM|多模态识图|执行工具)/.test(t)
  );
}

function thoughtTextForDisplay(entry, index, trace) {
  const raw = String(entry?.fullThought || entry?.thought || '').trim();
  if (!raw) return '';
  if (typeof AgentRoundText === 'undefined' || typeof AgentRoundText.sanitizeAgentThoughtText !== 'function') {
    return raw;
  }
  const prev = (trace || [])
    .slice(0, Math.max(0, index))
    .map((e) => e.fullThought || e.thought);
  return AgentRoundText.sanitizeAgentThoughtText(raw, prev);
}

function visibleThoughtDisplay(entry, index, trace, streaming) {
  const raw = String(entry?.fullThought || entry?.thought || '').trim();
  const thoughtText = thoughtTextForDisplay(entry, index, trace);
  if (thoughtText && thoughtText !== '请求中…') return thoughtText;
  if (raw && !isPlaceholderThoughtText(raw)) return '';
  return streaming ? '思考中…' : thoughtText || '';
}

function isThinkingRoundInProgress(entry, index, trace, streaming, streamContent) {
  if (!streaming) return false;
  if (index !== trace.length - 1) return false;
  if (entryHasPendingTools(entry)) return true;
  const phase = String(entry.phase || '').trim();
  if (phase === '汇总') {
    const t = String(entry.fullThought || entry.thought || '').trim();
    return isPlaceholderThoughtText(t) || /生成中|请求中/.test(t);
  }
  const tools = entry.tools || [];
  if (tools.length > 0) return false;
  if (String(streamContent || '').trim()) return false;
  const full = String(entry.fullThought || entry.thought || '').trim();
  return isPlaceholderThoughtText(full) || !!full;
}

function isThinkingRoundComplete(entry, index, trace, streaming, streamContent) {
  if (!streaming) return true;
  if (index < trace.length - 1) return true;
  return !isThinkingRoundInProgress(entry, index, trace, streaming, streamContent);
}

/** 工具已跑完、正文在流式输出时，思考区应收起以免定格在 diff */
function isTraceInAnswerStreamPhase(trace, streaming, streamContent) {
  if (!streaming || !trace?.length) return false;
  if (!String(streamContent || '').trim()) return false;
  for (const entry of trace) {
    if (entryHasPendingTools(entry)) return false;
  }
  return true;
}

/** 进入回答阶段后粘滞，避免 trace 追加 pending 工具时思考区突然展开 */
function resolveAnswerStreamPhase(trace, streaming, streamContent, uiState) {
  if (!streaming) {
    if (uiState) uiState.answerPhaseLatched = false;
    return false;
  }
  // Plan 运行会把子任务 / 探索 loop 的正文提前灌进 streamContent（见 rust-planner-runner
  // pushUiTrace），但那不是用户最终答复：据此折起思考区会显得「还没回答完就收起」。
  if (uiState?.planRun) {
    uiState.answerPhaseLatched = false;
    return false;
  }
  for (const entry of trace || []) {
    if ((entry.tools || []).some((t) => t && t.pending)) {
      if (uiState) uiState.answerPhaseLatched = false;
      return false;
    }
  }
  const hasContent = !!String(streamContent || '').trim();
  const rawReady = hasContent && isTraceInAnswerStreamPhase(trace, streaming, streamContent);
  if (uiState) {
    if (rawReady) uiState.answerPhaseLatched = true;
    if (uiState.answerPhaseLatched && hasContent) return true;
  }
  return rawReady;
}

function thinkingRoundTitle(entry) {
  if (entry.phase) return entry.phase;
  return '思考';
}

function thinkingStepKey(entry, index) {
  return `${index}:${entry.phase || `r${entry.round}`}:${entry.subagentId || ''}`;
}

function getThinkingUiState(hostEl) {
  if (!hostEl) return null;
  if (!hostEl._thinkingUi) {
    hostEl._thinkingUi = {
      expanded: new Set(),
      collapsed: new Set(),
      answerPhaseLatched: false,
      outerExpanded: false,
      outerCollapsed: false
    };
  }
  return hostEl._thinkingUi;
}

function resetThinkingUiState(hostEl) {
  if (!hostEl) return;
  delete hostEl._thinkingUi;
  delete hostEl.dataset.thinkingTraceSig;
}

/** 本轮是否为仍在执行的 Plan 运行（判定依据来自 sessionActiveRuns 登记，而非文案） */
function isPlanThinkingRun(hostEl) {
  const sid = hostEl?.dataset?.runSessionId;
  if (!sid || typeof sessionActiveRuns === 'undefined' || !sessionActiveRuns) return false;
  const live = sessionActiveRuns.get(String(sid));
  return !!(live && !live.finished && live.agentRunMode === 'plan');
}

/** 把「本轮是否 Plan 运行」记到思考区 UI 状态，供 resolveAnswerStreamPhase 判定 */
function applyThinkingRunMode(hostEl, streaming) {
  const uiState = getThinkingUiState(hostEl);
  if (uiState) uiState.planRun = !!streaming && isPlanThinkingRun(hostEl);
}

function bindThinkingOuterToggle(outer, uiState) {
  if (!outer || !uiState || outer.dataset.thinkingOuterToggle === '1') return;
  outer.dataset.thinkingOuterToggle = '1';
  outer.addEventListener('toggle', () => {
    if (outer.open) {
      uiState.outerExpanded = true;
      uiState.outerCollapsed = false;
    } else {
      uiState.outerCollapsed = true;
      uiState.outerExpanded = false;
    }
  });
}

function resolveThinkingOuterOpen({
  streaming,
  keepOpen,
  effectiveCollapseAll,
  trace,
  streamContent,
  uiState,
  answerPhase = false
}) {
  if (keepOpen) return true;
  if (uiState?.outerExpanded) return true;
  if (uiState?.outerCollapsed) return false;
  if (answerPhase) return false;
  if (streaming) return true;
  if (effectiveCollapseAll) return false;
  return trace.some((e, i) =>
    shouldDefaultOpenThinkingEntry(e, trace, streaming, streamContent, uiState)
  );
}

function thinkingOuterSummaryLabel(trace, { streaming = false, answerPhase = false, keepOpen = false } = {}) {
  if (keepOpen) return '已停止';
  if (!streaming) return '已完成';
  if (answerPhase) return '生成回答中';
  return '思考中';
}

function syncThinkingOuterSummary(outer, trace, { streaming, answerPhase, keepOpen }) {
  const summary = outer?.querySelector('.msg-thinking-outer-summary');
  if (!summary) return;
  const label = thinkingOuterSummaryLabel(trace, { streaming, answerPhase, keepOpen });
  if (summary.textContent !== label) summary.textContent = label;
}

function prepStepIconMarkup(status) {
  if (status === 'done') return '<span class="msg-thinking-prep-icon is-done" aria-hidden="true">✓</span>';
  if (status === 'failed') return '<span class="msg-thinking-prep-icon is-failed" aria-hidden="true">✗</span>';
  if (status === 'active') {
    return '<span class="msg-thinking-prep-icon is-active" aria-hidden="true"><span class="msg-thinking-prep-spinner"></span></span>';
  }
  if (status === 'skipped') return '<span class="msg-thinking-prep-icon is-skipped" aria-hidden="true">—</span>';
  return '<span class="msg-thinking-prep-icon is-pending" aria-hidden="true">○</span>';
}

function renderPrepStepsPanel(steps) {
  const panel = document.createElement('div');
  panel.className = 'msg-thinking-prep';
  syncPrepStepsPanel(panel, steps);
  return panel;
}

function syncPrepStepsPanel(panel, steps) {
  if (!panel) return;
  const rows = (steps || []).filter((s) => s);
  const title = panel.querySelector('.msg-thinking-prep-title');
  const list = panel.querySelector('.msg-thinking-prep-steps');
  if (!title || !list) {
    panel.replaceChildren();
    const h = document.createElement('div');
    h.className = 'msg-thinking-prep-title';
    h.textContent = '准备中';
    const ul = document.createElement('ul');
    ul.className = 'msg-thinking-prep-steps';
    panel.append(h, ul);
  }
  const listEl = panel.querySelector('.msg-thinking-prep-steps');
  if (!listEl) return;

  const existing = new Map();
  listEl.querySelectorAll('.msg-thinking-prep-step').forEach((el) => {
    existing.set(el.dataset.stepId || '', el);
  });

  for (const step of rows) {
    const id = String(step.id || '');
    let row = existing.get(id);
    if (!row) {
      row = document.createElement('li');
      row.className = 'msg-thinking-prep-step';
      row.dataset.stepId = id;
      row.innerHTML =
        prepStepIconMarkup(step.status) +
        '<span class="msg-thinking-prep-label"></span>';
      listEl.appendChild(row);
    }
    row.className = 'msg-thinking-prep-step' + (step.status ? ` is-${step.status}` : '');
    const iconHost = row.querySelector('.msg-thinking-prep-icon');
    const nextIconHtml = prepStepIconMarkup(step.status);
    if (iconHost) {
      if (iconHost.outerHTML !== nextIconHtml) iconHost.outerHTML = nextIconHtml;
    } else {
      row.insertAdjacentHTML('afterbegin', nextIconHtml);
    }
    const labelEl = row.querySelector('.msg-thinking-prep-label');
    if (labelEl) {
      const label = String(step.label || id);
      let text = step.status === 'active' ? `${label}…` : label;
      if (step.status === 'active' && step.detail) {
        text = `${label}：${String(step.detail).slice(0, 160)}`;
      } else if (step.status === 'failed' && step.detail) {
        text = `${label}：${String(step.detail).slice(0, 220)}`;
      } else if (step.status === 'skipped' && step.detail) {
        text = `${label}（${String(step.detail).slice(0, 220)}）`;
      }
      labelEl.textContent = text;
    }
    existing.delete(id);
  }

  existing.forEach((el) => el.remove());
}

var THINKING_SUMMARY_PREVIEW_CHARS = 110;
var THINKING_SUMMARY_TOOL_SUFFIX_MAX = 3;

function compactReasoningPreviewText(text, maxChars = THINKING_SUMMARY_PREVIEW_CHARS) {
  let t = String(text || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  if (!t || isPlaceholderThoughtText(t)) return '';
  if (t.length <= maxChars) return t;
  const cut = t.slice(0, maxChars);
  const lastSpace = cut.lastIndexOf(' ');
  const trimmed = lastSpace > maxChars * 0.55 ? cut.slice(0, lastSpace) : cut;
  return `${trimmed.replace(/[，,;；：:]+$/, '').trim()}…`;
}

function reasoningPreviewFromEntry(entry, index, trace) {
  if (tracePrefs.showReasoning === false) return '';
  const text =
    typeof index === 'number' && Array.isArray(trace)
      ? thoughtTextForDisplay(entry, index, trace)
      : String(entry.fullThought || entry.thought || '');
  return compactReasoningPreviewText(text);
}

function briefToolLabelForSummary(tool) {
  const name = String(tool?.name || 'tool').trim();
  const brief = String(tool?.argsBrief || '').trim();
  const filePath = String(tool?.toolArgs?.filePath || brief).trim();
  if (name === 'fs_write_file' || name === 'fs_edit' || name === 'fs_read_file' || name === 'fs_list_dir') {
    const base = filePath ? filePath.split(/[/\\]/).pop() || filePath : brief;
    const shortBase =
      base.length > 36 ? `…${base.slice(-32)}` : base;
    if (name === 'fs_write_file') return shortBase ? `Write ${shortBase}` : 'Write';
    if (name === 'fs_edit') return shortBase ? `Edit ${shortBase}` : 'Edit';
    if (name === 'fs_read_file') return shortBase ? `Read ${shortBase}` : 'Read';
    return shortBase ? `List ${shortBase}` : 'List';
  }
  if (name === 'host_exec') return 'Shell';
  if (name === 'grep' || name === 'web_fetch' || name === 'browser_navigate') {
    const shortBrief = brief.length > 32 ? `${brief.slice(0, 28)}…` : brief;
    return shortBrief ? `${name} ${shortBrief}` : name;
  }
  if (brief) {
    const shortBrief = brief.length > 28 ? `${brief.slice(0, 24)}…` : brief;
    return `${name} ${shortBrief}`;
  }
  return name;
}

function toolSuffixFromEntry(entry) {
  const tools = (entry.tools || []).filter(Boolean);
  if (!tools.length) return '';
  const anyPending = tools.some((t) => t && t.pending);
  const unique = [];
  const seen = new Set();
  for (const t of tools) {
    const label = briefToolLabelForSummary(t);
    const key = label.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push({ label, pending: !!t.pending });
  }
  const shown = unique.slice(0, THINKING_SUMMARY_TOOL_SUFFIX_MAX);
  if (!shown.length) return '';
  let suffix = shown
    .map(({ label, pending }) => (anyPending && pending ? `${label} …` : label))
    .join(', ');
  if (unique.length > shown.length) suffix += ` +${unique.length - shown.length}`;
  return suffix;
}

function joinSummaryParts(primary, suffix) {
  const p = String(primary || '').trim();
  const s = String(suffix || '').trim();
  if (p && s) return `${p} · ${s}`;
  return p || s || '';
}

/**
 * @returns {{ primary: string, suffix: string, combined: string }}
 */
function thinkingRoundSummaryParts(entry, index, trace) {
  const toolN = (entry.tools || []).length;
  const phase = String(entry.phase || '').trim();
  const pendingTools = (entry.tools || []).some((t) => t && t.pending);
  const preview = reasoningPreviewFromEntry(entry, index, trace);
  const toolSuffix = toolSuffixFromEntry(entry);

  if (entry.isolated && phase.startsWith('执行器 ')) {
    const primary =
      preview ||
      (pendingTools ? `${phase} · 运行中…` : toolN ? `${phase} · ${toolN} 个工具` : `${phase} · 运行中…`);
    return { primary, suffix: toolSuffix, combined: joinSummaryParts(primary, toolSuffix) };
  }

  if (!entry.isolated && phase.startsWith('调度 ·')) {
    const primary = preview || phase;
    return { primary, suffix: toolSuffix, combined: joinSummaryParts(primary, toolSuffix) };
  }

  if (phase === '汇总') {
    const t = String(entry.thought || entry.fullThought || '').trim();
    if (/正在生成|生成中/.test(t)) {
      return { primary: preview || '汇总 · 生成中…', suffix: '', combined: preview || '汇总 · 生成中…' };
    }
    if (/未完成|失败/.test(t)) {
      return { primary: preview || '汇总 · 未完成', suffix: '', combined: preview || '汇总 · 未完成' };
    }
    const primary = preview || '汇总 · 已完成';
    return { primary, suffix: '', combined: primary };
  }

  if (preview) {
    return { primary: preview, suffix: toolSuffix, combined: joinSummaryParts(preview, toolSuffix) };
  }

  if (toolSuffix) {
    return { primary: toolSuffix, suffix: '', combined: toolSuffix };
  }

  if (pendingTools) {
    return { primary: '执行工具…', suffix: '', combined: '执行工具…' };
  }

  const title = thinkingRoundTitle(entry);
  return { primary: title, suffix: '', combined: title };
}

/** 折叠时显示的 Cursor 风格摘要（推理 preview 为主，工具名为后缀） */
function thinkingRoundSummaryLabel(entry, index, trace) {
  return thinkingRoundSummaryParts(entry, index, trace).combined;
}

function syncThinkingRoundSummaryLabel(summary, entry, index, trace) {
  if (!summary) return false;
  summary
    .querySelectorAll(
      '.msg-thinking-round-summary-preview, .msg-thinking-round-summary-tools, .msg-thinking-round-summary-sep, .msg-thinking-round-summary-label'
    )
    .forEach((el) => el.remove());

  if (tracePrefs.showTitles === false) return false;

  const cpBtn = summary.querySelector('.msg-checkpoint-restore-btn');
  const { primary, suffix } = thinkingRoundSummaryParts(entry, index, trace);
  const insertNode = (node) => {
    if (cpBtn) summary.insertBefore(node, cpBtn);
    else summary.appendChild(node);
  };

  if (primary) {
    const previewSpan = document.createElement('span');
    previewSpan.className = 'msg-thinking-round-summary-preview';
    previewSpan.textContent = primary;
    previewSpan.title = primary;
    insertNode(previewSpan);
  }
  if (suffix) {
    if (primary) {
      const sep = document.createElement('span');
      sep.className = 'msg-checkpoint-restore-sep msg-thinking-round-summary-sep';
      sep.textContent = ' · ';
      insertNode(sep);
    }
    const toolsSpan = document.createElement('span');
    toolsSpan.className = 'msg-thinking-round-summary-tools';
    toolsSpan.textContent = suffix;
    toolsSpan.title = suffix;
    insertNode(toolsSpan);
  }

  return !!(primary || suffix);
}

function shouldShowCheckpointRestore(entry, { checkpointRestore, undoTurnId, complete }) {
  if (typeof getComposerLongHorizon === 'function' && getComposerLongHorizon()) return false;
  return !!(
    checkpointRestore &&
    undoTurnId &&
    entry.checkpointId &&
    complete &&
    !(entry.tools || []).some((t) => t.pending)
  );
}

function appendCheckpointRestoreLink(summary, { undoTurnId, batchId, afterLabel }) {
  if (afterLabel) {
    const sep = document.createElement('span');
    sep.className = 'msg-checkpoint-restore-sep';
    sep.textContent = ' · ';
    summary.appendChild(sep);
  }
  const cpBtn = document.createElement('button');
  cpBtn.type = 'button';
  cpBtn.className = 'msg-checkpoint-restore-btn';
  cpBtn.title = '将工作区文件恢复到此工具批次执行前（不删除对话）';
  cpBtn.textContent = '恢复';
  cpBtn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    void (async () => {
      if (typeof rollbackToBatchCheckpoint !== 'function') return;
      try {
        const r = await rollbackToBatchCheckpoint(undoTurnId, batchId);
        if (r && r.ok !== false && !(r.errors && r.errors.length)) {
          const n = r.restored != null ? r.restored : 0;
          showAgentToast('Checkpoint 已恢复', n > 0 ? `已恢复 ${n} 个文件` : '文件已回到该步骤前', {
            variant: 'success'
          });
        } else {
          showAgentToast(
            'Checkpoint 恢复失败',
            (r && r.errors && r.errors[0] && r.errors[0].error) || (r && r.error) || '未知错误',
            { variant: 'error' }
          );
        }
      } catch (err) {
        showAgentToast('Checkpoint 恢复失败', err.message || String(err), { variant: 'error' });
      }
    })();
  });
  summary.appendChild(cpBtn);
}

function resolveThinkingStepOpen(
  entry,
  index,
  trace,
  streaming,
  uiState,
  collapseAll,
  streamContent
) {
  if (tracePrefs.showTitles === false) return true;
  const key = thinkingStepKey(entry, index);
  if (uiState?.expanded.has(key)) return true;
  if (uiState?.collapsed.has(key)) return false;
  if (streaming) return true;
  if (collapseAll) return false;
  if (tracePrefs.expandShell && entryHasShellTool(entry)) return true;
  if (tracePrefs.expandEdit && entryHasEditTool(entry)) return true;
  return false;
}

function shouldDefaultOpenThinkingEntry(
  entry,
  trace,
  streaming,
  streamContent,
  uiState = null
) {
  if (streaming) return true;
  if (entry.isolated && entry.worker) return true;
  if (tracePrefs.expandShell && entryHasShellTool(entry)) return true;
  if (tracePrefs.expandEdit && entryHasEditTool(entry)) return true;
  return false;
}

function applyStreamingDetailsOpen(el, nextOpen) {
  if (!el) return false;
  const want = !!nextOpen;
  if (el.open === want) return false;
  if (typeof setStreamingDetailsOpen === 'function') {
    return setStreamingDetailsOpen(el, want);
  }
  el.open = want;
  return true;
}

function thinkingStepDomKey(entry, index) {
  const sid = entry.subagentId ? String(entry.subagentId) : '';
  const round = entry.round != null ? entry.round : index + 1;
  const phase = String(entry.phase || `r${round}`);
  return sid ? `sa:${sid}:r${round}` : `${phase}::${round}::${index}`;
}

function appendInlineToolDiff(parent, tool, { roundComplete = false } = {}) {
  if (!parent || !tool || !isEditToolName(tool.name)) return;
  const diff = tool.diff && typeof tool.diff === 'object' ? tool.diff : null;
  if (!diff || (typeof toolDiffHasBody === 'function' && !toolDiffHasBody(diff))) return;

  const details = document.createElement('details');
  details.className = 'msg-tool-inline-diff';
  if (tracePrefs.expandEdit && !roundComplete) details.open = true;

  const summary = document.createElement('summary');
  summary.className = 'msg-tool-inline-diff-summary';
  const title = diff.created ? '新建文件' : '查看 diff';
  summary.textContent = `${title} · +${Number(diff.added) || 0} -${Number(diff.removed) || 0}`;
  if (diff.textTruncated) {
    const note = document.createElement('span');
    note.className = 'msg-tool-inline-diff-trunc';
    note.textContent = '（大文件，仅变更片段）';
    summary.appendChild(note);
  }
  details.appendChild(summary);

  const grid = document.createElement('div');
  grid.className = 'agents-md-diff-grid msg-tool-inline-diff-grid';

  const beforePane = document.createElement('div');
  beforePane.className = 'agents-md-diff-pane';
  const beforeLabel = document.createElement('div');
  beforeLabel.className = 'agents-md-diff-label';
  beforeLabel.textContent = '修改前';
  const beforePre = document.createElement('pre');
  beforePre.className = 'agents-md-diff-pre';
  beforePre.textContent =
    typeof pickDiffDisplayText === 'function'
      ? pickDiffDisplayText(diff, 'before') || '（空 / 新建）'
      : '（空 / 新建）';
  beforePane.append(beforeLabel, beforePre);

  const afterPane = document.createElement('div');
  afterPane.className = 'agents-md-diff-pane';
  const afterLabel = document.createElement('div');
  afterLabel.className = 'agents-md-diff-label';
  afterLabel.textContent = '修改后';
  const afterPre = document.createElement('pre');
  afterPre.className = 'agents-md-diff-pre';
  afterPre.textContent =
    typeof pickDiffDisplayText === 'function' ? pickDiffDisplayText(diff, 'after') || '（空）' : '（空）';
  afterPane.append(afterLabel, afterPre);

  grid.append(beforePane, afterPane);
  details.appendChild(grid);
  parent.appendChild(details);
}

function thinkingToolsSignature(tools, roundComplete) {
  return `${roundComplete ? '1' : '0'}|${(tools || [])
    .map((t) => {
      const diff = t.diff
        ? `${String(t.diff.beforeText || '').length}:${String(t.diff.afterText || '').length}`
        : '';
      return `${t.id || ''}:${t.name}:${t.pending ? 1 : 0}:${t.failed ? 1 : 0}:${t.summary || ''}:${diff}`;
    })
    .join(';')}`;
}

function appendThinkingToolRows(ul, tools, { roundComplete = false } = {}) {
  const list = tools || [];
  const sig = thinkingToolsSignature(list, roundComplete);
  if (ul.dataset.toolsSig === sig && ul.childElementCount === list.length) {
    return;
  }
  ul.dataset.toolsSig = sig;
  ul.replaceChildren();
  for (const t of list) {
    const li = document.createElement('li');
    const label = t.argsBrief ? `${t.name}(${t.argsBrief})` : t.name;
    if (t.name === 'fs_write_file' || t.name === 'fs_edit') {
      const p = String(t.toolArgs?.filePath || t.argsBrief || '').trim();
      if (p && typeof normWritePath === 'function') {
        li.dataset.toolPath = normWritePath(p);
      } else if (p) {
        li.dataset.toolPath = p.replace(/\\/g, '/').toLowerCase();
      }
    }
    if (t.pending) {
      li.className = 'msg-thinking-tool-pending';
      li.textContent = `${label} …`;
    } else {
      const failed =
        !!t.failed ||
        (t.summary && String(t.summary).startsWith('错误')) ||
        (t.summary && String(t.summary).startsWith('失败'));
      if (failed) li.className = 'msg-thinking-tool-failed';
      const row = document.createElement('div');
      row.className = 'msg-thinking-tool-row';
      const text = document.createElement('span');
      text.className = 'msg-thinking-tool-text';
      text.textContent = `${label} → ${t.summary}`;
      row.appendChild(text);
      if (failed && t.name && t.toolArgs && window.diecloud && window.diecloud.agentRetryTool) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'msg-thinking-tool-retry';
        btn.textContent = '重试';
        btn.title = '重新执行此工具调用';
        btn.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          btn.disabled = true;
          void window.diecloud
            .agentRetryTool({
              name: t.name,
              args: t.toolArgs,
              sessionId:
                (btn.closest('.msg') && btn.closest('.msg').dataset.runSessionId) ||
                (typeof currentSessionId !== 'undefined' ? currentSessionId : undefined),
              undoTurnId:
                typeof getCurrentUndoTurnId === 'function' ? getCurrentUndoTurnId() : undefined
            })
            .then((r) => {
              if (r && r.error) {
                text.textContent = `${label} → 错误: ${r.error}`;
                if (typeof showAgentToast === 'function') {
                  showAgentToast('工具重试失败', String(r.error).slice(0, 200), { variant: 'error' });
                }
              } else if (typeof summarizeToolResult === 'function') {
                text.textContent = `${label} → ${summarizeToolResult(t.name, r)}`;
                li.classList.remove('msg-thinking-tool-failed');
                if (typeof showAgentToast === 'function') {
                  showAgentToast('工具已重试', t.name, { variant: 'success' });
                }
              }
            })
            .catch((err) => {
              if (typeof showAgentToast === 'function') {
                showAgentToast('工具重试失败', err.message || String(err), { variant: 'error' });
              }
            })
            .finally(() => {
              btn.disabled = false;
            });
        });
        row.appendChild(btn);
      }
      li.appendChild(row);
      appendInlineToolDiff(li, t, { roundComplete });
    }
    ul.appendChild(li);
  }
}

function thinkingRoundFilesSignature(files) {
  return (files || [])
    .map((f) => `${f.path || f.name || ''}:${f.pending ? 1 : 0}:${Number(f.added) || 0}:${Number(f.removed) || 0}`)
    .join(';');
}

function patchThinkingRoundFiles(block, entry, index, trace) {
  const isLastRound = trace && index === trace.length - 1;
  const roundFiles =
    isLastRound && typeof collectTraceEntryFileChanges === 'function'
      ? collectTraceEntryFileChanges(entry)
      : [];
  let fileList = block.querySelector('.msg-thinking-round-files');
  if (!isLastRound || !roundFiles.length) {
    if (fileList) fileList.remove();
    return;
  }
  const sig = thinkingRoundFilesSignature(roundFiles);
  if (fileList && fileList.dataset.filesSig === sig) return;
  if (!fileList) {
    fileList = document.createElement('ul');
    fileList.className = 'msg-thinking-round-files';
    const toolsEl = block.querySelector('.msg-thinking-tools');
    if (toolsEl) block.insertBefore(fileList, toolsEl);
    else block.appendChild(fileList);
  }
  fileList.dataset.filesSig = sig;
  fileList.replaceChildren();
  for (const f of roundFiles) {
    const li = document.createElement('li');
    li.className = 'msg-thinking-round-file-item' + (f.pending ? ' is-pending' : '');
    const name = document.createElement('span');
    name.className = 'msg-thinking-round-file-name';
    name.textContent = f.name;
    name.title = f.path;
    const stats = document.createElement('span');
    stats.className = 'msg-thinking-round-file-stats';
    if (f.pending && f.added == null && f.removed == null) {
      stats.textContent = '…';
    } else {
      stats.textContent = `+${Number(f.added) || 0} -${Number(f.removed) || 0}`;
    }
    li.append(name, stats);
    fileList.appendChild(li);
  }
}

function fillThinkingRoundBlock(block, entry, index, trace, streaming, streamContent) {
  const complete = isThinkingRoundComplete(entry, index, trace, streaming, streamContent);
  block.dataset.roundComplete = complete ? '1' : '0';

  if (Array.isArray(entry.bootSteps) && entry.bootSteps.length) {
    let bootPanel = block.querySelector('.msg-thinking-rust-boot');
    if (!bootPanel) {
      bootPanel =
        typeof renderRustLoopBootPanel === 'function'
          ? renderRustLoopBootPanel(entry.bootSteps)
          : null;
      if (bootPanel) block.insertBefore(bootPanel, block.firstChild);
    } else if (typeof syncRustLoopBootPanel === 'function') {
      syncRustLoopBootPanel(bootPanel, entry.bootSteps);
    }
  } else {
    block.querySelector('.msg-thinking-rust-boot')?.remove();
  }

  let thoughtEl = block.querySelector('.msg-thinking-thought');
  if (tracePrefs.showReasoning) {
    const display = visibleThoughtDisplay(entry, index, trace, streaming);
    if (display) {
      if (!thoughtEl) {
        thoughtEl = document.createElement('div');
        thoughtEl.className = 'msg-thinking-thought';
        const bootPanel = block.querySelector('.msg-thinking-rust-boot');
        if (bootPanel) bootPanel.insertAdjacentElement('afterend', thoughtEl);
        else block.insertBefore(thoughtEl, block.firstChild);
      }
      updateIncrementalTextContent(thoughtEl, display);
    } else if (thoughtEl) {
      thoughtEl.remove();
    }
  } else if (thoughtEl) {
    thoughtEl.remove();
  }
}

function fillThinkingRoundBeat(beat, entry, index, trace, streaming, streamContent) {
  if (!beat) return;
  const vis = String(entry.visibleContent || '').trim();
  let nar = beat.querySelector('.msg-thinking-narration');
  if (vis) {
    if (!nar) {
      nar = document.createElement('div');
      nar.className = 'msg-thinking-narration';
      beat.insertBefore(nar, beat.firstChild);
    }
    updateIncrementalTextContent(nar, vis);
  } else if (nar) {
    clearIncrementalTextState(nar);
    nar.remove();
  }

  const complete = isThinkingRoundComplete(entry, index, trace, streaming, streamContent);
  patchThinkingRoundFiles(beat, entry, index, trace);
  const tools = entry.tools || [];
  let ul = beat.querySelector('.msg-thinking-tools');
  if (tools.length) {
    if (!ul) {
      ul = document.createElement('ul');
      ul.className = 'msg-thinking-tools';
      beat.appendChild(ul);
    }
    appendThinkingToolRows(ul, tools, { roundComplete: complete });
  } else if (ul) {
    ul.remove();
  }
  beat.classList.toggle('is-empty', !beat.childElementCount);
}

function mountThinkingRoundDetails(
  entry,
  index,
  trace,
  {
    streaming,
    stateHost,
    uiState,
    effectiveCollapseAll,
    keepOpen,
    undoTurnId,
    checkpointRestore,
    streamContent
  }
) {
  const stepKey = thinkingStepKey(entry, index);
  const complete = isThinkingRoundComplete(entry, index, trace, streaming, streamContent);
  const wrap = document.createElement('div');
  wrap.className = 'msg-thinking-step';
  wrap.dataset.stepKey = thinkingStepDomKey(entry, index);
  const details = document.createElement('details');
  details.className = 'msg-thinking-round-details';
  details.dataset.stepKey = wrap.dataset.stepKey;
  if (tracePrefs.showTitles === false) details.classList.add('msg-thinking-no-title');
  applyStreamingDetailsOpen(
    details,
    keepOpen ||
      resolveThinkingStepOpen(
        entry,
        index,
        trace,
        streaming,
        uiState,
        effectiveCollapseAll,
        streamContent
      )
  );
  if (complete && !details.open) details.classList.add('is-collapsed-auto');
  details.addEventListener('toggle', () => {
    if (!uiState) return;
    if (details.open) {
      uiState.expanded.add(stepKey);
      uiState.collapsed.delete(stepKey);
      details.classList.remove('is-collapsed-auto');
    } else {
      uiState.collapsed.add(stepKey);
      uiState.expanded.delete(stepKey);
      if (complete) details.classList.add('is-collapsed-auto');
    }
  });

  const summary = document.createElement('summary');
  summary.className = 'msg-thinking-round-summary';
  const combinedLabel = tracePrefs.showTitles ? thinkingRoundSummaryLabel(entry, index, trace) : '';
  summary.title = tracePrefs.showTitles ? combinedLabel || thinkingRoundTitle(entry) : '';
  const hasLabel = syncThinkingRoundSummaryLabel(summary, entry, index, trace);
  if (shouldShowCheckpointRestore(entry, { checkpointRestore, undoTurnId, complete })) {
    appendCheckpointRestoreLink(summary, {
      undoTurnId,
      batchId: entry.checkpointId,
      afterLabel: hasLabel
    });
  }
  if (entry.isolated) details.classList.add('msg-thinking-subagent');
  if (entry.parallel && entry.worker) details.classList.add('msg-thinking-parallel');
  details.appendChild(summary);

  const block = document.createElement('div');
  block.className = 'msg-thinking-round';
  const last = streaming && index === trace.length - 1;
  fillThinkingRoundBlock(block, entry, index, trace, last, streamContent);
  details.appendChild(block);
  const beat = document.createElement('div');
  beat.className = 'msg-thinking-beat';
  fillThinkingRoundBeat(beat, entry, index, trace, last, streamContent);
  wrap.append(details, beat);
  return wrap;
}

function syncThinkingRoundDetails(
  details,
  entry,
  index,
  trace,
  { streaming, uiState, effectiveCollapseAll, keepOpen, undoTurnId, checkpointRestore, streamContent }
) {
  const complete = isThinkingRoundComplete(entry, index, trace, streaming, streamContent);
  const shouldOpen =
    keepOpen ||
    resolveThinkingStepOpen(
      entry,
      index,
      trace,
      streaming,
      uiState,
      effectiveCollapseAll,
      streamContent
    );
  applyStreamingDetailsOpen(details, shouldOpen);
  details.classList.toggle('is-collapsed-auto', complete && !details.open);

  const summary = details.querySelector('.msg-thinking-round-summary');
  if (summary) {
    const combinedLabel = tracePrefs.showTitles ? thinkingRoundSummaryLabel(entry, index, trace) : '';
    summary.title = tracePrefs.showTitles ? combinedLabel || thinkingRoundTitle(entry) : '';
    syncThinkingRoundSummaryLabel(summary, entry, index, trace);
  }

  details.classList.toggle('msg-thinking-subagent', !!entry.isolated);
  details.classList.toggle('msg-thinking-parallel', !!(entry.parallel && entry.worker));

  const last = streaming && index === trace.length - 1;
  const block = details.querySelector('.msg-thinking-round');
  if (block) {
    fillThinkingRoundBlock(block, entry, index, trace, last, streamContent);
  }
  const beat =
    details.closest('.msg-thinking-step')?.querySelector(':scope > .msg-thinking-beat') || null;
  if (beat) {
    fillThinkingRoundBeat(beat, entry, index, trace, last, streamContent);
  }
}
