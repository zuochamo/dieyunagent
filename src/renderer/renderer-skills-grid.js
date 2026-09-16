/* global window, document, $, escapeHtml, gwState, gatewayCall, openSettingsShell, switchSettingsPage, refreshAutomationList, showPluginListView, showMcpListView, loadPluginsUI, showAgentToast, getEffectiveInputBudget, CTX_LIMITS */
'use strict';

var skillsApi = window.diecloud || {};

var SKILLS_ENABLED_KEY = 'diecloud.skills.enabled.v1';
var SKILLS_HIDDEN_KEY = 'diecloud.skills.hidden.v1';
var SKILLS_PAGE_SIZE = 15;
var DEFAULT_ENABLED_SKILL_IDS = ['builtin:weather'];
var DEFAULT_ENABLED_SKILL_PREFIXES = ['builtin:minimax:', 'builtin:curated:'];
var MAX_SKILL_CHARS = typeof CTX_LIMITS !== 'undefined' ? CTX_LIMITS.SKILL_BODY_MAX : 3500;
var SKILL_INJECT_FULL = typeof CTX_LIMITS !== 'undefined' ? CTX_LIMITS.SKILL_FULL_COUNT : 3;
var SKILL_INJECT_TOTAL = typeof CTX_LIMITS !== 'undefined' ? CTX_LIMITS.SKILL_TOTAL_COUNT : 5;
var SKILLS_TAB_TITLES = { list: '技能', plugins: '插件', mcp: 'MCP', automation: '定时' };

/** 技能列表功能分类（「全部」单独一项；内置/预装技能按规则打散到下列分类） */
var SKILLS_TAXONOMY = [
  {
    id: 'dev',
    label: '开发工具',
    keywords: [
      'frontend',
      'fullstack',
      'full-stack',
      'android',
      'mobile',
      'graphics',
      'shader',
      'react',
      'flutter',
      'ios',
      '开发',
      '程序',
      'code',
      'debug',
      'git',
      'tmux',
      'test-runner',
      'security-auditor',
      'architecture',
      'supabase',
      'postgres',
      'opencode',
      'session-logs',
      '1password',
      'api',
      'web'
    ]
  },
  {
    id: 'office',
    label: '办公协同',
    keywords: [
      'document',
      'docx',
      'pdf',
      'xlsx',
      'pptx',
      'productivity',
      '办公',
      '文档',
      '表格',
      '幻灯片',
      'feishu',
      '飞书',
      '协同',
      'excel',
      '封皮',
      '打印',
      '提取',
      'drive',
      'cron-reminder',
      'screenshot',
      'send-file',
      'perm'
    ]
  },
  {
    id: 'life',
    label: '生活服务',
    keywords: ['weather', '生活', '天气', '出行', '健康', '便民', 'weather-china']
  },
  {
    id: 'content',
    label: '内容创作',
    keywords: [
      'creative',
      'music',
      'gif',
      '写作',
      'seo',
      'blog',
      'social',
      '内容',
      '文案',
      '视频',
      '设计',
      'media',
      'humanizer',
      'copywriting',
      'frontend-design',
      'ui-ux',
      'ffmpeg',
      'vision',
      'generate-image',
      'search-image',
      'content-strategy'
    ]
  },
  {
    id: 'efficiency',
    label: '效率工具',
    keywords: [
      'toolkit',
      'automation',
      'multimodal',
      '效率',
      '自动化',
      '助手',
      'agent',
      'vetter',
      'search-engine',
      'baidu-search',
      'find-skills',
      'skill-creator',
      'memory',
      'news-aggregator',
      'self-improving',
      'executing-plans',
      'writing-plans',
      'clawdefender',
      'websearch',
      'deepresearch',
      'open-link',
      'browser-agent',
      'controller'
    ]
  },
  {
    id: 'business',
    label: '商业运营',
    keywords: [
      'market',
      '商业',
      '运营',
      '营销',
      '销售',
      '投资',
      '理财',
      '增长',
      'stock',
      'backtest',
      'interview-designer',
      'content-strategy'
    ]
  },
  {
    id: 'edu',
    label: '教育学习',
    keywords: [
      '教育',
      '学习',
      'research',
      'academic',
      '论文',
      '课程',
      '培训',
      '考试',
      'aminer',
      'ontology',
      'brainstorming',
      'first-principles',
      'paper-writer'
    ]
  },
  {
    id: 'user',
    label: '用户添加',
    keywords: ['用户添加', 'builtin:user:', 'user:']
  }
];

