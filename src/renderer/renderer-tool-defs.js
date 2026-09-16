/* global window, $, fetch, escapeHtml, gwState, gatewayCall, loadEnabledSkillIds, showAgentToast, getAgentsMdMode, CTX_LIMITS, openDatabaseSettingsModal, openPluginDetail, openPluginSchemaSettings, renderGridCategoryTabs, updateGridPagination, bindGridSearchInput, bindGridPagination, PLUGIN_TAXONOMY, SKILLS_GRID_PAGE_SIZE */
const toolDefsApi = window.diecloud || {};

const EXPLORE_TOOL_NAMES = new Set([
  'fs_read_file',
  'fs_list_dir',
  'grep',
  'glob',
  'read_symbol',
  'lsp',
  'sql_list_databases',
  'sql_list_tables',
  'sql_query',
  'web_fetch',
  'web_search',
  'browser_snapshot',
  'browser_a11y_snapshot',
  'browser_network',
  'browser_console',
  'browser_expect',
  'browser_observe',
  'browser_wait_for',
  'browser_status'
]);
// browser_screenshot 支持 filePath 落盘（写文件），不属于纯只读；Explore 看图用 browser_observe。

function buildExploreTools(allTools) {
  return (allTools || []).filter((t) => {
    const name = t?.function?.name;
    return name && EXPLORE_TOOL_NAMES.has(name);
  });
}

const SHELL_TOOL_NAMES = new Set([
  'host_exec',
  'fs_read_file',
  'fs_list_dir',
  'grep',
  'glob',
  'read_symbol',
  'lsp',
  'sql_list_databases',
  'sql_list_tables',
  'sql_query'
]);

function buildShellTools(allTools) {
  return (allTools || []).filter((t) => {
    const name = t?.function?.name;
    return name && SHELL_TOOL_NAMES.has(name);
  });
}

function buildBuildTools(allTools) {
  return allTools || [];
}

let sqlStatusCache = null;

function formatPluginInstallHint(result) {
  if (!result || typeof result !== 'object') return '已安装';
  const action = result.action || 'install';
  const version = result.version ? ` v${result.version}` : '';
  if (action === 'upgrade') return `已更新${version}`;
  if (action === 'reinstall') return `已重新安装${version}`;
  return `已安装${version}`;
}

async function installPluginRpc(method, params) {
  try {
    return await gatewayCall(method, params);
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    if (msg.includes('低于已安装')) {
      const ok = window.confirm(`${msg}\n\n仍要覆盖安装吗？`);
      if (!ok) throw err;
      return gatewayCall(method, { ...params, allowDowngrade: true });
    }
    throw err;
  }
}

const PLUGIN_PAGE_SIZE = typeof SKILLS_GRID_PAGE_SIZE === 'number' ? SKILLS_GRID_PAGE_SIZE : 15;
const PLUGIN_TAXONOMY_LIST = Array.isArray(PLUGIN_TAXONOMY)
  ? PLUGIN_TAXONOMY
  : [
      { id: 'integration', label: '集成通知' },
      { id: 'data', label: '数据存储' },
      { id: 'utility', label: '效率工具' },
      { id: 'user', label: '用户安装' }
    ];

let pluginsListCache = [];
let pluginCategoryFilter = 'all';
let pluginSearchQuery = '';
let pluginPageIndex = 0;

function resolvePluginCategory(plugin) {
  if (!plugin) return 'utility';
  if (plugin.source === 'user') return 'user';
  const id = String(plugin.id || '').toLowerCase();
  const cat = String(plugin.category || 'general').toLowerCase();
  if (cat === 'data' || /database|sql/.test(id)) return 'data';
  if (cat === 'integration' || /webhook|feishu|dingtalk|http|bot|notify/.test(id)) return 'integration';
  return 'utility';
}

