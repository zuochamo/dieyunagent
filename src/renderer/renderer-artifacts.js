/* global gatewayCall, gwState, isSidePanelOpen, openSidePanel, setSidePanelTab, getSidePanelTab, flatFolderIconSvg, flatFileIconSvg, flatDirUpIconSvg, revealMonacoLine, refreshWorkspaceProblemsPanel, startWorkspaceDiagnosticsScan, getActiveLiveWrite, isLiveWritePath, normWritePath, pathsMatch, syncLiveWriteFromTrace, clearLiveWrite, applyLiveWriteFileListMarks, refreshLiveWriteArtifactPreview, createMonacoArtifactDiffEditor, updateMonacoArtifactDiffEditor, disposeMonacoArtifactEditor, createMonacoArtifactEditor, canUseMonacoEditor, getAgentLimits, pickDiffDisplayText, getLastTraceEntryFileChanges, enrichLiveWriteDiffStats, updateProblemsPanel, renderChangesPane, lastAgentDisplayedTrace, computeLineDiffStats, toolDiffHasBody, formatInlineUnifiedDiffHtml, escapeHtml, isEditToolName, editToolFilePath, canonicalArtifactPathFromTool, resolveToolDiffBody, resolveArtifactDiffFromTrace, mammoth, XLSX, withSessionRpcScope, isMonacoAfterOnlyEditorMounted, isMonacoMountInFlight, isMonacoArtifactEditorMounted, updateMonacoArtifactEditorText, currentSessionId, resolveSessionWorkspacePathSync, resolveSessionWorkspacePathForRpc, readFallbackArtifactText */
'use strict';

function pruneInvalidSessionArtifacts() {
  if (typeof isPlausibleArtifactPath !== 'function') return;
  for (let i = sessionArtifacts.length - 1; i >= 0; i--) {
    const p = sessionArtifacts[i] && sessionArtifacts[i].path;
    if (!isPlausibleArtifactPath(p)) sessionArtifacts.splice(i, 1);
  }
}

var planTraceArtifactLogged = false;

function maybeLogPlanTraceArtifacts(trace, latestByPath) {
  if (planTraceArtifactLogged) return;
  if (
    typeof window.shouldPlanUseTraceDiffFallback === 'function' &&
    !window.shouldPlanUseTraceDiffFallback()
  ) {
    return;
  }
  let writeTools = 0;
  let missingPath = 0;
  for (const entry of trace || []) {
    for (const tool of entry.tools || []) {
      if (!isEditToolName(tool.name) || tool.failed) continue;
      writeTools += 1;
      const p =
        typeof artifactPathFromTool === 'function' ? artifactPathFromTool(tool) : toolArtifactPath(tool);
      if (!p) missingPath += 1;
    }
  }
  if (!writeTools) return;
  planTraceArtifactLogged = true;
  const sample = [];
  for (const entry of trace || []) {
    for (const tool of entry.tools || []) {
      if (!isEditToolName(tool.name) || tool.failed) continue;
      const p =
        typeof artifactPathFromTool === 'function' ? artifactPathFromTool(tool) : toolArtifactPath(tool);
      sample.push({
        name: tool.name,
        pending: !!tool.pending,
        failed: !!tool.failed,
        path: p || null,
        hasDiff: !!(tool.diff && typeof toolDiffHasBody === 'function' && toolDiffHasBody(tool.diff)),
        argsBrief: String(tool.argsBrief || '').slice(0, 80) || null,
        hasResultPath: !!(tool.result && (tool.result.path || tool.result.filePath))
      });
      if (sample.length >= 4) break;
    }
    if (sample.length >= 4) break;
  }
  if (typeof window.logPlanTraceDiffState === 'function') {
    window.logPlanTraceDiffState('artifacts', {
      writeTools,
      missingPath,
      tracked: latestByPath.size,
      paths: [...latestByPath.keys()].slice(0, 8),
      sample
    });
  }
}

function resetPlanTraceArtifactLog() {
  planTraceArtifactLogged = false;
}

function notePlanTraceArtifactProgress(trace, latestByPath) {
  if (typeof window.logPlanTraceDiffState !== 'function') return;
  if (latestByPath.size > 0) return;
  let writeTools = 0;
  let missingPath = 0;
  for (const entry of trace || []) {
    for (const tool of entry.tools || []) {
      if (!isEditToolName(tool.name) || tool.failed) continue;
      writeTools += 1;
      const p =
        typeof artifactPathFromTool === 'function' ? artifactPathFromTool(tool) : toolArtifactPath(tool);
      if (!p) missingPath += 1;
    }
  }
  if (!writeTools || missingPath === 0) return;
  window.logPlanTraceDiffState('artifacts-pending', { writeTools, missingPath });
}

