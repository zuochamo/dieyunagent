/* global window, document, $, escapeHtml, gwState, gatewayCall, openSettingsShell, switchSettingsPage, refreshAutomationList, showMcpListView, showAgentToast, getEffectiveInputBudget, CTX_LIMITS */
'use strict';

var skillsApi = window.diecloud || {};

// 启用状态的权威存储**在 Main**（`src/skills/enabled-store.js`，经 IPC 读写）：频道 / 定时计划 /
// headless 那几档没有 Renderer，状态留在这里就等于那些轮次永远按默认值猜。
// 这个旧键只在首次加载时搬一次，搬完即删。
var SKILLS_ENABLED_LEGACY_KEY = 'diecloud.skills.enabled.v1';
var SKILLS_HIDDEN_KEY = 'diecloud.skills.hidden.v1';
var SKILLS_PAGE_SIZE = 15;
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

/**
 * 统一的分页条渲染（技能 / MCP / 定时 / 两个市场页共用这一份）。
 *
 * `opts`（都可省）说明"末页还能继续加载"这类差异，不再让每个页面各写一份：
 * - `loading`：加载中时把信息位换成「加载中…」并禁用两个按钮；
 * - `canLoadMore`：末页但服务端还有更多 —— 此时**必须**出现分页条并把「下一页」留着可点；
 * - `label`：信息位里的计数文案（默认「共 N 项」）。
 *
 * @param {string} prefix 分页条元素前缀（`${prefix}-pagination` / `-page-info` / `-page-prev` / `-page-next`）
 * @param {number} pageIndex
 * @param {number} pageCount
 * @param {number} total
 * @param {{ loading?: boolean, canLoadMore?: boolean, label?: string }} [opts]
 */
