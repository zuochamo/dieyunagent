/* global document, window */
'use strict';

function clampNumber(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function loadPaneSizeVar(key, cssVar, fallback) {
  try {
    const raw = Number(window.localStorage.getItem(key));
    if (Number.isFinite(raw) && raw > 0) {
      document.documentElement.style.setProperty(cssVar, `${raw}%`);
      return raw;
    }
  } catch {
    // ignore
  }
  if (fallback) document.documentElement.style.setProperty(cssVar, fallback);
  return null;
}

function savePaneSizeVar(key, value) {
  try {
    window.localStorage.setItem(key, String(Math.round(value * 10) / 10));
  } catch {
    // ignore
  }
}

function bindPaneDrag(el, onMove, onDone, opts) {
  if (!el) return;
  const bodyClass = (opts && opts.bodyClass) || 'pane-resizing';
  el.addEventListener('pointerdown', function (e) {
    e.preventDefault();
    e.stopPropagation();
    document.body.classList.add(bodyClass);
    if (el.setPointerCapture) {
      try {
        el.setPointerCapture(e.pointerId);
      } catch {
        // ignore
      }
    }
    const move = function (ev) {
      ev.preventDefault();
      onMove(ev);
    };
    const up = function (ev) {
      document.body.classList.remove(bodyClass);
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', up);
      if (el.releasePointerCapture) {
        try {
          el.releasePointerCapture(ev.pointerId);
        } catch {
          // ignore
        }
      }
      if (typeof onDone === 'function') onDone();
    };
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up, { once: true });
  });
}

function initPaneResizers() {
  const outer = document.getElementById('artifacts-pane-resizer');
  const inner = document.getElementById('artifacts-inner-resizer');
  const main = document.getElementById('agent-main');
  const body = document.querySelector('.artifacts-panel-body');
  loadPaneSizeVar('diecloud.ui.artifactsPanelWidth.v1', '--artifacts-panel-width', '45%');
  loadPaneSizeVar('diecloud.ui.artifactsListWidth.v1', '--artifacts-list-width', '38%');

  let outerPct = null;
  bindPaneDrag(
    outer,
    function (e) {
      if (!main || !main.classList.contains('side-panel-open')) return;
      const rect = main.getBoundingClientRect();
      const minPanel = Math.min(300, rect.width * 0.25);
      const minChat = Math.min(420, rect.width * 0.35);
      const panelPx = clampNumber(rect.right - e.clientX, minPanel, Math.max(minPanel, rect.width - minChat));
      outerPct = clampNumber((panelPx / rect.width) * 100, 20, 75);
      document.documentElement.style.setProperty('--artifacts-panel-width', `${outerPct}%`);
    },
    function () {
      if (outerPct != null) savePaneSizeVar('diecloud.ui.artifactsPanelWidth.v1', outerPct);
    }
  );

  let innerPct = null;
  bindPaneDrag(
    inner,
    function (e) {
      if (!body) return;
      const rect = body.getBoundingClientRect();
      const minList = Math.min(160, rect.width * 0.35);
      const minView = Math.min(220, rect.width * 0.4);
      const listPx = clampNumber(e.clientX - rect.left, minList, Math.max(minList, rect.width - minView));
      innerPct = clampNumber((listPx / rect.width) * 100, 18, 70);
      document.documentElement.style.setProperty('--artifacts-list-width', `${innerPct}%`);
    },
    function () {
      if (innerPct != null) savePaneSizeVar('diecloud.ui.artifactsListWidth.v1', innerPct);
    }
  );

  initComposerInputResizer();
}

const COMPOSER_INPUT_HEIGHT_MIN = 44;

function applyComposerInputHeight(px) {
  const box = document.getElementById('composer-box');
  const n = Math.round(Number(px));
  if (!Number.isFinite(n) || n < COMPOSER_INPUT_HEIGHT_MIN) return;
  document.documentElement.style.setProperty('--composer-input-height', `${n}px`);
  if (box) box.classList.add('is-composer-resized');
}

function composerInputHeightMax() {
  const col = document.querySelector('.agent-chat-column');
  const h = col ? col.getBoundingClientRect().height : window.innerHeight;
  return Math.max(COMPOSER_INPUT_HEIGHT_MIN + 40, Math.floor(h * 0.72));
}

function initComposerInputResizer() {
  const handle = document.getElementById('boot-chat-progress');
  const input = document.getElementById('chat-input');
  if (!handle || !input) return;
  let startY = 0;
  let startH = 0;
  handle.addEventListener('pointerdown', function (e) {
    startY = e.clientY;
    startH = input.getBoundingClientRect().height;
  });
  // 高度仅本次会话内生效，不持久化；重启后回到默认值
  bindPaneDrag(
    handle,
    function (e) {
      const next = clampNumber(startH - (e.clientY - startY), COMPOSER_INPUT_HEIGHT_MIN, composerInputHeightMax());
      applyComposerInputHeight(next);
    },
    null,
    { bodyClass: 'composer-resizing' }
  );
}
