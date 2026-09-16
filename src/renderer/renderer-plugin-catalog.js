'use strict';

/* global window, document, $, escapeHtml, gwState, gatewayCall, showPluginListView, installPluginRpc, formatPluginInstallHint, loadPluginsUI */

function entryCanInstall(ent) {
  if (!ent) return false;
  if (ent.canInstall != null) return !!ent.canInstall;
  return !!ent.hasPackage;
}

function catalogActionLabel(state, canInstall) {
  if (state === 'installed') return '已安装';
  if (state === 'upgrade') return '更新';
  if (canInstall) return '添加';
  return '不可用';
}

function showPluginCatalogView() {
  document.querySelectorAll('.plugin-settings-view').forEach((el) => {
    el.classList.toggle('active', el.dataset.pluginView === 'catalog');
  });
}

async function loadPluginCatalogUI({ refresh = false } = {}) {
  const listEl = $('plugin-catalog-list');
  const hint = $('plugin-catalog-hint');
  if (!listEl) return;
  if (!gwState.authed) {
    listEl.innerHTML = '<p class="skills-empty">Gateway 未连接</p>';
    return;
  }
  listEl.innerHTML = '<p class="skills-empty">加载目录…</p>';
  try {
    const entries = await gatewayCall('plugins.catalog.list', { refresh });
    if (!entries.length) {
      listEl.innerHTML = '<p class="skills-empty">目录为空</p>';
      return;
    }
    listEl.innerHTML = entries
      .map((ent) => {
        const canInstall = entryCanInstall(ent);
        const action = catalogActionLabel(ent.installState, canInstall);
        const installed = ent.installState === 'installed';
        const disabled =
          installed || (!canInstall && ent.installState !== 'upgrade' && ent.installState !== 'downgrade');
        const actionClass = disabled
          ? 'catalog-tile-action catalog-tile-action-disabled'
          : 'catalog-tile-action primary-btn';
        const installedNote =
          ent.installedVersion && ent.installState !== 'available'
            ? `已装 v${escapeHtml(ent.installedVersion)}`
            : escapeHtml(ent.source || 'catalog');
        return `<article class="skill-tile plugin-tile plugin-catalog-tile${installed ? ' enabled' : ''}">
          <div class="skill-tile-head">
            <div class="skill-tile-title">${escapeHtml(ent.name || ent.id)}</div>
            <span class="skill-tile-tag">v${escapeHtml(ent.version || '1.0.0')}</span>
          </div>
          <p class="skill-tile-desc">${escapeHtml(ent.description || '暂无简介')}</p>
          <p class="skill-tile-hint">${escapeHtml(ent.category || 'general')} · ${installedNote}</p>
          <div class="skill-tile-foot plugin-catalog-foot">
            <span class="plugin-catalog-state">${installed ? '已安装' : canInstall ? '市场' : ''}</span>
            <button
              type="button"
              class="${actionClass}"
              data-catalog-install="${escapeHtml(ent.id)}"
              ${disabled ? 'disabled' : ''}
              title="${installed ? '已在本地安装' : canInstall ? '安装到本地插件目录' : '暂无安装包'}"
            >${action}</button>
          </div>
        </article>`;
      })
      .join('');
    if (hint && refresh) hint.textContent = '目录已刷新';
  } catch (err) {
    listEl.innerHTML = `<p class="skills-empty">加载失败：${escapeHtml(err.message || err)}</p>`;
  }
}

async function saveCatalogSourcesFromUI() {
  const input = $('plugin-catalog-source-url');
  const hint = $('plugin-catalog-hint');
  if (!input || !gwState.authed) return;
  const raw = String(input.value || '')
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean);
  try {
    await gatewayCall('plugins.catalog.sources.set', { urls: raw });
    if (hint) hint.textContent = raw.length ? `已保存 ${raw.length} 个目录源` : '已清除扩展目录源';
    await loadPluginCatalogUI({ refresh: true });
  } catch (err) {
    if (hint) hint.textContent = `保存失败：${err.message || err}`;
  }
}

async function loadCatalogSourcesUI() {
  const input = $('plugin-catalog-source-url');
  if (!input || !gwState.authed) return;
  try {
    const { urls } = await gatewayCall('plugins.catalog.sources.get', {});
    input.value = Array.isArray(urls) && urls.length ? urls.join('\n') : '';
  } catch {
    input.value = '';
  }
}

function initPluginCatalogUI() {
  const openBtn = $('plugin-catalog-open-btn');
  if (openBtn) {
    openBtn.addEventListener('click', () => {
      showPluginCatalogView();
      loadCatalogSourcesUI().catch(() => {});
      loadPluginCatalogUI().catch(() => {});
    });
  }

  const backBtn = $('plugin-catalog-back');
  if (backBtn) {
    backBtn.addEventListener('click', () => {
      showPluginListView();
      loadPluginsUI().catch(() => {});
    });
  }

  const refreshBtn = $('plugin-catalog-refresh');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', () => loadPluginCatalogUI({ refresh: true }));
  }

  const saveSourcesBtn = $('plugin-catalog-sources-save');
  if (saveSourcesBtn) {
    saveSourcesBtn.addEventListener('click', () => saveCatalogSourcesFromUI());
  }

  document.addEventListener('click', async (e) => {
    const btn = e.target && e.target.closest ? e.target.closest('[data-catalog-install]') : null;
    if (!btn || btn.disabled) return;
    e.preventDefault();
    e.stopPropagation();
    const id = btn.dataset.catalogInstall;
    const hint = $('plugin-catalog-hint');
    if (!id || !gwState.authed) return;
    btn.disabled = true;
    if (hint) hint.textContent = '安装中…';
    try {
      const result = await installPluginRpc('plugins.catalog.install', { id });
      if (hint) hint.textContent = formatPluginInstallHint(result);
      await loadPluginCatalogUI();
      await loadPluginsUI();
    } catch (err) {
      if (hint) hint.textContent = `失败：${err.message || err}`;
      btn.disabled = false;
    }
  });
}

window.showPluginCatalogView = showPluginCatalogView;
window.loadPluginCatalogUI = loadPluginCatalogUI;
window.initPluginCatalogUI = initPluginCatalogUI;