function updateGridPagination(prefix, pageIndex, pageCount, total, opts) {
  const o = opts && typeof opts === 'object' ? opts : {};
  const bar = $(`${prefix}-pagination`);
  const info = $(`${prefix}-page-info`);
  const prev = $(`${prefix}-page-prev`);
  const next = $(`${prefix}-page-next`);
  if (!bar) return;
  const loading = !!o.loading;
  const canLoadMore = !!o.canLoadMore;
  if (pageCount <= 1 && !canLoadMore) {
    bar.hidden = true;
    return;
  }
  bar.hidden = false;
  const label = o.label || `共 ${total} 项`;
  if (info) info.textContent = loading ? '加载中…' : `${pageIndex + 1} / ${pageCount}（${label}）`;
  if (prev) prev.disabled = loading || pageIndex <= 0;
  if (next) next.disabled = loading || (pageIndex >= pageCount - 1 && !canLoadMore);
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

/**
 * 绑「上一页 / 下一页」两个按钮（技能 / MCP / 定时 / 两个市场页共用）。
 *
 * `opts.onNext` / `opts.onPrev` 用来接管"末页要继续向后端加载"这种特例：
 * 返回 `true` 表示已自行处理（例如市场页会先 loadMore、再把索引推进一页），
 * 于是同一个 handler 既能翻本地页，也能触发服务端加载 —— 不必再各写一遍。
 *
 * @param {string} prefix
 * @param {() => number} getPageIndex
 * @param {(v: number) => void} setPageIndex
 * @param {() => void} onRefresh
 * @param {{ onNext?: () => boolean | Promise<boolean>, onPrev?: () => boolean | Promise<boolean> }} [opts]
 */
function bindGridPagination(prefix, getPageIndex, setPageIndex, onRefresh, opts) {
  const o = opts && typeof opts === 'object' ? opts : {};
  const prev = $(`${prefix}-page-prev`);
  const next = $(`${prefix}-page-next`);
  if (prev) {
    prev.addEventListener('click', async () => {
      if (typeof o.onPrev === 'function' && (await o.onPrev())) return;
      const idx = getPageIndex();
      if (idx > 0) {
        setPageIndex(idx - 1);
        onRefresh();
      }
    });
  }
  if (next) {
    next.addEventListener('click', async () => {
      if (typeof o.onNext === 'function' && (await o.onNext())) return;
      setPageIndex(getPageIndex() + 1);
      onRefresh();
    });
  }
}

/**
 * 目录类接口（技能市场 / MCP 市场）的返回形状解析 —— 唯一实现。
 *
 * 只有一个形状：`{ entries, hasMore, loadedCount, searchRemote, errors? }`。
 * 以前两边各有一份，还各自兼容「结果是数组」的旧形状（Main 早已只返回对象）。
 * @param {any} result
 */
function parseGridListResult(result) {
  const entries = Array.isArray(result && result.entries) ? result.entries : [];
  return {
    entries,
    hasMore: !!(result && result.hasMore),
    loadedCount: Number(result && result.loadedCount) || entries.length,
    searchRemote: !!(result && result.searchRemote),
    errors: Array.isArray(result && result.errors) ? result.errors : []
  };
}

/** 技能的页签 id：分类由 Main 的 `skills/taxonomy.js` 决定，这里只读不算。 */
function skillDomainId(skill) {
  const d = String((skill && skill.domain) || '');
  return skillsDomains().some((c) => c.id === d) ? d : SKILLS_DOMAIN_DEFAULT;
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

/** 扫描结果里 `defaultEnabled` 的取用索引（Main 算好的，不要在这里补一份前缀表）。 */
var skillsByIdIndex = null;

function resetSkillsByIdIndex() {
  skillsByIdIndex = null;
}

function skillDefaultEnabled(id) {
  const key = String(id || '');
  if (!key) return false;
  if (!skillsByIdIndex) {
    skillsByIdIndex = new Map();
    for (const sk of skillsCatalog.skills || []) skillsByIdIndex.set(sk.id, !!sk.defaultEnabled);
  }
  return skillsByIdIndex.get(key) === true;
}

function isSkillEnabled(map, id) {
  if (map && Object.prototype.hasOwnProperty.call(map, id)) return !!map[id];
  return skillDefaultEnabled(id);
}

/** 用户显式设置过的启用状态（Main 那份的本地镜像；同步读，界面渲染都靠它）。 */
var skillsEnabledMap = {};

function loadEnabledSkillIds() {
  return skillsEnabledMap;
}

/**
 * 从 Main 拉一次启用状态。首次运行会把旧版 localStorage 里的选择搬过去（一次性）。
 * @returns {Promise<Record<string, boolean>>}
 */
async function loadSkillsEnabledFromMain() {
  if (typeof skillsApi.getSkillsEnabled !== 'function') return skillsEnabledMap;
  let res = null;
  try {
    res = await skillsApi.getSkillsEnabled();
  } catch {
    return skillsEnabledMap;
  }
  skillsEnabledMap = res && res.enabled && typeof res.enabled === 'object' ? res.enabled : {};
  if (res && res.exists === false) await importLegacyEnabledSkills();
  return skillsEnabledMap;
}

/** 旧版 localStorage → Main 的一次性搬迁。只在 Main 还没有这份文件时发生。 */
async function importLegacyEnabledSkills() {
  let legacy = null;
  try {
    legacy = JSON.parse(window.localStorage.getItem(SKILLS_ENABLED_LEGACY_KEY) || 'null');
  } catch {
    legacy = null;
  }
  if (!legacy || typeof legacy !== 'object') return;
  for (const [id, on] of Object.entries(legacy)) {
    if (!id || Object.prototype.hasOwnProperty.call(skillsEnabledMap, id)) continue;
    try {
      const saved = await skillsApi.setSkillEnabled({ id, enabled: !!on });
      if (saved && saved.enabled && typeof saved.enabled === 'object') skillsEnabledMap = saved.enabled;
    } catch {
      // 单条搬不过去就跳过：默认规则兜底，不影响其余条目
    }
  }
  try {
    window.localStorage.removeItem(SKILLS_ENABLED_LEGACY_KEY);
  } catch {
    // ignore
  }
  window.dispatchEvent(new CustomEvent('dieyun:skills-enabled-change'));
}

/**
 * 改一条启用状态：先更新本地镜像（界面立刻跟手），再写 Main（那里的才是真相）。
 * @param {string} id
 * @param {boolean} on
 */
async function setSkillEnabledFlag(id, on) {
  const key = String(id || '');
  if (!key) return;
  skillsEnabledMap = { ...skillsEnabledMap, [key]: !!on };
  window.dispatchEvent(new CustomEvent('dieyun:skills-enabled-change'));
  if (typeof skillsApi.setSkillEnabled !== 'function') return;
  try {
    const saved = await skillsApi.setSkillEnabled({ id: key, enabled: !!on });
    if (saved && saved.enabled && typeof saved.enabled === 'object') {
      skillsEnabledMap = saved.enabled;
      window.dispatchEvent(new CustomEvent('dieyun:skills-enabled-change'));
    }
  } catch {
    // 写失败保留本地镜像：界面按用户点过的显示，下次刷新回到 Main 的真相
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
  // 分类页签的渲染/计数/点击只有一份实现（renderGridCategoryTabs）。
  renderGridCategoryTabs(
    $('skills-category-tabs'),
    skillsCategoryFilter,
    skillsDomains(),
    countSkillsInTaxonomy,
    (id) => {
      skillsCategoryFilter = id;
      skillsPageIndex = 0;
      renderSkillsCategoryTabs();
      renderSkillsList();
    }
  );
}

function updateSkillsPagination(total, pageCount) {
  updateGridPagination('skills', skillsPageIndex, pageCount, total);
}

async function deleteSkillItem(sk) {
  const label = sk.name || sk.id;
  // 可删性由 Main 侧的扫描结果下发（deletable），Renderer 不再自行用 builtin 推断
  const canDelete = sk.deletable !== false;
  const hint = canDelete ? '' : '\n（内置/预装技能将从列表隐藏，不会删除安装文件）';
  if (!window.confirm(`确定删除技能「${label}」？${hint}`)) {
    return;
  }
  // 删掉的技能不该留着启用状态（留着也只是脏数据，但会让「已启用 N 项」多算）
  await setSkillEnabledFlag(sk.id, false);
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
      setSkillEnabledFlag(sk.id, cb.checked).catch(() => {});
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
