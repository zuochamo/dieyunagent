/* global gatewayCall, gwState, isSidePanelOpen, openSidePanel, setSidePanelTab, getSidePanelTab, flatFolderIconSvg, flatFileIconSvg, flatDirUpIconSvg, revealMonacoLine, refreshWorkspaceProblemsPanel, startWorkspaceDiagnosticsScan, getActiveLiveWrite, isLiveWritePath, normWritePath, pathsMatch, syncLiveWriteFromTrace, clearLiveWrite, applyLiveWriteFileListMarks, refreshLiveWriteArtifactPreview, createMonacoArtifactDiffEditor, updateMonacoArtifactDiffEditor, disposeMonacoArtifactEditor, createMonacoArtifactEditor, canUseMonacoEditor, getAgentLimits, pickDiffDisplayText, getLastTraceEntryFileChanges, enrichLiveWriteDiffStats, updateProblemsPanel, renderChangesPane, lastAgentDisplayedTrace, computeLineDiffStats, toolDiffHasBody, formatInlineUnifiedDiffHtml, escapeHtml, isEditToolName, editToolFilePath, canonicalArtifactPathFromTool, resolveToolDiffBody, resolveArtifactDiffFromTrace, mammoth, XLSX, withSessionRpcScope, isMonacoAfterOnlyEditorMounted, isMonacoMountInFlight, isMonacoArtifactEditorMounted, updateMonacoArtifactEditorText, currentSessionId, resolveSessionWorkspacePathSync, resolveSessionWorkspacePathForRpc, readFallbackArtifactText, applyWorkspaceArtifactPath, liveMatchesArtifactPath */
'use strict';

var artifactsApi = window.diecloud || {};

async function artifactRpcParams(extra, sessionId) {
  const params =
    typeof withSessionRpcScope === 'function'
      ? withSessionRpcScope(extra || {}, sessionId)
      : { ...(extra || {}) };
  if (!params.runWorkspaceRoot) {
    if (
      typeof resolveSessionWorkspacePathForRpc === 'function' &&
      (sessionId || (typeof currentSessionId !== 'undefined' && currentSessionId))
    ) {
      const sid = sessionId || currentSessionId;
      const rpcPath = resolveSessionWorkspacePathForRpc(sid);
      if (rpcPath) params.runWorkspaceRoot = rpcPath;
    }
  }
  if (!params.runWorkspaceRoot) {
    const viewPath =
      typeof window !== 'undefined' && window.activeViewSessionWorkspacePath
        ? window.activeViewSessionWorkspacePath
        : null;
    if (viewPath) params.runWorkspaceRoot = viewPath;
  }
  if (!params.runWorkspaceRoot) {
    const wsCtx = await getWorkspaceContext();
    if (wsCtx && wsCtx.workspacePath) params.runWorkspaceRoot = wsCtx.workspacePath;
  }
  return params;
}

var sessionArtifacts = [];
/** @type {Map<string, { sessionArtifacts: object[], sessionFileChangeTotals: object, lastRoundFileChanges: object[], selectedArtifactPath: string|null }>} */
var artifactsSessionStore = new Map();
var workspaceArtifacts = [];
var workspaceArtifactsSource = null;
var workspaceArtifactsLoaded = false;
var workspaceArtifactsLoading = false;
var workspaceArtifactsError = '';
var sessionFileChangeTotals = { files: 0, added: 0, removed: 0 };
var selectedArtifactPath = null;
/** 当前预览内容对应的磁盘 mtime（ms）；用于判断是否需重载 */
var selectedArtifactContentMtime = 0;
var artifactsWorkspaceRoot = null;
var artifactsWorkspaceKind = 'local';
/** @type {'changes'|'files'|null} */
var liveWritePreviewMountedTab = null;
var artifactsBrowseRel = '';
var artifactsDirEntries = [];
var artifactsDirLoading = false;
var artifactsDirRefreshPromise = null;
/** 目录刷新代际：切换会话 / invalidate 时递增，丢弃过期 list_dir 结果 */
var artifactsDirRefreshGen = 0;

