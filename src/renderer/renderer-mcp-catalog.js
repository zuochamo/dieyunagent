'use strict';

/* global window, document, $, escapeHtml, showMcpListView, renderMcpList,
   parseGridListResult, renderGridCategoryTabs, updateGridPagination, bindGridSearchInput, bindGridPagination */

const mcpCatalogApi = window.diecloud || {};
// 页大小唯一来源 renderer-skills-ui.js 导出的 window.SKILLS_GRID_PAGE_SIZE（本文件在其后加载）。
// 这里以前还有一层 `? … : 15` 兜底：它永不触发（加载顺序保证已赋值），只是把 15 又抄了一遍。
const MCP_CATALOG_PAGE_SIZE = window.SKILLS_GRID_PAGE_SIZE;

let mcpCatalogEntries = [];
let mcpCatalogSearchQuery = '';
let mcpCatalogPageIndex = 0;
let mcpCatalogFilter = 'addable';
let mcpCatalogHasMore = false;
let mcpCatalogLoading = false;
let mcpCatalogLoadedCount = 0;
let mcpCatalogSearchRemote = false;
/** 上一次加载失败的原因：非空时列表位显示错误，而不是被 finally 用旧数据盖掉 */
let mcpCatalogError = '';
/** 最近一次目录请求里各源的失败原因，用于说明「空目录」到底为什么空 */
let mcpCatalogSourceErrors = [];

function mcpCatalogPageCount() {
  const visible = getFilteredMcpCatalogEntries();
  return Math.max(1, Math.ceil(visible.length / MCP_CATALOG_PAGE_SIZE));
}

// 目录列表返回形状的解析只有一份（renderer-skills-grid.js#parseGridListResult）
function applyMcpCatalogListResult(result) {
  const parsed = parseGridListResult(result);
  mcpCatalogEntries = parsed.entries;
  mcpCatalogHasMore = parsed.hasMore;
  mcpCatalogLoadedCount = parsed.loadedCount;
  mcpCatalogSearchRemote = parsed.searchRemote;
  mcpCatalogSourceErrors = parsed.errors;
  return parsed;
}

/** 去重后的目录源失败说明，无失败返回空串 */
function mcpCatalogSourceErrorText() {
  const seen = new Set();
  const parts = [];
  for (const err of Array.isArray(mcpCatalogSourceErrors) ? mcpCatalogSourceErrors : []) {
    const message = String((err && err.message) || '').trim();
    if (!message || seen.has(message)) continue;
    seen.add(message);
    parts.push(message);
  }
  return parts.join('；');
}

