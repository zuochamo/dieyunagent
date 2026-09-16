/* global window, document, gatewayCall, gwState, updateProblemsPanel, initProblemsPanel, refreshWorkspaceProblemsPanel, getAgentLimits */
'use strict';


async function createMonacoArtifactEditor(hostEl, opts) {
  return runMonacoMountTask(async () => {
  await disposeMonacoArtifactEditor();
  await yieldToMonacoLayout();
  if (window.diecloud && typeof window.diecloud.setComponentInUse === 'function') {
    window.diecloud.setComponentInUse('monaco-editor', true);
  }
  const monaco = await loadMonaco();
  hostEl.innerHTML = '';
  applyDieyunMonacoTheme(monaco);

  const lang = guessMonacoLanguage(opts.filePath);
  const uri = artifactModelUri(monaco, opts.filePath);
  const model = createOrReplaceMonacoModel(monaco, uri, opts.text || '', lang);

  const editor = monaco.editor.create(hostEl, {
    model,
    automaticLayout: true,
    minimap: { enabled: false },
    scrollBeyondLastLine: false,
    fontSize: 13,
    lineNumbers: 'on',
    wordWrap: 'on',
    tabSize: 2,
    padding: { top: 8, bottom: 8 },
    renderOverviewRuler: false,
    overviewRulerLanes: 0,
    hideCursorInOverviewRuler: true,
    renderLineHighlight: 'line',
    selectionHighlight: false
  });
  applyMonacoEditorChromeOptions(editor);

  activeEditor = editor;
  activeFilePath = opts.filePath;
  rememberOpenTab(opts.filePath);
  updateEditorSelection(editor, opts.filePath);

  trackEditorDisposable(
    editor.onDidChangeModelContent(() => {
      scheduleLspSync(opts.filePath, () => editor.getValue());
    })
  );
  trackEditorDisposable(
    editor.onDidChangeCursorSelection(() => {
      updateEditorSelection(editor, opts.filePath);
    })
  );

  const r = await syncLspDocument(opts.filePath, opts.text || '');
  applyDiagnosticsToEditor(editor, opts.filePath, r ? r.diagnostics || [] : []);
  applyMonacoEditorChromeOptions(editor);

  activeHandle = {
    getValue: () => editor.getValue(),
    dispose: () => disposeMonacoArtifactEditor(),
    revealLine: (line, col) => {
      applyMonacoGotoLine(editor, line, col);
    }
  };
  flushPendingGotoLine();
  if (opts?.focusLine) {
    const ln = Math.max(1, Number(opts.focusLine) || 1);
    editor.revealLineInCenterIfOutsideViewport(ln);
    setDiffWritingDecoration(editor, monaco, ln);
  }
  if (typeof wireMonacoEditorSelectionDrag === 'function') {
    wireMonacoEditorSelectionDrag(editor);
  }
  return activeHandle;
  });
}

