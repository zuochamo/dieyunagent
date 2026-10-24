/* global window, document, setTimeout, escapeHtml, artifactPathsEqual, selectedArtifactPath, selectedArtifactContentMtime, loadArtifactContent, renderArtifactsList, clearArtifactsFileView, canUseMonacoEditor, createMonacoArtifactEditor, getArtifactModelByPath, getMonacoEditorHandle, initProblemsPanel, confirmTranslatedPathSave, syncSelectedArtifactContentMtimeFromDisk, artifactRpcParams, gatewayCall, getArtifactPathTranslation, markMonacoPathDirty, clearMonacoPathDirty */
'use strict';

/**
 * 文件面板的「多标签 + 持久编辑区」—— 侧栏「文件」页的唯一实现。
 *
 * 为什么需要标签：旧实现每次点文件都 `dispose → create` 编辑器、整块重挂 DOM，
 * 于是「同时看几个文件」「改了没保存先看别的」都做不到。这里把编辑区做成**一个长驻外壳**，
 * 切换文件只换 Monaco model（model 已按路径 LRU 缓存），标签记自己的未保存状态。
 *
 * 三类内容各有一套生命周期（都在同一个外壳里，靠 hidden 切换）：
 *   editor —— Monaco，单实例 + setModel，切回不重读盘；
 *   text   —— 文本域（超大文件 / 不认识的扩展名），正文存在标签里，切回即恢复；
 *   media  —— 图片 / Office / PDF，只读预览，切回时重新读一次（不做缓存，省内存）。
 *
 * 会话/工作区切换由 teardown 路径统一调 resetArtifactsTabs + resetArtifactsEditorShell，
 * 避免 SSH 本地/远程同名路径串到同一条标签上。
 */

/** 打开标签上限：与 Monaco model LRU（12）对齐；超出的旧标签切回时重新读盘，不会丢文件 */
var ARTIFACTS_TAB_MAX = 12;

/** @type {{ path: string, readPath: string, kind: 'auto'|'editor'|'text'|'media', dirty: boolean, docText: (string|null), truncated: boolean, sourceNote: string, at: number }[]} */
var artifactsOpenTabs = [];

/* ------------------------------------------------------------------ *
 * 标签状态
 * ------------------------------------------------------------------ */

function artifactsTabKey(filePath) {
  return String(filePath || '')
    .replace(/\\/g, '/')
    .toLowerCase();
}

function artifactTabName(filePath) {
  const norm = String(filePath || '').replace(/\\/g, '/');
  const idx = norm.lastIndexOf('/');
  return idx >= 0 ? norm.slice(idx + 1) || norm : norm;
}

function findArtifactTab(filePath) {
  const key = artifactsTabKey(filePath);
  if (!key) return null;
  for (const tab of artifactsOpenTabs) {
    if (artifactsTabKey(tab.path) === key) return tab;
  }
  return null;
}

function listArtifactTabs() {
  return artifactsOpenTabs.map((tab) => ({ ...tab }));
}

function artifactsTabCount() {
  return artifactsOpenTabs.length;
}

/** 新建标签；已存在则原样返回（不重置未保存状态与正文） */
function addArtifactTab(filePath) {
  const fp = String(filePath || '').trim();
  if (!fp) return null;
  const existing = findArtifactTab(fp);
  if (existing) return existing;
  const tab = {
    path: fp,
    readPath: fp,
    kind: 'auto',
    dirty: false,
    docText: null,
    truncated: false,
    sourceNote: '',
    at: Date.now()
  };
  artifactsOpenTabs.push(tab);
  trimArtifactTabs();
  return tab;
}

/**
 * 超上限时淘汰「最久没被激活且没有未保存修改」的标签。
 * 全是有未保存内容的标签就宁可不淘汰 —— 丢标签可以重开，丢编辑内容不行。
 */
function trimArtifactTabs() {
  while (artifactsOpenTabs.length > ARTIFACTS_TAB_MAX) {
    let idx = -1;
    const activeKey = artifactsTabKey(selectedArtifactPath || '');
    for (let i = 0; i < artifactsOpenTabs.length; i++) {
      const tab = artifactsOpenTabs[i];
      if (tab.dirty || artifactsTabKey(tab.path) === activeKey) continue;
      if (idx < 0 || tab.at < artifactsOpenTabs[idx].at) idx = i;
    }
    if (idx < 0) break;
    artifactsOpenTabs.splice(idx, 1);
  }
}

