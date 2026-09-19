/* global mergeArtifactRows, sessionFileChangeTotals, getSidePanelTab, escapeHtml, document, window, flatFileIconSvg, getActiveLiveWrite, syncLiveWritePreview, applyLiveWriteFileListMarks, pathsMatch, resolveArtifactDiffFromTrace, readArtifactFileText, renderChangesPaneDiffPreview, toolDiffHasBody, gwState, upsertArtifactFileDiffBadge, enrichLiveWriteDiffStats, formatArtifactDiffHtml, getLastRoundFileChanges, currentSessionId, isPlausibleArtifactPath, pickDiffDisplayText, applyWorkspaceArtifactPath, liveMatchesArtifactPath */
'use strict';

const dcApi = window.diecloud || {};

function workspaceArtifactPath(path) {
  return typeof applyWorkspaceArtifactPath === 'function'
    ? applyWorkspaceArtifactPath(String(path || '').trim())
    : String(path || '').trim();
}

function pathsMatchArtifact(a, b) {
  if (!a || !b) return false;
  const ca = workspaceArtifactPath(a);
  const cb = workspaceArtifactPath(b);
  return typeof pathsMatch === 'function' ? pathsMatch(ca, cb) : ca === cb;
}

function liveMatchesPath(live, path) {
  if (typeof liveMatchesArtifactPath === 'function') return liveMatchesArtifactPath(live, path);
  if (!live || !path || typeof pathsMatch !== 'function') return false;
  const target = workspaceArtifactPath(path);
  if (live.canonicalPath && pathsMatch(live.canonicalPath, target)) return true;
  if (live.path && pathsMatch(workspaceArtifactPath(live.path), target)) return true;
  return false;
}

/** @type {{ runId: string, preview: object, accepted: Map<string, boolean>, emptyPending?: boolean } | null} */
let worktreeReviewCache = null;

function invalidateWorktreeReviewCache() {
  worktreeReviewCache = null;
}

if (typeof window !== 'undefined') {
  window.invalidateWorktreeReviewCache = invalidateWorktreeReviewCache;
}

function kindLabel(kind) {
  if (typeof window.kindLabelWorktree === 'function') return window.kindLabelWorktree(kind);
  if (kind === 'deleted') return '删除';
  if (kind === 'added' || kind === 'untracked') return '新增';
  return '修改';
}

function formatDiffHtml(patch, opts) {
  if (!patch) return '<div class="artifacts-empty">无 diff 内容</div>';
  const asNew = !!(opts && opts.asNew);
  const lines = String(patch).split('\n');
  const looksLikePatch = lines.some((line) => line.startsWith('@@') || line.startsWith('+++'));
  if (asNew || (!looksLikePatch && !lines.some((line) => line.startsWith('+') || line.startsWith('-')))) {
    return lines
      .map((line) => `<div class="diff-line diff-add">${escapeHtml('+' + line)}</div>`)
      .join('');
  }
  return lines
    .map((line) => {
      let cls = 'diff-line';
      if (line.startsWith('+++') || line.startsWith('---')) cls += ' diff-hdr';
      else if (line.startsWith('+')) cls += ' diff-add';
      else if (line.startsWith('-')) cls += ' diff-del';
      else if (line.startsWith('@@')) cls += ' diff-hunk';
      else cls += ' diff-eq';
      return `<div class="${cls}">${escapeHtml(line)}</div>`;
    })
    .join('');
}

const WORKTREE_DIFF_PAINT_MS = 400;
let worktreeActiveChangeKey = '';
let worktreeLastPreviewSig = '';
let worktreeDiffPaintTimer = null;
/** @type {{ view: HTMLElement, ch: object } | null} */
let worktreeDiffPaintPending = null;

function worktreeChangeKey(ch) {
  if (!ch) return '';
  return String(ch.changeId || `${ch.roleId || ''}::${ch.repoPath || ''}`);
}

function worktreePreviewSig(beforeText, afterText) {
  const before = String(beforeText ?? '');
  const after = String(afterText ?? '');
  return `${before.length}:${after.length}:${before.slice(0, 48)}:${after.slice(-80)}`;
}

function scheduleWorktreeDiffPreviewUpdate(view, ch) {
  if (!view || !ch) return;
  worktreeDiffPaintPending = { view, ch };
  if (worktreeDiffPaintTimer) clearTimeout(worktreeDiffPaintTimer);
  worktreeDiffPaintTimer = setTimeout(() => {
    worktreeDiffPaintTimer = null;
    const pending = worktreeDiffPaintPending;
    worktreeDiffPaintPending = null;
    if (!pending) return;
    void refreshWorktreeChangePreview(pending.view, pending.ch, { incremental: true });
  }, WORKTREE_DIFF_PAINT_MS);
}

async function refreshWorktreeChangePreview(view, ch, opts) {
  if (!view || !ch) return;
  const incremental = !!(opts && opts.incremental);
  const key = worktreeChangeKey(ch);
  if (
    incremental &&
    isChangesDiffPreviewMounted(ch.repoPath) &&
    worktreeActiveChangeKey === key
  ) {
    let diff = { patch: '', added: 0, removed: 0 };
    if (dcApi.worktreeChangeDiff) {
      try {
        diff = await dcApi.worktreeChangeDiff(ch);
      } catch {
        // ignore
      }
    }
    await showWorktreeChangePreview(view, ch, diff, { incremental: true, planLive: true });
    return;
  }
  worktreeActiveChangeKey = key;
  if (!incremental) {
    worktreeLastPreviewSig = '';
    if (!isChangesDiffPreviewMounted(ch.repoPath)) {
      view.innerHTML = '<div class="artifacts-empty">加载 diff…</div>';
    }
  }
  let diff = { patch: '', added: 0, removed: 0 };
  if (dcApi.worktreeChangeDiff) {
    try {
      diff = await dcApi.worktreeChangeDiff(ch);
    } catch {
      // ignore
    }
  }
  await showWorktreeChangePreview(view, ch, diff, opts);
}