function pluginSearchHaystack(plugin) {
  return [plugin.id, plugin.name, plugin.description, plugin.category, plugin.version, plugin.source]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

function getFilteredPlugins() {
  const q = pluginSearchQuery.trim().toLowerCase();
  let list = pluginsListCache.slice();
  if (pluginCategoryFilter !== 'all') {
    list = list.filter((p) => resolvePluginCategory(p) === pluginCategoryFilter);
  }
  if (q) {
    list = list.filter((p) => pluginSearchHaystack(p).includes(q));
  }
  list.sort((a, b) => {
    const ea = a.enabled ? 1 : 0;
    const eb = b.enabled ? 1 : 0;
    if (eb !== ea) return eb - ea;
    return String(a.name || a.id).localeCompare(String(b.name || b.id), 'zh-CN');
  });
  return list;
}

function countPluginsInCategory(catId) {
  if (catId === 'all') return pluginsListCache.length;
  return pluginsListCache.filter((p) => resolvePluginCategory(p) === catId).length;
}

function renderPluginCategoryTabs() {
  if (typeof renderGridCategoryTabs !== 'function') return;
  renderGridCategoryTabs(
    $('plugin-category-tabs'),
    pluginCategoryFilter,
    PLUGIN_TAXONOMY_LIST,
    countPluginsInCategory,
    (id) => {
      pluginCategoryFilter = id;
      pluginPageIndex = 0;
      renderPluginCategoryTabs();
      loadPluginsUI().catch(() => {});
    }
  );
}

function wirePluginTileEvents(grid) {
  grid.querySelectorAll('.plugin-tile').forEach((tile) => {
    const hasSettings = tile.dataset.pluginHasSettings === '1';
    const pluginId = tile.dataset.pluginId || '';
    const pluginName = tile.dataset.pluginName || pluginId;

    tile.querySelector('.skill-tile-foot')?.addEventListener('click', (e) => {
      e.stopPropagation();
    });

    if (hasSettings) {
      tile.setAttribute('role', 'button');
      tile.tabIndex = 0;
      tile.title = '点击打开设置';
      const openSettings = () => {
        if (typeof openPluginDetail === 'function') {
          openPluginDetail({
            id: pluginId,
            name: pluginName,
            description: tile.dataset.pluginDescription || '',
            installPath: tile.dataset.pluginInstallPath || ''
          });
        } else if (pluginId === 'builtin.database') {
          openDatabaseSettingsModal('settings');
        } else if (typeof openPluginSchemaSettings === 'function') {
          openPluginSchemaSettings(pluginId, pluginName);
        }
      };
      tile.addEventListener('click', openSettings);
      tile.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          openSettings();
        }
      });
    }
  });

  grid.querySelectorAll('[data-plugin-enable-cb]').forEach((cb) => {
    cb.addEventListener('change', async (e) => {
      e.stopPropagation();
      const id = cb.dataset.pluginEnableCb;
      if (!id || !gwState.authed) return;
      cb.disabled = true;
      try {
        await gatewayCall('plugins.set_enabled', { id, enabled: cb.checked });
        if (id === 'builtin.database') {
          sqlStatusCache = null;
          if (typeof loadSqlConfigUI === 'function') loadSqlConfigUI().catch(() => {});
        }
        await loadPluginsUI();
      } catch (err) {
        cb.disabled = false;
        cb.checked = !cb.checked;
        showAgentToast('插件设置失败', err.message || String(err), { variant: 'error' });
      }
    });
  });
}

