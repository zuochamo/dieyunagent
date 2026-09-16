/* global $, gatewayCall, gwState, showAgentToast, escapeHtml, compactPlainText, fetchChatCompletion, resolveComposerModelForSend, withSessionRpcScope */
'use strict';

const playbookApi = window.diecloud || {};

const PLAYBOOK_AUTO_KEY = 'dieyun.playbook.auto';

/** @type {null | { draftPath: string, title: string, domain: string, preview: string, markdown: string, workspacePath: string }} */
let pendingPlaybookDraft = null;

function getPlaybookAutoMode() {
  try {
    const v = window.localStorage.getItem(PLAYBOOK_AUTO_KEY);
    if (v === 'off') return 'off';
  } catch {
    // ignore
  }
  return 'auto';
}

function setPlaybookAutoMode(mode) {
  try {
    window.localStorage.setItem(PLAYBOOK_AUTO_KEY, mode === 'off' ? 'off' : 'auto');
  } catch {
    // ignore
  }
}
async function resolveWorkspacePath() {
  if (!playbookApi.getWorkspace) return null;
  try {
    const ws = await playbookApi.getWorkspace();
    return ws && ws.workspacePath ? ws.workspacePath : null;
  } catch {
    return null;
  }
}

function hidePlaybookPreviewOverlay() {
  const overlay = $('playbook-preview-overlay');
  if (overlay) overlay.hidden = true;
}

function showPlaybookPreviewOverlay(draft) {
  const overlay = $('playbook-preview-overlay');
  const titleEl = $('playbook-preview-title');
  const metaEl = $('playbook-preview-meta');
  const bodyEl = $('playbook-preview-body');
  if (!overlay || !bodyEl) return;
  if (titleEl) titleEl.textContent = draft.auto ? `自动沉淀 · ${draft.title || 'Playbook 草稿'}` : draft.title || 'Playbook 草稿';
  if (metaEl) {
    metaEl.textContent = `${draft.domain || 'general'} · ${draft.draftPath || ''}`;
  }
  bodyEl.textContent = String(draft.preview || draft.markdown || '').slice(0, 12000);
  overlay.hidden = false;
}

async function acceptPendingPlaybookDraft() {
  if (!pendingPlaybookDraft) return { ok: false };
  const { draftPath, workspacePath, domain } = pendingPlaybookDraft;
  try {
    const result = await gatewayCall('playbook.confirm', {
      workspacePath,
      draftPath,
      domain
    });
    hidePlaybookPreviewOverlay();
    pendingPlaybookDraft = null;
    showAgentToast('Playbook 已入库', result.path || '.dieyun/playbooks/', { variant: 'info' });
    return { ok: true, result };
  } catch (err) {
    showAgentToast('Playbook 入库失败', err.message || String(err), { variant: 'warn' });
    return { ok: false, error: err.message || String(err) };
  }
}

async function rejectPendingPlaybookDraft() {
  if (!pendingPlaybookDraft) {
    hidePlaybookPreviewOverlay();
    return { ok: true };
  }
  const { draftPath, workspacePath } = pendingPlaybookDraft;
  try {
    await gatewayCall('playbook.discard', { workspacePath, draftPath });
  } catch {
    // ignore
  }
  pendingPlaybookDraft = null;
  hidePlaybookPreviewOverlay();
  showAgentToast('已放弃 Playbook 草稿', '', { variant: 'info' });
  return { ok: true };
}

async function queuePlaybookDraftPreview(draft, workspacePath, opts = {}) {
  pendingPlaybookDraft = {
    draftPath: draft.draftPath,
    title: draft.title,
    domain: draft.domain,
    preview: draft.preview,
    markdown: draft.markdown || draft.preview,
    workspacePath,
    auto: !!opts.auto
  };
  showPlaybookPreviewOverlay(pendingPlaybookDraft);
}

function traceHasPlaybookPropose(trace) {
  for (const entry of trace || []) {
    for (const tool of entry.tools || []) {
      if (tool.name === 'playbook_propose' && !tool.pending) return true;
    }
  }
  return false;
}

function summarizeTraceForPlaybook(trace) {
  const lines = [];
  for (const entry of trace || []) {
    for (const tool of entry.tools || []) {
      if (tool.pending) continue;
      const name = tool.name || 'tool';
      const brief = tool.argsBrief ? ` ${tool.argsBrief}` : '';
      const sum = compactPlainText(tool.summary || '', 180);
      lines.push(`- ${name}${brief}: ${sum}`);
    }
  }
  return lines.slice(0, 28).join('\n');
}

