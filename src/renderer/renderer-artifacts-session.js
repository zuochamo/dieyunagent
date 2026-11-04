/* global gatewayCall, gwState, isSidePanelOpen, openSidePanel, setSidePanelTab, getSidePanelTab, flatFolderIconSvg, flatFileIconSvg, flatDirUpIconSvg, revealMonacoLine, refreshWorkspaceProblemsPanel, startWorkspaceDiagnosticsScan, normWritePath, pathsMatch, disposeMonacoArtifactEditor, canUseMonacoEditor, getAgentLimits, pickDiffDisplayText, getLastTraceEntryFileChanges, updateProblemsPanel, renderChangesPane, lastAgentDisplayedTrace, computeLineDiffStats, toolDiffHasBody, formatInlineUnifiedDiffHtml, escapeHtml, isEditToolName, editToolFilePath, canonicalArtifactPathFromTool, resolveToolDiffBody, resolveArtifactDiffFromTrace, mammoth, XLSX, withSessionRpcScope, isMonacoArtifactEditorMounted, currentSessionId, resolveSessionWorkspacePathSync, resolveSessionWorkspacePathForRpc, readFallbackArtifactText, applyWorkspaceArtifactPath, renderArtifactsList, artifactViewHasPreview, resetArtifactFollowState, resetArtifactModelCache, revokeArtifactMediaBlobUrls, resolveArtifactPathInWorkspace, loadArtifactContent, markArtifactPathTranslated, getArtifactPathTranslation, clearArtifactPathTranslation, openArtifactTab, resetArtifactsTabs, resetArtifactsEditorShell, paintEmptyArtifactsTabStrip, isMonacoPathDirty, ensureArtifactsEditorMounted */
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

/**
 * 「路径翻译」记录：被权威解析（Gateway 在远程匹配出来的候选）打开的路径 → 原始输入。
 *
 * 只有两个用途：编辑器顶部提示条、保存前的二次确认。
 * 为什么需要确认：这条路径是**系统替用户做的决定**（不是他点的那个文件），
 * 而保存会写向真实远端 —— 写错了不可逆。用户自己从候选里点选的也记一笔，
 * 但只有「唯一候选自动打开」这种系统决策会反复提示。
 */
var artifactPathTranslations = new Map();

function artifactTranslationKey(filePath) {
  return typeof normWritePath === 'function'
    ? normWritePath(filePath)
    : String(filePath || '').replace(/\\/g, '/').toLowerCase();
}

function markArtifactPathTranslated(resolvedPath, info) {
  const key = artifactTranslationKey(resolvedPath);
  if (!key) return;
  artifactPathTranslations.set(key, {
    inputPath: String((info && info.inputPath) || ''),
    kind: String((info && info.kind) || 'picked')
  });
}

function getArtifactPathTranslation(filePath) {
  const key = artifactTranslationKey(filePath);
  return key ? artifactPathTranslations.get(key) || null : null;
}

function clearArtifactPathTranslation(filePath) {
  const key = artifactTranslationKey(filePath);
  if (key) artifactPathTranslations.delete(key);
}
var artifactsWorkspaceRoot = null;
var artifactsWorkspaceKind = 'local';
var artifactsBrowseRel = '';
var artifactsDirEntries = [];
/**
 * 目录条目版本号：entries 整体替换时递增，用于 O(1) 生成列表签名。
 * 大目录下逐项拼接签名是每拍（80ms）的固定开销，这里改成只比版本号。
 */
var artifactsDirEntriesVersion = 0;
var artifactsDirLoading = false;
var artifactsDirRefreshPromise = null;

/** entries 的唯一写入口：版本号与内容同步递增，避免漏递增导致列表不刷新 */
function setArtifactsDirEntries(next) {
  artifactsDirEntries = Array.isArray(next) ? next : [];
  artifactsDirEntriesVersion += 1;
}
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