async function showWorktreeChangePreview(view, ch, diff, opts) {
  if (!view || !ch) return;
  const planLive = !!(opts && opts.planLive);
  setChangesPreviewPath(ch.repoPath);
  worktreeActiveChangeKey = worktreeChangeKey(ch);
  ensureWorktreePreviewMeta(view, ch, diff, { planLive });
  const beforeText = diff.beforeText != null ? String(diff.beforeText) : '';
  const afterText =
    diff.afterText != null
      ? String(diff.afterText)
      : diff.untracked || diff.isNew
        ? String(diff.patch || '')
        : '';
  const hasBody = beforeText || afterText;
  const previewSig = worktreePreviewSig(beforeText, afterText);
  if (
    opts &&
    opts.incremental &&
    previewSig === worktreeLastPreviewSig &&
    isChangesDiffPreviewMounted(ch.repoPath)
  ) {
    ensureWorktreePreviewMeta(view, ch, diff, { planLive });
    return;
  }
  worktreeLastPreviewSig = previewSig;
  if (hasBody && typeof renderChangesPaneDiffPreview === 'function') {
    await renderChangesPaneDiffPreview(
      view,
      {
        path: ch.repoPath,
        diff: {
          beforeText,
          afterText,
          added: Number(diff.added) || 0,
          removed: Number(diff.removed) || 0,
          created: !!(diff.untracked || diff.isNew)
        }
      },
      { ...opts, planLive, worktreeChange: ch }
    );
    return;
  }
  if (opts && opts.incremental && view.querySelector('.changes-unified-diff')) {
    const body = view.querySelector('.changes-unified-diff');
    if (typeof window.patchUnifiedDiffInPlace === 'function') {
      window.patchUnifiedDiffInPlace(body, beforeText, afterText);
    }
    ensureWorktreePreviewMeta(view, ch, diff, { planLive });
    return;
  }
  ensureWorktreePreviewMeta(view, ch, diff, { planLive });
  view.querySelector('.artifacts-diff-shell')?.remove();
  view.insertAdjacentHTML(
    'beforeend',
    `<div class="changes-view-meta">${escapeHtml(ch.repoPath)}</div>` +
      `<div class="changes-view-diff">+${diff.added || 0} / -${diff.removed || 0} 行 · ${escapeHtml(kindLabel(ch.kind))}</div>` +
      `<div class="changes-diff-pre changes-unified-diff agent-scroll">${formatDiffHtml(diff.patch || '', {
        asNew: !!(diff.untracked || diff.isNew)
      })}</div>`
  );
}

function worktreePreviewMetaText(ch, diff, planLive) {
  const parts = [];
  if (ch.roleId) parts.push(`执行器 ${ch.roleId}`);
  parts.push(kindLabel(ch.kind));
  const added = Number(diff?.added) || 0;
  const removed = Number(diff?.removed) || 0;
  if (added || removed) parts.push(`+${added} -${removed}`);
  if (ch.conflict) parts.push('多路冲突');
  if (ch.mainDirty) parts.push('主区已改');
  if (planLive) parts.push('worktree 写入中');
  return parts.join(' · ');
}

function ensureWorktreePreviewMeta(view, ch, diff, opts) {
  if (!view || !ch) return;
  const planLive = !!(opts && opts.planLive);
  let meta = view.querySelector(':scope > .changes-worktree-preview-meta');
  if (!meta) {
    meta = document.createElement('div');
    meta.className = 'changes-worktree-preview-meta';
    const shell = view.querySelector('.artifacts-diff-shell');
    if (shell) view.insertBefore(meta, shell);
    else view.prepend(meta);
  }
  meta.classList.toggle('is-plan-live', planLive);
  if (!meta.querySelector('.changes-worktree-preview-path')) {
    meta.innerHTML =
      '<div class="changes-worktree-preview-path"></div>' +
      '<div class="changes-worktree-preview-detail"></div>' +
      '<span class="changes-worktree-preview-badge" hidden></span>';
  }
  const pathNode = meta.querySelector('.changes-worktree-preview-path');
  const detailNode = meta.querySelector('.changes-worktree-preview-detail');
  const badgeNode = meta.querySelector('.changes-worktree-preview-badge');
  if (pathNode) {
    pathNode.textContent = ch.repoPath;
    pathNode.title = ch.repoPath;
  }
  if (detailNode) {
    detailNode.textContent = worktreePreviewMetaText(ch, diff, false);
  }
  if (badgeNode) {
    if (planLive) {
      badgeNode.hidden = false;
      badgeNode.textContent = 'Plan · 写入中…';
    } else {
      badgeNode.hidden = true;
      badgeNode.textContent = '';
    }
  }
}

function planWorktreePreviewOpts() {
  const pending =
    typeof window.getPendingWorktreeApply === 'function' ? window.getPendingWorktreeApply() : null;
  return { planLive: !!(pending && pending.live) };
}

async function loadWorktreeReviewIfNeeded() {
  const pending =
    typeof window.getPendingWorktreeApply === 'function' ? window.getPendingWorktreeApply() : null;
  if (!pending) {
    worktreeReviewCache = null;
    return null;
  }
  if (pending.live && !pending.runId) {
    return {
      runId: '',
      preview: { ok: true, changes: [] },
      accepted: new Map(),
      live: true,
      awaitingRunId: true,
      emptyPending: true,
      planPreview: pending.planPreview || null,
      traceFallback: !!pending.traceFallback
    };
  }
  if (!pending.runId) {
    worktreeReviewCache = null;
    return null;
  }
  if (
    worktreeReviewCache?.runId === pending.runId &&
    !pending.live &&
    !worktreeReviewCache.live &&
    !worktreeReviewCache.emptyPending
  ) {
    return worktreeReviewCache;
  }
  let preview = null;
  if (dcApi.worktreePreviewRun) {
    try {
      preview = await dcApi.worktreePreviewRun(pending.runId);
    } catch {
      preview = null;
    }
  }
  if (!preview?.ok || !preview.changes?.length) {
    const emptyReview = {
      runId: pending.runId,
      preview: preview || { ok: false, changes: [], error: '无法加载 worktree 变更' },
      accepted: new Map(),
      emptyPending: true,
      live: !!pending.live,
      planPreview: pending.planPreview || null,
      traceFallback: !!pending.traceFallback
    };
    worktreeReviewCache = emptyReview;
    return emptyReview;
  }
  const accepted = new Map();
  for (const ch of preview.changes) {
    const key = ch.changeId || ch.repoPath;
    accepted.set(key, !ch.conflict);
  }
  worktreeReviewCache = {
    runId: pending.runId,
    preview,
    accepted,
    live: !!pending.live,
    planPreview: pending.planPreview || null,
    traceFallback: !!pending.traceFallback
  };
  return worktreeReviewCache;
}

function syncWorktreeReviewToolbar(review, summary) {
  showChangesDiffToolbar();
  const n = [...review.accepted.values()].filter(Boolean).length;
  const total = review.preview.changes.length;
  const live = !!review.live;
  const pending =
    typeof window.getPendingWorktreeApply === 'function' ? window.getPendingWorktreeApply() : null;
  const fallback = !!(pending && pending.traceFallback);
  const applyBtn = document.getElementById('changes-review-apply');
  const dismissBtn = document.getElementById('changes-review-dismiss');
  const meta = document.getElementById('changes-review-meta');
  setWorktreeReviewControlsEnabled(true, {
    applyDisabled: live || !!review.emptyPending,
    dismissDisabled: false,
    selectDisabled: !!review.emptyPending,
  });
  if (meta) {
    meta.textContent = live
      ? total > 0
        ? `Plan 执行中 · Worktree ${total} 个文件变更`
        : review.awaitingRunId
          ? 'Plan 执行中 · 等待 worktree 就绪'
          : (review.planPreview || pending?.planPreview)?.targets?.length
            ? `Plan 规划中 · 预计 ${(review.planPreview || pending.planPreview).targets.length} 个文件`
            : 'Plan 执行中 · 等待执行器写入'
      : `Worktree 待合并 · 已选 ${n} / ${total}`;
    if (fallback && live) {
      meta.textContent += ` · ${typeof window.traceFallbackLabel === 'function' ? window.traceFallbackLabel(pending.traceFallbackReason) : 'trace diff'}`;
    }
  }
  if (summary) {
    summary.textContent = live
      ? total > 0
        ? `Plan 执行中 · ${total} 个文件已变更`
        : (review.planPreview || pending?.planPreview)?.targets?.length
          ? `Plan 规划中 · ${(review.planPreview || pending.planPreview).targets.length} 个预计变更`
          : 'Plan 执行中 · 变更将在此实时显示'
      : `Worktree ${total} 个文件待审核`;
  }
}

