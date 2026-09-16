/* global gatewayCall, gwState, isSidePanelOpen, openSidePanel, setSidePanelTab, getSidePanelTab, flatFolderIconSvg, flatFileIconSvg, flatDirUpIconSvg, revealMonacoLine, refreshWorkspaceProblemsPanel, startWorkspaceDiagnosticsScan, getActiveLiveWrite, isLiveWritePath, normWritePath, pathsMatch, syncLiveWriteFromTrace, clearLiveWrite, applyLiveWriteFileListMarks, refreshLiveWriteArtifactPreview, createMonacoArtifactDiffEditor, updateMonacoArtifactDiffEditor, disposeMonacoArtifactEditor, createMonacoArtifactEditor, canUseMonacoEditor, getAgentLimits, pickDiffDisplayText, getLastTraceEntryFileChanges, enrichLiveWriteDiffStats, updateProblemsPanel, renderChangesPane, lastAgentDisplayedTrace, computeLineDiffStats, toolDiffHasBody, formatInlineUnifiedDiffHtml, escapeHtml, isEditToolName, editToolFilePath, canonicalArtifactPathFromTool, resolveToolDiffBody, resolveArtifactDiffFromTrace, mammoth, XLSX, withSessionRpcScope, isMonacoAfterOnlyEditorMounted, isMonacoMountInFlight, isMonacoArtifactEditorMounted, updateMonacoArtifactEditorText, currentSessionId, resolveSessionWorkspacePathSync, resolveSessionWorkspacePathForRpc, readFallbackArtifactText */
'use strict';


function ensureSessionArtifactForLiveWrite(filePath, meta) {
  trackArtifact(filePath, {
    ...(meta || {}),
    countTotals: false,
    skipUiFlush: true,
    sessionId: meta && meta.sessionId != null ? meta.sessionId : resolveArtifactSessionId()
  });
}

function highlightLiveWriteInThinking(live) {
  document.querySelectorAll('.msg-thinking-tools li.is-live-write-focus').forEach((el) => {
    el.classList.remove('is-live-write-focus');
  });
  if (!live || !live.norm) return;
  const nodes = document.querySelectorAll('.msg-thinking-tools li[data-tool-path]');
  let target = null;
  for (const el of nodes) {
    if (el.dataset.toolPath === live.norm) target = el;
  }
  if (!target) return;
  target.classList.add('is-live-write-focus');
}

function updateLiveWriteDiffChrome(viewEl, live) {
  if (!viewEl || !live) return;
  const badge = viewEl.querySelector('.artifacts-live-write-badge');
  const note = viewEl.querySelector('.artifacts-live-write-note');
  if (badge) {
    badge.className =
      'artifacts-live-write-badge' + (live.status === 'writing' ? ' is-writing' : ' is-done');
    badge.textContent = live.status === 'writing' ? '写入中…' : '已写入';
  }
  if (note) {
    note.textContent = liveWriteDiffStatusText(live);
  }
}

function liveWriteHasBeforeContent(live) {
  if (!live) return false;
  if (live.diff && live.diff.created) return false;
  const before =
    typeof liveWriteDiffText === 'function' ? liveWriteDiffText(live, 'before') : String(live.beforeText || '');
  return !!String(before || '').length;
}

function liveWriteDiffStatusText(live) {
  if (live && live.status === 'writing') {
    return '仅显示改后内容 · 完成后显示增删对比';
  }
  const hasBefore = liveWriteHasBeforeContent(live);
  if (!hasBefore) {
    return '新建 / 无改前内容 · 整文件为新增';
  }
  if (live && live.reviewMode) {
    return '内联增删对比 · 绿增红删';
  }
  return '改前 / 改后对比 · 绿增红删';
}

function resolveLiveWritePreviewTab() {
  const tab = typeof getSidePanelTab === 'function' ? getSidePanelTab() : 'changes';
  return tab === 'files' ? 'files' : 'changes';
}

function liveWritePreviewViewEl(tab) {
  return tab === 'changes'
    ? document.getElementById('changes-file-view')
    : document.getElementById('artifacts-file-view');
}

