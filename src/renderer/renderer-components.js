/* global window, document, $, escapeHtml, openSettingsShell, switchSettingsPage, uiText, showAgentToast */
'use strict';

const componentsApi = window.diecloud || {};
let componentsPollTimer = null;
let progressUnsub = null;

const SOURCE_LABELS = {
  bundled: '安装包',
  downloaded: '本机缓存',
  'lite-pack': 'Lite 包',
  dev: '开发目录',
  local: '本地',
  missing: '未安装'
};

const OPTIONAL_IDS = new Set(['bge-base-zh-v1.5', 'monaco-editor', 'remote-gateway-linux-node']);

function healthText(c) {
  if (c.inflight) return { text: '下载中', tone: 'pending' };
  if (c.ready) return { text: '就绪', tone: 'ok' };
  return { text: '未就绪', tone: 'err' };
}

function runText(c) {
  if (c.inUse) return { text: '使用中', tone: 'active' };
  if (c.id === 'bge-base-zh-v1.5' && c.configured) return { text: '已启用', tone: 'idle' };
  return { text: '空闲', tone: 'idle' };
}

function setComponentsHint(text, ok) {
  const el = $('components-hint');
  if (!el) return;
  el.textContent = text || '';
  el.classList.toggle('ok', ok === true);
  el.classList.toggle('warn', ok === false);
}

function renderStatusTag(text, tone) {
  return `<span class="components-tag components-tag-${tone || 'idle'}">${escapeHtml(text)}</span>`;
}

function buildActions(c) {
  const actions = document.createElement('div');
  actions.className = 'components-col-actions';

  if (!OPTIONAL_IDS.has(c.id)) {
    return actions;
  }

  const dlBtn = document.createElement('button');
  dlBtn.type = 'button';
  dlBtn.className = 'ghost-btn components-btn';
  if (c.inflight) {
    dlBtn.textContent = '下载中…';
    dlBtn.disabled = true;
  } else if (c.ready) {
    dlBtn.textContent = '重新下载';
  } else {
    dlBtn.textContent = '下载';
  }
  dlBtn.addEventListener('click', () => downloadComponent(c.id, c.ready === true, dlBtn));
  actions.appendChild(dlBtn);

  const manualBtn = document.createElement('button');
  manualBtn.type = 'button';
  manualBtn.className = 'ghost-btn components-btn';
  manualBtn.textContent = '手动安装';
  manualBtn.disabled = !!c.inflight;
  manualBtn.addEventListener('click', () => manualInstallComponent(c.id, manualBtn));
  actions.appendChild(manualBtn);

  return actions;
}

function renderComponentsList(data) {
  const list = $('components-list');
  if (!list) return;
  const rows = (data && data.components) || [];
  if (!rows.length) {
    list.innerHTML = '<div class="components-empty">暂无组件信息</div>';
    return;
  }

  list.innerHTML = '';
  list.className = 'components-table';

  const head = document.createElement('div');
  head.className = 'components-table-head';
  head.innerHTML =
    '<span>组件</span><span>健康</span><span>安装</span><span>来源</span><span>运行</span><span>操作</span>';
  list.appendChild(head);

  for (const c of rows) {
    const health = healthText(c);
    const run = runText(c);
    const row = document.createElement('div');
    row.className = 'components-table-row';
    row.dataset.componentId = c.id;

    const nameCol = document.createElement('div');
    nameCol.className = 'components-col-name';
    nameCol.innerHTML = `<span class="components-title">${escapeHtml(c.label)}</span>`;

    row.innerHTML = `
      <span></span>
      <span>${renderStatusTag(health.text, health.tone)}</span>
      <span>${renderStatusTag(c.ready ? '已完成' : '未完成', c.ready ? 'ok' : 'err')}</span>
      <span class="components-source">${escapeHtml(SOURCE_LABELS[c.source] || c.source || '—')}</span>
      <span>${renderStatusTag(run.text, run.tone)}</span>
      <span></span>
    `;
    row.children[0].replaceWith(nameCol);
    row.children[5].replaceWith(buildActions(c));
    list.appendChild(row);
  }
}