function collectPlaybookSignals(input) {
  const trace = input?.trace || [];
  const changes = (input?.changes || []).slice(0, 14).map((c) => {
    const p = c.relativePath || c.path || '';
    return `- ${p}${c.source ? ` (${c.source})` : ''}`;
  });
  const execLines = [];
  let writeCount = 0;
  for (const entry of trace) {
    for (const tool of entry.tools || []) {
      if (tool.pending) continue;
      if (tool.name === 'host_exec') {
        const s = String(tool.summary || '');
        if (/失败|error|exit\s*[1-9]/i.test(s)) continue;
        execLines.push(`- ${tool.argsBrief || 'host_exec'} → ${compactPlainText(s, 140)}`);
      }
      if (
        (tool.name === 'fs_write_file' || tool.name === 'fs_edit') &&
        !/失败|error/i.test(String(tool.summary || ''))
      ) {
        writeCount += 1;
      }
    }
  }
  const plan = input?.plan;
  const planSteps = Array.isArray(plan?.subtasks)
    ? plan.subtasks
    : Array.isArray(plan?.tasks)
      ? plan.tasks
      : [];
  let planSummary = '';
  if (planSteps.length) {
    planSummary = planSteps
      .slice(0, 12)
      .map((t, i) => `${i + 1}. ${compactPlainText(t.title || t.id || '', 120)}`)
      .join('\n');
  }
  return {
    userText: compactPlainText(input?.userText || '', 1400),
    assistantText: compactPlainText(input?.assistantText || '', 1800),
    toolTrace: summarizeTraceForPlaybook(trace),
    changes: changes.join('\n'),
    execLines: execLines.slice(0, 10).join('\n'),
    writeCount,
    planSummary,
    reviewNotes: compactPlainText(input?.review?.notes || '', 600),
    appliedPaths: (input?.appliedPaths || []).slice(0, 12).join('\n')
  };
}

function shouldRunPlaybookSedimentation(input) {
  if (getPlaybookAutoMode() === 'off') return false;
  if (pendingPlaybookDraft) return false;

  const source = String(input?.source || 'task-completed');
  if (source === 'plan-worktree-applied') return true;
  if (source === 'plan-completed' && input?.reviewAccepted) return true;
  if (input?.isPlanRun && !input?.reviewAccepted) return false;

  if (input?.playbookProposedThisTurn || traceHasPlaybookPropose(input?.trace)) return false;

  const userText = String(input?.userText || '').trim();
  if (!userText || userText.length < 3) return false;

  const trace = input?.trace || [];
  const changes = input?.changes || [];
  const signals = collectPlaybookSignals(input);
  const hasExec = !!signals.execLines;
  const hasWrite = signals.writeCount > 0;
  const toolCount = trace.reduce((n, e) => n + (e.tools || []).filter((t) => !t.pending).length, 0);

  // 结构信号（工具/变更/执行）；禁用寒暄关键词门闩
  return hasExec || hasWrite || changes.length > 0 || (toolCount >= 3 && userText.length >= 8);
}

async function executePlaybookPropose(args) {
  const title = String(args?.title || '').trim();
  const goal = String(args?.goal || '').trim();
  const steps = String(args?.steps || '').trim();
  if (!title || !goal || !steps) {
    return { error: 'title、goal、steps 必填' };
  }
  const workspacePath = await resolveWorkspacePath();
  if (!workspacePath) {
    return { error: '请先选择工作空间' };
  }
  if (!gwState.authed) {
    return { error: 'Gateway 未连接' };
  }
  try {
    const draft = await gatewayCall('playbook.draft_create', {
      workspacePath,
      title,
      domain: args?.domain,
      goal,
      steps,
      commands: args?.commands,
      acceptance: args?.acceptance,
      pitfalls: args?.pitfalls,
      relatedFiles: args?.relatedFiles,
      tags: args?.tags,
      trigger: 'manual'
    });
    await queuePlaybookDraftPreview(
      {
        ...draft,
        markdown: [
          `# ${title}`,
          '',
          '## 目标',
          goal,
          '',
          '## 确认步骤（SOP）',
          steps
        ].join('\n')
      },
      workspacePath
    );
    return {
      ok: true,
      pending: true,
      draftPath: draft.draftPath,
      id: draft.id,
      message: '已生成 Playbook 草稿，请在预览对话框中确认入库或放弃'
    };
  } catch (err) {
    return { error: err.message || String(err) };
  }
}

function syncPlaybookAutoTabs(mode) {
  document.querySelectorAll('.playbook-auto-tab').forEach((btn) => {
    const active = btn.dataset.mode === mode;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-checked', active ? 'true' : 'false');
  });
}

