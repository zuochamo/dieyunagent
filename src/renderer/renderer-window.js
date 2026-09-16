/* global window, document, $, escapeHtml, uiText, closeSettingsModal, closeExecuteModal, closeHelpModal, closeAutomationEditor */
const windowApi = window.diecloud || {};

/** Match left menubar icons: 24 viewBox @ 12px, stroke ~1.75 */
const TITLEBAR_ICON_STROKE = '1.75';

const WIN_CTRL_SVG = {
  min: `<svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true"><path d="M5 12h14" fill="none" stroke="currentColor" stroke-width="${TITLEBAR_ICON_STROKE}" stroke-linecap="round"/></svg>`,
  max: `<svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true"><rect x="5.5" y="5.5" width="13" height="13" fill="none" stroke="currentColor" stroke-width="${TITLEBAR_ICON_STROKE}"/></svg>`,
  restore: `<svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true"><path d="M5.5 14V6.5H13" fill="none" stroke="currentColor" stroke-width="${TITLEBAR_ICON_STROKE}" stroke-linejoin="miter"/><rect x="10.5" y="10.5" width="8" height="8" fill="none" stroke="currentColor" stroke-width="${TITLEBAR_ICON_STROKE}"/></svg>`,
  close: `<svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true"><path d="M7 7l10 10M17 7L7 17" fill="none" stroke="currentColor" stroke-width="${TITLEBAR_ICON_STROKE}" stroke-linecap="round"/></svg>`
};

function setMaximizeButtonState(btn, maxed) {
  if (!btn) return;
  btn.classList.add('titlebar-btn-win');
  btn.innerHTML = maxed ? WIN_CTRL_SVG.restore : WIN_CTRL_SVG.max;
  btn.classList.toggle('is-restored', !!maxed);
  const title = maxed ? uiText('restore', '向下还原') : uiText('maximize', '最大化');
  btn.setAttribute('title', title);
  btn.setAttribute('aria-label', title);
}

function paintWinControlButton(btn) {
  if (!btn) return;
  const kind = btn.getAttribute('data-win-control');
  if (!kind) return;
  btn.classList.add('titlebar-btn-win');
  if (kind === 'min') btn.innerHTML = WIN_CTRL_SVG.min;
  else if (kind === 'max') btn.innerHTML = WIN_CTRL_SVG.max;
  else if (kind === 'close') btn.innerHTML = WIN_CTRL_SVG.close;
}

function initWinControlIcons(root) {
  const scope = root && root.querySelectorAll ? root : document;
  scope.querySelectorAll('[data-win-control]').forEach(paintWinControlButton);
}

async function syncMainWindowMaxButton() {
  if (!windowApi.windowIsMaximized) return;
  const winMax = $('win-max');
  if (!winMax) return;
  try {
    const maxed = await windowApi.windowIsMaximized();
    setMaximizeButtonState(winMax, maxed);
  } catch {
    // ignore
  }
}

function bindWindowControls({ minId, maxId, closeId, onClose }) {
  if (!windowApi.windowMinimize) return;
  const winMin = $(minId);
  const winMax = $(maxId);
  const winClose = $(closeId);
  if (!winMin || !winMax || !winClose) return;

  winMin.addEventListener('click', () => windowApi.windowMinimize());
  winMax.addEventListener('click', () => windowApi.windowToggleMaximize());
  winClose.addEventListener('click', () => {
    if (typeof onClose === 'function') onClose();
    else windowApi.windowHide();
  });
}

/** 设置/技能等弹窗：最大化铺满遮罩，最小化仍收起整个应用窗口 */
function bindDialogControls({ overlayId, minId, maxId, closeId, onClose }) {
  const overlay = $(overlayId);
  const winMin = $(minId);
  const winMax = $(maxId);
  const winClose = $(closeId);
  if (!overlay || !winMax || !winClose) return;

  if (winMin && windowApi.windowMinimize) {
    winMin.addEventListener('click', () => windowApi.windowMinimize());
  }
  winMax.addEventListener('click', () => {
    const maxed = overlay.classList.toggle('dialog-maximized');
    setMaximizeButtonState(winMax, maxed);
  });
  winClose.addEventListener('click', () => {
    if (typeof onClose === 'function') onClose();
  });
}