function trackArtifactsFromTrace(trace, opts) {
  const o = opts && typeof opts === 'object' ? opts : {};
  const sessionId = resolveArtifactSessionId(o.sessionId);
  const visible = isVisibleArtifactSession(sessionId);
  if (
    visible &&
    typeof window.shouldSuppressPlanTraceDiff === 'function' &&
    window.shouldSuppressPlanTraceDiff()
  ) {
    if (typeof window.logPlanTraceDiffState === 'function') {
      let writeTools = 0;
      for (const entry of trace || []) {
        for (const tool of entry.tools || []) {
          if (isEditToolName(tool.name) && !tool.failed) writeTools += 1;
        }
      }
      if (writeTools > 0) {
        window.logPlanTraceDiffState('suppressed', { writeTools });
      }
    }
    return;
  }
  pruneInvalidSessionArtifacts();
  refreshLastRoundFileChangesForSession(trace, sessionId);
  let order = 0;
  const latestByPath = new Map();
  for (const entry of trace || []) {
    for (const tool of entry.tools || []) {
      const p =
        typeof artifactPathFromTool === 'function' ? artifactPathFromTool(tool) : toolArtifactPath(tool);
      if (
        isDeleteToolName(tool.name) &&
        p &&
        !tool.failed &&
        !tool.pending
      ) {
        dropArtifactFromWorkspaceFileList(p);
        latestByPath.delete(p);
        continue;
      }
      if (!isEditToolName(tool.name) || !p || tool.failed) continue;
      let diff = typeof resolveToolDiffBody === 'function' ? resolveToolDiffBody(tool) : null;
      if (!diff || !toolDiffHasBody(diff)) {
        diff = tool.diff || parseDiffFromSummary(tool.summary);
        if ((!diff || !toolDiffHasBody(diff)) && typeof resolveToolDiffBody === 'function') {
          const resolved = resolveToolDiffBody(tool);
          if (resolved) diff = resolved;
        }
      }
      latestByPath.set(p, { diff: diff || null, order: order++ });
    }
  }
  for (const [p, row] of latestByPath) {
    trackArtifact(p, {
      diff: row.diff,
      countTotals: false,
      skipUiFlush: true,
      sessionId
    });
  }
  maybeLogPlanTraceArtifacts(trace, latestByPath);
  notePlanTraceArtifactProgress(trace, latestByPath);
  if (
    latestByPath.size &&
    typeof window.clearPlanPreviewWhenTraceArtifactsExist === 'function'
  ) {
    window.clearPlanPreviewWhenTraceArtifactsExist();
  }
  const planTraceLive =
    typeof window.shouldPlanUseTraceDiffFallback === 'function' &&
    window.shouldPlanUseTraceDiffFallback();
  if (visible && latestByPath.size && planTraceLive) {
    if (typeof openSidePanel === 'function') openSidePanel({ tab: 'changes' });
    if (typeof setSidePanelTab === 'function') setSidePanelTab('changes');
    if (typeof window.patchChangesPane === 'function') window.patchChangesPane();
    else if (typeof renderChangesPane === 'function') renderChangesPane();
  }
  if (!visible) return;
  if (!isArtifactsUiBatching() && isSidePanelOpen()) {
    if (isActiveLiveWriteSession()) {
      patchArtifactsFilesPanelForLiveWrite();
      if (typeof window.patchChangesPane === 'function') window.patchChangesPane();
    } else {
      scheduleArtifactsUiFlush();
    }
  }
}

function renderLastRoundFileRows(list, view, dirEntries, live) {
  if (!lastRoundFileChanges.length) return;
  const missing = lastRoundFileChanges.filter(function (f) {
    if (
      (dirEntries || []).some(function (row) {
        return row.kind === 'file' && artifactPathsMatch(row.path, f.path);
      })
    ) {
      return false;
    }
    if (live && artifactPathsMatch(live.path, f.path)) return false;
    return shouldShowVirtualArtifactRow(f.path, { pending: f.pending });
  });
  if (!missing.length) return;
  const head = document.createElement('div');
  head.className = 'artifacts-round-files-head';
  head.textContent = '本轮变更';
  list.appendChild(head);
  for (const f of missing) {
    renderArtifactRow(list, view, {
      kind: 'file',
      name: f.name,
      path: f.path,
      relativePath: f.name,
      ts: Date.now(),
      diff:
        f.added != null || f.removed != null ? { added: f.added, removed: f.removed } : null,
      source: 'trace',
      virtual: true,
      pending: f.pending
    });
  }
}

function renderArtifactRow(list, view, row) {
  const live = typeof getActiveLiveWrite === 'function' ? getActiveLiveWrite() : null;
  const diffStats = resolveRowDiffStats(row, live);
  const diff = formatArtifactDiffHtml(diffStats);
  const remoteTag = row.remote ? ' <span class="artifacts-file-remote">远程</span>' : '';
  const icon = row.kind === 'dir' ? flatFolderIconSvg(16) : flatFileIconSvg(16);
  const el = document.createElement('div');
  el.className = 'artifacts-file-item' + (row.kind === 'dir' ? ' is-dir' : '');
  if (row.kind === 'file') {
    el.setAttribute('data-file-path', row.path);
    if (typeof isLiveWritePath === 'function' && isLiveWritePath(row.path)) {
      const live = typeof getActiveLiveWrite === 'function' ? getActiveLiveWrite() : null;
      if (live?.status === 'writing') el.classList.add('is-writing');
      if (live?.status === 'done') el.classList.add('is-write-done');
    }
  }
  if (row.kind === 'file' && row.path === selectedArtifactPath) el.classList.add('active');
  if (row.source === 'trace') el.classList.add('recent');
  el.innerHTML =
    '<span class="artifacts-file-icon">' +
    icon +
    '</span><span class="artifacts-file-name">' +
    escapeHtml(row.name) +
    '</span>' +
    remoteTag +
    diff;
  el.title = row.path;
  el.addEventListener('click', function () {
    if (row.kind === 'dir') {
      artifactsBrowseRel = row.relativePath;
      selectedArtifactPath = null;
      refreshArtifactsDirectory(true).then(function () {
        if (isSidePanelOpen()) renderArtifactsList({ skipRefresh: true });
      });
      return;
    }
    const items = list.querySelectorAll('.artifacts-file-item');
    for (let j = 0; j < items.length; j++) items[j].classList.remove('active');
    el.classList.add('active');
    selectedArtifactPath = row.path;
    selectedArtifactContentMtime = 0;
    loadArtifactContent(row.path, view);
  });
  list.appendChild(el);
}

