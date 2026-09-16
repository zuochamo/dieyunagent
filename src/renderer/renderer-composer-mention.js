/* global document, $, chatInput, insertComposerQuotedText */
'use strict';

function updateComposerMentionMenu() {
  const menu = $('composer-mention-menu');
  if (!menu || !chatInput) return;
  const pos = chatInput.selectionStart || 0;
  const left = chatInput.value.slice(0, pos);
  const atMatch = left.match(/(?:^|\s)@(\S*)$/);
  if (!atMatch) {
    menu.hidden = true;
    return;
  }
  menu.hidden = !/(^|\s)@$/.test(left);
}

function insertComposerMention(name) {
  if (!chatInput) return;
  const pos = chatInput.selectionStart || 0;
  const left = chatInput.value.slice(0, pos);
  const after = chatInput.value.slice(pos);
  const before = /(^|\s)@\S*$/.test(left)
    ? left.replace(/(^|\s)@\S*$/, (m, p1) => `${p1}@${name} `)
    : left.replace(/(^|\s)@$/, (m, p1) => `${p1}@${name} `);
  chatInput.value = before + after;
  const nextPos = before.length;
  chatInput.focus();
  chatInput.setSelectionRange(nextPos, nextPos);
  updateComposerMentionMenu();
  if (typeof refreshContextProgress === 'function') refreshContextProgress();
}

function initComposerMentionMenu() {
  const menu = $('composer-mention-menu');
  if (!menu || !chatInput) return;
  menu.querySelectorAll('[data-mention]').forEach((btn) => {
    btn.addEventListener('click', () => insertComposerMention(btn.dataset.mention || 'Codebase'));
  });
  chatInput.addEventListener('keyup', updateComposerMentionMenu);
  chatInput.addEventListener('click', updateComposerMentionMenu);
  document.addEventListener('click', (e) => {
    if (e.target === chatInput || e.target.closest?.('#composer-mention-menu')) return;
    menu.hidden = true;
  });
}