function isWorktreeReviewActive() {
  const pending =
    typeof window.getPendingWorktreeApply === 'function' ? window.getPendingWorktreeApply() : null;
  if (!pending || !(pending.runId || pending.live)) return false;
  if (
    typeof window.shouldPlanUseTraceDiffFallback === 'function' &&
    window.shouldPlanUseTraceDiffFallback()
  ) {
    return false;
  }
  if (
    typeof currentSessionId !== 'undefined' &&
    pending.sessionId &&
    currentSessionId &&
    pending.sessionId !== currentSessionId
  ) {
    return false;
  }
  return true;
}

function shouldShowPlanPreviewPane() {
  const pending =
    typeof window.getPendingWorktreeApply === 'function' ? window.getPendingWorktreeApply() : null;
  if (!pending?.live) return false;
  const preview = pending.planPreview;
  const targets = preview && Array.isArray(preview.targets) ? preview.targets : [];
  if (!targets.length) return false;
  if (
    typeof window.shouldPlanUseTraceDiffFallback === 'function' &&
    window.shouldPlanUseTraceDiffFallback()
  ) {
    const rows =
      typeof getSessionChangeRows === 'function'
        ? getSessionChangeRows()
        : typeof mergeArtifactRows === 'function'
          ? mergeArtifactRows().filter((a) => a && a.path && (a.diff || a.source === 'trace'))
          : [];
    return !rows.length;
  }
  return true;
}

function fallbackDiffAfterText(diff) {
  if (!diff || typeof diff !== 'object') return '';
  if (typeof pickDiffDisplayText === 'function') {
    const picked = pickDiffDisplayText(diff, 'after');
    if (picked) return String(picked);
  }
  if (diff.afterText != null && String(diff.afterText)) return String(diff.afterText);
  if ((diff.untracked || diff.isNew) && diff.patch) return String(diff.patch);
  return '';
}

async function findWorktreeChangeForRepoPath(filePath, opts) {
  if (!filePath) return null;
  const pending =
    typeof window.getPendingWorktreeApply === 'function' ? window.getPendingWorktreeApply() : null;
  if (!pending?.runId) return null;
  if (
    typeof currentSessionId !== 'undefined' &&
    pending.sessionId &&
    currentSessionId &&
    pending.sessionId !== currentSessionId
  ) {
    return null;
  }
  if (!(opts && opts.ignoreReviewGate) && !isWorktreeReviewActive()) return null;

  let changes = null;
  const cacheUsable =
    worktreeReviewCache?.runId === pending.runId &&
    !worktreeReviewCache.emptyPending &&
    worktreeReviewCache.preview?.ok &&
    Array.isArray(worktreeReviewCache.preview.changes) &&
    worktreeReviewCache.preview.changes.length > 0;
  if (cacheUsable) {
    changes = worktreeReviewCache.preview.changes;
  } else if (dcApi.worktreePreviewRun) {
    try {
      const preview = await dcApi.worktreePreviewRun(pending.runId);
      if (preview?.ok && preview.changes?.length) changes = preview.changes;
    } catch {
      return null;
    }
  }
  if (!changes?.length) return null;
  return (
    changes.find((ch) =>
      typeof pathsMatch === 'function' ? pathsMatch(ch.repoPath, filePath) : ch.repoPath === filePath
    ) || null
  );
}

/**
 * 当前工作区读盘失败时：live afterText → Worktree 实文件 → 会话/trace diff 正文。
 * @returns {Promise<{ text: string, source: 'worktree'|'live'|'trace', truncated?: boolean }|null>}
 */
async function readFallbackArtifactText(filePath) {
  const fp = workspaceArtifactPath(filePath);
  if (!fp) return null;

  const live = typeof getActiveLiveWrite === 'function' ? getActiveLiveWrite() : null;
  if (live && liveMatchesPath(live, fp) && live.afterText != null && String(live.afterText)) {
    return { text: String(live.afterText), source: 'live' };
  }

  const ch = await findWorktreeChangeForRepoPath(fp, { ignoreReviewGate: true });
  if (ch && dcApi.worktreeChangeDiff) {
    try {
      const diff = await dcApi.worktreeChangeDiff(ch);
      const after = fallbackDiffAfterText(diff);
      if (after) {
        return {
          text: after,
          source: 'worktree',
          truncated: /内容过长已截断/.test(after)
        };
      }
    } catch {
      // keep looking in session/trace
    }
  }

  const rows = typeof mergeArtifactRows === 'function' ? mergeArtifactRows() : [];
  const art = rows.find((r) => r && r.path && pathsMatchArtifact(r.path, fp));
  const merged = art ? mergeSessionArtifactDiff(art) : null;
  const fromRow = fallbackDiffAfterText(merged);
  if (fromRow) return { text: fromRow, source: 'trace' };

  if (typeof resolveArtifactDiffFromTrace === 'function') {
    const fromTrace = fallbackDiffAfterText(resolveArtifactDiffFromTrace(fp));
    if (fromTrace) return { text: fromTrace, source: 'trace' };
  }
  return null;
}

async function tryShowWorktreeChangePreview(view, filePath, opts) {
  const ch = await findWorktreeChangeForRepoPath(filePath);
  if (!ch || !view) return false;
  const pending =
    typeof window.getPendingWorktreeApply === 'function' ? window.getPendingWorktreeApply() : null;
  await refreshWorktreeChangePreview(view, ch, {
    incremental: !!(opts && opts.incremental),
    planLive: !!(pending && pending.live)
  });
  return true;
}

const WORKTREE_REVIEW_IDLE_TITLE = 'Plan Worktree 待审时可用';

function setWorktreeReviewControlsEnabled(enabled, opts) {
  const applyBtn = document.getElementById('changes-review-apply');
  const dismissBtn = document.getElementById('changes-review-dismiss');
  const selectAll = document.getElementById('changes-review-select-all');
  const idle = !enabled;
  const applyDisabled = idle || !!(opts && opts.applyDisabled);
  const dismissDisabled = idle || !!(opts && opts.dismissDisabled);
  const selectDisabled = idle || !!(opts && opts.selectDisabled);

  if (applyBtn) {
    applyBtn.disabled = applyDisabled;
    applyBtn.title = idle
      ? WORKTREE_REVIEW_IDLE_TITLE
      : '将已选 Worktree 变更应用到主工作区';
  }
  if (dismissBtn) {
    dismissBtn.disabled = dismissDisabled;
    dismissBtn.title = idle ? WORKTREE_REVIEW_IDLE_TITLE : '放弃 Worktree 待审变更';
  }
  if (selectAll) {
    selectAll.disabled = selectDisabled;
  }
}