function artifactsFileListSig() {
  const live = typeof getActiveLiveWrite === 'function' ? getActiveLiveWrite() : null;
  return [
    artifactsBrowseRel,
    selectedArtifactPath,
    artifactsDirEntries.map(function (e) {
      return (e.kind || '') + ':' + (e.path || '') + ':' + (e.ts || 0);
    }).join('|'),
    lastRoundFileChanges
      .map(function (f) {
        return String(f.path || '') + ':' + (f.pending ? 'p' : '') + ':' + (f.added || 0) + ':' + (f.removed || 0);
      })
      .join('|'),
    live ? String(live.path || '') + ':' + String(live.status || '') : ''
  ].join('::');
}

function paintArtifactsFileList(list, view) {
  const sig = artifactsFileListSig();
  if (sig === lastArtifactsFileListSig && list.childElementCount > 0) {
    if (view && selectedArtifactPath) {
      const live = typeof getActiveLiveWrite === 'function' ? getActiveLiveWrite() : null;
      const liveForSelected =
        live &&
        live.path &&
        (typeof liveMatchesArtifactPath === 'function'
          ? liveMatchesArtifactPath(live, selectedArtifactPath)
          : typeof isLiveWritePath === 'function' && isLiveWritePath(selectedArtifactPath));
      const needsLiveRemount =
        liveForSelected &&
        live.status === 'writing' &&
        viewHasPlainMonacoEditor(view);
      const alreadyMounted =
        typeof window.isMonacoArtifactEditorMounted === 'function' &&
        window.isMonacoArtifactEditorMounted(selectedArtifactPath);
      syncSelectedArtifactContentMtimeFromList();
      const diskMtime = findArtifactEntryMtime(selectedArtifactPath);
      const contentStale =
        !!diskMtime &&
        !!selectedArtifactContentMtime &&
        diskMtime !== selectedArtifactContentMtime;
      if (needsLiveRemount || !alreadyMounted || contentStale) {
        loadArtifactContent(
          selectedArtifactPath,
          view,
          needsLiveRemount || contentStale ? { force: true } : undefined
        );
      }
    }
    return;
  }
  lastArtifactsFileListSig = sig;
  list.replaceChildren();

  if (!artifactsWorkspaceRoot) {
    const emptyText = artifactsDirLoading ? '加载中…' : '未设置工作空间';
    list.innerHTML = '<div class="artifacts-empty">' + escapeHtml(emptyText) + '</div>';
    if (view) {
      void clearArtifactsFileView(
        view,
        '<div class="artifacts-empty">选择文件查看内容</div>'
      );
    }
    return;
  }

  const dirRel = normalizeRelPath(artifactsBrowseRel);
  if (dirRel) {
    list.insertAdjacentHTML(
      'beforeend',
      '<div class="artifacts-dir-crumbs">' + escapeHtml(dirRel) + '</div>'
    );
  }

  if (dirRel) {
    const up = document.createElement('div');
    up.className = 'artifacts-file-item artifacts-file-item-up';
    up.innerHTML =
      '<span class="artifacts-file-icon">' +
      flatDirUpIconSvg(16) +
      '</span><span class="artifacts-file-name">..</span>';
    up.title = parentRelPath(dirRel) || '工作区根目录';
    up.addEventListener('click', function () {
      artifactsBrowseRel = parentRelPath(dirRel);
      selectedArtifactPath = null;
      refreshArtifactsDirectory(true).then(function () {
        if (isSidePanelOpen()) renderArtifactsList({ skipRefresh: true });
      });
    });
    list.appendChild(up);
  }

  if (!artifactsDirEntries.length) {
    if (workspaceArtifactsError) {
      list.insertAdjacentHTML(
        'beforeend',
        '<div class="artifacts-empty">加载失败：' + escapeHtml(workspaceArtifactsError) + '</div>'
      );
    } else {
      list.insertAdjacentHTML(
        'beforeend',
        '<div class="artifacts-empty artifacts-dir-empty">此文件夹为空</div>'
      );
    }
  }

  const live = typeof getActiveLiveWrite === 'function' ? getActiveLiveWrite() : null;
  if (live && live.path) {
    selectedArtifactPath = applyWorkspaceArtifactPath(live.path);
  }

  renderLastRoundFileRows(list, view, artifactsDirEntries, live);

  var selectedExists =
    selectedArtifactPath &&
    (artifactsDirEntries.some(function (row) {
      return row.kind === 'file' && artifactPathsMatch(row.path, selectedArtifactPath);
    }) ||
      (live && artifactPathsMatch(live.path, selectedArtifactPath)));
  if (!selectedExists) selectedArtifactPath = null;
  if (!selectedArtifactPath && live && live.path) {
    selectedArtifactPath = applyWorkspaceArtifactPath(live.path);
  }
  if (!selectedArtifactPath) {
    const firstFile = artifactsDirEntries.find(function (r) {
      return r.kind === 'file';
    });
    if (firstFile) selectedArtifactPath = firstFile.path;
  }

  if (live && live.path) {
    const liveExists = artifactsDirEntries.some(function (row) {
      return row.kind === 'file' && artifactPathsMatch(row.path, live.path);
    });
    if (!liveExists && shouldShowVirtualArtifactRow(live.path, { pending: live.status === 'writing' })) {
      const livePath = applyWorkspaceArtifactPath(live.path);
      const name = String(livePath).replace(/\\/g, '/').split('/').pop() || livePath;
      renderArtifactRow(list, view, {
        kind: 'file',
        name,
        path: livePath,
        relativePath: name,
        ts: live.ts || Date.now(),
        diff: live.diff,
        source: 'trace',
        virtual: true
      });
    }
  }

  for (var i = 0; i < artifactsDirEntries.length; i++) {
    renderArtifactRow(list, view, artifactsDirEntries[i]);
  }

  if (view) {
    if (selectedArtifactPath) {
      const liveForSelected =
        live &&
        live.path &&
        (typeof liveMatchesArtifactPath === 'function'
          ? liveMatchesArtifactPath(live, selectedArtifactPath)
          : typeof isLiveWritePath === 'function' && isLiveWritePath(selectedArtifactPath));
      const needsLiveRemount =
        liveForSelected &&
        live.status === 'writing' &&
        viewHasPlainMonacoEditor(view);
      const alreadyMounted =
        typeof window.isMonacoArtifactEditorMounted === 'function' &&
        window.isMonacoArtifactEditorMounted(selectedArtifactPath);
      syncSelectedArtifactContentMtimeFromList();
      const diskMtime = findArtifactEntryMtime(selectedArtifactPath);
      const contentStale =
        !!diskMtime &&
        !!selectedArtifactContentMtime &&
        diskMtime !== selectedArtifactContentMtime;
      if (needsLiveRemount || !alreadyMounted || contentStale) {
        loadArtifactContent(
          selectedArtifactPath,
          view,
          needsLiveRemount || contentStale ? { force: true } : undefined
        );
      }
    } else if (!artifactsDirEntries.length) {
      void clearArtifactsFileView(
        view,
        '<div class="artifacts-empty">选择文件查看内容</div>'
      );
    }
  }
}

