/* global window, document, gatewayCall, gwState, updateProblemsPanel, initProblemsPanel, refreshWorkspaceProblemsPanel, getAgentLimits, resetArtifactFollowState */
'use strict';


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
var activeFilePath = null;
var syncTimer = null;
/** @type {{ getValue: Function, dispose: Function, revealLine: Function } | null} */
var activeHandle = null;
/** @type {{ line: number, col: number } | null} */
var pendingGotoLine = null;
/** @type {Map<string, { path: string, ts: number }>} */
var openTabMap = new Map();
/** 打开标签记录上限（仅用于编辑器上下文）：超出按最近使用淘汰，避免长会话无限累积 */
var MONACO_OPEN_TABS_MAX = 40;
/** @type {object|null} */
var editorSelection = null;
/** @type {Map<string, object[]>} */
var diagnosticsCache = new Map();
/** 诊断缓存上限（超出淘汰最旧），避免长会话累积 */
var MONACO_DIAG_CACHE_MAX = 200;
/**
 * Monaco model LRU：编辑器销毁不会释放 model，若不设上限，本次会话看过的每个文件
 * 都会留下一份模型常驻（单文件上限 monacoMaxChars）。这里只保留最近若干份，
 * 兼顾「切回来还能恢复撤销/滚动」与内存占用。
 */
var MONACO_MODEL_LRU_MAX = 12;
/** @type {Map<string, { model: object }>} */
var artifactModelLRU = new Map();
/**
 * 用户手动改过、还没保存的路径集合（按标签记录）。
 * 多标签下不能只留一个布尔：切走标签再切回来，未保存状态必须还在，
 * 否则「写入跟随 / 读盘对齐」会把用户输入当成可覆盖内容写掉。
 */
var editorDirtyPathKeys = new Set();
/** @type {Map<string, object>} 每个标签的视口状态（滚动位置 / 光标），切回来时恢复 */
var editorViewStateByPath = new Map();

/** 路径归一（与 rememberOpenTab 同一口径，用于脏标记与视口状态索引） */
function monacoPathKey(filePath) {
  return String(filePath || '')
    .trim()
    .replace(/\\/g, '/')
    .toLowerCase();
}

function markMonacoPathDirty(filePath) {
  const key = monacoPathKey(filePath);
  if (!key) return;
  editorDirtyPathKeys.add(key);
  if (typeof window.markArtifactTabDirty === 'function') {
    window.markArtifactTabDirty(filePath, true);
  }
}

function clearMonacoPathDirty(filePath) {
  const key = monacoPathKey(filePath);
  if (key) editorDirtyPathKeys.delete(key);
  if (typeof window.markArtifactTabDirty === 'function') {
    window.markArtifactTabDirty(filePath, false);
  }
}

function isMonacoPathDirty(filePath) {
  const key = monacoPathKey(filePath);
  return !!key && editorDirtyPathKeys.has(key);
}

function rememberMonacoViewState(filePath, editor) {
  if (!filePath || !editor || typeof editor.saveViewState !== 'function') return;
  try {
    const state = editor.saveViewState();
    if (state) editorViewStateByPath.set(monacoPathKey(filePath), state);
  } catch {
    // ignore
  }
}

function restoreMonacoViewState(filePath, editor) {
  if (!filePath || !editor || typeof editor.restoreViewState !== 'function') return;
  const state = editorViewStateByPath.get(monacoPathKey(filePath));
  if (!state) return;
  try {
    editor.restoreViewState(state);
  } catch {
    // ignore
  }
}

/** @type {object|null} */
var liveWriteLineDecorations = null;
/** @type {number} */
var lastWritingDecorationLine = 0;
/** @type {{ decorations: object|null, timer: ReturnType<typeof setTimeout>|null }} */
var gotoLineFlashState = { decorations: null, timer: null };

var GOTO_LINE_FLASH_MS = 2600;

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