function syncChangesReviewToolbarMode() {
  const toolbar = document.getElementById('changes-review-toolbar');
  if (!toolbar) return;
  const worktree = isWorktreeReviewActive();
  if (!worktree) {
    setWorktreeReviewControlsEnabled(false);
  }
  const meta = document.getElementById('changes-review-meta');
  const selectWrap = document.getElementById('changes-review-select-wrap');
  const applyBtn = document.getElementById('changes-review-apply');
  const dismissBtn = document.getElementById('changes-review-dismiss');
  if (meta) {
    if (!worktree) {
      meta.textContent = '';
      meta.hidden = true;
    } else {
      meta.hidden = false;
    }
  }
  if (selectWrap) selectWrap.hidden = !worktree;
  if (applyBtn) applyBtn.hidden = !worktree;
  if (dismissBtn) dismissBtn.hidden = !worktree;
}

function showChangesDiffToolbar() {
  const toolbar = document.getElementById('changes-review-toolbar');
  if (!toolbar) return;
  toolbar.hidden = !isWorktreeReviewActive();
  syncChangesReviewToolbarMode();
}

let changesPreviewPath = '';

function setChangesPreviewPath(filePath) {
  changesPreviewPath = filePath ? String(filePath) : '';
}

function hideWorktreeReviewToolbar(summary) {
  if (isWorktreeReviewActive()) {
    showChangesDiffToolbar();
    return;
  }
  const toolbar = document.getElementById('changes-review-toolbar');
  if (toolbar) toolbar.hidden = true;
  syncChangesReviewToolbarMode();
  if (summary && typeof sessionFileChangeTotals !== 'undefined') {
    const t = sessionFileChangeTotals;
    summary.textContent =
      t.files > 0 ? `${t.files} 个文件 · +${t.added || 0} -${t.removed || 0}` : '本会话暂无文件变更';
  }
}

function bindWorktreeReviewActions(review) {
  const applyBtn = document.getElementById('changes-review-apply');
  const dismissBtn = document.getElementById('changes-review-dismiss');
  const selectAll = document.getElementById('changes-review-select-all');
  const emptyPending = !!review.emptyPending;

  const syncSelectAll = () => {
    if (!selectAll) return;
    const all = review.preview.changes.every((ch) => review.accepted.get(ch.changeId || ch.repoPath));
    selectAll.checked = all;
  };

  if (selectAll) {
    selectAll.onchange = () => {
      const v = !!selectAll.checked;
      for (const ch of review.preview.changes) {
        review.accepted.set(ch.changeId || ch.repoPath, v);
      }
      renderChangesPane();
    };
  }

  if (applyBtn) {
    applyBtn.onclick = async () => {
      const selectedChanges = review.preview.changes.filter((ch) =>
        review.accepted.get(ch.changeId || ch.repoPath)
      );
      const keyOf = (ch) => ch.changeId || `${ch.roleId}::${ch.repoPath}`;
      const paths = [...new Set(selectedChanges.map((ch) => ch.repoPath))];
      const changeIds = selectedChanges.map(keyOf);
      // 冲突强制按变更粒度。原来用「存在冲突 → forceConflict=true」，
      // 勾中一个冲突文件会连带解除其余全部文件的覆盖保护。
      const forceChangeIds = selectedChanges.filter((ch) => ch.conflict).map(keyOf);
      // 主工作区已有未提交改动的文件默认不覆盖，必须逐次显式确认。
      const dirtyChanges = selectedChanges.filter((ch) => ch.mainDirty);
      let allowOverwriteMainDirty = false;
      if (dirtyChanges.length) {
        allowOverwriteMainDirty = window.confirm(
          `以下 ${dirtyChanges.length} 个文件在主工作区已有未提交修改，应用会覆盖它们：\n\n` +
            dirtyChanges.map((ch) => `· ${ch.repoPath}`).join('\n') +
            '\n\n覆盖前会自动备份到 .dieyun/backup/，可回滚。确定继续？'
        );
        if (!allowOverwriteMainDirty) return;
      }
      if (typeof window.applyWorktreeReview === 'function') {
        applyBtn.disabled = true;
        try {
          await window.applyWorktreeReview(paths, {
            forceChangeIds,
            allowOverwriteMainDirty,
            changeIds
          });
        } finally {
          applyBtn.disabled = false;
        }
      }
    };
  }

  if (dismissBtn) {
    dismissBtn.onclick = () => {
      if (typeof window.dismissWorktreeReview === 'function') {
        void window.dismissWorktreeReview();
      }
    };
  }

  syncSelectAll();
}

function worktreeEmptyPendingMessage(review) {
  if (review.live) {
    if (review.awaitingRunId) {
      return 'Plan 已启动，正在准备 worktree…执行器写入后，文件列表会在此自动更新。';
    }
    if (review.planPreview?.targets?.length) {
      return '任务拆解已完成。左侧为预计变更文件；执行器写入 worktree 后会切换为实际 diff。';
    }
    return 'Plan 执行器正在 worktree 中改代码，有文件变更后会自动出现在左侧列表；点击文件可预览内联 diff。';
  }
  const err = review.preview && review.preview.error ? String(review.preview.error) : '';
  if (err.includes('不是 git 仓库')) {
    return '当前工作空间不是 git 仓库，Plan 改动已直接写入工作区。可在下方查看本会话文件 diff，或点击「放弃全部」关闭待审状态。';
  }
  if (err.includes('未设置工作空间')) {
    return '未设置工作空间，无法加载待合并变更。请点击「放弃全部」关闭。';
  }
  return 'Worktree 中未检测到待合并文件（可能已直接写入主工作区，或变更已被清理）。请查看下方本会话 diff，或点击「放弃全部」。';
}

async function renderWorktreeEmptyPendingPane(review, list, view, summary) {
  const pending =
    typeof window.getPendingWorktreeApply === 'function' ? window.getPendingWorktreeApply() : null;
  if (
    review.live &&
    pending?.planPreview?.targets?.length &&
    typeof window.renderPlanPreviewPane === 'function'
  ) {
    window.renderPlanPreviewPane(pending, list, view, summary);
    return;
  }
  syncWorktreeReviewToolbar(review, summary);
  bindWorktreeReviewActions(review);
  const meta = document.getElementById('changes-review-meta');
  if (meta && review.live) {
    meta.textContent = review.awaitingRunId
      ? 'Plan 执行中 · 等待 worktree 就绪'
      : 'Plan 执行中 · 等待文件变更';
  } else if (meta) {
    meta.textContent = 'Worktree 待合并 · 无可选文件';
  }
  if (summary && review.live) {
    summary.textContent = 'Plan 执行中 · 变更将在此实时显示';
  } else if (summary) {
    summary.textContent = '无 worktree 待审文件';
  }
  list.innerHTML =
    `<div class="artifacts-empty changes-review-empty">${escapeHtml(worktreeEmptyPendingMessage(review))}</div>`;
  if (view) {
    view.innerHTML = review.live
      ? '<div class="artifacts-empty">执行器写入 worktree 后，可在此预览 diff</div>'
      : '<div class="artifacts-empty">若主工作区已有改动，可关闭本栏后从会话 trace 查看</div>';
  }
}

