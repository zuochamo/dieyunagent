/* global window, document, PetShapes, uiText */
'use strict';

/**
 * 设置 → 宠物 → 点点 的页面逻辑（主窗口侧）。
 *
 * 这里只读写设置（IPC 走 diecloud.petGetSettings / petSetSettings）；
 * 悬浮窗的创建/销毁/动画全在 Main 的 pet-window 与悬浮窗页面里 —— 设置页不发任何窗口命令，
 * 改了设置 Main 自己同步。形态表与色板来自 pet-shapes.js（与悬浮窗同一份，色值不在此处重复）。
 */

(function () {
  let current = null; // 最近一次拿到的设置（乐观更新 + 防抖提交）
  let pending = null; // 还没落盘的 patch（多次拖动合并成一次提交）
  let saveTimer = 0;
  let bound = false;
  let hintTimer = 0;

  function el(id) {
    return document.getElementById(id);
  }

  function api() {
    return window.diecloud || {};
  }

  function showHint(text) {
    const node = el('pet-hint');
    if (!node) return;
    node.textContent = text;
    if (hintTimer) window.clearTimeout(hintTimer);
    hintTimer = window.setTimeout(() => {
      node.textContent = '';
      hintTimer = 0;
    }, 1600);
  }

  function paint(s) {
    const enabled = el('pet-enabled');
    if (enabled) enabled.checked = s.enabled === true;
    const bind = el('pet-alive-bind');
    if (bind) bind.checked = s.aliveBind !== false;
    const count = el('pet-count');
    const countValue = el('pet-count-value');
    if (count) count.value = String(Math.round(Number(s.count) || 128));
    if (countValue) countValue.textContent = String(Math.round(Number(s.count) || 128));
    const dot = el('pet-dot');
    const dotValue = el('pet-dot-value');
    if (dot) dot.value = String(s.dotScale);
    if (dotValue) dotValue.textContent = `${Math.round((Number(s.dotScale) || 1) * 100)}%`;
    const size = el('pet-size');
    const sizeValue = el('pet-size-value');
    if (size) size.value = String(s.size);
    if (sizeValue) sizeValue.textContent = `${Math.round((Number(s.size) || 1) * 100)}%`;
    const motion = el('pet-motion');
    const motionValue = el('pet-motion-value');
    if (motion) motion.value = String(s.motion);
    if (motionValue) motionValue.textContent = `${Math.round((Number(s.motion) || 1) * 100)}%`;
    document.querySelectorAll('.pet-color-choice').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.petColor === s.color);
    });
  }

  /** 乐观改当前值 + 防抖提交（滑杆连续拖动只落一次盘；**多次改动合并**，别丢前一次的键） */
  function queuePatch(patch) {
    if (!current) return;
    current = { ...current, ...patch };
    pending = { ...(pending || {}), ...patch };
    paint(current);
    if (saveTimer) window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(async () => {
      saveTimer = 0;
      const send = pending || {};
      pending = null;
      const res = await api().petSetSettings(send);
      if (res && res.ok) {
        current = res.settings;
        paint(current);
        showHint(uiText('pet_saved', '已保存'));
      } else {
        showHint((res && res.error) || uiText('pet_save_failed', '保存失败'));
      }
    }, 180);
  }

  function mountColorSwatches() {
    const row = el('pet-color-row');
    if (!row || row.childElementCount) return;
    Object.keys(PetShapes.COLORS).forEach((id) => {
      const [r, g, b] = PetShapes.colorRgb(id);
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'pet-color-choice';
      btn.dataset.petColor = id;
      btn.style.background = `rgb(${r},${g},${b})`;
      btn.setAttribute('aria-label', id);
      btn.addEventListener('click', () => queuePatch({ color: id }));
      row.appendChild(btn);
    });
  }

  function bindOnce() {
    if (bound) return;
    bound = true;
    mountColorSwatches();
    const enabled = el('pet-enabled');
    if (enabled) {
      enabled.addEventListener('change', async () => {
        const res = await api().petSetEnabled(enabled.checked);
        if (res && res.ok) {
          current = res.settings;
          paint(current);
          showHint(uiText('pet_saved', '已保存'));
        }
      });
    }
    const bind = el('pet-alive-bind');
    if (bind) {
      bind.addEventListener('change', () => queuePatch({ aliveBind: bind.checked }));
    }
    const count = el('pet-count');
    if (count) {
      count.addEventListener('input', () => queuePatch({ count: Math.round(Number(count.value)) }));
    }
    const dot = el('pet-dot');
    if (dot) {
      dot.addEventListener('input', () => queuePatch({ dotScale: Number(dot.value) }));
    }
    const size = el('pet-size');
    if (size) {
      size.addEventListener('input', () => queuePatch({ size: Number(size.value) }));
    }
    const motion = el('pet-motion');
    if (motion) {
      motion.addEventListener('input', () => queuePatch({ motion: Number(motion.value) }));
    }
  }

  async function refresh() {
    const res = await api().petGetSettings();
    if (res && res.ok && res.settings) {
      current = res.settings;
      paint(current);
    }
  }

  function onPetSettingsTabShown() {
    bindOnce();
    refresh();
  }

  window.onPetSettingsTabShown = onPetSettingsTabShown;
  onPetSettingsTabShown();
})();
