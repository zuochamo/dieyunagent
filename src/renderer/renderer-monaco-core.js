/* global window, document, gatewayCall, gwState, updateProblemsPanel, initProblemsPanel, refreshWorkspaceProblemsPanel, getAgentLimits */
'use strict';

var MONACO_BASE = '../../node_modules/monaco-editor/min/vs';

var EXT_MONACO_LANG = {
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.py': 'python',
  '.json': 'json',
  '.css': 'css',
  '.scss': 'scss',
  '.html': 'html',
  '.htm': 'html',
  '.md': 'markdown',
  '.sql': 'sql',
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.xml': 'xml',
  '.sh': 'shell',
  '.bash': 'shell'
};

var monacoReady = null;
/** @type {import('monaco-editor').editor.IStandaloneCodeEditor | null} */
var activeEditor = null;
/** @type {import('monaco-editor').editor.IStandaloneDiffEditor | null} */
var activeDiffEditor = null;
/** @type {{ original: object, modified: object, filePath: string } | null} */
var activeDiffModels = null;
/** @type {HTMLElement | null} */
var activeDiffHostEl = null;
var activeFilePath = null;
var syncTimer = null;
/** @type {{ getValue: Function, dispose: Function, revealLine: Function } | null} */
var activeHandle = null;
/** @type {{ line: number, col: number } | null} */
var pendingGotoLine = null;
/** @type {Map<string, { path: string, ts: number }>} */
var openTabMap = new Map();
/** @type {object|null} */
var editorSelection = null;
/** @type {Map<string, object[]>} */
var diagnosticsCache = new Map();

/** @type {{ token: number, timer: ReturnType<typeof setTimeout>|null, filePath: string, targetAfter: string } | null} */
var diffAnimState = null;
/** @type {object|null} */
var liveWriteLineDecorations = null;
/** @type {number} */
var lastWritingDecorationLine = 0;
/** @type {{ decorations: object|null, timer: ReturnType<typeof setTimeout>|null }} */
var gotoLineFlashState = { decorations: null, timer: null };

var DIFF_ANIM_MS = 52;
var GOTO_LINE_FLASH_MS = 2600;
var DIFF_ANIM_MAX_LINES = 2000;
var DIFF_ANIM_MAX_LINE_PRODUCT = 400_000;
var DIFF_ANIM_MAX_STEPS = 220;
var DIFF_ANIM_INSERT_CHUNK = 3;

function guessMonacoLanguage(filePath) {
  const ext = String(filePath || '')
    .slice(String(filePath || '').lastIndexOf('.'))
    .toLowerCase();
  return EXT_MONACO_LANG[ext] || 'plaintext';
}

function canUseMonacoEditor(filePath, text) {
  const ext = String(filePath || '')
    .slice(String(filePath || '').lastIndexOf('.'))
    .toLowerCase();
  if (!EXT_MONACO_LANG[ext]) return false;
  if (String(text || '').length > (typeof getAgentLimits === 'function' ? getAgentLimits().monacoMaxChars : 200000)) return false;
  return true;
}

function ensureMonacoDieyunOverrideStyles() {
  if (document.getElementById('monaco-dieyun-overrides-css')) return;
  const style = document.createElement('style');
  style.id = 'monaco-dieyun-overrides-css';
  style.textContent = `
/* 必须排在 editor.main.css 之后，覆盖 Monaco 默认 20% 红底 inline diff */
.artifacts-file-view .monaco-editor .line-delete,
.artifacts-file-view .monaco-editor .char-delete,
.artifacts-file-view .monaco-diff-editor .line-delete,
.artifacts-file-view .monaco-diff-editor .char-delete,
.artifacts-file-view .monaco-editor .inline-deleted-text,
.artifacts-file-view .monaco-editor .inline-deleted-margin-view-zone,
.changes-file-view .monaco-editor .line-delete,
.changes-file-view .monaco-editor .char-delete,
.changes-file-view .monaco-diff-editor .line-delete,
.changes-file-view .monaco-diff-editor .char-delete,
.changes-file-view .monaco-editor .inline-deleted-text,
.changes-file-view .monaco-editor .inline-deleted-margin-view-zone {
  background-color: var(--cursor-diff-del-line, rgba(248, 81, 73, 0.06)) !important;
}
.artifacts-file-view .monaco-editor .line-insert,
.artifacts-file-view .monaco-editor .char-insert,
.artifacts-file-view .monaco-diff-editor .line-insert,
.artifacts-file-view .monaco-diff-editor .char-insert,
.changes-file-view .monaco-editor .line-insert,
.changes-file-view .monaco-editor .char-insert,
.changes-file-view .monaco-diff-editor .line-insert,
.changes-file-view .monaco-diff-editor .char-insert {
  background-color: var(--cursor-diff-ins-line, rgba(63, 185, 80, 0.06)) !important;
}
.artifacts-file-view.is-live-writing .monaco-editor .line-delete,
.artifacts-file-view.is-live-writing .monaco-editor .char-delete,
.artifacts-file-view.is-live-writing .monaco-diff-editor .line-delete,
.artifacts-file-view.is-live-writing .monaco-diff-editor .char-delete,
.artifacts-file-view.is-live-writing .monaco-editor .inline-deleted-text,
.artifacts-file-view.is-live-writing .monaco-editor .inline-deleted-margin-view-zone,
.changes-file-view.is-live-writing .monaco-editor .line-delete,
.changes-file-view.is-live-writing .monaco-editor .char-delete,
.changes-file-view.is-live-writing .monaco-diff-editor .line-delete,
.changes-file-view.is-live-writing .monaco-diff-editor .char-delete,
.changes-file-view.is-live-writing .monaco-editor .inline-deleted-text,
.changes-file-view.is-live-writing .monaco-editor .inline-deleted-margin-view-zone {
  background-color: transparent !important;
}
.monaco-diff-writing-line,
.monaco-editor .view-line.monaco-diff-writing-line,
.monaco-diff-editor .view-line.monaco-diff-writing-line,
.artifacts-file-view.is-live-writing .artifacts-monaco-host .view-line.monaco-diff-writing-line,
.artifacts-file-view.is-live-writing .artifacts-monaco-after-host .view-line.monaco-diff-writing-line {
  background-color: var(--monaco-writing-line-bg, rgba(255, 255, 255, 0.05)) !important;
  box-shadow: inset 3px 0 0 var(--monaco-writing-line-accent, rgba(255, 255, 255, 0.14)) !important;
}
/* 去掉 Monaco 隐藏 textarea 的系统黄/橙 focus 环 */
.monaco-editor .inputarea,
.monaco-editor textarea.inputarea,
.monaco-diff-editor .inputarea {
  outline: none !important;
  border: none !important;
  box-shadow: none !important;
}
`;
  document.head.appendChild(style);
}

