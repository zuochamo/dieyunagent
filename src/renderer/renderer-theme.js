/* global window, document, $, renderChatFromMessages */
const themeApi = window.diecloud || {};
const THEME_KEY = 'diecloud.theme.v1';
const OPACITY_KEY = 'diecloud.window.opacity.v1';
const OPACITY_MIN = 50;
const OPACITY_MAX = 100;
const FONT_SIZE_KEY = 'diecloud.ui.fontSize.v1';
const FONT_SIZE_MIN = 90;
const FONT_SIZE_MAX = 150;
const FONT_SIZE_DEFAULT = 100;
const COLOR_TEMP_KEY = 'diecloud.ui.colorTemp.v1';
const COLOR_TEMP_MIN = 0;
const COLOR_TEMP_MAX = 100;
const COLOR_TEMP_DEFAULT = 50;
const TRACE_PREFS_KEY = 'diecloud.trace.prefs.v1';
const TRACE_PREF_DEFAULTS = {
  showReasoning: true,
  showTitles: true,
  expandShell: false,
  expandEdit: true,
  followWrites: true,
  showReadiness: true,
  dampedFlow: false
};
var tracePrefs = loadTracePrefs();

function loadTracePrefs() {
  try {
    const raw = JSON.parse(window.localStorage.getItem(TRACE_PREFS_KEY) || '{}');
    return {
      showReasoning: raw.showReasoning !== false,
      showTitles: raw.showTitles !== false,
      expandShell: raw.expandShell === true,
      expandEdit: raw.expandEdit !== false,
      followWrites: raw.followWrites !== false,
      showReadiness: raw.showReadiness !== false,
      dampedFlow: raw.dampedFlow === true
    };
  } catch {
    return { ...TRACE_PREF_DEFAULTS };
  }
}

function saveTracePrefs() {
  try {
    window.localStorage.setItem(TRACE_PREFS_KEY, JSON.stringify(tracePrefs));
  } catch {
    // ignore
  }
}

function syncTracePrefInputs() {
  const show = $('trace-show-reasoning');
  const titles = $('trace-show-titles');
  const shell = $('trace-expand-shell');
  const edit = $('trace-expand-edit');
  const follow = $('trace-follow-writes');
  if (show) show.checked = tracePrefs.showReasoning !== false;
  if (titles) titles.checked = tracePrefs.showTitles !== false;
  if (shell) shell.checked = tracePrefs.expandShell === true;
  if (edit) edit.checked = tracePrefs.expandEdit !== false;
  if (follow) follow.checked = tracePrefs.followWrites !== false;
  const readiness = $('trace-show-readiness');
  if (readiness) readiness.checked = tracePrefs.showReadiness !== false;
  const damped = $('trace-damped-flow');
  if (damped) damped.checked = tracePrefs.dampedFlow === true;
}

/**
 * 「无极阻尼」（设置 → 主题）的唯一判定：思考区连续入流（CSS 侧看
 * :root[data-thinking-flow='damped']）与贴底阻尼跟随（renderer-chat-render.js）都以它为准。
 * 系统的「减少动效」优先：宁可退回整块瞬现，也不做与无障碍设置相抗的动画。
 */
function isThinkingDampedFlow() {
  if (tracePrefs.dampedFlow !== true) return false;
  try {
    return !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return true;
  }
}

/** 把开关落到 :root 上的一个属性，CSS 只认它（不在选择器里重复判偏好） */
function applyThinkingFlowPref() {
  const root = document.documentElement;
  if (isThinkingDampedFlow()) root.setAttribute('data-thinking-flow', 'damped');
  else root.removeAttribute('data-thinking-flow');
}

function syncThemeCards() {
  const cur = document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
  document.querySelectorAll('.theme-choice').forEach((el) => {
    el.classList.toggle('active', el.dataset.themeValue === cur);
  });
}