function renderArtifactsList(opts) {
  try {
    var list = document.getElementById('artifacts-file-list');
    var view = document.getElementById('artifacts-file-view');
    if (!list) return;
    if (isArtifactsUiBatching()) {
      markArtifactsUiDirty();
      return;
    }
    if (!(opts && opts.force) && isActiveLiveWriteSession() && isWorkspaceArtifactsCacheReady()) {
      patchArtifactsFilesPanelForLiveWrite();
      return;
    }
    var skipRefresh = !!(opts && opts.skipRefresh);
    var forceRefresh = !!(opts && opts.forceRefresh);
    var hasCachedList = workspaceArtifactsLoaded && artifactsDirEntries.length > 0;

    if (!skipRefresh && !artifactsDirLoading) {
      const needForce = forceRefresh || !workspaceArtifactsLoaded;
      void refreshArtifactsDirectory(needForce).then(function () {
        if (isSidePanelOpen()) renderArtifactsList({ skipRefresh: true });
      });
    }

    if (artifactsDirLoading && !hasCachedList) {
      if (!list.querySelector('.artifacts-empty')) {
        list.innerHTML = '<div class="artifacts-empty">加载中…</div>';
      }
      return;
    }

    paintArtifactsFileList(list, view);
  } catch (e) {
    try {
      var listErr = document.getElementById('artifacts-file-list');
      if (listErr) {
        listErr.innerHTML =
          '<div class="artifacts-empty">渲染失败：' +
          escapeHtml(e && e.message ? e.message : String(e)) +
          '</div>';
      }
    } catch {
      // ignore
    }
  }
}

function loadArtifactContent(filePath, viewEl, opts) {
  if (!viewEl) return;
  const fp = String(filePath || '').trim();
  const force = !!(opts && opts.force);

  const live = typeof getActiveLiveWrite === 'function' ? getActiveLiveWrite() : null;
  const liveForFile =
    live &&
    live.path &&
    (typeof liveMatchesArtifactPath === 'function'
      ? liveMatchesArtifactPath(live, fp)
      : typeof isLiveWritePath === 'function' && isLiveWritePath(fp));
  if (liveForFile && typeof createMonacoArtifactDiffEditor === 'function') {
    const previewTab =
      typeof resolveLiveWritePreviewTab === 'function' ? resolveLiveWritePreviewTab() : 'changes';
    const showLiveDiff = live.status === 'writing' || previewTab === 'changes';
    if (showLiveDiff) {
      renderLiveWriteDiffInView(viewEl, fp, live, {
        incremental: !force,
        forceRemount: force,
        revealLastChange: live.status === 'done',
        focusLine: live.status === 'writing' ? live.focusLine : undefined,
        reviewMode: previewTab === 'changes'
      });
      liveWritePreviewMountedTab = resolveLiveWritePreviewTab();
      return;
    }
  }

  if (
    !force &&
    typeof window.isMonacoArtifactEditorMounted === 'function' &&
    window.isMonacoArtifactEditorMounted(fp)
  ) {
    const diskMtime = findArtifactEntryMtime(fp);
    const contentStale =
      !!diskMtime &&
      !!selectedArtifactContentMtime &&
      artifactPathsEqual(selectedArtifactPath, fp) &&
      diskMtime !== selectedArtifactContentMtime;
    if (!contentStale) {
      if (typeof updateProblemsPanel === 'function') updateProblemsPanel(fp, []);
      return;
    }
  }
  if (typeof updateProblemsPanel === 'function') {
    updateProblemsPanel(fp, []);
  }

  void loadArtifactContentAsync(fp, viewEl, ++artifactContentLoadGen);
}