function renderPluginTileHtml(p) {
  const on = !!p.enabled;
  const sourceLabel = p.source === 'user' ? '用户' : '内置';
  const deleteLabel = p.source === 'user' ? '卸载' : '删除';
  const hasSettings = p.id === 'builtin.database' || !!p.hasSettings;
  const hintText = hasSettings ? '点击打开设置' : `${p.category || 'general'} · ${sourceLabel}`;
  return `<article class="skill-tile plugin-tile${on ? ' enabled' : ''}${hasSettings ? ' plugin-tile-clickable' : ''}" data-plugin-id="${escapeHtml(p.id)}" data-plugin-name="${escapeHtml(p.name || p.id)}" data-plugin-description="${escapeHtml(p.description || '')}" data-plugin-install-path="${escapeHtml(p.installPath || '')}" data-plugin-has-settings="${hasSettings ? '1' : '0'}">
    <div class="skill-tile-head">
      <div class="skill-tile-title">${escapeHtml(p.name || p.id)}</div>
      <span class="skill-tile-tag">v${escapeHtml(p.version || '1.0.0')}</span>
    </div>
    <p class="skill-tile-desc">${escapeHtml(p.description || '暂无简介')}</p>
    <p class="skill-tile-hint">${escapeHtml(hintText)}</p>
    <div class="skill-tile-foot">
      <label>
        <input type="checkbox" data-plugin-enable-cb="${escapeHtml(p.id)}" ${on ? 'checked' : ''} />
        <span>${on ? '已启用' : '启用'}</span>
      </label>
      <button type="button" class="skill-tile-delete plugin-btn-danger" data-plugin-remove="${escapeHtml(p.id)}" data-plugin-name="${escapeHtml(p.name || p.id)}" data-plugin-source="${escapeHtml(p.source || 'builtin')}">${deleteLabel}</button>
    </div>
  </article>`;
}

async function loadPluginsUI() {
  const grid = $('plugin-list');
  if (!grid) return;
  if (!gwState.authed) {
    grid.innerHTML = '<p class="skills-empty">Gateway 未连接</p>';
    if (typeof updateGridPagination === 'function') updateGridPagination('plugin', 0, 0, 0);
    return;
  }
  if (!pluginsListCache.length) {
    grid.innerHTML = '<p class="skills-empty">加载中…</p>';
  }
  try {
    pluginsListCache = await gatewayCall('plugins.list', {});
    if (!Array.isArray(pluginsListCache)) pluginsListCache = [];
    renderPluginCategoryTabs();
    if (!pluginsListCache.length) {
      grid.innerHTML =
        '<p class="skills-empty">暂无插件。点击「添加」选择本地插件目录，或打开「市场」从目录安装</p>';
      if (typeof updateGridPagination === 'function') updateGridPagination('plugin', 0, 0, 0);
      return;
    }
    const visible = getFilteredPlugins();
    if (!visible.length) {
      const hint = pluginSearchQuery.trim()
        ? '没有匹配的插件，请调整搜索或分类'
        : '当前分类下暂无插件';
      grid.innerHTML = `<p class="skills-empty">${escapeHtml(hint)}</p>`;
      if (typeof updateGridPagination === 'function') updateGridPagination('plugin', 0, 0, 0);
      return;
    }
    const pageCount = Math.max(1, Math.ceil(visible.length / PLUGIN_PAGE_SIZE));
    if (pluginPageIndex >= pageCount) pluginPageIndex = pageCount - 1;
    if (pluginPageIndex < 0) pluginPageIndex = 0;
    const slice = visible.slice(
      pluginPageIndex * PLUGIN_PAGE_SIZE,
      pluginPageIndex * PLUGIN_PAGE_SIZE + PLUGIN_PAGE_SIZE
    );
    grid.innerHTML = slice.map((p) => renderPluginTileHtml(p)).join('');
    wirePluginTileEvents(grid);
    if (typeof updateGridPagination === 'function') {
      updateGridPagination('plugin', pluginPageIndex, pageCount, visible.length);
    }
  } catch (e) {
    grid.innerHTML = `<p class="skills-empty">加载失败：${escapeHtml(e.message || e)}</p>`;
    if (typeof updateGridPagination === 'function') updateGridPagination('plugin', 0, 0, 0);
  }
}

