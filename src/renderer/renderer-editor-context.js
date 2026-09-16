/* global window, gatewayCall, gwState, getContextFilePathsForAgent, buildOpenFilesContext, extractCodebasePathsFromBlock, fetchWorkspaceDiagnosticsContext, shouldFetchWorkspaceDiagnostics, shouldInjectCodeContext, textHasCodebaseMention, buildRecentChangesContext, getSessionChangeRowsForAgent, CTX_LIMITS, getAgentLimits, currentSessionId, withSessionRpcScope */
'use strict';

function editorLimits() {
  return typeof getAgentLimits === 'function' ? getAgentLimits() : {};
}

function capEditorContextText(text, max) {
  const s = String(text || '');
  if (s.length <= max) return s;
  return `${s.slice(0, max)}\n…（已截断，原文 ${s.length} 字符）`;
}

function buildEditorContextBlock(opts = {}) {
  const sid = opts.sessionId != null ? String(opts.sessionId).trim() : '';
  const view =
    !sid ||
    (typeof currentSessionId !== 'undefined' && sid === String(currentSessionId || ''));
  if (view && typeof window.getMonacoEditorContext === 'function') {
    const ctx = window.getMonacoEditorContext();
    if (ctx && ctx.activeFilePath) {
      const sel = ctx.selection;
      const hasSel = !!(sel && !sel.isEmpty && sel.text);
      if (!hasSel) return `【编辑器】${ctx.activeFilePath}`;
      return [
        '【编辑器上下文 · 当前焦点】',
        `当前文件：${ctx.activeFilePath}`,
        `选区：L${sel.startLine}:${sel.startColumn}-L${sel.endLine}:${sel.endColumn}`,
        '```',
        capEditorContextText(sel.text, editorLimits().editorSelectionMax),
        '```'
      ].join('\n');
    }
  }

  if (typeof window.getSelectedArtifactPath === 'function') {
    const selected = window.getSelectedArtifactPath(sid || undefined);
    if (selected) {
      return [
        '【编辑器上下文 · 侧栏选中】',
        `当前关注文件：${selected}`,
        '说明：文件已在侧栏选中；优先基于此文件修 bug，必要时 fs_read_file。'
      ].join('\n');
    }
  }

  return '';
}

function getMergedContextFilePaths(sessionId) {
  const out = [];
  const seen = new Set();
  function add(p) {
    const key = String(p || '').trim();
    if (!key) return;
    const norm = key.replace(/\\/g, '/').toLowerCase();
    if (seen.has(norm)) return;
    seen.add(norm);
    out.push(key);
  }

  const sid = sessionId != null ? String(sessionId).trim() : '';
  const view =
    !sid ||
    (typeof currentSessionId !== 'undefined' && sid === String(currentSessionId || ''));
  if (view && typeof window.getMonacoEditorContextPaths === 'function') {
    for (const p of window.getMonacoEditorContextPaths()) add(p);
  }
  if (typeof getContextFilePathsForAgent === 'function') {
    for (const p of getContextFilePathsForAgent(sid || undefined)) add(p);
  }
  return out.slice(0, CTX_LIMITS.OPEN_FILES_MAX);
}

async function fetchGitDiffContext(workspaceRoot, focusPaths, opts = {}) {
  if (!gwState.authed || !workspaceRoot) return '';
  try {
    const data = await gatewayCall(
      'workspace.git_diff',
      typeof withSessionRpcScope === 'function'
        ? withSessionRpcScope(
            {
              workspaceRoot,
              files: (focusPaths || []).slice(0, 12),
              maxChars: opts.maxChars || 12000,
              maxFiles: opts.maxFiles || 8
            },
            opts.sessionId
          )
        : {
            workspaceRoot,
            files: (focusPaths || []).slice(0, 12),
            maxChars: opts.maxChars || 12000,
            maxFiles: opts.maxFiles || 8
          }
    );
    if (!data || !data.ok || !data.text) return '';
    return String(data.text);
  } catch {
    return '';
  }
}