/** 标签的未保存标记（编辑器改动 / 文本域改动 / 保存成功后清零都走它） */
function markArtifactTabDirty(filePath, dirty) {
  const tab = findArtifactTab(filePath);
  if (!tab) return;
  const next = dirty !== false;
  if (tab.dirty === next) return;
  tab.dirty = next;
  renderArtifactsTabStrip();
}

/** 切换会话 / 工作区 / 清空产物时整体丢弃标签 */
function resetArtifactsTabs() {
  artifactsOpenTabs.length = 0;
  renderArtifactsTabStrip();
}

/** 清空标签条（不动标签数据，用于「视图被清空但标签还在」的过渡态） */
function paintEmptyArtifactsTabStrip() {
  const strip = document.getElementById('artifacts-tabstrip');
  const list = document.getElementById('artifacts-tabstrip-list');
  if (list) list.replaceChildren();
  if (strip) strip.hidden = true;
}

/* ------------------------------------------------------------------ *
 * 标签条渲染
 * ------------------------------------------------------------------ */

/** 标签条内容签名：列表每次重绘都会问一次，没变化就别重建 DOM（会打断点击/焦点） */
var artifactsTabStripSig = '';

function artifactsTabStripSignature() {
  const parts = artifactsOpenTabs.map(function (tab) {
    return artifactsTabKey(tab.path) + (tab.dirty ? '*' : '');
  });
  parts.push('::' + artifactsTabKey(selectedArtifactPath || ''));
  return parts.join('|');
}

function renderArtifactsTabStrip() {
  const strip = document.getElementById('artifacts-tabstrip');
  const list = document.getElementById('artifacts-tabstrip-list');
  if (!strip || !list) return;
  const sig = artifactsTabStripSignature();
  if (sig === artifactsTabStripSig && list.childElementCount === artifactsOpenTabs.length) {
    strip.hidden = artifactsOpenTabs.length === 0;
    return;
  }
  artifactsTabStripSig = sig;
  strip.hidden = artifactsOpenTabs.length === 0;
  list.replaceChildren();
  const activeKey = artifactsTabKey(selectedArtifactPath || '');
  for (const tab of artifactsOpenTabs) {
    const isActive = artifactsTabKey(tab.path) === activeKey;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'side-tab' + (isActive ? ' active' : '') + (tab.dirty ? ' is-dirty' : '');
    btn.title = tab.path + (tab.dirty ? '（未保存）' : '');
    btn.setAttribute('data-artifact-tab', tab.path);
    btn.setAttribute('role', 'tab');
    btn.setAttribute('aria-selected', isActive ? 'true' : 'false');

    const titleEl = document.createElement('span');
    titleEl.className = 'side-tab-title';
    titleEl.textContent = artifactTabName(tab.path);
    btn.appendChild(titleEl);

    if (tab.dirty) {
      const dot = document.createElement('span');
      dot.className = 'side-tab-dirty';
      dot.textContent = '●';
      dot.title = '未保存';
      btn.appendChild(dot);
    }

    const closeEl = document.createElement('span');
    closeEl.className = 'side-tab-close';
    closeEl.setAttribute('role', 'button');
    closeEl.setAttribute('data-artifact-tab-close', tab.path);
    closeEl.title = '关闭';
    closeEl.setAttribute('aria-label', '关闭 ' + artifactTabName(tab.path));
    closeEl.textContent = '×';
    btn.appendChild(closeEl);

    btn.addEventListener('click', function (ev) {
      if (ev.target === closeEl) {
        ev.stopPropagation();
        closeArtifactTab(tab.path);
        return;
      }
      activateArtifactTab(tab.path);
    });
    btn.addEventListener('auxclick', function (ev) {
      // 中键关标签：与浏览器页保持一致
      if (ev.button !== 1) return;
      ev.preventDefault();
      closeArtifactTab(tab.path);
    });

    list.appendChild(btn);
    if (isActive) {
      // 只动标签条自身的横向滚动，不连带滚祖先容器
      const left = btn.offsetLeft;
      const right = left + btn.offsetWidth;
      if (left < list.scrollLeft) list.scrollLeft = left;
      else if (right > list.scrollLeft + list.clientWidth) {
        list.scrollLeft = right - list.clientWidth;
      }
    }
  }
}

