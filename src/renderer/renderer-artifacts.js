/* global gatewayCall, gwState, isSidePanelOpen, openSidePanel, setSidePanelTab, getSidePanelTab, flatFolderIconSvg, flatFileIconSvg, flatDirUpIconSvg, revealMonacoLine, refreshWorkspaceProblemsPanel, startWorkspaceDiagnosticsScan, normWritePath, pathsMatch, disposeMonacoArtifactEditor, canUseMonacoEditor, getAgentLimits, pickDiffDisplayText, getLastTraceEntryFileChanges, updateProblemsPanel, renderChangesPane, lastAgentDisplayedTrace, computeLineDiffStats, toolDiffHasBody, formatInlineUnifiedDiffHtml, escapeHtml, isEditToolName, editToolFilePath, canonicalArtifactPathFromTool, resolveToolDiffBody, resolveArtifactDiffFromTrace, mammoth, XLSX, withSessionRpcScope, isMonacoArtifactEditorMounted, currentSessionId, resolveSessionWorkspacePathSync, resolveSessionWorkspacePathForRpc, readFallbackArtifactText, scheduleArtifactsUiRefresh, isArtifactContentLoading, beginArtifactContentLoad, endArtifactContentLoad, followArtifactEditorOnWrite, isArtifactEditorFollowCurrent, syncSelectedArtifactContentMtimeFromDisk, resolveArtifactPathInWorkspace, resolveArtifactPathViaGateway, getArtifactPathTranslation, clearArtifactPathTranslation, markArtifactPathTranslated, openArtifactTab, syncArtifactTabAfterLoad, syncArtifactTabsWithSelection, isMonacoPathDirty, renderArtifactEditor */
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

/**
 * 「聊天里展示过的图片」也算本会话产物。
 *
 * 为什么需要这条来源：图片常常不是用 fs_write 写的（UE 渲染、ffmpeg/PIL 缩放、
 * 截图工具都走 host_exec 或自己的工具），trace 里没有写工具，产物区就会漏掉
 * 「用户明明在聊天里看到过这张图」的条目。而 fs_read_file + encoding=base64
 * 且落成图片的调用，正是「这张图被展示给用户了」的精确信号，且 toolArgs 会
 * 随 trace 持久化（历史会话 replay 也能重建）。
 *
 * 只看 args、不看工具结果：失败调用（如 IMAGE_TOO_LARGE）不算展示过。
 */
var READ_IMAGE_TOOL_NAMES = ['fs_read_file', 'fs.read_file'];

function isImagePreviewToolCall(tool, resolvedPath) {
  if (!tool || tool.failed || tool.pending) return false;
  const name = String(tool.name || '').toLowerCase();
  if (READ_IMAGE_TOOL_NAMES.indexOf(name) < 0) return false;
  const args =
    tool.toolArgs && typeof tool.toolArgs === 'object'
      ? tool.toolArgs
      : typeof window !== 'undefined' && typeof window.resolveToolArgsFromTrace === 'function'
        ? window.resolveToolArgsFromTrace(tool) || {}
        : {};
  if (String(args.encoding || '').toLowerCase() !== 'base64') return false;
  const p = resolvedPath || toolArtifactPath(tool);
  return !!p && IMAGE_ARTIFACT_RE.test(p);
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
      if (!isEditToolName(tool.name) || !p || tool.failed) {
        // 展示过的图片没有写工具，但确实进了本会话产物（见 isImagePreviewToolCall 注释）
        if (p && isImagePreviewToolCall(tool, p)) {
          latestByPath.set(p, { diff: null, order: order++ });
        }
        continue;
      }
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
  // 先把「最新一次写入」增量喂给编辑区（零 RPC、不重建编辑器），再排列表重绘
  if (typeof followArtifactEditorOnWrite === 'function') {
    followArtifactEditorOnWrite(trace, { sessionId });
  }
  // 思考流只是「数据更新」，走 light 刷新：不发 list_dir、不打断正在看的编辑器
  scheduleArtifactsUiRefresh('light');
}

