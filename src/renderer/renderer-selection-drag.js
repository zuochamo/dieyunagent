/* global document, chatInput, composerBox, refreshContextProgress, updateComposerMentionMenu */
'use strict';

const SELECTION_DRAG_SOURCE_SELECTORS = [
  '#chat-list',
  '#artifacts-file-view',
  '.side-panel-body',
  '.changes-panel-body',
  '.msg-thinking-body',
  '.msg-tool-inline-diff-grid',
  '.agents-md-diff-pre'
];

function isSelectionDragSource(node) {
  if (!node || typeof node.closest !== 'function') return false;
  return SELECTION_DRAG_SOURCE_SELECTORS.some((sel) => node.closest(sel));
}

function getNativeSelectionText() {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed) return '';
  return String(sel.toString()).replace(/\r\n/g, '\n');
}

function insertComposerQuotedText(text) {
  if (!chatInput) return;
  const raw = String(text || '').replace(/\r\n/g, '\n');
  if (!raw.trim()) return;

  const start = chatInput.selectionStart ?? chatInput.value.length;
  const end = chatInput.selectionEnd ?? start;
  const before = chatInput.value.slice(0, start);
  const after = chatInput.value.slice(end);

  let prefix = '';
  if (before.length > 0) {
    prefix = before.endsWith('\n\n') ? '' : before.endsWith('\n') ? '\n' : '\n\n';
  }

  const snippet = `${prefix}${raw}`;
  chatInput.value = before + snippet + after;
  const pos = before.length + snippet.length;
  chatInput.focus();
  chatInput.setSelectionRange(pos, pos);

  if (typeof refreshContextProgress === 'function') refreshContextProgress();
  if (typeof updateComposerMentionMenu === 'function') updateComposerMentionMenu();
}

function setComposerTextDropHighlight(on) {
  if (!composerBox) return;
  composerBox.classList.toggle('is-text-drop-target', !!on);
}

function initSelectionToComposerDrag() {
  if (!chatInput || !composerBox) return;

  document.addEventListener(
    'dragstart',
    (e) => {
      if (!isSelectionDragSource(e.target)) return;
      const text = getNativeSelectionText();
      if (!text.trim()) return;
      if (!e.dataTransfer) return;
      e.dataTransfer.setData('text/plain', text);
      e.dataTransfer.effectAllowed = 'copy';
    },
    true
  );

  let dragDepth = 0;

  composerBox.addEventListener('dragenter', (ev) => {
    if ((ev.dataTransfer?.types || []).includes('Files')) return;
    dragDepth += 1;
    setComposerTextDropHighlight(true);
  });

  composerBox.addEventListener('dragleave', (ev) => {
    if (ev.relatedTarget && composerBox.contains(ev.relatedTarget)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) setComposerTextDropHighlight(false);
  });

  composerBox.addEventListener('dragover', (ev) => {
    const hasFiles = (ev.dataTransfer?.files?.length || 0) > 0;
    const types = ev.dataTransfer?.types ? [...ev.dataTransfer.types] : [];
    const hasText = types.includes('text/plain') || types.includes('Text');
    if (!hasFiles && hasText) {
      ev.preventDefault();
      if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'copy';
      setComposerTextDropHighlight(true);
    }
  });

  composerBox.addEventListener('drop', () => {
    dragDepth = 0;
    setComposerTextDropHighlight(false);
  });
}

function wireMonacoEditorSelectionDrag(editor) {
  if (!editor || typeof editor.getDomNode !== 'function') return;
  const dom = editor.getDomNode();
  if (!dom || dom.dataset.selectionDragWired === '1') return;
  dom.dataset.selectionDragWired = '1';
  dom.addEventListener('dragstart', (e) => {
    const model = editor.getModel && editor.getModel();
    const sel = editor.getSelection && editor.getSelection();
    if (!model || !sel || sel.isEmpty()) return;
    let text = '';
    try {
      text = model.getValueInRange(sel);
    } catch {
      text = getNativeSelectionText();
    }
    if (!String(text).trim() || !e.dataTransfer) return;
    e.dataTransfer.setData('text/plain', String(text).replace(/\r\n/g, '\n'));
    e.dataTransfer.effectAllowed = 'copy';
  });
}

window.insertComposerQuotedText = insertComposerQuotedText;
window.initSelectionToComposerDrag = initSelectionToComposerDrag;
window.wireMonacoEditorSelectionDrag = wireMonacoEditorSelectionDrag;