function initPlaybookSettingsUI() {
  const tabs = document.querySelectorAll('.playbook-auto-tab');
  if (!tabs.length || tabs[0]?.dataset.playbookBound === '1') return;
  tabs.forEach((btn) => {
    btn.dataset.playbookBound = '1';
  });
  syncPlaybookAutoTabs(getPlaybookAutoMode());
  tabs.forEach((btn) => {
    btn.addEventListener('click', () => {
      const mode = btn.dataset.mode;
      if (!mode || mode === getPlaybookAutoMode()) return;
      setPlaybookAutoMode(mode);
      syncPlaybookAutoTabs(mode);
      const hint = $('playbook-settings-hint');
      if (hint) {
        hint.textContent = 'Playbook 设置已保存';
        hint.classList.add('show');
        setTimeout(() => hint.classList.remove('show'), 2200);
      }
    });
  });
}

async function fetchPlaybookContext(userQuery, workspacePath) {
  if (!gwState.authed || !workspacePath) return '';
  const limit =
    typeof CTX_LIMITS !== 'undefined' && CTX_LIMITS.PLAYBOOK_RECALL_LIMIT
      ? CTX_LIMITS.PLAYBOOK_RECALL_LIMIT
      : 3;
  const summaryMax =
    typeof CTX_LIMITS !== 'undefined' && CTX_LIMITS.PLAYBOOK_SUMMARY_MAX
      ? CTX_LIMITS.PLAYBOOK_SUMMARY_MAX
      : 250;
  try {
    const params =
      typeof withSessionRpcScope === 'function'
        ? withSessionRpcScope({
            workspacePath,
            query: String(userQuery || '').trim(),
            limit,
            runWorkspaceRoot: workspacePath
          })
        : {
            workspacePath,
            query: String(userQuery || '').trim(),
            limit,
            runWorkspaceRoot: workspacePath
          };
    const recall = await gatewayCall('playbook.recall', params);
    const rows = recall && Array.isArray(recall.results) ? recall.results : [];
    if (!rows.length) return '';
    if (!recall.mode || recall.mode === 'none' || recall.mode === 'recent') return '';
    const minScore = recall.mode === 'semantic' ? 0.32 : 0.12;
    const filtered = rows.filter((r) => (Number(r.score) || 0) >= minScore);
    if (!filtered.length) return '';
    const modeLabel = recall.mode === 'semantic' ? '语义' : '关键词';
    const lines = filtered.map((row) => {
      const summary = compactPlainText(row.summary || '', summaryMax);
      return `- ${row.id} · ${row.title || row.id}（${row.domain || 'general'}）\n  步骤摘要：${summary}\n  路径：${row.path || ''}`;
    });
    return (
      `【相关 Playbook · ${modeLabel}】\n` +
      `工作空间：${workspacePath}\n` +
      `命中时可优先按 SOP 执行；细节用 fs_read_file 读取路径全文。与用户最新输入冲突时以用户为准。\n` +
      `${lines.join('\n')}`
    );
  } catch {
    return '';
  }
}

function initPlaybookUI() {
  $('playbook-preview-accept')?.addEventListener('click', () => {
    acceptPendingPlaybookDraft();
  });
  $('playbook-preview-reject')?.addEventListener('click', () => {
    rejectPendingPlaybookDraft();
  });
  $('playbook-preview-close')?.addEventListener('click', () => {
    hidePlaybookPreviewOverlay();
  });
}

function maybeShowProposeToolPreview(name, result) {
  if (!result || result.error || result.ok === false) return;
  if (name === 'playbook_propose' && result.pending && result.draftPath) {
    queuePlaybookDraftPreview(result, result.workspacePath);
    return;
  }
  if (name === 'agents_md_propose' && result.pending && result.workspacePath) {
    if (typeof loadPendingAgentsMdProposalFromDisk === 'function') {
      void loadPendingAgentsMdProposalFromDisk(result.workspacePath).then((p) => {
        if (p && typeof showAgentsMdPreviewOverlay === 'function') showAgentsMdPreviewOverlay(p);
      });
    }
    return;
  }
  if (name === 'agents_md_propose' && result.draft && typeof showAgentToast === 'function') {
    showAgentToast('项目地图草稿', result.message || '已写入草稿', { variant: 'info' });
    return;
  }
  if (
    name === 'agents_md_propose' &&
    result.applied &&
    !result.pending &&
    !result.draft &&
    typeof showAgentToast === 'function'
  ) {
    showAgentToast('项目地图已更新', result.message || '', { variant: 'info' });
  }
}

window.executePlaybookPropose = executePlaybookPropose;
window.fetchPlaybookContext = fetchPlaybookContext;
window.initPlaybookUI = initPlaybookUI;
window.initPlaybookSettingsUI = initPlaybookSettingsUI;
window.getPlaybookAutoMode = getPlaybookAutoMode;
window.shouldRunPlaybookSedimentation = shouldRunPlaybookSedimentation;
window.traceHasPlaybookPropose = traceHasPlaybookPropose;
window.queuePlaybookDraftPreview = queuePlaybookDraftPreview;
window.maybeShowProposeToolPreview = maybeShowProposeToolPreview;

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initPlaybookUI);
} else {
  initPlaybookUI();
}
