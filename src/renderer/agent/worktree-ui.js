/* global window, document, $, currentSessionId, sessionActiveRuns, showAgentToast, renderChangesPane, getSessionChangeRowsForAgent, capturePlanApplyForUndo, flushKnowledgeMaintenanceAfterPlan, hasKnowledgeMaintenanceContext, dispatchAgentRunEvent, createAgentRunEvent, AGENT_RUN_EVENT_TYPES, maybeEnforceWorktreeCleanupPolicy, openSidePanel, setSidePanelTab, DieyunNamespaces */
'use strict';

const worktreeLoopApi = window.diecloud || {};

/** @type {Map<string, object>} */
const pendingWorktreeBySession = new Map();

function worktreeSid(sessionId) {
  return String(sessionId || currentSessionId || '').trim();
}

function pendingWorktreeRow(sessionId) {
  const sid = worktreeSid(sessionId);
  return sid ? pendingWorktreeBySession.get(sid) || null : null;
}

function setPendingWorktreeRow(row, sessionId) {
  const sid = worktreeSid(sessionId || (row && row.sessionId));
  if (!sid) return;
  if (!row) pendingWorktreeBySession.delete(sid);
  else pendingWorktreeBySession.set(sid, { ...row, sessionId: sid });
}

let planWorktreeRefreshTimer = null;

function scheduleWorktreePolicyCleanup() {
  if (typeof maybeEnforceWorktreeCleanupPolicy === 'function') {
    void maybeEnforceWorktreeCleanupPolicy();
  }
}

function applyPlanWorktreeMode(mode, sessionId) {
  const pending = pendingWorktreeRow(sessionId);
  if (!pending?.live) return;
  const supported = !!(mode && mode.supported);
  const nextFallback = !supported;
  const changed = pending.traceFallback !== nextFallback;
  pending.traceFallback = nextFallback;
  pending.traceFallbackReason = supported ? '' : String(mode?.reason || '');
  if (typeof window.invalidateWorktreeReviewCache === 'function') {
    window.invalidateWorktreeReviewCache();
  }
  if (changed || nextFallback) {
    if (typeof window.patchChangesPane === 'function') window.patchChangesPane();
    else if (typeof renderChangesPane === 'function') renderChangesPane();
  }
  if (typeof window.logPlanTraceDiffState === 'function') {
    window.logPlanTraceDiffState('mode');
  }
}

function applyPlanPreviewState(preview, sessionId) {
  const pending = pendingWorktreeRow(sessionId);
  if (!pending) return;
  pending.planPreview = preview || null;
  if (typeof window.patchChangesPane === 'function') window.patchChangesPane();
  else if (typeof renderChangesPane === 'function') renderChangesPane();
}

function sessionWorkspacePathForUi(sessionId) {
  const sid = String(sessionId || currentSessionId || '');
  const live = sessionActiveRuns.get(sid);
  if (live && live.workspacePath) return String(live.workspacePath);
  if (typeof window.resolveSessionWorkspacePathSync === 'function') {
    const cached = window.resolveSessionWorkspacePathSync(sid);
    if (cached) return String(cached);
  }
  if (sid === String(currentSessionId) && typeof window.activeViewSessionWorkspacePath === 'string') {
    return window.activeViewSessionWorkspacePath;
  }
  return '';
}

