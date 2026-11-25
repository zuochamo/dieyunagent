'use strict';

/* global window, document, $, escapeHtml, refreshSkillsCatalog, gatewayCall,
   updateGridPagination, bindGridSearchInput, bindGridPagination, parseGridListResult */

const skillCatalogApi = window.diecloud || {};
// 页大小唯一来源 window.SKILLS_GRID_PAGE_SIZE（renderer-skills-ui.js 在本文件之前加载）。
const SKILL_CATALOG_PAGE_SIZE = window.SKILLS_GRID_PAGE_SIZE;

let skillCatalogEntries = [];
let skillCatalogSearchQuery = '';
let skillCatalogPageIndex = 0;
let skillCatalogHasMore = false;
let skillCatalogLoading = false;
let skillCatalogLoadedCount = 0;
let skillCatalogSearchRemote = false;
let skillCatalogDetailEntry = null;
/** 上一次加载失败的原因：非空时列表位显示错误，而不是被 finally 用旧数据盖掉 */
let skillCatalogError = '';

function skillCatalogPageCount() {
  return Math.max(1, Math.ceil(skillCatalogEntries.length / SKILL_CATALOG_PAGE_SIZE));
}

function findSkillCatalogEntry(id) {
  return skillCatalogEntries.find((ent) => ent.id === id) || null;
}

function closeSkillCatalogDetail() {
  const overlay = $('skill-catalog-detail-overlay');
  if (overlay) overlay.hidden = true;
  skillCatalogDetailEntry = null;
}

function renderSkillCatalogDetailBody(ent, data) {
  const installsNote = ent && ent.installs ? `${formatInstallCount(ent.installs)} 次安装` : '';
  const source = data?.source || ent?.source || '';
  const url = data?.url || ent?.url || (ent?.id ? `https://skills.sh/${ent.id}` : '');
  let html = '';
  if (source || installsNote || url) {
    html += '<section class="skill-detail-section"><h3>市场信息</h3>';
    if (source) {
      html += `<p><span class="field-label">来源</span> <code>${escapeHtml(source)}</code></p>`;
    }
    if (installsNote) {
      html += `<p><span class="field-label">安装量</span> ${escapeHtml(installsNote)}</p>`;
    }
    if (url) {
      html += `<p class="skill-detail-path"><span class="field-label">链接</span> <code>${escapeHtml(url)}</code></p>`;
    }
    html += '</section>';
  }
  const desc = data?.description || ent?.description || '';
  if (desc) {
    html += `<section class="skill-detail-section"><h3>简介</h3><p>${escapeHtml(desc)}</p></section>`;
  }
  const content = data?.content || '';
  if (content) {
    const maxLen = 12000;
    const clipped = content.length > maxLen;
    const shown = clipped ? content.slice(0, maxLen) : content;
    html += `<section class="skill-detail-section"><h3>SKILL.md</h3><pre class="skill-detail-pre">${escapeHtml(shown)}</pre>`;
    if (clipped) {
      html += `<p class="save-hint">内容较长，仅显示前 ${maxLen.toLocaleString()} 字符</p>`;
    }
    html += '</section>';
  }
  const files = Array.isArray(data?.files) ? data.files : [];
  if (files.length) {
    html += `<section class="skill-detail-section"><h3>附带文件</h3><p>${escapeHtml(files.join(' · '))}</p></section>`;
  }
  if (!html) {
    html = '<p class="skills-empty">暂无详情</p>';
  }
  return html;
}

