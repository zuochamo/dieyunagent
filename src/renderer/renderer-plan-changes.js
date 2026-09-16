/* global window, document, escapeHtml, extractPathHintsFromText, flatFileIconSvg, mergeArtifactRows, getSessionChangeRowsForAgent */
'use strict';

const BARE_FILE_RE =
  /\b([\w.-]+\.(?:tsx?|jsx?|vue|py|go|rs|java|cs|cpp|c|h|hpp|html|css|scss|less|json|yaml|yml|toml|md|sql|sh|bash|bat|ps1|xml|svg|kt|swift|rb|php|mjs|cjs))\b/gi;

/**
 * @param {object | null | undefined} plan
 * @returns {Array<{ path: string, subtaskId: string, title: string, worker: string, agentType: string }>}
 */
function extractPlannedChangeTargets(plan) {
  if (!plan || typeof plan !== 'object') return [];
  const subtasks = Array.isArray(plan.subtasks) ? plan.subtasks : [];
  const extractHints =
    typeof extractPathHintsFromText === 'function' ? extractPathHintsFromText : () => [];
  const targets = new Map();

  const addPath = (rawPath, st) => {
    const path = String(rawPath || '')
      .trim()
      .replace(/\\/g, '/');
    if (!path || path.length > 240) return;
    if (!targets.has(path)) {
      targets.set(path, {
        path,
        subtaskId: String(st.id || ''),
        title: String(st.title || st.id || '子任务'),
        worker: String(st.worker || 'A'),
        agentType: String(st.agentType || 'build')
      });
    }
  };

  for (const st of subtasks) {
    if (!st || typeof st !== 'object') continue;
    const text = [st.title, st.instruction, st.expectedOutput].filter(Boolean).join('\n');
    for (const p of extractHints(text)) addPath(p, st);
    let m;
    BARE_FILE_RE.lastIndex = 0;
    while ((m = BARE_FILE_RE.exec(text))) {
      addPath(m[1], st);
    }
  }
  return [...targets.values()];
}

function buildPlanPreviewState(plan) {
  if (!plan || typeof plan !== 'object') return null;
  const targets = extractPlannedChangeTargets(plan);
  const subtasks = (Array.isArray(plan.subtasks) ? plan.subtasks : []).map((st) => ({
    id: String(st.id || ''),
    title: String(st.title || ''),
    worker: String(st.worker || 'A'),
    agentType: String(st.agentType || 'build'),
    instruction: String(st.instruction || '').slice(0, 400)
  }));
  return {
    planSummary: String(plan.planSummary || plan.summary || '').trim(),
    subtasks,
    targets,
    updatedAt: Date.now()
  };
}

function workspaceLooksLikeSsh(ws) {
  if (!ws) return false;
  if (ws.kind === 'ssh') return true;
  const path = ws.workspacePath ? String(ws.workspacePath) : '';
  return /^ssh:/i.test(path);
}

function probePlanWorktreeSupportSync() {
  const cached =
    typeof window.activeViewSessionWorkspacePath === 'string'
      ? window.activeViewSessionWorkspacePath
      : '';
  if (cached && /^ssh:/i.test(cached)) return { supported: false, reason: 'ssh' };
  if (window.activeViewSessionWorkspaceKind === 'ssh') {
    return { supported: false, reason: 'ssh' };
  }
  const wsEl = document.getElementById('composer-workspace');
  if (wsEl && wsEl.classList.contains('composer-workspace-ssh')) {
    return { supported: false, reason: 'ssh' };
  }
  const dcApi = window.diecloud || {};
  if (dcApi.getWorkspace && typeof dcApi.getWorkspace === 'function') {
    try {
      const ws = dcApi.getWorkspace();
      if (ws && typeof ws.then === 'function') {
        // async — handled by refreshPlanWorktreeMode
      } else if (ws) {
        const path = ws.workspacePath ? String(ws.workspacePath) : '';
        if (ws.kind === 'ssh' || /^ssh:/i.test(path)) return { supported: false, reason: 'ssh' };
      }
    } catch {
      // ignore
    }
  }
  return null;
}