async function renderWorktreeReviewPane(review, list, view, summary) {
  if (review.emptyPending) {
    await renderWorktreeEmptyPendingPane(review, list, view, summary);
    return;
  }

  syncWorktreeReviewToolbar(review, summary);
  bindWorktreeReviewActions(review);

  const prevPath = changesPreviewPath;
  const prevKey = worktreeActiveChangeKey;
  const wasMounted = prevPath && isChangesDiffPreviewMounted(prevPath);
  const changes = review.preview.changes;

  const listSyncedInPlace = review.live && syncWorktreeReviewListInPlace(review, list);

  if (!listSyncedInPlace) {
    list.innerHTML = '';

    for (const ch of changes) {
      const row = document.createElement('div');
      row.className = 'artifacts-file-item changes-review-item';
      row.dataset.changeKey = worktreeChangeKey(ch);
      if (ch.conflict) row.classList.add('conflict');
      if (ch.mainDirty) row.classList.add('main-dirty');

      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.className = 'changes-review-cb';
      cb.checked = !!review.accepted.get(ch.changeId || ch.repoPath);
      cb.addEventListener('click', (e) => e.stopPropagation());
      cb.addEventListener('change', () => {
        review.accepted.set(ch.changeId || ch.repoPath, cb.checked);
        syncWorktreeReviewToolbar(review, summary);
        bindWorktreeReviewActions(review);
      });

      const nameSpan = document.createElement('span');
      nameSpan.className = 'artifacts-file-name';
      nameSpan.textContent = ch.conflict ? `${ch.repoPath} (${ch.roleId})` : ch.repoPath;

      const metaSpan = document.createElement('span');
      metaSpan.className = 'changes-review-meta-tag';
      metaSpan.textContent = worktreeRowMeta(ch);

      row.appendChild(cb);
      row.appendChild(nameSpan);
      row.appendChild(metaSpan);
      row.title = ch.repoPath;

      row.addEventListener('click', async () => {
        const items = list.querySelectorAll('.artifacts-file-item');
        for (let j = 0; j < items.length; j++) items[j].classList.remove('active');
        row.classList.add('active');
        if (!view) return;
        worktreeLastPreviewSig = '';
        await refreshWorktreeChangePreview(view, ch, { incremental: false, ...planWorktreePreviewOpts() });
      });

      list.appendChild(row);
    }
  }

  restoreWorktreePreviewSelection(review, list, view, {
    prevPath,
    prevKey,
    wasMounted,
    changes
  });
}

function worktreeRowMeta(ch) {
  return `${kindLabel(ch.kind)} · ${ch.roleId}${ch.conflict ? ' · 冲突' : ''}${ch.mainDirty ? ' · 主区已改' : ''}`;
}

function syncWorktreeReviewListInPlace(review, list) {
  const changes = review.preview?.changes;
  if (!Array.isArray(changes) || !list) return false;
  const rows = list.querySelectorAll('.changes-review-item');
  if (rows.length !== changes.length) return false;

  for (let i = 0; i < changes.length; i++) {
    const ch = changes[i];
    const row = rows[i];
    const key = worktreeChangeKey(ch);
    if (!row || row.dataset.changeKey !== key) return false;

    const metaSpan = row.querySelector('.changes-review-meta-tag');
    if (metaSpan) metaSpan.textContent = worktreeRowMeta(ch);

    const cb = row.querySelector('.changes-review-cb');
    if (cb && document.activeElement !== cb) {
      cb.checked = !!review.accepted.get(ch.changeId || ch.repoPath);
    }

    row.classList.toggle('conflict', !!ch.conflict);
    row.classList.toggle('main-dirty', !!ch.mainDirty);
  }
  return true;
}

async function restoreWorktreePreviewSelection(review, list, view, ctx) {
  const { prevPath, prevKey, wasMounted, changes } = ctx;
  if (view && changes.length) {
    list.querySelectorAll('.artifacts-file-item.active').forEach((el) => el.classList.remove('active'));
    let targetRow =
      (prevKey &&
        [...list.querySelectorAll('.changes-review-item')].find(
          (el) => el.dataset.changeKey === prevKey
        )) ||
      (prevPath &&
        [...list.querySelectorAll('.artifacts-file-item')].find((el) => el.title === prevPath)) ||
      list.querySelector('.artifacts-file-item');
    const ch =
      targetRow &&
      changes.find((c) => worktreeChangeKey(c) === targetRow.dataset.changeKey);
    if (targetRow && ch) {
      targetRow.classList.add('active');
      list.querySelectorAll('.changes-review-item').forEach((el) => {
        el.classList.toggle('is-plan-preview-active', el === targetRow && !!review.live);
      });
      const samePreview =
        wasMounted &&
        prevPath &&
        typeof pathsMatch === 'function' &&
        pathsMatch(prevPath, ch.repoPath);
      if (samePreview && review.live) {
        scheduleWorktreeDiffPreviewUpdate(view, ch);
      } else if (samePreview) {
        setChangesPreviewPath(ch.repoPath);
        worktreeActiveChangeKey = worktreeChangeKey(ch);
        if (wasMounted && !review.live) {
          worktreeLastPreviewSig = '';
          await refreshWorktreeChangePreview(view, ch, { incremental: true, planLive: false });
        }
      } else {
        worktreeLastPreviewSig = '';
        await refreshWorktreeChangePreview(view, ch, { incremental: false, ...planWorktreePreviewOpts() });
      }
    }
  } else if (view) {
    worktreeActiveChangeKey = '';
    worktreeLastPreviewSig = '';
    view.innerHTML =
      '<div class="artifacts-empty">勾选要合并的文件，点击行查看 diff，然后「应用已选」</div>';
  }
}

function renderSessionDiffSideBySide(view, art) {
  const diff = art.diff || {};
  const before =
    diff.beforeText != null
      ? String(diff.beforeText)
      : diff.created
        ? ''
        : diff.beforeSnippet != null
          ? String(diff.beforeSnippet)
          : '';
  const after =
    diff.afterText != null
      ? String(diff.afterText)
      : diff.afterSnippet != null
        ? String(diff.afterSnippet)
        : '';
  const title = art.diff?.created ? '新建文件' : '修改文件';
  const truncatedNote = diff.textTruncated
    ? '<div class="changes-view-meta changes-view-meta-muted">文件较大，仅显示变更片段</div>'
    : '';
  view.innerHTML =
    '<div class="changes-view-meta">' +
    escapeHtml(art.path) +
    ' · ' +
    escapeHtml(title) +
    ' · +' +
    escapeHtml(String(diff.added || 0)) +
    ' / -' +
    escapeHtml(String(diff.removed || 0)) +
    ' 行</div>' +
    truncatedNote +
    '<div class="agents-md-diff-grid changes-session-diff-grid">' +
    '<div class="agents-md-diff-pane"><div class="agents-md-diff-label">修改前</div>' +
    '<pre class="agents-md-diff-pre">' +
    escapeHtml(before || '（空 / 新建）') +
    '</pre></div>' +
    '<div class="agents-md-diff-pane"><div class="agents-md-diff-label">修改后</div>' +
    '<pre class="agents-md-diff-pre">' +
    escapeHtml(after || '（空）') +
    '</pre></div></div>';
}