function loadMonaco() {
  if (window.monaco) {
    ensureMonacoDieyunOverrideStyles();
    configureMonacoArtifactLanguages(window.monaco);
    return Promise.resolve(window.monaco);
  }
  if (monacoReady) return monacoReady;
  monacoReady = (async () => {
    let vsBase = `${MONACO_BASE}`;
    if (window.diecloud && typeof window.diecloud.ensureOptionalAsset === 'function') {
      try {
        const r = await window.diecloud.ensureOptionalAsset('monaco-editor');
        if (r && r.ok && r.vsUrl) vsBase = r.vsUrl;
      } catch (err) {
        console.warn('[monaco] 按需下载失败，尝试本地 node_modules', err);
      }
    }
    if (!document.getElementById('monaco-editor-css')) {
      const link = document.createElement('link');
      link.id = 'monaco-editor-css';
      link.rel = 'stylesheet';
      link.href =
        vsBase.startsWith('file:') || vsBase.startsWith('http')
          ? `${vsBase}/editor/editor.main.css`
          : `${MONACO_BASE}/editor/editor.main.css`;
      document.head.appendChild(link);
    }
    ensureMonacoDieyunOverrideStyles();
    await new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src =
        vsBase.startsWith('file:') || vsBase.startsWith('http')
          ? `${vsBase}/loader.js`
          : `${MONACO_BASE}/loader.js`;
      s.onload = () => {
        window.require.config({ paths: { vs: vsBase } });
        window.require(['vs/editor/editor.main'], () => {
          if (window.monaco) configureMonacoArtifactLanguages(window.monaco);
          resolve();
        });
      };
      s.onerror = () => reject(new Error('Monaco 加载失败'));
      document.head.appendChild(s);
    });
    return window.monaco;
  })();
  return monacoReady;
}

function markerSeverity(monaco, severity) {
  if (severity === 'error') return monaco.MarkerSeverity.Error;
  if (severity === 'warning') return monaco.MarkerSeverity.Warning;
  if (severity === 'info') return monaco.MarkerSeverity.Info;
  return monaco.MarkerSeverity.Hint;
}

function monacoMarkersFromDiagnostics(diagnostics) {
  if (!window.monaco) return [];
  return (diagnostics || []).map((d) => ({
    severity: markerSeverity(window.monaco, d.severity),
    startLineNumber: Math.max(1, Number(d.line) || 1),
    startColumn: Math.max(1, Number(d.col) || 1),
    endLineNumber: Math.max(1, Number(d.line) || 1),
    endColumn: Math.max(2, (Number(d.col) || 1) + 1),
    message: String(d.message || ''),
    code: d.code ? String(d.code) : undefined,
    source: d.source ? String(d.source) : 'lsp'
  }));
}

async function syncLspDocument(filePath, text, opts) {
  if (!gwState || !gwState.authed) return null;
  try {
    return await gatewayCall('lsp.document_sync', {
      filePath,
      text,
      close: !!(opts && opts.close),
      timeoutMs: 8000
    });
  } catch {
    return null;
  }
}

function rememberOpenTab(filePath) {
  const p = String(filePath || '').trim();
  if (!p) return;
  openTabMap.set(p.replace(/\\/g, '/').toLowerCase(), { path: p, ts: Date.now() });
}

function getOpenTabPaths() {
  return Array.from(openTabMap.values())
    .sort((a, b) => b.ts - a.ts)
    .map((t) => t.path);
}

function cacheDiagnostics(filePath, diagnostics) {
  const p = String(filePath || '').trim();
  if (!p) return;
  diagnosticsCache.set(p.replace(/\\/g, '/').toLowerCase(), Array.isArray(diagnostics) ? diagnostics : []);
  if (gwState && gwState.authed && diagnostics && diagnostics.length) {
    void gatewayCall('lsp.diagnostics_report', {
      filePath: p,
      diagnostics,
      source: 'monaco'
    }).catch(() => {});
  }
}

function applyDiagnosticsToEditor(editor, filePath, diagnostics) {
  if (!window.monaco || !editor) return;
  const model = editor.getModel();
  if (!model) return;
  cacheDiagnostics(filePath, diagnostics);
  window.monaco.editor.setModelMarkers(model, 'dieyun-lsp', monacoMarkersFromDiagnostics(diagnostics));
  if (typeof updateProblemsPanel === 'function') {
    updateProblemsPanel(filePath, diagnostics || []);
  }
}

function updateEditorSelection(editor, filePath) {
  if (!editor) {
    editorSelection = null;
    return;
  }
  const sel = editor.getSelection();
  const model = editor.getModel();
  if (!sel || !model) {
    editorSelection = null;
    return;
  }
  const text = sel.isEmpty() ? '' : model.getValueInRange(sel);
  editorSelection = {
    filePath,
    startLine: sel.startLineNumber,
    startColumn: sel.startColumn,
    endLine: sel.endLineNumber,
    endColumn: sel.endColumn,
    isEmpty: sel.isEmpty(),
    text: String(text || '')
  };
}

function getVisibleSnippet(editor) {
  if (!editor) return { line: 1, snippet: '' };
  const model = editor.getModel();
  if (!model) return { line: 1, snippet: '' };
  const pos = editor.getPosition();
  const line = Math.max(1, pos ? pos.lineNumber : 1);
  const half = Math.floor(((typeof getAgentLimits === 'function' ? getAgentLimits().editorVisibleLines : 40) || 40) / 2);
  const start = Math.max(1, line - half);
  const end = Math.min(model.getLineCount(), line + half);
  const lines = [];
  for (let ln = start; ln <= end; ln++) {
    lines.push(model.getLineContent(ln));
  }
  return { line, snippet: lines.join('\n') };
}

function getMonacoEditorContext() {
  const tabs = getOpenTabPaths();
  const ctx = {
    activeFilePath,
    openTabs: tabs.map((p) => ({ path: p })),
    selection: editorSelection,
    cursorLine: 1,
    visibleSnippet: ''
  };
  if (activeEditor && activeFilePath) {
    const vis = getVisibleSnippet(activeEditor);
    ctx.cursorLine = vis.line;
    if (!editorSelection || editorSelection.isEmpty) {
      ctx.visibleSnippet = vis.snippet;
    }
  }
  return ctx;
}

