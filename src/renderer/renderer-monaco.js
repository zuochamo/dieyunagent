/* global window, document, gatewayCall, gwState, updateProblemsPanel, initProblemsPanel, refreshWorkspaceProblemsPanel, getAgentLimits, activeEditorUserDirty, markActiveMonacoEditorUserDirty, isActiveMonacoEditorUserDirty, resetArtifactFollowState, resetArtifactModelCache */
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

  activeEditorUserDirty = false;
  trackEditorDisposable(
    editor.onDidChangeModelContent(() => {
      // 程序化写入（写入跟随 / 读盘对齐）不算用户改动，否则跟随会误判为「用户已编辑」而停止
      if (!editor._dieyunProgEdit) markActiveMonacoEditorUserDirty();
      scheduleLspSync(opts.filePath, () => editor.getValue());
    })
  );
  trackEditorDisposable(
    editor.onDidChangeCursorSelection(() => {
      updateEditorSelection(editor, opts.filePath);
    })
  );

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

  // LSP 同步是慢路径（首次可能要等语言服务器就绪，超时 8s），绝不能留在挂载任务里：
  // runMonacoMountTask 串行执行，一旦被它占住，用户之后每次打开文件都要排在后面等超时
  // —— 表现就是「点了文件只见标题栏、内容空白很久」。编辑器挂载本身是同步的，
  // 这里返回后内容立即可见，诊断稍后补上。
  void syncLspDocument(opts.filePath, opts.text || '')
    .then((r) => {
      if (activeEditor !== editor) return; // 已切走，丢弃过期诊断
      applyDiagnosticsToEditor(editor, opts.filePath, r ? r.diagnostics || [] : []);
      applyMonacoEditorChromeOptions(editor);
    })
    .catch(() => {
      // LSP 不可用不影响编辑器内容展示
    });

  return activeHandle;
  });
}

function updateMonacoArtifactEditorText(filePath, text, opts) {
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
  const editor = activeEditor;
  // 标记为程序化编辑：Monaco 的 model 变更事件同步派发，finally 里立即复位
  if (editor) editor._dieyunProgEdit = true;
  try {
    if (incremental && monaco) {
      const result = applyMonacoModelTextIncremental(model, next, monaco, { appendOnly });
      if (result === 'ok' || result === 'same') return result === 'ok';
      if (result === 'skipped') return false;
    }
    if (appendOnly) return false;
    model.setValue(next);
    return true;
  } finally {
    if (editor) editor._dieyunProgEdit = false;
  }
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
  pendingGotoLine = { line: ln, col: cn };
}

window.loadMonaco = loadMonaco;
window.canUseMonacoEditor = canUseMonacoEditor;
window.refreshDieyunMonacoTheme = refreshDieyunMonacoTheme;
window.createMonacoArtifactEditor = createMonacoArtifactEditor;
window.updateMonacoArtifactEditorText = updateMonacoArtifactEditorText;
window.applyMonacoModelTextIncremental = applyMonacoModelTextIncremental;
window.setMonacoModelText = setMonacoModelText;
window.disposeMonacoArtifactEditor = disposeMonacoArtifactEditor;
window.revealMonacoLine = revealMonacoLine;
window.getMonacoEditorHandle = () => activeHandle;
window.isActiveMonacoEditorUserDirty = isActiveMonacoEditorUserDirty;
window.isMonacoArtifactEditorMounted = isMonacoArtifactEditorMounted;
window.isMonacoMountInFlight = isMonacoMountInFlight;
window.resetArtifactModelCache = resetArtifactModelCache;
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
