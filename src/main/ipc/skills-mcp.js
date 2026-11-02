'use strict';

const path = require('path');
const fsp = require('fs/promises');
const { scanSkills, readSkillContent, assertReadableSkillPath } = require('../../skills/scanner');
const { recallSkills } = require('../../skills/vector-index');
const { readSkillUsage, usageFor } = require('../../skills/usage-ledger');
const { recallAgentTools } = require('../../tools/tool-vector-index');
const { getEmbeddingConfig } = require('../../model-settings');
const {
  createUserSkill,
  describeAgentHome,
  getScanRoots,
  filterAccessibleSkillRoots,
  evaluateSkillDeletable
} = require('../../agent-home');

/**
 * @param {object} ctx
 */
function registerSkillsMcpIpc(ctx) {
  const {
    ipcMain,
    getLocalGateway,
    getUserDataPath,
    loadModelSettings,
    getMcpCatalog,
    getMcpRuntime,
    mcpManager,
    getSkillCatalog,
    listMcpServersForUi,
    deleteMcpServer,
    addMcpServer,
    setMcpServerEnabled,
    getMcpServerConfigForUi,
    updateMcpServerConfig,
    checkMcpServerUpdate,
    installMcpServerPackage,
    repairMcpEnvironment,
    upgradeMcpServerPackage,
    notifySkillsCatalogChanged,
    isWorkplaceMonitorEnabled,
    applyWorkplaceMonitorEnabled
  } = ctx;

  ipcMain.handle('skills:scan', async () => {
    const localGateway = getLocalGateway();
    const userData = getUserDataPath();
    const workspacePath = localGateway ? localGateway.getWorkspace().workspacePath : null;
    const catalog = await scanSkills({ userData, workspacePath });
    // 把使用账本并进扫描结果：技能列表要回答「这个技能到底有没有在用」，
    // 而账本记的是「模型读过 SKILL.md」这件事（见 skills/usage-ledger.js）。
    const usage = await readSkillUsage(userData);
    return {
      ...catalog,
      skills: (catalog.skills || []).map((skill) => {
        const entry = usageFor(usage, skill.skillPath);
        return entry
          ? { ...skill, lastUsedAt: entry.lastAt || 0, useCount: entry.count || 0 }
          : skill;
      })
    };
  });

  ipcMain.handle('skills:recall', async (_evt, payload) => {
    const localGateway = getLocalGateway();
    const userData = getUserDataPath();
    const workspacePath = localGateway ? localGateway.getWorkspace().workspacePath : null;
    const settings = loadModelSettings(userData);
    const embeddingConfig = getEmbeddingConfig(settings);
    return recallSkills({
      userData,
      workspacePath,
      embeddingConfig,
      enabledIds: Array.isArray(payload?.enabledIds) ? payload.enabledIds : [],
      query: payload?.query || '',
      limit: payload?.limit || 8
    });
  });

  ipcMain.handle('mcp:catalog-list', async (_evt, payload) => {
    const mcpCatalog = getMcpCatalog();
    if (!mcpCatalog) return { entries: [], hasMore: false, loadedCount: 0, errors: [] };
    return mcpCatalog.listEntries({
      forceRemote: !!(payload && payload.refresh),
      loadMore: !!(payload && payload.loadMore),
      search: payload && payload.search != null ? String(payload.search) : ''
    });
  });

  ipcMain.handle('mcp:catalog-install', async (_evt, payload) => {
    const mcpCatalog = getMcpCatalog();
    if (!mcpCatalog) throw new Error('MCP 目录未就绪');
    const result = await mcpCatalog.install(String((payload && payload.id) || ''));
    await mcpManager.reload();
    return result;
  });

  ipcMain.handle('mcp:catalog-sources-get', () => {
    const mcpCatalog = getMcpCatalog();
    if (!mcpCatalog) return { urls: [], defaultUrl: '' };
    return mcpCatalog.getSources();
  });

  ipcMain.handle('mcp:catalog-sources-set', (_evt, payload) => {
    const mcpCatalog = getMcpCatalog();
    if (!mcpCatalog) return { urls: [] };
    const urls = payload && Array.isArray(payload.urls) ? payload.urls : [];
    return mcpCatalog.setSources(urls);
  });

  ipcMain.handle('tools:recall', async (_evt, payload) => {
    const userData = getUserDataPath();
    const settings = loadModelSettings(userData);
    const embeddingConfig = getEmbeddingConfig(settings);
    const recalled = await recallAgentTools({
      userData,
      embeddingConfig,
      candidates: Array.isArray(payload?.candidates) ? payload.candidates : [],
      query: payload?.query || '',
      limit: payload?.limit || 10
    });
    if (recalled && recalled.serverFloor > 0) {
      console.log(`[tools] recall 每服务保底补入 ${recalled.serverFloor} 个服务（候选 ${recalled.total}）`);
    }
    return recalled;
  });

  ipcMain.handle('mcp:list', () => listMcpServersForUi(getUserDataPath()));

  ipcMain.handle('mcp:set-enabled', async (_evt, payload) => {
    const userData = getUserDataPath();
    const id = payload && payload.id ? String(payload.id) : '';
    const list = setMcpServerEnabled(userData, { id, enabled: payload && payload.enabled !== false });
    await mcpManager.reload();
    return list;
  });

  ipcMain.handle('mcp:delete', async (_evt, payload) => {
    const userData = getUserDataPath();
    const id = payload && payload.id ? String(payload.id) : '';
    const result = deleteMcpServer(userData, id);
    await mcpManager.reload();
    return result;
  });

  ipcMain.handle('mcp:add', async (_evt, payload) => {
    const userData = getUserDataPath();
    const result = addMcpServer(userData, payload || {});
    await mcpManager.reload();
    return result;
  });

  ipcMain.handle('mcp:get-config', async (_evt, payload) => {
    const id = payload && payload.id ? String(payload.id) : '';
    return getMcpServerConfigForUi(getUserDataPath(), id);
  });

  ipcMain.handle('mcp:update-config', async (_evt, payload) => {
    const userData = getUserDataPath();
    const result = updateMcpServerConfig(userData, payload || {});
    await mcpManager.reload();
    return result;
  });

  ipcMain.handle('mcp:check-update', async (_evt, payload) => {
    const id = payload && payload.id ? String(payload.id) : '';
    return checkMcpServerUpdate(getUserDataPath(), id);
  });

  ipcMain.handle('mcp:install-package', async (_evt, payload) => {
    const userData = getUserDataPath();
    const id = payload && payload.id ? String(payload.id) : '';
    const result = await installMcpServerPackage(userData, id);
    await mcpManager.reload();
    return result;
  });

  ipcMain.handle('mcp:repair-env', async (_evt, payload) => repairMcpEnvironment(getUserDataPath(), payload || {}));

  ipcMain.handle('mcp:upgrade-package', async (_evt, payload) => {
    const userData = getUserDataPath();
    const result = await upgradeMcpServerPackage(userData, payload || {});
    await mcpManager.reload();
    return result;
  });

  ipcMain.handle('mcp:runtime-tools', async (_evt, payload) => {
    const mcpRuntime = getMcpRuntime();
    if (!mcpRuntime) return { tools: [], errors: [] };
    const result = await mcpRuntime.listAgentTools({
      force: !!(payload && payload.force),
      catalogOnly: !!(payload && payload.catalogOnly),
      refreshCatalog: !!(payload && payload.refreshCatalog),
      serverIds: Array.isArray(payload?.serverIds) ? payload.serverIds : undefined
    });
    return {
      tools: result.tools || [],
      errors: result.errors || [],
      catalogOnly: !!result.catalogOnly
    };
  });

  ipcMain.handle('mcp:runtime-call', async (_evt, payload) => {
    const mcpRuntime = getMcpRuntime();
    if (!mcpRuntime) throw new Error('MCP 运行时未就绪');
    const agentName = payload && payload.agentName != null ? String(payload.agentName).trim() : '';
    if (!agentName) throw new Error('agentName 必填');
    const args =
      payload && payload.arguments && typeof payload.arguments === 'object' ? payload.arguments : {};
    return mcpRuntime.callAgentTool(agentName, args);
  });

  ipcMain.handle('skills:get-home', () => {
    const localGateway = getLocalGateway();
    const userData = getUserDataPath();
    const workspacePath = localGateway ? localGateway.getWorkspace().workspacePath : null;
    return describeAgentHome(userData, workspacePath);
  });

  ipcMain.handle('skills:create', async (evt, payload) => {
    const localGateway = getLocalGateway();
    const userData = getUserDataPath();
    const workspacePath = localGateway ? localGateway.getWorkspace().workspacePath : null;
    const created = createUserSkill(userData, workspacePath, payload || {});
    notifySkillsCatalogChanged(evt.sender, created);
    return created;
  });

  ipcMain.handle('skills:catalog-list', async (_evt, payload) => {
    const skillCatalog = getSkillCatalog();
    if (!skillCatalog) return { entries: [], hasMore: false, loadedCount: 0 };
    return skillCatalog.listEntries({
      forceRemote: !!(payload && payload.refresh),
      loadMore: !!(payload && payload.loadMore),
      search: payload && payload.search != null ? String(payload.search) : ''
    });
  });

  ipcMain.handle('skills:catalog-install', async (_evt, payload) => {
    const skillCatalog = getSkillCatalog();
    const localGateway = getLocalGateway();
    const userData = getUserDataPath();
    if (!skillCatalog) throw new Error('技能市场未就绪');
    const workspacePath = localGateway ? localGateway.getWorkspace().workspacePath : null;
    return skillCatalog.install(String((payload && payload.id) || ''), userData, workspacePath);
  });

  ipcMain.handle('skills:catalog-preview', async (_evt, payload) => {
    const skillCatalog = getSkillCatalog();
    if (!skillCatalog) throw new Error('技能市场未就绪');
    return skillCatalog.preview(String((payload && payload.id) || ''));
  });

  ipcMain.handle('skills:read', async (_evt, skillPath) => {
    if (!skillPath || typeof skillPath !== 'string') {
      throw new Error('skillPath 必填');
    }
    const localGateway = getLocalGateway();
    const userData = getUserDataPath();
    const workspacePath = localGateway ? localGateway.getWorkspace().workspacePath : null;
    const roots = filterAccessibleSkillRoots(getScanRoots(userData, workspacePath).map((r) => path.resolve(r)));
    assertReadableSkillPath(skillPath, roots);
    return readSkillContent(skillPath);
  });

  ipcMain.handle('workplace-monitor:get', () => ({ enabled: isWorkplaceMonitorEnabled() }));

  ipcMain.handle('workplace-monitor:set', (_evt, payload) => {
    if (payload && Object.prototype.hasOwnProperty.call(payload, 'enabled')) {
      applyWorkplaceMonitorEnabled(!!payload.enabled);
    }
    return { enabled: isWorkplaceMonitorEnabled() };
  });

  ipcMain.handle('skills:delete', async (_evt, payload) => {
    // 实现唯一来源 src/agent-home.js#deleteUserSkill（Agent 工具 skill_delete 走同一份）
    const localGateway = getLocalGateway();
    const workspacePath = localGateway ? localGateway.getWorkspace().workspacePath : null;
    await deleteUserSkill(getUserDataPath(), workspacePath, payload && payload.dir);
    return { ok: true };
  });
}

module.exports = { registerSkillsMcpIpc };