function renderLiveWritePreviewFollowHint(viewEl, activeTab) {
  if (!viewEl) return;
  const page = activeTab === 'changes' ? '变更' : '文件';
  viewEl.innerHTML =
    '<div class="artifacts-empty live-write-preview-follow-hint">' +
    `<p>实时预览正在「${page}」页</p>` +
    `<p class="live-write-preview-follow-sub">切换侧栏「${page}」查看写入动画</p>` +
    '</div>';
}

function ensureLiveWriteFileListRow(live) {
  const list = document.getElementById('artifacts-file-list');
  if (!list || !live?.path) return;
  let found = false;
  list.querySelectorAll('.artifacts-file-item[data-file-path]').forEach((el) => {
    const p = el.getAttribute('data-file-path') || '';
    if (artifactPathsMatch(p, live.path)) found = true;
  });
  if (found) return;
  const name = String(live.path).replace(/\\/g, '/').split('/').pop() || live.path;
  renderArtifactRow(list, document.getElementById('artifacts-file-view'), {
    kind: 'file',
    name,
    path: live.path,
    relativePath: name,
    ts: live.ts || Date.now(),
    diff: live.diff,
    source: 'trace',
    virtual: true
  });
}

function isChangesFileViewEl(viewEl) {
  return !!(viewEl && viewEl.id === 'changes-file-view');
}

function shouldHideChangesDiffHead(viewEl, opts) {
  return !!(opts && opts.hideDiffHead) || isChangesFileViewEl(viewEl);
}

var liveMonacoDiffPaintTimer = null;
/** @type {{ viewEl: HTMLElement, live: object, editorOpts: object } | null} */
var liveMonacoDiffPaintPending = null;
var liveAfterEditorPaintTimer = null;
/** @type {{ viewEl: HTMLElement, filePath: string, live: object, opts: object } | null} */
var liveAfterEditorPaintPending = null;

function unifiedDiffLiveSig(beforeText, afterText) {
  const before = String(beforeText ?? '');
  const after = String(afterText ?? '');
  return `${before.length}:${after.length}:${after.slice(-96)}`;
}

/** Append/update + lines in unified HTML diff without replacing the container. */
function patchUnifiedDiffInPlace(container, beforeText, afterText) {
  if (!container) return false;
  const before = String(beforeText ?? '');
  const after = String(afterText ?? '');
  const sig = unifiedDiffLiveSig(before, after);
  if (container.dataset.liveDiffSig === sig) return true;

  if (!before.trim()) {
    const lines = after.split('\n');
    const nodes = container.querySelectorAll('.diff-line.diff-add');
    for (let i = 0; i < lines.length; i++) {
      const expected = '+' + lines[i];
      if (i < nodes.length) {
        if (nodes[i].textContent !== expected) nodes[i].textContent = expected;
      } else {
        const div = document.createElement('div');
        div.className = 'diff-line diff-add';
        div.textContent = expected;
        container.appendChild(div);
      }
    }
    while (container.querySelectorAll('.diff-line.diff-add').length > lines.length) {
      container.lastElementChild?.remove();
    }
    container.dataset.liveDiffSig = sig;
    return true;
  }

  if (typeof formatInlineUnifiedDiffHtml === 'function') {
    const nextHtml = formatInlineUnifiedDiffHtml(before, after, { escapeHtml });
    if (container.innerHTML !== nextHtml) container.innerHTML = nextHtml;
    container.dataset.liveDiffSig = sig;
    return true;
  }
  return false;
}

function patchLargeLiveWriteDiffInView(viewEl, filePath, live, opts) {
  if (!viewEl || !live) return Promise.resolve();
  const before = liveWriteDiffText(live, 'before');
  const after = liveWriteDiffText(live, 'after');
  const unified = viewEl.querySelector('.changes-unified-diff');
  if (unified) {
    patchUnifiedDiffInPlace(unified, before, after);
    updateLiveWriteDiffChrome(viewEl, live);
    return Promise.resolve();
  }
  const afterPre = viewEl.querySelector('.agents-md-diff-pre');
  if (afterPre && !viewEl.querySelector('.agents-md-diff-grid')) {
    const next = trimLiveDiffPreview(after) || '（空）';
    if (afterPre.textContent !== next) afterPre.textContent = next;
    updateLiveWriteDiffChrome(viewEl, live);
    return Promise.resolve();
  }
  renderLargeLiveWriteDiff(viewEl, filePath, live, { ...opts, incremental: false });
  return Promise.resolve();
}