async function updateTitlebarVersion() {
  const el = $('titlebar-title');
  if (!el) return;
  let version = '';
  if (windowApi.getVersion) {
    try {
      version = String(await windowApi.getVersion() || '').trim();
    } catch {
      // ignore
    }
  }
  if (version) {
    el.textContent = `叠云 Agent V${version}`;
    document.title = `叠云 Agent V${version}`;
  } else {
    el.textContent = '叠云 Agent';
  }
}

function setupTitlebar() {
  initWinControlIcons(document);
  const drag = $('titlebar-drag');
  bindWindowControls({ minId: 'win-min', maxId: 'win-max', closeId: 'win-close' });
  bindDialogControls({
    overlayId: 'settings-overlay',
    minId: 'settings-min',
    maxId: 'settings-max',
    closeId: 'settings-close',
    onClose: () => closeSettingsModal()
  });
  bindDialogControls({
    overlayId: 'execute-overlay',
    minId: 'execute-min',
    maxId: 'execute-max',
    closeId: 'execute-close',
    onClose: () => closeExecuteModal()
  });
  bindDialogControls({
    overlayId: 'help-overlay',
    minId: 'help-min',
    maxId: 'help-max',
    closeId: 'help-close',
    onClose: () => closeHelpModal()
  });
  bindDialogControls({
    overlayId: 'automation-editor-overlay',
    minId: 'automation-editor-min',
    maxId: 'automation-editor-max',
    closeId: 'automation-editor-close',
    onClose: () => closeAutomationEditor()
  });
  if (drag && windowApi.windowToggleMaximize) {
    drag.addEventListener('dblclick', () => windowApi.windowToggleMaximize());
  }
  if (windowApi.onWindowMaxState) {
    windowApi.onWindowMaxState(() => syncMainWindowMaxButton());
  }
  syncMainWindowMaxButton();
  updateTitlebarVersion().catch(() => {});
}
setupTitlebar();

function formatStatNumber(n) {
  const v = Number(n) || 0;
  try {
    return v.toLocaleString('zh-CN');
  } catch {
    return String(v);
  }
}

function formatStatPercent(numerator, denominator) {
  const n = Number(numerator) || 0;
  const d = Number(denominator) || 0;
  if (d <= 0 || n <= 0) return '0%';
  return `${Math.max(0, Math.min(100, (n / d) * 100)).toFixed(1)}%`;
}

function normalizeModelUsageEntries(map) {
  if (!map || typeof map !== 'object') return [];
  return Object.entries(map)
    .map(([model, tokens]) => ({
      model: String(model || '未知模型'),
      tokens: Math.max(0, Math.floor(Number(tokens) || 0))
    }))
    .filter((item) => item.tokens > 0)
    .sort((a, b) => b.tokens - a.tokens);
}

/** 文本未变化时不写 DOM（状态每秒推送，避免无谓重排） */
function setTextIfChanged(el, value) {
  if (!el) return;
  const next = String(value);
  if (el.textContent !== next) el.textContent = next;
}

/**
 * 图表 HTML 一致时不重写 innerHTML。
 * 上一版 HTML 记在元素自身，而不是按 id 缓存：元素被重建/替换后仍会重绘，
 * 不会出现「缓存命中但真实节点是空的」这类跨面板问题。
 */
function setModelUsageChartHtml(container, html) {
  if (container.__modelUsageHtml === html) return;
  container.__modelUsageHtml = html;
  container.innerHTML = html;
}