async function createMonacoArtifactDiffEditor(hostEl, opts) {
  return runMonacoMountTask(async () => {
  await disposeMonacoArtifactEditor();
  await yieldToMonacoLayout();
  if (window.diecloud && typeof window.diecloud.setComponentInUse === 'function') {
    window.diecloud.setComponentInUse('monaco-editor', true);
  }
  const monaco = await loadMonaco();
  if (!hostEl?.isConnected && !hostEl?.parentNode) return null;
  hostEl = freshMonacoDiffHost(hostEl);
  activeDiffHostEl = hostEl;
  const reviewMode = !!opts.reviewMode;
  hostEl.classList.toggle('is-diff-review', reviewMode);
  applyDieyunMonacoTheme(monaco, false, reviewMode);
  const lang = guessMonacoLanguage(opts.filePath);
  const before = String(opts.beforeText != null ? opts.beforeText : '');
  const after = String(opts.afterText != null ? opts.afterText : '');
  const wide = hostEl.clientWidth >= 820;

  const diffEditor = monaco.editor.createDiffEditor(hostEl, {
    automaticLayout: true,
    readOnly: true,
    renderSideBySide: reviewMode ? false : wide,
    useInlineViewWhenSpaceIsLimited: true,
    renderSideBySideInlineBreakpoint: reviewMode ? 99999 : 820,
    renderIndicators: true,
    minimap: { enabled: false },
    scrollBeyondLastLine: false,
    fontSize: 13,
    lineNumbers: 'on',
    wordWrap: 'on',
    tabSize: 2,
    padding: { top: 8, bottom: 8 },
    renderOverviewRuler: false,
    overviewRulerLanes: 0,
    hideCursorInOverviewRuler: true,
    diffAlgorithm: 'advanced'
  });

  const animate = shouldAnimateMonacoDiff(before, after, opts);
  const { original, modified } = createDiffMonacoModels(monaco, before, after, lang, animate, opts.filePath);
  diffEditor.setModel({ original, modified });
  applyMonacoDiffEditorChromeOptions(diffEditor);

  activeDiffEditor = diffEditor;
  activeDiffModels = { original, modified, filePath: opts.filePath };
  activeEditor = null;
  activeFilePath = opts.filePath;
  rememberOpenTab(opts.filePath);

  activeHandle = {
    getValue: () => modified.getValue(),
    dispose: () => disposeMonacoArtifactEditor(),
    revealLine: (line, col) => {
      const modifiedEditor = diffEditor.getModifiedEditor?.();
      applyMonacoGotoLine(modifiedEditor, line, col);
    }
  };

  if (animate) {
    startDiffHunkAnimation(before, after, { ...opts, filePath: opts.filePath, revealLastChange: false });
  } else if (opts.liveWriting) {
    applyMonacoDiffVisualMode('writing');
    const modifiedEditor = diffEditor.getModifiedEditor?.();
    if (opts.focusLine && modifiedEditor) {
      const ln = Math.max(1, Number(opts.focusLine) || 1);
      modifiedEditor.revealLineInCenterIfOutsideViewport(ln);
      setDiffWritingDecoration(modifiedEditor, monaco, ln);
    }
  } else {
    applyMonacoDiffVisualMode('done');
    if (opts.revealLastChange) {
      const listener = diffEditor.onDidUpdateDiff(() => {
        listener.dispose();
        runWhenDiffReady(diffEditor, () => {
          revealLastDiffChange(diffEditor);
          paintCursorReviewDiffLineNumbers(diffEditor);
        });
      });
    } else if (reviewMode) {
      scheduleCursorReviewDiffLineNumberPaint(diffEditor);
    } else if (opts.focusLine) {
      const ln = Math.max(1, Number(opts.focusLine) || 1);
      const modifiedEditor = diffEditor.getModifiedEditor?.();
      if (modifiedEditor) modifiedEditor.revealLineInCenter(ln);
    }
  }

  flushPendingGotoLine();

  if (typeof wireMonacoEditorSelectionDrag === 'function') {
    wireMonacoEditorSelectionDrag(diffEditor.getOriginalEditor());
    wireMonacoEditorSelectionDrag(diffEditor.getModifiedEditor());
  }

  return activeHandle;
  });
}

function updateMonacoArtifactEditorText(filePath, text, opts) {
  if (activeDiffEditor) return false;
  if (!activeEditor) return false;
  const sameFile =
    typeof window.pathsMatch === 'function'
      ? window.pathsMatch(activeFilePath, filePath)
      : normMonacoFilePath(activeFilePath) === normMonacoFilePath(filePath);
  if (!sameFile) return false;
  const model = activeEditor.getModel?.();
  if (!model) return false;
  const next = String(text ?? '');
  const appendOnly = opts?.appendOnly !== false;
  const changed = setMonacoModelText(model, next, {
    incremental: true,
    appendOnly
  });
  if (!changed && appendOnly && model.getValue() !== next) {
    // 非纯追加：写入中跳过，避免 setValue 整屏字形闪烁；写完再整量挂载
    return false;
  }
  if (opts?.focusLine) {
    const ln = Math.max(1, Number(opts.focusLine) || 1);
    const curLine = model.getLineCount();
    if (Math.abs(ln - curLine) >= 3) {
      activeEditor.revealLineInCenterIfOutsideViewport(ln);
    }
    const monaco = window.monaco;
    if (monaco) setDiffWritingDecoration(activeEditor, monaco, ln);
  }
  return true;
}

function flushPendingGotoLine() {
  if (!pendingGotoLine) return;
  if (activeHandle && typeof activeHandle.revealLine === 'function') {
    const { line, col } = pendingGotoLine;
    pendingGotoLine = null;
    activeHandle.revealLine(line, col);
  }
}