function getMonacoEditorContextPaths() {
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
  if (activeFilePath) add(activeFilePath);
  for (const p of getOpenTabPaths()) add(p);
  return out;
}

function getCachedDiagnosticsForPaths(paths) {
  const out = [];
  for (const p of paths || []) {
    const key = String(p || '').replace(/\\/g, '/').toLowerCase();
    const diags = diagnosticsCache.get(key);
    if (diags && diags.length) out.push({ file: p, diagnostics: diags });
  }
  return out;
}

function scheduleLspSync(filePath, getText) {
  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = setTimeout(() => {
    void (async () => {
      const text = getText();
      const r = await syncLspDocument(filePath, text);
      if (r && activeFilePath === filePath && activeEditor) {
        applyDiagnosticsToEditor(activeEditor, filePath, r.diagnostics || []);
      }
    })();
  }, typeof getAgentLimits === 'function' ? getAgentLimits().lspSyncDebounceMs : 500);
}

function clearLiveWriteLineDecoration() {
  if (liveWriteLineDecorations && typeof liveWriteLineDecorations.clear === 'function') {
    liveWriteLineDecorations.clear();
  }
  liveWriteLineDecorations = null;
  lastWritingDecorationLine = 0;
}

function cancelDiffHunkAnimation() {
  if (!diffAnimState) return;
  if (diffAnimState.timer) {
    clearTimeout(diffAnimState.timer);
    diffAnimState.timer = null;
  }
  clearLiveWriteLineDecoration();
  diffAnimState = null;
}

function clearGotoLineFlash() {
  if (gotoLineFlashState.timer) {
    clearTimeout(gotoLineFlashState.timer);
    gotoLineFlashState.timer = null;
  }
  if (gotoLineFlashState.decorations && typeof gotoLineFlashState.decorations.clear === 'function') {
    gotoLineFlashState.decorations.clear();
    gotoLineFlashState.decorations = null;
  }
}

function flashMonacoGotoLine(editor, line, col) {
  const monaco = window.monaco;
  if (!editor || !monaco || typeof editor.createDecorationsCollection !== 'function') return;
  const model = editor.getModel?.();
  if (!model) return;
  clearGotoLineFlash();
  const ln = Math.max(1, Math.min(Number(line) || 1, model.getLineCount()));
  const maxCol = model.getLineMaxColumn(ln);
  const cn = Math.max(1, Math.min(Number(col) || 1, maxCol));
  gotoLineFlashState.decorations = editor.createDecorationsCollection([
    {
      range: new monaco.Range(ln, 1, ln, maxCol),
      options: {
        isWholeLine: true,
        className: 'monaco-goto-line-highlight',
        blockClassName: 'monaco-goto-line-highlight'
      }
    }
  ]);
  gotoLineFlashState.timer = setTimeout(clearGotoLineFlash, GOTO_LINE_FLASH_MS);
  if (typeof editor.setPosition === 'function') {
    editor.setPosition({ lineNumber: ln, column: cn });
  }
}

function applyMonacoGotoLine(editor, line, col) {
  if (!editor) return;
  const ln = Math.max(1, Number(line) || 1);
  const cn = Math.max(1, Number(col) || 1);
  editor.revealLineInCenter(ln);
  if (typeof editor.focus === 'function') editor.focus();
  flashMonacoGotoLine(editor, ln, cn);
}

function splitTextLines(text) {
  return String(text ?? '').split('\n');
}

function buildMonacoLineDiffOps(beforeText, afterText) {
  const oldLines = splitTextLines(beforeText);
  const newLines = splitTextLines(afterText);
  const n = oldLines.length;
  const m = newLines.length;
  if (n > DIFF_ANIM_MAX_LINES || m > DIFF_ANIM_MAX_LINES || n * m > DIFF_ANIM_MAX_LINE_PRODUCT) {
    return null;
  }
  if (n === m && oldLines.every((line, i) => line === newLines[i])) {
    return [];
  }

  const dp = Array.from({ length: n + 1 }, () => Array(m + 1).fill(0));
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      if (oldLines[i - 1] === newLines[j - 1]) dp[i][j] = dp[i - 1][j - 1] + 1;
      else dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }

  const raw = [];
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      raw.push({ t: 'keep' });
      i -= 1;
      j -= 1;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      raw.push({ t: 'ins', line: newLines[j - 1] });
      j -= 1;
    } else {
      raw.push({ t: 'del' });
      i -= 1;
    }
  }
  raw.reverse();
  return raw;
}

/** @returns {{ text: string, focusLine: number }[] | null} */
function buildDiffHunkSnapshots(beforeText, afterText) {
  const ops = buildMonacoLineDiffOps(beforeText, afterText);
  if (!ops || !ops.length) return null;

  const naturalFrames = [];
  let cur = [];
  for (const op of ops) {
    if (op.t === 'keep') {
      if (cur.length) naturalFrames.push(cur);
      cur = [];
    } else {
      cur.push(op);
    }
  }
  if (cur.length) naturalFrames.push(cur);

  const expandedFrames = [];
  for (const frame of naturalFrames) {
    const insertOnly = frame.every((o) => o.t === 'ins');
    if (insertOnly && frame.length > DIFF_ANIM_INSERT_CHUNK) {
      for (let i = 0; i < frame.length; i += DIFF_ANIM_INSERT_CHUNK) {
        expandedFrames.push(frame.slice(i, i + DIFF_ANIM_INSERT_CHUNK));
      }
    } else {
      expandedFrames.push(frame);
    }
  }

  const lines = [...splitTextLines(beforeText)];
  let modLine = 1;
  let opIdx = 0;
  const snapshots = [];

  for (const frame of expandedFrames) {
    while (opIdx < ops.length && ops[opIdx].t === 'keep') {
      modLine += 1;
      opIdx += 1;
    }
    for (const op of frame) {
      if (op.t === 'del') {
        if (lines.length === 1 && lines[0] === '') lines.length = 0;
        else if (lines.length) lines.splice(modLine - 1, 1);
        if (!lines.length) modLine = 1;
      } else if (op.t === 'ins') {
        if (!lines.length) {
          lines.push(op.line);
          modLine = 2;
        } else {
          lines.splice(modLine - 1, 0, op.line);
          modLine += 1;
        }
      }
      opIdx += 1;
    }
    snapshots.push({
      text: lines.join('\n'),
      focusLine: Math.max(1, Math.min(modLine - 1, lines.length || 1))
    });
  }

  return snapshots.length ? snapshots : null;
}

