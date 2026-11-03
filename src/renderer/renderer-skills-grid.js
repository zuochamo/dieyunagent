/* global window, document, $, escapeHtml, gwState, gatewayCall, openSettingsShell, switchSettingsPage, refreshAutomationList, showMcpListView, showAgentToast, getEffectiveInputBudget, CTX_LIMITS */
'use strict';

var skillsApi = window.diecloud || {};

var SKILLS_ENABLED_KEY = 'diecloud.skills.enabled.v1';
var SKILLS_HIDDEN_KEY = 'diecloud.skills.hidden.v1';
var SKILLS_PAGE_SIZE = 15;
var DEFAULT_ENABLED_SKILL_IDS = ['builtin:weather'];
var DEFAULT_ENABLED_SKILL_PREFIXES = ['builtin:minimax:', 'builtin:curated:'];
var SKILLS_TAB_TITLES = { list: '技能', mcp: 'MCP', automation: '定时' };

/**
 * 技能功能分类（页签）的**唯一来源是 Main**：`src/skills/taxonomy.js` 随扫描结果下发
 * （`skillsCatalog.domains` + 每个技能的 `domain`）。分类是数据 —— frontmatter 的 `domain:`
 * 或预装精确 id 表 —— Renderer 只负责渲染，不再用 150 个关键词 + 9 条正则去猜。
 */
var SKILLS_DOMAIN_DEFAULT = 'efficiency';

function skillsDomains() {
  var list = skillsCatalog && Array.isArray(skillsCatalog.domains) ? skillsCatalog.domains : [];
  return list.filter(function (d) {
    return d && d.id;
  });
}


/** MCP 列表分组（与技能页相同的 Tab 风格）；两个 id 必须与 `resolveMcpCategory` 的返回值一致 */
var MCP_TAXONOMY = [
  { id: 'efficiency', label: '效率工具' },
  { id: 'user', label: '用户添加' }
];

// 「定时」页的分类页签：**唯一来源**（renderer-automation.js 的 resolveAutomationCategory
// 产出的每个 id 都必须在这里有一项，否则那种计划在界面上根本点不到）。
var AUTOMATION_TAXONOMY = [
  { id: 'periodic', label: '周期' },
  { id: 'interval', label: '按间隔' },
  { id: 'once', label: '单次' },
  { id: 'idle', label: '空闲时' },
  { id: 'goal', label: '目标' },
  { id: 'disabled', label: '已停用' }
];

function renderGridCategoryTabs(nav, activeId, tabs, countForId, onPick) {
  if (!nav) return;
  nav.innerHTML = '';
  const mkTab = (id, label) => {
    const n = countForId(id);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `skills-category-tab${activeId === id ? ' active' : ''}`;
    btn.dataset.category = id;
    btn.textContent = id === 'all' ? label : n > 0 ? `${label} ${n}` : label;
    btn.addEventListener('click', () => onPick(id));
    nav.appendChild(btn);
  };
  mkTab('all', '全部');
  for (const cat of tabs) mkTab(cat.id, cat.label);
}

function updateGridPagination(prefix, pageIndex, pageCount, total) {
  const bar = $(`${prefix}-pagination`);
  const info = $(`${prefix}-page-info`);
  const prev = $(`${prefix}-page-prev`);
  const next = $(`${prefix}-page-next`);
  if (!bar) return;
  if (pageCount <= 1) {
    bar.hidden = true;
    return;
  }
  bar.hidden = false;
  if (info) info.textContent = `${pageIndex + 1} / ${pageCount}（共 ${total} 项）`;
  if (prev) prev.disabled = pageIndex <= 0;
  if (next) next.disabled = pageIndex >= pageCount - 1;
}

function bindGridSearchInput(inputId, getQuery, setQuery, getPageIndex, setPageIndex, onRefresh) {
  const input = $(inputId);
  if (!input) return;
  let searchDebounce;
  input.addEventListener('input', () => {
    setQuery(input.value || '');
    setPageIndex(0);
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(onRefresh, 200);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    input.value = '';
    setQuery('');
    setPageIndex(0);
    onRefresh();
  });
}