function artifactPathsEqual(a, b) {
  if (!a || !b) return false;
  if (typeof artifactPathsMatch === 'function') return artifactPathsMatch(a, b);
  if (typeof pathsMatch === 'function') return pathsMatch(a, b);
  return String(a) === String(b);
}

function findArtifactEntryMtime(filePath) {
  const fp = String(filePath || '').trim();
  if (!fp) return 0;
  for (const row of artifactsDirEntries || []) {
    if (row && row.kind === 'file' && artifactPathsEqual(row.path, fp)) {
      return Number(row.ts) || 0;
    }
  }
  for (const art of workspaceArtifacts || []) {
    if (art && artifactPathsEqual(art.path, fp)) {
      return Number(art.ts) || 0;
    }
  }
  return 0;
}

function rememberSelectedArtifactContentMtime(filePath) {
  if (!selectedArtifactPath || !artifactPathsEqual(selectedArtifactPath, filePath)) return;
  const m = findArtifactEntryMtime(filePath);
  if (m) selectedArtifactContentMtime = m;
}

function syncSelectedArtifactContentMtimeFromList() {
  if (!selectedArtifactPath || selectedArtifactContentMtime) return;
  const m = findArtifactEntryMtime(selectedArtifactPath);
  if (m) selectedArtifactContentMtime = m;
}

/**
 * 文件预览已挂载后默认不重读盘；磁盘 mtime 变化或写入完成后需强制刷新。
 * @param {{ force?: boolean, path?: string }} [opts]
 */
function maybeReloadSelectedArtifactContent(opts) {
  const force = !!(opts && opts.force);
  const wantPath = opts && opts.path ? String(opts.path).trim() : '';
  const fp = wantPath || selectedArtifactPath;
  if (!fp) return false;
  if (wantPath && selectedArtifactPath && !artifactPathsEqual(selectedArtifactPath, wantPath)) {
    return false;
  }
  if (typeof isSidePanelOpen === 'function' && !isSidePanelOpen()) return false;
  if (typeof getSidePanelTab === 'function' && getSidePanelTab() !== 'files') return false;

  const live = typeof getActiveLiveWrite === 'function' ? getActiveLiveWrite() : null;
  const liveForFile =
    live &&
    live.path &&
    live.status === 'writing' &&
    (typeof liveMatchesArtifactPath === 'function'
      ? liveMatchesArtifactPath(live, fp)
      : typeof isLiveWritePath === 'function' && isLiveWritePath(fp));
  if (liveForFile) return false;

  const diskMtime = findArtifactEntryMtime(fp);
  const mounted =
    typeof window.isMonacoArtifactEditorMounted === 'function' &&
    window.isMonacoArtifactEditorMounted(fp);
  const view = document.getElementById('artifacts-file-view');
  const hasPreview =
    !!view &&
    !!view.querySelector(
      '.artifacts-editor-shell, .monaco-artifact-editor, .monaco-diff-artifact-editor, img.artifacts-image-preview'
    );
  if (!force) {
    if (mounted || hasPreview) {
      if (!diskMtime || diskMtime === selectedArtifactContentMtime) return false;
    } else if (!diskMtime && selectedArtifactContentMtime) {
      // 列表尚未带上 mtime 时，已有预览则不动
      return false;
    }
  }

  if (!view) return false;
  if (!selectedArtifactPath || !artifactPathsEqual(selectedArtifactPath, fp)) {
    selectedArtifactPath = fp;
  }
  loadArtifactContent(fp, view, { force: true });
  return true;
}

var ARTIFACT_SKIP_DIRS = new Set([
  '.git',
  '.agents',
  '.codex',
  'node_modules',
  '__pycache__',
  '.venv',
  'venv',
  'dist',
  'build',
  '.dieyun'
]);

var lastRoundFileChanges = [];

function refreshLastRoundFileChanges(trace) {
  refreshLastRoundFileChangesForSession(trace, resolveArtifactSessionId());
}