function planTraceDiffEnabled() {
  const wt = getPendingPlanWorktree();
  if (typeof window.currentSessionHasActiveRemoteRun === 'function' && window.currentSessionHasActiveRemoteRun()) {
    return !!(wt && (wt.live || wt.runId));
  }
  const kind =
    typeof window.activeViewSessionWorkspaceKind === 'string'
      ? window.activeViewSessionWorkspaceKind
      : '';
  if (kind === 'ssh') {
    return !!(wt && (wt.live || wt.runId));
  }
  if (!wt || (!wt.live && !wt.runId)) return false;
  if (wt.traceFallback) return true;
  const syncHint = probePlanWorktreeSupportSync();
  return !!(syncHint && syncHint.supported === false);
}

function shouldSuppressPlanTraceDiff() {
  if (planTraceDiffEnabled()) return false;
  const wt = getPendingPlanWorktree();
  if (!wt || (!wt.live && !wt.runId)) return false;
  if (typeof window.currentSessionHasActiveRemoteRun === 'function' && window.currentSessionHasActiveRemoteRun()) {
    return false;
  }
  const kind =
    typeof window.activeViewSessionWorkspaceKind === 'string'
      ? window.activeViewSessionWorkspaceKind
      : '';
  if (kind === 'ssh') return false;
  // 仅当明确走本地 worktree 时才屏蔽 trace diff
  return wt.live === true && wt.traceFallback === false && !wt.traceFallbackReason;
}

function logPlanTraceDiffState(tag, extra) {
  try {
    const wt = getPendingPlanWorktree();
    const payload = {
      suppress: shouldSuppressPlanTraceDiff(),
      enabled: planTraceDiffEnabled(),
      path: window.activeViewSessionWorkspacePath || null,
      kind: window.activeViewSessionWorkspaceKind || null,
      remote:
        typeof window.currentSessionHasActiveRemoteRun === 'function'
          ? window.currentSessionHasActiveRemoteRun()
          : null,
      pending: wt
        ? {
            live: !!wt.live,
            runId: wt.runId || null,
            traceFallback: !!wt.traceFallback,
            reason: wt.traceFallbackReason || ''
          }
        : null,
      probe: probePlanWorktreeSupportSync(),
      ...(extra && typeof extra === 'object' ? extra : {})
    };
    console.warn(`[plan-trace-diff:${tag}] ${JSON.stringify(payload)}`);
  } catch (e) {
    console.warn(`[plan-trace-diff:${tag}] log failed ${String(e && e.message ? e.message : e)}`);
  }
}

function shouldPlanUseTraceDiffFallback() {
  return planTraceDiffEnabled();
}

function getPendingPlanWorktree() {
  return typeof window.getPendingWorktreeApply === 'function' ? window.getPendingWorktreeApply() : null;
}

/**
 * @returns {Promise<{ supported: boolean, reason?: string }>}
 */
async function probePlanWorktreeSupport() {
  const syncHint = probePlanWorktreeSupportSync();
  if (syncHint) return syncHint;
  const dcApi = window.diecloud || {};
  let ws = null;
  if (dcApi.getWorkspace) {
    try {
      ws = await dcApi.getWorkspace();
    } catch {
      ws = null;
    }
  }
  if (!ws || !ws.workspacePath) {
    return { supported: false, reason: 'no_workspace' };
  }
  if (workspaceLooksLikeSsh(ws)) {
    return { supported: false, reason: 'ssh' };
  }
  if (dcApi.worktreeListManaged) {
    try {
      const listed = await dcApi.worktreeListManaged();
      if (!listed?.ok) {
        const err = String(listed?.error || '');
        if (err.includes('不是 git') || err.includes('git 仓库')) {
          return { supported: false, reason: 'not_git' };
        }
      }
    } catch {
      // ignore probe errors; assume supported for local paths
    }
  }
  return { supported: true };
}

