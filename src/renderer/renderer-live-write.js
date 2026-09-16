/* global gatewayCall, gwState, openSidePanel, isSidePanelOpen, getSidePanelTab, compactDiffForTrace, pickDiffDisplayText, ensureSessionArtifactForLiveWrite, updateMonacoArtifactDiffEditor, highlightLiveWriteInThinking, scheduleArtifactsUiFlush, getAgentLimits, refreshLastRoundFileChanges, computeLineDiffStats, findLastRoundChange, upsertArtifactFileDiffBadge, isEditToolName, syncChangesListLiveRows, applyWorkspaceArtifactPath, currentSessionId, withSessionRpcScope */
'use strict';

/** @type {Map<string, { path: string, norm: string, status: 'writing'|'done', beforeText: string, afterText: string, diff: object|null, focusLine: number, ts: number, canonicalPath?: string, sessionId?: string }>} */
const liveWriteBySession = new Map();
/** @type {Map<string, number>} */
const liveWriteSyncGenBySession = new Map();
/** @type {Map<string, ReturnType<typeof setTimeout>>} */
const liveWriteSyncTimerBySession = new Map();
/** @type {Map<string, object[]>} */
const liveWriteSyncPendingBySession = new Map();
let liveWriteSyncSuppressDepth = 0;
/** @type {Map<string, string>} */
const beforeTextCache = new Map();
/** @type {Map<string, Promise<string>>} */
const beforeTextInflight = new Map();

const LIVE_WRITE_DEBOUNCE_MS = () =>
  (typeof getAgentLimits === 'function' ? getAgentLimits().liveWriteDebounceMs : 120) || 120;

function resolveLiveWriteSessionId(sessionId) {
  if (sessionId != null && String(sessionId).trim()) return String(sessionId).trim();
  if (typeof currentSessionId !== 'undefined' && currentSessionId) return String(currentSessionId);
  return '';
}

function isVisibleLiveWriteSession(sessionId) {
  const sid = resolveLiveWriteSessionId(sessionId);
  return !!sid && sid === resolveLiveWriteSessionId();
}

function liveWriteRow(sessionId) {
  const sid = resolveLiveWriteSessionId(sessionId);
  if (!sid) return null;
  return liveWriteBySession.get(sid) || null;
}

function setLiveWriteRow(sessionId, row) {
  const sid = resolveLiveWriteSessionId(sessionId || (row && row.sessionId));
  if (!sid) return;
  if (!row) liveWriteBySession.delete(sid);
  else liveWriteBySession.set(sid, { ...row, sessionId: sid });
}

function bumpLiveWriteSyncGen(sessionId) {
  const sid = resolveLiveWriteSessionId(sessionId);
  if (!sid) return 0;
  const n = (liveWriteSyncGenBySession.get(sid) || 0) + 1;
  liveWriteSyncGenBySession.set(sid, n);
  return n;
}

function liveWriteSyncGenOf(sessionId) {
  const sid = resolveLiveWriteSessionId(sessionId);
  return sid ? liveWriteSyncGenBySession.get(sid) || 0 : 0;
}

function viewLiveWrite() {
  return liveWriteRow();
}

function emitLiveWriteUi(sessionId, opts) {
  if (!isVisibleLiveWriteSession(sessionId)) return;
  notifyLiveWriteChanged(opts);
}

function clearLiveWriteTimers(sessionId) {
  const sid = resolveLiveWriteSessionId(sessionId);
  if (!sid) return;
  const t = liveWriteSyncTimerBySession.get(sid);
  if (t) {
    clearTimeout(t);
    liveWriteSyncTimerBySession.delete(sid);
  }
  liveWriteSyncPendingBySession.delete(sid);
}

function beginLiveWriteSyncSuppress() {
  liveWriteSyncSuppressDepth += 1;
}

function endLiveWriteSyncSuppress() {
  liveWriteSyncSuppressDepth = Math.max(0, liveWriteSyncSuppressDepth - 1);
}

function isLiveWriteSyncSuppressed() {
  return liveWriteSyncSuppressDepth > 0;
}

function normWritePath(p) {
  return String(p || '')
    .trim()
    .replace(/\\/g, '/')
    .toLowerCase();
}

function pathsMatch(a, b) {
  if (!a || !b) return false;
  const na = normWritePath(a);
  const nb = normWritePath(b);
  if (na === nb) return true;
  if (na.endsWith('/' + nb) || nb.endsWith('/' + na)) return true;
  const ba = na.includes('/') ? na.slice(na.lastIndexOf('/') + 1) : na;
  const bb = nb.includes('/') ? nb.slice(nb.lastIndexOf('/') + 1) : nb;
  return !!(ba && ba === bb);
}