function initPluginListFilters() {
  if (typeof bindGridSearchInput === 'function') {
    bindGridSearchInput(
      'plugin-search',
      () => pluginSearchQuery,
      (v) => {
        pluginSearchQuery = v;
      },
      () => pluginPageIndex,
      (v) => {
        pluginPageIndex = v;
      },
      () => loadPluginsUI().catch(() => {})
    );
  }
  if (typeof bindGridPagination === 'function') {
    bindGridPagination(
      'plugin',
      () => pluginPageIndex,
      (v) => {
        pluginPageIndex = v;
      },
      () => loadPluginsUI().catch(() => {})
    );
  }
}

document.addEventListener('click', async (e) => {
  const removeBtn = e.target && e.target.closest ? e.target.closest('[data-plugin-remove]') : null;
  if (!removeBtn) return;
  e.preventDefault();
  e.stopPropagation();
  if (!gwState.authed) return;
  const removeId = removeBtn.dataset.pluginRemove;
  const removeName = removeBtn.dataset.pluginName || removeId;
  const removeSource = removeBtn.dataset.pluginSource || 'builtin';
  const confirmMsg =
    removeSource === 'user'
      ? `确定卸载插件「${removeName}」？\n将从本机删除插件文件。`
      : `确定删除插件「${removeName}」？\n将从列表隐藏并停用。`;
  if (!window.confirm(confirmMsg)) {
    return;
  }
  removeBtn.disabled = true;
  try {
    if (removeSource === 'user') {
      await gatewayCall('plugins.uninstall', { id: removeId });
    } else {
      await gatewayCall('plugins.remove', { id: removeId });
    }
    if (removeId === 'builtin.database') {
      sqlStatusCache = null;
    }
    await loadPluginsUI();
  } catch (err) {
    removeBtn.disabled = false;
    showAgentToast('删除插件失败', err.message || String(err), { variant: 'error' });
  }
});

const _tc = typeof DieyunToolCatalog !== 'undefined' ? DieyunToolCatalog : {};
const HOST_TOOLS = _tc.HOST_TOOLS || [];
const WEB_TOOLS = _tc.WEB_TOOLS || [];
const BROWSER_TOOLS = _tc.BROWSER_TOOLS || [];
const CODEBASE_TOOL = _tc.CODEBASE_TOOL;
const GREP_TOOL = _tc.GREP_TOOL;
const GLOB_TOOL = _tc.GLOB_TOOL;
const READ_SYMBOL_TOOL = _tc.READ_SYMBOL_TOOL;
const LSP_TOOL = _tc.LSP_TOOL;
const GRAPH_TOOL = _tc.GRAPH_TOOL;
const PLAYBOOK_PROPOSE_TOOL = _tc.PLAYBOOK_PROPOSE_TOOL;
const AGENTS_MD_PROPOSE_TOOL = _tc.AGENTS_MD_PROPOSE_TOOL;
const SKILL_CREATE_TOOL = _tc.SKILL_CREATE_TOOL;
const PLAN_TOOLS = _tc.PLAN_TOOLS || [];
const MCP_TOOL_SCHEMA_TOOL = _tc.MCP_TOOL_SCHEMA_TOOL;
const CLARIFY_TOOL = _tc.CLARIFY_TOOL;
const isWeakToolCallerModel = _tc.isWeakToolCallerModel || function () { return false; };
const compactMcpToolDef = _tc.compactMcpToolDef || function (entry) { return entry && entry.tool; };

function setSqlHint(text) {
  const el = $('plugin-detail-hint') || $('sql-hint');
  if (!el) return;
  el.textContent = text || '';
  if (text) {
    el.classList.add('show');
    setTimeout(() => el.classList.remove('show'), 2500);
  }
}

function renderSqlDbList(databases, extra) {
  const el = $('sql-db-list');
  if (!el) return;
  if (!databases || !databases.length) {
    el.textContent = extra || '（无数据库或无权限）';
    return;
  }
  el.textContent = `共 ${databases.length} 个数据库：\n${databases.join('\n')}`;
}

