/* global window, document, gatewayCall, gwState, pickDiffDisplayText, escapeHtml, formatInlineUnifiedDiffHtml, isEditToolName, isDeleteToolName, editToolFilePath, canonicalArtifactPathFromTool, toolArtifactPath, disposeMonacoArtifactEditor, artifactRpcParams, applyWorkspaceArtifactPath, sessionArtifacts, pathsMatch, normWritePath */
'use strict';

/**
 * 产物 diff 的**静态**渲染与读盘工具。
 *
 * 历史：本文件曾叫 `renderer-artifacts-live-write.js`，承载 live-write（边写边预览）的
 * 流式渲染、Monaco after-only 编辑器、页签跟随等。live-write 引擎已整体移除：产物面板的
 * diff 现在只由会话产物 / worktree / trace 的数据按需渲染，不再存在「写入中」状态。
 */

function artifactPathsMatch(a, b) {
  if (!a || !b) return false;
  const ca = applyWorkspaceArtifactPath(a);
  const cb = applyWorkspaceArtifactPath(b);
  if (typeof pathsMatch === 'function') return pathsMatch(ca, cb);
  if (typeof normWritePath === 'function') return normWritePath(ca) === normWritePath(cb);
  return ca === cb;
}

function isChangesFileViewEl(viewEl) {
  return !!(viewEl && viewEl.id === 'changes-file-view');
}

function shouldHideChangesDiffHead(viewEl, opts) {
  return !!(opts && opts.hideDiffHead) || isChangesFileViewEl(viewEl);
}

function parseDiffFromSummary(summary) {
  const m = String(summary || '').match(/\+(\d+)\s+-(\d+)/);
  if (!m) return null;
  return {
    added: Number(m[1]) || 0,
    removed: Number(m[2]) || 0
  };
}

function artifactPathFromTool(tool) {
  if (!tool) return '';
  if (!isEditToolName(tool.name) && !isDeleteToolName(tool.name)) return '';
  if (typeof canonicalArtifactPathFromTool === 'function') {
    const canonical = canonicalArtifactPathFromTool(tool);
    if (canonical) return canonical;
  }
  if (typeof editToolFilePath === 'function') return editToolFilePath(tool);
  return toolArtifactPath(tool);
}

/** 同一路径可能同时出现在会话产物与目录列表里，取最完整（最长）的那个 */
function resolveArtifactReadPath(filePath) {
  const fp = String(filePath || '').trim();
  if (!fp) return fp;
  let best = fp;
  for (const art of sessionArtifacts) {
    if (!art?.path) continue;
    if (typeof pathsMatch === 'function' ? pathsMatch(art.path, fp) : art.path === fp) {
      if (String(art.path).length > best.length) best = art.path;
    }
  }
  return applyWorkspaceArtifactPath(best);
}

async function readArtifactFileText(filePath) {
  if (!gwState || !gwState.authed) throw new Error('Gateway 未连接');
  const readPath = resolveArtifactReadPath(filePath);
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
        await artifactRpcParams({ filePath: readPath, encoding: 'utf8' })
      );
    } else {
      throw err;
    }
  }
  return r && r.data != null ? String(r.data) : '';
}

function unifiedDiffSig(beforeText, afterText) {
  const before = String(beforeText ?? '');
  const after = String(afterText ?? '');
  return `${before.length}:${after.length}:${after.slice(-96)}`;
}

/** 同容器内增量更新 unified diff，避免整块 innerHTML 重建导致滚动位置/选中丢失 */
function patchUnifiedDiffInPlace(container, beforeText, afterText) {
  if (!container) return false;
  const before = String(beforeText ?? '');
  const after = String(afterText ?? '');
  const sig = unifiedDiffSig(before, after);
  if (container.dataset.diffSig === sig) return true;

  if (!before.trim()) {
    const lines = after.split('\n');
    const nodes = container.querySelectorAll('.diff-line.diff-add');
    for (let i = 0; i < lines.length; i++) {
      const expected = '+' + lines[i];
      if (i < nodes.length) {
        if (nodes[i].textContent !== expected) nodes[i].textContent = expected;
      } else {
        const div = document.createElement('div');
        div.className = 'diff-line diff-add';
        div.textContent = expected;
        container.appendChild(div);
      }
    }
    while (container.querySelectorAll('.diff-line.diff-add').length > lines.length) {
      container.lastElementChild?.remove();
    }
    container.dataset.diffSig = sig;
    return true;
  }

  if (typeof formatInlineUnifiedDiffHtml === 'function') {
    const nextHtml = formatInlineUnifiedDiffHtml(before, after, { escapeHtml });
    if (container.innerHTML !== nextHtml) container.innerHTML = nextHtml;
    container.dataset.diffSig = sig;
    return true;
  }
  return false;
}

