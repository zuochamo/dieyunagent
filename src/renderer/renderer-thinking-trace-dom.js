/* global document, tracePrefs, upgradeAgentTraceRecord, entryHasShellTool, entryHasEditTool, isEditToolName, getAgentContinueState, resumeAgentToolLoop, renderAssistantAnswerContent, rollbackToBatchCheckpoint, showAgentToast, AgentRoundText, toolDiffHasBody, pickDiffDisplayText, compactDiffForTrace, normWritePath, followChatStreamGrowth, scheduleStreamingChatFollow, setStreamingDetailsOpen, startThinkingTransitionPin, AgentRoundText, sessionActiveRuns, escapeHtml, formatInlineUnifiedDiffHtml, openSubagentPanelDetail, gatewayCall, openArtifactTab, isThinkingDampedFlow, SCROLL_DAMP_TAU_MS */
'use strict';

/** 工具行的稳定签名（不含思考正文） */
function thinkingToolsStructureSig(tools) {
  return (tools || [])
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
}

/** 子 Agent 卡片内各轮（轮号 + 该轮工具）的稳定签名，卡片内容变化据此触发重绘 */
function isolatedCardRoundsSig(entry) {
  const rounds = Array.isArray(entry && entry.rounds) ? entry.rounds : null;
  if (!rounds) return '';
  return rounds
    .map((r) => `${r && r.round != null ? r.round : ''}~${thinkingToolsStructureSig(r && r.tools)}`)
    .join(';');
}