function readSqlForm() {
  return {
    enabled: $('sql-enabled')?.checked !== false,
    host: ($('sql-host')?.value || '').trim(),
    port: Number($('sql-port')?.value) || 1433,
    user: ($('sql-user')?.value || '').trim(),
    password: $('sql-password')?.value || '',
    maxRows: Number($('sql-max-rows')?.value) || 500
  };
}

function applySqlForm(cfg) {
  if (!cfg) return;
  if ($('sql-enabled')) $('sql-enabled').checked = !!cfg.enabled;
  if ($('sql-host')) $('sql-host').value = cfg.host || '';
  if ($('sql-port')) $('sql-port').value = cfg.port || 1433;
  if ($('sql-user')) $('sql-user').value = cfg.user || '';
  if ($('sql-max-rows')) $('sql-max-rows').value = cfg.maxRows || 500;
  if (cfg.databases && cfg.databases.length) renderSqlDbList(cfg.databases);
}

async function loadSqlConfigUI() {
  if (!gwState.authed) return;
  try {
    const cfg = await gatewayCall('sql.config_get', {});
    sqlStatusCache = cfg;
    applySqlForm(cfg);
  } catch {
    // ignore
  }
}

async function saveSqlConfig() {
  if (!gwState.authed) {
    setSqlHint('Gateway 未连接');
    return;
  }
  try {
    const patch = readSqlForm();
    const saved = await gatewayCall('sql.config_set', patch);
    sqlStatusCache = saved;
    setSqlHint('配置已保存 ✓');
  } catch (err) {
    setSqlHint(`保存失败：${err.message || err}`);
  }
}

async function testSqlConnection() {
  if (!gwState.authed) {
    setSqlHint('Gateway 未连接');
    return;
  }
  const listEl = $('sql-db-list');
  if (listEl) listEl.textContent = '正在连接…';
  try {
    await saveSqlConfig();
    const r = await gatewayCall('sql.test', {});
    sqlStatusCache = { ...sqlStatusCache, databases: r.databases, lastTestOk: true };
    renderSqlDbList(r.databases, `连接成功\n${(r.version || '').split('\n')[0]}`);
    setSqlHint('连接成功 ✓');
  } catch (err) {
    if (listEl) listEl.textContent = `连接失败：${err.message || err}`;
    setSqlHint(`失败：${err.message || err}`);
  }
}

async function loadPluginToolsForAgent() {
  if (!gwState.authed) return [];
  try {
    const tools = await gatewayCall('plugins.list_tools', {});
    if (!Array.isArray(tools) || !tools.length) return [];
    const p = await toolDefsApi.getPermissions();
    if (p && p.sqlRead === false) {
      return tools.filter((t) => !String(t?.function?.name || '').startsWith('sql_'));
    }
    return tools;
  } catch {
    return [];
  }
}

async function getHostToolFlags() {
  if (!gwState.authed || !toolDefsApi.getPermissions) {
    return { openUrl: false, exec: false, fsRead: false, fsWrite: false, webFetch: false, browser: false };
  }
  try {
    const p = await toolDefsApi.getPermissions();
    const webFetch = p?.webFetch !== false;
    const browser = p?.browserAutomation !== false;
    if (!p || !p.hostControl) {
      return {
        openUrl: false,
        exec: false,
        fsRead: false,
        fsWrite: false,
        webFetch,
        browser: false,
        hostControl: false
      };
    }
    return {
      hostControl: true,
      openUrl: true,
      exec: !!p.shellExec,
      fsRead: !!p.fsRead,
      fsWrite: !!p.fsWrite,
      webFetch,
      browser
    };
  } catch {
    return { openUrl: false, exec: false, fsRead: false, fsWrite: false, webFetch: false, browser: false };
  }
}

function hostToolByName(name) {
  return HOST_TOOLS.find((t) => t && t.function && t.function.name === name);
}

async function shouldExposeGraphTools() {
  if (!gwState.authed) return false;
  return true;
}