function beginPlanWorktreeTracking(runId, sessionId) {
  const sid = worktreeSid(sessionId);
  const prev = pendingWorktreeRow(sid);
  if (typeof window.pruneInvalidSessionArtifacts === 'function') {
    window.pruneInvalidSessionArtifacts();
  }
  if (typeof window.resetPlanTraceArtifactLog === 'function') {
    window.resetPlanTraceArtifactLog();
  }
  const viewSid = String(currentSessionId || '');
  const syncMode =
    sid &&
    sid === viewSid &&
    typeof window.probePlanWorktreeSupportSync === 'function'
      ? window.probePlanWorktreeSupportSync()
      : null;
  const prevFallback = !!prev?.traceFallback;
  const prevReason = String(prev?.traceFallbackReason || '');
  let traceFallback = prevFallback;
  let traceFallbackReason = prevReason;
  if (syncMode && syncMode.supported === false) {
    traceFallback = true;
    traceFallbackReason = syncMode.reason || prevReason;
  } else if (typeof window.sessionRunUsesRemote === 'function' && window.sessionRunUsesRemote(sid)) {
    traceFallback = true;
    traceFallbackReason = prevReason || 'ssh';
  } else {
    const wsPath = sessionWorkspacePathForUi(sid);
    if (/^ssh:/i.test(wsPath)) {
      traceFallback = true;
      traceFallbackReason = 'ssh';
    }
  }
  const modeKnown = traceFallback || !!traceFallbackReason || !!syncMode;
  setPendingWorktreeRow({
    runId: runId || prev?.runId || null,
    sessionId: sid,
    undoTurnId: prev?.undoTurnId || null,
    knowledgeBase: prev?.knowledgeBase || null,
    live: true,
    traceFallback,
    traceFallbackReason,
    planPreview: prev?.planPreview || null
  }, sid);
  if (typeof window.invalidateWorktreeReviewCache === 'function') {
    window.invalidateWorktreeReviewCache();
  }
  if (!modeKnown && typeof window.refreshPlanWorktreeMode === 'function') {
    void window.refreshPlanWorktreeMode();
  } else if (typeof window.patchChangesPane === 'function') {
    window.patchChangesPane();
  }
  if (traceFallback && typeof window.patchChangesPane === 'function') {
    window.patchChangesPane();
  }
  if (typeof window.logPlanTraceDiffState === 'function') {
    window.logPlanTraceDiffState('begin');
  }
  if (traceFallback && typeof showAgentToast === 'function') {
    const label =
      typeof window.traceFallbackLabel === 'function'
        ? window.traceFallbackLabel(traceFallbackReason)
        : '远程工作空间';
    showAgentToast('Plan 变更预览', `${label}：侧栏将显示 trace diff`, { variant: 'info' });
  }
  openWorktreeReviewPane();
}

function schedulePlanWorktreeChangesRefresh(sessionId) {
  const pending = pendingWorktreeRow(sessionId);
  if (!pending?.live || pending.traceFallback) return;
  if (planWorktreeRefreshTimer) return;
  planWorktreeRefreshTimer = setTimeout(() => {
    planWorktreeRefreshTimer = null;
    if (typeof window.invalidateWorktreeReviewCache === 'function') {
      window.invalidateWorktreeReviewCache();
    }
    if (typeof window.patchChangesPane === 'function') window.patchChangesPane();
    else if (typeof renderChangesPane === 'function') renderChangesPane();
  }, 1200);
}

function finalizePlanWorktreeTracking(runId, sessionId, undoTurnId, knowledgeBase) {
  if (!runId) return;
  const sid = worktreeSid(sessionId);
  const prev = pendingWorktreeRow(sid);
  setPendingWorktreeRow({
    runId,
    sessionId: sid,
    undoTurnId: undoTurnId || prev?.undoTurnId || null,
    knowledgeBase: knowledgeBase || prev?.knowledgeBase || null,
    traceFallback: !!prev?.traceFallback,
    traceFallbackReason: prev?.traceFallbackReason || '',
    planPreview: prev?.planPreview || null
  }, sid);
  if (typeof window.invalidateWorktreeReviewCache === 'function') {
    window.invalidateWorktreeReviewCache();
  }
}