function scheduleLiveMonacoDiffUpdate(viewEl, live, editorOpts) {
  liveMonacoDiffPaintPending = { viewEl, live, editorOpts: { ...editorOpts, liveWriting: true } };
  if (liveMonacoDiffPaintTimer) clearTimeout(liveMonacoDiffPaintTimer);
  liveMonacoDiffPaintTimer = setTimeout(() => {
    liveMonacoDiffPaintTimer = null;
    const pending = liveMonacoDiffPaintPending;
    liveMonacoDiffPaintPending = null;
    if (!pending) return;
    updateLiveWriteDiffChrome(pending.viewEl, pending.live);
    void updateMonacoArtifactDiffEditor(pending.editorOpts).catch(() => {});
  }, LIVE_DIFF_PAINT_MS);
}

function scheduleLiveAfterEditorUpdate(viewEl, filePath, live, opts) {
  liveAfterEditorPaintPending = { viewEl, filePath, live, opts: opts || {} };
  if (liveAfterEditorPaintTimer) clearTimeout(liveAfterEditorPaintTimer);
  liveAfterEditorPaintTimer = setTimeout(() => {
    liveAfterEditorPaintTimer = null;
    const pending = liveAfterEditorPaintPending;
    liveAfterEditorPaintPending = null;
    if (!pending) return;
    updateLiveWriteDiffChrome(pending.viewEl, pending.live);
    const afterText =
      typeof liveWriteDiffText === 'function' ? liveWriteDiffText(pending.live, 'after') : '';
    if (typeof updateMonacoArtifactEditorText === 'function') {
      updateMonacoArtifactEditorText(pending.filePath, afterText, {
        focusLine: pending.live.focusLine,
        appendOnly: true
      });
    }
  }, LIVE_DIFF_PAINT_MS);
}

/** 超大文件写入中：单栏纯文本，避免 DiffEditor / unified HTML 重算 */
function renderLiveWriteAfterOnlyHtmlInView(viewEl, filePath, live, opts) {
  const afterText =
    typeof liveWriteDiffText === 'function' ? liveWriteDiffText(live, 'after') : String(live.afterText || '');
  const existingPre = viewEl.querySelector('.artifacts-after-only-shell .agents-md-diff-pre');
  if (!opts?.forceRemount && existingPre && opts?.incremental !== false) {
    const prev = existingPre.textContent || '';
    const next = trimLiveDiffPreview(afterText) || '（空）';
    if (next === prev) {
      updateLiveWriteDiffChrome(viewEl, live);
      return Promise.resolve();
    }
    if (next.startsWith(prev) || !prev) {
      existingPre.textContent = next;
      updateLiveWriteDiffChrome(viewEl, live);
      return Promise.resolve();
    }
    // 非追加：保持安静，写完再整量刷新
    updateLiveWriteDiffChrome(viewEl, live);
    return Promise.resolve();
  }

  viewEl.innerHTML = '';
  const hideDiffHead = shouldHideChangesDiffHead(viewEl, opts);
  const shell = document.createElement('div');
  shell.className = 'artifacts-editor-shell artifacts-diff-shell artifacts-after-only-shell';
  if (!hideDiffHead) {
    const head = document.createElement('div');
    head.className = 'artifacts-editor-head artifacts-diff-head';
    const pathEl = document.createElement('span');
    pathEl.className = 'artifacts-editor-path';
    pathEl.textContent = filePath;
    pathEl.title = filePath;
    const badge = document.createElement('span');
    badge.className = 'artifacts-live-write-badge is-writing';
    badge.textContent = '写入中…';
    const note = document.createElement('span');
    note.className = 'artifacts-live-write-note';
    note.textContent = liveWriteDiffStatusText(live);
    head.append(pathEl, badge, note);
    shell.appendChild(head);
  }
  const pre = document.createElement('pre');
  pre.className = 'agents-md-diff-pre artifacts-after-only-pre agent-scroll';
  pre.textContent = trimLiveDiffPreview(afterText) || '（空）';
  shell.appendChild(pre);
  viewEl.appendChild(shell);
  return Promise.resolve();
}

