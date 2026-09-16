'use strict';

/* global window, document, $, escapeHtml, showMcpListView, renderMcpList, SKILLS_GRID_PAGE_SIZE */

const mcpCatalogApi = window.diecloud || {};
const MCP_CATALOG_PAGE_SIZE =
  typeof window.SKILLS_GRID_PAGE_SIZE === 'number' ? window.SKILLS_GRID_PAGE_SIZE : 15;

let mcpCatalogEntries = [];
let mcpCatalogSearchQuery = '';
let mcpCatalogPageIndex = 0;
let mcpCatalogFilter = 'addable';
let mcpCatalogHasMore = false;
let mcpCatalogLoading = false;
let mcpCatalogLoadedCount = 0;
let mcpCatalogSearchRemote = false;

function parseMcpCatalogListResult(result) {
  if (Array.isArray(result)) {
    return { entries: result, hasMore: false, loadedCount: result.length, searchRemote: false };
  }
  return {
    entries: Array.isArray(result?.entries) ? result.entries : [],
    hasMore: !!result?.hasMore,
    loadedCount: Number(result?.loadedCount) || (Array.isArray(result?.entries) ? result.entries.length : 0),
    searchRemote: !!result?.searchRemote
  };
}

function applyMcpCatalogListResult(result) {
  const parsed = parseMcpCatalogListResult(result);
  mcpCatalogEntries = parsed.entries;
  mcpCatalogHasMore = parsed.hasMore;
  mcpCatalogLoadedCount = parsed.loadedCount;
  mcpCatalogSearchRemote = parsed.searchRemote;
  return parsed;
}

function entryCanAdd(ent) {
  if (!ent) return false;
  if (ent.canAdd != null) return !!ent.canAdd;
  return !!(ent.hasPackage || ent.hasRemote || ent.remoteUrl || ent.installSpec);
}

function showMcpListView() {
  document.querySelectorAll('.mcp-settings-view').forEach((el) => {
    el.classList.toggle('active', el.dataset.mcpView === 'list');
  });
}

function mcpCatalogActionLabel(state, canAdd) {
  if (state === 'installed') return '已安装';
  if (state === 'upgrade') return '更新';
  if (canAdd) return '添加';
  return '不可用';
}

function showMcpCatalogView() {
  document.querySelectorAll('.mcp-settings-view').forEach((el) => {
    el.classList.toggle('active', el.dataset.mcpView === 'catalog');
  });
}

function getFilteredMcpCatalogEntries() {
  const q = mcpCatalogSearchQuery.trim().toLowerCase();
  let list = mcpCatalogEntries.slice();
  if (mcpCatalogFilter === 'addable') {
    list = list.filter((ent) => entryCanAdd(ent));
  } else if (mcpCatalogFilter === 'remote') {
    list = list.filter((ent) => ent.hasRemote || ent.transport === 'remote' || ent.remoteUrl);
  } else if (mcpCatalogFilter === 'local') {
    list = list.filter((ent) => ent.hasPackage || ent.installSpec);
  }
  if (q && !mcpCatalogSearchRemote) {
    list = list.filter((ent) => {
      const hay = [ent.id, ent.name, ent.description, ent.category, ent.registryName, ent.envHint]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return hay.includes(q);
    });
  }
  return list;
}

function renderMcpCatalogFilterTabs() {
  const nav = $('mcp-catalog-filter-tabs');
  if (!nav) return;
  const tabs = [
    { id: 'addable', label: '可添加' },
    { id: 'remote', label: '远程' },
    { id: 'local', label: '本地 npm' },
    { id: 'all', label: '全部' }
  ];
  nav.innerHTML = tabs
    .map(
      (tab) =>
        `<button type="button" class="skills-category-tab${mcpCatalogFilter === tab.id ? ' active' : ''}" data-mcp-catalog-filter="${tab.id}">${tab.label}</button>`
    )
    .join('');
}