function openArbitrationDialog(pending) {
  return new Promise((resolve) => {
    const overlay = $('agent-arbitration-overlay');
    const desc = $('agent-arbitration-desc');
    if (!overlay || !desc) {
      resolve({ action: 'retry' });
      return;
    }
    desc.textContent = `任务 ${pending?.taskId || ''}：${pending?.reason || '需要人工决策'}`;
    overlay.hidden = false;
    if (typeof dispatchAgentRunEvent === 'function' && typeof createAgentRunEvent === 'function') {
      dispatchAgentRunEvent(
        currentSessionId,
        createAgentRunEvent(AGENT_RUN_EVENT_TYPES.ARBITRATION, {
          sessionId: currentSessionId,
          phase: 'arbitration',
          summary: desc.textContent,
          meta: { taskId: pending?.taskId || null, reason: pending?.reason || '' }
        })
      );
    }

    const onPick = (action) => {
      overlay.hidden = true;
      for (const btn of overlay.querySelectorAll('[data-arb]')) {
        btn.removeEventListener('click', btn._arbHandler);
      }
      resolve({ action, note: 'user arbitration' });
    };

    for (const btn of overlay.querySelectorAll('[data-arb]')) {
      btn._arbHandler = () => onPick(btn.getAttribute('data-arb'));
      btn.addEventListener('click', btn._arbHandler);
    }
  });
}

if (typeof window !== 'undefined' && window.diecloud && window.diecloud.onAgentPlannerArbitrate) {
  window.diecloud.onAgentPlannerArbitrate(async (payload) => {
    const requestId = payload && payload.requestId;
    const runId = payload && payload.runId;
    try {
      const decision = await openArbitrationDialog(payload && payload.pending);
      if (window.diecloud.agentArbitrate && runId) {
        await window.diecloud.agentArbitrate(runId, decision);
      }
      if (window.diecloud.agentPlannerArbitrateResult) {
        await window.diecloud.agentPlannerArbitrateResult({ requestId, decision });
      }
    } catch (e) {
      if (window.diecloud.agentPlannerArbitrateResult) {
        await window.diecloud.agentPlannerArbitrateResult({
          requestId,
          error: e && e.message ? e.message : String(e)
        });
      }
    }
  });
}

function kindLabelWorktree(kind) {
  if (kind === 'deleted') return '删除';
  if (kind === 'added' || kind === 'untracked') return '新增';
  return '修改';
}

async function applyWorktreeChangesCore(runId, undoTurnId, paths, forceConflict, changeIds, applyOpts) {
  if (!paths?.length || !worktreeLoopApi.worktreeApplyRun) return { appliedOk: false };
  try {
    const apply = await worktreeLoopApi.worktreeApplyRun(
      runId,
      paths,
      !!forceConflict,
      changeIds || [],
      applyOpts || {}
    );
    if (apply.ok) {
      if (undoTurnId && paths.length) {
        let workspaceRoot = null;
        if (worktreeLoopApi.getWorkspace) {
          try {
            const ws = await worktreeLoopApi.getWorkspace();
            workspaceRoot = ws && ws.workspacePath ? ws.workspacePath : null;
          } catch {
            // ignore
          }
        }
        await capturePlanApplyForUndo(undoTurnId, paths, workspaceRoot);
      }
      showAgentToast(
        '已应用到工作区',
        `已写回 ${apply.applied} 个文件${apply.errors?.length ? `，${apply.errors.length} 项失败` : ''}`,
        { variant: 'success' }
      );
      return { appliedOk: true, apply };
    }
    showAgentToast('应用失败', apply.errors?.[0]?.error || apply.error || '未知错误', {
      variant: 'error'
    });
    return { appliedOk: false, apply };
  } catch (e) {
    showAgentToast('应用失败', e.message || String(e), { variant: 'error' });
    return { appliedOk: false, error: e };
  }
}

function finalizeWorktreeKnowledge(appliedOk, appliedPaths, sessionId) {
  const sid = worktreeSid(sessionId);
  const knowledgeDefer =
    typeof hasKnowledgeMaintenanceContext === 'function' &&
    hasKnowledgeMaintenanceContext(sid);
  if (!knowledgeDefer) return;
  flushKnowledgeMaintenanceAfterPlan(
    appliedOk ? 'applied' : 'skipped',
    appliedOk ? { appliedPaths: appliedPaths || [], sessionId: sid } : { sessionId: sid }
  );
}