/* ------------------------------------------------------------------ *
 * 打开 / 激活 / 关闭
 * ------------------------------------------------------------------ */

function artifactViewEl() {
  return document.getElementById('artifacts-file-view');
}

/** 该标签能否直接用内存里的内容重绘（不读盘） */
function canRenderArtifactTabFromCache(tab) {
  if (!tab) return false;
  if (tab.kind === 'editor') {
    return typeof getArtifactModelByPath === 'function' && !!getArtifactModelByPath(tab.readPath || tab.path);
  }
  if (tab.kind === 'text') return typeof tab.docText === 'string';
  return false;
}

function renderArtifactTabFromCache(view, tab) {
  if (!view || !tab) return false;
  if (tab.kind === 'editor') {
    void renderArtifactEditor(view, tab.readPath || tab.path, '', tab.truncated, tab.sourceNote, {
      tabPath: tab.path,
      keepModelText: true
    });
    return true;
  }
  if (tab.kind === 'text') {
    void renderArtifactEditor(
      view,
      tab.readPath || tab.path,
      tab.docText == null ? '' : tab.docText,
      tab.truncated,
      tab.sourceNote,
      { tabPath: tab.path, keepText: true }
    );
    return true;
  }
  return false;
}

/**
 * 其它面板（变更 / 源码管理的 diff 预览）会卸载 Monaco 实例，
 * 回到「文件」页时编辑区就只剩空壳。此时用缓存模型补挂回来（零 RPC）。
 * @returns {boolean} 是否真的补挂了
 */
function ensureArtifactsEditorMounted() {
  const tab = findArtifactTab(selectedArtifactPath || '');
  if (!tab || tab.kind !== 'editor') return false;
  const state = artifactsEditorShell;
  const view = artifactViewEl();
  if (!state || !view || !view.contains(state.shell)) return false;
  if (state.monacoHost.querySelector('.monaco-editor')) return false;
  if (!canRenderArtifactTabFromCache(tab)) return false;
  renderArtifactTabFromCache(view, tab);
  return true;
}

/**
 * 打开（或聚焦）一个文件标签。
 * @param {string} filePath
 * @param {{ force?: boolean, authoritative?: boolean }} [opts]
 */
function openArtifactTab(filePath, opts) {
  const tab = addArtifactTab(filePath);
  if (!tab) return null;
  activateArtifactTab(tab.path, opts);
  return tab;
}

/**
 * 激活标签：有缓存就用缓存重绘（切换零 RPC），否则从磁盘加载。
 * 再点一次当前标签 = 强制从磁盘重载（沿用旧行为）。
 */
function activateArtifactTab(filePath, opts) {
  const tab = findArtifactTab(filePath);
  if (!tab) return;
  const options = opts || {};
  const view = artifactViewEl();
  const samePath = !!selectedArtifactPath && artifactPathsEqual(selectedArtifactPath, tab.path);
  tab.at = Date.now();
  // 要重新从磁盘加载（再点当前标签 / 强制打开）时，有未保存修改必须先问，别让一次误点丢掉输入
  if ((samePath || options.force) && tab.dirty) {
    if (
      !window.confirm(
        '「' + artifactTabName(tab.path) + '」有未保存的修改，重新从磁盘加载会丢弃，继续吗？'
      )
    ) {
      return;
    }
    if (typeof clearMonacoPathDirty === 'function') clearMonacoPathDirty(tab.readPath || tab.path);
    markArtifactTabDirty(tab.path, false);
  }
  selectedArtifactPath = tab.path;
  renderArtifactsTabStrip();
  if (!view) return;

  if (options.force || samePath || !canRenderArtifactTabFromCache(tab)) {
    loadArtifactContent(tab.path, view, {
      force: true,
      authoritative: !!options.authoritative
    });
  } else {
    // 缓存重绘：内容来自内存，mtime 基线归零（后续列表刷新会补）
    selectedArtifactContentMtime = 0;
    renderArtifactTabFromCache(view, tab);
  }
  if (typeof renderArtifactsList === 'function') {
    renderArtifactsList({ skipRefresh: true });
  }
}