async function openSkillCatalogDetail(ent) {
  const overlay = $('skill-catalog-detail-overlay');
  const titleEl = $('skill-catalog-detail-title');
  const bodyEl = $('skill-catalog-detail-body');
  const hintEl = $('skill-catalog-detail-hint');
  const installBtn = $('skill-catalog-detail-install');
  const webBtn = $('skill-catalog-detail-open-web');
  if (!overlay || !bodyEl || !ent || !ent.id) return;

  skillCatalogDetailEntry = ent;
  overlay.hidden = false;
  if (titleEl) titleEl.textContent = ent.name || ent.id;
  bodyEl.innerHTML = '<p class="skills-empty">正在加载 SKILL.md…</p>';
  if (hintEl) hintEl.textContent = '';
  if (installBtn) {
    installBtn.hidden = true;
    installBtn.disabled = true;
  }
  if (webBtn) webBtn.hidden = true;

  if (!skillCatalogApi.skillCatalogPreview) {
    bodyEl.innerHTML = renderSkillCatalogDetailBody(ent, null);
    return;
  }

  try {
    const data = await skillCatalogApi.skillCatalogPreview({ id: ent.id });
    if (titleEl && data?.name) titleEl.textContent = data.name;
    bodyEl.innerHTML = renderSkillCatalogDetailBody(ent, data);

    const installed = (data && data.installState === 'installed') || ent.installState === 'installed';
    if (installBtn) {
      installBtn.hidden = false;
      installBtn.disabled = installed || !skillCatalogApi.skillCatalogInstall;
      installBtn.textContent = installed ? '已安装' : '添加到本地';
    }
    const url = data?.url || ent.url || `https://skills.sh/${ent.id}`;
    if (webBtn && url) {
      webBtn.hidden = false;
      webBtn.dataset.url = url;
    }
  } catch (err) {
    bodyEl.innerHTML = `<p class="skills-empty">加载失败：${escapeHtml(err.message || err)}</p>`;
    if (installBtn) installBtn.hidden = true;
  }
}

async function installSkillCatalogEntry(id, { fromDetail = false } = {}) {
  if (!id || !skillCatalogApi.skillCatalogInstall) return;
  const hint = fromDetail ? $('skill-catalog-detail-hint') : $('skill-catalog-hint');
  const installBtn = fromDetail ? $('skill-catalog-detail-install') : null;
  if (installBtn) {
    installBtn.disabled = true;
    installBtn.textContent = '安装中…';
  }
  try {
    const result = await skillCatalogApi.skillCatalogInstall({ id });
    if (hint) {
      hint.textContent =
        result && result.action === 'installed'
          ? '该技能已安装'
          : `已安装：${result?.name || id}`;
    }
    await loadSkillCatalogUI({ refresh: true, silent: true });
    if (typeof refreshSkillsCatalog === 'function') refreshSkillsCatalog();
    if (fromDetail) {
      const ent = findSkillCatalogEntry(id) || skillCatalogDetailEntry;
      if (ent) {
        ent.installState = 'installed';
        ent.canAdd = false;
      }
      if (installBtn) {
        installBtn.disabled = true;
        installBtn.textContent = '已安装';
      }
    }
  } catch (err) {
    if (hint) hint.textContent = `安装失败：${err.message || err}`;
    if (installBtn) {
      installBtn.disabled = false;
      installBtn.textContent = '添加到本地';
    }
    throw err;
  }
}

// 目录列表返回形状的解析只有一份（renderer-skills-grid.js#parseGridListResult）
function applySkillCatalogListResult(result) {
  const parsed = parseGridListResult(result);
  skillCatalogEntries = parsed.entries;
  skillCatalogHasMore = parsed.hasMore;
  skillCatalogLoadedCount = parsed.loadedCount;
  skillCatalogSearchRemote = parsed.searchRemote;
  return parsed;
}

function showSkillListView() {
  document.querySelectorAll('.skill-settings-view').forEach((el) => {
    el.classList.toggle('active', el.dataset.skillView === 'list');
  });
}

function showSkillCatalogView() {
  document.querySelectorAll('.skill-settings-view').forEach((el) => {
    el.classList.toggle('active', el.dataset.skillView === 'catalog');
  });
}