function mergeSessionArtifactDiff(art) {
  let diff = art.diff && typeof art.diff === 'object' ? { ...art.diff } : null;
  if ((!diff || !toolDiffHasBody(diff)) && typeof resolveArtifactDiffFromTrace === 'function') {
    const resolved = resolveArtifactDiffFromTrace(art.path);
    if (resolved) diff = resolved;
  }
  const live = typeof getActiveLiveWrite === 'function' ? getActiveLiveWrite() : null;
  if (
    live &&
    art?.path &&
    liveMatchesPath(live, art.path) &&
    (!diff || !toolDiffHasBody(diff))
  ) {
    const liveDiff =
      typeof enrichLiveWriteDiffStats === 'function' ? enrichLiveWriteDiffStats(live) : live.diff;
    if (liveDiff && toolDiffHasBody(liveDiff)) {
      diff = {
        ...liveDiff,
        beforeText: live.beforeText ?? liveDiff.beforeText,
        afterText: live.afterText ?? liveDiff.afterText
      };
    } else if (live.afterText != null) {
      diff = {
        ...(diff || {}),
        beforeText: live.beforeText ?? '',
        afterText: live.afterText,
        created: !live.beforeText,
        added: Number(liveDiff?.added) || Number(diff?.added) || 0,
        removed: Number(liveDiff?.removed) || Number(diff?.removed) || 0
      };
    }
  }
  return diff;
}

function isChangesDiffPreviewMounted(filePath) {
  const view = document.getElementById('changes-file-view');
  if (!view || !filePath) return false;
  const hasPreview = !!view.querySelector(
    '.artifacts-diff-shell, .artifacts-diff-shell-large'
  );
  if (!hasPreview) return false;
  const previewPath = changesPreviewPath || '';
  if (!previewPath) return false;
  return pathsMatchArtifact(previewPath, filePath);
}

async function showSessionChangePreview(view, art, opts) {
  if (!view || !art?.path) {
    setChangesPreviewPath('');
    return;
  }
  const previewPath = workspaceArtifactPath(art.path);
  const incremental = !!(opts && opts.incremental);

  if (isWorktreeReviewActive()) {
    const shown = await tryShowWorktreeChangePreview(view, previewPath, opts);
    if (shown) return;
  }

  const live = typeof getActiveLiveWrite === 'function' ? getActiveLiveWrite() : null;
  if (live && live.status === 'writing' && liveMatchesPath(live, previewPath)) {
    setChangesPreviewPath(previewPath);
    if (typeof syncLiveWritePreview === 'function') {
      syncLiveWritePreview({ live, incremental: true });
    }
    return;
  }

  if (incremental && isChangesDiffPreviewMounted(previewPath) && !(opts && opts.remountInline)) {
    setChangesPreviewPath(previewPath);
    const mountedDiff = mergeSessionArtifactDiff(art);
    if (mountedDiff && toolDiffHasBody(mountedDiff) && typeof renderChangesPaneDiffPreview === 'function') {
      await renderChangesPaneDiffPreview(view, { ...art, diff: mountedDiff }, { ...opts, incremental: true });
    }
    return;
  }

  setChangesPreviewPath(previewPath);

  let diff = mergeSessionArtifactDiff(art);
  if (diff && toolDiffHasBody(diff)) {
    if (typeof renderChangesPaneDiffPreview === 'function') {
      await renderChangesPaneDiffPreview(view, { ...art, diff }, opts);
    } else {
      renderSessionDiffSideBySide(view, { ...art, diff });
    }
    return;
  }

  if (diff && (Number(diff.added) || Number(diff.removed))) {
    if (!isChangesDiffPreviewMounted(previewPath)) {
      view.innerHTML = '<div class="artifacts-empty">加载 diff…</div>';
    }
    try {
      if (typeof readArtifactFileText === 'function') {
        const afterText = await readArtifactFileText(previewPath);
        if (changesPreviewPath && !pathsMatchArtifact(changesPreviewPath, previewPath)) return;
        const fullDiff = {
          ...diff,
          beforeText: pickDiffDisplayText(diff, 'before') || '',
          afterText,
          created: !pickDiffDisplayText(diff, 'before'),
          added: Number(diff.added) || afterText.split('\n').length,
          removed: Number(diff.removed) || 0
        };
        if (typeof renderChangesPaneDiffPreview === 'function') {
          await renderChangesPaneDiffPreview(view, { ...art, diff: fullDiff }, opts);
        } else {
          renderSessionDiffSideBySide(view, { ...art, diff: fullDiff });
        }
      }
    } catch (e) {
      if (changesPreviewPath && !pathsMatchArtifact(changesPreviewPath, previewPath)) return;
      const wtShown = await tryShowWorktreeChangePreview(view, previewPath, opts);
      if (wtShown) return;
      const retryDiff = mergeSessionArtifactDiff(art);
      if (retryDiff && toolDiffHasBody(retryDiff) && typeof renderChangesPaneDiffPreview === 'function') {
        await renderChangesPaneDiffPreview(view, { ...art, diff: retryDiff }, opts);
        return;
      }
      view.innerHTML =
        '<div class="artifacts-empty">无法加载 diff：' + escapeHtml(e.message || String(e)) + '</div>';
    }
    return;
  }

  view.innerHTML = '<div class="artifacts-empty">无 diff 内容</div>';
}

function findChangesListRow(list, filePath) {
  if (!list || !filePath) return null;
  const target = workspaceArtifactPath(filePath);
  for (const el of list.querySelectorAll('.artifacts-file-item')) {
    const p = el.getAttribute('data-change-path') || el.title || '';
    if (pathsMatchArtifact(p, target)) return el;
  }
  return null;
}

function bindChangesListRowClick(row, filePath) {
  row.addEventListener('click', function () {
    const list = document.getElementById('changes-file-list');
    const view = document.getElementById('changes-file-view');
    if (list) {
      list.querySelectorAll('.artifacts-file-item').forEach((el) => el.classList.remove('active'));
    }
    row.classList.add('active');
    if (!view) return;
    let art =
      typeof mergeArtifactRows === 'function'
        ? mergeArtifactRows().find((r) => pathsMatchArtifact(r.path, filePath))
        : null;
    if (!art) art = { path: workspaceArtifactPath(filePath), diff: null };
    const live = typeof getActiveLiveWrite === 'function' ? getActiveLiveWrite() : null;
    if (live && liveMatchesPath(live, filePath) && typeof enrichLiveWriteDiffStats === 'function') {
      art = { ...art, diff: enrichLiveWriteDiffStats(live) };
    }
    void showSessionChangePreview(view, art);
  });
}