function traceFallbackLabel(reason) {
  if (reason === 'ssh') return 'SSH 远程工作空间';
  if (reason === 'not_git') return '非 git 工作空间';
  if (reason === 'no_workspace') return '未设置工作空间';
  return 'worktree 不可用';
}

async function refreshPlanWorktreeMode() {
  const pending =
    typeof window.getPendingWorktreeApply === 'function' ? window.getPendingWorktreeApply() : null;
  if (!pending?.live) return;
  const mode = await probePlanWorktreeSupport();
  if (typeof window.applyPlanWorktreeMode === 'function') {
    window.applyPlanWorktreeMode(mode);
  }
}

function getTraceSessionChangeRowCount() {
  if (typeof mergeArtifactRows === 'function') {
    return mergeArtifactRows().filter(
      (a) => a && a.path && (a.diff || a.source === 'trace')
    ).length;
  }
  if (typeof getSessionChangeRowsForAgent === 'function') {
    return getSessionChangeRowsForAgent().length;
  }
  return 0;
}

function syncPlanPreviewFromPlan(plan) {
  const preview = buildPlanPreviewState(plan);
  if (!preview) return;
  const pending = getPendingPlanWorktree();
  if (planTraceDiffEnabled() && getTraceSessionChangeRowCount() > 0) {
    if (pending.planPreview && typeof window.applyPlanPreviewState === 'function') {
      window.applyPlanPreviewState(null);
    }
    return;
  }
  if (typeof window.applyPlanPreviewState === 'function') {
    window.applyPlanPreviewState(preview);
  }
}

function clearPlanPreviewWhenTraceArtifactsExist() {
  const pending = getPendingPlanWorktree();
  if (!pending?.live || !planTraceDiffEnabled() || !pending.planPreview) return;
  if (getTraceSessionChangeRowCount() <= 0) return;
  if (typeof window.applyPlanPreviewState === 'function') {
    window.applyPlanPreviewState(null);
  }
}

function clearPlanPreviewState() {
  if (typeof window.applyPlanPreviewState === 'function') {
    window.applyPlanPreviewState(null);
  }
}

function planPreviewSubtaskForPath(preview, filePath) {
  if (!preview || !filePath) return null;
  const targets = Array.isArray(preview.targets) ? preview.targets : [];
  const hit =
    targets.find((t) => t.path === filePath) ||
    targets.find((t) => filePath.endsWith('/' + t.path) || filePath.endsWith('\\' + t.path));
  if (!hit) return null;
  const subtasks = Array.isArray(preview.subtasks) ? preview.subtasks : [];
  return subtasks.find((st) => st.id === hit.subtaskId) || hit;
}

function renderPlanPreviewDetail(view, preview, target) {
  if (!view || !preview) return;
  const st =
    (target &&
      (Array.isArray(preview.subtasks)
        ? preview.subtasks.find((row) => row.id === target.subtaskId)
        : null)) ||
    null;
  const summary = preview.planSummary
    ? `<div class="changes-plan-preview-summary">${escapeHtml(preview.planSummary)}</div>`
    : '';
  const title = target ? target.title : '规划预览';
  const worker = target ? `执行器 ${target.worker}` : '';
  const instruction = st?.instruction
    ? `<div class="changes-plan-preview-instruction">${escapeHtml(st.instruction)}</div>`
    : '<div class="artifacts-empty">从子任务说明中推断的可能变更文件；执行器写入后会切换为实际 diff。</div>';
  view.innerHTML =
    `<div class="changes-view-meta changes-plan-preview-meta">Plan 规划预览 · ${escapeHtml(title)}${worker ? ` · ${escapeHtml(worker)}` : ''}</div>` +
    summary +
    instruction;
}