function loadMonaco() {
  if (window.monaco) {
    configureMonacoArtifactLanguages(window.monaco);
    return Promise.resolve(window.monaco);
  }
  if (monacoReady) return monacoReady;
  monacoReady = (async () => {
    // Monaco 随安装包预装：vs 目录只有 Main 知道（安装包 = resources/monaco-editor，
    // 开发 = node_modules/monaco-editor），渲染进程不再猜路径、也不再按需下载。
    const api = window.diecloud || {};
    if (typeof api.getMonacoVsUrl !== 'function') {
      throw new Error('Monaco 加载接口不可用');
    }
    const info = await api.getMonacoVsUrl();
    if (!info || !info.ok || !info.vsUrl) {
      throw new Error((info && info.error) || '内置 Monaco 编辑器不可用');
    }
    const vsBase = info.vsUrl;
    if (!document.getElementById('monaco-editor-css')) {
      const link = document.createElement('link');
      link.id = 'monaco-editor-css';
      link.rel = 'stylesheet';
      link.href = `${vsBase}/editor/editor.main.css`;
      document.head.appendChild(link);
    }
    await new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = `${vsBase}/loader.js`;
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
  const key = p.replace(/\\/g, '/').toLowerCase();
  // 先删后插：Map 的迭代顺序即最近使用顺序（用于淘汰）
  openTabMap.delete(key);
  openTabMap.set(key, { path: p, ts: Date.now() });
  while (openTabMap.size > MONACO_OPEN_TABS_MAX) {
    const oldest = openTabMap.keys().next().value;
    if (oldest === key) break;
    openTabMap.delete(oldest);
  }
}

function getOpenTabPaths() {
  return Array.from(openTabMap.values())
    .sort((a, b) => b.ts - a.ts)
    .map((t) => t.path);
}

function cacheDiagnostics(filePath, diagnostics) {
  const p = String(filePath || '').trim();
  if (!p) return;
  const key = p.replace(/\\/g, '/').toLowerCase();
  diagnosticsCache.delete(key);
  diagnosticsCache.set(key, Array.isArray(diagnostics) ? diagnostics : []);
  while (diagnosticsCache.size > MONACO_DIAG_CACHE_MAX) {
    const oldest = diagnosticsCache.keys().next().value;
    if (oldest === key) break;
    diagnosticsCache.delete(oldest);
  }
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

/** @type {Promise<void> | null} */
var monacoDisposeInFlight = null;
/** @type {Promise<unknown> | null} */
var monacoMountInFlight = null;
/** @type {import('monaco-editor').IDisposable[]} */
var activeEditorDisposables = [];
var dieyunMonacoThemesReady = false;
/** @type {string | null} */
var lastDieyunMonacoThemeId = null;

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

/** 由 onDidChangeModelContent 调用；程序化写入（跟随/读盘对齐）不能算用户改动 */
function markActiveMonacoEditorUserDirty() {
  if (activeFilePath) markMonacoPathDirty(activeFilePath);
}

function isActiveMonacoEditorUserDirty() {
  return !!activeFilePath && isMonacoPathDirty(activeFilePath);
}

function isModelBoundToActiveEditors(model) {
  if (!model) return false;
  try {
    if (activeEditor && activeEditor.getModel?.() === model) return true;
  } catch {
    // ignore
  }
  return false;
}

function detachModelFromActiveEditors(model) {
  if (!model || !isModelBoundToActiveEditors(model)) return;
  try {
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

function touchArtifactModelLRU(uriKey, model) {
  if (!uriKey || !model) return;
  artifactModelLRU.delete(uriKey);
  artifactModelLRU.set(uriKey, { model });
}

/** 模型是否对应一个「用户改过未保存」的标签（这种模型绝不淘汰，否则未保存内容直接丢失） */
function isArtifactModelDirty(model) {
  try {
    const p = model && model.uri ? String(model.uri.path || '') : '';
    return !!p && editorDirtyPathKeys.has(monacoPathKey(p));
  } catch {
    return false;
  }
}

/**
 * 按路径取缓存的 model（标签切回时用它避免重读盘、保住撤销栈与未保存内容）。
 * 先查 LRU，再查当前编辑器绑定模型（理论上已包含在 LRU 里，作为兜底）。
 */
function getArtifactModelByPath(filePath) {
  const want = normalizeArtifactModelPath(filePath).toLowerCase();
  if (!want) return null;
  for (const entry of artifactModelLRU.values()) {
    const model = entry && entry.model;
    if (!model) continue;
    let p = '';
    try {
      p = String(model.uri && model.uri.path ? model.uri.path : '').toLowerCase();
    } catch {
      p = '';
    }
    if (p !== want) continue;
    let disposed = false;
    try {
      disposed = typeof model.isDisposed === 'function' && model.isDisposed();
    } catch {
      disposed = true;
    }
    if (!disposed) return model;
  }
  try {
    const bound = activeEditor && activeEditor.getModel ? activeEditor.getModel() : null;
    if (bound && String(bound.uri && bound.uri.path ? bound.uri.path : '').toLowerCase() === want) {
      return bound;
    }
  } catch {
    // ignore
  }
  return null;
}

/** 超出上限时淘汰最久未使用的模型；仍被编辑器使用或含未保存内容的模型不释放 */
function evictArtifactModelsIfNeeded() {
  let overflow = artifactModelLRU.size - MONACO_MODEL_LRU_MAX;
  if (overflow <= 0) return;
  for (const key of Array.from(artifactModelLRU.keys())) {
    if (overflow <= 0) break;
    const entry = artifactModelLRU.get(key);
    if (!entry) continue;
    if (isModelBoundToActiveEditors(entry.model)) continue;
    if (isArtifactModelDirty(entry.model)) continue;
    artifactModelLRU.delete(key);
    safeDisposeMonacoModel(entry.model);
    overflow -= 1;
  }
}

/** 切换工作区 / 清空产物时释放全部缓存模型（仍被编辑器使用的不动） */
function resetArtifactModelCache() {
  for (const entry of artifactModelLRU.values()) {
    if (!entry || !entry.model) continue;
    if (isModelBoundToActiveEditors(entry.model)) continue;
    safeDisposeMonacoModel(entry.model);
  }
  artifactModelLRU.clear();
  // 工作区换了，路径与未保存/视口状态都不再成立
  editorDirtyPathKeys.clear();
  editorViewStateByPath.clear();
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

/**
 * 让出一帧给 Monaco 完成布局。
 * 必须带超时兜底：窗口隐藏/最小化时 rAF 会被暂停，裸 requestAnimationFrame 会让
 * 挂载任务永久挂起（monacoMountInFlight 不释放），后续打开任何文件都永远排队。
 */
function yieldToMonacoLayout() {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(finish);
    setTimeout(finish, 120);
  });
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
  clearLiveWriteLineDecoration();
  clearActiveEditorDisposables();
  lastWritingDecorationLine = 0;
  if (syncTimer) {
    clearTimeout(syncTimer);
    syncTimer = null;
  }
  if (activeFilePath) {
    // 切标签/切会话前先把视口状态留下，切回来能恢复滚动与光标
    rememberMonacoViewState(activeFilePath, activeEditor);
    void syncLspDocument(activeFilePath, '', { close: true });
  }
  if (activeEditor) {
    disposeStandaloneEditor(activeEditor);
    activeEditor = null;
  }
  activeHandle = null;
  activeFilePath = null;
  editorSelection = null;
  // 注意：不清 editorDirtyPathKeys —— 未保存标记属于「标签」而不是「编辑器实例」，
  // 编辑器因展示 diff / 切会话被销毁后，模型的未保存内容仍在，标记也必须留着。
  if (typeof resetArtifactFollowState === 'function') resetArtifactFollowState();
  if (typeof updateProblemsPanel === 'function') {
    updateProblemsPanel('', []);
  }
}

function isAppDarkTheme() {
  return document.documentElement.getAttribute('data-theme') !== 'light';
}

/**
 * Monaco 主题：自定义配色表已拆除（Monaco 选区红底排查时清空，见 git 历史），
 * 统一走官方 vs / vs-dark 基底；保留函数是为了让主题调用点稳定。
 */
function buildDieyunMonacoColors() {
  return {};
}

function ensureDieyunMonacoThemes(monaco) {
  const themeId = isAppDarkTheme() ? 'dieyun-dark' : 'dieyun-light';
  const base = isAppDarkTheme() ? 'vs-dark' : 'vs';
  monaco.editor.defineTheme(themeId, {
    base,
    inherit: true,
    rules: [],
    colors: buildDieyunMonacoColors()
  });
  if (!dieyunMonacoThemesReady) {
    monaco.editor.defineTheme('dieyun-dark', {
      base: 'vs-dark',
      inherit: true,
      rules: [],
      colors: buildDieyunMonacoColors()
    });
    monaco.editor.defineTheme('dieyun-light', {
      base: 'vs',
      inherit: true,
      rules: [],
      colors: buildDieyunMonacoColors()
    });
    dieyunMonacoThemesReady = true;
  }
  return themeId;
}

function applyDieyunMonacoTheme(monaco) {
  const themeId = ensureDieyunMonacoThemes(monaco);
  if (lastDieyunMonacoThemeId === themeId) return themeId;
  lastDieyunMonacoThemeId = themeId;
  monaco.editor.setTheme(themeId);
  return themeId;
}

function refreshDieyunMonacoTheme() {
  if (!window.monaco) return;
  dieyunMonacoThemesReady = false;
  lastDieyunMonacoThemeId = null;
  applyDieyunMonacoTheme(window.monaco);
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

function normalizeArtifactModelPath(filePath) {
  const raw = String(filePath || '').trim().replace(/\\/g, '/');
  if (!raw) return '/untitled';
  return '/' + raw.replace(/^\/+/, '').replace(/\/+/g, '/');
}

function artifactModelUri(monaco, filePath) {
  const path = normalizeArtifactModelPath(filePath);
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

/**
 * 取（或建）该路径的 model。
 * `opts.keepText`：多标签切回时不要用磁盘正文覆盖 —— 模型里可能有未保存编辑，
 * 也可能只是比磁盘新；覆盖就等于丢弃用户输入。
 */
function createOrReplaceMonacoModel(monaco, uri, text, lang, opts) {
  const nextText = String(text ?? '');
  const keepText = !!(opts && opts.keepText);
  const uriKey = uri && typeof uri.toString === 'function' ? uri.toString() : String(uri);
  let model = null;
  const existing = monaco.editor.getModel(uri);
  if (existing) {
    let usable = true;
    try {
      usable = !(typeof existing.isDisposed === 'function' && existing.isDisposed());
    } catch {
      usable = false;
    }
    if (usable) {
      detachModelFromActiveEditors(existing);
      if (!keepText && existing.getValue() !== nextText) {
        const editor = activeEditor;
        if (editor) editor._dieyunProgEdit = true;
        try {
          existing.setValue(nextText);
        } finally {
          if (editor) editor._dieyunProgEdit = false;
        }
      }
      model = existing;
    }
  }
  if (!model) model = monaco.editor.createModel(nextText, lang, uri);
  touchArtifactModelLRU(uriKey, model);
  evictArtifactModelsIfNeeded();
  return model;
}

function isMonacoArtifactEditorMounted(filePath) {
  if (!activeEditor || !activeFilePath || !filePath) return false;
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