async function renderLiveWriteAfterOnlyInView(viewEl, filePath, live, opts) {
  const afterText =
    typeof liveWriteDiffText === 'function' ? liveWriteDiffText(live, 'after') : String(live.afterText || '');
  if (
    typeof shouldUseMonacoAfterOnlyPreview === 'function' &&
    !shouldUseMonacoAfterOnlyPreview(live)
  ) {
    return renderLiveWriteAfterOnlyHtmlInView(viewEl, filePath, live, opts);
  }

  const existingHost = viewEl.querySelector('.artifacts-monaco-after-host');
  const afterOnlyShell = viewEl.querySelector('.artifacts-after-only-shell');
  const mounted =
    typeof isMonacoAfterOnlyEditorMounted === 'function'
      ? isMonacoAfterOnlyEditorMounted(filePath)
      : typeof isMonacoArtifactEditorMounted === 'function' &&
        isMonacoArtifactEditorMounted(filePath) &&
        !!existingHost;
  const mounting =
    typeof isMonacoMountInFlight === 'function' && isMonacoMountInFlight() && !!existingHost;
  const canIncremental =
    !opts?.forceRemount &&
    opts?.incremental !== false &&
    existingHost &&
    afterOnlyShell &&
    (mounted || mounting);

  // 挂载中：只排队文本，禁止 dispose 重建
  if (canIncremental) {
    scheduleLiveAfterEditorUpdate(viewEl, filePath, live, opts);
    return;
  }

  if (typeof disposeMonacoArtifactEditor === 'function') {
    await disposeMonacoArtifactEditor();
  }
  viewEl.innerHTML = '';
  const hideDiffHead = shouldHideChangesDiffHead(viewEl, opts);
  const shell = document.createElement('div');
  shell.className = 'artifacts-editor-shell artifacts-diff-shell artifacts-after-only-shell';
  if (!hideDiffHead) {
    const head = document.createElement('div');
    head.className = 'artifacts-editor-head artifacts-diff-head';
    const pathEl = document.createElement('span');
    pathEl.className = 'artifacts-editor-path';
    pathEl.textContent = filePath;
    pathEl.title = filePath;
    const badge = document.createElement('span');
    badge.className = 'artifacts-live-write-badge is-writing';
    badge.textContent = '写入中…';
    const note = document.createElement('span');
    note.className = 'artifacts-live-write-note';
    note.textContent = liveWriteDiffStatusText(live);
    head.append(pathEl, badge, note);
    shell.appendChild(head);
  }
  const host = document.createElement('div');
  host.className = 'artifacts-monaco-after-host';
  shell.appendChild(host);
  viewEl.appendChild(shell);
  // 标记已占用，避免挂载未完成时 forceRemount 风暴
  liveWritePreviewMountedTab = resolveLiveWritePreviewTab();
  const handle = await createMonacoArtifactEditor(host, {
    filePath,
    text: afterText,
    focusLine: live.status === 'writing' ? live.focusLine : undefined
  });
  // 挂载期间积压的最新 after 文本（仅 append）
  if (liveAfterEditorPaintPending && liveAfterEditorPaintPending.filePath) {
    const pending = liveAfterEditorPaintPending;
    const pendingAfter =
      typeof liveWriteDiffText === 'function' ? liveWriteDiffText(pending.live, 'after') : '';
    if (pendingAfter && typeof updateMonacoArtifactEditorText === 'function') {
      updateMonacoArtifactEditorText(filePath, pendingAfter, {
        focusLine: pending.live?.focusLine,
        appendOnly: true
      });
    }
  }
  return handle;
}

