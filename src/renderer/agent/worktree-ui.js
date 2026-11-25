/* global window, document, $, currentSessionId, sessionActiveRuns, isSessionSending, gwState, gatewayCall, showAgentToast, renderChangesPane, getSessionChangeRowsForAgent, capturePlanApplyForUndo, reportKnowledgePlanOutcome, maybeEnforceWorktreeCleanupPolicy, openSidePanel, setSidePanelTab, DieyunNamespaces */
'use strict';

const worktreeLoopApi = window.diecloud || {};

/** @type {Map<string, object>} */
const pendingWorktreeBySession = new Map();

function worktreeSid(sessionId) {
  return String(sessionId || currentSessionId || '').trim();
}

/** plan 是否仍在跑：**现算**，别信存下来的布尔（见 `pendingWorktreeRow`）。 */
function planRunIsLive(sid) {
  return !!(sid && typeof isSessionSending === 'function' && isSessionSending(sid));
}

function pendingWorktreeRow(sessionId) {
  const sid = worktreeSid(sessionId);
  if (!sid) return null;
  const row = pendingWorktreeBySession.get(sid) || null;
  // `live` 是**推导事实**，不是要单独维护的状态。
  //
  // 以前它只在 `finalizePlanWorktreeTracking`（唯一调用方 = 打开审阅）里被清，而 plan 还有五条
  // 终态路径不会走到那里：撞轮次上限停车、用户停止、抛错、评审否决、后台会话完成 ——
  // 结果 `live` 永远是 true：「应用」按钮永久禁用、面板一直写「Plan 执行中」，
  // 用户只能点「放弃」把产出丢掉（2026-11-19 审计）。
  // 读取时按会话真实运行态校正一次，就不再需要「谁负责清」这条约定。
  if (row && row.live && !planRunIsLive(sid)) row.live = false;
  return row;
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

function finalizePlanWorktreeTracking(runId, sessionId, undoTurnId) {
  if (!runId) return;
  const sid = worktreeSid(sessionId);
  const prev = pendingWorktreeRow(sid);
  setPendingWorktreeRow({
    runId,
    sessionId: sid,
    undoTurnId: undoTurnId || prev?.undoTurnId || null,
    traceFallback: !!prev?.traceFallback,
    traceFallbackReason: prev?.traceFallbackReason || '',
    planPreview: prev?.planPreview || null
  }, sid);
  if (typeof window.invalidateWorktreeReviewCache === 'function') {
    window.invalidateWorktreeReviewCache();
  }
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

/**
 * 计划 worktree 的最终归宿 → Main 的归纳暂存（`agent:knowledge-plan-outcome`）。
 *
 * 归纳的上下文与兜底超时都在 Main，所以这里**只报结论**：
 *   applied   —— 已写回工作区，按应用后的路径整理；
 *   no_changes—— 没有待合并项（非 git 工作空间或纯读计划），按「验收通过」整理；
 *   skipped   —— 用户放弃，plan 相关知识不写入。
 */
function finalizeWorktreeKnowledge(outcome, appliedPaths, sessionId) {
  const sid = worktreeSid(sessionId);
  if (!sid) return;
  if (typeof reportKnowledgePlanOutcome !== 'function') return;
  reportKnowledgePlanOutcome(
    sid,
    outcome,
    outcome === 'applied' ? { appliedPaths: appliedPaths || [] } : {}
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
  //
  // **但只在整批都成功时才清理**：`appliedOk` 对「部分成功」也是 true（失败项在
  // `apply.errors` 里），以前无条件清理会把没应用上的那部分连同行状态一起抹掉 ——
  // 主工作区留下半套改动、剩下的只剩在用户看不见的分支上，而面板因为 `appliedOk=false`
  // 还挂着那一行；再点「应用」时预览已空，反倒弹「已写回 0 个文件」的成功提示。
  const fullyApplied =
    result.appliedOk && !(result.apply && Array.isArray(result.apply.errors) && result.apply.errors.length);
  if (fullyApplied && worktreeLoopApi.worktreeCleanupRun) {
    await worktreeLoopApi.worktreeCleanupRun(pending.runId).catch(() => {});
  }
  scheduleWorktreePolicyCleanup();
  finalizeWorktreeKnowledge(result.appliedOk ? 'applied' : 'skipped', paths, pending.sessionId);
  if (fullyApplied) setPendingWorktreeRow(null, pending.sessionId);
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
  finalizeWorktreeKnowledge('skipped', [], pending.sessionId);
  if (typeof window.invalidateWorktreeReviewCache === 'function') {
    window.invalidateWorktreeReviewCache();
  }
  showAgentToast('已放弃变更', 'Worktree 变更已丢弃', { variant: 'warn' });
  if (typeof renderChangesPane === 'function') renderChangesPane();
}

async function openWorktreeReviewAfterPlan(runId, sessionId, undoTurnId) {
  finalizePlanWorktreeTracking(runId, sessionId, undoTurnId);
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
    // 没有待合并项：这一轮照样验收通过，归应按「已完成」整理（上下文在 Main 暂存）
    finalizeWorktreeKnowledge('no_changes', [], sessionId);
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

/**
 * 会话装载时恢复「待应用」的 worktree 行。
 *
 * `agent_runs.status === 'pending_apply'` 是**持久事实**，而 `pendingWorktreeBySession`
 * 只是进程内 Map —— 重启后「变更」面板再也找不到这个 run，用户只能在「设置 → Worktree」
 * 里看到一个「遗留 run」，那里的删除还会把它归档/丢掉（2026-11-19 审计 P1）。
 * 这里按库里的事实把行补回来，`pending_apply` 才名副其实。
 */
async function restorePendingWorktreeRowFromState(sessionId) {
  const sid = worktreeSid(sessionId);
  if (!sid || !gwState.authed) return false;
  if (pendingWorktreeRow(sid)) return false;
  if (typeof gatewayCall !== 'function') return false;
  try {
    const state = await gatewayCall('agent.state_get', { sessionId: sid });
    if (!state || state.status !== 'pending_apply' || !state.runId) return false;
    setPendingWorktreeRow(
      {
        runId: String(state.runId),
        sessionId: sid,
        undoTurnId: null,
        live: false,
        traceFallback: false,
        traceFallbackReason: '',
        planPreview: null
      },
      sid
    );
    if (typeof window.invalidateWorktreeReviewCache === 'function') {
      window.invalidateWorktreeReviewCache();
    }
    if (typeof renderChangesPane === 'function') renderChangesPane();
    return true;
  } catch {
    return false;
  }
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
    restorePendingWorktreeRowFromState,
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
      'restorePendingWorktreeRowFromState',
      'openWorktreeReviewAfterPlan',
      'kindLabelWorktree',
      'getPendingWorktreeApply'
    ]
  }
);