var SKILLS_TAXONOMY_DEFAULT = 'efficiency';
var SKILLS_TAXONOMY_REMOVED = new Set(['minimax', 'curated', 'dieyun']);

/** MCP / 插件列表分组（与技能页相同的 Tab 风格） */
var MCP_TAXONOMY = [
  { id: 'dev', label: '开发工具' },
  { id: 'efficiency', label: '效率工具' },
  { id: 'user', label: '用户添加' }
];

var PLUGIN_TAXONOMY = [
  { id: 'integration', label: '集成通知' },
  { id: 'data', label: '数据存储' },
  { id: 'utility', label: '效率工具' },
  { id: 'user', label: '用户安装' }
];

var AUTOMATION_TAXONOMY = [
  { id: 'periodic', label: '周期' },
  { id: 'interval', label: '按间隔' },
  { id: 'once', label: '单次' },
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

function findTaxonomyById(catId) {
  return (
    SKILLS_TAXONOMY.find((c) => c.id === catId) ||
    SKILLS_TAXONOMY.find((c) => c.id === SKILLS_TAXONOMY_DEFAULT)
  );
}

function skillSearchHaystack(skill) {
  const cat = String(skill.category || '');
  const skipMetaCategory = cat.includes('用户预装') || cat.includes('预装精选');
  return [skill.id, skill.name, skill.description, skill.preview, skipMetaCategory ? '' : cat]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

/** 按技能 id/名称优先匹配（避免「用户预装」等元数据干扰关键词） */
function matchSkillTaxonomyByRules(skill) {
  const id = String(skill.id || '').toLowerCase();
  const name = String(skill.name || '').toLowerCase();
  const blob = `${id} ${name}`;

  if (id === 'builtin:weather' || /weather/.test(blob)) return 'life';
  if (id.includes('builtin:user:') || String(skill.category || '').includes('用户添加')) return 'user';

  if (/minimax:(minimax-docx|minimax-pdf|minimax-xlsx|pptx-generator)/.test(id)) return 'office';
  if (/minimax:(frontend-dev|fullstack-dev|android-native-dev)/.test(id)) return 'dev';
  if (/minimax:(minimax-music-gen|vision-analysis)/.test(id)) return 'content';
  if (/minimax:minimax-multimodal-toolkit/.test(id)) return 'efficiency';

  if (/curated:(weather-china|baidu-search)/.test(id)) return id.includes('weather') ? 'life' : 'efficiency';
  if (/curated:(skill-vetter|multi-search-engine|skill-creator)/.test(id)) return 'efficiency';

  if (/feishu|excel|xlsx|docx|pdf|pptx|封皮|打印|提取|drive|cron-reminder|screenshot|send-file|perm/.test(blob)) {
    return 'office';
  }
  if (
    /git|debug|test-runner|tmux|code-|security-auditor|architecture|supabase|postgres|opencode|session-logs|1password/.test(
      blob
    )
  ) {
    return 'dev';
  }
  if (
    /blog|seo|copywriting|social|video|ffmpeg|frontend-design|humanizer|autoglm|generate-image|search-image|ui-ux/.test(
      blob
    )
  ) {
    return 'content';
  }
  if (/stock|market|backtest|interview/.test(blob)) return 'business';
  if (/aminer|research-paper|ontology|brainstorming|first-principles|paper-writer|deepresearch/.test(blob)) {
    return 'edu';
  }
  if (
    /vetter|search-engine|find-skills|skill-creator|memory|automation|news|self-improving|executing-plans|writing-plans|clawdefender|agent-self|websearch|open-link|browser-agent|controller/.test(
      blob
    )
  ) {
    return 'efficiency';
  }

  return null;
}

function resolveSkillTaxonomy(skill) {
  const ruled = matchSkillTaxonomyByRules(skill);
  if (ruled) return findTaxonomyById(ruled);

  const hay = skillSearchHaystack(skill);
  for (const cat of SKILLS_TAXONOMY) {
    if (cat.keywords.some((kw) => hay.includes(String(kw).toLowerCase()))) {
      return cat;
    }
  }
  return findTaxonomyById(SKILLS_TAXONOMY_DEFAULT);
}

function normalizeSkillsCategoryFilter() {
  if (skillsCategoryFilter !== 'all' && SKILLS_TAXONOMY_REMOVED.has(skillsCategoryFilter)) {
    skillsCategoryFilter = 'all';
  }
  if (
    skillsCategoryFilter !== 'all' &&
    !SKILLS_TAXONOMY.some((c) => c.id === skillsCategoryFilter)
  ) {
    skillsCategoryFilter = 'all';
  }
}

function getSkillTaxonomyLabel(skill) {
  return resolveSkillTaxonomy(skill).label;
}

var skillsCatalog = { skills: [], roots: [] };
var skillsCategoryFilter = 'all';
var skillsSearchQuery = '';
var skillsPageIndex = 0;

var mcpServersCache = [];
var mcpCategoryFilter = 'all';
var mcpSearchQuery = '';
var mcpPageIndex = 0;

function resolveMcpCategory(server) {
  if (!server || server.builtin === false) return 'user';
  const blob = `${server.id || ''} ${server.name || ''} ${server.description || ''}`.toLowerCase();
  if (/playwright|github|context7/.test(blob)) return 'dev';
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
  if (skillsTab === 'plugins') {
    showPluginListView();
    if (typeof renderPluginCategoryTabs === 'function') renderPluginCategoryTabs();
    loadPluginsUI().catch(() => {});
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
    (sk) => !hidden[sk.id] && isSkillEnabled(map, sk.id)
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

function getSortedVisibleSkills() {
  const enabled = loadEnabledSkillIds();
  const hidden = loadHiddenSkillIds();
  const q = skillsSearchQuery.trim().toLowerCase();
  let skills = (skillsCatalog.skills || []).filter((sk) => !hidden[sk.id]);
  if (skillsCategoryFilter !== 'all') {
    skills = skills.filter((sk) => resolveSkillTaxonomy(sk).id === skillsCategoryFilter);
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
    if (hidden[sk.id]) return false;
    if (taxonomyId === 'all') return true;
    return resolveSkillTaxonomy(sk).id === taxonomyId;
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
  for (const cat of SKILLS_TAXONOMY) {
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
  if (!window.confirm(`确定删除技能「${label}」？${sk.builtin ? '\n（内置技能将从列表隐藏，不会删除安装文件）' : ''}`)) {
    return;
  }
  const enabled = loadEnabledSkillIds();
  delete enabled[sk.id];
  saveEnabledSkillIds(enabled);
  if (sk.builtin) {
    const hidden = loadHiddenSkillIds();
    hidden[sk.id] = true;
    saveHiddenSkillIds(hidden);
  } else if (skillsApi.deleteSkill) {
    try {
      await skillsApi.deleteSkill({ dir: sk.dir });
    } catch (err) {
      window.alert(`删除失败：${err.message || err}`);
      return;
    }
  }
  await refreshSkillsCatalog();
}

function renderSkillsList() {
  const grid = $('skills-grid');
  if (!grid) return;
  const enabled = loadEnabledSkillIds();
  const allVisible = getSortedVisibleSkills();
  const totalAll = (skillsCatalog.skills || []).filter((sk) => !loadHiddenSkillIds()[sk.id]).length;
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
      <p class="skill-tile-hint">点击查看完整介绍</p>
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