function refreshLastRoundFileChangesForSession(trace, sessionId) {
  const raw =
    typeof getLastTraceEntryFileChanges === 'function' ? getLastTraceEntryFileChanges(trace) : [];
  const changes = raw.map(function (ch) {
    if (!ch || !ch.path) return ch;
    return { ...ch, path: applyWorkspaceArtifactPath(ch.path) };
  });
  const sid = resolveArtifactSessionId(sessionId);
  if (!sid) return;
  const visibleSid = resolveArtifactSessionId();
  const bucket = getArtifactBucket(sid, true);
  if (bucket) bucket.lastRoundFileChanges = changes.slice();
  if (sid === visibleSid) {
    lastRoundFileChanges = changes;
    persistGlobalsToArtifactBucket(sid);
  } else {
    persistArtifactBucket(sid);
  }
}

function isVisibleArtifactSession(sessionId) {
  const sid = resolveArtifactSessionId(sessionId);
  return !!sid && sid === resolveArtifactSessionId();
}

function persistArtifactBucket(sessionId) {
  const sid = resolveArtifactSessionId(sessionId);
  if (!sid) return;
  if (sid === resolveArtifactSessionId()) {
    persistGlobalsToArtifactBucket(sid);
    return;
  }
  const bucket = getArtifactBucket(sid, false);
  if (!bucket) return;
  artifactsSessionStore.set(sid, {
    sessionArtifacts: bucket.sessionArtifacts.slice(),
    sessionFileChangeTotals: { ...bucket.sessionFileChangeTotals },
    lastRoundFileChanges: bucket.lastRoundFileChanges.slice(),
    selectedArtifactPath: bucket.selectedArtifactPath || null
  });
}

function findLastRoundChange(filePath) {
  if (!filePath || !lastRoundFileChanges.length) return null;
  for (const ch of lastRoundFileChanges) {
    if (artifactPathsMatch(ch.path, filePath)) return ch;
  }
  return null;
}

function getLastRoundFileChanges() {
  return lastRoundFileChanges.slice();
}

function formatArtifactDiffHtml(diffStats) {
  if (!diffStats) return '';
  if (diffStats.added == null && diffStats.removed == null) return '';
  return (
    ' <span class="artifacts-file-diff">+' +
    escapeHtml(String(Number(diffStats.added) || 0)) +
    ' -' +
    escapeHtml(String(Number(diffStats.removed) || 0)) +
    '</span>'
  );
}

function resolveRowDiffStats(row, live) {
  let diff = row && row.diff ? row.diff : null;
  if (live && row && row.path && liveMatchesArtifactPath(live, row.path)) {
    const enriched =
      typeof enrichLiveWriteDiffStats === 'function' ? enrichLiveWriteDiffStats(live) : live.diff;
    if (enriched) diff = enriched;
  }
  const fromRound = row && row.path ? findLastRoundChange(row.path) : null;
  if (fromRound && (fromRound.added != null || fromRound.removed != null)) {
    return {
      added: diff?.added ?? fromRound.added ?? 0,
      removed: diff?.removed ?? fromRound.removed ?? 0
    };
  }
  if (diff && (diff.added != null || diff.removed != null)) {
    return { added: Number(diff.added) || 0, removed: Number(diff.removed) || 0 };
  }
  return null;
}

function upsertArtifactFileDiffBadge(el, diffStats) {
  if (!el || el.classList.contains('is-dir')) return;
  const html = formatArtifactDiffHtml(diffStats);
  const badge = el.querySelector('.artifacts-file-diff');
  if (!html) {
    if (badge) badge.remove();
    return;
  }
  const added = String(Number(diffStats.added) || 0);
  const removed = String(Number(diffStats.removed) || 0);
  if (badge) {
    const nextText = '+' + added + ' -' + removed;
    if (badge.textContent === nextText) return;
    badge.textContent = nextText;
  } else {
    el.insertAdjacentHTML('beforeend', html);
  }
}
function isDeleteToolName(name) {
  const n = String(name || '').toLowerCase();
  return n === 'fs.delete_file' || n === 'fs_delete_file' || n.includes('delete_file');
}