function setDiffWritingDecoration(editor, monaco, line) {
  if (!editor || !monaco || typeof editor.createDecorationsCollection !== 'function') return;
  const model = editor.getModel?.();
  if (!model) return;
  const ln = Math.max(1, Math.min(Number(line) || 1, model.getLineCount() || 1));
  if (liveWriteLineDecorations && lastWritingDecorationLine === ln) return;
  clearLiveWriteLineDecoration();
  lastWritingDecorationLine = ln;
  const maxCol = model.getLineMaxColumn(ln);
  liveWriteLineDecorations = editor.createDecorationsCollection([
    {
      range: new monaco.Range(ln, 1, ln, maxCol),
      options: {
        isWholeLine: true,
        className: 'monaco-diff-writing-line',
        blockClassName: 'monaco-diff-writing-line'
      }
    }
  ]);
}

/** @type {object|null} decorations for Cursor-style insert line numbers in review diff */
var reviewDiffLineNumDecorations = null;
/** @type {import('monaco-editor').IDisposable | null} */
var reviewDiffPaintListener = null;

function clearReviewDiffLineNumberPaint() {
  if (reviewDiffLineNumDecorations && typeof reviewDiffLineNumDecorations.clear === 'function') {
    reviewDiffLineNumDecorations.clear();
  }
  reviewDiffLineNumDecorations = null;
}

function disposeReviewDiffPaintListener() {
  if (!reviewDiffPaintListener) return;
  try {
    reviewDiffPaintListener.dispose();
  } catch {
    // ignore
  }
  reviewDiffPaintListener = null;
}

function safeGetLineChanges(diffEditor) {
  if (!diffEditor) return [];
  try {
    const changes = diffEditor.getLineChanges?.();
    return changes && Array.isArray(changes) ? changes : [];
  } catch {
    return [];
  }
}

async function whenDiffReady(diffEditor, fn) {
  if (!diffEditor || typeof fn !== 'function') return;
  try {
    if (typeof diffEditor.waitForDiff === 'function') {
      await diffEditor.waitForDiff();
    } else {
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    }
  } catch {
    return;
  }
  try {
    fn();
  } catch {
    // ignore — Monaco may throw if diff was invalidated mid-flight
  }
}

function runWhenDiffReady(diffEditor, fn) {
  void whenDiffReady(diffEditor, fn);
}

function paintCursorReviewDiffLineNumbers(diffEditor) {
  clearReviewDiffLineNumberPaint();
  if (!isDiffReviewHost() || !diffEditor || activeDiffHostEl?.classList.contains('is-diff-writing')) return;
  const modified = diffEditor.getModifiedEditor?.();
  const monaco = window.monaco;
  if (!modified || !monaco) return;
  const changes = safeGetLineChanges(diffEditor);
  if (!changes.length) return;
  const decorations = [];
  for (const ch of changes) {
    const modStart = Number(ch.modifiedStartLineNumber) || 0;
    const modEnd = Number(ch.modifiedEndLineNumber) || modStart;
    if (modStart < 1) continue;
    for (let ln = modStart; ln <= Math.max(modStart, modEnd); ln++) {
      decorations.push({
        range: new monaco.Range(ln, 1, ln, 1),
        options: {
          lineNumberClassName: 'cursor-diff-ins-lnum',
          linesDecorationsClassName: 'cursor-diff-ins-gutter'
        }
      });
    }
  }
  if (!decorations.length) return;
  reviewDiffLineNumDecorations = modified.createDecorationsCollection(decorations);
}

function scheduleCursorReviewDiffLineNumberPaint(diffEditor) {
  if (!diffEditor || !isDiffReviewHost()) return;
  disposeReviewDiffPaintListener();
  try {
    reviewDiffPaintListener = diffEditor.onDidUpdateDiff(() => {
      disposeReviewDiffPaintListener();
      runWhenDiffReady(diffEditor, () => paintCursorReviewDiffLineNumbers(diffEditor));
    });
    trackEditorDisposable(reviewDiffPaintListener);
  } catch {
    runWhenDiffReady(diffEditor, () => paintCursorReviewDiffLineNumbers(diffEditor));
  }
}

function setDiffHostWritingState(writing) {
  if (activeDiffHostEl) {
    activeDiffHostEl.classList.toggle('is-diff-writing', !!writing);
  }
}

function isDiffReviewHost() {
  return !!activeDiffHostEl?.classList.contains('is-diff-review');
}

function applyMonacoDiffVisualMode(mode) {
  const monaco = window.monaco;
  if (!monaco) return;
  const writing = mode === 'writing';
  const review = isDiffReviewHost();
  if (!writing) {
    clearLiveWriteLineDecoration();
    lastWritingDecorationLine = 0;
  }
  // 写入中每个 chunk 都 setTheme/updateOptions 会让字形重绘闪烁；同模式只应用一次
  if (lastDiffVisualMode === mode && activeDiffEditor) {
    setDiffHostWritingState(writing);
    return;
  }
  lastDiffVisualMode = mode;
  applyDieyunMonacoTheme(monaco, writing, review && !writing);
  setDiffHostWritingState(writing);
  if (!activeDiffEditor) return;
  const wide = activeDiffHostEl ? activeDiffHostEl.clientWidth >= 820 : true;
  try {
    activeDiffEditor.updateOptions({
      renderSideBySide: writing || review ? false : wide,
      renderIndicators: review || !writing,
      useInlineViewWhenSpaceIsLimited: writing || review || !wide,
      renderSideBySideInlineBreakpoint: review ? 99999 : 820,
      renderOverviewRuler: false,
      overviewRulerLanes: 0
    });
    applyMonacoDiffEditorChromeOptions(activeDiffEditor);
    if (review && !writing) {
      scheduleCursorReviewDiffLineNumberPaint(activeDiffEditor);
    }
  } catch {
    // ignore
  }
}

function shouldAnimateMonacoDiff(before, after, opts) {
  if (!opts || !opts.animate) return false;
  if (before === after) return false;
  const snapshots = buildDiffHunkSnapshots(before, after);
  return !!(snapshots && snapshots.length && snapshots.length <= DIFF_ANIM_MAX_STEPS);
}