/** 「这条是否可添加」的唯一判据是 Main 下发的 `canAdd`（`mcp/catalog.js#resolveCatalogAddability`）。 */
function mcpCatalogEntryCanAdd(ent) {
  return !!(ent && ent.canAdd);
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

/** 目录筛选页签：唯一来源（顺序即展示顺序，`renderGridCategoryTabs` 会补一个「全部」） */
const MCP_CATALOG_FILTERS = [
  { id: 'addable', label: '可添加' },
  { id: 'remote', label: '远程' },
  { id: 'local', label: '本地 npm' }
];

function mcpCatalogMatches(ent, filterId) {
  if (filterId === 'remote') return !!(ent.hasRemote || ent.transport === 'remote' || ent.remoteUrl);
  if (filterId === 'local') return !!(ent.hasPackage || ent.installSpec);
  return mcpCatalogEntryCanAdd(ent);
}

function countMcpCatalogInFilter(filterId) {
  if (filterId === 'all') return mcpCatalogEntries.length;
  return mcpCatalogEntries.filter((ent) => mcpCatalogMatches(ent, filterId)).length;
}

function getFilteredMcpCatalogEntries() {
  const q = mcpCatalogSearchQuery.trim().toLowerCase();
  let list = mcpCatalogEntries.slice();
  if (mcpCatalogFilter !== 'all') {
    list = list.filter((ent) => mcpCatalogMatches(ent, mcpCatalogFilter));
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
  // 页签渲染/计数/点击只有一份实现（renderer-skills-grid.js#renderGridCategoryTabs）
  renderGridCategoryTabs(
    $('mcp-catalog-filter-tabs'),
    mcpCatalogFilter,
    MCP_CATALOG_FILTERS,
    countMcpCatalogInFilter,
    (id) => {
      mcpCatalogFilter = id === 'all' ? 'all' : id;
      mcpCatalogPageIndex = 0;
      renderMcpCatalogFilterTabs();
      renderMcpCatalogGrid();
    }
  );
}

function renderMcpCatalogGrid() {
  const listEl = $('mcp-catalog-list');
  if (!listEl) return;

  if (mcpCatalogError) {
    listEl.innerHTML = `<p class="skills-empty">加载失败：${escapeHtml(mcpCatalogError)}</p>`;
    updateGridPagination('mcp-catalog', 0, 0, 0);
    return;
  }

  const visible = getFilteredMcpCatalogEntries();
  if (!visible.length) {
    const q = mcpCatalogSearchQuery.trim();
    const reason = mcpCatalogSourceErrorText();
    const emptyMsg = reason
      ? `目录源请求失败：${reason}。可点「刷新目录」重试，或回 MCP 列表用「添加」手动接入。`
      : q
        ? '没有匹配的 MCP，可换关键词或切换筛选'
        : '没有匹配的 MCP';
    listEl.innerHTML = `<p class="skills-empty">${escapeHtml(emptyMsg)}</p>`;
    updateGridPagination('mcp-catalog', 0, 0, 0);
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
      const canAdd = mcpCatalogEntryCanAdd(ent);
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
          <div class="skill-tile-foot catalog-tile-foot">
            <span class="catalog-tile-state">${installed ? '已安装' : ent.hasRemote || ent.remoteUrl ? '远程' : ent.hasPackage ? '本地' : ''}</span>
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

  // 分页条（含"末页还能继续加载"）：唯一实现在 renderer-skills-grid.js#updateGridPagination
  const atLastPage = mcpCatalogPageIndex >= pageCount - 1;
  const searchHint = mcpCatalogSearchRemote ? ' · 官方市场搜索' : '';
  const loadedHint =
    mcpCatalogLoadedCount > visible.length ? ` · 已加载 ${mcpCatalogLoadedCount} 条` : '';
  updateGridPagination('mcp-catalog', mcpCatalogPageIndex, pageCount, visible.length, {
    loading: mcpCatalogLoading,
    canLoadMore: atLastPage && mcpCatalogHasMore,
    label: `当前 ${visible.length} 项${loadedHint}${searchHint}${mcpCatalogHasMore ? ' · 可继续加载' : ''}`
  });
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
  mcpCatalogError = '';
  renderMcpCatalogGrid();
  if (!silent && !loadMore) {
    const loadingMsg = searchQuery
      ? '正在搜索官方市场…（官方 Registry 较慢，可能需数十秒）'
      : '正在加载目录…（首次拉取可能需要数十秒）';
    listEl.innerHTML = `<p class="skills-empty">${loadingMsg}</p>`;
  } else if (loadMore && hint) {
    hint.textContent = searchQuery ? '搜索加载更多…' : '加载更多…';
  }
  try {
    await fetchMcpCatalogFromApi({ refresh, loadMore, search: searchQuery });
    if (!loadMore) mcpCatalogPageIndex = 0;
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
    mcpCatalogError = String((err && err.message) || err);
    if (hint) hint.textContent = '加载失败，可点「刷新目录」重试';
  } finally {
    // 失败也走同一处渲染：以前 catch 写完错误、finally 又用旧数据重绘把它盖掉了
    mcpCatalogLoading = false;
    renderMcpCatalogFilterTabs();
    renderMcpCatalogGrid();
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

  // 搜索：防抖 / 清空语义只有一份（renderer-skills-grid.js#bindGridSearchInput）
  bindGridSearchInput(
    'mcp-catalog-search',
    () => mcpCatalogSearchQuery,
    (v) => {
      mcpCatalogSearchQuery = v;
    },
    () => mcpCatalogPageIndex,
    (v) => {
      mcpCatalogPageIndex = v;
    },
    () => {
      const q = mcpCatalogSearchQuery.trim();
      loadMcpCatalogUI({ refresh: !!q, search: q }).catch(() => {});
    }
  );

  // 翻页（末页「下一页」= 向 Main 再要一批，再推进一页）：唯一实现在 renderer-skills-grid.js
  bindGridPagination(
    'mcp-catalog',
    () => mcpCatalogPageIndex,
    (v) => {
      mcpCatalogPageIndex = v;
    },
    () => renderMcpCatalogGrid(),
    {
      onNext: async () => {
        if (mcpCatalogLoading) return true;
        if (mcpCatalogPageIndex < mcpCatalogPageCount() - 1 || !mcpCatalogHasMore) return false;
        await loadMcpCatalogUI({ loadMore: true, search: mcpCatalogSearchQuery.trim() });
        mcpCatalogPageIndex += 1;
        renderMcpCatalogGrid();
        return true;
      }
    }
  );

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

// `showMcpListView` 是跨文件契约（renderer-skills-grid.js 切页签时调用），保留导出；
// showMcpCatalogView / loadMcpCatalogUI 只有本文件在用，不再挂到 window。
window.showMcpListView = showMcpListView;
window.initMcpCatalogUI = initMcpCatalogUI;