function closeArtifactTab(filePath) {
  const tab = findArtifactTab(filePath);
  if (!tab) return;
  if (tab.dirty) {
    const ok = window.confirm(
      '「' + artifactTabName(tab.path) + '」还有未保存的修改，仍要关闭吗？'
    );
    if (!ok) return;
    if (typeof clearMonacoPathDirty === 'function') clearMonacoPathDirty(tab.readPath || tab.path);
    tab.dirty = false;
  }
  const idx = artifactsOpenTabs.indexOf(tab);
  if (idx < 0) return;
  artifactsOpenTabs.splice(idx, 1);

  const wasActive = !!selectedArtifactPath && artifactPathsEqual(selectedArtifactPath, tab.path);
  if (!wasActive) {
    renderArtifactsTabStrip();
    if (typeof renderArtifactsList === 'function') renderArtifactsList({ skipRefresh: true });
    return;
  }

  const next = artifactsOpenTabs[idx] || artifactsOpenTabs[idx - 1] || null;
  if (next) {
    activateArtifactTab(next.path);
    return;
  }

  selectedArtifactPath = null;
  selectedArtifactContentMtime = 0;
  renderArtifactsTabStrip();
  const view = artifactViewEl();
  if (view && typeof clearArtifactsFileView === 'function') {
    void clearArtifactsFileView(view, '<div class="artifacts-empty">选择文件查看内容</div>', {
      keepTabs: true
    });
  }
  if (typeof renderArtifactsList === 'function') renderArtifactsList({ skipRefresh: true });
}

/**
 * 加载完成后回填标签元信息（哪来的内容 / 是否截断 / 记过哪些提示）。
 * 标签身份用「用户点的那条路径」，readPath 才是真正读盘/写盘的路径（远端可能不同）。
 */
function syncArtifactTabAfterLoad(filePath, info) {
  const fp = String(filePath || '').trim();
  if (!fp) return null;
  const tab = addArtifactTab(fp);
  if (!tab) return null;
  const meta = info || {};
  if (meta.kind) tab.kind = meta.kind;
  if (meta.readPath) tab.readPath = String(meta.readPath);
  if (Object.prototype.hasOwnProperty.call(meta, 'truncated')) tab.truncated = !!meta.truncated;
  if (typeof meta.sourceNote === 'string') tab.sourceNote = meta.sourceNote;
  if (!selectedArtifactPath) selectedArtifactPath = tab.path;
  renderArtifactsTabStrip();
  return tab;
}

/** 会话切换 / 工作区切换恢复了 selectedArtifactPath 但没有标签时，补一条 */
function syncArtifactTabsWithSelection() {
  const fp = String(selectedArtifactPath || '').trim();
  if (!fp) {
    if (artifactsOpenTabs.length) renderArtifactsTabStrip();
    return;
  }
  if (!findArtifactTab(fp)) {
    addArtifactTab(fp);
    renderArtifactsTabStrip();
    return;
  }
  renderArtifactsTabStrip();
}

/* ------------------------------------------------------------------ *
 * 持久编辑区（唯一外壳）
 * ------------------------------------------------------------------ */

/** @type {{ shell: HTMLElement, pathEl: HTMLElement, saveBtn: HTMLElement, noteHost: HTMLElement, monacoHost: HTMLElement, textarea: HTMLTextAreaElement, filePath: string, mode: 'monaco'|'text'|'' } | null} */
var artifactsEditorShell = null;

/** 编辑器被销毁 / 视图被重建后，外壳缓存必须失效（下次会用新宿主重建实例） */
function resetArtifactsEditorShell() {
  artifactsEditorShell = null;
}