function snapMonacoDiffModels(before, after, opts) {
  if (!activeDiffModels?.original || !activeDiffModels?.modified) return;
  const liveWriting = !!(opts && opts.liveWriting);
  const incremental = liveWriting || !!(opts && opts.incremental);
  cancelDiffHunkAnimation();
  if (!liveWriting && activeDiffModels.original.getValue() !== before) {
    setMonacoModelText(activeDiffModels.original, before, { incremental });
  }
  if (activeDiffModels.modified.getValue() !== after) {
    setMonacoModelText(activeDiffModels.modified, after, { incremental });
  }
  const modifiedEditor = activeDiffEditor?.getModifiedEditor?.();
  if (liveWriting) {
    applyMonacoDiffVisualMode('writing');
    if (opts?.focusLine && modifiedEditor) {
      const ln = Math.max(1, Number(opts.focusLine) || 1);
      modifiedEditor.revealLineInCenterIfOutsideViewport(ln);
      const monaco = window.monaco;
      if (monaco) setDiffWritingDecoration(modifiedEditor, monaco, ln);
    }
    return;
  }
  applyMonacoDiffVisualMode('done');
  if (opts?.revealLastChange && activeDiffEditor) {
    const listener = activeDiffEditor.onDidUpdateDiff(() => {
      listener.dispose();
      runWhenDiffReady(activeDiffEditor, () => {
        revealLastDiffChange(activeDiffEditor);
        paintCursorReviewDiffLineNumbers(activeDiffEditor);
      });
    });
  } else if (opts?.focusLine && modifiedEditor) {
    const ln = Math.max(1, Number(opts.focusLine) || 1);
    modifiedEditor.revealLineInCenter(ln);
  } else if (
    isDiffReviewHost() &&
    activeDiffEditor &&
    !incremental &&
    !opts?.revealLastChange
  ) {
    scheduleCursorReviewDiffLineNumberPaint(activeDiffEditor);
  }
}

function startDiffHunkAnimation(before, after, opts) {
  if (!activeDiffEditor || !activeDiffModels?.modified || !activeDiffModels?.original) return false;
  const monaco = window.monaco;
  if (!monaco) return false;

  const snapshots = buildDiffHunkSnapshots(before, after);
  if (!snapshots || !snapshots.length || snapshots.length > DIFF_ANIM_MAX_STEPS) {
    snapMonacoDiffModels(before, after, opts);
    return false;
  }

  cancelDiffHunkAnimation();
  activeDiffModels.original.setValue(before);
  activeDiffModels.modified.setValue(before);
  applyMonacoDiffVisualMode('writing');

  const modifiedEditor = activeDiffEditor.getModifiedEditor();
  const model = activeDiffModels.modified;
  const token = Date.now();
  let stepIdx = 0;

  diffAnimState = {
    token,
    timer: null,
    filePath: String(opts?.filePath || activeDiffModels.filePath || ''),
    targetAfter: after
  };

  const finish = (reveal) => {
    if (!diffAnimState || diffAnimState.token !== token) return;
    if (model.getValue() !== after) model.setValue(after);
    const animFilePath = String(diffAnimState.filePath || opts?.filePath || activeDiffModels.filePath || '');
    diffAnimState = null;
    const live =
      typeof window.getActiveLiveWrite === 'function' ? window.getActiveLiveWrite() : null;
    const stillWriting =
      !!(
        live &&
        live.status === 'writing' &&
        (typeof window.pathsMatch === 'function'
          ? window.pathsMatch(live.path, animFilePath)
          : String(live.path) === animFilePath)
      );
    applyMonacoDiffVisualMode(stillWriting ? 'writing' : 'done');
    if (stillWriting && modifiedEditor) {
      const ln = Math.max(1, Math.min(snapshots[snapshots.length - 1]?.focusLine || 1, model.getLineCount()));
      setDiffWritingDecoration(modifiedEditor, monaco, ln);
    }
    if (reveal && activeDiffEditor) {
      const listener = activeDiffEditor.onDidUpdateDiff(() => {
        listener.dispose();
        runWhenDiffReady(activeDiffEditor, () => revealLastDiffChange(activeDiffEditor));
      });
    } else if (reveal && modifiedEditor) {
      modifiedEditor.revealLineInCenter(Math.max(1, model.getLineCount()));
    }
  };

  const tick = () => {
    if (!diffAnimState || diffAnimState.token !== token) return;
    if (stepIdx >= snapshots.length) {
      finish(!!opts?.revealLastChange);
      return;
    }

    const snap = snapshots[stepIdx];
    stepIdx += 1;
    model.setValue(snap.text);

    const revealLine = Math.max(1, Math.min(snap.focusLine, model.getLineCount()));
    if (modifiedEditor) {
      modifiedEditor.revealLineInCenterIfOutsideViewport(revealLine);
      setDiffWritingDecoration(modifiedEditor, monaco, revealLine);
    }

    const delay =
      snapshots.length > 120 ? Math.max(16, Math.floor(DIFF_ANIM_MS * 0.45)) : DIFF_ANIM_MS;
    diffAnimState.timer = setTimeout(tick, delay);
  };

  tick();
  return true;
}

/** @type {Promise<void> | null} */
var monacoDisposeInFlight = null;
/** @type {Promise<unknown> | null} */
var monacoMountInFlight = null;
/** @type {import('monaco-editor').IDisposable[]} */
var activeEditorDisposables = [];
var dieyunMonacoThemesReady = false;
/** @type {string | null} */
var lastDieyunMonacoThemeId = null;
/** @type {'writing' | 'done' | null} */
var lastDiffVisualMode = null;

function clearActiveEditorDisposables() {
  for (const d of activeEditorDisposables) {
    try {
      d.dispose();
    } catch {
      // ignore
    }
  }
  activeEditorDisposables = [];
}

function trackEditorDisposable(disposable) {
  if (disposable && typeof disposable.dispose === 'function') {
    activeEditorDisposables.push(disposable);
  }
  return disposable;
}

function isModelBoundToActiveEditors(model) {
  if (!model) return false;
  try {
    if (activeDiffEditor) {
      const pair = activeDiffEditor.getModel?.();
      if (pair && (pair.original === model || pair.modified === model)) return true;
    }
    if (activeEditor && activeEditor.getModel?.() === model) return true;
  } catch {
    // ignore
  }
  return false;
}

function detachModelFromActiveEditors(model) {
  if (!model || !isModelBoundToActiveEditors(model)) return;
  try {
    if (activeDiffEditor) {
      const pair = activeDiffEditor.getModel?.();
      if (pair && (pair.original === model || pair.modified === model)) {
        activeDiffEditor.setModel(null);
      }
    }
    if (activeEditor && activeEditor.getModel?.() === model) {
      activeEditor.setModel(null);
    }
  } catch {
    // ignore
  }
}

function safeDisposeMonacoModel(model) {
  if (!model) return;
  try {
    if (typeof model.isDisposed === 'function' && model.isDisposed()) return;
    detachModelFromActiveEditors(model);
    model.dispose();
  } catch {
    // Ignore races during hot reload or overlapping dispose calls.
  }
}