/**
 * 用户手动保存后：磁盘 mtime 已变，但列表里的 ts 还是旧值。
 * 不对齐的话陈旧判定永远为真（拿 Date.now() 与磁盘 mtime 比），下一次列表刷新会把编辑器
 * 当成「内容过期」强制重载 —— 滚动位置和光标全部丢失。
 * 这里从磁盘取一次真实 mtime，并同步列表项，保证同一拍内 stale 判定一致。
 */
async function syncSelectedArtifactContentMtimeFromDisk(filePath) {
  const fp = String(filePath || '').trim();
  if (!fp) return false;
  try {
    const st = await gatewayCall('fs.stat', await artifactRpcParams({ filePath: fp }));
    const m = Number(st && st.mtimeMs) || 0;
    if (!m) return false;
    if (selectedArtifactPath && artifactPathsEqual(selectedArtifactPath, fp)) {
      selectedArtifactContentMtime = m;
    }
    for (const row of artifactsDirEntries || []) {
      if (row && row.kind === 'file' && artifactPathsEqual(row.path, fp)) {
        row.ts = m;
        break;
      }
    }
    return true;
  } catch {
    return false;
  }
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
  // 别的面板的 diff 预览会卸载 Monaco：回到文件页先补挂（内容在缓存里，零 RPC）
  if (!force && typeof ensureArtifactsEditorMounted === 'function' && ensureArtifactsEditorMounted()) {
    return true;
  }
  // 当前标签有未保存修改：任何「磁盘变了」的判定都不能覆盖用户输入
  if (typeof isMonacoPathDirty === 'function' && isMonacoPathDirty(fp)) return false;

  const diskMtime = findArtifactEntryMtime(fp);
  const mounted =
    typeof window.isMonacoArtifactEditorMounted === 'function' &&
    window.isMonacoArtifactEditorMounted(fp);
  const view = document.getElementById('artifacts-file-view');
  // 预览容器判定统一走 artifactViewHasPreview，避免各处选择器写岔（图片/Office shell 不同）
  const hasPreview = artifactViewHasPreview(view);
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
  // 不属于当前工作区的路径（例如 SSH 会话里混入的本地盘符路径）不进变更行：
  // 它在列表里注定打不开，留着只会误导
  const changes = raw
    .map(function (ch) {
      if (!ch || !ch.path) return ch;
      const resolved = resolveArtifactPathInWorkspace(ch.path);
      return resolved.ok ? { ...ch, path: resolved.path } : null;
    })
    .filter(Boolean);
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
    selectedArtifactPath: bucket.selectedArtifactPath || null,
    sinceTs: Number(bucket.sinceTs) || Date.now()
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

function resolveRowDiffStats(row) {
  const diff = row && row.diff ? row.diff : null;
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
    // 写/删工具的路径归属在 artifactPathFromTool；它对**读类工具**（fs_read_file 看图的场景）
    // 按设计返回空 —— 这里必须继续往 args 走，否则「聊天里展示过的图片」这条来源永远拿不到路径。
    const viaEditTool = artifactPathFromTool(tool);
    if (viaEditTool) return viaEditTool;
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
    selectedArtifactPath: null,
    // 会话窗口起点：产物区据此向文件系统追问「这段窗口里到底改过哪些文件」
    // （脚本 / 截图 / 插件落盘的 docx、xlsx、png 没有写工具，只能从盘上问）。
    sinceTs: Date.now()
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
  const prev = artifactsSessionStore.get(sid);
  artifactsSessionStore.set(sid, {
    sessionArtifacts: sessionArtifacts.slice(),
    sessionFileChangeTotals: { ...sessionFileChangeTotals },
    lastRoundFileChanges: lastRoundFileChanges.slice(),
    selectedArtifactPath,
    // 窗口起点只在会话首次出现时钉住；后续持久化不能把它刷成「现在」，
    // 否则每次重绘都把窗口缩短，早先产出的脚本产物会被判成「不属于本会话」。
    sinceTs: (prev && Number(prev.sinceTs)) || Date.now()
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
  // 产物区的扫描窗口是「会话」口径的：旧会话的窗口结果不能留在新会话的列表里
  if (typeof window.resetProductsScan === 'function') window.resetProductsScan();
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
  if (typeof window.refreshProductsPanelIfActive === 'function') {
    window.refreshProductsPanelIfActive();
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
  setArtifactsDirEntries(artifactsDirEntries.filter((row) => !artifactPathsMatch(row.path, fp)));
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
      // 解析失败说明它不属于当前工作区（如 SSH 会话里混入了本地盘符路径）：
      // 不写入产物记录 —— 否则列表里会出现「点开就报错」的条目，
      // 其路径还会参与 artifactPathsMatch，污染去重与变更匹配。
      const resolved = resolveArtifactPathInWorkspace(fp);
      if (!resolved.ok) return;
      fp = resolved.path;
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
    const skipFlush = !!(meta && meta.skipUiFlush);
    if (!skipFlush && isVisibleArtifactSession(sid)) {
      scheduleArtifactsUiRefresh('light');
    }
  } catch (e) {
    // ignore
  }
}

function cancelArtifactContentLoads() {
  artifactContentLoadGen += 1;
  artifactContentLoadingPath = '';
  artifactContentLoadingAt = 0;
}

/** 切换会话 / 清空产物预览前：先卸 Monaco，再动 DOM，避免 Diff 销毁竞态 */
async function teardownArtifactsMonacoEditor() {
  cancelArtifactContentLoads();
  // 图片/PDF 预览的 blob 也必须在这里释放：切会话 / 切工作区 / 清空产物都会走这条路径，
  // 只在「切换到另一个文件」时 revoke 会让之前看过的媒体字节一直常驻内存。
  if (typeof revokeArtifactMediaBlobUrls === 'function') {
    revokeArtifactMediaBlobUrls(document.getElementById('artifacts-file-view'));
  }
  if (typeof disposeMonacoArtifactEditor === 'function') {
    await disposeMonacoArtifactEditor();
  }
  // 编辑器实例没了，长驻编辑区外壳必须失效（下次用新宿主重建）。
  // 标签也跟着清：调用方都是「切工作区 / 清空产物」，跨工作区留着标签会把
  // SSH 本地/远程的同名路径串成同一条。
  if (typeof resetArtifactsEditorShell === 'function') resetArtifactsEditorShell();
  if (typeof resetArtifactsTabs === 'function') resetArtifactsTabs();
  // 选中项一起清：否则下一次列表重绘会按旧工作区的路径把标签又建回来
  selectedArtifactPath = null;
  selectedArtifactContentMtime = 0;
}

/**
 * @param {HTMLElement} view
 * @param {string} html
 * @param {{ keepTabs?: boolean }} [opts] 关闭最后一个标签时用 keepTabs（标签已空，别再重复清）
 */
async function clearArtifactsFileView(view, html, opts) {
  if (!view) return;
  cancelArtifactContentLoads();
  await teardownArtifactsMonacoEditor();
  if (opts && opts.keepTabs && typeof paintEmptyArtifactsTabStrip === 'function') {
    paintEmptyArtifactsTabStrip();
  }
  if (view.isConnected) view.innerHTML = html;
}

function clearArtifacts() {
  sessionArtifacts.length = 0;
  sessionFileChangeTotals = { files: 0, added: 0, removed: 0 };
  lastRoundFileChanges = [];
  selectedArtifactPath = null;
  selectedArtifactContentMtime = 0;
  cancelArtifactContentLoads();
  if (typeof resetArtifactFollowState === 'function') resetArtifactFollowState();
  if (typeof teardownArtifactsMonacoEditor === 'function') {
    void teardownArtifactsMonacoEditor();
  }
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
  setArtifactsDirEntries([]);
  artifactsDirLoading = false;
  lastDefaultEditorWorkspaceKey = null;
  lastArtifactsFileListSig = '';
  selectedArtifactContentMtime = 0;
  cancelArtifactContentLoads();
  // 产物区的会话扫描结果属于「旧工作区 / 旧窗口」，一并作废（下一次可见时重扫）
  if (typeof window.resetProductsScan === 'function') window.resetProductsScan();
  if (typeof revokeArtifactMediaBlobUrls === 'function') {
    revokeArtifactMediaBlobUrls(document.getElementById('artifacts-file-view'));
  }
  if (typeof resetArtifactModelCache === 'function') resetArtifactModelCache();
  // 工作区换了：标签里的路径与未保存内容都不再成立
  if (typeof resetArtifactsEditorShell === 'function') resetArtifactsEditorShell();
  if (typeof resetArtifactsTabs === 'function') resetArtifactsTabs();
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

var lastDefaultEditorWorkspaceKey = null;
var lastArtifactsFileListSig = '';
var artifactContentLoadGen = 0;

var artifactsUiBatchDepth = 0;
var artifactsUiBatchDirty = false;
/** batch 期间累积的最强刷新类型：一旦出现 full 就保持 full */
var artifactsUiBatchKind = null;

/**
 * 产物面板刷新调度器状态。
 * 语义是 throttle（保证最小间隔），不是 debounce：
 * debounce 在 Agent 思考流这种高频事件下会被无限顺延（饿死），随后一次性爆发，
 * 表现为「文件列表长时间不动、然后猛跳一下」。
 */
var artifactsUiRefreshTimer = null;
var artifactsUiRefreshPendingKind = null;
var artifactsUiRefreshLastAt = 0;

/** 当前正在异步加载预览的文件路径，用于避免同路径重复加载互相打断渲染 */
var artifactContentLoadingPath = '';
var artifactContentLoadingGen = 0;
/** 加载开始时间：异常路径留下的标记不能永久挡住后续点击 */
var artifactContentLoadingAt = 0;
/** 超过该时长仍认为「在加载中」，视为失效标记并放行（远大于正常读盘+挂载耗时） */
var ARTIFACT_CONTENT_LOADING_STALE_MS = 30000;

function artifactsUiRefreshIntervalMs() {
  const v =
    typeof getAgentLimits === 'function' ? Number(getAgentLimits().artifactsUiFlushMs) : NaN;
  return Number.isFinite(v) && v > 0 ? v : 80;
}

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
    const kind = artifactsUiBatchKind === 'light' ? 'light' : 'full';
    artifactsUiBatchKind = null;
    flushArtifactsUiNow(kind);
  }
}

/** @param {'light'|'full'} [kind] 默认 light（仅重绘列表数据） */
function markArtifactsUiDirty(kind) {
  if (!isArtifactsUiBatching()) return false;
  artifactsUiBatchDirty = true;
  if (artifactsUiBatchKind === 'full') return true;
  artifactsUiBatchKind = kind === 'full' ? 'full' : artifactsUiBatchKind || 'light';
  return true;
}

/** batch 结束必须拿到最新磁盘视图（否则新文件不会出现在列表里） */
function forceArtifactsUiRefreshAfterBatch() {
  if (!isArtifactsUiBatching()) return;
  artifactsUiBatchDirty = true;
  artifactsUiBatchKind = 'full';
}

function isArtifactContentLoading(filePath) {
  if (!artifactContentLoadingPath) return false;
  if (
    artifactContentLoadingAt > 0 &&
    Date.now() - artifactContentLoadingAt > ARTIFACT_CONTENT_LOADING_STALE_MS
  ) {
    // 标记疑似残留（加载异常未走清理）：放行，否则该文件会永久「点了没反应」
    artifactContentLoadingPath = '';
    artifactContentLoadingAt = 0;
    return false;
  }
  return artifactPathsEqual(artifactContentLoadingPath, filePath);
}

function beginArtifactContentLoad(filePath, gen) {
  artifactContentLoadingPath = String(filePath || '');
  artifactContentLoadingGen = Number(gen) || 0;
  artifactContentLoadingAt = Date.now();
}

/** 只有「最新一次加载」结束时才清标记，避免旧加载清掉新加载的状态 */
function endArtifactContentLoad(gen) {
  if (gen != null && Number(gen) !== artifactContentLoadingGen) return;
  artifactContentLoadingPath = '';
  artifactContentLoadingAt = 0;
}

/** 重绘产物列表 + 变更面板 + 产物区（三个 pane 共用同一拍刷新，避免各自扫描） */
function refreshArtifactsPaneViews() {
  renderArtifactsList({ skipRefresh: true });
  if (typeof window.patchChangesPane === 'function') {
    window.patchChangesPane();
  } else if (typeof renderChangesPane === 'function') {
    renderChangesPane();
  }
  // 产物区是 sessionArtifacts 的只读索引：同一份数据，同一拍刷新（pane 不可见时自带短路）
  if (typeof window.refreshProductsPanelIfActive === 'function') {
    window.refreshProductsPanelIfActive();
  }
}

/**
 * @param {'light'|'full'} [kind] 默认 full（兼容旧调用点）
 * light：只重绘内存数据，不发 RPC、不主动重载编辑器；
 * full ：强制 list_dir 后再重绘（文件系统确实变化时用）。
 */
function flushArtifactsUiNow(kind) {
  if (typeof isSidePanelOpen === 'function' && !isSidePanelOpen()) return;
  // 未显式指定 light（或列表尚未加载过）时按 full 处理，保持旧调用点语义不变
  const needFull = kind !== 'light' || !workspaceArtifactsLoaded;
  if (!needFull) {
    refreshArtifactsPaneViews();
    return;
  }
  // 缓存就绪时仍强制 list_dir：否则 mtime 不更新，打开中的文件预览会一直停在旧内容
  void refreshArtifactsDirectory(true).then(function () {
    refreshArtifactsPaneViews();
  });
}

/**
 * 产物面板刷新的唯一入口（单一来源）。
 * kind = 'light'：数据更新（trace / track）用，思考流只走这条，开销与文件系统无关；
 * kind = 'full' ：文件系统可能变化（工具执行完成 / 切页 / 用户操作）用。
 * throttle：持续事件下按最小间隔周期性刷新，而不是被无限顺延。
 */
function scheduleArtifactsUiRefresh(kind) {
  const want = kind === 'full' ? 'full' : 'light';
  if (isArtifactsUiBatching()) {
    markArtifactsUiDirty(want);
    return;
  }
  if (typeof isSidePanelOpen === 'function' && !isSidePanelOpen()) return;
  if (want === 'full' || !artifactsUiRefreshPendingKind) {
    artifactsUiRefreshPendingKind = want;
  }
  if (artifactsUiRefreshTimer) return;
  const interval = artifactsUiRefreshIntervalMs();
  const elapsed = Date.now() - artifactsUiRefreshLastAt;
  const wait = elapsed >= interval ? 0 : interval - elapsed;
  artifactsUiRefreshTimer = setTimeout(function () {
    artifactsUiRefreshTimer = null;
    const pendingKind = artifactsUiRefreshPendingKind || 'light';
    artifactsUiRefreshPendingKind = null;
    artifactsUiRefreshLastAt = Date.now();
    flushArtifactsUiNow(pendingKind);
  }, wait);
}

/** 兼容旧调用点：数据更新语义 = light */
function scheduleArtifactsUiFlush() {
  scheduleArtifactsUiRefresh('light');
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
  const view = document.getElementById('artifacts-file-view');
  if (pick && typeof openArtifactTab === 'function') {
    // 用户主动打开：允许在本地映射失败时向 Gateway 要一次权威解析
    openArtifactTab(pick, { force: true, authoritative: true });
  } else if (pick && view && typeof loadArtifactContent === 'function') {
    selectedArtifactPath = pick;
    selectedArtifactContentMtime = 0;
    loadArtifactContent(pick, view, { authoritative: true });
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
  if (typeof openArtifactTab === 'function') {
    // 来自问题面板 / 搜索结果的路径：可能是「别的视角」的路径，允许权威解析兜底
    openArtifactTab(fp, { force: true, authoritative: true });
  } else {
    selectedArtifactPath = fp;
    selectedArtifactContentMtime = 0;
    const view = document.getElementById('artifacts-file-view');
    if (view && typeof loadArtifactContent === 'function') {
      loadArtifactContent(fp, view, { force: true, authoritative: true });
    } else if (typeof renderArtifactsList === 'function') {
      renderArtifactsList({ skipRefresh: true });
    }
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