function ensureArtifactsEditorShell() {
  if (artifactsEditorShell) return artifactsEditorShell;

  const shell = document.createElement('div');
  shell.className = 'artifacts-editor-shell';

  const head = document.createElement('div');
  head.className = 'artifacts-editor-head';
  const pathEl = document.createElement('span');
  pathEl.className = 'artifacts-editor-path';
  const saveBtn = document.createElement('button');
  saveBtn.type = 'button';
  saveBtn.className = 'ghost-btn artifacts-editor-save';
  saveBtn.textContent = '保存';
  head.appendChild(pathEl);
  head.appendChild(saveBtn);

  const noteHost = document.createElement('div');
  noteHost.className = 'artifacts-editor-notes';

  const monacoHost = document.createElement('div');
  monacoHost.className = 'artifacts-monaco-host';
  monacoHost.hidden = true;

  const textarea = document.createElement('textarea');
  textarea.className = 'artifacts-editor-textarea';
  textarea.spellcheck = false;
  textarea.hidden = true;

  shell.appendChild(head);
  shell.appendChild(noteHost);
  shell.appendChild(monacoHost);
  shell.appendChild(textarea);
  if (typeof initProblemsPanel === 'function') initProblemsPanel(shell);

  const state = {
    shell: shell,
    head: head,
    pathEl: pathEl,
    saveBtn: saveBtn,
    noteHost: noteHost,
    monacoHost: monacoHost,
    textarea: textarea,
    filePath: '',
    /** 当前真正挂在编辑器实例上的路径（编辑器可能被别的面板卸载，保存前要核对） */
    mountedPath: '',
    mode: ''
  };
  saveBtn.addEventListener('click', function () {
    void saveArtifactEditorContent(state);
  });
  textarea.addEventListener('input', function () {
    const fp = state.filePath;
    if (!fp) return;
    const tab = findArtifactTab(fp);
    if (tab) tab.docText = textarea.value;
    if (typeof markMonacoPathDirty === 'function') markMonacoPathDirty(fp);
    markArtifactTabDirty(fp, true);
  });
  artifactsEditorShell = state;
  return state;
}

function artifactEditorNote(state, text, extraClass) {
  const el = document.createElement('div');
  el.className = 'artifacts-editor-note' + (extraClass ? ' ' + extraClass : '');
  el.textContent = text;
  state.noteHost.appendChild(el);
  return el;
}

function renderArtifactEditorNotes(state, filePath, truncated, sourceNote) {
  const host = state.noteHost;
  host.replaceChildren();
  if (truncated) {
    artifactEditorNote(state, '内容过长，仅显示部分内容（可用 offset/maxBytes 分块读取）');
  }
  if (sourceNote) artifactEditorNote(state, sourceNote);
  // 路径是系统按文件名匹配出来的：必须让用户知道打开的不是他给的那个路径
  const translation =
    typeof getArtifactPathTranslation === 'function' ? getArtifactPathTranslation(filePath) : null;
  if (translation) {
    const el = artifactEditorNote(
      state,
      `原路径在远程不存在，已打开文件名匹配到的文件：${translation.inputPath}`,
      'artifacts-editor-translation-note'
    );
    el.title = `原路径：${translation.inputPath}\n当前文件：${filePath}`;
  }
}

async function saveArtifactEditorContent(state) {
  const filePath = state.filePath;
  if (!filePath) return;
  if (typeof confirmTranslatedPathSave === 'function' && !confirmTranslatedPathSave(filePath)) {
    return;
  }
  const btn = state.saveBtn;
  let data = '';
  if (state.mode === 'monaco') {
    const handle = typeof getMonacoEditorHandle === 'function' ? getMonacoEditorHandle() : null;
    // 编辑器可能已被别的面板（变更 / 源码管理 diff）卸载：此时 getValue 拿不到内容，
    // 继续写盘等于用空内容覆盖文件 —— 必须拒绝，让用户重新打开该标签。
    if (!handle || !state.mountedPath || state.mountedPath !== state.filePath) {
      btn.textContent = '保存';
      window.alert('编辑器未就绪（可能刚被其它面板卸载），请重新点击该标签打开后再保存。');
      return;
    }
    data = String(handle.getValue() || '');
  } else {
    data = String(state.textarea.value || '');
  }
  btn.disabled = true;
  btn.textContent = '保存中…';
  try {
    const params = await artifactRpcParams({ filePath: filePath, data: data, encoding: 'utf8' });
    await gatewayCall('fs.write_file', params);
    // 用真实磁盘 mtime 对齐（不是 Date.now()），否则下次刷新会把编辑器当过期内容重建
    if (typeof syncSelectedArtifactContentMtimeFromDisk === 'function') {
      await syncSelectedArtifactContentMtimeFromDisk(filePath);
    }
    if (typeof clearMonacoPathDirty === 'function') clearMonacoPathDirty(filePath);
    // 显式清标签脏标记（不依赖 monaco 那层的回调）
    markArtifactTabDirty(filePath, false);
    const tab = findArtifactTab(filePath);
    if (tab && state.mode === 'text') tab.docText = data;
    btn.textContent = '已保存';
    setTimeout(function () {
      btn.textContent = '保存';
      btn.disabled = false;
    }, 1200);
  } catch (err) {
    btn.textContent = '保存失败';
    btn.disabled = false;
    window.alert((err && err.message) || String(err));
  }
}

