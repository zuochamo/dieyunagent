/* global window, document, settings, saveSettings, escapeHtml */
'use strict';

/**
 * 快捷键的**唯一来源**：默认键位 → 实际生效键位 → 按键匹配 → 「基础设置 → 快捷键」页。
 *
 * 别处判按键只调 `matchesShortcut(ev, 'voice.toggle')`，不要再写 `ev.key === 'm'`：
 * 键位是用户可改的（存在 `settings.shortcuts[id]`，缺省回落 `defaultCombo`），
 * 任何一处硬编码都会在用户改键后静默失效。
 *
 * 组合键字符串形如 `Ctrl+Shift+M`：修饰键顺序固定 Ctrl → Alt → Shift，最后是主键。
 * `Ctrl` 同时代表 macOS 的 ⌘（沿用旧代码 `ev.ctrlKey || ev.metaKey` 的口径）。
 */

const SHORTCUT_DEFS = [
  {
    id: 'voice.toggle',
    label: '语音输入（录音 / 转写）',
    desc: '开 / 关录音；录完点「转写」或再按一次结束，Esc 取消。',
    defaultCombo: 'Ctrl+M'
  },
  {
    id: 'settings.open',
    label: '打开设置',
    desc: '直接打开「定义模型」页。',
    defaultCombo: 'Alt+S'
  },
  {
    id: 'skills.open',
    label: '技能 / MCP 面板',
    desc: '再按一次收起。',
    defaultCombo: 'Alt+K'
  },
  {
    id: 'automation.open',
    label: '执行（锚点 / 定时 / API）',
    desc: '再按一次收起。',
    defaultCombo: 'Alt+E'
  },
  {
    id: 'help.open',
    label: '打开帮助',
    desc: '',
    defaultCombo: 'Alt+H'
  }
];

// 只按修饰键不算「按到了主键」，录入时要继续等
const SHORTCUT_MODIFIER_KEYS = new Set(['Control', 'Alt', 'Shift', 'Meta', 'OS', 'AltGraph', 'CapsLock']);
// 功能键可以不带修饰键（其余裸键会让正常打字不可用）
const SHORTCUT_BARE_KEY_RE = /^F([1-9]|1[0-9]|2[0-4])$/;
const SHORTCUT_UNUSABLE_KEYS = new Set(['Process', 'Dead', 'Unidentified']);

// 正在等待新按键的快捷键 id（录入期间所有全局快捷键一律让路，见 matchesShortcut）
let shortcutRecordingId = '';

function shortcutDef(id) {
  return SHORTCUT_DEFS.find((def) => def.id === id) || null;
}

function getShortcutCombo(id) {
  const def = shortcutDef(id);
  if (!def) return '';
  const custom = settings && settings.shortcuts ? settings.shortcuts[id] : '';
  const combo = typeof custom === 'string' ? custom.trim() : '';
  return combo || def.defaultCombo;
}

function isShortcutCustomized(id) {
  const def = shortcutDef(id);
  return !!def && getShortcutCombo(id) !== def.defaultCombo;
}

function normalizeShortcutKey(key) {
  const raw = String(key == null ? '' : key);
  if (!raw) return '';
  if (raw === ' ' || raw === 'Spacebar') return 'Space';
  if (raw.length === 1) return raw.toUpperCase();
  const arrow = /^arrow(\w+)$/i.exec(raw);
  if (arrow) {
    const dir = arrow[1].toLowerCase();
    return `Arrow${dir.charAt(0).toUpperCase()}${dir.slice(1)}`;
  }
  return raw; // F5 / Enter / Escape / PageUp / Backspace …
}

function parseShortcutCombo(combo) {
  const parsed = { ctrl: false, alt: false, shift: false, key: '' };
  for (const rawPart of String(combo || '').split('+')) {
    const part = rawPart.trim();
    if (!part) continue;
    const low = part.toLowerCase();
    if (low === 'ctrl' || low === 'control' || low === 'cmd' || low === 'command' || low === 'meta' || low === 'win' || low === 'super') {
      parsed.ctrl = true;
      continue;
    }
    if (low === 'alt' || low === 'option') {
      parsed.alt = true;
      continue;
    }
    if (low === 'shift') {
      parsed.shift = true;
      continue;
    }
    parsed.key = normalizeShortcutKey(part);
  }
  return parsed;
}