async function buildCursorLikeContextBlocks(userQuery, workspaceInfo, opts = {}) {
  const chunks = [];
  const prepSid =
    opts.sessionId != null && String(opts.sessionId).trim()
      ? String(opts.sessionId).trim()
      : '';
  const viewingSidNow = () =>
    typeof currentSessionId !== 'undefined' && currentSessionId
      ? String(currentSessionId)
      : '';
  const shouldSkipUiEditor = () => {
    if (opts.skipOpenFiles === true) return true;
    const viewing = viewingSidNow();
    return !!(prepSid && viewing && prepSid !== viewing);
  };
  const skipUiAtEntry = shouldSkipUiEditor();
  const injectCode =
    typeof shouldInjectCodeContext === 'function'
      ? shouldInjectCodeContext(userQuery, {
          workspaceInfo,
          ...opts,
          includeEditor: skipUiAtEntry ? false : opts.includeEditor
        })
      : true;
  const allowCodebase =
    injectCode ||
    textHasCodebaseMention(userQuery) ||
    (typeof opts.fetchCodebase === 'function' && opts.forceCodebase === true);

  const editorBlock = buildEditorContextBlock({ sessionId: prepSid || undefined });
  if (editorBlock) chunks.push(editorBlock);

  const workspaceRoot =
    opts.runWorkspaceRoot ||
    opts.workspaceRoot ||
    (workspaceInfo && workspaceInfo.workspacePath) ||
    null;
  const mergedPaths = skipUiAtEntry
    ? typeof getContextFilePathsForAgent === 'function'
      ? getContextFilePathsForAgent(prepSid)
      : []
    : getMergedContextFilePaths(prepSid || undefined);

  if (injectCode && workspaceRoot && opts.includeGitDiff !== false) {
    try {
      const gitBlock = await fetchGitDiffContext(workspaceRoot, mergedPaths, {
        ...opts,
        sessionId: prepSid || opts.sessionId,
        runWorkspaceRoot: workspaceRoot
      });
      if (gitBlock) chunks.push(gitBlock);
    } catch {
      // ignore
    }
  }

  if (injectCode && opts.skipChanges !== true) {
    try {
      const changesBlock = buildRecentChangesContext(
        getSessionChangeRowsForAgent,
        prepSid || undefined
      );
      if (changesBlock) chunks.push(changesBlock);
    } catch {
      // ignore
    }
  }

  let codebaseBlock = '';
  if (typeof opts.fetchCodebase === 'function' && allowCodebase) {
    try {
      codebaseBlock = await opts.fetchCodebase(userQuery);
      if (codebaseBlock) chunks.push(codebaseBlock);
    } catch {
      // ignore
    }
  }

  if (injectCode && opts.skipOpenFiles !== true && mergedPaths.length) {
    try {
      const openFiles = await buildOpenFilesContext(
        () => mergedPaths.slice(),
        extractCodebasePathsFromBlock(codebaseBlock).concat(mergedPaths),
        {
          parallel: true,
          maxPreviews: opts.maxPreviews != null ? opts.maxPreviews : 4,
          sessionId: opts.sessionId,
          runWorkspaceRoot: workspaceRoot
        }
      );
      if (openFiles) chunks.push(openFiles);
    } catch {
      // ignore
    }
  }

  if (
    workspaceInfo &&
    workspaceInfo.workspacePath &&
    typeof shouldFetchWorkspaceDiagnostics === 'function' &&
    shouldFetchWorkspaceDiagnostics(userQuery, workspaceInfo, opts)
  ) {
    try {
      const diagnosticsBlock = await fetchWorkspaceDiagnosticsContext(userQuery, {
        workspaceInfo,
        workspaceRoot,
        // 显式传数组（可为空）：禁止 diagnostics 回退到当前 tab 打开文件
        pathHints: mergedPaths,
        force: opts.forceDiagnostics === true,
        maxFiles: opts.diagMaxFiles,
        sessionId: opts.sessionId,
        runWorkspaceRoot: workspaceRoot,
        skipUiPathHints: true
      });
      if (diagnosticsBlock) chunks.push(diagnosticsBlock);
    } catch {
      // ignore
    }
  }

  return { chunks, mergedPaths, codebaseBlock };
}

window.buildEditorContextBlock = buildEditorContextBlock;
window.getMergedContextFilePaths = getMergedContextFilePaths;
window.fetchGitDiffContext = fetchGitDiffContext;
window.buildCursorLikeContextBlocks = buildCursorLikeContextBlocks;