function bindGridPagination(prefix, getPageIndex, setPageIndex, onRefresh) {
  const prev = $(`${prefix}-page-prev`);
  const next = $(`${prefix}-page-next`);
  if (prev) {
    prev.addEventListener('click', () => {
      const idx = getPageIndex();
      if (idx > 0) {
        setPageIndex(idx - 1);
        onRefresh();
      }
    });
  }
  if (next) {
    next.addEventListener('click', () => {
      setPageIndex(getPageIndex() + 1);
      onRefresh();
    });
  }
}

function findDomainById(catId) {
  const list = skillsDomains();
  return (
    list.find((c) => c.id === catId) ||
    list.find((c) => c.id === SKILLS_DOMAIN_DEFAULT) ||
    { id: SKILLS_DOMAIN_DEFAULT, label: '效率工具' }
  );
}

function skillSearchHaystack(skill) {
  return [skill.id, skill.name, skill.description, skill.preview, skill.category]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

/** 技能的页签 id：分类由 Main 的 `skills/taxonomy.js` 决定，这里只读不算。 */
function skillDomainId(skill) {
  const d = String((skill && skill.domain) || '');
  return skillsDomains().some((c) => c.id === d) ? d : SKILLS_DOMAIN_DEFAULT;
}

function skillDomainLabel(skill) {
  return findDomainById(skillDomainId(skill)).label;
}


function normalizeSkillsCategoryFilter() {
  if (
    skillsCategoryFilter !== 'all' &&
    !skillsDomains().some((c) => c.id === skillsCategoryFilter)
  ) {
    skillsCategoryFilter = 'all';
  }
}

var skillsCatalog = { skills: [], roots: [], domains: [] };
var skillsCategoryFilter = 'all';
var skillsSearchQuery = '';
var skillsPageIndex = 0;

var mcpServersCache = [];
var mcpCategoryFilter = 'all';
var mcpSearchQuery = '';
var mcpPageIndex = 0;

/**
 * MCP 分组只看**结构**：预装（registry 里登记的）→ 效率工具，用户自己加的 → 用户添加。
 * 以前这里还有一条 `/playwright|github|context7/` 的名称词表把这三个塞进「开发工具」，
 * 但那三个 npx 模板 2026-11 已从 `src/mcp/registry.js` 移除，词表永远匹配不到任何东西。
 */
function resolveMcpCategory(server) {
  if (!server || server.builtin === false) return 'user';
  return 'efficiency';
}

function mcpSearchHaystack(server) {
  const command = [server.command, ...(server.args || [])].filter(Boolean).join(' ');
  return [
    server.id,
    server.name,
    server.description,
    command,
    server.envHint,
    ...(Array.isArray(server.envHints) ? server.envHints.map((def) => def && def.name) : []),
    server.remoteUrl,
    server.transportKind
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

function getFilteredMcpServers() {
  const q = mcpSearchQuery.trim().toLowerCase();
  let list = mcpServersCache.slice();
  if (mcpCategoryFilter !== 'all') {
    list = list.filter((s) => resolveMcpCategory(s) === mcpCategoryFilter);
  }
  if (q) {
    list = list.filter((s) => mcpSearchHaystack(s).includes(q));
  }
  list.sort((a, b) => {
    const ea = a.enabled ? 1 : 0;
    const eb = b.enabled ? 1 : 0;
    if (eb !== ea) return eb - ea;
    return String(a.name || a.id).localeCompare(String(b.name || b.id), 'zh-CN');
  });
  return list;
}

function countMcpInCategory(catId) {
  if (catId === 'all') return mcpServersCache.length;
  return mcpServersCache.filter((s) => resolveMcpCategory(s) === catId).length;
}

function renderMcpCategoryTabs() {
  renderGridCategoryTabs($('mcp-category-tabs'), mcpCategoryFilter, MCP_TAXONOMY, countMcpInCategory, (id) => {
    mcpCategoryFilter = id;
    mcpPageIndex = 0;
    renderMcpCategoryTabs();
    renderMcpList().catch(() => {});
  });
}

function openSettingsSkillsPage(skillsTab = 'list') {
  if (!openSettingsShell()) return;
  switchSkillsTab(skillsTab);
  if (skillsTab === 'list') refreshSkillsCatalog().catch(() => {});
}

function switchSkillsTab(tab) {
  const skillsTab = tab || 'list';
  switchSettingsPage(
    'skills',
    SKILLS_TAB_TITLES[skillsTab] || skillsTab,
    (el) => el.dataset.settingsAction === 'skills' && el.dataset.skillsTab === skillsTab
  );
  document.querySelectorAll('.skills-page[data-skills-tab]').forEach((el) => {
    el.classList.toggle('active', el.dataset.skillsTab === skillsTab);
  });
  if (skillsTab === 'list') {
    renderSkillsCategoryTabs();
    renderSkillsList();
  }
  if (skillsTab === 'mcp') {
    if (typeof showMcpListView === 'function') showMcpListView();
    renderMcpCategoryTabs();
    renderMcpList().catch(() => {});
  }
  if (skillsTab === 'automation') {
    const activate = window.activateAutomationTab;
    if (typeof activate === 'function') activate().catch(() => {});
    else if (typeof window.refreshAutomationList === 'function') window.refreshAutomationList().catch(() => {});
  }
}

function shouldDefaultEnableSkillId(id) {
  if (DEFAULT_ENABLED_SKILL_IDS.includes(id)) return true;
  return DEFAULT_ENABLED_SKILL_PREFIXES.some((prefix) => id.startsWith(prefix));
}

function isSkillEnabled(map, id) {
  if (Object.prototype.hasOwnProperty.call(map, id)) return !!map[id];
  return shouldDefaultEnableSkillId(id);
}

function loadEnabledSkillIds() {
  try {
    const raw = window.localStorage.getItem(SKILLS_ENABLED_KEY);
    const obj = raw ? JSON.parse(raw) : {};
    const map = obj && typeof obj === 'object' ? obj : {};
    let changed = false;
    for (const sk of skillsCatalog.skills || []) {
      if (map[sk.id] === undefined && shouldDefaultEnableSkillId(sk.id)) {
        map[sk.id] = true;
        changed = true;
      }
    }
    for (const id of DEFAULT_ENABLED_SKILL_IDS) {
      if (map[id] === undefined) {
        map[id] = true;
        changed = true;
      }
    }
    if (changed) saveEnabledSkillIds(map);
    return map;
  } catch {
    const map = {};
    for (const id of DEFAULT_ENABLED_SKILL_IDS) map[id] = true;
    return map;
  }
}

function updateSkillsEnabledCount() {
  const el = $('skills-enabled-count');
  if (!el) return;
  const map = loadEnabledSkillIds();
  const hidden = loadHiddenSkillIds();
  const n = (skillsCatalog.skills || []).filter(
    (sk) => !isSkillHidden(hidden, sk) && isSkillEnabled(map, sk.id)
  ).length;
  el.textContent = `${n} 项已启用`;
}

function saveEnabledSkillIds(map) {
  try {
    window.localStorage.setItem(SKILLS_ENABLED_KEY, JSON.stringify(map));
    window.dispatchEvent(new CustomEvent('dieyun:skills-enabled-change'));
  } catch {
    // ignore
  }
}

function loadHiddenSkillIds() {
  try {
    const raw = window.localStorage.getItem(SKILLS_HIDDEN_KEY);
    const obj = raw ? JSON.parse(raw) : {};
    return obj && typeof obj === 'object' ? obj : {};
  } catch {
    return {};
  }
}

function saveHiddenSkillIds(map) {
  try {
    window.localStorage.setItem(SKILLS_HIDDEN_KEY, JSON.stringify(map));
  } catch {
    // ignore
  }
}

/**
 * 是否隐藏。隐藏只对不可删（内置/预装）技能有意义：可删技能的隐藏记录来自旧版
 * 「有 skillKey 即内置」的误判，一律视为未隐藏。
 */
function isSkillHidden(hidden, sk) {
  return !!hidden[sk.id] && sk.deletable !== true;
}

/** 清掉旧判定残留、当前已可删的隐藏记录；返回清理后的隐藏表 */
function pruneStaleHiddenSkills() {
  const hidden = loadHiddenSkillIds();
  let changed = false;
  for (const sk of skillsCatalog.skills || []) {
    if (hidden[sk.id] && sk.deletable === true) {
      delete hidden[sk.id];
      changed = true;
    }
  }
  if (changed) saveHiddenSkillIds(hidden);
  return hidden;
}

function getSortedVisibleSkills() {
  const enabled = loadEnabledSkillIds();
  const hidden = loadHiddenSkillIds();
  const q = skillsSearchQuery.trim().toLowerCase();
  let skills = (skillsCatalog.skills || []).filter((sk) => !isSkillHidden(hidden, sk));
  if (skillsCategoryFilter !== 'all') {
    skills = skills.filter((sk) => skillDomainId(sk) === skillsCategoryFilter);
  }
  if (q) {
    skills = skills.filter((sk) => {
      const hay = [
        sk.name,
        sk.description,
        sk.descriptionZh,
        sk.descriptionEn,
        sk.preview,
        sk.category,
        sk.id
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return hay.includes(q);
    });
  }
  skills.sort((a, b) => {
    const ea = isSkillEnabled(enabled, a.id) ? 1 : 0;
    const eb = isSkillEnabled(enabled, b.id) ? 1 : 0;
    if (eb !== ea) return eb - ea;
    return String(a.name).localeCompare(String(b.name), 'zh-CN');
  });
  return skills;
}

function countSkillsInTaxonomy(taxonomyId) {
  const hidden = loadHiddenSkillIds();
  return (skillsCatalog.skills || []).filter((sk) => {
    if (isSkillHidden(hidden, sk)) return false;
    if (taxonomyId === 'all') return true;
    return skillDomainId(sk) === taxonomyId;
  }).length;
}

function renderSkillsCategoryTabs() {
  normalizeSkillsCategoryFilter();
  const nav = $('skills-category-tabs');
  if (!nav) return;
  nav.innerHTML = '';

  const mkTab = (id, label) => {
    const n = countSkillsInTaxonomy(id);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `skills-category-tab${skillsCategoryFilter === id ? ' active' : ''}`;
    btn.dataset.category = id;
    btn.textContent = id === 'all' ? label : n > 0 ? `${label} ${n}` : label;
    btn.addEventListener('click', () => {
      skillsCategoryFilter = id;
      skillsPageIndex = 0;
      renderSkillsCategoryTabs();
      renderSkillsList();
    });
    nav.appendChild(btn);
  };

  mkTab('all', '全部');
  for (const cat of skillsDomains()) {
    mkTab(cat.id, cat.label);
  }
}

function updateSkillsPagination(total, pageCount) {
  const bar = $('skills-pagination');
  const info = $('skills-page-info');
  const prev = $('skills-page-prev');
  const next = $('skills-page-next');
  if (!bar) return;
  if (pageCount <= 1) {
    bar.hidden = true;
    return;
  }
  bar.hidden = false;
  if (info) info.textContent = `${skillsPageIndex + 1} / ${pageCount}（共 ${total} 项）`;
  if (prev) prev.disabled = skillsPageIndex <= 0;
  if (next) next.disabled = skillsPageIndex >= pageCount - 1;
}

async function deleteSkillItem(sk) {
  const label = sk.name || sk.id;
  // 可删性由 Main 侧的扫描结果下发（deletable），Renderer 不再自行用 builtin 推断
  const canDelete = sk.deletable !== false;
  const hint = canDelete ? '' : '\n（内置/预装技能将从列表隐藏，不会删除安装文件）';
  if (!window.confirm(`确定删除技能「${label}」？${hint}`)) {
    return;
  }
  const enabled = loadEnabledSkillIds();
  delete enabled[sk.id];
  saveEnabledSkillIds(enabled);
  if (canDelete) {
    if (!skillsApi.deleteSkill) {
      window.alert('当前版本未提供技能删除接口');
      return;
    }
    try {
      await skillsApi.deleteSkill({ dir: sk.dir });
    } catch (err) {
      window.alert(`删除失败：${err.message || err}`);
      return;
    }
  } else {
    const hidden = loadHiddenSkillIds();
    hidden[sk.id] = true;
    saveHiddenSkillIds(hidden);
  }
  await refreshSkillsCatalog();
}

/**
 * 技能「最近使用」提示。
 * 数据来自 skills:scan 合并的使用账本（Main 侧 skills/usage-ledger.js），
 * 这里只负责显示 —— 不要在 Renderer 再判断「算不算用过」。
 * @param {{ lastUsedAt?: number, useCount?: number }} sk
 */
function formatSkillUsageHint(sk) {
  const at = Number(sk && sk.lastUsedAt) || 0;
  if (!at) return '';
  const days = Math.floor(Math.max(0, Date.now() - at) / 86400000);
  const when = days <= 0 ? '今天' : days === 1 ? '昨天' : `${days} 天前`;
  const times = Number(sk.useCount) || 0;
  return `最近使用：${when}${times > 1 ? ` · 共 ${times} 次` : ''}`;
}

function renderSkillsList() {
  const grid = $('skills-grid');
  if (!grid) return;
  const enabled = loadEnabledSkillIds();
  const hidden = pruneStaleHiddenSkills();
  const allVisible = getSortedVisibleSkills();
  const totalAll = (skillsCatalog.skills || []).filter((sk) => !isSkillHidden(hidden, sk)).length;
  if (!totalAll) {
    grid.innerHTML =
      '<div class="skills-empty">未找到技能。请将 SKILL.md 放入 ~/.dieyun/skills，也可在对话中让 Agent 创建技能。</div>';
    updateSkillsPagination(0, 0);
    return;
  }
  if (!allVisible.length) {
    const hint = skillsSearchQuery.trim()
      ? '没有匹配的技能，请调整搜索或分类'
      : '当前分类下暂无技能';
    grid.innerHTML = `<div class="skills-empty">${escapeHtml(hint)}</div>`;
    updateSkillsPagination(0, 0);
    return;
  }
  const pageCount = Math.max(1, Math.ceil(allVisible.length / SKILLS_PAGE_SIZE));
  if (skillsPageIndex >= pageCount) skillsPageIndex = pageCount - 1;
  if (skillsPageIndex < 0) skillsPageIndex = 0;
  const slice = allVisible.slice(
    skillsPageIndex * SKILLS_PAGE_SIZE,
    skillsPageIndex * SKILLS_PAGE_SIZE + SKILLS_PAGE_SIZE
  );
  grid.innerHTML = '';
  for (const sk of slice) {
    const on = isSkillEnabled(enabled, sk.id);
    const desc = sk.description || sk.preview || '暂无简介';
    const usageHint = formatSkillUsageHint(sk);
    const tile = document.createElement('article');
    tile.className = `skill-tile${on ? ' enabled' : ''}`;
    tile.setAttribute('role', 'button');
    tile.tabIndex = 0;
    tile.title = '点击查看完整介绍';
    tile.innerHTML = `
      <div class="skill-tile-head">
        <div class="skill-tile-title">${escapeHtml(sk.name)}</div>
      </div>
      <p class="skill-tile-desc">${escapeHtml(desc)}</p>
      <p class="skill-tile-hint">${escapeHtml(usageHint || '点击查看完整介绍')}</p>
      <div class="skill-tile-foot">
        <label>
          <input type="checkbox" ${on ? 'checked' : ''} />
          <span>${on ? '已启用' : '启用'}</span>
        </label>
        <button type="button" class="skill-tile-delete" title="删除技能">删除</button>
      </div>`;
    const cb = tile.querySelector('input[type="checkbox"]');
    cb.addEventListener('click', (e) => {
      e.stopPropagation();
    });
    cb.addEventListener('change', (e) => {
      e.stopPropagation();
      const map = loadEnabledSkillIds();
      if (cb.checked) map[sk.id] = true;
      else map[sk.id] = false;
      saveEnabledSkillIds(map);
      renderSkillsList();
    });
    tile.querySelector('.skill-tile-foot')?.addEventListener('click', (e) => {
      e.stopPropagation();
    });
    tile.querySelector('.skill-tile-delete')?.addEventListener('click', (e) => {
      e.stopPropagation();
      deleteSkillItem(sk).catch(() => {});
    });
    const openDetail = () => openSkillDetail(sk).catch((err) => window.alert(err.message || String(err)));
    tile.addEventListener('click', openDetail);
    tile.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        openDetail();
      }
    });
    grid.appendChild(tile);
  }
  updateSkillsPagination(allVisible.length, pageCount);
  updateSkillsEnabledCount();
}