function pushGraphTools(tools) {
  if (GRAPH_TOOL) tools.push(GRAPH_TOOL);
}

async function buildAgentTools(userQuery = '', opts = {}) {
  if (opts.signal?.aborted) {
    const err = new Error('已停止');
    err.name = 'AbortError';
    throw err;
  }
  const prepSid = opts.prepSessionId ? String(opts.prepSessionId) : '';
  if (prepSid && typeof agentPrepStepStart === 'function') agentPrepStepStart(prepSid, 'tools');
  try {
  const tools = [];
  const weakModel = isWeakToolCallerModel(opts.model);
  const host = await getHostToolFlags();
  if (host.openUrl) tools.push(hostToolByName('host_open_url'));
  if (host.exec) {
    tools.push(hostToolByName('host_print_image'));
    tools.push(hostToolByName('host_exec'));
  }
  if (host.fsRead) {
    tools.push(hostToolByName('fs_read_file'));
    tools.push(hostToolByName('fs_list_dir'));
    tools.push(GREP_TOOL);
    tools.push(GLOB_TOOL);
    tools.push(READ_SYMBOL_TOOL);
    tools.push(LSP_TOOL);
  }
  if (host.fsWrite) {
    tools.push(hostToolByName('fs_edit'));
    tools.push(hostToolByName('fs_write_file'));
  }
  if (host.fsWrite && getAgentsMdMode() !== 'off') tools.push(AGENTS_MD_PROPOSE_TOOL);
  if (host.fsWrite) tools.push(PLAYBOOK_PROPOSE_TOOL);
  if (host.hostControl) tools.push(SKILL_CREATE_TOOL);
  if (host.webFetch) tools.push(...WEB_TOOLS);
  if (host.browser && !weakModel) tools.push(...BROWSER_TOOLS);
  else if (host.browser && weakModel) {
    const weakBrowser = new Set(['browser_navigate', 'browser_snapshot', 'browser_a11y_snapshot', 'browser_network', 'browser_console', 'browser_observe', 'browser_status', 'browser_close']);
    tools.push(...BROWSER_TOOLS.filter((t) => weakBrowser.has(t.function.name)));
  }
  if (gwState.authed) {
    tools.push(CODEBASE_TOOL);
    if (await shouldExposeGraphTools()) pushGraphTools(tools);
  }
  tools.push(...(await loadPluginToolsForAgent()));
  tools.push(...PLAN_TOOLS);
  tools.push(CLARIFY_TOOL);

  const optionalEntries = [];

  const mcpApi = window.diecloud || {};
  const toolRecallLimit =
    typeof CTX_LIMITS !== 'undefined' && CTX_LIMITS.TOOL_RECALL_LIMIT
      ? CTX_LIMITS.TOOL_RECALL_LIMIT
      : 10;
  const effectiveRecallLimit = weakModel ? Math.min(5, toolRecallLimit) : toolRecallLimit;
  let mcpCatalogTools = [];
  let enabledMcpIds = new Set();

  if (mcpApi.getMcpRuntimeTools) {
    try {
      if (mcpApi.listMcpServers) {
        const servers = await mcpApi.listMcpServers();
        enabledMcpIds = new Set(
          (servers || []).filter((s) => s && s.enabled).map((s) => String(s.id))
        );
      }
      const catalog = await Promise.race([
        mcpApi.getMcpRuntimeTools({ catalogOnly: true }),
        new Promise((_, reject) => {
          setTimeout(() => reject(new Error('MCP 目录读取超时')), 8000);
        })
      ]);
      mcpCatalogTools = (catalog.tools || []).filter((item) =>
        enabledMcpIds.size ? enabledMcpIds.has(String(item.serverId)) : true
      );
      for (const item of mcpCatalogTools) {
        optionalEntries.push({
          id: item.agentName,
          tool: {
            type: 'function',
            function: {
              name: item.agentName,
              description: `[MCP · ${item.serverId}] ${item.description || item.toolName}`,
              parameters:
                item.inputSchema && typeof item.inputSchema === 'object'
                  ? item.inputSchema
                  : { type: 'object', properties: {} }
            }
          },
          candidate: {
            id: item.agentName,
            name: item.agentName,
            description: `[MCP · ${item.serverId}] ${item.description || item.toolName}`,
            source: 'mcp',
            serverId: item.serverId || ''
          }
        });
      }
    } catch {
      // MCP 连接失败时不阻塞其它工具
    }
  }

  let selectedOptional = optionalEntries;
  if (optionalEntries.length > effectiveRecallLimit && typeof mcpApi.recallAgentTools === 'function') {
    try {
      const recalled = await mcpApi.recallAgentTools({
        query: String(userQuery || ''),
        limit: effectiveRecallLimit,
        candidates: optionalEntries.map((entry) => entry.candidate)
      });
      const picked = new Set((recalled.tools || []).map((row) => row.id));
      if (picked.size) {
        selectedOptional = optionalEntries.filter((entry) => picked.has(entry.id));
      } else {
        selectedOptional = optionalEntries.slice(0, effectiveRecallLimit);
      }
    } catch {
      selectedOptional = optionalEntries.slice(0, effectiveRecallLimit);
    }
  } else if (optionalEntries.length > effectiveRecallLimit) {
    selectedOptional = optionalEntries.slice(0, effectiveRecallLimit);
  }

  const hasMcpOptional = selectedOptional.some((e) => e.candidate && e.candidate.source === 'mcp');
  if (hasMcpOptional) {
    tools.push(MCP_TOOL_SCHEMA_TOOL);
  }

  for (const entry of selectedOptional) {
    if (entry.candidate && entry.candidate.source === 'mcp' && hasMcpOptional) {
      tools.push(compactMcpToolDef(entry));
    } else {
      tools.push(entry.tool);
    }
  }
  return tools;
  } finally {
    if (prepSid && typeof agentPrepStepDone === 'function') agentPrepStepDone(prepSid, 'tools');
  }
}