function renderPlanPreviewPane(pending, list, view, summary) {
  const preview = pending?.planPreview;
  const targets = preview && Array.isArray(preview.targets) ? preview.targets : [];
  const fallback = !!pending.traceFallback;
  const meta = document.getElementById('changes-review-meta');
  const toolbar = document.getElementById('changes-review-toolbar');

  if (toolbar) toolbar.hidden = false;
  if (typeof window.showChangesDiffToolbar === 'function') window.showChangesDiffToolbar();
  if (typeof window.setWorktreeReviewControlsEnabled === 'function') {
    window.setWorktreeReviewControlsEnabled(true, {
      applyDisabled: true,
      dismissDisabled: !pending.live,
      selectDisabled: true
    });
  }

  const phaseLabel = pending.live ? 'Plan 规划中' : 'Plan 预览';
  const fallbackNote = fallback
    ? ` · ${traceFallbackLabel(pending.traceFallbackReason)}，执行期使用 trace diff`
    : '';
  if (meta) {
    meta.textContent = `${phaseLabel} · 预计 ${targets.length} 个文件${fallbackNote}`;
  }
  if (summary) {
    summary.textContent = targets.length
      ? `${phaseLabel} · ${targets.length} 个预计变更文件`
      : `${phaseLabel} · 等待任务拆解`;
  }

  list.innerHTML = '';
  if (!targets.length) {
    list.innerHTML =
      '<div class="artifacts-empty changes-review-empty">任务拆解完成后，预计变更的文件会显示在这里。</div>';
    if (view) {
      view.innerHTML =
        '<div class="artifacts-empty">Plan 正在拆解子任务…完成后可预览预计修改的文件。</div>';
    }
    return;
  }

  for (const target of targets) {
    const row = document.createElement('div');
    row.className = 'artifacts-file-item changes-plan-preview-item';
    row.dataset.planPath = target.path;
    row.title = target.path;
    const name = target.path.replace(/\\/g, '/').split('/').pop() || target.path;
    row.innerHTML =
      '<span class="artifacts-file-icon">' +
      flatFileIconSvg(16) +
      '</span><span class="artifacts-file-name">' +
      escapeHtml(name) +
      '</span><span class="changes-review-meta-tag">预计 · ' +
      escapeHtml(target.subtaskId || target.worker) +
      '</span>';
    row.addEventListener('click', () => {
      list.querySelectorAll('.artifacts-file-item').forEach((el) => el.classList.remove('active'));
      row.classList.add('active');
      if (view) renderPlanPreviewDetail(view, preview, target);
    });
    list.appendChild(row);
  }

  const first = list.querySelector('.changes-plan-preview-item');
  if (first) {
    first.classList.add('active');
    if (view) renderPlanPreviewDetail(view, preview, targets[0]);
  }
}

window.extractPlannedChangeTargets = extractPlannedChangeTargets;
window.buildPlanPreviewState = buildPlanPreviewState;
window.probePlanWorktreeSupport = probePlanWorktreeSupport;
window.probePlanWorktreeSupportSync = probePlanWorktreeSupportSync;
window.refreshPlanWorktreeMode = refreshPlanWorktreeMode;
window.shouldSuppressPlanTraceDiff = shouldSuppressPlanTraceDiff;
window.shouldPlanUseTraceDiffFallback = shouldPlanUseTraceDiffFallback;
window.logPlanTraceDiffState = logPlanTraceDiffState;
window.syncPlanPreviewFromPlan = syncPlanPreviewFromPlan;
window.clearPlanPreviewWhenTraceArtifactsExist = clearPlanPreviewWhenTraceArtifactsExist;
window.clearPlanPreviewState = clearPlanPreviewState;
window.renderPlanPreviewPane = renderPlanPreviewPane;
window.traceFallbackLabel = traceFallbackLabel;