async function applyWorktreeReview(paths, opts = {}) {
  const pending = pendingWorktreeRow();
  if (!pending?.runId) return { ok: false, error: '无待审变更' };
  if (pending.live) {
    showAgentToast('Plan 执行中', '请等待 Plan 完成后再应用变更', { variant: 'info' });
    return { ok: false, error: 'plan_running' };
  }
  if (!paths?.length) {
    showAgentToast('未选择文件', '请至少勾选一个文件，或点击「放弃全部」', { variant: 'warn' });
    return { ok: false };
  }
  const result = await applyWorktreeChangesCore(
    pending.runId,
    pending.undoTurnId,
    paths,
    !!opts.forceConflict,
    opts.changeIds || [],
    {
      forceChangeIds: opts.forceChangeIds || [],
      allowOverwriteMainDirty: !!opts.allowOverwriteMainDirty
    }
  );
  // 应用后清理走默认「归档到分支再删」：用户没勾选的文件产出仍留在分支上，
  // 不会像原来的 rmSync --force 那样静默消失。
  if (worktreeLoopApi.worktreeCleanupRun) {
    await worktreeLoopApi.worktreeCleanupRun(pending.runId).catch(() => {});
  }
  scheduleWorktreePolicyCleanup();
  finalizeWorktreeKnowledge(result.appliedOk, result.appliedOk ? paths : [], pending.sessionId);
  if (result.appliedOk) setPendingWorktreeRow(null, pending.sessionId);
  if (typeof window.invalidateWorktreeReviewCache === 'function') {
    window.invalidateWorktreeReviewCache();
  }
  if (typeof renderChangesPane === 'function') renderChangesPane();
  return result;
}

async function dismissWorktreeReview() {
  const pending = pendingWorktreeRow();
  if (!pending?.runId && !pending?.live) return;
  if (pending.live) {
    setPendingWorktreeRow(null, pending.sessionId);
    if (typeof window.clearPlanPreviewState === 'function') window.clearPlanPreviewState();
    if (typeof window.invalidateWorktreeReviewCache === 'function') {
      window.invalidateWorktreeReviewCache();
    }
    if (typeof renderChangesPane === 'function') renderChangesPane();
    return;
  }
  if (!pending.runId) return;
  // 用户显式放弃：这是唯一允许「丢弃未提交产出 + 回收分支」的路径。
  // 其它清理入口都走默认归档，不会走到这里。
  if (worktreeLoopApi.worktreeCleanupRun) {
    await worktreeLoopApi.worktreeCleanupRun(pending.runId, {
      archive: false,
      allowDiscardUncommitted: true,
      deleteBranches: true
    }).catch(() => {});
  }
  scheduleWorktreePolicyCleanup();
  setPendingWorktreeRow(null, pending.sessionId);
  finalizeWorktreeKnowledge(false, [], pending.sessionId);
  if (typeof window.invalidateWorktreeReviewCache === 'function') {
    window.invalidateWorktreeReviewCache();
  }
  showAgentToast('已放弃变更', 'Worktree 变更已丢弃', { variant: 'warn' });
  if (typeof renderChangesPane === 'function') renderChangesPane();
}