function toolArtifactPath(tool) {
  if (!tool) return '';
  if (typeof artifactPathFromTool === 'function') {
    return artifactPathFromTool(tool);
  }
  const args =
    typeof window.resolveToolArgsFromTrace === 'function'
      ? window.resolveToolArgsFromTrace(tool)
      : tool.toolArgs && typeof tool.toolArgs === 'object'
        ? tool.toolArgs
        : {};
  const fromResult =
    tool.result && typeof tool.result === 'object'
      ? String(tool.result.path || tool.result.filePath || '')
      : '';
  const raw = String(fromResult || args.filePath || args.path || tool.filePath || tool.path || '')
    .trim()
    .replace(/\s+→[\s\S]*$/, '')
    .replace(/^\((.*)\)$/, '$1')
    .trim();
  if (typeof isPlausibleArtifactPath === 'function' && !isPlausibleArtifactPath(raw)) return '';
  return raw;
}

function shouldShowVirtualArtifactRow(filePath, meta) {
  const fp = String(filePath || '').trim();
  if (!fp) return false;
  const live = typeof getActiveLiveWrite === 'function' ? getActiveLiveWrite() : null;
  if (live && typeof pathsMatch === 'function' && pathsMatch(live.path, fp)) {
    return live.status === 'writing';
  }
  return !!(meta && meta.pending);
}

function resolveArtifactSessionId(sessionId) {
  if (sessionId != null && String(sessionId).trim()) return String(sessionId).trim();
  if (typeof currentSessionId !== 'undefined' && currentSessionId) return String(currentSessionId);
  return '';
}

function emptyArtifactBucket() {
  return {
    sessionArtifacts: [],
    sessionFileChangeTotals: { files: 0, added: 0, removed: 0 },
    lastRoundFileChanges: [],
    selectedArtifactPath: null
  };
}

function getArtifactBucket(sessionId, create) {
  const sid = resolveArtifactSessionId(sessionId);
  if (!sid) return null;
  if (!artifactsSessionStore.has(sid) && create) {
    artifactsSessionStore.set(sid, emptyArtifactBucket());
  }
  return artifactsSessionStore.get(sid) || null;
}

function applyArtifactBucketToGlobals(bucket) {
  if (!bucket) {
    sessionArtifacts.length = 0;
    sessionFileChangeTotals = { files: 0, added: 0, removed: 0 };
    lastRoundFileChanges = [];
    selectedArtifactPath = null;
    selectedArtifactContentMtime = 0;
    return;
  }
  sessionArtifacts.length = 0;
  sessionArtifacts.push(...bucket.sessionArtifacts);
  sessionFileChangeTotals = {
    files: Number(bucket.sessionFileChangeTotals.files) || 0,
    added: Number(bucket.sessionFileChangeTotals.added) || 0,
    removed: Number(bucket.sessionFileChangeTotals.removed) || 0
  };
  lastRoundFileChanges = bucket.lastRoundFileChanges.slice();
  selectedArtifactPath = bucket.selectedArtifactPath || null;
  selectedArtifactContentMtime = 0;
}

function persistGlobalsToArtifactBucket(sessionId) {
  const sid = resolveArtifactSessionId(sessionId);
  if (!sid) return;
  artifactsSessionStore.set(sid, {
    sessionArtifacts: sessionArtifacts.slice(),
    sessionFileChangeTotals: { ...sessionFileChangeTotals },
    lastRoundFileChanges: lastRoundFileChanges.slice(),
    selectedArtifactPath
  });
}

function switchSessionArtifacts(prevSessionId, nextSessionId, opts) {
  if (prevSessionId) persistGlobalsToArtifactBucket(prevSessionId);
  applyArtifactBucketToGlobals(getArtifactBucket(nextSessionId, true));
  let sameWorkspace = false;
  if (typeof resolveSessionWorkspacePathSync === 'function' && prevSessionId && nextSessionId) {
    const prevPath = resolveSessionWorkspacePathSync(prevSessionId);
    const nextPath = resolveSessionWorkspacePathSync(nextSessionId);
    sameWorkspace = prevPath != null && nextPath != null && String(prevPath) === String(nextPath);
  }
  if (!sameWorkspace) {
    invalidateWorkspaceArtifacts();
  }
  if (opts && opts.skipRender) return;
  if (
    typeof isSidePanelOpen === 'function' &&
    isSidePanelOpen() &&
    typeof getSidePanelTab === 'function' &&
    getSidePanelTab() === 'changes' &&
    typeof renderChangesPane === 'function'
  ) {
    renderChangesPane();
  }
}