/**
 * 编辑区唯一渲染入口（原 renderer-artifacts.js 里的同名函数已迁到这里）。
 *
 * @param {HTMLElement} viewEl
 * @param {string} filePath 展示 / 读盘路径（远端映射后的路径）
 * @param {string} text
 * @param {boolean} truncated
 * @param {string} [sourceNote]
 * @param {{ tabPath?: string, keepModelText?: boolean, keepText?: boolean }} [opts]
 */
async function renderArtifactEditor(viewEl, filePath, text, truncated, sourceNote, opts) {
  if (!viewEl) return;
  const options = opts || {};
  const displayPath = String(filePath || '');
  const tabPath = String(options.tabPath || displayPath);
  const keepModelText = !!options.keepModelText;
  const keepText = !!options.keepText;
  const bodyText = String(text == null ? '' : text);

  const state = ensureArtifactsEditorShell();
  const useMonaco =
    typeof createMonacoArtifactEditor === 'function' &&
    (keepModelText ||
      (typeof canUseMonacoEditor === 'function' && canUseMonacoEditor(displayPath, bodyText)));

  state.filePath = displayPath;
  state.pathEl.textContent = displayPath;
  state.pathEl.title = displayPath;
  state.saveBtn.disabled = false;
  state.saveBtn.textContent = '保存';
  renderArtifactEditorNotes(state, displayPath, truncated, sourceNote);

  state.mode = useMonaco ? 'monaco' : 'text';
  state.monacoHost.hidden = !useMonaco;
  state.textarea.hidden = useMonaco;

  // 外壳是长驻的：只在「不是当前唯一子节点」时才重挂，避免每次切标签都动 DOM
  if (viewEl.firstElementChild !== state.shell || viewEl.childElementCount !== 1) {
    viewEl.replaceChildren(state.shell);
  }

  const tab = syncArtifactTabAfterLoad(tabPath, {
    kind: useMonaco ? 'editor' : 'text',
    readPath: displayPath,
    truncated: truncated,
    sourceNote: sourceNote || ''
  });

  if (!useMonaco) {
    state.mountedPath = '';
    if (!keepText || state.textarea.value !== bodyText) {
      state.textarea.value = bodyText.slice(0, 500000);
    }
    if (tab && tab.docText == null) tab.docText = state.textarea.value;
    return;
  }

  state.textarea.value = '';
  try {
    await createMonacoArtifactEditor(state.monacoHost, {
      filePath: displayPath,
      text: bodyText.slice(0, 500000),
      keepModelText: keepModelText
    });
    state.mountedPath = displayPath;
  } catch {
    // Monaco 挂不上就退回文本域：内容正确比编辑器手感重要
    state.mountedPath = '';
    state.monacoHost.hidden = true;
    state.textarea.hidden = false;
    state.mode = 'text';
    state.textarea.value = bodyText.slice(0, 500000);
    if (tab) {
      tab.kind = 'text';
      tab.docText = state.textarea.value;
    }
    renderArtifactsTabStrip();
  }
}

/* ------------------------------------------------------------------ *
 * 导出
 * ------------------------------------------------------------------ */

window.openArtifactTab = openArtifactTab;
window.activateArtifactTab = activateArtifactTab;
window.closeArtifactTab = closeArtifactTab;
window.findArtifactTab = findArtifactTab;
window.listArtifactTabs = listArtifactTabs;
window.artifactsTabCount = artifactsTabCount;
window.markArtifactTabDirty = markArtifactTabDirty;
window.resetArtifactsTabs = resetArtifactsTabs;
window.resetArtifactsEditorShell = resetArtifactsEditorShell;
window.renderArtifactsTabStrip = renderArtifactsTabStrip;
window.syncArtifactTabAfterLoad = syncArtifactTabAfterLoad;
window.syncArtifactTabsWithSelection = syncArtifactTabsWithSelection;
window.ensureArtifactsEditorMounted = ensureArtifactsEditorMounted;
window.paintEmptyArtifactsTabStrip = paintEmptyArtifactsTabStrip;
window.renderArtifactEditor = renderArtifactEditor;