async function runMonacoMountTask(task) {
  if (monacoMountInFlight) await monacoMountInFlight;
  const job = task();
  monacoMountInFlight = job;
  try {
    return await job;
  } finally {
    if (monacoMountInFlight === job) monacoMountInFlight = null;
  }
}

function yieldToMonacoLayout() {
  return new Promise((resolve) => requestAnimationFrame(resolve));
}

/** Monaco stamps a context attribute on the container; innerHTML clear is not enough to remount. */
function clearMonacoHostContext(hostEl) {
  if (!hostEl) return;
  try {
    hostEl.innerHTML = '';
    for (const name of hostEl.getAttributeNames()) {
      if (/context|monaco/i.test(name)) hostEl.removeAttribute(name);
    }
  } catch {
    // ignore
  }
}

function freshMonacoDiffHost(hostEl) {
  if (!hostEl) return hostEl;
  if (!hostEl.parentNode) {
    clearMonacoHostContext(hostEl);
    return hostEl;
  }
  const next = document.createElement('div');
  next.className = hostEl.className;
  hostEl.parentNode.replaceChild(next, hostEl);
  return next;
}

function disposeStandaloneEditor(editor) {
  if (!editor) return;
  try {
    if (typeof editor.setModel === 'function') editor.setModel(null);
    editor.dispose();
  } catch {
    // ignore
  }
}