function cleanupSessionArtifacts(sessionId) {
  const sid = resolveArtifactSessionId(sessionId);
  if (!sid) return;
  artifactsSessionStore.delete(sid);
}

function removeSessionArtifact(fp) {
  const target = String(fp || '').trim();
  if (!target) return;
  for (let i = sessionArtifacts.length - 1; i >= 0; i--) {
    const p = sessionArtifacts[i] && sessionArtifacts[i].path;
    if (p === target || artifactPathsMatch(p, target)) sessionArtifacts.splice(i, 1);
  }
}

function dropArtifactFromWorkspaceFileList(filePath, opts) {
  const fp = String(filePath || '').trim();
  if (!fp) return;
  if (!(opts && opts.keepSession)) {
    removeSessionArtifact(fp);
  }
  artifactsDirEntries = artifactsDirEntries.filter((row) => !artifactPathsMatch(row.path, fp));
  workspaceArtifacts = workspaceArtifacts.filter((row) => !artifactPathsMatch(row.path, fp));
  if (selectedArtifactPath && artifactPathsMatch(selectedArtifactPath, fp)) {
    selectedArtifactPath = null;
  }
  if (isSidePanelOpen()) renderArtifactsList({ skipRefresh: true });
}

function isSessionTrackedArtifactPath(filePath) {
  const fp = String(filePath || '').trim();
  if (!fp) return false;
  if (sessionArtifacts.some((a) => a && artifactPathsMatch(a.path, fp))) return true;
  if (lastRoundFileChanges.some((f) => f && artifactPathsMatch(f.path, fp))) return true;
  return false;
}

function artifactFallbackSourceNote(source) {
  if (source === 'worktree') return '当前工作区尚无此文件，已从 Worktree 加载（尚未应用到主工作区）';
  if (source === 'live') return '当前工作区尚无此文件，已从正在写入的内容加载';
  if (source === 'trace') return '当前工作区尚无此文件，已从本会话变更记录加载';
  return '当前工作区尚无此文件，已从会话变更加载';
}

function trackArtifact(fp, meta) {
  try {
    const sid = resolveArtifactSessionId(meta && meta.sessionId);
    fp = String(fp || '').trim();
    if (!sid || isVisibleArtifactSession(sid)) {
      fp = applyWorkspaceArtifactPath(fp);
    }
    if (!fp) return;
    const bucket = getArtifactBucket(sid, true);
    const list = sid && bucket ? bucket.sessionArtifacts : sessionArtifacts;
    var ex = list.find(function (a) {
      return artifactPathsMatch(a.path, fp);
    });
    var next = {
      path: fp,
      ts: Date.now(),
      diff: meta && meta.diff ? meta.diff : null
    };
    if (ex && ex.diff && next.diff && typeof toolDiffHasBody === 'function') {
      const prevHasBody = toolDiffHasBody(ex.diff);
      const nextHasBody = toolDiffHasBody(next.diff);
      if (prevHasBody && !nextHasBody) {
        next.diff = {
          ...ex.diff,
          added: next.diff.added != null ? next.diff.added : ex.diff.added,
          removed: next.diff.removed != null ? next.diff.removed : ex.diff.removed
        };
      } else if (nextHasBody && !(Number(next.diff.added) || Number(next.diff.removed))) {
        next.diff = {
          ...next.diff,
          added: ex.diff.added != null ? ex.diff.added : next.diff.added,
          removed: ex.diff.removed != null ? ex.diff.removed : next.diff.removed
        };
      }
    }
    if (ex) {
      Object.assign(ex, next);
    } else {
      list.push(next);
    }
    if (list.length > 200) list.shift();
    if (bucket && sid === resolveArtifactSessionId()) {
      sessionArtifacts.length = 0;
      sessionArtifacts.push(...bucket.sessionArtifacts);
    }
    if (meta && meta.diff && meta.countTotals !== false) {
      const totalsTarget =
        bucket && sid !== resolveArtifactSessionId() ? bucket.sessionFileChangeTotals : sessionFileChangeTotals;
      totalsTarget.files += 1;
      totalsTarget.added += Number(meta.diff.added) || 0;
      totalsTarget.removed += Number(meta.diff.removed) || 0;
      if (bucket && sid !== resolveArtifactSessionId()) {
        sessionFileChangeTotals = { ...bucket.sessionFileChangeTotals };
      }
    }
    if (sid) persistArtifactBucket(sid);
    const skipFlush =
      (meta && meta.skipUiFlush) ||
      (typeof getActiveLiveWrite === 'function' &&
        getActiveLiveWrite() &&
        typeof pathsMatch === 'function' &&
        pathsMatch(getActiveLiveWrite().path, fp));
    if (!skipFlush && isVisibleArtifactSession(sid) && isSidePanelOpen()) {
      scheduleArtifactsUiFlush();
    }
  } catch (e) {
    // ignore
  }
}