/** 超大文本的轻量预览：中间省略，保住首尾（首尾通常才是用户关心的改动点） */
function trimDiffPreview(text) {
  const s = String(text || '');
  const LIMIT = 50000;
  if (s.length <= LIMIT) return s;
  const half = Math.floor(LIMIT / 2);
  return (
    s.slice(0, half) +
    '\n\n... diff 内容过大，已省略中间部分 ...\n\n' +
    s.slice(Math.max(half, s.length - half))
  );
}

function buildDiffShell(viewEl, opts) {
  const shell = document.createElement('div');
  shell.className = 'artifacts-editor-shell artifacts-diff-shell';
  if (shouldHideChangesDiffHead(viewEl, opts)) return shell;
  const head = document.createElement('div');
  head.className = 'artifacts-editor-head artifacts-diff-head';
  const pathEl = document.createElement('span');
  pathEl.className = 'artifacts-editor-path';
  pathEl.textContent = String(opts?.filePath || '');
  pathEl.title = pathEl.textContent;
  const note = document.createElement('span');
  note.className = 'artifacts-live-write-note';
  note.textContent = '改前 / 改后对比 · 绿增红删';
  head.append(pathEl, note);
  shell.appendChild(head);
  return shell;
}

function renderDiffSideBySide(shell, beforeText, afterText) {
  const grid = document.createElement('div');
  grid.className = 'agents-md-diff-grid artifacts-large-diff-grid';
  for (const [label, text, emptyHint] of [
    ['修改前', beforeText, '（空 / 新建）'],
    ['修改后', afterText, '（空）']
  ]) {
    const pane = document.createElement('div');
    pane.className = 'agents-md-diff-pane';
    const labelEl = document.createElement('div');
    labelEl.className = 'agents-md-diff-label';
    labelEl.textContent = label;
    const pre = document.createElement('pre');
    pre.className = 'agents-md-diff-pre';
    pre.textContent = trimDiffPreview(text) || emptyHint;
    pane.append(labelEl, pre);
    grid.appendChild(pane);
  }
  shell.appendChild(grid);
}

/**
 * 产物 diff 预览（唯一入口，变更页 / 源码管理页 / worktree 预览共用）。
 * 变更页：单栏 unified，绿增红删；其余页面：上下对照的整文件预览。
 */
function renderChangesPaneDiffPreview(viewEl, art, opts) {
  if (!viewEl || !art?.path) return Promise.resolve();
  const o = opts && typeof opts === 'object' ? opts : {};
  const diff = art.diff && typeof art.diff === 'object' ? art.diff : {};
  const beforeText =
    typeof pickDiffDisplayText === 'function'
      ? pickDiffDisplayText(diff, 'before')
      : String(diff.beforeText || '');
  const afterText =
    typeof pickDiffDisplayText === 'function'
      ? pickDiffDisplayText(diff, 'after')
      : String(diff.afterText || '');
  const isChangesView = isChangesFileViewEl(viewEl);
  if (typeof window.setChangesPreviewPath === 'function') window.setChangesPreviewPath(art.path);

  if (isChangesView) {
    const unified = viewEl.querySelector('.changes-unified-diff');
    const incremental =
      !!o.incremental &&
      !!unified &&
      typeof window.isChangesDiffPreviewMounted === 'function' &&
      window.isChangesDiffPreviewMounted(art.path);
    if (incremental && patchUnifiedDiffInPlace(unified, beforeText, afterText)) {
      return Promise.resolve();
    }
    viewEl.innerHTML = '';
    const shell = buildDiffShell(viewEl, { ...o, hideDiffHead: true });
    const body = document.createElement('div');
    body.className = 'changes-diff-pre changes-unified-diff agent-scroll';
    body.innerHTML =
      typeof formatInlineUnifiedDiffHtml === 'function'
        ? formatInlineUnifiedDiffHtml(beforeText, afterText, { escapeHtml })
        : escapeHtml(afterText);
    shell.appendChild(body);
    viewEl.appendChild(shell);
    return Promise.resolve();
  }

  // 其它视图（源码管理、worktree 预览…）自带标题栏：卸载 Monaco 后静态渲染，避免两套编辑器打架
  return (async function () {
    if (typeof disposeMonacoArtifactEditor === 'function') {
      await disposeMonacoArtifactEditor();
    }
    viewEl.innerHTML = '';
    const shell = buildDiffShell(viewEl, { ...o, filePath: art.path });
    renderDiffSideBySide(shell, beforeText, afterText);
    viewEl.appendChild(shell);
  })();
}

window.readArtifactFileText = readArtifactFileText;
window.renderChangesPaneDiffPreview = renderChangesPaneDiffPreview;
window.patchUnifiedDiffInPlace = patchUnifiedDiffInPlace;