/** 结构签名：不含 thought 正文，用于区分「仅流式文本」与「trace 结构变化」 */
function thinkingTraceStructureSig(trace) {
  if (!trace || !trace.length) return '';
  return trace
    .map((entry, index) => {
      const tools = entry.tools || [];
      const toolSig = thinkingToolsStructureSig(tools);
      const roundsSig = isolatedCardRoundsSig(entry);
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
        entry.runDone ? '1' : '0',
        roundsSig,
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
  if ((entry?.tools || []).some((t) => t && t.pending)) return true;
  // 子 Agent 卡片的工具在 rounds 内（全部内容都在卡片里）
  if (Array.isArray(entry?.rounds)) {
    return entry.rounds.some((r) => (r?.tools || []).some((t) => t && t.pending));
  }
  return false;
}

function thoughtTextForDisplay(entry) {
  // 账本只记模型原文：不再做 status 剥离 / 重复前言去重（2026-10-28 整改）。
  return String(entry?.fullThought || entry?.thought || '').trim();
}

function visibleThoughtDisplay(entry, index, trace, streaming) {
  const raw = String(entry?.fullThought || entry?.thought || '').trim();
  const thoughtText = thoughtTextForDisplay(entry);
  if (thoughtText && !entry?.placeholder) return thoughtText;
  if (raw && !entry?.placeholder) return '';
  return streaming ? '思考中…' : thoughtText || '';
}

function isThinkingRoundInProgress(entry, index, trace, streaming, streamContent) {
  if (!streaming) return false;
  if (index !== trace.length - 1) return false;
  if (entryHasPendingTools(entry)) return true;
  const phase = String(entry.phase || '').trim();
  if (phase === '汇总') {
    return entry?.placeholder === true;
  }
  const tools = entry.tools || [];
  if (tools.length > 0) return false;
  if (String(streamContent || '').trim()) return false;
  const full = String(entry.fullThought || entry.thought || '').trim();
  return entry?.placeholder === true || !!full;
}

function isThinkingRoundComplete(entry, index, trace, streaming, streamContent) {
  if (!streaming) return true;
  if (index < trace.length - 1) return true;
  return !isThinkingRoundInProgress(entry, index, trace, streaming, streamContent);
}

/**
 * 是否已进入「本轮确认不再调工具」的正文阶段。
 * 信号唯一来源：renderer-agent-rust-loop 在 llm_response(toolCalls=0) 与 synthesis 时
 * 给当轮打的 answerPhase 标记。
 * 不能用「streamContent 非空」去猜：模型中间轮常先出文本再发 tool_calls，
 * 那几秒会被误判成正文阶段，思考区就会「收起又展开」。
 */
function traceAnswerPhase(trace) {
  const rows = trace || [];
  // 子 Agent 过程卡片是并列插入的，不代表父运行进度：跳过它们找父运行的最后一行。
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    if (rows[i] && rows[i].isolated) continue;
    return !!rows[i].answerPhase;
  }
  return false;
}

/** trace 里是否含子 Agent 过程卡片（并发 subagent / planner 执行器）。 */
function hasIsolatedThinkingEntry(trace) {
  return Array.isArray(trace) && trace.some((e) => e && e.isolated);
}

/** 子 Agent 卡片条目：一个子 Agent = 一条 trace，全部轮次在 entry.rounds 内。 */
function isIsolatedCardEntry(entry) {
  return !!(entry && entry.isolated && Array.isArray(entry.rounds));
}

/**
 * 是否展示 trace 标题（卡片身份标题 + 轮次摘要）。
 * 子 Agent 卡片的身份标题（类型 + 序号）不跟随「显示标题」开关：并发多张卡片时，
 * 标题是「一眼认出是哪张卡片」的唯一依据，隐藏后卡片将无法区分。
 */
function shouldShowTraceTitle(entry) {
  return tracePrefs.showTitles !== false || !!(entry && entry.isolated);
}

/** 卡片是否仍在运行：优先用 Main 推来的 done 标记，其次用「是否还有未完成工具 / 占位文案」兜底。 */
function isolatedCardRunning(entry) {
  const rounds = Array.isArray(entry && entry.rounds) ? entry.rounds : [];
  if (rounds.some((r) => (r && r.tools || []).some((t) => t && t.pending))) return true;
  if (entry && entry.runDone === true) return false;
  if (entry && entry.runDone === false) return true;
  const last = rounds.length ? rounds[rounds.length - 1] : null;
  return !!(last && last.placeholder);
}

function thinkingRoundTitle(entry) {
  if (entry.phase) return entry.phase;
  return '思考';
}

function thinkingStepKey(entry, index) {
  // 子 Agent 卡片 = 一个 subagentId 一张卡；父循环新增轮次会改变 index，
  // 必须用 subagentId 做稳定键，否则父循环每推进一步，用户手动的展开/折叠状态就会丢。
  // 与 thinkingStepDomKey 对齐。
  if (entry.subagentId) return `sa:${entry.subagentId}`;
  return `${index}:${entry.phase || `r${entry.round}`}:`;
}

function getThinkingUiState(hostEl) {
  if (!hostEl) return null;
  if (!hostEl._thinkingUi) {
    hostEl._thinkingUi = {
      expanded: new Set(),
      collapsed: new Set(),
      liveRun: false,
      userOpen: null,
      flowEntered: new Set()
    };
  }
  return hostEl._thinkingUi;
}

/** 重绘只清步骤级记忆，保留用户手动展开/折叠的选择 */
function resetThinkingUiState(hostEl) {
  if (!hostEl) return;
  const prev = hostEl._thinkingUi;
  hostEl._thinkingUi = {
    expanded: new Set(),
    collapsed: new Set(),
    liveRun: false,
    userOpen: prev && typeof prev.userOpen === 'boolean' ? prev.userOpen : null,
    flowEntered: new Set()
  };
  delete hostEl.dataset.thinkingTraceSig;
}

/** 本轮 run 是否仍在执行：依据 sessionActiveRuns 登记，而不是 loading / 文案 */
function thinkingRunState(hostEl) {
  const sid = hostEl?.dataset?.runSessionId;
  if (!sid || typeof sessionActiveRuns === 'undefined' || !sessionActiveRuns) return null;
  const live = sessionActiveRuns.get(String(sid));
  return live && !live.finished ? live : null;
}

/** 把「本轮 run 是否仍在跑」记到思考区 UI 状态，供 resolveThinkingOuterOpen 判定 */
function applyThinkingLiveState(hostEl) {
  const uiState = getThinkingUiState(hostEl);
  if (!uiState) return;
  uiState.liveRun = !!thinkingRunState(hostEl);
}

function bindThinkingOuterToggle(outer, uiState) {
  if (!outer || !uiState) return;
  bindDetailsUserIntent(outer, (open) => {
    uiState.userOpen = open;
  });
}

/**
 * 思考区展开规则（单一来源，不要再叠记忆类补丁）：
 *   1. 停止态 → 展开
 *   2. 流式期间用户手动选择优先
 *   3. 本轮确认不再调工具（正文阶段）→ 折叠
 *   4. 仍在思考（流式 / run 未结束）→ 展开
 *   5. 本轮结束 → 按原逻辑折叠
 * 例外：含子 Agent 过程卡片的思考区不自动折叠（卡片就是「要看的过程」），仍可手动折叠。
 */
function resolveThinkingOuterOpen({
  streaming,
  keepOpen,
  effectiveCollapseAll,
  trace,
  streamContent,
  uiState
}) {
  if (keepOpen) return true;
  const hasCards = hasIsolatedThinkingEntry(trace);
  if (streaming && uiState?.userOpen != null) return uiState.userOpen;
  if (traceAnswerPhase(trace)) return hasCards;
  if (streaming || uiState?.liveRun) return true;
  if (effectiveCollapseAll) return hasCards;
  return trace.some((e, i) =>
    shouldDefaultOpenThinkingEntry(e, trace, streaming, streamContent, uiState)
  );
}

function thinkingOuterSummaryLabel(trace, { streaming = false, keepOpen = false } = {}) {
  if (keepOpen) return '已停止';
  if (!streaming) return '已完成';
  if (traceAnswerPhase(trace)) return '生成回答中';
  return '思考中';
}

function syncThinkingOuterSummary(outer, trace, { streaming, keepOpen }) {
  const summary = outer?.querySelector('.msg-thinking-outer-summary');
  if (!summary) return;
  const label = thinkingOuterSummaryLabel(trace, { streaming, keepOpen });
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

function compactReasoningPreviewText(text, maxChars = THINKING_SUMMARY_PREVIEW_CHARS, placeholder = false) {
  let t = String(text || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  // 平台占位文案（结构标记）不进摘要预览
  if (!t || placeholder) return '';
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
      ? thoughtTextForDisplay(entry)
      : String(entry.fullThought || entry.thought || '');
  return compactReasoningPreviewText(text, THINKING_SUMMARY_PREVIEW_CHARS, entry?.placeholder === true);
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
 * @returns {{ name?: string, primary: string, suffix: string, combined: string }}
 */
function thinkingRoundSummaryParts(entry, index, trace) {
  const toolN = (entry.tools || []).length;
  const phase = String(entry.phase || '').trim();
  const pendingTools = (entry.tools || []).some((t) => t && t.pending);
  const preview = reasoningPreviewFromEntry(entry, index, trace);
  const toolSuffix = toolSuffixFromEntry(entry);

  if (entry.isolated) {
    // 子 Agent 卡片：标题只显示「子 Agent 类型 + 序号」（entry.phase，由 live-loop-trace 统一拼装）
    // 与运行状态/步数。**不再拼最新思考预览**：那一行每个 token 都在变，一次 32 步的子 Agent
    // 会在运行期间把标题改写上百次，收尾后又停在一句随机的话上 —— 标题本该是稳定的身份牌，
    // 思考全文就在卡片正文里，不需要标题替它做摘要。
    const rounds = Array.isArray(entry.rounds) ? entry.rounds : [];
    const stepN = rounds.length
      ? rounds.reduce((n, r) => n + ((r && r.tools) || []).length, 0)
      : toolN;
    const running = isolatedCardRunning(entry);
    const name = phase || '子 Agent';
    const status = running ? '运行中…' : stepN ? `已完成 · ${stepN} 步` : '已完成';
    return {
      name,
      primary: '',
      suffix: status,
      combined: joinSummaryParts(name, status)
    };
  }

  if (!entry.isolated && phase.startsWith('调度 ·')) {
    const primary = preview || phase;
    return { primary, suffix: toolSuffix, combined: joinSummaryParts(primary, toolSuffix) };
  }

  if (phase === '汇总') {
    const t = String(entry.thought || entry.fullThought || '').trim();
    // 汇总这一步「生成中 / 成功 / 失败」三句文案是**单一来源**（`agent-round-text.js` 的
    // SYNTHESIS_START / SYNTHESIS_DONE / SYNTHESIS_FAILED，由 agent-synthesis 写进 trace）。
    // 这里按值相等认状态，不再用 /正在生成|生成中/、/未完成|失败/ 去猜模型写出来的文字。
    const roundText = typeof AgentRoundText !== 'undefined' && AgentRoundText ? AgentRoundText : {};
    if (t && t === roundText.SYNTHESIS_START) {
      return { primary: preview || '汇总 · 生成中…', suffix: '', combined: preview || '汇总 · 生成中…' };
    }
    if (t && t === roundText.SYNTHESIS_FAILED) {
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

  // 不用「执行工具…」占位：没有可用预览时退回真实轮次标题（phase），
  // 工具进度由工具行自己表达，避免摘要里出现无信息量的假文案。
  if (pendingTools) {
    const pendingTitle = thinkingRoundTitle(entry);
    return { primary: pendingTitle, suffix: '', combined: pendingTitle };
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
      '.msg-thinking-subagent-name, .msg-thinking-round-summary-preview, .msg-thinking-round-summary-tools, .msg-thinking-round-summary-sep, .msg-thinking-round-summary-label'
    )
    .forEach((el) => el.remove());

  if (!shouldShowTraceTitle(entry)) return false;

  const cpBtn = summary.querySelector('.msg-checkpoint-restore-btn');
  // 子 Agent 卡片的「详情」入口固定留在行尾：标题片段插在它前面
  const detailBtn = summary.querySelector('.msg-thinking-subagent-detail');
  const { name, primary, suffix } = thinkingRoundSummaryParts(entry, index, trace);
  const insertNode = (node) => {
    if (cpBtn) summary.insertBefore(node, cpBtn);
    else if (detailBtn) summary.insertBefore(node, detailBtn);
    else summary.appendChild(node);
  };

  let wrote = false;
  const writePart = (cls, text) => {
    if (!text) return;
    if (wrote) {
      const sep = document.createElement('span');
      sep.className = 'msg-checkpoint-restore-sep msg-thinking-round-summary-sep';
      sep.textContent = ' · ';
      insertNode(sep);
    }
    const span = document.createElement('span');
    span.className = cls;
    span.textContent = text;
    span.title = text;
    insertNode(span);
    wrote = true;
  };

  // 子 Agent 卡片的 name = 「类型 + 序号」标题；普通轮次没有 name。
  writePart('msg-thinking-subagent-name', name);
  writePart('msg-thinking-round-summary-preview', primary);
  writePart('msg-thinking-round-summary-tools', suffix);

  return wrote;
}

function shouldShowCheckpointRestore(entry, { checkpointRestore, undoTurnId, complete }) {
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
          // 单检查点没有 git 树可比对：shell 改的路径没被覆盖，必须说出来
          if (r.warning) showAgentToast('部分改动未还原', r.warning, { variant: 'info', duration: 8000 });
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
  // 子 Agent 过程卡片默认展开，且不随「回合结束 / 正文阶段」自动折叠（用户手动折叠仍生效）。
  if (entry.isolated) return true;
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
  if (entry.isolated) return true;
  if (tracePrefs.expandShell && entryHasShellTool(entry)) return true;
  if (tracePrefs.expandEdit && entryHasEditTool(entry)) return true;
  return false;
}

/**
 * 展示态升级的唯一入口：把这一条气泡的 trace 从「展示态」换成完整态。
 *
 * 触发点只有**用户的展开动作**（某一轮思考 / 某个内联 diff）—— 展示态里那些被裁掉的
 * 正文，收起时本来也不可见。同一个 runId 只取一次（`trace-store` 的 `full` 档缓存）。
 *
 * @param {Element} hostEl 展开的那个节点（任意位于气泡内的元素）
 * @param {(trace: object[]) => void} onTrace 拿到完整 trace 后做什么（就地补 DOM，不整块重绘）
 * @returns {boolean} 是否真的发起了升级（false = 这条气泡不是回放来的，没有 runId）
 */
function requestTraceUpgrade(hostEl, onTrace) {
  if (!hostEl || typeof hostEl.closest !== 'function') return false;
  if (typeof upgradeAgentTraceRecord !== 'function') return false;
  const bubble = hostEl.closest('.msg');
  const runId = String((bubble && bubble.dataset && bubble.dataset.traceRunId) || '').trim();
  if (!runId) return false;
  void upgradeAgentTraceRecord(runId)
    .then((row) => {
      const trace = row && Array.isArray(row.trace) ? row.trace : null;
      if (!trace || !trace.length) return;
      if (typeof onTrace === 'function') onTrace(trace);
    })
    .catch((e) => console.warn(e));
  return true;
}

/**
 * 展示态升级的「同一轮」判据：两次读之间那一行可能又长过（运行中的 checkpoint），
 * 按下标找回时必须核对轮次身份，对不上宁可不补。
 */
function isSameThinkingEntry(a, b) {
  if (!a || !b) return false;
  if (String(a.phase || '') !== String(b.phase || '')) return false;
  if (a.round != null && b.round != null && Number(a.round) !== Number(b.round)) return false;
  return true;
}

/**
 * 程序化切换 details.open 的唯一入口（保留流式滚动钉底逻辑）。
 * 切换前登记期望值，toggle 回调据此区分「用户点击」与「程序化切换」；
 * 旧代码把程序化收起也记成用户意图，导致展开/折叠状态被写死。
 */
function setDetailsOpen(el, nextOpen) {
  if (!el) return false;
  const want = !!nextOpen;
  if (el.open === want) return false;
  el._progOpenWanted = want;
  if (typeof setStreamingDetailsOpen === 'function') {
    return setStreamingDetailsOpen(el, want);
  }
  el.open = want;
  return true;
}

/** 只在「非程序化造成」的 open 变化时回调 onUserIntent(open)，外层与轮次共用 */
function bindDetailsUserIntent(el, onUserIntent) {
  if (!el || el.dataset.detailsUserIntent === '1') return;
  el.dataset.detailsUserIntent = '1';
  el.addEventListener('toggle', (ev) => {
    if (ev.target !== el) return;
    const wanted = el._progOpenWanted;
    if (wanted !== undefined) {
      el._progOpenWanted = undefined;
      if (wanted === el.open) return;
    }
    if (typeof onUserIntent === 'function') onUserIntent(!!el.open);
  });
}

function thinkingStepDomKey(entry, index) {
  const sid = entry.subagentId ? String(entry.subagentId) : '';
  if (sid) return `sa:${sid}`;
  const round = entry.round != null ? entry.round : index + 1;
  const phase = String(entry.phase || `r${round}`);
  return `${phase}::${round}::${index}`;
}

function appendInlineToolDiff(parent, tool, { roundComplete = false, entryIndex = null, toolIndex = null } = {}) {
  if (!parent || !tool || !isEditToolName(tool.name)) return;
  let diff = tool.diff && typeof tool.diff === 'object' ? tool.diff : null;
  if (!diff || (typeof toolDiffHasBody === 'function' && !toolDiffHasBody(diff))) return;
  /** 展示态里 diff 正文被裁掉（`textTrimmed`）：展开这一下才去取完整态 */
  let diffTextTrimmed = diff.textTrimmed === true;

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

  const body = document.createElement('div');
  body.className = 'msg-tool-inline-diff-body agent-scroll';
  /*
   * diff 正文**惰性生成**：整轮结束后这条 `<details>` 是收起的（只有运行中且
   * `tracePrefs.expandEdit` 时才 `open`），而一屏 32 轮里可能有几十个 edit 行。
   * 以前不管开合都预先 `buildThinkingInlineDiffHtml` + `innerHTML` 一遍 —— 那是
   * LCS + 整段红绿的 DOM，正是单条 trace 里最大的一块（diff 全文 0.9–1.5MB），
   * 收起时一个字都看不见。现在只在真正展开那一下生成一次。
   */
  let diffBodyPending = true;
  const fillDiffBody = () => {
    if (!diffBodyPending) return;
    diffBodyPending = false;
    body.innerHTML = buildThinkingInlineDiffHtml(diff);
  };
  const openDiffBody = () => {
    if (!details.open || !diffBodyPending) return;
    if (!diffTextTrimmed) {
      fillDiffBody();
      return;
    }
    // 展示态：正文还在库里，展开这一下才取（同一个 runId 只取一次）
    diffBodyPending = false;
    body.innerHTML = '<div class="diff-line diff-eq">正在加载完整 diff…</div>';
    const started = requestTraceUpgrade(details, (fullTrace) => {
      const entry = entryIndex != null ? fullTrace[entryIndex] : null;
      const fullTool = entry && toolIndex != null ? (entry.tools || [])[toolIndex] : null;
      const fullDiff = fullTool && fullTool.diff;
      if (!fullDiff || typeof fullDiff !== 'object') {
        // 拿不到完整正文时**不许**用裁剪版（空 before/after）冒充 —— 那会显示成「（无内容）」，
        // 比明确说加载失败更误导。保留 textTrimmed，让用户收起再点一次可以重试。
        body.innerHTML = '<div class="diff-line diff-eq">（完整 diff 未能加载，收起后再点一次重试）</div>';
        diffBodyPending = true;
        return;
      }
      diff = { ...fullDiff };
      tool.diff = diff;
      diffTextTrimmed = false;
      diffBodyPending = true;
      fillDiffBody();
    });
    if (!started) {
      diffBodyPending = true;
      body.innerHTML = '<div class="diff-line diff-eq">（完整 diff 需要回到这条会话里重新打开）</div>';
    }
  };
  if (details.open) openDiffBody();
  // 监听常驻：靠 `diffBodyPending` 做幂等（生成过就直接 return）。
  // 不能挂 `once` —— 升级失败时我们保留 pending 让用户收起再点一次重试，
  // `once` 会在第一次 toggle 就把它消费掉，重试永远不触发。
  else details.addEventListener('toggle', openDiffBody);
  details.appendChild(body);
  parent.appendChild(details);
}

/**
 * 思考区内联 diff：上下单栏、绿增红删（unified）。
 * 复用面板同一套 LCS 渲染（formatInlineUnifiedDiffHtml），不在这里再造一份 diff 实现；
 * 仅当行数超过 LCS 上限（该函数返回「无 diff 内容」）时，退化为整段删 + 整段增。
 */
function buildThinkingInlineDiffHtml(diff) {
  const escape =
    typeof escapeHtml === 'function'
      ? escapeHtml
      : (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const before =
    typeof pickDiffDisplayText === 'function' ? String(pickDiffDisplayText(diff, 'before') || '') : '';
  const after =
    typeof pickDiffDisplayText === 'function' ? String(pickDiffDisplayText(diff, 'after') || '') : '';
  if (typeof formatInlineUnifiedDiffHtml === 'function') {
    const html = formatInlineUnifiedDiffHtml(before, after, { escapeHtml: escape });
    if (html && !html.includes('artifacts-empty')) return html;
  }
  return buildWholeFileDiffHtml(before, after, escape);
}

/** 超大文件兜底：整段删 + 整段增，仍然红绿；行数封顶避免 DOM 爆炸 */
function buildWholeFileDiffHtml(before, after, escape) {
  const MAX_LINES = 500;
  const take = (text) => {
    const all = String(text ?? '').split('\n');
    return all.length <= MAX_LINES ? { all, truncated: false } : { all: all.slice(0, MAX_LINES), truncated: true };
  };
  if (!before && !after) return '<div class="diff-line diff-eq">（无内容）</div>';
  const rows = [];
  if (before) {
    const { all, truncated } = take(before);
    for (const line of all) rows.push(`<div class="diff-line diff-del">${escape('-' + line)}</div>`);
    if (truncated) rows.push('<div class="diff-line diff-gap">…</div>');
  }
  if (after) {
    const { all, truncated } = take(after);
    for (const line of all) rows.push(`<div class="diff-line diff-add">${escape('+' + line)}</div>`);
    if (truncated) rows.push('<div class="diff-line diff-gap">…</div>');
  }
  return rows.join('');
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

/** HTML 产物预览的读取上限（module 内局部阈值；srcdoc 过大浏览器渲染也吃不住） */
const HTML_PREVIEW_MAX_BYTES = 400 * 1024;

/**
 * HTML 产物的聊天内预览卡（Gen UI 简版）：
 * - sandbox iframe（只有 allow-scripts，无 allow-same-origin → 页面拿不到宿主 DOM/storage）；
 * - 内容经 fs.read_file 异步读出后填 srcdoc；读不到/被截断就撤卡，不占位；
 * - 「在面板打开」复用 artifacts 面板的 openArtifactTab，不另造预览器。
 */
/**
 * 思考区里的 HTML 预览（edit 了 .html 文件时给一块 iframe）。
 *
 * **先把文件读出来，再插 iframe**：iframe 一旦先进 DOM、`srcdoc` 还没设，浏览器会按
 * `about:blank` 画一帧，而我们的 iframe 背景是 `#fff`（见 styles.css）—— 深色主题下
 * 就是「屏幕白闪一下」（2026-11-25 用户实测：编辑 html 文件时闪）。
 * 现在插入那一刻 `srcdoc` 已经设好，首帧就是真内容。
 */
function appendInlineHtmlPreview(li, t) {
  const p = String((t.toolArgs && t.toolArgs.filePath) || '').trim();
  if (!p || !/\.html?$/i.test(p)) return;
  if (li.querySelector('.msg-tool-html-preview')) return;
  Promise.resolve()
    .then(() =>
      gatewayCall('fs.read_file', { filePath: p, maxBytes: HTML_PREVIEW_MAX_BYTES })
    )
    .then((r) => {
      const content = r && typeof r.content === 'string' ? r.content : null;
      if (content == null || r.truncated) return;
      // 读回来这段时间里这一行可能已经被重建 / 移除：别往死节点里塞
      if (li.isConnected === false || li.querySelector('.msg-tool-html-preview')) return;
      const wrap = document.createElement('div');
      wrap.className = 'msg-tool-html-preview';
      const bar = document.createElement('div');
      bar.className = 'msg-tool-html-preview-bar';
      const name = document.createElement('span');
      name.textContent = 'HTML 预览';
      bar.appendChild(name);
      const openBtn = document.createElement('button');
      openBtn.type = 'button';
      openBtn.textContent = '在面板打开';
      openBtn.addEventListener('click', () => {
        if (typeof openArtifactTab === 'function') openArtifactTab(p);
      });
      bar.appendChild(openBtn);
      const frame = document.createElement('iframe');
      frame.setAttribute('sandbox', 'allow-scripts');
      frame.setAttribute('title', 'HTML 预览');
      frame.setAttribute('referrerpolicy', 'no-referrer');
      frame.srcdoc = content; // 先给内容，再入 DOM → 不留白帧
      wrap.appendChild(bar);
      wrap.appendChild(frame);
      li.appendChild(wrap);
    })
    .catch(() => {});
}

function appendThinkingToolRows(ul, tools, { roundComplete = false, entryIndex = null } = {}) {
  const list = tools || [];
  const sig = thinkingToolsSignature(list, roundComplete);
  if (ul.dataset.toolsSig === sig && ul.childElementCount === list.length) {
    return;
  }
  ul.dataset.toolsSig = sig;
  ul.replaceChildren();
  for (let ti = 0; ti < list.length; ti++) {
    const t = list[ti];
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
      li.appendChild(row);
      appendInlineToolDiff(li, t, { roundComplete, entryIndex, toolIndex: ti });
      // HTML 预览只在**整轮结束后**挂：流式期间这一行的 DOM 会被反复重建
      // （`ul.replaceChildren()`），每次都插一个 iframe + 重读同一个文件 ——
      // 深色界面里就是一遍遍白闪，而且同一个 html 被读很多次。
      if (!failed && roundComplete) appendInlineHtmlPreview(li, t);
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

/**
 * 等待备注（如「上游 42s 无数据」）的唯一 DOM 出入口：叠加在思考正文下方，不覆盖正文。
 * 流式快路径（renderer-thinking-trace.js#patchStreamingTextOnly）与整块重绘都必须调它，
 * 否则结构签名不变（只是备注变了）时备注不会出现。
 */
function syncThinkingLiveNote(block, entry) {
  if (!block) return;
  const note = String((entry && entry.liveNote) || '').trim();
  let noteEl = block.querySelector('.msg-thinking-live-note');
  if (note) {
    if (!noteEl) {
      noteEl = document.createElement('div');
      noteEl.className = 'msg-thinking-live-note';
      const anchor = block.querySelector('.msg-thinking-thought');
      if (anchor) anchor.insertAdjacentElement('afterend', noteEl);
      else block.insertBefore(noteEl, block.firstChild);
    }
    updateIncrementalTextContent(noteEl, note);
  } else if (noteEl) {
    clearIncrementalTextState(noteEl);
    noteEl.remove();
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

  syncThinkingLiveNote(block, entry);
}

/**
 * 「流式新生块」的入场标记（唯一写入口）：只在无极阻尼**当前生效**时打标，
 * 并在入场动画结束时立刻摘掉。
 * 两条都必须：CSS 的语义是「有 data-flow-enter 就播一次」，标记若永久留着，
 * 用户之后在设置里打开无极阻尼时，当前会话里所有历史块会整片重放一次淡入 ——
 * 正是这个开关要避免的事；阻尼关着时不打标，同理避免「补放一遍」。
 * @returns {boolean} 是否真的打了标记（调用方据此记账，见 flowEntered）
 */
function markThinkingFlowEnter(el) {
  if (!el) return false;
  if (typeof isThinkingDampedFlow !== 'function' || !isThinkingDampedFlow()) return false;
  el.dataset.flowEnter = '1';
  const done = (e) => {
    if (e.target !== el || e.animationName !== 'thinking-damped-in') return;
    el.removeEventListener('animationend', done);
    delete el.dataset.flowEnter;
  };
  el.addEventListener('animationend', done);
  return true;
}

function fillThinkingRoundBeat(beat, entry, index, trace, streaming, streamContent) {
  if (!beat) return;
  const vis = String(entry.visibleContent || '').trim();
  let nar = beat.querySelector('.msg-thinking-narration');
  if (vis) {
    if (!nar) {
      nar = document.createElement('div');
      nar.className = 'msg-thinking-narration';
      // 旁白刻意不加入场动画：它随 visibleContent 的有无被反复重建（每个 delta 都可能
      // 移除再新建），打标就等于一帧播一次入场，看起来一直在闪。这一轮要不要入场
      // 由外层 .msg-thinking-step 负责，旁白跟着它一起出来就够了。
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
    appendThinkingToolRows(ul, tools, { roundComplete: complete, entryIndex: index });
  } else if (ul) {
    ul.remove();
  }
  beat.classList.toggle('is-empty', !beat.childElementCount);
}

/**
 * 卡片内单轮：思考正文 + 工具行。全部落在卡片内部（不再有卡片外的 beat），
 * 随 rounds 更新实时刷新（工具 pending → 完成、思考正文流式增长）。
 *
 * `opts.forceReasoning`：忽略 `tracePrefs.showReasoning`。右侧「子代理」面板是
 * 用户显式打开的「看思考」视图，不该被聊天区的显示开关关成空壳。
 */
function fillIsolatedSubround(block, roundData, isLast, running, opts = {}) {
  const round = roundData || {};
  let thoughtEl = block.querySelector(':scope > .msg-thinking-thought');
  if (tracePrefs.showReasoning || opts.forceReasoning) {
    const text = String(round.fullThought || round.thought || '').trim();
    const display = text || (isLast && running ? '思考中…' : '');
    if (display) {
      if (!thoughtEl) {
        thoughtEl = document.createElement('div');
        thoughtEl.className = 'msg-thinking-thought';
        block.insertBefore(thoughtEl, block.firstChild);
      }
      updateIncrementalTextContent(thoughtEl, display);
    } else if (thoughtEl) {
      clearIncrementalTextState(thoughtEl);
      thoughtEl.remove();
    }
  } else if (thoughtEl) {
    clearIncrementalTextState(thoughtEl);
    thoughtEl.remove();
  }

  const tools = round.tools || [];
  let ul = block.querySelector(':scope > .msg-thinking-tools');
  if (tools.length) {
    if (!ul) {
      ul = document.createElement('ul');
      ul.className = 'msg-thinking-tools';
      block.appendChild(ul);
    }
    appendThinkingToolRows(ul, tools, { roundComplete: !isLast || !running });
  } else if (ul) {
    ul.remove();
  }
  block.classList.toggle('is-empty', !block.childElementCount);
}

/** 卡片正文是否贴底（判据只此一处，与聊天区同为 24px） */
function isIsolatedCardNearBottom(body) {
  return body.scrollHeight - body.scrollTop - body.clientHeight < 24;
}

/**
 * 「卡片正文要不要贴底」的用户意图位（唯一写入口）。
 *
 * 为什么不能只看滚动位置：卡片刚出现时 `scrollTop` 本来就是 0，而内容往往已经高过盒子
 * （一次子 Agent 直接跑出十几轮），「本来就贴底」永远不成立 —— 于是正文从此再也不跟。
 * 所以默认跟随，只有用户**在这块里真的滚过**（滚轮 / 触摸 / 拖滚动条 / 键盘）才让位；
 * 用户自己滚回贴底，自动恢复跟随。
 *
 * 两个坑（都踩过）：
 * - **点在正文里不算接管**：面板正文里点一下（选字、点开 diff、点链接）以前也会关掉跟随，
 *   表现就是「看着看着它不动了」，而且没有任何提示。只有按在**滚动条**上才算用户要接管。
 * - **程序化滚动也会触发 scroll 事件**：所以恢复跟随只看「已经让位过 + 现在贴底」，
 *   不能拿 scroll 当用户信号。
 */
function bindIsolatedCardFollowIntent(body) {
  if (!body || body.dataset.cardFollowIntent === '1') return;
  body.dataset.cardFollowIntent = '1';
  const yieldToUser = () => {
    body.dataset.cardFollowYield = '1';
    stopIsolatedCardFollow(body);
  };
  body.addEventListener('wheel', yieldToUser, { passive: true });
  body.addEventListener('touchmove', yieldToUser, { passive: true });
  body.addEventListener(
    'pointerdown',
    (e) => {
      const rect = body.getBoundingClientRect();
      if (e.clientX - rect.left >= body.clientWidth) yieldToUser();
    },
    { passive: true }
  );
  body.addEventListener(
    'keydown',
    (e) => {
      if (
        e.key === 'ArrowUp' ||
        e.key === 'ArrowDown' ||
        e.key === 'PageUp' ||
        e.key === 'PageDown' ||
        e.key === 'Home' ||
        e.key === 'End' ||
        e.key === ' '
      ) {
        yieldToUser();
      }
    },
    { passive: true }
  );
  body.addEventListener(
    'scroll',
    () => {
      if (body.dataset.cardFollowYield !== '1') return;
      if (!isIsolatedCardNearBottom(body)) return;
      delete body.dataset.cardFollowYield;
    },
    { passive: true }
  );
}

/** @type {WeakMap<Element, { raf: number, lastTs: number }>} */
const isolatedCardFollowState = new WeakMap();

function stopIsolatedCardFollow(body) {
  const state = isolatedCardFollowState.get(body);
  if (!state || !state.raf) return;
  cancelAnimationFrame(state.raf);
  state.raf = 0;
  state.lastTs = 0;
}

/**
 * 运行中的卡片正文贴底：默认跟随（阻尼开着时逐帧逼近，见 renderer-chat-render.js 的同一手感），
 * 用户上翻过就让位（意图位 `data-card-follow-yield`）。
 */
function followIsolatedCardBody(body) {
  if (!body || body.dataset.cardFollowYield === '1') return;
  const damped = typeof isThinkingDampedFlow === 'function' && isThinkingDampedFlow();
  const target = Math.max(0, body.scrollHeight - body.clientHeight);
  if (!damped) {
    stopIsolatedCardFollow(body);
    body.scrollTop = target;
    return;
  }
  let state = isolatedCardFollowState.get(body);
  if (!state) {
    state = { raf: 0, lastTs: 0 };
    isolatedCardFollowState.set(body, state);
  }
  if (state.raf) return;
  const tick = () => {
    const maxScroll = Math.max(0, body.scrollHeight - body.clientHeight);
    const delta = maxScroll - body.scrollTop;
    // 1px 内落位：亚像素取整会让「每帧推进 0.1px」变成永远追不到
    if (!body.isConnected || Math.abs(delta) <= 1) {
      if (body.isConnected) body.scrollTop = maxScroll;
      state.raf = 0;
      state.lastTs = 0;
      return;
    }
    const now = Date.now();
    const dt = state.lastTs ? Math.min(64, Math.max(8, now - state.lastTs)) : 16;
    state.lastTs = now;
    const before = body.scrollTop;
    body.scrollTop = before + delta * (1 - Math.exp(-dt / SCROLL_DAMP_TAU_MS));
    if (body.scrollTop === before) {
      body.scrollTop = maxScroll;
      state.raf = 0;
      state.lastTs = 0;
      return;
    }
    state.raf = requestAnimationFrame(tick);
  };
  state.raf = requestAnimationFrame(tick);
}

/**
 * 子 Agent 卡片正文：一个子 Agent 的全部轮次都在卡片里，按轮顺序渲染。
 * 正文是固定高度的滚动容器（见 styles.css .msg-thinking-subagent-body），
 * 运行中默认跟着最新一轮走（阻尼 = 无极阻尼开关），用户在这块里自己滚过就让位。
 *
 * `opts.runningHint`：调用方**已经知道这次运行还活着时的权威判定**（面板有整轮状态）。
 * 为什么需要它：`isolatedCardRunning(entry)` 只能在「有 pending 工具 / 有空占位 / 有 runDone」
 * 三条上判 —— planner 派出来的 worker 卡片没有 `runDone`，两轮之间（拿到思考、还没发工具）
 * 三条全不成立，会被判成「已结束」，于是正文恰好在最该跟的时刻停止跟随。
 */
function fillIsolatedCardBody(body, entry, opts = {}) {
  const rounds = Array.isArray(entry.rounds) ? entry.rounds : [];
  const running =
    typeof opts.runningHint === 'boolean' ? opts.runningHint : isolatedCardRunning(entry);
  const seen = new Set();
  rounds.forEach((r, i) => {
    const key = String(r && r.round != null ? r.round : i + 1);
    seen.add(key);
    let block = body.querySelector(`:scope > .msg-thinking-subround[data-subround="${key}"]`);
    if (!block) {
      block = document.createElement('div');
      block.className = 'msg-thinking-subround';
      block.dataset.subround = key;
      body.appendChild(block);
    }
    fillIsolatedSubround(block, r, i === rounds.length - 1, running, opts);
  });
  body.querySelectorAll(':scope > .msg-thinking-subround').forEach((el) => {
    if (!seen.has(el.dataset.subround || '')) el.remove();
  });
  body.classList.toggle('is-empty', !rounds.length);
  body.classList.toggle('is-multi-round', rounds.length > 1);
  if (running) {
    bindIsolatedCardFollowIntent(body);
    body.dataset.cardFollowing = '1';
    followIsolatedCardBody(body);
    return;
  }
  // 收尾那一拍补一次落位：运行期间一直在跟的卡片，最后一段内容不该停在折线以下。
  // 只对「跟过」的卡片做（历史卡片重绘时 dataset 不在，不会被拽到底部）。
  if (body.dataset.cardFollowing === '1') {
    delete body.dataset.cardFollowing;
    followIsolatedCardBody(body);
  }
}

/**
 * 卡片标题行尾的「详情」入口：把这张卡片同一份 `rounds` 在右侧「子代理」面板里
 * 全文展开（面板不另存数据，读的就是这个条目，见 renderer-subagent-panel.js）。
 * 独立按钮：必须拦掉冒泡，否则点它会顺带切换卡片折叠。
 */
function appendSubagentDetailLink(summary, entry) {
  const subagentId = String((entry && entry.subagentId) || '');
  if (!summary || !subagentId) return;
  let btn = summary.querySelector(':scope > .msg-thinking-subagent-detail');
  if (!btn) {
    btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'msg-thinking-subagent-detail';
    btn.textContent = '详情';
    btn.title = '在右侧面板查看该子代理的完整思考过程';
    btn.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      if (typeof openSubagentPanelDetail === 'function') {
        openSubagentPanelDetail(btn.dataset.subagentId || '');
      }
    });
    summary.appendChild(btn);
  }
  btn.dataset.subagentId = subagentId;
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
  /*
   * 入流标记按轮次记账：流式期间思考区会被反复重绘（同一轮的节点可能整棵重建），
   * 每次重建都打标就等于每帧重播一次入场动画 —— 表现是整片思考区一直闪。
   * flowEntered 记「这一轮已经入过流」，随本轮 run 的重置一起清空（见 resetThinkingUiState）。
   */
  if (streaming && uiState && !uiState.flowEntered.has(stepKey) && markThinkingFlowEnter(wrap)) {
    uiState.flowEntered.add(stepKey);
  }
  const details = document.createElement('details');
  details.className = 'msg-thinking-round-details';
  details.dataset.stepKey = wrap.dataset.stepKey;
  if (!shouldShowTraceTitle(entry)) details.classList.add('msg-thinking-no-title');
  if (uiState) {
    bindDetailsUserIntent(details, (open) => {
      if (open) {
        uiState.expanded.add(stepKey);
        uiState.collapsed.delete(stepKey);
        details.classList.remove('is-collapsed-auto');
      } else {
        uiState.collapsed.add(stepKey);
        uiState.expanded.delete(stepKey);
        if (complete) details.classList.add('is-collapsed-auto');
      }
    });
  }
  setDetailsOpen(
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

  const summary = document.createElement('summary');
  summary.className = 'msg-thinking-round-summary';
  const showTitle = shouldShowTraceTitle(entry);
  const combinedLabel = showTitle ? thinkingRoundSummaryLabel(entry, index, trace) : '';
  summary.title = showTitle ? combinedLabel || thinkingRoundTitle(entry) : '';
  const hasLabel = syncThinkingRoundSummaryLabel(summary, entry, index, trace);
  if (shouldShowCheckpointRestore(entry, { checkpointRestore, undoTurnId, complete })) {
    appendCheckpointRestoreLink(summary, {
      undoTurnId,
      batchId: entry.checkpointId,
      afterLabel: hasLabel
    });
  }
  if (entry.isolated) details.classList.add('msg-thinking-subagent');
  if (entry.parallel) details.classList.add('msg-thinking-parallel');
  details.classList.toggle('is-running', entry.isolated ? isolatedCardRunning(entry) : false);
  if (entry.isolated) appendSubagentDetailLink(summary, entry);
  details.appendChild(summary);

  if (isIsolatedCardEntry(entry)) {
    // 子 Agent 卡片：全部内容（思考 + 工具）都在卡片内部，没有卡片外的 beat。
    const body = document.createElement('div');
    body.className = 'msg-thinking-round msg-thinking-subagent-body';
    fillIsolatedCardBody(body, entry);
    details.appendChild(body);
    wrap.append(details);
    return wrap;
  }

  const block = document.createElement('div');
  block.className = 'msg-thinking-round';
  const last = !entry.isolated && streaming && index === trace.length - 1;
  fillThinkingRoundBlock(block, entry, index, trace, last, streamContent);
  /*
   * 展示态 trace 的按需升级：这一轮的思考正文被裁过（`fullThoughtTruncated`），
   * 用户展开时才去取完整态，取回来就地把 `entry` 补全后重填这一块 —— 不整块重绘气泡，
   * 用户刚打开的其它折叠状态因此不会被打回。
   */
  if (entry.fullThoughtTruncated && tracePrefs.showReasoning !== false) {
    details.dataset.traceTrimmed = '1';
    details.addEventListener('toggle', () => {
      if (!details.open || !entry.fullThoughtTruncated) return;
      const started = requestTraceUpgrade(details, (fullTrace) => {
        const fullEntry = fullTrace[index];
        // 两次读之间那一行可能已经长过（运行中的 checkpoint）：按轮次身份核对，
        // 对不上就**不补**（宁可留着截断版 + 下次重试，也不要贴错一轮的思考）。
        if (!isSameThinkingEntry(fullEntry, entry) || typeof fullEntry.fullThought !== 'string') return;
        entry.fullThought = fullEntry.fullThought;
        delete entry.fullThoughtTruncated;
        delete details.dataset.traceTrimmed;
        fillThinkingRoundBlock(block, entry, index, trace, last, streamContent);
      });
      if (!started) delete details.dataset.traceTrimmed;
    });
  }
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
  setDetailsOpen(details, shouldOpen);
  details.classList.toggle('is-collapsed-auto', complete && !details.open);

  const summary = details.querySelector('.msg-thinking-round-summary');
  if (summary) {
    const showTitle = shouldShowTraceTitle(entry);
    const combinedLabel = showTitle ? thinkingRoundSummaryLabel(entry, index, trace) : '';
    summary.title = showTitle ? combinedLabel || thinkingRoundTitle(entry) : '';
    syncThinkingRoundSummaryLabel(summary, entry, index, trace);
  }

  details.classList.toggle('msg-thinking-subagent', !!entry.isolated);
  details.classList.toggle('msg-thinking-parallel', !!entry.parallel);
  details.classList.toggle('is-running', entry.isolated ? isolatedCardRunning(entry) : false);
  if (entry.isolated && summary) appendSubagentDetailLink(summary, entry);

  if (isIsolatedCardEntry(entry)) {
    const cardBody = details.querySelector('.msg-thinking-round.msg-thinking-subagent-body');
    if (cardBody) fillIsolatedCardBody(cardBody, entry);
    return;
  }

  const last = !entry.isolated && streaming && index === trace.length - 1;
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