/** 折叠内联：不用 Monaco DiffEditor（内联 diff 重算会导致文字闪），写入用单栏 Monaco，完成用 HTML patch */
function renderCollapsedReviewDiffInView(viewEl, filePath, live, opts) {
  liveWritePreviewMountedTab = 'changes';
  const incremental = !opts?.forceRemount && opts?.incremental !== false;
  if (live.status === 'writing') {
    return renderLiveWriteAfterOnlyInView(viewEl, filePath, live, opts);
  }
  renderLargeLiveWriteDiff(viewEl, filePath, live, {
    reviewMode: true,
    hideDiffHead: shouldHideChangesDiffHead(viewEl, opts),
    incremental
  });
  return Promise.resolve();
}

async function renderLiveWriteDiffInView(viewEl, filePath, live, opts) {
  if (!viewEl || !live) return;
  const reviewMode = !!(opts && opts.reviewMode);
  live = { ...live, reviewMode: reviewMode || live.reviewMode };

  // 写入中、以及文件面板：只用 after-only，禁止 DiffEditor。
  // 文件编辑态挂内联 DiffEditor 时，字符级替换会在新增行上叠 Monaco 默认大红底。
  if (live.status === 'writing' || !reviewMode) {
    return renderLiveWriteAfterOnlyInView(viewEl, filePath, live, opts);
  }

  // 变更页 review：内联增删对比，禁止 DiffEditor
  return renderCollapsedReviewDiffInView(viewEl, filePath, live, opts);
}

function setLiveWritePanelChrome(live) {
  const writing = !!(live && live.status === 'writing');
  const filesView = document.getElementById('artifacts-file-view');
  const changesView = document.getElementById('changes-file-view');
  if (filesView) filesView.classList.toggle('is-live-writing', writing);
  if (changesView) changesView.classList.toggle('is-live-writing', writing);
}

function viewHasPlainMonacoEditor(viewEl) {
  return !!(
    viewEl &&
    viewEl.querySelector('.artifacts-monaco-host') &&
    !viewEl.querySelector('.artifacts-monaco-diff-host, .artifacts-monaco-after-host')
  );
}

function syncLiveWritePreview(opts) {
  const live =
    opts && opts.live
      ? opts.live
      : typeof getActiveLiveWrite === 'function'
        ? getActiveLiveWrite()
        : null;

  if (!live || !live.path) {
    liveWritePreviewMountedTab = null;
    setLiveWritePanelChrome(null);
    return;
  }
  setLiveWritePanelChrome(live);
  if (typeof isSidePanelOpen === 'function' && !isSidePanelOpen()) return;

  selectedArtifactPath = live.path;
  if (typeof ensureSessionArtifactForLiveWrite === 'function') {
    ensureSessionArtifactForLiveWrite(live.path, {
      diff:
        (typeof enrichLiveWriteDiffStats === 'function' ? enrichLiveWriteDiffStats(live) : null) ||
        live.diff ||
        null
    });
  }
  if (typeof applyLiveWriteFileListMarks === 'function') applyLiveWriteFileListMarks();

  const activeTab = resolveLiveWritePreviewTab();
  const inactiveTab = activeTab === 'changes' ? 'files' : 'changes';
  const activeView = liveWritePreviewViewEl(activeTab);
  const inactiveView = liveWritePreviewViewEl(inactiveTab);
  const forceRemount =
    !!(opts && opts.forceRemount) ||
    liveWritePreviewMountedTab !== activeTab ||
    (activeTab === 'files' &&
      live.status === 'writing' &&
      viewHasPlainMonacoEditor(activeView)) ||
    // 变更页写完：拆掉 after-only，挂正式 diff / HTML。文件页保持正文编辑器。
    (live.status === 'done' &&
      activeTab === 'changes' &&
      !!activeView?.querySelector('.artifacts-after-only-shell'));

  if (inactiveView && inactiveView !== activeView) {
    const mountedHere =
      liveWritePreviewMountedTab === inactiveTab ||
      inactiveView.querySelector('.artifacts-diff-shell');
    if (mountedHere || live.status === 'writing') {
      if (!inactiveView.querySelector('.artifacts-diff-shell')) {
        renderLiveWritePreviewFollowHint(inactiveView, activeTab);
      }
    }
  }

  if (!activeView) return;
  if (activeTab === 'files') ensureLiveWriteFileListRow(live);

  if (activeTab === 'files' && live.status !== 'writing') {
    const afterOnly = activeView.querySelector('.artifacts-after-only-shell');
    if (afterOnly) {
      updateLiveWriteDiffChrome(activeView, live);
      liveWritePreviewMountedTab = 'files';
      return;
    }
    if (viewHasPlainMonacoEditor(activeView) && !forceRemount) {
      liveWritePreviewMountedTab = 'files';
      return;
    }
    loadArtifactContent(live.path, activeView, { force: true });
    liveWritePreviewMountedTab = 'files';
    return;
  }

  renderLiveWriteDiffInView(activeView, live.path, live, {
    incremental: !forceRemount && opts?.incremental !== false,
    forceRemount,
    revealLastChange: !!(opts && opts.revealLastChange) || live.status === 'done',
    focusLine: live.status === 'writing' ? live.focusLine : undefined,
    reviewMode: activeTab === 'changes'
  }).then(function () {
    if (activeTab === 'changes' && typeof window.setChangesPreviewPath === 'function') {
      window.setChangesPreviewPath(live.path);
    }
    liveWritePreviewMountedTab = activeTab;
  });
}