function renderMcpCatalogGrid() {
  const listEl = $('mcp-catalog-list');
  const info = $('mcp-catalog-page-info');
  const prev = $('mcp-catalog-page-prev');
  const next = $('mcp-catalog-page-next');
  const bar = $('mcp-catalog-pagination');
  if (!listEl) return;

  const visible = getFilteredMcpCatalogEntries();
  if (!visible.length) {
    const q = mcpCatalogSearchQuery.trim();
    const emptyMsg = q
      ? mcpCatalogSearchRemote
        ? '官方市场未找到匹配项，可换关键词或切换「全部」筛选'
        : '没有匹配的 MCP，可换关键词或切换筛选'
      : '没有匹配的 MCP';
    listEl.innerHTML = `<p class="skills-empty">${emptyMsg}</p>`;
    if (bar) bar.hidden = true;
    return;
  }

  const pageCount = Math.max(1, Math.ceil(visible.length / MCP_CATALOG_PAGE_SIZE));
  if (mcpCatalogPageIndex >= pageCount) mcpCatalogPageIndex = pageCount - 1;
  if (mcpCatalogPageIndex < 0) mcpCatalogPageIndex = 0;
  const slice = visible.slice(
    mcpCatalogPageIndex * MCP_CATALOG_PAGE_SIZE,
    mcpCatalogPageIndex * MCP_CATALOG_PAGE_SIZE + MCP_CATALOG_PAGE_SIZE
  );

  listEl.innerHTML = slice
    .map((ent) => {
      const canAdd = entryCanAdd(ent);
      const action = mcpCatalogActionLabel(ent.installState, canAdd);
      const disabled = ent.installState === 'installed' || (!canAdd && ent.installState !== 'upgrade');
      const installed = ent.installState === 'installed';
      const installedNote =
        ent.installedVersion && ent.installState !== 'available'
          ? `已装 v${escapeHtml(ent.installedVersion)}`
          : escapeHtml(ent.category || 'catalog');
      const envNote = ent.envHint ? ` · 需 ${escapeHtml(ent.envHint)}` : '';
      const remoteNote = (ent.hasRemote || ent.remoteUrl) && !ent.hasPackage ? ' · 添加后需配置' : '';
      const actionClass = disabled
        ? 'catalog-tile-action catalog-tile-action-disabled'
        : canAdd
          ? 'catalog-tile-action primary-btn'
          : 'catalog-tile-action ghost-btn';
      return `<article class="skill-tile mcp-tile mcp-catalog-tile${installed ? ' enabled' : ''}">
          <div class="skill-tile-head">
            <div class="skill-tile-title">${escapeHtml(ent.name || ent.id)}</div>
            <span class="skill-tile-tag">v${escapeHtml(ent.version || '1.0.0')}</span>
          </div>
          <p class="skill-tile-desc">${escapeHtml(ent.description || '暂无简介')}</p>
          <p class="skill-tile-hint">${installedNote}${envNote}${remoteNote}</p>
          <div class="skill-tile-foot plugin-catalog-foot">
            <span class="plugin-catalog-state">${installed ? '已安装' : ent.hasRemote || ent.remoteUrl ? '远程' : ent.hasPackage ? '本地' : ''}</span>
            <button
              type="button"
              class="${actionClass}"
              data-mcp-catalog-install="${escapeHtml(ent.id)}"
              ${disabled ? 'disabled' : ''}
              title="${canAdd ? '添加到 MCP 列表' : '当前不支持添加（需 npm stdio 或远程 HTTP/SSE）'}"
            >${action}</button>
          </div>
        </article>`;
    })
    .join('');

  if (bar) {
    const atLastPage = mcpCatalogPageIndex >= pageCount - 1;
    const canLoadMore = atLastPage && mcpCatalogHasMore;
    if (pageCount <= 1 && !canLoadMore) {
      bar.hidden = true;
    } else {
      bar.hidden = false;
      const moreHint = mcpCatalogHasMore ? ' · 可继续加载' : '';
      const searchHint = mcpCatalogSearchRemote ? ' · 官方市场搜索' : '';
      const loadedHint =
        mcpCatalogLoadedCount > visible.length
          ? ` · 已加载 ${mcpCatalogLoadedCount} 条`
          : '';
      if (info) {
        info.textContent = mcpCatalogLoading
          ? '加载中…'
          : `${mcpCatalogPageIndex + 1} / ${pageCount}（当前 ${visible.length} 项${loadedHint}${searchHint}${moreHint}）`;
      }
      if (prev) prev.disabled = mcpCatalogPageIndex <= 0 || mcpCatalogLoading;
      if (next) next.disabled = mcpCatalogLoading || (atLastPage && !mcpCatalogHasMore);
    }
  }
}

async function fetchMcpCatalogFromApi({ refresh = false, loadMore = false, search = '' } = {}) {
  const q = String(search || '').trim();
  const result = await mcpCatalogApi.mcpCatalogList({
    refresh,
    loadMore,
    search: q
  });
  return applyMcpCatalogListResult(result);
}

