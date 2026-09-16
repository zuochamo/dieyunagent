/* global document, $, setMaximizeButtonState, paintWinControlButton */
'use strict';

function resetDialogMaximize(overlayId, maxBtnId) {
  const overlay = $(overlayId);
  if (overlay) overlay.classList.remove('dialog-maximized');
  const maxBtn = $(maxBtnId);
  if (!maxBtn) return;
  if (typeof setMaximizeButtonState === 'function') {
    setMaximizeButtonState(maxBtn, false);
  } else if (typeof paintWinControlButton === 'function') {
    paintWinControlButton(maxBtn);
  }
}

function setDialogMaximized(overlayId, maxBtnId) {
  const overlay = $(overlayId);
  if (overlay) overlay.classList.add('dialog-maximized');
  const maxBtn = $(maxBtnId);
  if (!maxBtn) return;
  if (typeof setMaximizeButtonState === 'function') {
    setMaximizeButtonState(maxBtn, true);
  } else if (typeof paintWinControlButton === 'function') {
    paintWinControlButton(maxBtn);
  }
}