function initSqlSettingsUI() {
  const btnRefreshList = $('sql-refresh-list');
  if (btnRefreshList) {
    btnRefreshList.addEventListener('click', async () => {
      if (sqlStatusCache && sqlStatusCache.databases && sqlStatusCache.databases.length) {
        renderSqlDbList(sqlStatusCache.databases);
        return;
      }
      await testSqlConnection();
    });
  }

  if (typeof initPluginDetailOverlay === 'function') initPluginDetailOverlay();

  const pluginAddBtn = $('plugin-add-btn');
  if (pluginAddBtn) {
    pluginAddBtn.addEventListener('click', async () => {
      const hint = $('plugin-install-hint');
      const api = window.diecloud || {};
      if (!api.pickFolder) {
        if (hint) hint.textContent = '当前环境无法选择文件夹';
        return;
      }
      if (!gwState.authed) {
        if (hint) hint.textContent = 'Gateway 未连接';
        return;
      }
      const folder = await api.pickFolder();
      if (!folder) return;
      if (hint) hint.textContent = '安装中…';
      pluginAddBtn.disabled = true;
      try {
        const result = await installPluginRpc('plugins.install_from_path', { sourcePath: folder });
        if (hint) hint.textContent = formatPluginInstallHint(result);
        await loadPluginsUI();
      } catch (err) {
        if (hint) hint.textContent = `失败：${err.message || err}`;
      } finally {
        pluginAddBtn.disabled = false;
      }
    });
  }
}

window.isWeakToolCallerModel = isWeakToolCallerModel;
window.formatPluginInstallHint = formatPluginInstallHint;
window.installPluginRpc = installPluginRpc;
window.loadPluginsUI = loadPluginsUI;
window.renderPluginCategoryTabs = renderPluginCategoryTabs;
window.initPluginListFilters = initPluginListFilters;