function createChangesListRow(filePath, diffStats) {
  const path = workspaceArtifactPath(filePath);
  const name = path.replace(/\\/g, '/').split('/').pop() || path;
  const diffHtml =
    typeof formatArtifactDiffHtml === 'function' ? formatArtifactDiffHtml(diffStats) : '';
  const row = document.createElement('div');
  row.className = 'artifacts-file-item';
  row.setAttribute('data-change-path', path);
  row.title = path;
  row.innerHTML =
    '<span class="artifacts-file-icon">' +
    flatFileIconSvg(16) +
    '</span><span class="artifacts-file-name">' +
    escapeHtml(name) +
    '</span>' +
    (diffHtml || '');
  bindChangesListRowClick(row, path);
  return row;
}

function updateChangesListRowBadge(row, diffStats, opts) {
  if (!row || !diffStats) return;
  const badge = row.querySelector('.artifacts-file-diff');
  const nextAdded = Number(diffStats.added) || 0;
  const nextRemoved = Number(diffStats.removed) || 0;
  if (badge) {
    const m = badge.textContent.match(/\+(\d+)\s*-(\d+)/);
    if (m && Number(m[1]) === nextAdded && Number(m[2]) === nextRemoved) {
      if (opts && opts.live) {
        badge.classList.add('is-live-count');
      }
      return;
    }
  }
  if (typeof upsertArtifactFileDiffBadge === 'function') {
    upsertArtifactFileDiffBadge(row, diffStats);
  }
  const updatedBadge = row.querySelector('.artifacts-file-diff');
  if (updatedBadge && opts && opts.live) {
    updatedBadge.classList.add('is-live-count');
    updatedBadge.classList.remove('is-live-count-pulse');
    void updatedBadge.offsetWidth;
    updatedBadge.classList.add('is-live-count-pulse');
  }
}

/** 写入过程中：确保变更列表有对应行，并实时刷新 +/- 数字（Plan worktree 待审时不注入 trace 行） */
function syncChangesListLiveRows() {
  const list = document.getElementById('changes-file-list');
  if (!list) return;
  if (isWorktreeReviewActive()) return;

  const live = typeof getActiveLiveWrite === 'function' ? getActiveLiveWrite() : null;
  const roundChanges =
    typeof getLastRoundFileChanges === 'function' ? getLastRoundFileChanges() : [];
  const targets = new Map();

  if (live && (live.path || live.canonicalPath)) {
    const path = live.canonicalPath || workspaceArtifactPath(live.path);
    const stats =
      typeof enrichLiveWriteDiffStats === 'function' ? enrichLiveWriteDiffStats(live) : live.diff;
    targets.set(path, {
      path,
      stats: stats ? { added: Number(stats.added) || 0, removed: Number(stats.removed) || 0 } : null,
      writing: live.status === 'writing',
      done: live.status === 'done',
      live: true
    });
  }

  for (const ch of roundChanges) {
    if (!ch || !ch.path) continue;
    const key = workspaceArtifactPath(ch.path);
    if (targets.has(key) && targets.get(key).live) continue;
    if (ch.added == null && ch.removed == null && !ch.pending) continue;
    targets.set(key, {
      path: ch.path,
      stats: { added: Number(ch.added) || 0, removed: Number(ch.removed) || 0 },
      writing: !!ch.pending,
      done: !ch.pending,
      live: false
    });
  }

  if (!targets.size) return;

  const empty = list.querySelector('.artifacts-empty');
  if (empty) empty.remove();

  for (const info of targets.values()) {
    let row = findChangesListRow(list, info.path);
    if (!row) {
      row = createChangesListRow(info.path, info.stats);
      list.insertBefore(row, list.firstChild);
    } else if (info.stats) {
      updateChangesListRowBadge(row, info.stats, { live: info.live && info.writing });
    }
    row.classList.toggle('is-writing', !!info.writing);
    row.classList.toggle('is-write-done', !!info.done && !info.writing);
    if (info.writing && info.live) row.classList.add('active');
  }
}

function getSessionChangeRows() {
  return typeof mergeArtifactRows === 'function'
    ? mergeArtifactRows().filter(function (a) {
        if (!a || !a.path) return false;
        if (typeof isPlausibleArtifactPath === 'function' && !isPlausibleArtifactPath(a.path)) {
          return false;
        }
        return a.diff || a.source === 'trace';
      })
    : [];
}

function syncSessionChangesSummary(summary, rows) {
  if (!summary) return;
  let added = 0;
  let removed = 0;
  for (const r of rows || []) {
    const d = r.diff || {};
    added += Number(d.added) || 0;
    removed += Number(d.removed) || 0;
  }
  summary.textContent = rows.length
    ? `${rows.length} 个文件 · +${added} -${removed}`
    : '本会话暂无文件变更';
}

function resolveSessionRowDiffStats(art) {
  const live = typeof getActiveLiveWrite === 'function' ? getActiveLiveWrite() : null;
  if (
    live &&
    live.status === 'writing' &&
    liveMatchesPath(live, art.path) &&
    typeof enrichLiveWriteDiffStats === 'function'
  ) {
    return enrichLiveWriteDiffStats(live);
  }
  return art.diff;
}

function listShowsPlanPreviewRows(list) {
  return !!(list && list.querySelector('.changes-plan-preview-item, [data-plan-path]'));
}

function syncSessionChangesListInPlace(list, rows) {
  if (!list || !Array.isArray(rows) || !rows.length) return false;
  if (listShowsPlanPreviewRows(list)) return false;

  const existingRows = list.querySelectorAll('.artifacts-file-item[data-change-path]');
  if (existingRows.length !== rows.length) return false;

  for (const art of rows) {
    if (!findChangesListRow(list, art.path)) return false;
  }

  const live = typeof getActiveLiveWrite === 'function' ? getActiveLiveWrite() : null;
  for (const art of rows) {
    const row = findChangesListRow(list, art.path);
    if (!row) continue;
    const diffStats = resolveSessionRowDiffStats(art);
    if (diffStats) {
      const isLiveFile = live && liveMatchesPath(live, art.path);
      updateChangesListRowBadge(row, diffStats, {
        live: !!(isLiveFile && live.status === 'writing')
      });
    }
    const isLiveFile = live && liveMatchesPath(live, art.path);
    row.classList.toggle('is-writing', !!(isLiveFile && live.status === 'writing'));
    row.classList.toggle('is-write-done', !!(isLiveFile && live.status === 'done'));
  }
  return true;
}

function patchSessionChangesPreview(view, rows) {
  if (!view || !rows.length) return;
  const list = document.getElementById('changes-file-list');
  const live = typeof getActiveLiveWrite === 'function' ? getActiveLiveWrite() : null;

  if (live && (live.path || live.canonicalPath) && typeof syncLiveWritePreview === 'function') {
    syncLiveWritePreview({ live, incremental: true, forceRemount: false });
    return;
  }

  const previewPath = changesPreviewPath || '';
  if (previewPath && isChangesDiffPreviewMounted(previewPath)) {
    const art = rows.find((r) => pathsMatchArtifact(r.path, previewPath));
    if (art) {
      void showSessionChangePreview(view, art, { incremental: true, remountInline: true });
      return;
    }
  }

  if (list) autoPreviewSessionChange(list, view, rows);
}