async function openWorktreeReviewAfterPlan(runId, sessionId, undoTurnId, knowledgeBase) {
  finalizePlanWorktreeTracking(runId, sessionId, undoTurnId, knowledgeBase);
  let preview = null;
  if (worktreeLoopApi.worktreePreviewRun) {
    try {
      preview = await worktreeLoopApi.worktreePreviewRun(runId);
    } catch {
      preview = null;
    }
  }
  if (!preview?.ok || !preview.changes?.length) {
    if (worktreeLoopApi.worktreeCleanupRun) {
      await worktreeLoopApi.worktreeCleanupRun(runId).catch(() => {});
      scheduleWorktreePolicyCleanup();
    }
    setPendingWorktreeRow(null, sessionId);
    if (typeof window.clearPlanPreviewState === 'function') window.clearPlanPreviewState();
    if (typeof window.invalidateWorktreeReviewCache === 'function') {
      window.invalidateWorktreeReviewCache();
    }
    const hasSessionChanges =
      typeof getSessionChangeRowsForAgent === 'function' &&
      getSessionChangeRowsForAgent().length > 0;
    if (typeof renderChangesPane === 'function') renderChangesPane();
    if (hasSessionChanges) {
      if (typeof openSidePanel === 'function') openSidePanel({ tab: 'changes' });
      if (typeof setSidePanelTab === 'function') setSidePanelTab('changes');
      showAgentToast(
        'Plan 已完成',
        preview?.error?.includes('不是 git 仓库')
          ? '工作空间非 git 仓库，改动已直接写入；可在「变更」查看会话 diff'
          : '无 worktree 待合并项；可在「变更」查看本会话 diff',
        { variant: 'info' }
      );
    }
    return false;
  }
  setPendingWorktreeRow({
    runId,
    sessionId,
    undoTurnId: undoTurnId || null,
    knowledgeBase: knowledgeBase ? { ...knowledgeBase } : null,
    planPreview: null
  }, sessionId);
  openWorktreeReviewPane();
  showAgentToast('待合并变更', '请在侧栏「变更」中逐文件审核并应用', { variant: 'info' });
  return true;
}

function openWorktreeReviewPane() {
  if (typeof openSidePanel === 'function') openSidePanel({ tab: 'changes' });
  if (typeof setSidePanelTab === 'function') setSidePanelTab('changes');
  if (typeof renderChangesPane === 'function') renderChangesPane();
}

async function handleWorktreeApplyAfterRun(_runId, _undoTurnId) {
  openWorktreeReviewPane();
}