async function loadMcpCatalogUI({ refresh = false, loadMore = false, silent = false, search } = {}) {
  const listEl = $('mcp-catalog-list');
  const hint = $('mcp-catalog-hint');
  if (!listEl || mcpCatalogLoading) return;
  if (!mcpCatalogApi.mcpCatalogList) {
    listEl.innerHTML = '<p class="skills-empty">当前版本未提供 MCP 市场</p>';
    return;
  }
  const searchQuery = search != null ? String(search).trim() : mcpCatalogSearchQuery.trim();
  mcpCatalogLoading = true;
  renderMcpCatalogGrid();
  if (!silent && !loadMore) {
    listEl.innerHTML = `<p class="skills-empty">${searchQuery ? '正在搜索官方市场…' : '加载目录…'}</p>`;
  } else if (loadMore && hint) {
    hint.textContent = searchQuery ? '搜索加载更多…' : '加载更多…';
  }
  try {
    await fetchMcpCatalogFromApi({ refresh, loadMore, search: searchQuery });
    if (!loadMore) mcpCatalogPageIndex = 0;

    const isBrowse = !searchQuery;
    if (!mcpCatalogEntries.length && mcpCatalogHasMore && !loadMore) {
      await fetchMcpCatalogFromApi({ loadMore: true, search: searchQuery });
    }

    if (isBrowse && !loadMore && !refresh) {
      let attempts = 0;
      while (attempts < 6) {
        const visible = getFilteredMcpCatalogEntries();
        if (visible.length >= MCP_CATALOG_PAGE_SIZE || !mcpCatalogHasMore) break;
        await fetchMcpCatalogFromApi({ loadMore: true, search: '' });
        attempts += 1;
      }
    }

    if (!mcpCatalogEntries.length) {
      listEl.innerHTML = `<p class="skills-empty">${searchQuery ? '没有匹配的 MCP' : '目录为空'}</p>`;
      renderMcpCatalogFilterTabs();
      return;
    }
    renderMcpCatalogFilterTabs();
    if (hint) {
      if (refresh) hint.textContent = '目录已刷新';
      else if (loadMore) hint.textContent = mcpCatalogHasMore ? '已加载更多' : '已全部加载';
      else if (searchQuery && mcpCatalogSearchRemote) {
        hint.textContent = '已在官方 Registry 搜索（按服务器名称匹配）';
      } else if (searchQuery) {
        hint.textContent = '已在已加载目录中搜索';
      } else if (!silent) hint.textContent = mcpCatalogHasMore ? '已加载首屏，翻页可继续加载' : '';
    }
  } catch (err) {
    listEl.innerHTML = `<p class="skills-empty">加载失败：${escapeHtml(err.message || err)}</p>`;
  } finally {
    mcpCatalogLoading = false;
    if (mcpCatalogEntries.length) {
      renderMcpCatalogGrid();
    }
  }
}

async function saveMcpCatalogSourcesFromUI() {
  const input = $('mcp-catalog-source-url');
  const hint = $('mcp-catalog-hint');
  if (!input || !mcpCatalogApi.mcpCatalogSourcesSet) return;
  const raw = String(input.value || '')
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean);
  try {
    await mcpCatalogApi.mcpCatalogSourcesSet({ urls: raw });
    if (hint) hint.textContent = raw.length ? `已保存 ${raw.length} 个目录源` : '已恢复默认官方源';
    await loadMcpCatalogUI({ refresh: true });
  } catch (err) {
    if (hint) hint.textContent = `保存失败：${err.message || err}`;
  }
}

async function loadMcpCatalogSourcesUI() {
  const input = $('mcp-catalog-source-url');
  if (!input || !mcpCatalogApi.mcpCatalogSourcesGet) return;
  try {
    const { urls, defaultUrl } = await mcpCatalogApi.mcpCatalogSourcesGet();
    const list = Array.isArray(urls) && urls.length ? urls : defaultUrl ? [defaultUrl] : [];
    input.value = list.join('\n');
  } catch {
    input.value = 'https://registry.modelcontextprotocol.io/v0.1/servers';
  }
}

function formatMcpCatalogInstallHint(result) {
  if (!result) return '已添加';
  if (result.action === 'restore') return '已恢复预装 MCP';
  if (result.action === 'upgrade') return '已更新 MCP 配置';
  return '已添加到 MCP 列表，请完成配置后启用';
}