function shortcutKeyFromEvent(ev) {
  const code = String(ev?.code || '');
  const letter = /^Key([A-Z])$/.exec(code);
  if (letter) return letter[1];
  const digit = /^Digit([0-9])$/.exec(code);
  if (digit) return digit[1];
  const fn = /^(F[0-9]{1,2})$/.exec(code);
  if (fn) return fn[1];
  const key = String(ev?.key || '');
  if (!key || SHORTCUT_MODIFIER_KEYS.has(key) || SHORTCUT_UNUSABLE_KEYS.has(key)) return '';
  return normalizeShortcutKey(key);
}

/** 一次 keydown → 规范组合键字符串；返回 '' 表示「还不能确定」（只按了修饰键 / 无效键）。 */
function comboFromShortcutEvent(ev) {
  const key = shortcutKeyFromEvent(ev);
  if (!key) return '';
  const mods = [];
  if (ev.ctrlKey || ev.metaKey) mods.push('Ctrl');
  if (ev.altKey) mods.push('Alt');
  if (ev.shiftKey) mods.push('Shift');
  if (!mods.length && !SHORTCUT_BARE_KEY_RE.test(key)) return '';
  return mods.concat(key).join('+');
}

function shortcutCombosEqual(a, b) {
  const x = parseShortcutCombo(a);
  const y = parseShortcutCombo(b);
  if (!x.key || !y.key) return false;
  return (
    x.key.toLowerCase() === y.key.toLowerCase() &&
    x.ctrl === y.ctrl &&
    x.alt === y.alt &&
    x.shift === y.shift
  );
}

/** 该快捷键当前是否被这次按键触发（调用方仍需自己 preventDefault）。 */
function matchesShortcut(ev, id) {
  if (!ev || shortcutRecordingId) return false;
  const want = parseShortcutCombo(getShortcutCombo(id));
  if (!want.key) return false;
  const key = shortcutKeyFromEvent(ev);
  if (!key || key.toLowerCase() !== want.key.toLowerCase()) return false;
  return (
    ((!!ev.ctrlKey || !!ev.metaKey) === want.ctrl) &&
    (!!ev.altKey === want.alt) &&
    (!!ev.shiftKey === want.shift)
  );
}

/** 这个组合键是否已被别的快捷键占用（返回那一条定义，没有则 null）。 */
function shortcutConflict(id, combo) {
  return (
    SHORTCUT_DEFS.find((def) => def.id !== id && shortcutCombosEqual(getShortcutCombo(def.id), combo)) || null
  );
}

function saveShortcutCombo(id, combo) {
  const def = shortcutDef(id);
  if (!def || !settings) return false;
  const next = String(combo || '').trim();
  const map = { ...(settings.shortcuts || {}) };
  // 与默认一致就删掉这条覆盖，别在设置里留一份和默认重复的副本
  if (!next || next === def.defaultCombo) delete map[id];
  else map[id] = next;
  settings.shortcuts = map;
  if (typeof saveSettings === 'function') saveSettings(settings);
  syncShortcutLabels();
  renderShortcutsSettingsPage();
  return true;
}

function setShortcutHint(text) {
  const hint = document.getElementById('shortcut-save-hint');
  if (hint) hint.textContent = String(text || '');
}

/**
 * 把页面里写的 `Ctrl+M` 之类的静态文案换成当前实际键位。
 * `data-shortcut-label="<id>"`：元素文字 = 组合键；
 * 带 `data-shortcut-title-tpl="…%s…"`：只把组合键塞进 title，不动文字（图标按钮用）。
 */
function syncShortcutLabels() {
  document.querySelectorAll('[data-shortcut-label]').forEach((el) => {
    const id = el.getAttribute('data-shortcut-label');
    if (!id) return;
    const combo = getShortcutCombo(id);
    const tpl = el.getAttribute('data-shortcut-title-tpl');
    if (tpl) {
      el.title = String(tpl).replace('%s', combo);
      return;
    }
    el.textContent = combo;
  });
}

function shortcutRowHtml(def) {
  const combo = getShortcutCombo(def.id);
  const customized = isShortcutCustomized(def.id);
  const recording = shortcutRecordingId === def.id;
  const comboText = recording ? '按下新按键…' : combo || '未设置';
  return (
    `<div class="shortcut-row${recording ? ' is-recording' : ''}">` +
    '<div class="shortcut-text">' +
    `<span class="shortcut-name">${escapeShortcutText(def.label)}</span>` +
    (def.desc ? `<span class="shortcut-desc">${escapeShortcutText(def.desc)}</span>` : '') +
    '</div>' +
    '<div class="shortcut-controls">' +
    (customized ? '<span class="shortcut-badge">已改</span>' : '') +
    `<button type="button" class="shortcut-combo${recording ? ' is-recording' : ''}" ` +
    `data-shortcut-capture="${escapeShortcutText(def.id)}" title="点击后按下新的组合键">` +
    `${escapeShortcutText(comboText)}</button>` +
    '</div>' +
    '</div>'
  );
}