var OFFICE_ARTIFACT_READ_MAX_BYTES = 16 * 1024 * 1024;
var IMAGE_ARTIFACT_RE = /\.(png|jpe?g|gif|webp|bmp|svg|heic|tiff?|ico|avif)$/i;

function officeArtifactKind(filePath) {
  const ext = String(filePath || '')
    .slice(String(filePath || '').lastIndexOf('.'))
    .toLowerCase();
  if (ext === '.docx') return 'docx';
  if (ext === '.xlsx' || ext === '.xls') return 'xlsx';
  if (ext === '.pdf') return 'pdf';
  return null;
}

function imageArtifactKind(filePath) {
  const name = String(filePath || '').toLowerCase();
  return IMAGE_ARTIFACT_RE.test(name) ? 'image' : null;
}

function guessImageArtifactMime(filePath) {
  const name = String(filePath || '').toLowerCase();
  if (name.endsWith('.png')) return 'image/png';
  if (name.endsWith('.gif')) return 'image/gif';
  if (name.endsWith('.webp')) return 'image/webp';
  if (name.endsWith('.bmp')) return 'image/bmp';
  if (name.endsWith('.svg')) return 'image/svg+xml';
  if (name.endsWith('.avif')) return 'image/avif';
  if (name.endsWith('.heic')) return 'image/heic';
  if (name.endsWith('.tif') || name.endsWith('.tiff')) return 'image/tiff';
  if (name.endsWith('.ico')) return 'image/x-icon';
  return 'image/jpeg';
}

function revokeArtifactMediaBlobUrls(viewEl) {
  if (!viewEl) return;
  for (const el of viewEl.querySelectorAll('[data-artifact-blob-url]')) {
    const url = el.dataset.artifactBlobUrl;
    if (!url) continue;
    try {
      URL.revokeObjectURL(url);
    } catch {
      // ignore
    }
    delete el.dataset.artifactBlobUrl;
  }
}

function base64ToUint8Array(b64) {
  const raw = String(b64 || '').replace(/\s/g, '');
  const bin = atob(raw);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function readArtifactFileBase64(filePath, maxBytes) {
  const readPath = resolveArtifactReadPath(filePath);
  try {
    return await gatewayCall(
      'artifact.read_file',
      await artifactRpcParams({
        filePath: readPath,
        encoding: 'base64',
        maxBytes: maxBytes || OFFICE_ARTIFACT_READ_MAX_BYTES
      })
    );
  } catch (err) {
    const msg = String((err && err.message) || err || '');
    if (/No handler|handler registered|未知 RPC|unknown/i.test(msg)) {
      return gatewayCall(
        'fs.read_file',
        await artifactRpcParams({
          filePath: readPath,
          encoding: 'base64',
          maxBytes: maxBytes || OFFICE_ARTIFACT_READ_MAX_BYTES
        })
      );
    }
    throw err;
  }
}

async function renderOfficeArtifactPreview(viewEl, displayPath, readPath, kind, loadGen) {
  if (kind === 'docx' && typeof mammoth === 'undefined') {
    throw new Error('Word 预览组件未加载');
  }
  if (kind === 'xlsx' && typeof XLSX === 'undefined') {
    throw new Error('Excel 预览组件未加载');
  }

  const r = await readArtifactFileBase64(readPath, OFFICE_ARTIFACT_READ_MAX_BYTES);
  if (loadGen !== artifactContentLoadGen) return;

  const bytes = base64ToUint8Array(r && r.data);
  const arrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);

  viewEl.innerHTML = '';
  const shell = document.createElement('div');
  shell.className = 'artifacts-office-preview';

  const head = document.createElement('div');
  head.className = 'artifacts-editor-head';
  const pathEl = document.createElement('span');
  pathEl.className = 'artifacts-editor-path';
  pathEl.textContent = displayPath;
  pathEl.title = displayPath;
  const hint = document.createElement('span');
  hint.className = 'artifacts-office-preview-hint';
  hint.textContent =
    kind === 'docx' ? 'Word 只读预览' : kind === 'pdf' ? 'PDF 只读预览' : 'Excel 只读预览';
  head.append(pathEl, hint);
  shell.appendChild(head);

  if (r && r.truncated) {
    const note = document.createElement('div');
    note.className = 'artifacts-editor-note';
    note.textContent =
      kind === 'pdf'
        ? '文件过大，无法完整加载预览'
        : '文件过大，仅加载部分内容，预览可能不完整';
    shell.appendChild(note);
  }

  const body = document.createElement('div');
  body.className = 'artifacts-office-preview-body agent-scroll';

  if (kind === 'pdf') {
    body.classList.remove('agent-scroll');
    body.classList.add('artifacts-pdf-preview-body');
    if (r && r.truncated) {
      body.innerHTML = '<div class="artifacts-empty">PDF 过大，无法在应用内预览</div>';
    } else {
      const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
      shell.dataset.artifactBlobUrl = url;
      const iframe = document.createElement('iframe');
      iframe.className = 'artifacts-pdf-preview-frame';
      iframe.title = displayPath;
      iframe.src = url;
      body.appendChild(iframe);
    }
  } else if (kind === 'docx') {
    const result = await mammoth.convertToHtml({ arrayBuffer });
    if (loadGen !== artifactContentLoadGen) return;
    body.innerHTML = (result && result.value) || '<p class="artifacts-empty">（空文档）</p>';
  } else {
    const wb = XLSX.read(bytes, { type: 'array' });
    if (loadGen !== artifactContentLoadGen) return;
    const sheetName = wb.SheetNames && wb.SheetNames[0];
    body.innerHTML = sheetName
      ? XLSX.utils.sheet_to_html(wb.Sheets[sheetName])
      : '<div class="artifacts-empty">（空工作簿）</div>';
  }

  shell.appendChild(body);
  viewEl.appendChild(shell);
}