function applyTheme(mode) {
  const m = mode === 'light' ? 'light' : 'dark';
  if (m === 'light') {
    document.documentElement.setAttribute('data-theme', 'light');
  } else {
    document.documentElement.removeAttribute('data-theme');
  }
  try {
    window.localStorage.setItem(THEME_KEY, m);
  } catch {
    // ignore
  }
  syncThemeCards();
  if (typeof refreshDieyunMonacoTheme === 'function') {
    refreshDieyunMonacoTheme();
  }
}

(function initTheme() {
  try {
    const s = window.localStorage.getItem(THEME_KEY);
    applyTheme(s === 'dark' ? 'dark' : 'light');
  } catch {
    applyTheme('light');
  }
})();

function applyWindowOpacity(percent) {
  const p = Math.min(OPACITY_MAX, Math.max(OPACITY_MIN, Math.round(Number(percent) || OPACITY_MAX)));
  const el = $('theme-opacity');
  const label = $('opacity-value');
  if (el) el.value = String(p);
  if (label) label.textContent = `${p}%`;
  if (themeApi.setWindowOpacity) {
    themeApi.setWindowOpacity(p / 100);
  }
  try {
    window.localStorage.setItem(OPACITY_KEY, String(p));
  } catch {
    // ignore
  }
}

(function initOpacity() {
  let stored = OPACITY_MAX;
  try {
    const raw = window.localStorage.getItem(OPACITY_KEY);
    if (raw != null) stored = Number(raw);
  } catch {
    // ignore
  }
  applyWindowOpacity(stored);
})();

function applyFontSize(percent) {
  const p = Math.min(
    FONT_SIZE_MAX,
    Math.max(FONT_SIZE_MIN, Math.round(Number(percent) || FONT_SIZE_DEFAULT))
  );
  const el = $('theme-font-size');
  const label = $('font-size-value');
  if (el) el.value = String(p);
  if (label) label.textContent = `${p}%`;
  if (themeApi.setWindowZoom) {
    themeApi.setWindowZoom(p / 100);
  }
  try {
    window.localStorage.setItem(FONT_SIZE_KEY, String(p));
  } catch {
    // ignore
  }
}

(function initFontSize() {
  let stored = FONT_SIZE_DEFAULT;
  try {
    const raw = window.localStorage.getItem(FONT_SIZE_KEY);
    if (raw != null) stored = Number(raw);
  } catch {
    // ignore
  }
  applyFontSize(stored);
})();

function colorTempLabel(value) {
  const p = Math.round(Number(value) || COLOR_TEMP_DEFAULT);
  const i18n = window.dieyunI18n && window.dieyunI18n.t ? window.dieyunI18n.t : (k) => k;
  if (p === COLOR_TEMP_DEFAULT) return i18n('color_temp_neutral');
  if (p < COLOR_TEMP_DEFAULT) {
    const pct = Math.round(((COLOR_TEMP_DEFAULT - p) / COLOR_TEMP_DEFAULT) * 100);
    return `${i18n('color_temp_cool')} ${pct}%`;
  }
  const pct = Math.round(((p - COLOR_TEMP_DEFAULT) / (COLOR_TEMP_MAX - COLOR_TEMP_DEFAULT)) * 100);
  return `${i18n('color_temp_warm')} ${pct}%`;
}

function applyColorTemperature(percent) {
  const p = Math.min(
    COLOR_TEMP_MAX,
    Math.max(COLOR_TEMP_MIN, Math.round(Number(percent) || COLOR_TEMP_DEFAULT))
  );
  const el = $('theme-color-temp');
  const label = $('color-temp-value');
  if (el) el.value = String(p);
  if (label) label.textContent = colorTempLabel(p);

  const bias = (p - COLOR_TEMP_DEFAULT) / COLOR_TEMP_DEFAULT;
  if (Math.abs(bias) < 0.02) {
    document.documentElement.style.filter = '';
    document.documentElement.removeAttribute('data-color-temp');
  } else if (bias > 0) {
    const sepia = bias * 0.32;
    const hue = bias * -10;
    document.documentElement.style.filter = `sepia(${sepia}) hue-rotate(${hue}deg)`;
    document.documentElement.dataset.colorTemp = 'warm';
  } else {
    const hue = bias * 14;
    document.documentElement.style.filter = `hue-rotate(${hue}deg) saturate(${1 + Math.abs(bias) * 0.06})`;
    document.documentElement.dataset.colorTemp = 'cool';
  }

  try {
    window.localStorage.setItem(COLOR_TEMP_KEY, String(p));
  } catch {
    // ignore
  }
}