function revealLastDiffChange(diffEditor) {
  if (!diffEditor) return;
  const modifiedEditor = diffEditor.getModifiedEditor?.();
  if (!modifiedEditor) return;
  try {
    const changes = safeGetLineChanges(diffEditor);
    if (changes.length) {
      const last = changes[changes.length - 1];
      const line = Math.max(1, last.modifiedEndLineNumber || last.modifiedStartLineNumber || 1);
      modifiedEditor.revealLineInCenter(line);
      return;
    }
  } catch {
    // ignore
  }
  const model = modifiedEditor.getModel?.();
  const fallback = Math.max(1, model?.getLineCount?.() ?? 1);
  modifiedEditor.revealLineInCenter(fallback);
}

function normMonacoFilePath(p) {
  return String(p || '')
    .trim()
    .replace(/\\/g, '/')
    .toLowerCase();
}

/**
 * Update model text with minimal DOM churn: append-only and common-prefix tail edits
 * instead of full setValue (which repaints all visible lines and flickers).
 * @returns {'same'|'ok'|'skipped'|false}
 */
function applyMonacoModelTextIncremental(model, nextText, monaco, opts) {
  if (!model) return false;
  const prev = model.getValue();
  const next = String(nextText ?? '');
  if (prev === next) return 'same';

  const appendOnly = !!(opts && opts.appendOnly);
  const Range = monaco && monaco.Range;
  if (!Range) {
    if (appendOnly) return 'skipped';
    model.setValue(next);
    return 'ok';
  }

  if (next.startsWith(prev)) {
    const suffix = next.slice(prev.length);
    if (!suffix) return 'same';
    const lineCount = model.getLineCount();
    const lastLineLen = model.getLineContent(lineCount).length;
    model.applyEdits([
      {
        range: new Range(lineCount, lastLineLen + 1, lineCount, lastLineLen + 1),
        text: suffix,
        forceMoveMarkers: true
      }
    ]);
    return 'ok';
  }

  if (appendOnly) return 'skipped';

  const prevLines = prev.split('\n');
  const nextLines = next.split('\n');
  let common = 0;
  const minLines = Math.min(prevLines.length, nextLines.length);
  while (common < minLines && prevLines[common] === nextLines[common]) common++;

  if (common > 0 || (!prevLines.length && nextLines.length)) {
    const startLine = Math.max(1, common + 1);
    const endLine = Math.max(startLine, prevLines.length);
    const endColumn =
      prevLines.length > 0 ? prevLines[prevLines.length - 1].length + 1 : 1;
    const newTail = nextLines.slice(common).join('\n');
    const range =
      prevLines.length === 0
        ? new Range(1, 1, 1, 1)
        : new Range(startLine, 1, endLine, endColumn);
    model.applyEdits([{ range, text: newTail, forceMoveMarkers: true }]);
    return 'ok';
  }

  model.setValue(next);
  return 'ok';
}

function setMonacoModelText(model, nextText, opts) {
  if (!model) return false;
  const next = String(nextText ?? '');
  if (model.getValue() === next) return false;
  const incremental = !!(opts && opts.incremental);
  const appendOnly = !!(opts && opts.appendOnly);
  const monaco = window.monaco;
  if (incremental && monaco) {
    const result = applyMonacoModelTextIncremental(model, next, monaco, { appendOnly });
    if (result === 'ok' || result === 'same') return result === 'ok';
    if (result === 'skipped') return false;
  }
  if (appendOnly) return false;
  model.setValue(next);
  return true;
}