async function renderImageArtifactPreview(viewEl, displayPath, readPath, loadGen) {
  const r = await readArtifactFileBase64(readPath, OFFICE_ARTIFACT_READ_MAX_BYTES);
  if (loadGen !== artifactContentLoadGen) return;

  viewEl.innerHTML = '';
  const shell = document.createElement('div');
  shell.className = 'artifacts-office-preview artifacts-image-preview';

  const head = document.createElement('div');
  head.className = 'artifacts-editor-head';
  const pathEl = document.createElement('span');
  pathEl.className = 'artifacts-editor-path';
  pathEl.textContent = displayPath;
  pathEl.title = displayPath;
  const hint = document.createElement('span');
  hint.className = 'artifacts-office-preview-hint';
  hint.textContent = '图片只读预览';
  head.append(pathEl, hint);
  shell.appendChild(head);

  if (r && r.truncated) {
    const note = document.createElement('div');
    note.className = 'artifacts-editor-note';
    note.textContent = '图片过大，无法完整加载预览';
    shell.appendChild(note);
  }

  const body = document.createElement('div');
  body.className = 'artifacts-office-preview-body artifacts-image-preview-body';

  if (r && r.truncated) {
    body.innerHTML = '<div class="artifacts-empty">图片过大，无法在应用内预览</div>';
  } else {
    const bytes = base64ToUint8Array(r && r.data);
    const mime = guessImageArtifactMime(readPath);
    const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
    shell.dataset.artifactBlobUrl = url;
    const img = document.createElement('img');
    img.className = 'artifacts-image-preview-img';
    img.alt = displayPath;
    img.decoding = 'async';
    img.src = url;
    img.addEventListener('error', () => {
      img.replaceWith(
        Object.assign(document.createElement('div'), {
          className: 'artifacts-empty',
          textContent: '当前环境无法解码此图片格式'
        })
      );
    });
    body.appendChild(img);
  }

  shell.appendChild(body);
  viewEl.appendChild(shell);
}

async function loadArtifactContentAsync(filePath, viewEl, loadGen) {
  const gen = loadGen || ++artifactContentLoadGen;
  const hadEditor =
    !!viewEl.querySelector(
      '.artifacts-editor-shell, .monaco-artifact-editor, .monaco-diff-artifact-editor'
    );

  if (typeof disposeMonacoArtifactEditor === 'function') {
    await disposeMonacoArtifactEditor();
  }

  revokeArtifactMediaBlobUrls(viewEl);

  if (gen !== artifactContentLoadGen) return;

  if (!hadEditor) {
    viewEl.innerHTML = '<div class="artifacts-empty">加载中…</div>';
  }
  if (!gwState || !gwState.authed) {
    viewEl.textContent = 'Gateway 未连接';
    return;
  }
  let wsCtx = null;
  try {
    wsCtx = await getWorkspaceContext();
    const readPath = applyWorkspaceArtifactPath(resolveArtifactReadPath(filePath), wsCtx);
    if (imageArtifactKind(readPath)) {
      await renderImageArtifactPreview(viewEl, readPath, readPath, gen);
      if (gen === artifactContentLoadGen) rememberSelectedArtifactContentMtime(readPath);
      return;
    }
    const officeKind = officeArtifactKind(readPath);
    if (officeKind) {
      await renderOfficeArtifactPreview(viewEl, readPath, readPath, officeKind, gen);
      if (gen === artifactContentLoadGen) rememberSelectedArtifactContentMtime(readPath);
      return;
    }
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
          await artifactRpcParams({ filePath: filePath, encoding: 'utf8' })
        );
      } else {
        throw err;
      }
    }
    const text = r && r.data ? String(r.data) : '';
    const truncated = !!(r && r.truncated);
    if (gen !== artifactContentLoadGen) return;
    await renderArtifactEditor(viewEl, readPath, text, truncated);
    if (gen === artifactContentLoadGen) rememberSelectedArtifactContentMtime(readPath);
  } catch (err) {
    if (gen !== artifactContentLoadGen) return;
    const msg = String((err && err.message) || err || '');
    const missing = /ENOENT|not found|不存在|No such file/i.test(msg);
    if (missing && typeof readFallbackArtifactText === 'function') {
      try {
        const fb = await readFallbackArtifactText(filePath);
        if (gen !== artifactContentLoadGen) return;
        if (fb && fb.text != null) {
          const displayPath =
            applyWorkspaceArtifactPath(resolveArtifactReadPath(filePath), wsCtx) || filePath;
          await renderArtifactEditor(
            viewEl,
            displayPath,
            fb.text,
            !!fb.truncated,
            artifactFallbackSourceNote(fb.source)
          );
          return;
        }
      } catch {
        if (gen !== artifactContentLoadGen) return;
      }
    }
    if (missing) {
      dropArtifactFromWorkspaceFileList(filePath, {
        keepSession: isSessionTrackedArtifactPath(filePath)
      });
    }
    viewEl.innerHTML =
      '<div class="artifacts-empty">读取失败: ' + escapeHtml(msg) + '</div>';
  }
}