function initMcpCatalogUI() {
  const openBtn = $('mcp-catalog-open-btn');
  if (openBtn) {
    openBtn.addEventListener('click', () => {
      showMcpCatalogView();
      loadMcpCatalogSourcesUI().catch(() => {});
      loadMcpCatalogUI().catch(() => {});
    });
  }

  const backBtn = $('mcp-catalog-back');
  if (backBtn) {
    backBtn.addEventListener('click', () => {
      showMcpListView();
      renderMcpList().catch(() => {});
    });
  }

  const refreshBtn = $('mcp-catalog-refresh');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', () => loadMcpCatalogUI({ refresh: true }));
  }

  const saveSourcesBtn = $('mcp-catalog-sources-save');
  if (saveSourcesBtn) {
    saveSourcesBtn.addEventListener('click', () => saveMcpCatalogSourcesFromUI());
  }

  const searchInput = $('mcp-catalog-search');
  if (searchInput) {
    let debounce;
    searchInput.addEventListener('input', () => {
      mcpCatalogSearchQuery = searchInput.value || '';
      mcpCatalogPageIndex = 0;
      clearTimeout(debounce);
      debounce = setTimeout(() => {
        const q = mcpCatalogSearchQuery.trim();
        if (q) {
          loadMcpCatalogUI({ refresh: true, search: q }).catch(() => {});
        } else {
          loadMcpCatalogUI({ refresh: false }).catch(() => {});
        }
      }, 350);
    });
    searchInput.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      searchInput.value = '';
      mcpCatalogSearchQuery = '';
      mcpCatalogPageIndex = 0;
      loadMcpCatalogUI({ refresh: false }).catch(() => {});
    });
  }

  document.addEventListener('click', (e) => {
    const filterBtn =
      e.target && e.target.closest ? e.target.closest('[data-mcp-catalog-filter]') : null;
    if (filterBtn) {
      mcpCatalogFilter = filterBtn.dataset.mcpCatalogFilter || 'addable';
      mcpCatalogPageIndex = 0;
      renderMcpCatalogFilterTabs();
      renderMcpCatalogGrid();
      return;
    }
  });

  const prev = $('mcp-catalog-page-prev');
  const next = $('mcp-catalog-page-next');
  if (prev) {
    prev.addEventListener('click', () => {
      if (mcpCatalogPageIndex > 0) {
        mcpCatalogPageIndex -= 1;
        renderMcpCatalogGrid();
      }
    });
  }
  if (next) {
    next.addEventListener('click', async () => {
      if (mcpCatalogLoading) return;
      const visible = getFilteredMcpCatalogEntries();
      const pageCount = Math.max(1, Math.ceil(visible.length / MCP_CATALOG_PAGE_SIZE));
      const atLastPage = mcpCatalogPageIndex >= pageCount - 1;
      if (atLastPage && mcpCatalogHasMore) {
        const nextPage = mcpCatalogPageIndex + 1;
        const q = mcpCatalogSearchQuery.trim();
        await loadMcpCatalogUI({ loadMore: true, search: q });
        mcpCatalogPageIndex = nextPage;
        renderMcpCatalogGrid();
      } else if (mcpCatalogPageIndex < pageCount - 1) {
        mcpCatalogPageIndex += 1;
        renderMcpCatalogGrid();
      }
    });
  }

  document.addEventListener('click', async (e) => {
    const btn = e.target && e.target.closest ? e.target.closest('[data-mcp-catalog-install]') : null;
    if (!btn || btn.disabled) return;
    e.preventDefault();
    e.stopPropagation();
    const id = btn.dataset.mcpCatalogInstall;
    const hint = $('mcp-catalog-hint');
    if (!id || !mcpCatalogApi.mcpCatalogInstall) return;
    btn.disabled = true;
    if (hint) hint.textContent = '添加中…';
    try {
      const result = await mcpCatalogApi.mcpCatalogInstall({ id });
      if (hint) hint.textContent = formatMcpCatalogInstallHint(result);
      await loadMcpCatalogUI();
      await renderMcpList().catch(() => {});
      if (result && result.mcpId && mcpCatalogApi.listMcpServers && window.openMcpConfigDialog) {
        const servers = await mcpCatalogApi.listMcpServers();
        const added = (servers || []).find((s) => s.id === result.mcpId);
        if (added && added.needsConfig) {
          showMcpListView();
          await window.openMcpConfigDialog(added);
        }
      }
    } catch (err) {
      if (hint) hint.textContent = `失败：${err.message || err}`;
      btn.disabled = false;
    }
  });
}

window.showMcpCatalogView = showMcpCatalogView;
window.showMcpListView = showMcpListView;
window.loadMcpCatalogUI = loadMcpCatalogUI;
window.initMcpCatalogUI = initMcpCatalogUI;