function cancelArtifactContentLoads() {
  artifactContentLoadGen += 1;
}

/** 切换会话 / 清空产物预览前：先卸 Monaco，再动 DOM，避免 Diff 销毁竞态 */
async function teardownArtifactsMonacoEditor() {
  cancelArtifactContentLoads();
  if (typeof disposeMonacoArtifactEditor === 'function') {
    await disposeMonacoArtifactEditor();
  }
}

async function clearArtifactsFileView(view, html) {
  if (!view) return;
  cancelArtifactContentLoads();
  await teardownArtifactsMonacoEditor();
  if (view.isConnected) view.innerHTML = html;
}

function clearArtifacts() {
  sessionArtifacts.length = 0;
  sessionFileChangeTotals = { files: 0, added: 0, removed: 0 };
  lastRoundFileChanges = [];
  selectedArtifactPath = null;
  selectedArtifactContentMtime = 0;
  liveWritePreviewMountedTab = null;
  cancelArtifactContentLoads();
  if (typeof disposeMonacoArtifactEditor === 'function') {
    void disposeMonacoArtifactEditor();
  }
  if (typeof clearLiveWrite === 'function') clearLiveWrite();
  const sid = resolveArtifactSessionId();
  if (sid) persistGlobalsToArtifactBucket(sid);
}

function invalidateWorkspaceArtifacts() {
  artifactsDirRefreshGen += 1;
  artifactsDirRefreshPromise = null;
  workspaceArtifacts = [];
  workspaceArtifactsSource = null;
  workspaceArtifactsLoaded = false;
  workspaceArtifactsLoading = false;
  workspaceArtifactsError = '';
  artifactsWorkspaceRoot = null;
  artifactsWorkspaceKind = 'local';
  artifactsBrowseRel = '';
  artifactsDirEntries = [];
  artifactsDirLoading = false;
  lastDefaultEditorWorkspaceKey = null;
  lastArtifactsFileListSig = '';
  selectedArtifactContentMtime = 0;
  cancelArtifactContentLoads();
}

function expectedArtifactsSourceKey(workspacePath, browseRel) {
  return `${workspacePath || '__default__'}::${browseRel != null ? browseRel : artifactsBrowseRel}`;
}

function isWorkspaceArtifactsCacheReady() {
  if (!workspaceArtifactsLoaded || !artifactsDirEntries.length) return false;
  const viewPath =
    typeof window !== 'undefined' && window.activeViewSessionWorkspacePath
      ? window.activeViewSessionWorkspacePath
      : '';
  if (!viewPath) return false;
  return workspaceArtifactsSource === expectedArtifactsSourceKey(viewPath, artifactsBrowseRel);
}

var DEFAULT_EDITOR_REL_CANDIDATES = [
  '.dieyun/AGENTS.md',
  'AGENTS.md',
  'README.md',
  'readme.md',
  'package.json'
];