function migrateLiveWritePreviewOnTabSwitch(tab) {
  if (tab !== 'files' && tab !== 'changes') return;
  const live = typeof getActiveLiveWrite === 'function' ? getActiveLiveWrite() : null;
  if (!live || typeof isSidePanelOpen !== 'function' || !isSidePanelOpen()) return;
  const targetView =
    tab === 'changes'
      ? document.getElementById('changes-file-view')
      : document.getElementById('artifacts-file-view');
  const hasShell = !!(
    targetView &&
    targetView.querySelector('.artifacts-diff-shell')
  );
  syncLiveWritePreview({
    live,
    forceRemount: !hasShell,
    incremental: hasShell
  });
}

function liveWriteDiffText(live, side) {
  if (!live) return '';
  const diff = live.diff && typeof live.diff === 'object' ? live.diff : null;
  if (diff && typeof pickDiffDisplayText === 'function') {
    const picked = pickDiffDisplayText(diff, side);
    if (picked) return picked;
  }
  if (side === 'before') {
    if (live.beforeText != null) return String(live.beforeText);
    if (diff?.created) return '';
    if (diff?.beforeText != null) return String(diff.beforeText);
    if (diff?.beforeSnippet != null) return String(diff.beforeSnippet);
    return '';
  }
  if (live.afterText != null) return String(live.afterText);
  if (diff?.afterText != null) return String(diff.afterText);
  if (diff?.afterSnippet != null) return String(diff.afterSnippet);
  return '';
}

function shouldUseMonacoAfterOnlyPreview(live) {
  const after = liveWriteDiffText(live, 'after');
  return after.length <= LIVE_DIFF_MONACO_MAX_CHARS;
}

function trimLiveDiffPreview(text) {
  const s = String(text || '');
  if (s.length <= LIVE_DIFF_LIGHT_PREVIEW_CHARS) return s;
  const half = Math.floor(LIVE_DIFF_LIGHT_PREVIEW_CHARS / 2);
  return (
    s.slice(0, half) +
    '\n\n... diff 内容过大，已省略中间部分 ...\n\n' +
    s.slice(Math.max(half, s.length - half))
  );
}

function renderLargeLiveWriteDiff(viewEl, filePath, live, opts) {
  const incremental = !!(opts && opts.incremental);
  const unified = viewEl?.querySelector('.changes-unified-diff');
  if (incremental && unified) {
    const before = liveWriteDiffText(live, 'before');
    const after = liveWriteDiffText(live, 'after');
    patchUnifiedDiffInPlace(unified, before, after);
    updateLiveWriteDiffChrome(viewEl, live);
    return;
  }
  void (async function () {
    if (!incremental && typeof disposeMonacoArtifactEditor === 'function') {
      await disposeMonacoArtifactEditor();
    }
    renderLargeLiveWriteDiffBody(viewEl, filePath, live, opts);
  })();
}