function patchSessionChangesPane(list, view, summary) {
  hideWorktreeReviewToolbar(summary);
  const rows = getSessionChangeRows();
  syncSessionChangesSummary(summary, rows);

  if (!rows.length) {
    const hasRows = list.querySelector('.artifacts-file-item[data-change-path]');
    if (hasRows || listShowsPlanPreviewRows(list)) {
      renderSessionArtifactChanges(list, view, summary);
      return;
    }
    if (view && !view.querySelector('.artifacts-diff-shell')) {
      const empty = view.querySelector('.artifacts-empty');
      if (!empty) {
        view.innerHTML = '<div class="artifacts-empty">选择文件查看 diff 摘要</div>';
      }
    }
    setChangesPreviewPath('');
    return;
  }

  if (listShowsPlanPreviewRows(list)) {
    renderSessionArtifactChanges(list, view, summary);
    return;
  }

  if (syncSessionChangesListInPlace(list, rows)) {
    patchSessionChangesPreview(view, rows);
    return;
  }

  renderSessionArtifactChanges(list, view, summary);
}

async function patchChangesPaneAsync() {
  const list = document.getElementById('changes-file-list');
  const view = document.getElementById('changes-file-view');
  const summary = document.getElementById('changes-summary');
  if (!list) return;

  let worktreeReview = null;
  try {
    worktreeReview = await loadWorktreeReviewIfNeeded();
    if (worktreeReview && isWorktreeReviewActive()) {
      await renderWorktreeReviewPane(worktreeReview, list, view, summary);
      syncLiveWriteAfterChangesRender();
      return;
    }
  } catch (err) {
    console.warn('patchChangesPane worktree review failed:', err);
  }

  if (shouldShowPlanPreviewPane()) {
    const pending =
      typeof window.getPendingWorktreeApply === 'function' ? window.getPendingWorktreeApply() : null;
    if (pending && typeof window.renderPlanPreviewPane === 'function') {
      window.renderPlanPreviewPane(pending, list, view, summary);
      syncLiveWriteAfterChangesRender();
      return;
    }
  }

  patchSessionChangesPane(list, view, summary);
  syncLiveWriteAfterChangesRender();
}

function patchChangesPane() {
  void patchChangesPaneAsync();
}

function autoPreviewSessionChange(list, view, rows) {
  if (!view || !rows.length) return;
  const live = typeof getActiveLiveWrite === 'function' ? getActiveLiveWrite() : null;
  let target = rows[0];
  if (live) {
    target = rows.find((r) => liveMatchesPath(live, r.path)) || target;
  }
  list.querySelectorAll('.artifacts-file-item').forEach((el) => el.classList.remove('active'));
  const rowEl = [...list.querySelectorAll('.artifacts-file-item')].find((el) => {
    const p = el.getAttribute('data-change-path') || el.title || '';
    return pathsMatchArtifact(p, target.path);
  });
  if (rowEl) rowEl.classList.add('active');
  void showSessionChangePreview(view, target, { incremental: true });
}

function renderSessionArtifactChanges(list, view, summary) {
  hideWorktreeReviewToolbar(summary);

  const rows = getSessionChangeRows();

  syncSessionChangesSummary(summary, rows);

  list.innerHTML = '';
  if (!rows.length) {
    list.innerHTML = '<div class="artifacts-empty">Agent 修改的文件会显示在这里</div>';
    if (view && !view.querySelector('.artifacts-diff-shell')) {
      view.innerHTML = '<div class="artifacts-empty">选择文件查看 diff 摘要</div>';
    }
    setChangesPreviewPath('');
    return;
  }

  for (const art of rows) {
    const path = workspaceArtifactPath(art.path);
    const name = art.relativePath || path.replace(/\\/g, '/').split('/').pop() || path;
    const diffStats = resolveSessionRowDiffStats(art);
    const diff = diffStats
      ? ' <span class="artifacts-file-diff">+' +
        escapeHtml(String(diffStats.added || 0)) +
        ' -' +
        escapeHtml(String(diffStats.removed || 0)) +
        '</span>'
      : '';
    const row = document.createElement('div');
    row.className = 'artifacts-file-item';
    row.setAttribute('data-change-path', path);
    row.innerHTML =
      '<span class="artifacts-file-icon">' +
      flatFileIconSvg(16) +
      '</span><span class="artifacts-file-name">' +
      escapeHtml(name) +
      '</span>' +
      diff;
    row.title = path;
    row.addEventListener('click', function () {
      const items = list.querySelectorAll('.artifacts-file-item');
      for (let j = 0; j < items.length; j++) items[j].classList.remove('active');
      row.classList.add('active');
      if (view) void showSessionChangePreview(view, { ...art, path });
    });
    list.appendChild(row);
  }

  if (view && rows.length) {
    autoPreviewSessionChange(list, view, rows);
  } else if (view && !view.querySelector('.artifacts-diff-shell')) {
    view.innerHTML = '<div class="artifacts-empty">选择文件查看 diff</div>';
  }
}

function renderChangesPane(opts) {
  if (opts && opts.soft) {
    patchChangesPane();
    return;
  }
  void renderChangesPaneAsync();
}

async function renderChangesPaneAsync() {
  const list = document.getElementById('changes-file-list');
  const view = document.getElementById('changes-file-view');
  const summary = document.getElementById('changes-summary');
  if (!list) return;

  let worktreeReview = null;
  try {
    worktreeReview = await loadWorktreeReviewIfNeeded();
    if (worktreeReview && isWorktreeReviewActive()) {
      await renderWorktreeReviewPane(worktreeReview, list, view, summary);
      syncLiveWriteAfterChangesRender();
      return;
    }
  } catch (err) {
    console.warn('renderChangesPane worktree review failed:', err);
  }

  if (shouldShowPlanPreviewPane()) {
    const pending =
      typeof window.getPendingWorktreeApply === 'function' ? window.getPendingWorktreeApply() : null;
    if (pending && typeof window.renderPlanPreviewPane === 'function') {
      window.renderPlanPreviewPane(pending, list, view, summary);
      syncLiveWriteAfterChangesRender();
      return;
    }
  }

  renderSessionArtifactChanges(list, view, summary);
  syncLiveWriteAfterChangesRender();
}

function syncLiveWriteAfterChangesRender() {
  if (typeof getSidePanelTab === 'function' && getSidePanelTab() !== 'changes') return;
  if (typeof syncChangesListLiveRows === 'function') syncChangesListLiveRows();
  if (typeof applyLiveWriteFileListMarks === 'function') applyLiveWriteFileListMarks();
}

window.setChangesPreviewPath = setChangesPreviewPath;
window.syncChangesListLiveRows = syncChangesListLiveRows;
window.isChangesDiffPreviewMounted = isChangesDiffPreviewMounted;
window.patchChangesPane = patchChangesPane;
window.showSessionChangePreview = showSessionChangePreview;
window.renderChangesPane = renderChangesPane;
window.showChangesDiffToolbar = showChangesDiffToolbar;
window.setWorktreeReviewControlsEnabled = setWorktreeReviewControlsEnabled;
window.readFallbackArtifactText = readFallbackArtifactText;