(function initColorTemperature() {
  let stored = COLOR_TEMP_DEFAULT;
  try {
    const raw = window.localStorage.getItem(COLOR_TEMP_KEY);
    if (raw != null) stored = Number(raw);
  } catch {
    // ignore
  }
  applyColorTemperature(stored);
})();

const themeFontSizeInput = $('theme-font-size');
if (themeFontSizeInput) {
  themeFontSizeInput.addEventListener('input', () => {
    applyFontSize(themeFontSizeInput.value);
  });
}

const themeOpacityInput = $('theme-opacity');
if (themeOpacityInput) {
  themeOpacityInput.addEventListener('input', () => {
    applyWindowOpacity(themeOpacityInput.value);
  });
}

const themeColorTempInput = $('theme-color-temp');
if (themeColorTempInput) {
  themeColorTempInput.addEventListener('input', () => {
    applyColorTemperature(themeColorTempInput.value);
  });
}

$('theme-dark')?.addEventListener('click', () => applyTheme('dark'));
$('theme-light')?.addEventListener('click', () => applyTheme('light'));

async function syncAutoLaunchToggle() {
  const el = $('theme-auto-launch');
  const row = $('theme-auto-launch-row');
  const hint = $('theme-auto-launch-hint');
  if (!el || !themeApi.getAutoLaunch) return;
  try {
    const state = await themeApi.getAutoLaunch();
    el.checked = state.enabled === true;
    el.disabled = !state.available;
    if (row) row.classList.toggle('disabled', !state.available);
    if (hint) hint.hidden = state.available !== false;
  } catch {
    // ignore
  }
}

(function initAutoLaunchToggle() {
  const el = $('theme-auto-launch');
  if (!el || !themeApi.setAutoLaunch) return;
  el.addEventListener('change', async () => {
    const want = el.checked === true;
    el.disabled = true;
    try {
      const result = await themeApi.setAutoLaunch(want);
      if (result && result.ok === false) {
        el.checked = !want;
      } else if (result) {
        el.checked = result.enabled === true;
      }
    } catch {
      el.checked = !want;
    } finally {
      syncAutoLaunchToggle();
    }
  });
  if (themeApi.onAutoLaunchChanged) {
    themeApi.onAutoLaunchChanged(() => {
      syncAutoLaunchToggle();
    });
  }
  syncAutoLaunchToggle();
})();

window.syncThemeAutoLaunchToggle = syncAutoLaunchToggle;

syncTracePrefInputs();
applyThinkingFlowPref();
[
  ['trace-show-reasoning', 'showReasoning', true],
  ['trace-show-titles', 'showTitles', true],
  ['trace-expand-shell', 'expandShell', true],
  ['trace-expand-edit', 'expandEdit', true],
  // 跟随开关只影响后续写入，重绘整轮聊天开销大且无必要
  ['trace-follow-writes', 'followWrites', false],
  // 完成验收提示只作用于之后的新回复，历史消息已落库，重绘也不会变
  ['trace-show-readiness', 'showReadiness', false],
  // 无极阻尼是纯呈现层开关：只翻 :root 属性，聊天重绘一遍反而会让历史块白跑一遍入场
  ['trace-damped-flow', 'dampedFlow', false, applyThinkingFlowPref]
].forEach(([id, key, rerender, effect]) => {
  const el = $(id);
  if (!el) return;
  el.addEventListener('change', () => {
    tracePrefs = { ...tracePrefs, [key]: el.checked === true };
    saveTracePrefs();
    if (typeof effect === 'function') effect();
    if (!rerender) return;
    if (typeof renderChatFromMessagesYielding === 'function') {
      void renderChatFromMessagesYielding();
    } else {
      renderChatFromMessages();
    }
  });
});