function escapeShortcutText(value) {
  if (typeof escapeHtml === 'function') return escapeHtml(value);
  return String(value == null ? '' : value);
}

function renderShortcutsSettingsPage() {
  const list = document.getElementById('shortcut-list');
  if (!list) return;
  // 正在录制的行可能已经不在页面上（切页 / 关面板）：录制状态跟着页面一起失效
  if (shortcutRecordingId && (!shortcutDef(shortcutRecordingId) || !isShortcutsPageVisible())) {
    shortcutRecordingId = '';
  }
  list.innerHTML = SHORTCUT_DEFS.map(shortcutRowHtml).join('');
  syncShortcutLabels();
}

function startShortcutCapture(id) {
  if (!shortcutDef(id)) return;
  shortcutRecordingId = id;
  setShortcutHint('按下新的组合键（Esc 取消）');
  renderShortcutsSettingsPage();
}

function finishShortcutCapture(combo) {
  const id = shortcutRecordingId;
  shortcutRecordingId = '';
  if (!id) return;
  if (combo) {
    saveShortcutCombo(id, combo);
    setShortcutHint(`已保存：${combo}`);
    return;
  }
  renderShortcutsSettingsPage();
}

function handleShortcutCaptureKey(ev) {
  // 页已经不可见（切页 / 关窗）：录制状态作废，别在别处继续吞按键
  if (shortcutRecordingId && !isShortcutsPageVisible()) shortcutRecordingId = '';
  if (!shortcutRecordingId) return false;
  // 录入期间这一下按键属于录入本身：任何全局快捷键都不许响应
  ev.preventDefault();
  ev.stopPropagation();
  if (ev.repeat) return true;
  if (ev.key === 'Escape') {
    shortcutRecordingId = '';
    renderShortcutsSettingsPage();
    setShortcutHint('已取消');
    return true;
  }
  const combo = comboFromShortcutEvent(ev);
  if (!combo) return true; // 只按了修饰键之类的半成品：继续等
  const conflict = shortcutConflict(shortcutRecordingId, combo);
  if (conflict) {
    setShortcutHint(`「${combo}」已被「${conflict.label}」占用，换一个`);
    return true;
  }
  finishShortcutCapture(combo);
  return true;
}

function initShortcuts() {
  const list = document.getElementById('shortcut-list');
  if (list && !list.dataset.bound) {
    list.dataset.bound = '1';
    list.addEventListener('click', (ev) => {
      const captureBtn = ev.target.closest('[data-shortcut-capture]');
      if (!captureBtn) return;
      startShortcutCapture(captureBtn.getAttribute('data-shortcut-capture'));
    });
  }
  // 录入中点到别处（不是另一个键位按钮）就取消录入，别把键盘一直扣在录入状态里
  const overlay = document.getElementById('settings-overlay');
  if (overlay && !overlay.dataset.shortcutBound) {
    overlay.dataset.shortcutBound = '1';
    overlay.addEventListener('click', (ev) => {
      if (!shortcutRecordingId) return;
      if (ev.target?.closest?.('[data-shortcut-capture]')) return;
      shortcutRecordingId = '';
      renderShortcutsSettingsPage();
      setShortcutHint('已取消');
    });
  }
  // 捕获阶段：录入中的按键不能先被各处的全局快捷键吃掉
  document.addEventListener('keydown', (ev) => handleShortcutCaptureKey(ev), true);
  window.addEventListener('dieyun:language-change', () => {
    if (isShortcutsPageVisible()) renderShortcutsSettingsPage();
  });
  syncShortcutLabels();
}

function isShortcutsPageVisible() {
  const overlay = document.getElementById('settings-overlay');
  if (overlay && overlay.hidden) return false;
  return !!document.querySelector('.settings-page[data-settings="shortcuts"].active');
}

window.initShortcuts = initShortcuts;
window.renderShortcutsSettingsPage = renderShortcutsSettingsPage;
window.getShortcutCombo = getShortcutCombo;
window.matchesShortcut = matchesShortcut;
window.syncShortcutLabels = syncShortcutLabels;