function renderLargeLiveWriteDiffBody(viewEl, filePath, live, opts) {
  const reviewMode = !!(opts && opts.reviewMode) || !!(live && live.reviewMode);
  const hideDiffHead = shouldHideChangesDiffHead(viewEl, opts);
  const before = liveWriteDiffText(live, 'before');
  const after = liveWriteDiffText(live, 'after');
  const changed =
    (Number(live?.diff?.added) || 0) +
    (Number(live?.diff?.removed) || 0);
  const chars = before.length + after.length;
  viewEl.innerHTML = '';

  const shell = document.createElement('div');
  shell.className =
    'artifacts-editor-shell artifacts-diff-shell artifacts-diff-shell-large' +
    (reviewMode ? ' is-diff-review' : '');
  if (!hideDiffHead) {
    const head = document.createElement('div');
    head.className = 'artifacts-editor-head artifacts-diff-head';
    const pathEl = document.createElement('span');
    pathEl.className = 'artifacts-editor-path';
    pathEl.textContent = filePath;
    pathEl.title = filePath;
    const badge = document.createElement('span');
    badge.className =
      'artifacts-live-write-badge' + (live.status === 'writing' ? ' is-writing' : ' is-done');
    badge.textContent = live.status === 'writing' ? '写入中' : '已写入';
    const note = document.createElement('span');
    note.className = 'artifacts-live-write-note';
    note.textContent =
      liveWriteDiffStatusText({ ...live, reviewMode }) +
      ` · diff 过大，已切换轻量预览（${changed.toLocaleString()} 行变动，${chars.toLocaleString()} 字符）`;
    head.append(pathEl, badge, note);
    shell.appendChild(head);
  }

  if (reviewMode && typeof formatInlineUnifiedDiffHtml === 'function') {
    const body = document.createElement('div');
    body.className = 'changes-diff-pre changes-unified-diff agent-scroll';
    body.innerHTML = formatInlineUnifiedDiffHtml(before, after, { escapeHtml });
    shell.appendChild(body);
    viewEl.appendChild(shell);
    return;
  }

  const grid = document.createElement('div');
  grid.className = 'agents-md-diff-grid artifacts-large-diff-grid';
  const beforePane = document.createElement('div');
  beforePane.className = 'agents-md-diff-pane';
  const beforeLabel = document.createElement('div');
  beforeLabel.className = 'agents-md-diff-label';
  beforeLabel.textContent = '修改前';
  const beforePre = document.createElement('pre');
  beforePre.className = 'agents-md-diff-pre';
  beforePre.textContent = trimLiveDiffPreview(before) || '（空 / 新建）';
  beforePane.append(beforeLabel, beforePre);

  const afterPane = document.createElement('div');
  afterPane.className = 'agents-md-diff-pane';
  const afterLabel = document.createElement('div');
  afterLabel.className = 'agents-md-diff-label';
  afterLabel.textContent = '修改后';
  const afterPre = document.createElement('pre');
  afterPre.className = 'agents-md-diff-pre';
  afterPre.textContent = trimLiveDiffPreview(after) || '（空）';
  afterPane.append(afterLabel, afterPre);

  grid.append(beforePane, afterPane);
  shell.appendChild(grid);
  viewEl.appendChild(shell);
}

function artifactPathsMatch(a, b) {
  if (!a || !b) return false;
  const ca = applyWorkspaceArtifactPath(a);
  const cb = applyWorkspaceArtifactPath(b);
  if (typeof pathsMatch === 'function') return pathsMatch(ca, cb);
  if (typeof normWritePath === 'function') return normWritePath(ca) === normWritePath(cb);
  return ca === cb;
}

function liveMatchesArtifactPath(live, path) {
  if (!live || !path || typeof pathsMatch !== 'function') return false;
  const target = applyWorkspaceArtifactPath(path);
  if (live.canonicalPath && pathsMatch(live.canonicalPath, target)) return true;
  if (live.path && pathsMatch(applyWorkspaceArtifactPath(live.path), target)) return true;
  return false;
}