async function renderArtifactEditor(viewEl, filePath, text, truncated, sourceNote) {
  if (typeof disposeMonacoArtifactEditor === 'function') {
    await disposeMonacoArtifactEditor();
  }
  viewEl.innerHTML = '';
  const shell = document.createElement('div');
  shell.className = 'artifacts-editor-shell';

  const head = document.createElement('div');
  head.className = 'artifacts-editor-head';
  const pathEl = document.createElement('span');
  pathEl.className = 'artifacts-editor-path';
  pathEl.textContent = filePath;
  pathEl.title = filePath;
  const saveBtn = document.createElement('button');
  saveBtn.type = 'button';
  saveBtn.className = 'ghost-btn artifacts-editor-save';
  saveBtn.textContent = '保存';
  head.appendChild(pathEl);
  head.appendChild(saveBtn);

  shell.appendChild(head);
  if (truncated) {
    const note = document.createElement('div');
    note.className = 'artifacts-editor-note';
    note.textContent = '内容过长，仅显示部分内容（可用 offset/maxBytes 分块读取）';
    shell.appendChild(note);
  }
  if (sourceNote) {
    const note = document.createElement('div');
    note.className = 'artifacts-editor-note';
    note.textContent = sourceNote;
    shell.appendChild(note);
  }

  const useMonaco =
    typeof canUseMonacoEditor === 'function' &&
    canUseMonacoEditor(filePath, text) &&
    typeof createMonacoArtifactEditor === 'function';

  if (useMonaco) {
    const editorHost = document.createElement('div');
    editorHost.className = 'artifacts-monaco-host';
    shell.appendChild(editorHost);
    if (typeof initProblemsPanel === 'function') {
      initProblemsPanel(shell);
    }
    viewEl.appendChild(shell);

    let editorHandle = null;
    let textareaFallback = null;

    function saveCurrentContent() {
      saveBtn.disabled = true;
      saveBtn.textContent = '保存中…';
      const data =
        editorHandle && typeof editorHandle.getValue === 'function'
          ? editorHandle.getValue()
          : textareaFallback
            ? textareaFallback.value
            : '';
      artifactRpcParams({ filePath: filePath, data: data, encoding: 'utf8' }).then((params) =>
        gatewayCall('fs.write_file', params)
      )
        .then(function () {
          selectedArtifactContentMtime = Date.now();
          saveBtn.textContent = '已保存';
          setTimeout(function () {
            saveBtn.textContent = '保存';
            saveBtn.disabled = false;
          }, 1200);
        })
        .catch(function (err) {
          saveBtn.textContent = '保存失败';
          saveBtn.disabled = false;
          window.alert((err && err.message) || String(err));
        });
    }

    saveBtn.addEventListener('click', saveCurrentContent);

    createMonacoArtifactEditor(editorHost, { filePath: filePath, text: text.slice(0, 500000) })
      .then(function (handle) {
        editorHandle = handle;
      })
      .catch(function () {
        editorHost.remove();
        if (typeof initProblemsPanel === 'function') {
          const prob = shell.querySelector('.artifacts-problems');
          if (prob) prob.remove();
        }
        textareaFallback = renderArtifactTextarea(shell, text);
      });
    return;
  }

  const ta = renderArtifactTextarea(shell, text);
  viewEl.appendChild(shell);
  saveBtn.addEventListener('click', function () {
    saveBtn.disabled = true;
    saveBtn.textContent = '保存中…';
    artifactRpcParams({ filePath: filePath, data: ta.value, encoding: 'utf8' })
      .then(function (params) {
        return gatewayCall('fs.write_file', params);
      })
      .then(function () {
        selectedArtifactContentMtime = Date.now();
        saveBtn.textContent = '已保存';
        setTimeout(function () {
          saveBtn.textContent = '保存';
          saveBtn.disabled = false;
        }, 1200);
      })
      .catch(function (err) {
        saveBtn.textContent = '保存失败';
        saveBtn.disabled = false;
        window.alert((err && err.message) || String(err));
      });
  });
}

function renderArtifactTextarea(shell, text) {
  const ta = document.createElement('textarea');
  ta.className = 'artifacts-editor-textarea';
  ta.spellcheck = false;
  ta.value = text.slice(0, 500000);
  shell.appendChild(ta);
  return ta;
}

function initArtifactsBtn() {
  // Panel toggle handled by initSidePanel()
}