function extractPathFieldsFromArgsBrief(brief) {
  const out = {};
  const raw = String(brief || '').trim();
  if (!raw) return out;
  const filePath = raw.match(/"filePath"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  if (filePath) out.filePath = filePath[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  const path = raw.match(/"path"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  if (path) out.path = path[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  return out;
}

function resolveToolArgsFromTrace(tool) {
  if (!tool) return {};
  const pickArgs = (obj) => {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
    return Object.keys(obj).length ? { ...obj } : null;
  };
  let args = pickArgs(tool.toolArgs) || pickArgs(tool.args);
  if (args) {
    if (!args.filePath && args.path) args.filePath = args.path;
    if (!args.filePath && args.file) args.filePath = args.file;
    if (!args.filePath && args.filename) args.filePath = args.filename;
    return args;
  }
  const brief = String(tool.argsBrief || '').trim();
  if (brief.startsWith('{') || brief.startsWith('[')) {
    try {
      const parsed = JSON.parse(brief);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        if (!parsed.filePath && parsed.path) parsed.filePath = parsed.path;
        return parsed;
      }
    } catch {
      const partial = extractPathFieldsFromArgsBrief(brief);
      if (partial.filePath || partial.path) return partial;
    }
  } else if (brief && isEditToolName(tool.name)) {
    const pathOnly = brief.replace(/\s+→[\s\S]*$/, '').replace(/^\((.*)\)$/, '$1').trim();
    if (pathOnly && !/[\r\n]/.test(pathOnly)) return { filePath: pathOnly };
  }
  return {};
}

function resolveWritePathFromTool(tool) {
  if (!tool) return '';
  const args = resolveToolArgsFromTrace(tool);
  const fromResult =
    tool.result && typeof tool.result === 'object'
      ? String(tool.result.path || tool.result.filePath || '')
      : '';
  const raw = String(
    fromResult || args.filePath || args.path || tool.filePath || tool.path || ''
  ).trim();
  if (raw) return raw.replace(/\s+→[\s\S]*$/, '').replace(/^\((.*)\)$/, '$1').trim();
  const brief = String(tool.argsBrief || '').trim();
  if (!brief || brief.startsWith('{') || brief.startsWith('[')) return '';
  return brief.replace(/\s+→[\s\S]*$/, '').replace(/^\((.*)\)$/, '$1').trim();
}

function diffHasDisplayBody(diff) {
  if (!diff || typeof diff !== 'object') return false;
  return (
    diff.beforeText != null ||
    diff.afterText != null ||
    diff.beforeSnippet != null ||
    diff.afterSnippet != null ||
    !!diff.created
  );
}

function isLiveTrackableEditTool(tool) {
  if (!tool || tool.failed) return false;
  const n = String(tool.name || '').toLowerCase();
  if (n === 'fs_write_file' || n === 'fs.write_file' || n === 'write_file' || n === 'fs_edit' || n === 'fs.edit_file') return true;
  if (typeof isEditToolName === 'function' && isEditToolName(tool.name)) {
    return !!(resolveWritePathFromTool(tool) || (tool.diff && typeof tool.diff === 'object'));
  }
  return false;
}

function findLatestWriteTool(trace) {
  let pending = null;
  let lastDone = null;
  for (const entry of trace || []) {
    for (const t of entry.tools || []) {
      if (!isLiveTrackableEditTool(t)) continue;
      if (t.pending) pending = t;
      else if (!t.failed) lastDone = t;
    }
  }
  return { pending, lastDone };
}

function beforeTextCacheKey(filePath, sessionId) {
  return `${resolveLiveWriteSessionId(sessionId)}\0${normWritePath(filePath)}`;
}

async function readBeforeText(filePath, sessionId) {
  if (!filePath || !gwState?.authed) return '';
  const key = beforeTextCacheKey(filePath, sessionId);
  if (beforeTextCache.has(key)) return beforeTextCache.get(key);
  if (beforeTextInflight.has(key)) return beforeTextInflight.get(key);

  const p = (async () => {
    const readPath = resolveLiveWriteStoragePath(filePath, sessionId);
    try {
      const r = await gatewayCall(
        'fs.read_file',
        typeof withSessionRpcScope === 'function'
          ? withSessionRpcScope(
              { filePath: readPath, encoding: 'utf8' },
              resolveLiveWriteSessionId(sessionId)
            )
          : { filePath: readPath, encoding: 'utf8' }
      );
      if (r && r.ok !== false && r.data != null) {
        const text = String(r.data);
        beforeTextCache.set(key, text);
        return text;
      }
    } catch {
      // 新建文件或读失败 → 视为空
    }
    beforeTextCache.set(key, '');
    return '';
  })().finally(() => {
    beforeTextInflight.delete(key);
  });

  beforeTextInflight.set(key, p);
  return p;
}

/** 仅打开侧栏，不强制切换 tab（壳不动：用户停在「文件」页则保持） */
function ensureSidePanelOpenForLiveWrite() {
  if (typeof isSidePanelOpen !== 'function' || typeof openSidePanel !== 'function') return;
  if (isSidePanelOpen()) return;
  const tab =
    typeof getSidePanelTab === 'function' ? getSidePanelTab() : 'changes';
  openSidePanel({ tab: tab || 'changes' });
}

function resolveLiveWriteStoragePath(path, sessionId) {
  const raw = String(path || '').trim();
  const sid = resolveLiveWriteSessionId(sessionId);
  if (sid && !isVisibleLiveWriteSession(sid)) {
    // 后台会话：不要用当前视图的 SSH 根改写路径，交给该会话 RPC scope
    return raw;
  }
  if (typeof applyWorkspaceArtifactPath === 'function') {
    return applyWorkspaceArtifactPath(raw);
  }
  return raw;
}

function prefetchBeforeText(filePath, sessionId) {
  if (!filePath) return;
  const key = beforeTextCacheKey(filePath, sessionId);
  if (beforeTextCache.has(key) || beforeTextInflight.has(key)) return;
  void readBeforeText(filePath, sessionId).then((text) => {
    const live = liveWriteRow(sessionId);
    if (!live || !pathsMatch(live.path, filePath)) return;
    if (live.beforeText === text) return;
    setLiveWriteRow(sessionId, { ...live, beforeText: text });
    emitLiveWriteUi(sessionId, { incremental: true, previewOnly: true });
  });
}

function invalidateBeforeTextCache(filePath, sessionId) {
  if (!filePath) return;
  beforeTextCache.delete(beforeTextCacheKey(filePath, sessionId));
}

function enrichLiveWriteDiffStats(live) {
  if (!live) return null;
  const base = live.diff && typeof live.diff === 'object' ? { ...live.diff } : {};
  if (live.beforeText != null && base.beforeText == null) base.beforeText = String(live.beforeText);
  if (live.afterText != null && base.afterText == null) base.afterText = String(live.afterText);
  if (base.created == null && !base.beforeText && base.afterText) base.created = true;

  const hasTexts = live.beforeText != null && live.afterText != null;
  const liveWriting = live.status === 'writing';
  if (
    typeof computeLineDiffStats === 'function' &&
    hasTexts &&
    (liveWriting || !(Number(base.added) || Number(base.removed)))
  ) {
    const stats = computeLineDiffStats(live.beforeText, live.afterText);
    base.added = stats.added;
    base.removed = stats.removed;
  }
  return base;
}

function applyLiveWriteFileListMarks() {
  if (typeof syncChangesListLiveRows === 'function') syncChangesListLiveRows();

  const live = viewLiveWrite();
  const liveStats = live ? enrichLiveWriteDiffStats(live) : null;

  function markList(list, pathFromEl) {
    if (!list) return;
    list.querySelectorAll('.artifacts-file-item').forEach((el) => {
      const p = pathFromEl(el);
      const isTarget = live && pathsMatch(p, live.path);
      el.classList.toggle('is-writing', !!(isTarget && live.status === 'writing'));
      el.classList.toggle('is-write-done', !!(isTarget && live.status === 'done'));
      let stats = null;
      if (isTarget && liveStats) {
        stats = { added: liveStats.added, removed: liveStats.removed };
      } else if (typeof findLastRoundChange === 'function') {
        stats = findLastRoundChange(p);
        if (stats) stats = { added: stats.added, removed: stats.removed };
      }
      if (!stats || (stats.added == null && stats.removed == null)) return;
      if (isTarget && live.status === 'writing') return;
      if (typeof upsertArtifactFileDiffBadge === 'function') {
        upsertArtifactFileDiffBadge(el, stats);
      }
    });
  }

  markList(document.getElementById('artifacts-file-list'), (el) => el.getAttribute('data-file-path') || '');
  markList(
    document.getElementById('changes-file-list'),
    (el) => el.getAttribute('data-change-path') || el.title || ''
  );

  if (live && live.status === 'writing') {
    const changesList = document.getElementById('changes-file-list');
    const activeRow = changesList?.querySelector('.artifacts-file-item.is-writing');
    if (activeRow) {
      try {
        activeRow.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      } catch {
        activeRow.scrollIntoView(false);
      }
    }
  }
}

function computeLastChangedLine(beforeText, afterText) {
  const beforeLines = String(beforeText || '').split('\n');
  const afterLines = String(afterText || '').split('\n');
  const max = Math.max(beforeLines.length, afterLines.length);
  for (let i = max - 1; i >= 0; i--) {
    if ((beforeLines[i] ?? '') !== (afterLines[i] ?? '')) return i + 1;
  }
  return Math.max(1, afterLines.length);
}

function notifyLiveWriteChanged(opts) {
  applyLiveWriteFileListMarks();
  const live = viewLiveWrite();
  if (typeof highlightLiveWriteInThinking === 'function') {
    highlightLiveWriteInThinking(live);
  }
  if (typeof window.onLiveWriteChanged === 'function') {
    window.onLiveWriteChanged(live, opts || {});
  }
}

/** 写入中：先用 tool 内容刷新预览。后台会话只记账，不打开当前侧栏。 */
function applyLiveWritePreviewFast(tool, status, sessionId) {
  const sid = resolveLiveWriteSessionId(sessionId);
  if (!sid) return false;
  const path = resolveWritePathFromTool(tool);
  if (!path) return false;
  const args = resolveToolArgsFromTrace(tool);
  let afterText = String(args.content != null ? args.content : '');
  const diff = tool.diff && typeof tool.diff === 'object' ? tool.diff : null;
  if (!afterText && diff && diffHasDisplayBody(diff)) {
    afterText = pickDiffDisplayText(diff, 'after');
  }
  if (!afterText && diff && (Number(diff.added) || Number(diff.removed))) {
    afterText = pickDiffDisplayText(diff, 'after');
  }

  const prev = liveWriteRow(sid);
  const samePath = prev && pathsMatch(prev.path, path);
  let beforeText = samePath ? String(prev.beforeText ?? '') : '';
  if (!beforeText) {
    const cached = beforeTextCache.get(beforeTextCacheKey(path, sid));
    if (cached != null) beforeText = cached;
  }

  const focusLine = computeLastChangedLine(beforeText, afterText);
  if (
    samePath &&
    prev.status === status &&
    prev.beforeText === beforeText &&
    prev.afterText === afterText
  ) {
    return false;
  }

  const next = {
    path,
    norm: normWritePath(path),
    status,
    beforeText,
    afterText,
    diff: enrichLiveWriteDiffStats({
      path,
      beforeText,
      afterText,
      diff
    }),
    focusLine,
    ts: Date.now(),
    sessionId: sid,
    canonicalPath: samePath && prev.canonicalPath ? prev.canonicalPath : resolveLiveWriteStoragePath(path, sid)
  };
  setLiveWriteRow(sid, next);

  if (!beforeText && !beforeTextCache.has(beforeTextCacheKey(path, sid))) {
    prefetchBeforeText(path, sid);
  }

  if (isVisibleLiveWriteSession(sid) && typeof ensureSessionArtifactForLiveWrite === 'function') {
    ensureSessionArtifactForLiveWrite(path, { diff: next.diff, sessionId: sid });
  }

  if (isVisibleLiveWriteSession(sid)) {
    ensureSidePanelOpenForLiveWrite();
    notifyLiveWriteChanged({
      incremental: samePath,
      revealLastChange: status === 'done',
      previewOnly: status === 'writing'
    });
  }
  return true;
}

async function setLiveWriteFromTool(tool, status, syncGen, sessionId) {
  const sid = resolveLiveWriteSessionId(sessionId);
  if (!sid) return;
  const path = resolveWritePathFromTool(tool);
  if (!path) return;

  const args = resolveToolArgsFromTrace(tool);
  const contentFromArgs = String(args.content != null ? args.content : '');
  let beforeText = '';
  let afterText = contentFromArgs;
  let diff = tool.diff && typeof tool.diff === 'object' ? tool.diff : null;
  const prevLive = liveWriteRow(sid);
  const samePath = prevLive && pathsMatch(prevLive.path, path);

  if (status === 'writing') {
    if (samePath && prevLive.beforeText != null) {
      beforeText = prevLive.beforeText;
    } else {
      beforeText = await readBeforeText(path, sid);
      if (syncGen != null && syncGen !== liveWriteSyncGenOf(sid)) return;
    }
    if (!afterText && diff && diffHasDisplayBody(diff)) {
      afterText = pickDiffDisplayText(diff, 'after');
      const fromDiff = pickDiffDisplayText(diff, 'before');
      if (fromDiff || diff.created) beforeText = fromDiff;
    }
  } else {
    if (diff && diffHasDisplayBody(diff)) {
      beforeText = pickDiffDisplayText(diff, 'before');
      afterText = pickDiffDisplayText(diff, 'after') || contentFromArgs;
    } else if (contentFromArgs) {
      afterText = contentFromArgs;
      if (samePath && prevLive.beforeText != null) {
        beforeText = prevLive.beforeText;
      } else {
        beforeText = await readBeforeText(path, sid);
        if (syncGen != null && syncGen !== liveWriteSyncGenOf(sid)) return;
      }
    } else if (samePath && prevLive) {
      beforeText = prevLive.beforeText;
      afterText = prevLive.afterText;
    }
  }

  const focusLine = computeLastChangedLine(beforeText, afterText);

  if (
    samePath &&
    prevLive.status === status &&
    prevLive.beforeText === beforeText &&
    prevLive.afterText === afterText
  ) {
    if (syncGen != null && syncGen !== liveWriteSyncGenOf(sid)) return;
    emitLiveWriteUi(sid, { incremental: true, revealLastChange: status === 'done' });
    return;
  }

  const next = {
    path,
    norm: normWritePath(path),
    status,
    beforeText,
    afterText,
    diff: enrichLiveWriteDiffStats({
      path,
      beforeText,
      afterText,
      diff
    }),
    focusLine,
    ts: Date.now(),
    sessionId: sid,
    canonicalPath: resolveLiveWriteStoragePath(path, sid)
  };
  setLiveWriteRow(sid, next);
  beforeTextCache.set(beforeTextCacheKey(path, sid), beforeText);

  if (isVisibleLiveWriteSession(sid) && typeof ensureSessionArtifactForLiveWrite === 'function') {
    ensureSessionArtifactForLiveWrite(next.canonicalPath || path, {
      diff: next.diff,
      sessionId: sid
    });
  }
  if (syncGen != null && syncGen !== liveWriteSyncGenOf(sid)) return;
  if (isVisibleLiveWriteSession(sid)) {
    ensureSidePanelOpenForLiveWrite();
    notifyLiveWriteChanged({
      revealLastChange: status === 'done',
      incremental: !!samePath
    });
  }

  if (status === 'done') {
    invalidateBeforeTextCache(path, sid);
    beforeTextCache.set(beforeTextCacheKey(path, sid), beforeText);
    if (isVisibleLiveWriteSession(sid) && typeof scheduleArtifactsUiFlush === 'function') {
      scheduleArtifactsUiFlush();
    }
  }
}

async function syncLiveWriteFromTraceNow(trace, sessionId) {
  if (isLiveWriteSyncSuppressed()) return;
  const sid = resolveLiveWriteSessionId(sessionId);
  if (!sid) return;
  const gen = bumpLiveWriteSyncGen(sid);
  const { pending, lastDone } = findLatestWriteTool(trace);
  if (pending) {
    await setLiveWriteFromTool(pending, 'writing', gen, sid);
    return;
  }
  if (lastDone && (lastDone.diff || resolveWritePathFromTool(lastDone))) {
    const toolForLive = { ...lastDone };
    if (lastDone.diff && typeof compactDiffForTrace === 'function') {
      toolForLive.diff = compactDiffForTrace(lastDone.diff) || lastDone.diff;
    }
    await setLiveWriteFromTool(toolForLive, 'done', gen, sid);
    return;
  }
  if (gen !== liveWriteSyncGenOf(sid)) return;
  const live = liveWriteRow(sid);
  if (live && live.status === 'writing') {
    setLiveWriteRow(sid, null);
    emitLiveWriteUi(sid, { showStaticPreview: true });
    return;
  }
  if (live && live.status === 'done') {
    emitLiveWriteUi(sid, { revealLastChange: true, incremental: true });
  }
}

function syncLiveWriteFromTrace(trace, opts) {
  if (isLiveWriteSyncSuppressed()) return;
  const o = opts && typeof opts === 'object' ? opts : {};
  const sid = resolveLiveWriteSessionId(o.sessionId);
  if (!sid) return;
  if (
    isVisibleLiveWriteSession(sid) &&
    typeof window.shouldSuppressPlanTraceDiff === 'function' &&
    window.shouldSuppressPlanTraceDiff()
  ) {
    return;
  }
  liveWriteSyncPendingBySession.set(sid, trace);
  const { pending } = findLatestWriteTool(trace);

  if (pending) {
    applyLiveWritePreviewFast(pending, 'writing', sid);
    if (liveWriteSyncTimerBySession.has(sid)) return;
    liveWriteSyncTimerBySession.set(
      sid,
      setTimeout(() => {
        liveWriteSyncTimerBySession.delete(sid);
        const pendingTrace = liveWriteSyncPendingBySession.get(sid);
        liveWriteSyncPendingBySession.delete(sid);
        if (pendingTrace) void syncLiveWriteFromTraceNow(pendingTrace, sid);
      }, LIVE_WRITE_DEBOUNCE_MS())
    );
    return;
  }

  clearLiveWriteTimers(sid);
  void syncLiveWriteFromTraceNow(trace, sid);
}

function getActiveLiveWrite(sessionId) {
  if (sessionId != null && String(sessionId).trim()) return liveWriteRow(sessionId);
  return viewLiveWrite();
}

function activateLiveWriteForView(sessionId) {
  const live = liveWriteRow(sessionId);
  notifyLiveWriteChanged({
    showStaticPreview: !live,
    incremental: false,
    revealLastChange: !!(live && live.status === 'done')
  });
}

function clearLiveWrite(opts = {}) {
  const onlySid =
    opts && opts.onlySessionId != null && String(opts.onlySessionId).trim()
      ? String(opts.onlySessionId).trim()
      : '';
  const sid = onlySid || resolveLiveWriteSessionId();
  if (!sid) return;
  const prev = liveWriteRow(sid);
  setLiveWriteRow(sid, null);
  clearLiveWriteTimers(sid);
  if (prev && prev.path && typeof ensureSessionArtifactForLiveWrite === 'function') {
    ensureSessionArtifactForLiveWrite(prev.path, {
      diff: typeof enrichLiveWriteDiffStats === 'function' ? enrichLiveWriteDiffStats(prev) : prev.diff,
      sessionId: prev.sessionId
    });
  }
  if (isVisibleLiveWriteSession(sid)) {
    notifyLiveWriteChanged({ showStaticPreview: true, completedPath: prev && prev.path ? prev.path : null });
    if (typeof window.setLiveWritePanelChrome === 'function') window.setLiveWritePanelChrome(null);
  }
}

function isLiveWritePath(filePath) {
  const live = viewLiveWrite();
  if (!live || !filePath) return false;
  if (typeof window.liveMatchesArtifactPath === 'function') {
    return window.liveMatchesArtifactPath(live, filePath);
  }
  return pathsMatch(filePath, live.path);
}

/** 刷新侧栏 diff 预览，Monaco 单例跟随当前「变更/文件」页 */
function refreshLiveWriteArtifactPreview(opts) {
  const live = viewLiveWrite();
  if (!live || !live.path) return;
  if (typeof isSidePanelOpen === 'function' && !isSidePanelOpen()) return;
  if (typeof window.syncLiveWritePreview === 'function') {
    window.syncLiveWritePreview({
      live,
      incremental: !(opts && opts.incremental === false),
      revealLastChange: !!(opts && opts.revealLastChange) || live.status === 'done'
    });
  }
}

window.resolveToolArgsFromTrace = resolveToolArgsFromTrace;
window.extractPathFieldsFromArgsBrief = extractPathFieldsFromArgsBrief;
window.syncLiveWriteFromTrace = syncLiveWriteFromTrace;
window.pathsMatch = pathsMatch;
window.refreshLiveWriteArtifactPreview = refreshLiveWriteArtifactPreview;
window.beginLiveWriteSyncSuppress = beginLiveWriteSyncSuppress;
window.endLiveWriteSyncSuppress = endLiveWriteSyncSuppress;
window.getActiveLiveWrite = getActiveLiveWrite;
window.activateLiveWriteForView = activateLiveWriteForView;
window.clearLiveWrite = clearLiveWrite;
window.isLiveWritePath = isLiveWritePath;
window.normWritePath = normWritePath;
window.enrichLiveWriteDiffStats = enrichLiveWriteDiffStats;
window.applyLiveWriteFileListMarks = applyLiveWriteFileListMarks;