function formatInstallCount(n) {
  const v = Number(n) || 0;
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  if (v >= 1000) return `${(v / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  return String(v);
}

function renderSkillCatalogGrid() {
  const listEl = $('skill-catalog-list');
  if (!listEl) return;

  if (skillCatalogError) {
    listEl.innerHTML = `<p class="skills-empty">加载失败：${escapeHtml(skillCatalogError)}</p>`;
    updateGridPagination('skill-catalog', 0, 0, 0);
    return;
  }

  const visible = skillCatalogEntries.slice();
  if (!visible.length) {
    const q = skillCatalogSearchQuery.trim();
    const emptyMsg = q
      ? '没有匹配的技能，可换关键词（skills.sh 搜索至少 2 个字符）'
      : '目录为空';
    listEl.innerHTML = `<p class="skills-empty">${emptyMsg}</p>`;
    updateGridPagination('skill-catalog', 0, 0, 0);
    return;
  }

  const pageCount = skillCatalogPageCount();
  if (skillCatalogPageIndex >= pageCount) skillCatalogPageIndex = pageCount - 1;
  if (skillCatalogPageIndex < 0) skillCatalogPageIndex = 0;
  const slice = visible.slice(
    skillCatalogPageIndex * SKILL_CATALOG_PAGE_SIZE,
    skillCatalogPageIndex * SKILL_CATALOG_PAGE_SIZE + SKILL_CATALOG_PAGE_SIZE
  );

  listEl.innerHTML = slice
    .map((ent) => {
      const installed = ent.installState === 'installed';
      const action = installed ? '已安装' : '添加';
      const disabled = installed;
      const actionClass = disabled
        ? 'catalog-tile-action catalog-tile-action-disabled'
        : 'catalog-tile-action primary-btn';
      const sourceNote = ent.source ? escapeHtml(ent.source) : '';
      const installsNote = ent.installs ? `${formatInstallCount(ent.installs)} 次安装` : '';
      return `<article class="skill-tile mcp-tile mcp-catalog-tile skill-catalog-tile${installed ? ' enabled' : ''}" data-skill-catalog-detail="${escapeHtml(ent.id)}" tabindex="0" role="button" aria-label="查看 ${escapeHtml(ent.name || ent.id)} 详情">
          <div class="skill-tile-head">
            <div class="skill-tile-title">${escapeHtml(ent.name || ent.id)}</div>
            <span class="skill-tile-tag">${installsNote || 'skills.sh'}</span>
          </div>
          <p class="skill-tile-desc">${escapeHtml(ent.description || sourceNote || '点击查看 SKILL.md 详情')}</p>
          <p class="skill-tile-hint">${sourceNote}${installsNote ? ` · ${installsNote}` : ''}</p>
          <div class="skill-tile-foot catalog-tile-foot">
            <span class="catalog-tile-state">${installed ? '已安装' : '市场'}</span>
            <button
              type="button"
              class="${actionClass}"
              data-skill-catalog-install="${escapeHtml(ent.id)}"
              ${disabled ? 'disabled' : ''}
              title="${installed ? '已在 ~/.dieyun/skills 安装' : '下载到 ~/.dieyun/skills'}"
            >${action}</button>
          </div>
        </article>`;
    })
    .join('');

  // 分页条（含"末页还能继续加载"）：唯一实现在 renderer-skills-grid.js#updateGridPagination
  const atLastPage = skillCatalogPageIndex >= pageCount - 1;
  const searchHint = skillCatalogSearchRemote ? ' · skills.sh 搜索' : '';
  const loadedHint =
    skillCatalogLoadedCount > visible.length ? ` · 已加载 ${skillCatalogLoadedCount} 条` : '';
  updateGridPagination('skill-catalog', skillCatalogPageIndex, pageCount, visible.length, {
    loading: skillCatalogLoading,
    canLoadMore: atLastPage && skillCatalogHasMore,
    label: `当前 ${visible.length} 项${loadedHint}${searchHint}${skillCatalogHasMore ? ' · 可继续加载' : ''}`
  });
}

async function fetchSkillCatalogFromApi({ refresh = false, loadMore = false, search = '' } = {}) {
  const q = String(search || '').trim();
  const result = await skillCatalogApi.skillCatalogList({
    refresh,
    loadMore,
    search: q
  });
  return applySkillCatalogListResult(result);
}

async function loadSkillCatalogUI({ refresh = false, loadMore = false, silent = false, search } = {}) {
  const listEl = $('skill-catalog-list');
  const hint = $('skill-catalog-hint');
  if (!listEl || skillCatalogLoading) return;
  if (!skillCatalogApi.skillCatalogList) {
    listEl.innerHTML = '<p class="skills-empty">当前版本未提供技能市场</p>';
    return;
  }
  const searchQuery = search != null ? String(search).trim() : skillCatalogSearchQuery.trim();
  skillCatalogLoading = true;
  skillCatalogError = '';
  renderSkillCatalogGrid();
  if (!silent && !loadMore) {
    listEl.innerHTML = `<p class="skills-empty">${searchQuery ? '正在搜索 skills.sh…' : '加载目录…'}</p>`;
  } else if (loadMore && hint) {
    hint.textContent = searchQuery ? '搜索加载更多…' : '加载更多…';
  }
  try {
    // 首屏条数与「太短的搜索词」都由 Main 判定（skills/catalog.js）：
    // 它一次给 3 页（45 条）、搜索词 <2 字符直接回空表 —— Renderer 不再补一遍预取或特判。
    await fetchSkillCatalogFromApi({ refresh, loadMore, search: searchQuery });
    if (!loadMore) skillCatalogPageIndex = 0;
    if (hint) {
      if (refresh) hint.textContent = '目录已刷新';
      else if (loadMore) hint.textContent = skillCatalogHasMore ? '已加载更多' : '已全部加载';
      else if (searchQuery && skillCatalogSearchRemote && skillCatalogEntries.length) {
        hint.textContent = '已在 skills.sh 搜索';
      } else if (!silent) {
        hint.textContent = skillCatalogHasMore ? '已加载首屏，翻页可继续加载' : '';
      }
    }
  } catch (err) {
    skillCatalogError = String((err && err.message) || err);
    if (hint) hint.textContent = '加载失败，可点「刷新目录」重试';
  } finally {
    // 失败也要走同一处渲染：以前 catch 写完错误、finally 又用旧数据重绘把它盖掉了
    skillCatalogLoading = false;
    renderSkillCatalogGrid();
  }
}

/**
 * 打开市场页链接：走既有 RPC `host.open_url`。
 *
 * 唯一实现是 `gateway/host-control.js#openExternalUrl`（http(s) 校验 + shell.openExternal +
 * 非 Electron 回落）。以前这里判断 `diecloud.openExternal` —— 那个方法**从来不存在**，
 * 所以按钮点了只会显示一句提示；现在接上既有通道，被 hostControl 权限拒绝时如实说明。
 * @param {string} url
 */
async function openSkillCatalogUrl(url) {
  const target = String(url || '').trim();
  if (!target) return;
  try {
    if (typeof gatewayCall !== 'function') throw new Error('Gateway 未就绪');
    await gatewayCall('host.open_url', { url: target });
  } catch (err) {
    const hintEl = $('skill-catalog-detail-hint');
    if (hintEl) {
      hintEl.textContent = `无法直接打开（${(err && err.message) || err}）；链接已显示在上方，可复制到浏览器`;
    }
  }
}

function initSkillCatalogUI() {
  const openBtn = $('skill-catalog-open-btn');
  if (openBtn) {
    openBtn.addEventListener('click', () => {
      showSkillCatalogView();
      loadSkillCatalogUI().catch(() => {});
    });
  }

  const backBtn = $('skill-catalog-back');
  if (backBtn) {
    backBtn.addEventListener('click', () => {
      showSkillListView();
      if (typeof refreshSkillsCatalog === 'function') refreshSkillsCatalog();
    });
  }

  const refreshBtn = $('skill-catalog-refresh');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', () => loadSkillCatalogUI({ refresh: true }));
  }

  // 搜索：防抖 / 清空语义只有一份（renderer-skills-grid.js#bindGridSearchInput）
  bindGridSearchInput(
    'skill-catalog-search',
    () => skillCatalogSearchQuery,
    (v) => {
      skillCatalogSearchQuery = v;
    },
    () => skillCatalogPageIndex,
    (v) => {
      skillCatalogPageIndex = v;
    },
    () => {
      const q = skillCatalogSearchQuery.trim();
      loadSkillCatalogUI({ refresh: !!q, search: q }).catch(() => {});
    }
  );

  bindGridPagination(
    'skill-catalog',
    () => skillCatalogPageIndex,
    (v) => {
      skillCatalogPageIndex = v;
    },
    () => renderSkillCatalogGrid(),
    {
      /**
       * 末页「下一页」= 向 Main 再要一批。
       * 以前这里加载完只重渲染、**不推进索引**，用户点一次看到的还是同一页（要再点一次才动）。
       */
      onNext: async () => {
        if (skillCatalogLoading) return true;
        if (skillCatalogPageIndex < skillCatalogPageCount() - 1 || !skillCatalogHasMore) return false;
        await loadSkillCatalogUI({ loadMore: true, silent: true });
        skillCatalogPageIndex += 1;
        renderSkillCatalogGrid();
        return true;
      }
    }
  );

  const listEl = $('skill-catalog-list');
  if (listEl) {
    listEl.addEventListener('click', async (e) => {
      const installBtn = e.target.closest('[data-skill-catalog-install]');
      if (installBtn) {
        e.stopPropagation();
        if (installBtn.disabled || !skillCatalogApi.skillCatalogInstall) return;
        const id = installBtn.getAttribute('data-skill-catalog-install');
        if (!id) return;
        installBtn.disabled = true;
        const prevText = installBtn.textContent;
        installBtn.textContent = '安装中…';
        try {
          await installSkillCatalogEntry(id, { fromDetail: false });
        } catch {
          installBtn.disabled = false;
          installBtn.textContent = prevText;
        }
        return;
      }

      const tile = e.target.closest('[data-skill-catalog-detail]');
      if (!tile) return;
      const id = tile.getAttribute('data-skill-catalog-detail');
      const ent = findSkillCatalogEntry(id);
      if (ent) openSkillCatalogDetail(ent).catch(() => {});
    });

    listEl.addEventListener('keydown', (e) => {
      const tile = e.target.closest('[data-skill-catalog-detail]');
      if (!tile || (e.key !== 'Enter' && e.key !== ' ')) return;
      if (e.target.closest('[data-skill-catalog-install]')) return;
      e.preventDefault();
      const id = tile.getAttribute('data-skill-catalog-detail');
      const ent = findSkillCatalogEntry(id);
      if (ent) openSkillCatalogDetail(ent).catch(() => {});
    });
  }

  const detailClose = $('skill-catalog-detail-close');
  if (detailClose) detailClose.addEventListener('click', closeSkillCatalogDetail);

  const detailInstallBtn = $('skill-catalog-detail-install');
  if (detailInstallBtn) {
    detailInstallBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (detailInstallBtn.disabled || !skillCatalogDetailEntry) return;
      try {
        await installSkillCatalogEntry(skillCatalogDetailEntry.id, { fromDetail: true });
      } catch {
        // hint already set
      }
    });
  }

  const detailWebBtn = $('skill-catalog-detail-open-web');
  if (detailWebBtn) {
    detailWebBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const url = detailWebBtn.dataset.url;
      if (!url) return;
      openSkillCatalogUrl(url).catch(() => {});
    });
  }

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const overlay = $('skill-catalog-detail-overlay');
    if (overlay && !overlay.hidden) closeSkillCatalogDetail();
  });
}

window.initSkillCatalogUI = initSkillCatalogUI;