var CODE_FILE_EXT_RE = /\.(tsx?|jsx?|mjs|cjs|vue|py|go|rs|java|cs|cpp|c|h|md|json|yaml|yml)$/i;
var LIVE_DIFF_MONACO_MAX_CHARS = 180000;
var LIVE_DIFF_LIGHT_PREVIEW_CHARS = 50000;
var LIVE_DIFF_PAINT_MS = 400;

var lastDefaultEditorWorkspaceKey = null;
var lastArtifactsFileListSig = '';
var artifactContentLoadGen = 0;

var artifactsUiBatchDepth = 0;
var artifactsUiBatchDirty = false;
var artifactsUiFlushTimer = null;

function isArtifactsUiBatching() {
  return artifactsUiBatchDepth > 0;
}

function beginArtifactsUiBatch() {
  artifactsUiBatchDepth += 1;
}

function endArtifactsUiBatch() {
  if (artifactsUiBatchDepth <= 0) return;
  artifactsUiBatchDepth -= 1;
  if (artifactsUiBatchDepth === 0 && artifactsUiBatchDirty) {
    artifactsUiBatchDirty = false;
    flushArtifactsUiNow();
  }
}

function markArtifactsUiDirty() {
  if (!isArtifactsUiBatching()) return false;
  artifactsUiBatchDirty = true;
  return true;
}

function forceArtifactsUiRefreshAfterBatch() {
  if (isArtifactsUiBatching()) artifactsUiBatchDirty = true;
}

/** 写入进行中：文件列表只打补丁，不整表 innerHTML 重建（壳不动） */
function isActiveLiveWriteSession() {
  const live = typeof getActiveLiveWrite === 'function' ? getActiveLiveWrite() : null;
  return !!(live && live.status === 'writing');
}

function patchArtifactsFilesPanelForLiveWrite() {
  const live = typeof getActiveLiveWrite === 'function' ? getActiveLiveWrite() : null;
  if (!live || !live.path) return;
  ensureLiveWriteFileListRow(live);
  applyLiveWriteFileListMarks();
  if (typeof refreshLiveWriteArtifactPreview === 'function') {
    refreshLiveWriteArtifactPreview({ incremental: true });
  }
}

function flushArtifactsUiNow() {
  if (!isSidePanelOpen()) return;
  if (isActiveLiveWriteSession() && isWorkspaceArtifactsCacheReady()) {
    patchArtifactsFilesPanelForLiveWrite();
    if (typeof window.patchChangesPane === 'function') {
      window.patchChangesPane();
    }
    return;
  }
  // 缓存就绪时仍强制 list_dir：否则 mtime 不更新，打开中的文件预览会一直停在旧内容
  void refreshArtifactsDirectory(true).then(function () {
    renderArtifactsList({ skipRefresh: true });
    if (typeof refreshLiveWriteArtifactPreview === 'function') {
      refreshLiveWriteArtifactPreview({ incremental: true, revealLastChange: true });
    }
    if (typeof window.patchChangesPane === 'function') {
      window.patchChangesPane();
    } else if (typeof renderChangesPane === 'function') {
      renderChangesPane();
    }
  });
}

function scheduleArtifactsUiFlush() {
  if (markArtifactsUiDirty()) return;
  if (artifactsUiFlushTimer) clearTimeout(artifactsUiFlushTimer);
  artifactsUiFlushTimer = setTimeout(function () {
    artifactsUiFlushTimer = null;
    flushArtifactsUiNow();
  }, typeof getAgentLimits === 'function' ? getAgentLimits().artifactsUiFlushMs : 80);
}

async function pickDefaultEditorFile(wsCtx) {
  if (!wsCtx || !wsCtx.root) return null;
  for (const rel of DEFAULT_EDITOR_REL_CANDIDATES) {
    const abs =
      wsCtx.kind === 'ssh' ? joinPosixPath(wsCtx.root, rel) : joinArtifactPath(wsCtx.root, rel);
    try {
      const st = await gatewayCall(
        'fs.stat',
        await artifactRpcParams({ filePath: abs })
      );
      if (st && (st.isFile === true || st.kind === 'file')) return abs;
    } catch {
      // try next
    }
  }
  const codeFile = (artifactsDirEntries || []).find(
    (r) => r.kind === 'file' && CODE_FILE_EXT_RE.test(String(r.name || ''))
  );
  return codeFile ? codeFile.path : null;
}