async function updateMonacoArtifactDiffEditor(opts) {
  if (monacoMountInFlight) {
    try {
      await monacoMountInFlight;
    } catch {
      // ignore failed mount; fall through to retry
    }
  }

  const filePath = String(opts.filePath || '');
  const before = String(opts.beforeText != null ? opts.beforeText : '');
  const after = String(opts.afterText != null ? opts.afterText : '');

  const sameFile =
    typeof window.pathsMatch === 'function'
      ? window.pathsMatch(activeDiffModels?.filePath, filePath)
      : normMonacoFilePath(activeDiffModels?.filePath) === normMonacoFilePath(filePath);

  const hostConnected = !!(opts.hostEl && opts.hostEl.isConnected);
  const hostMatchesActive =
    hostConnected && activeDiffHostEl && opts.hostEl === activeDiffHostEl;

  if (activeDiffEditor && activeDiffModels && sameFile && activeDiffModels.original && activeDiffModels.modified) {
    if (!hostMatchesActive && hostConnected) {
      return createMonacoArtifactDiffEditor(freshMonacoDiffHost(opts.hostEl), opts);
    }
    const updateOpts = { ...opts, animate: false };
    const animatingSameTarget =
      diffAnimState &&
      diffAnimState.filePath &&
      normMonacoFilePath(diffAnimState.filePath) === normMonacoFilePath(filePath) &&
      diffAnimState.targetAfter === after;

    if (updateOpts.revealLastChange || updateOpts.animate === false) {
      snapMonacoDiffModels(before, after, { ...updateOpts, incremental: true });
      return activeHandle;
    }

    if (animatingSameTarget) {
      activeDiffModels.original.setValue(before);
      return activeHandle;
    }

    if (shouldAnimateMonacoDiff(before, after, updateOpts)) {
      startDiffHunkAnimation(before, after, { ...updateOpts, filePath });
      return activeHandle;
    }

    snapMonacoDiffModels(before, after, { ...updateOpts, incremental: true });
    return activeHandle;
  }

  if (!opts.hostEl) return null;
  return createMonacoArtifactDiffEditor(opts.hostEl, opts);
}

function revealMonacoLine(line, col) {
  const ln = Math.max(1, Number(line) || 1);
  const cn = Math.max(1, Number(col) || 1);
  if (activeHandle && typeof activeHandle.revealLine === 'function') {
    pendingGotoLine = null;
    activeHandle.revealLine(ln, cn);
    return;
  }
  if (activeEditor) {
    pendingGotoLine = null;
    applyMonacoGotoLine(activeEditor, ln, cn);
    return;
  }
  if (activeDiffEditor) {
    pendingGotoLine = null;
    applyMonacoGotoLine(activeDiffEditor.getModifiedEditor?.(), ln, cn);
    return;
  }
  pendingGotoLine = { line: ln, col: cn };
}

window.createMonacoArtifactModel = createMonacoArtifactModel;
window.loadMonaco = loadMonaco;
window.canUseMonacoEditor = canUseMonacoEditor;
window.refreshDieyunMonacoTheme = refreshDieyunMonacoTheme;
window.createMonacoArtifactEditor = createMonacoArtifactEditor;
window.createMonacoArtifactDiffEditor = createMonacoArtifactDiffEditor;
window.updateMonacoArtifactDiffEditor = updateMonacoArtifactDiffEditor;
window.updateMonacoArtifactEditorText = updateMonacoArtifactEditorText;
window.applyMonacoModelTextIncremental = applyMonacoModelTextIncremental;
window.setMonacoModelText = setMonacoModelText;
window.disposeMonacoArtifactEditor = disposeMonacoArtifactEditor;
window.stripMonacoOverviewRuler = stripMonacoOverviewRuler;
window.revealMonacoLine = revealMonacoLine;
window.getMonacoEditorHandle = () => activeHandle;
window.isMonacoArtifactEditorMounted = isMonacoArtifactEditorMounted;
window.isMonacoAfterOnlyEditorMounted = isMonacoAfterOnlyEditorMounted;
window.isMonacoMountInFlight = isMonacoMountInFlight;
window.getMonacoEditorContext = getMonacoEditorContext;
window.getMonacoEditorContextPaths = getMonacoEditorContextPaths;
window.getCachedMonacoDiagnostics = getCachedDiagnosticsForPaths;

var monacoPreloadPromise = null;

/** Gateway 连接后预装 Monaco（安装包内置或 dev node_modules），避免首次打开文件才下载/加载 */
function preloadMonacoEditor() {
  if (monacoPreloadPromise) return monacoPreloadPromise;
  monacoPreloadPromise = (async () => {
    if (window.diecloud && typeof window.diecloud.ensureOptionalAsset === 'function') {
      await window.diecloud.ensureOptionalAsset('monaco-editor');
    }
    await loadMonaco();
  })().catch((err) => {
    monacoPreloadPromise = null;
    console.warn('[monaco] preload failed', err);
    throw err;
  });
  return monacoPreloadPromise;
}

window.preloadMonacoEditor = preloadMonacoEditor;