function openWorktreeApplyDialog(preview) {
  return new Promise((resolve) => {
    const overlay = $('worktree-apply-overlay');
    const listEl = $('worktree-apply-list');
    const countEl = $('worktree-apply-count');
    const warnEl = $('worktree-apply-warn');
    const selectAll = $('worktree-apply-select-all');
    const btnConfirm = $('worktree-apply-confirm');
    const btnSkip = $('worktree-apply-skip');
    if (!overlay || !listEl || !btnConfirm || !btnSkip) {
      resolve({ applied: false });
      return;
    }

    const changes = preview.changes || [];
    const hasConflict = changes.some((c) => c.conflict);
    const hasMainDirty = changes.some((c) => c.mainDirty);

    listEl.innerHTML = '';
    const inputs = [];
    for (const ch of changes) {
      const li = document.createElement('li');
      if (ch.conflict) li.classList.add('conflict');
      if (ch.mainDirty) li.classList.add('main-dirty');
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = !ch.conflict;
      cb.dataset.path = ch.repoPath;
      inputs.push(cb);
      const pathSpan = document.createElement('span');
      pathSpan.className = 'worktree-apply-path';
      pathSpan.textContent = ch.repoPath;
      const meta = document.createElement('span');
      meta.className = 'worktree-apply-meta';
      meta.textContent = `${kindLabelWorktree(ch.kind)} · ${ch.roleId}${ch.conflict ? ' · 冲突' : ''}${ch.mainDirty ? ' · 主区已改' : ''}`;
      li.appendChild(cb);
      li.appendChild(pathSpan);
      li.appendChild(meta);
      listEl.appendChild(li);
    }

    const syncCount = () => {
      const n = inputs.filter((i) => i.checked).length;
      if (countEl) countEl.textContent = `已选 ${n} / ${changes.length}`;
      if (selectAll) selectAll.checked = n === inputs.length;
    };
    syncCount();

    if (warnEl) {
      const warns = [];
      if (hasConflict) warns.push('部分文件被多个执行器同时修改，默认不勾选；强制应用将覆盖为最后写入的 worktree 副本。');
      if (hasMainDirty) warns.push('主工作区中部分文件已有未提交修改，应用将直接覆盖磁盘内容。');
      if (warns.length) {
        warnEl.textContent = warns.join(' ');
        warnEl.hidden = false;
      } else {
        warnEl.hidden = true;
      }
    }

    const close = (result) => {
      overlay.hidden = true;
      selectAll?.removeEventListener('change', onSelectAll);
      btnConfirm.removeEventListener('click', onConfirm);
      btnSkip.removeEventListener('click', onSkip);
      resolve(result);
    };

    const onSelectAll = () => {
      const v = !!selectAll.checked;
      for (const inp of inputs) inp.checked = v;
      syncCount();
    };

    const onConfirm = () => {
      const paths = inputs.filter((i) => i.checked).map((i) => i.dataset.path);
      if (!paths.length) {
        showAgentToast('未选择文件', '请至少勾选一个文件，或点击「放弃变更」', { variant: 'warn' });
        return;
      }
      // 冲突强制按变更粒度：勾中某个冲突文件只强制它自己，
      // 不再用一个全局 boolean 顺带解除其余文件的覆盖保护。
      const selectedChanges = changes.filter((c) => paths.includes(c.repoPath));
      const keyOf = (ch) => ch.changeId || `${ch.roleId}::${ch.repoPath}`;
      const forceChangeIds = selectedChanges.filter((c) => c.conflict).map(keyOf);
      const dirtyFiles = selectedChanges.filter((c) => c.mainDirty);
      let allowOverwriteMainDirty = false;
      if (dirtyFiles.length) {
        allowOverwriteMainDirty = window.confirm(
          `主工作区中以下 ${dirtyFiles.length} 个文件已有未提交修改，应用会覆盖它们：\n\n` +
            dirtyFiles.map((c) => `· ${c.repoPath}`).join('\n') +
            '\n\n覆盖前会自动备份到 .dieyun/backup/，可回滚。确定继续？'
        );
        if (!allowOverwriteMainDirty) return;
      }
      close({ applied: true, paths, forceChangeIds, allowOverwriteMainDirty });
    };

    const onSkip = () => close({ applied: false });

    for (const inp of inputs) inp.addEventListener('change', syncCount);
    selectAll?.addEventListener('change', onSelectAll);
    btnConfirm.addEventListener('click', onConfirm);
    btnSkip.addEventListener('click', onSkip);

    overlay.hidden = false;
  });
}

window.DieyunNamespaces.register(
  'DieyunAgent',
  {
    scheduleWorktreePolicyCleanup,
    applyPlanWorktreeMode,
    applyPlanPreviewState,
    beginPlanWorktreeTracking,
    schedulePlanWorktreeChangesRefresh,
    finalizePlanWorktreeTracking,
    applyWorktreeReview,
    dismissWorktreeReview,
    openWorktreeReviewAfterPlan,
    openWorktreeReviewPane,
    handleWorktreeApplyAfterRun,
    kindLabelWorktree,
    getPendingWorktreeApply: (sessionId) => {
      const row = pendingWorktreeRow(sessionId);
      return row ? { ...row } : null;
    }
  },
  {
    compat: [
      'scheduleWorktreePolicyCleanup',
      'applyPlanWorktreeMode',
      'applyPlanPreviewState',
      'beginPlanWorktreeTracking',
      'schedulePlanWorktreeChangesRefresh',
      'applyWorktreeReview',
      'dismissWorktreeReview',
      'openWorktreeReviewPane',
      'handleWorktreeApplyAfterRun',
      'openWorktreeReviewAfterPlan',
      'kindLabelWorktree',
      'getPendingWorktreeApply'
    ]
  }
);