/**
 * 绑定工作区后默认打开侧栏文件视图 + Monaco，使编辑器上下文/LSP 在发 Agent 消息前就绪。
 */
async function ensureDefaultWorkspaceEditor(opts = {}) {
  if (!gwState.authed) return;
  const wsCtx = await getWorkspaceContext();
  if (!wsCtx || !wsCtx.workspacePath) return;
  if (wsCtx.kind === 'ssh' && !wsCtx.sshConnected) return;

  const workspaceKey = String(wsCtx.workspacePath || '');
  if (!opts.force && lastDefaultEditorWorkspaceKey === workspaceKey && isSidePanelOpen()) {
    return;
  }
  lastDefaultEditorWorkspaceKey = workspaceKey;

  if (typeof preloadMonacoEditor === 'function') {
    try {
      await preloadMonacoEditor();
    } catch {
      // Monaco 失败仍尝试文本预览
    }
  }

  if (typeof openSidePanel === 'function') openSidePanel({ tab: 'files' });
  artifactsBrowseRel = '';
  await refreshArtifactsDirectory(true);

  const pick = await pickDefaultEditorFile(wsCtx);
  if (pick) {
    selectedArtifactPath = pick;
    selectedArtifactContentMtime = 0;
  }

  const view = document.getElementById('artifacts-file-view');
  if (pick && view && typeof loadArtifactContent === 'function') {
    loadArtifactContent(pick, view);
  } else if (typeof renderArtifactsList === 'function') {
    renderArtifactsList({ skipRefresh: true });
  }

  if (pick && gwState.authed) {
    const warmPaths = [pick];
    if (typeof window.getMergedContextFilePaths === 'function') {
      warmPaths.push(...window.getMergedContextFilePaths().slice(0, 8));
    }
    void gatewayCall(
      'workspace.diagnostics',
      await artifactRpcParams({
        workspaceRoot: wsCtx.workspacePath,
        files: warmPaths,
        useDiagnosticStore: true,
        includeGitDirty: true,
        maxFiles: 16
      })
    )
      .then(() => {
        if (typeof startWorkspaceDiagnosticsScan === 'function') {
          return startWorkspaceDiagnosticsScan(wsCtx.workspacePath, { background: true, force: true });
        }
        return null;
      })
      .then(() => {
        if (typeof refreshWorkspaceProblemsPanel === 'function') {
          return refreshWorkspaceProblemsPanel({ workspaceRoot: wsCtx.workspacePath });
        }
        return null;
      })
      .catch(() => {});
  }
}

window.ensureDefaultWorkspaceEditor = ensureDefaultWorkspaceEditor;
window.getSelectedArtifactPath = function getSelectedArtifactPath(sessionId) {
  const sid =
    sessionId != null && String(sessionId).trim() ? String(sessionId).trim() : '';
  if (sid && !isVisibleArtifactSession(sid)) {
    const bucket = getArtifactBucket(sid, false);
    return (bucket && bucket.selectedArtifactPath) || '';
  }
  return selectedArtifactPath;
};

async function openArtifactFileAtLine(filePath, line, col) {
  const fp = applyWorkspaceArtifactPath(String(filePath || '').trim());
  if (!fp) return;
  if (typeof openSidePanel === 'function') openSidePanel({ tab: 'files' });
  selectedArtifactPath = fp;
  selectedArtifactContentMtime = 0;
  const view = document.getElementById('artifacts-file-view');
  if (view && typeof loadArtifactContent === 'function') {
    loadArtifactContent(fp, view, { force: true });
  } else if (typeof renderArtifactsList === 'function') {
    renderArtifactsList({ skipRefresh: true });
  }
  if (typeof revealMonacoLine === 'function') {
    revealMonacoLine(line, col);
    setTimeout(() => {
      if (typeof revealMonacoLine === 'function') {
        revealMonacoLine(line, col);
      }
    }, 800);
  }
}

window.openArtifactFileAtLine = openArtifactFileAtLine;