function renderLastRoundFileRows(list, view, dirEntries) {
  if (!lastRoundFileChanges.length) return;
  const missing = lastRoundFileChanges.filter(function (f) {
    if (
      (dirEntries || []).some(function (row) {
        return row.kind === 'file' && artifactPathsMatch(row.path, f.path);
      })
    ) {
      return false;
    }
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

/**
 * 创建一行文件/目录项。
 * @param {HTMLElement} list 滚动容器（用于清除 active 高亮）
 * @param {object} [opts] skipAppend=true 时不自动挂载（虚拟列表自行定位后挂载）
 * @returns {HTMLElement}
 */
function renderArtifactRow(list, view, row, opts) {
  const diffStats = resolveRowDiffStats(row);
  const diff = formatArtifactDiffHtml(diffStats);
  const remoteTag = row.remote ? ' <span class="artifacts-file-remote">远程</span>' : '';
  const icon = row.kind === 'dir' ? flatFolderIconSvg(16) : flatFileIconSvg(16);
  const el = document.createElement('div');
  el.className = 'artifacts-file-item' + (row.kind === 'dir' ? ' is-dir' : '');
  if (row.kind === 'file') {
    el.setAttribute('data-file-path', row.path);
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
      // 与「..」同一口径：换目录不动标签
      refreshArtifactsDirectory(true).then(function () {
        if (isSidePanelOpen()) renderArtifactsList({ skipRefresh: true });
      });
      return;
    }
    const items = list.querySelectorAll('.artifacts-file-item');
    for (let j = 0; j < items.length; j++) items[j].classList.remove('active');
    el.classList.add('active');
    // 打开成标签：已开着的直接激活（再点一次同一个文件仍会强制从磁盘重载）
    if (typeof openArtifactTab === 'function') {
      openArtifactTab(row.path);
      return;
    }
    selectedArtifactPath = row.path;
    selectedArtifactContentMtime = 0;
    loadArtifactContent(row.path, view, { force: true });
  });
  if (!(opts && opts.skipAppend)) list.appendChild(el);
  return el;
}

/** 虚拟列表参数：低于阈值时退回全量渲染，保证小目录视觉与行为完全不变 */
var ARTIFACTS_VIRTUALIZE_MIN_ROWS = 120;
var ARTIFACTS_VIRTUAL_ROW_H = 26;
var ARTIFACTS_VIRTUAL_BUFFER = 8;
var artifactsVirtualScrollBound = false;
var artifactsVirtualRaf = null;

/** host 在滚动容器内容坐标系中的顶部偏移（用 rect 差值，避免依赖 offsetParent） */
function artifactsVirtualHostOffsetTop(list, host) {
  return host.getBoundingClientRect().top - list.getBoundingClientRect().top + list.scrollTop;
}

/**
 * 只渲染可视窗口内的行（含上下缓冲），大目录不再一次性铺满 DOM。
 * 行高固定为 ARTIFACTS_VIRTUAL_ROW_H，用绝对定位摆放。
 */
function renderArtifactsVirtualWindow(list, host, opts) {
  const rows = host && host._rows;
  if (!Array.isArray(rows) || !rows.length) return;
  const view = host._view;
  const ROW_H = ARTIFACTS_VIRTUAL_ROW_H;
  // 只在高度真的需要变时才写，避免「每帧写样式 + 读 rect」触发同步布局
  const nextHeight = rows.length * ROW_H + 'px';
  if (host.style.height !== nextHeight) host.style.height = nextHeight;
  const viewTop = list.scrollTop - artifactsVirtualHostOffsetTop(list, host);
  const viewH = list.clientHeight || 0;
  const start = Math.max(0, Math.floor(viewTop / ROW_H) - ARTIFACTS_VIRTUAL_BUFFER);
  const end = Math.min(
    rows.length,
    Math.ceil((Math.max(0, viewTop) + viewH) / ROW_H) + ARTIFACTS_VIRTUAL_BUFFER
  );
  if (!(opts && opts.force)) {
    const prev = host._range;
    if (prev && prev.start === start && prev.end === end) return;
  }
  host._range = { start, end };
  host.replaceChildren();
  for (let i = start; i < end; i++) {
    const el = renderArtifactRow(list, view, rows[i], { skipAppend: true });
    if (!el) continue;
    el.style.position = 'absolute';
    el.style.left = '0';
    el.style.right = '0';
    el.style.top = i * ROW_H + 'px';
    el.style.height = ROW_H + 'px';
    el.style.boxSizing = 'border-box';
    host.appendChild(el);
  }
}

/** 滚动时按帧重算窗口；只绑一次（容器元素常驻） */
function bindArtifactsVirtualScroll(list) {
  if (artifactsVirtualScrollBound) return;
  artifactsVirtualScrollBound = true;
  list.addEventListener('scroll', function () {
    if (artifactsVirtualRaf) return;
    artifactsVirtualRaf = requestAnimationFrame(function () {
      artifactsVirtualRaf = null;
      const host = list.querySelector('.artifacts-virtual-list');
      if (host) renderArtifactsVirtualWindow(list, host);
    });
  });
}

/**
 * 列表签名：用「版本号 + 行数 + 首尾行」判定目录内容是否变化，不再逐项拼接
 * —— 大目录下逐项拼接是每 80ms 一次的固定开销。
 * 注意：entries 的任何替换都必须走 setArtifactsDirEntries（它负责递增版本号），
 * 否则会漏刷新。
 */
function artifactsFileListSig() {
  const entries = artifactsDirEntries;
  const head = entries.length ? entries[0] : null;
  const tail = entries.length ? entries[entries.length - 1] : null;
  const entrySig = [
    artifactsDirEntriesVersion,
    entries.length,
    head ? (head.kind || '') + ':' + (head.path || '') + ':' + (head.ts || 0) : '',
    tail ? (tail.kind || '') + ':' + (tail.path || '') + ':' + (tail.ts || 0) : ''
  ].join(':');
  return [
    artifactsBrowseRel,
    selectedArtifactPath,
    entrySig,
    lastRoundFileChanges
      .map(function (f) {
        return String(f.path || '') + ':' + (f.pending ? 'p' : '') + ':' + (f.added || 0) + ':' + (f.removed || 0);
      })
      .join('|')
  ].join('::');
}

/**
 * 预览容器判定（单一来源）。
 * 文件编辑器 shell = artifacts-editor-shell；Office / 图片预览 shell = artifacts-office-preview。
 * 图片 <img> 自身的 class 是 artifacts-image-preview-img，不在 shell 层，不能只判断 img。
 */
var ARTIFACT_PREVIEW_SELECTOR =
  '.artifacts-editor-shell, .artifacts-office-preview, .monaco-artifact-editor';

function artifactViewHasPreview(view) {
  return !!view && !!view.querySelector(ARTIFACT_PREVIEW_SELECTOR);
}

/**
 * 编辑器同步兜底：超过该时长没跟磁盘对齐过，就强制校验一次。
 * 走的是原地刷新（内容不变即 no-op），所以只是「静默读盘一次」的成本；
 * 远程 SSH 工作区读盘更贵，因此取值偏保守。
 */
var ARTIFACTS_EDITOR_MAX_STALE_MS = 30000;
var artifactEditorLastSyncAt = Date.now();

/**
 * 选中文件预览的同步入口（编辑区唯一入口）。
 * 关键点：同一路径正在异步加载时直接跳过，否则「列表重绘 → 尚未挂载 → 再次加载 →
 * 递增 gen 丢弃上一次 → 再次尚未挂载」会形成自激循环，编辑器永远停在「加载中…」。
 * 已有预览（Monaco / 文本域 / Office / 图片）时只在磁盘 mtime 变化才强制重载。
 */
function syncSelectedArtifactEditorFromList(view) {
  if (!view || !selectedArtifactPath) return false;
  // 两个早退闸（正在加载 / 跟随刚写过）只在「未超时」时生效；超时后放行一次，
  // 避免极端情况下长期不跟随磁盘变化。
  const overdue = Date.now() - artifactEditorLastSyncAt > ARTIFACTS_EDITOR_MAX_STALE_MS;
  if (!overdue) {
    if (
      typeof isArtifactContentLoading === 'function' &&
      isArtifactContentLoading(selectedArtifactPath)
    ) {
      return false;
    }
    if (
      typeof isArtifactEditorFollowCurrent === 'function' &&
      isArtifactEditorFollowCurrent(selectedArtifactPath)
    ) {
      return false;
    }
  }
  const mounted =
    typeof window.isMonacoArtifactEditorMounted === 'function' &&
    window.isMonacoArtifactEditorMounted(selectedArtifactPath);
  const hasPreview = artifactViewHasPreview(view);
  if (!mounted && !hasPreview) {
    loadArtifactContent(selectedArtifactPath, view);
    artifactEditorLastSyncAt = Date.now();
    return true;
  }
  syncSelectedArtifactContentMtimeFromList();
  const diskMtime = findArtifactEntryMtime(selectedArtifactPath);
  const contentStale =
    !!diskMtime && !!selectedArtifactContentMtime && diskMtime !== selectedArtifactContentMtime;
  // 超时兜底：即使 mtime 判定「没变」也回读一次，保证最终一致（原地刷新，几乎零成本）
  if (!contentStale && !overdue) return false;
  loadArtifactContent(selectedArtifactPath, view, { force: true });
  artifactEditorLastSyncAt = Date.now();
  return true;
}

function paintArtifactsFileList(list, view) {
  const sig = artifactsFileListSig();
  if (sig === lastArtifactsFileListSig && list.childElementCount > 0) {
    // 列表内容没变，但面板可能刚由隐藏变可见（clientHeight 从 0 恢复），窗口需要重算
    const host = list.querySelector('.artifacts-virtual-list');
    if (host) renderArtifactsVirtualWindow(list, host);
    if (view) syncSelectedArtifactEditorFromList(view);
    return;
  }
  lastArtifactsFileListSig = sig;
  // replaceChildren 会让内容高度瞬间塌陷，scrollTop 可能被浏览器归零；后面重建完再恢复
  const prevScrollTop = list.scrollTop;
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
      // 标签保持不动：换目录只换列表内容，已打开的文件仍在标签条里
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

  renderLastRoundFileRows(list, view, artifactsDirEntries);

  // 选中项由标签决定：切目录不再自动选中第一个文件（那会让每翻一次目录都多开一个标签）
  if (typeof syncArtifactTabsWithSelection === 'function') syncArtifactTabsWithSelection();

  if (artifactsDirEntries.length >= ARTIFACTS_VIRTUALIZE_MIN_ROWS) {
    // 大目录：先按总行数把滚动高度撑开，再只渲染可视窗口内的行
    const host = document.createElement('div');
    host.className = 'artifacts-virtual-list';
    host.style.position = 'relative';
    host.style.width = '100%';
    host.style.height = artifactsDirEntries.length * ARTIFACTS_VIRTUAL_ROW_H + 'px';
    host._rows = artifactsDirEntries;
    host._view = view;
    list.appendChild(host);
    bindArtifactsVirtualScroll(list);
    list.scrollTop = prevScrollTop;
    renderArtifactsVirtualWindow(list, host, { force: true });
  } else {
    for (var i = 0; i < artifactsDirEntries.length; i++) {
      renderArtifactRow(list, view, artifactsDirEntries[i]);
    }
    list.scrollTop = prevScrollTop;
  }

  if (view) {
    if (selectedArtifactPath) {
      syncSelectedArtifactEditorFromList(view);
    } else if (!artifactsDirEntries.length) {
      // 目录为空只清预览，不动标签（标签里的文件不属于当前目录）
      void clearArtifactsFileView(
        view,
        '<div class="artifacts-empty">选择文件查看内容</div>',
        { keepTabs: true }
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

/** 加载/切换前清空该文件的诊断面板（诊断由新挂载的编辑器重新上报） */
function resetArtifactProblemsFor(filePath) {
  if (typeof updateProblemsPanel === 'function') updateProblemsPanel(filePath, []);
}

function loadArtifactContent(filePath, viewEl, opts) {
  if (!viewEl) return;
  const fp = String(filePath || '').trim();
  const force = !!(opts && opts.force);

  // 同路径已在加载：直接跳过（即便 force 也没必要打断重来，结果一样）
  if (typeof isArtifactContentLoading === 'function' && isArtifactContentLoading(fp)) {
    return;
  }

  const mounted =
    typeof window.isMonacoArtifactEditorMounted === 'function' &&
    window.isMonacoArtifactEditorMounted(fp);

  if (mounted) {
    const diskMtime = findArtifactEntryMtime(fp);
    const contentStale =
      !!diskMtime &&
      !!selectedArtifactContentMtime &&
      artifactPathsEqual(selectedArtifactPath, fp) &&
      diskMtime !== selectedArtifactContentMtime;
    if (!force && !contentStale) {
      resetArtifactProblemsFor(fp);
      return;
    }
    // 已挂载的文本编辑器：优先原地增量刷新（保留滚动/光标），失败再完整重载。
    // 「再点一次同一文件」与「超时兜底校验」都走这条。
    resetArtifactProblemsFor(fp);
    void refreshMountedArtifactTextInPlace(fp, viewEl).then((ok) => {
      if (!ok) void loadArtifactContentAsync(fp, viewEl, ++artifactContentLoadGen, opts);
    });
    return;
  }

  resetArtifactProblemsFor(fp);
  void loadArtifactContentAsync(fp, viewEl, ++artifactContentLoadGen, opts);
}

var OFFICE_ARTIFACT_READ_MAX_BYTES = 16 * 1024 * 1024;
var IMAGE_ARTIFACT_RE = /\.(png|jpe?g|gif|webp|bmp|svg|heic|tiff?|ico|avif)$/i;
/**
 * 音视频：与 Main 侧 `src/main/media-protocol.js:MEDIA_MIME` 同一份扩展名知识
 * （跨进程无法共享模块，与 IMAGE_ARTIFACT_RE 的既有做法一致）。
 */
var MEDIA_ARTIFACT_RE = /\.(mp4|m4v|webm|ogv|mov|mkv|mp3|wav|m4a|aac|ogg|oga|opus|flac)$/i;

/** 'video' | 'audio' | '' —— 决定产物面板里给 <video> 还是 <audio> */
function mediaArtifactKind(filePath) {
  const p = String(filePath || '').toLowerCase();
  if (!MEDIA_ARTIFACT_RE.test(p)) return '';
  return /\.(mp4|m4v|webm|ogv|mov|mkv)$/.test(p) ? 'video' : 'audio';
}

/**
 * 可 seek 的媒体 URL（`dieyun-media://`，协议实现见 `src/main/media-protocol.js`）。
 *
 * **不读字节**：媒体元素自己去要 Range，Main 再把每一段翻译成 Gateway 的
 * `artifact.read_file`（offset/maxBytes）—— 几十上百 MB 的视频也因此能拖进度、不炸内存。
 *
 * 带上与 RPC 同一套工作区上下文：`s` = 会话 id，`w` = 该会话的工作区路径，
 * 否则多工作区 / 远端会话会读到别的目录去。
 */
function artifactMediaUrl(filePath, opts) {
  const o = opts && typeof opts === 'object' ? opts : {};
  const parts = ['p=' + encodeURIComponent(String(filePath || '').trim())];
  if (o.sessionId) parts.push('s=' + encodeURIComponent(String(o.sessionId)));
  if (o.workspacePath) parts.push('w=' + encodeURIComponent(String(o.workspacePath)));
  return 'dieyun-media://file?' + parts.join('&');
}

/** 当前会话上下文下的媒体 URL（会话 id / 工作区路径都取既有单一来源） */
function artifactMediaUrlForCurrentSession(filePath) {
  const sid = typeof resolveArtifactSessionId === 'function' ? resolveArtifactSessionId() : '';
  let workspacePath = '';
  if (sid && typeof resolveSessionWorkspacePathForRpc === 'function') {
    try {
      workspacePath = resolveSessionWorkspacePathForRpc(sid) || '';
    } catch {
      workspacePath = '';
    }
  }
  if (!workspacePath && typeof window !== 'undefined' && window.activeViewSessionWorkspacePath) {
    workspacePath = String(window.activeViewSessionWorkspacePath);
  }
  return artifactMediaUrl(filePath, { sessionId: sid, workspacePath });
}

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

/**
 * 图片字节 → blob URL 的**唯一实现**（产物面板预览、回答里的图共用）。
 * 调用方负责把 URL 写进 `data-artifact-blob-url` 并 revoke（见 revokeArtifactMediaBlobUrls）。
 */
function imageObjectUrlFromBase64(base64, filePath) {
  const bytes = base64ToUint8Array(base64);
  if (!bytes.length) return '';
  return URL.createObjectURL(new Blob([bytes], { type: guessImageArtifactMime(filePath) }));
}

/** 聊天里内联图片的读取上限：超过就不内联（只留「在面板打开」），避免每张 4K 截图都整张读进渲染进程 */
var CHAT_IMAGE_INLINE_MAX_BYTES = 3 * 1024 * 1024;

/**
 * 图片产物 → blob URL（聊天内图片的唯一读取入口）。
 *
 * 路径解析与读权限全部复用 `readArtifactFileBase64` / Gateway（含 SSH 远端与
 * `.dieyun/tool-output/vision/...` 这类宿主机虚拟路径），渲染进程不碰白名单。
 *
 * @param {string} filePath
 * @param {{ maxBytes?: number }} [opts]
 * @returns {Promise<string|null>} 读不到 / 太大 / 不是图片时返回 null
 */
async function loadArtifactImageObjectUrl(filePath, opts) {
  const fp = String(filePath || '').trim();
  if (!fp || !IMAGE_ARTIFACT_RE.test(fp)) return null;
  const maxBytes =
    opts && Number(opts.maxBytes) > 0
      ? Math.floor(Number(opts.maxBytes))
      : CHAT_IMAGE_INLINE_MAX_BYTES;
  const r = await readArtifactFileBase64(fp, maxBytes);
  if (!r || r.truncated === true) return null;
  return imageObjectUrlFromBase64(r.data, fp) || null;
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
    const url = imageObjectUrlFromBase64(r && r.data, readPath);
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

/**
 * 用系统播放器打开（媒体在应用内播不了 / 文件过大时的兜底）。
 *
 * 路径校验不在渲染进程也不在 Main 重写：Main 的 `media:open-path` 会先让 Gateway
 * 解析并校验路径，再调系统默认程序。桥不在（手机端）时返回 false，调用方自己降级。
 * @returns {boolean} 是否已经把请求发出去了
 */
function openLocalPathInSystemPlayer(filePath) {
  const p = String(filePath || '').trim();
  if (!p) return false;
  const api = typeof window !== 'undefined' ? window.diecloud : null;
  if (!api || typeof api.openLocalPath !== 'function') return false;
  void api
    .openLocalPath(p)
    .then((r) => {
      if (r && r.ok === false && typeof showAgentToast === 'function') {
        showAgentToast('打不开这个文件', String(r.error || ''), { variant: 'error' });
      }
    })
    .catch(() => {
      /* 用户取消 / 桥异常：不吵 */
    });
  return true;
}

/**
 * 音视频预览：不读字节，给媒体元素一个可 seek 的 `dieyun-media://` 源。
 * 播不了（编码不支持 / 文件读不到）时降级成「用系统播放器打开」，不留一个死播放器。
 */
function renderMediaArtifactPreview(viewEl, displayPath, readPath, kind) {
  viewEl.innerHTML = '';
  const shell = document.createElement('div');
  shell.className = 'artifacts-office-preview artifacts-media-preview';

  const head = document.createElement('div');
  head.className = 'artifacts-editor-head';
  const pathEl = document.createElement('span');
  pathEl.className = 'artifacts-editor-path';
  pathEl.textContent = displayPath;
  pathEl.title = displayPath;
  const hint = document.createElement('span');
  hint.className = 'artifacts-office-preview-hint';
  hint.textContent = kind === 'video' ? '视频只读预览' : '音频只读预览';
  const openBtn = document.createElement('button');
  openBtn.type = 'button';
  openBtn.className = 'ghost-btn';
  openBtn.textContent = '用系统播放器打开';
  openBtn.addEventListener('click', () => openLocalPathInSystemPlayer(readPath));
  head.append(pathEl, hint, openBtn);
  shell.appendChild(head);

  const body = document.createElement('div');
  body.className = 'artifacts-office-preview-body artifacts-media-preview-body';

  const el = document.createElement(kind === 'video' ? 'video' : 'audio');
  el.className = 'artifacts-media-preview-el';
  el.controls = true;
  el.preload = 'metadata';
  if (kind === 'video') el.playsInline = true;
  el.src = artifactMediaUrlForCurrentSession(readPath);
  el.addEventListener('error', () => {
    const existing = body.querySelector('.artifacts-empty');
    if (existing) return;
    el.remove();
    const empty = document.createElement('div');
    empty.className = 'artifacts-empty';
    empty.textContent = '应用内播不了这个文件（编码不支持或文件读不到），可用系统播放器打开';
    body.appendChild(empty);
  });
  body.appendChild(el);

  shell.appendChild(body);
  viewEl.appendChild(shell);
}

/** 读文本文件（artifact.read_file → fs.read_file 回退），返回正文与截断标记 */
async function readArtifactTextFile(filePath, wsCtx, precomputedReadPath) {
  const readPath =
    precomputedReadPath || applyWorkspaceArtifactPath(resolveArtifactReadPath(filePath), wsCtx);
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
  return {
    readPath,
    text: r && r.data ? String(r.data) : '',
    truncated: !!(r && r.truncated)
  };
}

/**
 * 原地刷新已挂载的文本预览：读盘后用 applyEdits 增量替换，保留滚动位置与光标。
 * 「再点一次同一文件重新加载」与「长时间未同步的兜底校验」都走它，
 * 避免刷新一次就把编辑器整个重建（重建会丢滚动位置并闪烁）。
 * @returns {Promise<boolean>} true = 已原地刷新；false = 调用方应走完整重载
 */
async function refreshMountedArtifactTextInPlace(filePath, viewEl) {
  if (
    typeof isMonacoArtifactEditorMounted !== 'function' ||
    !isMonacoArtifactEditorMounted(filePath) ||
    typeof updateMonacoArtifactEditorText !== 'function'
  ) {
    return false;
  }
  // 用户在这个标签里改过还没保存：读盘刷新等于丢弃输入，直接当「已是最新」
  if (typeof isMonacoPathDirty === 'function' && isMonacoPathDirty(filePath)) return true;
  const gen = ++artifactContentLoadGen;
  if (typeof beginArtifactContentLoad === 'function') beginArtifactContentLoad(filePath, gen);
  try {
    let wsCtx = null;
    try {
      wsCtx = await getWorkspaceContext();
      const { readPath, text, truncated } = await readArtifactTextFile(filePath, wsCtx);
      if (gen !== artifactContentLoadGen) return true;
      if (truncated) return false; // 截断正文不能作为完整视图，交给完整重载
      updateMonacoArtifactEditorText(readPath, text, { appendOnly: false });
      if (gen === artifactContentLoadGen) rememberSelectedArtifactContentMtime(readPath);
      if (typeof syncSelectedArtifactContentMtimeFromDisk === 'function') {
        void syncSelectedArtifactContentMtimeFromDisk(readPath);
      }
      return true;
    } catch {
      return false; // 读盘失败：交给完整重载走 fallback / 错误提示
    }
  } finally {
    if (typeof endArtifactContentLoad === 'function') endArtifactContentLoad(gen);
  }
}

/**
 * 候选选择视图：本地映射失败、Gateway 在远程按尾部特征找到了可能的文件。
 *
 * 必须同时给出「相对路径」和「完整远程路径」——只显示文件名的话，
 * 用户无法分辨 src/a.ts 与 lib/a.ts，选错就会打开（并可能保存）到错误的文件。
 */
function renderArtifactPathCandidates(viewEl, inputPath, payload) {
  viewEl.innerHTML = '';
  const shell = document.createElement('div');
  shell.className = 'artifacts-path-resolve';

  const head = document.createElement('div');
  head.className = 'artifacts-editor-head';
  const title = document.createElement('span');
  title.className = 'artifacts-editor-path';
  title.textContent = '未在远程找到该路径';
  title.title = inputPath;
  head.appendChild(title);
  shell.appendChild(head);

  const note = document.createElement('div');
  note.className = 'artifacts-editor-note';
  note.textContent =
    (payload && payload.reason
      ? payload.reason
      : '原路径在远程不存在。以下是文件名匹配到的候选，请确认后打开：') +
    '（选择后会打开该文件，并对它的保存操作保持真实远端路径）';
  shell.appendChild(note);

  const list = document.createElement('div');
  list.className = 'artifacts-path-candidates agent-scroll';
  const candidates = Array.isArray(payload && payload.candidates) ? payload.candidates : [];
  for (const c of candidates) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'artifacts-path-candidate';
    btn.title = c.path;

    const main = document.createElement('span');
    main.className = 'artifacts-path-candidate-main';
    main.textContent = c.relativePath || c.path;
    btn.appendChild(main);

    if (c.path && c.relativePath && c.path !== c.relativePath) {
      const full = document.createElement('span');
      full.className = 'artifacts-path-candidate-full';
      full.textContent = c.path;
      btn.appendChild(full);
    }

    btn.addEventListener('click', function () {
      // 用户点选 = 明确的决定（不是系统替他猜），照常打开，不再重复追问
      if (typeof markArtifactPathTranslated === 'function') {
        markArtifactPathTranslated(c.path, { inputPath: inputPath, kind: 'picked' });
      }
      if (typeof openArtifactTab === 'function') {
        openArtifactTab(c.path, { force: true, authoritative: true });
        return;
      }
      selectedArtifactPath = c.path;
      selectedArtifactContentMtime = 0;
      loadArtifactContent(c.path, viewEl, { force: true });
      if (typeof renderArtifactsList === 'function') renderArtifactsList({ skipRefresh: true });
    });
    list.appendChild(btn);
  }
  shell.appendChild(list);
  if (payload && payload.truncated) {
    const more = document.createElement('div');
    more.className = 'artifacts-editor-note';
    more.textContent = '候选过多，仅列出前若干项。可先用搜索定位确切路径。';
    shell.appendChild(more);
  }
  viewEl.appendChild(shell);
}

/**
 * 本地确定性映射失败后的统一处理（「讲不清就不猜」的落地）。
 *
 * - 非用户主动动作：只明确拒绝，不做远程模糊匹配（避免后台刷新打远程）。
 * - 用户主动打开：向 Gateway 要一次权威解析，三种结局：
 *     原路径其实存在 → 按正常流程重新加载；
 *     唯一候选       → 自动打开，但标记「路径翻译」以便提示条 + 保存前确认；
 *     多个候选       → 交给用户选（绝不自动采用）。
 */
async function handleArtifactPathResolveFailure(filePath, viewEl, gen, opts, resolvedRead) {
  const showReject = () => {
    if (gen !== artifactContentLoadGen) return;
    viewEl.innerHTML =
      '<div class="artifacts-empty">' + escapeHtml(resolvedRead.reason) + '</div>';
  };
  if (!(opts && opts.authoritative)) {
    showReject();
    return;
  }
  if (typeof resolveArtifactPathViaGateway !== 'function') {
    showReject();
    return;
  }

  viewEl.innerHTML = '<div class="artifacts-empty">正在远程查找…</div>';
  const payload = await resolveArtifactPathViaGateway(filePath);
  if (gen !== artifactContentLoadGen) return;

  // 原路径在远程确实存在（本地映射判不出来）：回到正常流程
  if (payload && payload.ok && payload.exact && payload.path) {
    void loadArtifactContentAsync(filePath, viewEl, gen, { ...(opts || {}), authoritative: false });
    return;
  }

  const candidates =
    payload && payload.ok && Array.isArray(payload.candidates) ? payload.candidates : [];
  if (!candidates.length) {
    const reason = (payload && payload.reason) || resolvedRead.reason;
    viewEl.innerHTML = '<div class="artifacts-empty">' + escapeHtml(reason) + '</div>';
    return;
  }

  if (candidates.length === 1) {
    const only = candidates[0];
    // 唯一候选 = 系统替用户做的决定 → 标记，让编辑器给出提示条并在首次保存前确认
    if (typeof markArtifactPathTranslated === 'function') {
      markArtifactPathTranslated(only.path, { inputPath: filePath, kind: 'unique' });
    }
    selectedArtifactPath = only.path;
    selectedArtifactContentMtime = 0;
    void loadArtifactContentAsync(only.path, viewEl, gen, { ...(opts || {}), authoritative: false });
    return;
  }

  renderArtifactPathCandidates(viewEl, filePath, payload);
}

async function loadArtifactContentAsync(filePath, viewEl, loadGen, opts) {
  const gen = loadGen || ++artifactContentLoadGen;
  if (typeof beginArtifactContentLoad === 'function') beginArtifactContentLoad(filePath, gen);
  try {
    // 编辑器不再在切换文件时销毁：文本标签之间只换 model（见 renderer-artifacts-tabs.js）。
    // 只有渲染媒体预览（图片/Office/PDF）前才卸掉，避免留一个看不见的编辑器实例。
    const hadPreview =
      typeof artifactViewHasPreview === 'function'
        ? artifactViewHasPreview(viewEl)
        : !!viewEl.querySelector(ARTIFACT_PREVIEW_SELECTOR);

    revokeArtifactMediaBlobUrls(viewEl);

    if (gen !== artifactContentLoadGen) return;

    if (!hadPreview) {
      viewEl.innerHTML = '<div class="artifacts-empty">加载中…</div>';
    }
    if (!gwState || !gwState.authed) {
      viewEl.textContent = 'Gateway 未连接';
      return;
    }
    let wsCtx = null;
    try {
      wsCtx = await getWorkspaceContext();
      // 路径映射必须确定性成功：失败就明确拒绝，不猜、也不拿原路径去试
      // （猜错的后果是打开另一个文件，且该路径会被编辑器的保存按钮写进去）
      const resolvedRead = resolveArtifactPathInWorkspace(
        resolveArtifactReadPath(filePath),
        wsCtx
      );
      if (!resolvedRead.ok) {
        await handleArtifactPathResolveFailure(filePath, viewEl, gen, opts, resolvedRead);
        return;
      }
      const readPath = resolvedRead.path;
      const mediaKind = mediaArtifactKind(readPath);
      if (mediaKind) {
        if (typeof disposeMonacoArtifactEditor === 'function') {
          await disposeMonacoArtifactEditor();
        }
        if (gen !== artifactContentLoadGen) return;
        renderMediaArtifactPreview(viewEl, readPath, readPath, mediaKind);
        if (gen === artifactContentLoadGen) {
          if (typeof syncArtifactTabAfterLoad === 'function') {
            syncArtifactTabAfterLoad(filePath, { kind: 'media', readPath: readPath });
          }
          rememberSelectedArtifactContentMtime(readPath);
        }
        return;
      }
      if (imageArtifactKind(readPath)) {
        if (typeof disposeMonacoArtifactEditor === 'function') {
          await disposeMonacoArtifactEditor();
        }
        await renderImageArtifactPreview(viewEl, readPath, readPath, gen);
        if (gen === artifactContentLoadGen) {
          if (typeof syncArtifactTabAfterLoad === 'function') {
            syncArtifactTabAfterLoad(filePath, { kind: 'media', readPath: readPath });
          }
          rememberSelectedArtifactContentMtime(readPath);
        }
        return;
      }
      const officeKind = officeArtifactKind(readPath);
      if (officeKind) {
        if (typeof disposeMonacoArtifactEditor === 'function') {
          await disposeMonacoArtifactEditor();
        }
        await renderOfficeArtifactPreview(viewEl, readPath, readPath, officeKind, gen);
        if (gen === artifactContentLoadGen) {
          if (typeof syncArtifactTabAfterLoad === 'function') {
            syncArtifactTabAfterLoad(filePath, { kind: 'media', readPath: readPath });
          }
          rememberSelectedArtifactContentMtime(readPath);
        }
        return;
      }
      const { text, truncated } = await readArtifactTextFile(filePath, wsCtx, readPath);
      if (gen !== artifactContentLoadGen) return;
      await renderArtifactEditor(viewEl, readPath, text, truncated, '', { tabPath: filePath });
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
              artifactFallbackSourceNote(fb.source),
              { tabPath: filePath }
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
  } finally {
    if (typeof endArtifactContentLoad === 'function') endArtifactContentLoad(gen);
  }
}

/**
 * 被「路径翻译」打开的文件，首次保存前确认一次。
 *
 * 理由：这条路径是**系统按文件名匹配出来的**，不是用户点的那个文件；
 * 而保存会写向真实远端 —— 写错了不可逆。确认过一次就不再重复打断。
 */
function confirmTranslatedPathSave(filePath) {
  const t =
    typeof getArtifactPathTranslation === 'function'
      ? getArtifactPathTranslation(filePath)
      : null;
  if (!t) return true;
  const ok = window.confirm(
    '这个文件是按文件名匹配打开的，不是原路径。\n\n' +
      `原路径：${t.inputPath}\n` +
      `实际位置：${filePath}\n\n` +
      '确认保存到这个文件？'
  );
  if (ok && typeof clearArtifactPathTranslation === 'function') {
    clearArtifactPathTranslation(filePath);
  }
  return ok;
}

/**
 * 编辑区渲染（renderArtifactEditor / 文本域回退）已迁到 renderer-artifacts-tabs.js：
 * 那里是「多标签 + 长驻编辑区」的唯一实现，本文件只负责文件列表与内容加载。
 */

function initArtifactsBtn() {
  // Panel toggle handled by initSidePanel()
}

window.pruneInvalidSessionArtifacts = pruneInvalidSessionArtifacts;
window.resetPlanTraceArtifactLog = resetPlanTraceArtifactLog;
window.loadArtifactImageObjectUrl = loadArtifactImageObjectUrl;
window.imageObjectUrlFromBase64 = imageObjectUrlFromBase64;
// 媒体（音视频）：可 seek 的 dieyun-media:// URL + 系统播放器兜底，见 src/main/media-protocol.js
window.mediaArtifactKind = mediaArtifactKind;
window.artifactMediaUrl = artifactMediaUrl;
window.artifactMediaUrlForCurrentSession = artifactMediaUrlForCurrentSession;
window.openLocalPathInSystemPlayer = openLocalPathInSystemPlayer;

window.findLastRoundChange = findLastRoundChange;
window.getLastRoundFileChanges = getLastRoundFileChanges;
window.formatArtifactDiffHtml = formatArtifactDiffHtml;
window.upsertArtifactFileDiffBadge = upsertArtifactFileDiffBadge;
window.refreshLastRoundFileChanges = refreshLastRoundFileChanges;

window.beginArtifactsUiBatch = beginArtifactsUiBatch;
window.endArtifactsUiBatch = endArtifactsUiBatch;
window.isArtifactsUiBatching = isArtifactsUiBatching;
window.flushArtifactsUiNow = flushArtifactsUiNow;
window.scheduleArtifactsUiFlush = scheduleArtifactsUiFlush;
window.scheduleArtifactsUiRefresh = scheduleArtifactsUiRefresh;
window.forceArtifactsUiRefreshAfterBatch = forceArtifactsUiRefreshAfterBatch;
window.isWorkspaceArtifactsCacheReady = isWorkspaceArtifactsCacheReady;
window.teardownArtifactsMonacoEditor = teardownArtifactsMonacoEditor;
window.cancelArtifactContentLoads = cancelArtifactContentLoads;
window.switchSessionArtifacts = switchSessionArtifacts;
window.cleanupSessionArtifacts = cleanupSessionArtifacts;
window.persistGlobalsToArtifactBucket = persistGlobalsToArtifactBucket;
window.maybeReloadSelectedArtifactContent = maybeReloadSelectedArtifactContent;