function parseDiffFromSummary(summary) {
  const m = String(summary || '').match(/\+(\d+)\s+-(\d+)/);
  if (!m) return null;
  return {
    added: Number(m[1]) || 0,
    removed: Number(m[2]) || 0
  };
}

function artifactPathFromTool(tool) {
  if (!tool) return '';
  if (!isEditToolName(tool.name) && !isDeleteToolName(tool.name)) return '';
  if (typeof canonicalArtifactPathFromTool === 'function') {
    const canonical = canonicalArtifactPathFromTool(tool);
    if (canonical) return canonical;
  }
  if (typeof editToolFilePath === 'function') return editToolFilePath(tool);
  return toolArtifactPath(tool);
}

function resolveArtifactReadPath(filePath) {
  const fp = String(filePath || '').trim();
  if (!fp) return fp;
  let best = fp;
  for (const art of sessionArtifacts) {
    if (!art?.path) continue;
    if (typeof pathsMatch === 'function' ? pathsMatch(art.path, fp) : art.path === fp) {
      if (String(art.path).length > best.length) best = art.path;
    }
  }
  const live = typeof getActiveLiveWrite === 'function' ? getActiveLiveWrite() : null;
  if (
    live?.path &&
    typeof pathsMatch === 'function' &&
    pathsMatch(live.path, fp) &&
    String(live.path).length > best.length
  ) {
    best = live.path;
  }
  if (
    live?.canonicalPath &&
    typeof pathsMatch === 'function' &&
    pathsMatch(live.canonicalPath, fp) &&
    String(live.canonicalPath).length > best.length
  ) {
    best = live.canonicalPath;
  }
  return applyWorkspaceArtifactPath(best);
}

async function readArtifactFileText(filePath) {
  if (!gwState || !gwState.authed) throw new Error('Gateway 未连接');
  const readPath = resolveArtifactReadPath(filePath);
  let r;
  try {
    r = await gatewayCall(
      'artifact.read_file',
      await artifactRpcParams({ filePath: readPath, encoding: 'utf8' })
    );
  } catch (err) {
    const msg = String((err && err.message) || err || '');
    if (/No handler|handler registered|未知 RPC|unknown/i.test(msg)) {
      r = await gatewayCall(
        'fs.read_file',
        await artifactRpcParams({ filePath: readPath, encoding: 'utf8' })
      );
    } else {
      throw err;
    }
  }
  return r && r.data != null ? String(r.data) : '';
}

function renderChangesPaneDiffPreview(viewEl, art, opts) {
  if (!viewEl || !art?.path) return Promise.resolve();
  const diff = art.diff && typeof art.diff === 'object' ? art.diff : {};
  const planLive = !!(opts && opts.planLive);
  const beforeText =
    typeof pickDiffDisplayText === 'function' ? pickDiffDisplayText(diff, 'before') : String(diff.beforeText || '');
  const afterText =
    typeof pickDiffDisplayText === 'function' ? pickDiffDisplayText(diff, 'after') : String(diff.afterText || '');
  const liveLike = {
    path: art.path,
    status: planLive ? 'writing' : 'done',
    beforeText,
    afterText,
    diff: {
      ...diff,
      beforeText,
      afterText,
      added: Number(diff.added) || 0,
      removed: Number(diff.removed) || 0
    },
    focusLine: Math.max(1, afterText.split('\n').length)
  };
  const incremental =
    !!(opts && opts.incremental) &&
    typeof window.isChangesDiffPreviewMounted === 'function' &&
    window.isChangesDiffPreviewMounted(art.path);

  // 折叠内联：与 live 路径一致，不用 DiffEditor
  liveWritePreviewMountedTab = 'changes';
  return renderCollapsedReviewDiffInView(viewEl, art.path, liveLike, {
    revealLastChange: planLive || !incremental,
    incremental,
    forceRemount: !incremental,
    reviewMode: true
  });
}

window.liveMatchesArtifactPath = liveMatchesArtifactPath;