async function waitForDiffEditorIdle(diffEditor, timeoutMs = 120) {
  if (!diffEditor) return;
  try {
    if (typeof diffEditor.waitForDiff === 'function') {
      await Promise.race([
        diffEditor.waitForDiff(),
        new Promise((resolve) => setTimeout(resolve, timeoutMs))
      ]);
    }
  } catch {
    // ignore — diff may already be torn down
  }
  await yieldToMonacoLayout();
  await yieldToMonacoLayout();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function disposeActiveDiffEditor() {
  const diffEditor = activeDiffEditor;
  const hostEl = activeDiffHostEl;
  disposeReviewDiffPaintListener();
  clearReviewDiffLineNumberPaint();
  activeDiffEditor = null;
  activeDiffModels = null;

  if (!diffEditor) return;

  await waitForDiffEditorIdle(diffEditor);

  try {
    diffEditor.setModel(null);
  } catch {
    // ignore
  }

  await yieldToMonacoLayout();
  await new Promise((resolve) => setTimeout(resolve, 0));

  try {
    diffEditor.dispose();
  } catch {
    // ignore
  }

  if (hostEl?.parentNode) {
    freshMonacoDiffHost(hostEl);
  } else if (hostEl) {
    clearMonacoHostContext(hostEl);
  }
}

async function disposeMonacoArtifactEditor() {
  if (monacoDisposeInFlight) {
    await monacoDisposeInFlight;
    return;
  }
  monacoDisposeInFlight = disposeMonacoArtifactEditorCore();
  try {
    await monacoDisposeInFlight;
  } finally {
    monacoDisposeInFlight = null;
  }
}

async function disposeMonacoArtifactEditorCore() {
  clearGotoLineFlash();
  clearReviewDiffLineNumberPaint();
  cancelDiffHunkAnimation();
  clearActiveEditorDisposables();
  lastDiffVisualMode = null;
  lastWritingDecorationLine = 0;
  if (syncTimer) {
    clearTimeout(syncTimer);
    syncTimer = null;
  }
  const staleDiffHost = activeDiffHostEl;
  if (activeFilePath && !activeDiffEditor) {
    void syncLspDocument(activeFilePath, '', { close: true });
  }
  if (activeDiffEditor) {
    await disposeActiveDiffEditor();
  } else {
    activeDiffModels = null;
    if (staleDiffHost) {
      clearMonacoHostContext(staleDiffHost);
      if (staleDiffHost.parentNode) freshMonacoDiffHost(staleDiffHost);
    }
  }
  activeDiffHostEl = null;
  setDiffHostWritingState(false);
  if (activeEditor) {
    disposeStandaloneEditor(activeEditor);
    activeEditor = null;
  }
  activeHandle = null;
  activeFilePath = null;
  editorSelection = null;
  if (window.diecloud && typeof window.diecloud.setComponentInUse === 'function') {
    window.diecloud.setComponentInUse('monaco-editor', false);
  }
  if (typeof updateProblemsPanel === 'function') {
    updateProblemsPanel('', []);
  }
}

function isAppDarkTheme() {
  return document.documentElement.getAttribute('data-theme') !== 'light';
}

function readCssVar(name, fallback) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

function buildDieyunMonacoColors(quietDiff = false, reviewMode = false) {
  const dark = isAppDarkTheme();
  const editorBg = readCssVar('--monaco-editor-bg', 'transparent');
  const overviewMarker = readCssVar(
    '--monaco-overview-ruler-color',
    dark ? 'rgba(154, 160, 192, 0.42)' : 'rgba(100, 116, 139, 0.38)'
  );
  const overviewTrack = readCssVar('--monaco-overview-ruler-track', 'transparent');
  const borderColor = readCssVar('--border', dark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.08)');
  const lineHighlight = dark ? 'rgba(255, 255, 255, 0.03)' : 'rgba(0, 0, 0, 0.025)';
  const gotoLineBg = readCssVar(
    '--monaco-goto-line-bg',
    dark ? 'rgba(96, 165, 250, 0.08)' : 'rgba(59, 130, 246, 0.07)'
  );
  const base = {
    'editor.background': editorBg === 'transparent' ? '#00000000' : editorBg,
    'editor.foreground': readCssVar('--text', dark ? '#e6e8f5' : '#111827'),
    'editorLineNumber.foreground': readCssVar('--text-mute', dark ? '#6b7196' : '#6b7280'),
    'editorLineNumber.activeForeground': readCssVar('--text-dim', dark ? '#9aa0c0' : '#374151'),
    'editor.selectionBackground': dark ? 'rgba(190, 194, 202, 0.22)' : 'rgba(0, 0, 0, 0.1)',
    'editor.inactiveSelectionBackground': dark ? 'rgba(190, 194, 202, 0.1)' : 'rgba(0, 0, 0, 0.05)',
    'editorCursor.foreground': readCssVar('--accent-2', dark ? '#e2e4e8' : '#111827'),
    'editor.lineHighlightBackground': lineHighlight,
    'editor.lineHighlightBorder': '#00000000',
    'editor.rangeHighlightBackground': gotoLineBg,
    'editor.selectionHighlightBackground': gotoLineBg,
    'editor.wordHighlightBackground': gotoLineBg,
    'editor.wordHighlightStrongBackground': gotoLineBg,
    // Monaco 默认 find / snippet 为亮黄框，改为黑白灰描边
    'editor.findMatchBackground': dark ? 'rgba(255, 255, 255, 0.16)' : 'rgba(0, 0, 0, 0.1)',
    'editor.findMatchBorder': dark ? 'rgba(255, 255, 255, 0.45)' : 'rgba(0, 0, 0, 0.35)',
    'editor.findMatchHighlightBackground': dark ? 'rgba(255, 255, 255, 0.08)' : 'rgba(0, 0, 0, 0.05)',
    'editor.findMatchHighlightBorder': dark ? 'rgba(255, 255, 255, 0.22)' : 'rgba(0, 0, 0, 0.18)',
    'editor.findRangeHighlightBackground': gotoLineBg,
    'editor.snippetTabstopHighlightBackground': dark ? 'rgba(255, 255, 255, 0.1)' : 'rgba(0, 0, 0, 0.06)',
    'editor.snippetTabstopHighlightBorder': dark ? 'rgba(255, 255, 255, 0.35)' : 'rgba(0, 0, 0, 0.28)',
    'editor.snippetFinalTabstopHighlightBackground': dark ? 'rgba(255, 255, 255, 0.14)' : 'rgba(0, 0, 0, 0.08)',
    'editor.snippetFinalTabstopHighlightBorder': dark ? 'rgba(255, 255, 255, 0.45)' : 'rgba(0, 0, 0, 0.35)',
    'editorBracketMatch.background': dark ? 'rgba(255, 255, 255, 0.06)' : 'rgba(0, 0, 0, 0.04)',
    'editorBracketMatch.border': dark ? 'rgba(255, 255, 255, 0.35)' : 'rgba(0, 0, 0, 0.28)',
    'editorWidget.background': readCssVar('--bg-elev', dark ? '#121212' : '#ffffff'),
    'editorWidget.border': borderColor,
    'focusBorder': '#00000000',
    'contrastBorder': '#00000000',
    'contrastActiveBorder': '#00000000',
    'scrollbarSlider.background': readCssVar('--scrollbar-thumb', 'rgba(128,128,128,0.25)'),
    'scrollbarSlider.hoverBackground': readCssVar('--scrollbar-thumb-hover', 'rgba(128,128,128,0.4)'),
    'scrollbarSlider.activeBackground': readCssVar('--scrollbar-thumb-hover', 'rgba(128,128,128,0.4)'),
    'editorOverviewRuler.background': overviewTrack === 'transparent' ? '#00000000' : overviewTrack,
    'editorOverviewRuler.border': '#00000000',
    'editorOverviewRuler.errorForeground': overviewMarker,
    'editorOverviewRuler.warningForeground': overviewMarker,
    'editorOverviewRuler.infoForeground': overviewMarker,
    'editorOverviewRuler.findMatchForeground': overviewMarker,
    'editorOverviewRuler.rangeHighlightForeground': overviewMarker,
    'editorOverviewRuler.selectionHighlightForeground': overviewMarker,
    'editorOverviewRuler.wordHighlightForeground': overviewMarker,
    'editorOverviewRuler.wordHighlightStrongForeground': overviewMarker,
    'editorOverviewRuler.modifiedForeground': overviewMarker,
    'editorOverviewRuler.addedForeground': overviewMarker,
    'editorOverviewRuler.deletedForeground': overviewMarker,
    'diffEditor.border': dark ? '#ffffff14' : '#00000014',
    'diffEditor.insertedTextBorder': '#00000000',
    'diffEditor.removedTextBorder': '#00000000',
    'panel.background': readCssVar('--bg-elev', dark ? '#121212' : '#ffffff'),
    'sideBar.background': readCssVar('--bg-elev', dark ? '#121212' : '#ffffff')
  };
  if (quietDiff) {
    return {
      ...base,
      'diffEditor.insertedLineBackground': '#00000000',
      'diffEditor.removedLineBackground': '#00000000',
      'diffEditor.insertedTextBackground': '#00000000',
      'diffEditor.removedTextBackground': '#00000000',
      'diffEditorGutter.insertedLineBackground': '#00000000',
      'diffEditorGutter.removedLineBackground': '#00000000',
      'diffEditor.diagonalFill': '#00000000'
    };
  }
  if (reviewMode) {
    // Cursor-like: faint whole-line tint + slightly stronger char-level highlight; delete/insert symmetric
    return {
      ...base,
      'diffEditor.insertedLineBackground': dark ? '#3fb9500a' : '#16a34a08',
      'diffEditor.removedLineBackground': dark ? '#f851490a' : '#dc262608',
      'diffEditor.insertedTextBackground': dark ? '#3fb95018' : '#16a34a14',
      'diffEditor.removedTextBackground': dark ? '#f8514918' : '#dc262614',
      'diffEditor.diagonalFill': dark ? '#ffffff06' : '#00000004',
      'diffEditorGutter.insertedLineBackground': dark ? '#3fb95033' : '#16a34a28',
      'diffEditorGutter.removedLineBackground': dark ? '#f8514933' : '#dc262628'
    };
  }
  return {
    ...base,
    'diffEditor.insertedLineBackground': dark ? '#22c55e05' : '#16a34a04',
    'diffEditor.removedLineBackground': dark ? '#ef444405' : '#dc262604',
    'diffEditor.insertedTextBackground': dark ? '#3fb95012' : '#16a34a10',
    'diffEditor.removedTextBackground': dark ? '#f8514912' : '#dc262610'
  };
}

function ensureDieyunMonacoThemes(monaco, quietDiff = false, reviewMode = false) {
  const colors = buildDieyunMonacoColors(quietDiff, reviewMode);
  let themeId = isAppDarkTheme() ? 'dieyun-dark' : 'dieyun-light';
  if (quietDiff) themeId = 'dieyun-diff-quiet';
  else if (reviewMode) themeId = 'dieyun-diff-review';
  const base = isAppDarkTheme() ? 'vs-dark' : 'vs';
  monaco.editor.defineTheme(themeId, {
    base,
    inherit: true,
    rules: [],
    colors
  });
  if (!quietDiff && !reviewMode && !dieyunMonacoThemesReady) {
    monaco.editor.defineTheme('dieyun-dark', {
      base: 'vs-dark',
      inherit: true,
      rules: [],
      colors: buildDieyunMonacoColors(false, false)
    });
    monaco.editor.defineTheme('dieyun-light', {
      base: 'vs',
      inherit: true,
      rules: [],
      colors: buildDieyunMonacoColors(false, false)
    });
    dieyunMonacoThemesReady = true;
  }
  return themeId;
}

function applyDieyunMonacoTheme(monaco, quietDiff = false, reviewMode = false) {
  const themeId = ensureDieyunMonacoThemes(monaco, quietDiff, reviewMode);
  if (lastDieyunMonacoThemeId === themeId) return themeId;
  lastDieyunMonacoThemeId = themeId;
  monaco.editor.setTheme(themeId);
  return themeId;
}

function refreshDieyunMonacoTheme() {
  if (!window.monaco) return;
  dieyunMonacoThemesReady = false;
  lastDieyunMonacoThemeId = null;
  const quiet = activeDiffHostEl?.classList.contains('is-diff-writing');
  const review = activeDiffHostEl?.classList.contains('is-diff-review');
  applyDieyunMonacoTheme(window.monaco, quiet, review && !quiet);
}

function applyMonacoEditorChromeOptions(editor) {
  if (!editor || typeof editor.updateOptions !== 'function') return;
  const scrollbarSize = Number.parseInt(
    getComputedStyle(document.documentElement).getPropertyValue('--scrollbar-size').trim(),
    10
  );
  editor.updateOptions({
    renderOverviewRuler: false,
    overviewRulerLanes: 0,
    overviewRulerBorder: false,
    hideCursorInOverviewRuler: true,
    minimap: { enabled: false },
    renderLineHighlight: 'line',
    selectionHighlight: false,
    scrollbars: {
      vertical: 'auto',
      horizontal: 'hidden',
      verticalScrollbarSize: Number.isFinite(scrollbarSize) && scrollbarSize > 0 ? scrollbarSize : 8,
      horizontalScrollbarSize: Number.isFinite(scrollbarSize) && scrollbarSize > 0 ? scrollbarSize : 8,
      verticalHasArrows: false,
      horizontalHasArrows: false,
      useShadows: false
    }
  });
}

/** 移除/隐藏 Monaco overview ruler（变更区左右对比里会误显示为粗红条） */
function stripMonacoOverviewRuler(hostEl) {
  if (!hostEl) return;
  hostEl.querySelectorAll('.decorationsOverviewRuler, .overview-ruler').forEach((el) => {
    el.style.display = 'none';
    el.style.width = '0';
    el.style.height = '0';
    el.style.opacity = '0';
    el.style.pointerEvents = 'none';
  });
}

function applyMonacoDiffEditorChromeOptions(diffEditor) {
  if (!diffEditor) return;
  applyMonacoEditorChromeOptions(diffEditor.getOriginalEditor?.());
  applyMonacoEditorChromeOptions(diffEditor.getModifiedEditor?.());
}

function normalizeArtifactModelPath(filePath) {
  const raw = String(filePath || '').trim().replace(/\\/g, '/');
  if (!raw) return '/untitled';
  return '/' + raw.replace(/^\/+/, '').replace(/\/+/g, '/');
}

function artifactModelUri(monaco, filePath, suffix) {
  let path = normalizeArtifactModelPath(filePath);
  if (suffix) path += `~${suffix}`;
  return monaco.Uri.from({ scheme: 'inmemory', authority: 'dieyun', path });
}

function configureMonacoArtifactLanguages(monaco) {
  if (configureMonacoArtifactLanguages._done) return;
  configureMonacoArtifactLanguages._done = true;
  const diag = {
    noSemanticValidation: true,
    noSyntaxValidation: true,
    noSuggestionDiagnostics: true
  };
  const compiler = {
    allowNonTsExtensions: true,
    allowJs: true,
    checkJs: false,
    noLib: true,
    skipLibCheck: true
  };
  monaco.languages.typescript.typescriptDefaults.setDiagnosticsOptions(diag);
  monaco.languages.typescript.javascriptDefaults.setDiagnosticsOptions(diag);
  monaco.languages.typescript.typescriptDefaults.setCompilerOptions(compiler);
  monaco.languages.typescript.javascriptDefaults.setCompilerOptions(compiler);
}

function createOrReplaceMonacoModel(monaco, uri, text, lang) {
  const nextText = String(text ?? '');
  const existing = monaco.editor.getModel(uri);
  if (!existing) {
    return monaco.editor.createModel(nextText, lang, uri);
  }
  try {
    if (typeof existing.isDisposed === 'function' && existing.isDisposed()) {
      return monaco.editor.createModel(nextText, lang, uri);
    }
  } catch {
    return monaco.editor.createModel(nextText, lang, uri);
  }
  detachModelFromActiveEditors(existing);
  if (existing.getValue() !== nextText) {
    existing.setValue(nextText);
  }
  return existing;
}

function createMonacoArtifactModel(monaco, filePath, text, lang, suffix) {
  const uri = artifactModelUri(monaco, filePath, suffix);
  return createOrReplaceMonacoModel(monaco, uri, text, lang);
}

function createDiffMonacoModels(monaco, before, after, lang, animate, filePath) {
  const origUri = artifactModelUri(monaco, filePath, 'original');
  const modUri = artifactModelUri(monaco, filePath, 'modified');
  return {
    original: createOrReplaceMonacoModel(monaco, origUri, before, lang),
    modified: createOrReplaceMonacoModel(monaco, modUri, animate ? before : after, lang)
  };
}

function isMonacoArtifactEditorMounted(filePath) {
  if (!activeFilePath || !filePath) return false;
  const same =
    typeof window.pathsMatch === 'function'
      ? window.pathsMatch(activeFilePath, filePath)
      : normMonacoFilePath(activeFilePath) === normMonacoFilePath(filePath);
  if (!same) return false;
  if (activeEditor) {
    const dom = activeEditor.getDomNode?.();
    return !!(dom && dom.isConnected);
  }
  if (activeDiffEditor && activeDiffHostEl) {
    return activeDiffHostEl.isConnected;
  }
  return false;
}

/** 单栏 after-only 是否已挂好（不含 DiffEditor） */
function isMonacoAfterOnlyEditorMounted(filePath) {
  if (activeDiffEditor || !activeEditor || !activeFilePath || !filePath) return false;
  const same =
    typeof window.pathsMatch === 'function'
      ? window.pathsMatch(activeFilePath, filePath)
      : normMonacoFilePath(activeFilePath) === normMonacoFilePath(filePath);
  if (!same) return false;
  const dom = activeEditor.getDomNode?.();
  return !!(dom && dom.isConnected);
}

function isMonacoMountInFlight() {
  return !!monacoMountInFlight;
}