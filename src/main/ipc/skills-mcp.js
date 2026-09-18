'use strict';

const path = require('path');
const fsp = require('fs/promises');
const { scanSkills, readSkillContent, assertReadableSkillPath } = require('../../skills/scanner');
const { recallSkills } = require('../../skills/vector-index');
const { recallAgentTools } = require('../../tools/tool-vector-index');
const { getEmbeddingConfig } = require('../../model-settings');
const { listBuiltinMcpServers } = require('../../mcp/registry');
const { isMcpServerConfigured } = require('../../mcp/server-config');
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
    getSkillCatalog,
    listMcpServersForUi,
    loadMcpStore,
    saveMcpStore,
    ensureMcpCredentialsStore,
    deleteMcpServer,
    addMcpServer,
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
    return scanSkills({ userData, workspacePath });
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
    if (!mcpCatalog) return { entries: [], hasMore: false, loadedCount: 0 };
    return mcpCatalog.listEntries({
      forceRemote: !!(payload && payload.refresh),
      loadMore: !!(payload && payload.loadMore),
      search: payload && payload.search != null ? String(payload.search) : ''
    });
  });

  ipcMain.handle('mcp:catalog-install', async (_evt, payload) => {
    const mcpCatalog = getMcpCatalog();
    const mcpRuntime = getMcpRuntime();
    if (!mcpCatalog) throw new Error('MCP 目录未就绪');
    const result = await mcpCatalog.install(String((payload && payload.id) || ''));
    if (mcpRuntime) {
      mcpRuntime.invalidateToolsCache();
      await mcpRuntime.syncSessions().catch(() => {});
    }
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
    return recallAgentTools({
      userData,
      embeddingConfig,
      candidates: Array.isArray(payload?.candidates) ? payload.candidates : [],
      query: payload?.query || '',
      limit: payload?.limit || 10
    });
  });

  ipcMain.handle('mcp:list', () => listMcpServersForUi(getUserDataPath()));

  ipcMain.handle('mcp:set-enabled', async (_evt, payload) => {
    const userData = getUserDataPath();
    const mcpRuntime = getMcpRuntime();
    const id = payload && payload.id ? String(payload.id) : '';
    if (!id) throw new Error('MCP id 必填');
    const store = loadMcpStore(userData);
    const exists =
      listBuiltinMcpServers().some((s) => s.id === id && !(store.removed || []).includes(id)) ||
      (store.custom || []).some((s) => s.id === id);
    if (!exists) throw new Error('MCP 服务不存在');
    if (payload.enabled !== false) {
      const creds = ensureMcpCredentialsStore(userData);
      const server = listMcpServersForUi(userData).find((s) => s.id === id);
      if (server && !isMcpServerConfigured(server, { getSecretMeta: (sid) => creds.getSecretMeta(sid) })) {
        throw new Error('请先点击 MCP 卡片完成配置（URL / Token / 环境变量）');
      }
    }
    store.enabled[id] = payload.enabled !== false;
    saveMcpStore(userData, store);
    if (mcpRuntime) {
      mcpRuntime.invalidateToolsCache();
      await mcpRuntime.syncSessions().catch(() => {});
    }
    return listMcpServersForUi(userData);
  });

  ipcMain.handle('mcp:delete', async (_evt, payload) => {
    const userData = getUserDataPath();
    const mcpRuntime = getMcpRuntime();
    const id = payload && payload.id ? String(payload.id) : '';
    const result = deleteMcpServer(userData, id);
    if (mcpRuntime) {
      mcpRuntime.invalidateToolsCache();
      await mcpRuntime.syncSessions().catch(() => {});
    }
    return result;
  });

  ipcMain.handle('mcp:add', async (_evt, payload) => {
    const userData = getUserDataPath();
    const mcpRuntime = getMcpRuntime();
    const result = addMcpServer(userData, payload || {});
    if (mcpRuntime) {
      mcpRuntime.invalidateToolsCache();
      await mcpRuntime.syncSessions().catch(() => {});
    }
    return result;
  });

  ipcMain.handle('mcp:get-config', async (_evt, payload) => {
    const id = payload && payload.id ? String(payload.id) : '';
    return getMcpServerConfigForUi(getUserDataPath(), id);
  });

  ipcMain.handle('mcp:update-config', async (_evt, payload) => {
    const userData = getUserDataPath();
    const mcpRuntime = getMcpRuntime();
    const result = updateMcpServerConfig(userData, payload || {});
    if (mcpRuntime) {
      mcpRuntime.invalidateToolsCache();
      await mcpRuntime.syncSessions().catch(() => {});
    }
    return result;
  });

  ipcMain.handle('mcp:check-update', async (_evt, payload) => {
    const id = payload && payload.id ? String(payload.id) : '';
    return checkMcpServerUpdate(getUserDataPath(), id);
  });

  ipcMain.handle('mcp:install-package', async (_evt, payload) => {
    const userData = getUserDataPath();
    const mcpRuntime = getMcpRuntime();
    const id = payload && payload.id ? String(payload.id) : '';
    const result = await installMcpServerPackage(userData, id);
    if (mcpRuntime) {
      mcpRuntime.invalidateToolsCache();
      await mcpRuntime.syncSessions().catch(() => {});
    }
    return result;
  });

  ipcMain.handle('mcp:repair-env', async (_evt, payload) => repairMcpEnvironment(getUserDataPath(), payload || {}));

  ipcMain.handle('mcp:upgrade-package', async (_evt, payload) => {
    const userData = getUserDataPath();
    const mcpRuntime = getMcpRuntime();
    const result = await upgradeMcpServerPackage(userData, payload || {});
    if (mcpRuntime) {
      mcpRuntime.invalidateToolsCache();
      await mcpRuntime.syncSessions().catch(() => {});
    }
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
    const dir = payload && payload.dir;
    if (!dir || typeof dir !== 'string') throw new Error('dir 必填');
    const localGateway = getLocalGateway();
    const userData = getUserDataPath();
    const workspacePath = localGateway ? localGateway.getWorkspace().workspacePath : null;
    // 删除作用域 == 扫描作用域（~/.dieyun/skills、userData/skills/user、<workspace>/.dieyun/skills）
    const roots = filterAccessibleSkillRoots(
      getScanRoots(userData, workspacePath).map((r) => path.resolve(r))
    );
    const verdict = evaluateSkillDeletable(dir, roots);
    if (!verdict.deletable) {
      if (verdict.reason === 'ROOT_DIR') throw new Error('不能删除技能根目录');
      if (verdict.reason === 'SEEDED') throw new Error('预装内置技能不可删除');
      throw new Error('仅可删除当前扫描范围内的技能目录');
    }
    const resolved = path.resolve(dir);
    // 加固：只删真正的技能目录，避免伪造 dir 误删根内其它目录
    try {
      await fsp.access(path.join(resolved, 'SKILL.md'));
    } catch {
      throw new Error('目标目录不是技能目录（缺少 SKILL.md）');
    }
    await fsp.rm(resolved, { recursive: true, force: true });
    return { ok: true };
  });
}

module.exports = { registerSkillsMcpIpc };