function focusLiveWriteFile(filePath) {
  if (!filePath) return;
  selectedArtifactPath = filePath;
  if (isArtifactsUiBatching()) {
    markArtifactsUiDirty();
    return;
  }
  applyLiveWriteFileListMarks();
  const live =
    typeof getActiveLiveWrite === 'function' &&
    typeof isLiveWritePath === 'function' &&
    isLiveWritePath(filePath)
      ? getActiveLiveWrite()
      : null;
  if (live && isSidePanelOpen()) {
    syncLiveWritePreview({ live, incremental: false });
    return;
  }
  if (isSidePanelOpen()) {
    renderArtifactsList({ skipRefresh: true });
    const view = document.getElementById('artifacts-file-view');
    if (view) loadArtifactContent(filePath, view);
    return;
  }
  void refreshArtifactsDirectory(false).then(function () {
    if (isSidePanelOpen()) {
      renderArtifactsList({ skipRefresh: true });
      const view = document.getElementById('artifacts-file-view');
      if (view) loadArtifactContent(filePath, view);
    }
  });
}

/** 写入联动：列表补行 + 预览跟随当前侧栏页 */
function openLiveWritePreview(live) {
  if (!live || !live.path) return;
  if (isArtifactsUiBatching()) {
    markArtifactsUiDirty();
    return;
  }
  syncLiveWritePreview({ live, incremental: false });
}

window.pruneInvalidSessionArtifacts = pruneInvalidSessionArtifacts;
window.resetPlanTraceArtifactLog = resetPlanTraceArtifactLog;
window.syncLiveWritePreview = syncLiveWritePreview;
window.setLiveWritePanelChrome = setLiveWritePanelChrome;
window.migrateLiveWritePreviewOnTabSwitch = migrateLiveWritePreviewOnTabSwitch;

window.focusLiveWriteFile = focusLiveWriteFile;
window.findLastRoundChange = findLastRoundChange;
window.getLastRoundFileChanges = getLastRoundFileChanges;
window.formatArtifactDiffHtml = formatArtifactDiffHtml;
window.upsertArtifactFileDiffBadge = upsertArtifactFileDiffBadge;
window.refreshLastRoundFileChanges = refreshLastRoundFileChanges;
window.ensureSessionArtifactForLiveWrite = ensureSessionArtifactForLiveWrite;
window.readArtifactFileText = readArtifactFileText;
window.renderChangesPaneDiffPreview = renderChangesPaneDiffPreview;
window.patchUnifiedDiffInPlace = patchUnifiedDiffInPlace;
window.highlightLiveWriteInThinking = highlightLiveWriteInThinking;
window.onLiveWriteChanged = function (liveArg, opts) {
  if (isArtifactsUiBatching()) {
    markArtifactsUiDirty();
    return;
  }
  const live =
    liveArg && liveArg.path
      ? liveArg
      : typeof getActiveLiveWrite === 'function'
        ? getActiveLiveWrite()
        : null;
  if (!live) {
    if (typeof renderChangesPane === 'function') {
      renderChangesPane();
    } else if (opts && opts.showStaticPreview) {
      const view = document.getElementById('changes-file-view');
      const rows =
        typeof getSessionChangeRowsForAgent === 'function' ? getSessionChangeRowsForAgent() : [];
      const path = opts.completedPath || (rows[0] && rows[0].path);
      const art = path ? rows.find((r) => (typeof pathsMatch === 'function' ? pathsMatch(r.path, path) : r.path === path)) || rows[0] : rows[0];
      if (view && art && typeof renderChangesPaneDiffPreview === 'function') {
        renderChangesPaneDiffPreview(view, art);
      }
    }
    // 写入结束后文件预览可能仍停在旧 Monaco 内容：强制刷目录并重载当前打开文件
    const completedPath = opts && opts.completedPath ? String(opts.completedPath).trim() : '';
    if (completedPath || (opts && opts.showStaticPreview)) {
      void refreshArtifactsDirectory(true).then(function () {
        if (typeof isSidePanelOpen === 'function' && isSidePanelOpen()) {
          renderArtifactsList({ skipRefresh: true });
        }
        maybeReloadSelectedArtifactContent({
          force: true,
          path: completedPath || undefined
        });
      });
    }
    return;
  }
  syncLiveWritePreview({
    live,
    incremental: opts?.incremental !== false,
    revealLastChange: !!(opts && opts.revealLastChange) || live.status === 'done',
    forceRemount: !!(opts && opts.forceRemount)
  });
  if (live.status === 'done') {
    if (typeof window.patchChangesPane === 'function') {
      window.patchChangesPane();
    } else if (typeof scheduleArtifactsUiFlush === 'function') {
      scheduleArtifactsUiFlush();
    }
    // 最终落盘预览在 clearLiveWrite → onLiveWriteChanged(!live) 里强制重载
  }
};

window.beginArtifactsUiBatch = beginArtifactsUiBatch;
window.endArtifactsUiBatch = endArtifactsUiBatch;
window.isArtifactsUiBatching = isArtifactsUiBatching;
window.flushArtifactsUiNow = flushArtifactsUiNow;
window.scheduleArtifactsUiFlush = scheduleArtifactsUiFlush;
window.forceArtifactsUiRefreshAfterBatch = forceArtifactsUiRefreshAfterBatch;
window.isWorkspaceArtifactsCacheReady = isWorkspaceArtifactsCacheReady;
window.teardownArtifactsMonacoEditor = teardownArtifactsMonacoEditor;
window.cancelArtifactContentLoads = cancelArtifactContentLoads;
window.switchSessionArtifacts = switchSessionArtifacts;
window.cleanupSessionArtifacts = cleanupSessionArtifacts;
window.persistGlobalsToArtifactBucket = persistGlobalsToArtifactBucket;
window.maybeReloadSelectedArtifactContent = maybeReloadSelectedArtifactContent;