async function refreshComponentsPage() {
  if (!componentsApi.getComponentsStatus) {
    renderComponentsList({ components: [] });
    setComponentsHint('组件状态接口不可用', false);
    return;
  }
  try {
    const data = await componentsApi.getComponentsStatus();
    const inflight = data.inflight || {};
    for (const c of data.components || []) {
      c.inflight = !!inflight[c.id];
    }
    renderComponentsList(data);
    setComponentsHint('');
  } catch (e) {
    setComponentsHint(e.message || String(e), false);
  }
}

async function downloadComponent(assetId, force, btn) {
  if (!componentsApi.ensureOptionalAsset) return;
  if (btn) btn.disabled = true;
  setComponentsHint(force ? `正在重新下载 ${assetId}…` : `正在下载 ${assetId}…`);
  try {
    const r = await componentsApi.ensureOptionalAsset(assetId, { force: !!force });
    if (r && r.ok) {
      setComponentsHint('下载完成', true);
      if (typeof showAgentToast === 'function') {
        showAgentToast('组件', '下载完成', { variant: 'success' });
      }
    } else {
      throw new Error((r && r.error) || '下载失败');
    }
  } catch (e) {
    setComponentsHint(e.message || String(e), false);
    if (typeof showAgentToast === 'function') {
      showAgentToast('组件', e.message || String(e), { variant: 'warn' });
    }
  } finally {
    await refreshComponentsPage();
  }
}

async function manualInstallComponent(assetId, btn) {
  if (!componentsApi.installOptionalAssetFromFile) return;
  if (btn) btn.disabled = true;
  try {
    const r = await componentsApi.installOptionalAssetFromFile(assetId);
    if (r && r.cancelled) {
      setComponentsHint('已取消');
      return;
    }
    if (r && r.ok) {
      setComponentsHint('手动安装完成', true);
      if (typeof showAgentToast === 'function') {
        showAgentToast('组件', '手动安装完成', { variant: 'success' });
      }
    } else {
      throw new Error((r && r.error) || '安装失败');
    }
  } catch (e) {
    setComponentsHint(e.message || String(e), false);
  } finally {
    if (btn) btn.disabled = false;
    await refreshComponentsPage();
  }
}

function ensureComponentsProgressWatch() {
  if (progressUnsub || !componentsApi.onOptionalAssetProgress) return;
  progressUnsub = componentsApi.onOptionalAssetProgress((payload) => {
    if (!payload || !payload.assetId) return;
    if (!isComponentsSettingsPageOpen()) return;
    const pct = Number(payload.percent);
    if (Number.isFinite(pct) && pct > 0) {
      setComponentsHint(`${payload.message || payload.assetId} (${pct}%)`);
    } else if (payload.message) {
      setComponentsHint(payload.message);
    }
    void refreshComponentsPage();
  });
}

function beginComponentsPoll() {
  endComponentsPoll();
  componentsPollTimer = setInterval(() => {
    if (!isComponentsSettingsPageOpen()) {
      endComponentsPoll();
      return;
    }
    void refreshComponentsPage();
  }, 3000);
}

function endComponentsPoll() {
  if (componentsPollTimer) {
    clearInterval(componentsPollTimer);
    componentsPollTimer = null;
  }
}

function isComponentsSettingsPageOpen() {
  const overlay = $('settings-overlay');
  if (!overlay || overlay.hidden) return false;
  return !!document.querySelector('.settings-page.active[data-settings="components"]');
}

function openSettingsComponentsPage() {
  if (!openSettingsShell()) return;
  switchSettingsPage('components', uiText('settings_components', '组件'), (el) => el.dataset.settingsAction === 'components');
  ensureComponentsProgressWatch();
  beginComponentsPoll();
  void refreshComponentsPage();
}

function initComponentsSettingsPage() {
  const refreshBtn = $('components-refresh-btn');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', () => {
      void refreshComponentsPage();
    });
  }
}

window.openSettingsComponentsPage = openSettingsComponentsPage;
window.isSettingsComponentsPageOpen = isSettingsComponentsPageOpen;
window.refreshComponentsPage = refreshComponentsPage;
window.initComponentsSettingsPage = initComponentsSettingsPage;

initComponentsSettingsPage();