function renderModelUsageChart(containerId, totalId, usageMap) {
  const container = $(containerId);
  const totalEl = $(totalId);
  if (!container) return;
  const entries = normalizeModelUsageEntries(usageMap);
  const total = entries.reduce((sum, item) => sum + item.tokens, 0);
  if (totalEl) totalEl.textContent = `${formatStatNumber(total)} Token`;
  if (!entries.length) {
    setModelUsageChartHtml(
      container,
      `<p class="model-usage-empty">${escapeHtml(uiText('no_model_usage', '暂无模型调用'))}</p>`
    );
    return;
  }
  const max = Math.max(...entries.map((item) => item.tokens), 1);
  setModelUsageChartHtml(
    container,
    entries
      .map((item) => {
        const pct = Math.max(3, Math.min(100, (item.tokens / max) * 100));
        const safeName = escapeHtml(item.model);
        return (
          `<div class="model-usage-row" title="${safeName} · ${formatStatNumber(item.tokens)} Token">` +
          `<span class="model-usage-name">${safeName}</span>` +
          `<span class="model-usage-track"><span class="model-usage-fill" style="width:${pct.toFixed(1)}%"></span></span>` +
          `<span class="model-usage-value">${formatStatNumber(item.tokens)}</span>` +
          `</div>`
        );
      })
      .join('')
  );
}

function initStatusPanel() {
  const toggle = $('status-summary-toggle');
  const panel = $('status-panel');
  const root = $('sidebar-status');
  if (!toggle || !panel || !root) return;
  toggle.addEventListener('click', () => {
    const open = root.classList.toggle('expanded');
    panel.hidden = !open;
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
  });
}

// ---------- 主进程 → 渲染端的监控状态 ----------
let lastStatusPayload = null;
/**
 * 逐元素判断是否需要写入，而不是用「整体签名」提前 return：
 * 面板被重建/换标签页后，整体签名不变会跳过重绘导致该面板空白；
 * 逐元素比较天然免疫这一点，同时仍有「值没变就不碰 DOM」的收益。
 */
function renderStatusPayload(s) {
  if (!s) return;
  if (typeof updateHelpStatsGatewayStatus === 'function') updateHelpStatsGatewayStatus();
  setTextIfChanged($('meta-id-compact'), s.computerId || '-');
  setTextIfChanged($('meta-keys-today'), formatStatNumber(s.keystrokesToday));
  setTextIfChanged($('meta-clicks'), formatStatNumber(s.mouseClicksToday ?? s.mouseClicks));
  setTextIfChanged($('meta-tokens-today'), formatStatNumber(s.tokensToday));
  setTextIfChanged($('meta-prompt-tokens-today'), formatStatNumber(s.promptTokensToday));
  setTextIfChanged($('meta-completion-tokens-today'), formatStatNumber(s.completionTokensToday));
  setTextIfChanged($('meta-cached-tokens-today'), formatStatNumber(s.cachedTokensToday));
  setTextIfChanged(
    $('meta-cache-hit-rate-today'),
    formatStatPercent(s.cachedTokensToday, s.cacheHitPromptTokensToday || s.promptTokensToday)
  );
  setTextIfChanged(
    $('meta-cache-hit-rate-month'),
    formatStatPercent(s.cachedTokensMonth, s.cacheHitPromptTokensMonth || s.promptTokensMonth)
  );
  renderModelUsageChart('model-usage-today', 'model-usage-today-total', s.modelUsageToday);
  renderModelUsageChart('model-usage-month', 'model-usage-month-total', s.modelUsageMonth);
  if (s.version) setTextIfChanged($('meta-version'), `v${s.version}`);
}

if (windowApi.onStatus) {
  windowApi.onStatus((s) => {
    lastStatusPayload = s;
    renderStatusPayload(s);
  });
}
window.addEventListener('dieyun:language-change', () => {
  // 图表空态文案来自 uiText，会随语言变化，逐元素比较即可发现并重绘
  renderStatusPayload(lastStatusPayload);
  if (typeof updateHelpStatsGatewayStatus === 'function') updateHelpStatsGatewayStatus();
  syncMainWindowMaxButton();
});
initStatusPanel();
