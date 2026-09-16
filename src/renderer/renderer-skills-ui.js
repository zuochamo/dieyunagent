/* global window, document, $, escapeHtml, gwState, gatewayCall, openSettingsShell, switchSettingsPage, refreshAutomationList, showPluginListView, showMcpListView, loadPluginsUI, showAgentToast, getEffectiveInputBudget, CTX_LIMITS, updateSshPanelVisibility */
'use strict';

function closeSkillDetail() {
  const overlay = $('skill-detail-overlay');
  if (overlay) overlay.hidden = true;
}

function buildMcpFullDescription(server, tools = []) {
  const lines = [];
  lines.push(`来源：${server.builtin ? '预装 MCP' : '用户添加'}`);
  lines.push(`类型：${server.transportKind === 'remote' ? '远程 HTTP/SSE' : '本地 stdio'}`);
  lines.push(`状态：${server.enabled ? '已启用' : '未启用'}`);
  if (server.packageName) {
    lines.push(`包：${server.packageName}${server.packageVersion ? `@${server.packageVersion}` : ''}`);
  }
  if (server.needsConfig) lines.push('配置：待完成 URL / Token / 环境变量');
  lines.push('');
  if (server.transportKind === 'remote') {
    lines.push('连接方式');
    lines.push(`  URL：${server.remoteUrl || '未配置'}`);
    lines.push(`  传输：${server.remoteTransport || 'streamable-http'}`);
    lines.push(`  鉴权 Header：${server.authHeaderName || 'Authorization'}`);
  } else {
    lines.push('启动方式');
    lines.push(`  命令：${server.command || '未配置'}`);
    if (Array.isArray(server.args) && server.args.length) {
      lines.push('  参数：');
      for (const arg of server.args) lines.push(`    ${arg}`);
    }
    if (server.envHint) {
      lines.push('');
      lines.push(`环境变量：${server.envHint}`);
    }
  }
  if (tools.length) {
    lines.push('');
    lines.push(`已发现工具（${tools.length}）：`);
    for (const tool of tools) {
      const name = tool.toolName || tool.agentName || 'tool';
      const desc = tool.description ? ` — ${tool.description}` : '';
      lines.push(`• ${name}${desc}`);
    }
  } else if (server.enabled && server.configured) {
    lines.push('');
    lines.push('（工具列表尚未缓存；Agent 首次调用时会自动发现。）');
  }
  return lines.join('\n');
}

var mcpConfigServerId = '';
var mcpConfigLastUpdateInfo = null;
var mcpConfigRepairKind = '';

function closeMcpConfigDialog() {
  const overlay = $('mcp-config-overlay');
  if (overlay) overlay.hidden = true;
  document.body.classList.remove('modal-config-open');
  mcpConfigServerId = '';
  mcpConfigLastUpdateInfo = null;
  mcpConfigRepairKind = '';
}

function renderMcpVersionStatus(config, info = null) {
  const section = $('mcp-config-version-section');
  const statusEl = $('mcp-config-version-status');
  const upgradeBtn = $('mcp-config-upgrade');
  const checkBtn = $('mcp-config-check-update');
  const installBtn = $('mcp-config-install-local');
  const repairBtn = $('mcp-config-repair-env');
  if (!section || !statusEl || !upgradeBtn || !checkBtn || !installBtn || !repairBtn) return;

  const packageName = config?.packageName || '';
  const packageVersion = config?.packageVersion || '';
  const supported = !!packageName && config?.transportKind !== 'remote';
  const canRepairBuildEnv = supported && /code-graph|schema|better-sqlite3|sqlite|native/i.test(packageName);
  section.hidden = !supported;
  upgradeBtn.hidden = true;
  upgradeBtn.disabled = true;
  installBtn.hidden = !supported;
  installBtn.disabled = false;
  mcpConfigRepairKind = canRepairBuildEnv ? 'windows-vctools' : '';
  repairBtn.hidden = !canRepairBuildEnv;
  repairBtn.disabled = !canRepairBuildEnv;
  if (!supported) {
    statusEl.textContent = '';
    mcpConfigRepairKind = '';
    return;
  }

  const installedText = config.packageInstalled
    ? `已安装：${config.packageInstalledVersion || packageVersion || '未知版本'}`
    : '未安装到本地';
  installBtn.textContent = config.packageInstalled ? '重新安装' : '安装到本地';

  if (!info) {
    statusEl.textContent =
      `当前：${packageName}${packageVersion ? `@${packageVersion}` : '（跟随 latest）'} · ${installedText}` +
      (config.packageInstallRoot ? `\n目录：${config.packageInstallRoot}` : '');
    return;
  }
  if (!info.supported) {
    statusEl.textContent = info.message || '该 MCP 暂不支持自动检查版本。';
    return;
  }
  const current = info.currentVersion || packageVersion || 'latest';
  const latest = info.latestVersion || '未知';
  statusEl.textContent =
    `${info.packageName || packageName} 当前 ${current}，最新 ${latest}。${info.message || ''}` +
    `\n${installedText}` +
    (config.packageInstallRoot ? `\n目录：${config.packageInstallRoot}` : '');
  if (info.updateAvailable && info.latestVersion) {
    upgradeBtn.hidden = false;
    upgradeBtn.disabled = false;
    upgradeBtn.textContent = `升级到 ${info.latestVersion}`;
  }
}

function showMcpPackageFailure(result) {
  const statusEl = $('mcp-config-version-status');
  const repairBtn = $('mcp-config-repair-env');
  const message = result?.error || '安装失败';
  const detail = result?.diagnostic ? `\n\n${result.diagnostic}` : '';
  if (statusEl) statusEl.textContent = `${message}${detail}`;
  mcpConfigRepairKind = result?.repairKind || '';
  if (repairBtn) {
    repairBtn.hidden = !mcpConfigRepairKind || mcpConfigRepairKind === 'npm-cache-busy';
    repairBtn.disabled = repairBtn.hidden;
  }
}

async function installMcpPackageForCurrent() {
  if (!mcpConfigServerId || !skillsApi.installMcpPackage) return;
  const btn = $('mcp-config-install-local');
  const statusEl = $('mcp-config-version-status');
  if (btn) btn.disabled = true;
  if (statusEl) statusEl.textContent = '正在安装到本地固定目录…';
  try {
    const result = await skillsApi.installMcpPackage({ id: mcpConfigServerId });
    if (result && result.ok === false) {
      showMcpPackageFailure(result);
      return;
    }
    const config = await skillsApi.getMcpConfig({ id: mcpConfigServerId });
    mcpConfigLastUpdateInfo = null;
    renderMcpVersionStatus(config, null);
    await renderMcpList();
  } catch (err) {
    if (statusEl) statusEl.textContent = `安装失败：${err.message || err}`;
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function repairMcpEnvForCurrent() {
  if (!mcpConfigRepairKind || !skillsApi.repairMcpEnv) return;
  const btn = $('mcp-config-repair-env');
  const statusEl = $('mcp-config-version-status');
  if (
    !window.confirm(
      '将打开一个命令行窗口安装 Windows C++ 编译环境。这个过程可能较久，也可能需要管理员权限。继续吗？'
    )
  ) {
    return;
  }
  if (btn) btn.disabled = true;
  try {
    const result = await skillsApi.repairMcpEnv({ repairKind: mcpConfigRepairKind });
    if (statusEl) statusEl.textContent = result?.message || '已启动环境修复器。';
  } catch (err) {
    if (statusEl) statusEl.textContent = `启动修复失败：${err.message || err}`;
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function checkMcpUpdateForCurrent() {
  if (!mcpConfigServerId || !skillsApi.checkMcpUpdate) return;
  const btn = $('mcp-config-check-update');
  const statusEl = $('mcp-config-version-status');
  if (btn) btn.disabled = true;
  if (statusEl) statusEl.textContent = '正在检查更新…';
  try {
    const info = await skillsApi.checkMcpUpdate({ id: mcpConfigServerId });
    mcpConfigLastUpdateInfo = info || null;
    const config = await skillsApi.getMcpConfig({ id: mcpConfigServerId });
    renderMcpVersionStatus(config, info);
  } catch (err) {
    if (statusEl) statusEl.textContent = `检查失败：${err.message || err}`;
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function upgradeMcpPackageForCurrent() {
  if (!mcpConfigServerId || !skillsApi.upgradeMcpPackage) return;
  const target = mcpConfigLastUpdateInfo?.latestVersion || '';
  if (!target) return;
  if (!window.confirm(`确定升级 MCP 到 ${target}？升级后会重新连接该 MCP。`)) return;
  const btn = $('mcp-config-upgrade');
  const statusEl = $('mcp-config-version-status');
  if (btn) btn.disabled = true;
  if (statusEl) statusEl.textContent = `正在升级到 ${target}…`;
  try {
    const result = await skillsApi.upgradeMcpPackage({ id: mcpConfigServerId, version: target });
    if (result && result.ok === false) {
      showMcpPackageFailure(result);
      return;
    }
    const config = await skillsApi.getMcpConfig({ id: mcpConfigServerId });
    mcpConfigLastUpdateInfo = null;
    renderMcpVersionStatus(config, null);
    await renderMcpList();
  } catch (err) {
    if (statusEl) statusEl.textContent = `升级失败：${err.message || err}`;
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function openMcpConfigDialog(server) {
  const overlay = $('mcp-config-overlay');
  const titleEl = $('mcp-config-title');
  const descEl = $('mcp-config-desc');
  const remoteFields = $('mcp-config-remote-fields');
  const stdioFields = $('mcp-config-stdio-fields');
  const simpleFields = $('mcp-config-simple-fields');
  if (!overlay || !server) return;
  if (!skillsApi.getMcpConfig) {
    window.alert('当前版本未提供 MCP 配置接口');
    return;
  }

  overlay.hidden = false;
  document.body.classList.add('modal-config-open');
  mcpConfigServerId = server.id;
  mcpConfigLastUpdateInfo = null;
  mcpConfigRepairKind = '';
  if (titleEl) titleEl.textContent = server.name || server.id || 'MCP 配置';
  if (descEl) descEl.textContent = '正在加载配置…';

  let config = server;
  try {
    config = await skillsApi.getMcpConfig({ id: server.id });
  } catch (err) {
    if (descEl) descEl.textContent = `加载失败：${err.message || err}`;
    return;
  }

  const isDieyunService = config.configKind === 'dieyun-service' || !!config.dieyunService;
  const isSimpleCred = isDieyunService;
  const isRemote = !isSimpleCred && config.transportKind === 'remote';
  if (descEl) {
    descEl.textContent = config.description || (isRemote ? '远程 MCP 服务' : '本地 stdio MCP');
  }
  renderMcpVersionStatus(config, null);
  if (remoteFields) remoteFields.hidden = !isRemote;
  if (simpleFields) simpleFields.hidden = !isSimpleCred;
  if (stdioFields) stdioFields.hidden = isRemote;

  const envField = $('mcp-config-env-field');
  if (envField) envField.hidden = isSimpleCred;

  if (isSimpleCred) {
    const cred = config.dieyunService || {};
    $('mcp-config-simple-url') && ($('mcp-config-simple-url').value = cred.url || '');
    $('mcp-config-simple-key') && ($('mcp-config-simple-key').value = cred.key || '');
    const hint = $('mcp-config-simple-hint');
    if (hint) {
      hint.textContent = `${cred.label || '叠云'} 只读 Open API：填写 Base URL 与 API Key。`;
    }
    const keyHint = $('mcp-config-simple-key-hint');
    if (keyHint) {
      keyHint.textContent = cred.hasKey
        ? `已填充（来源：${cred.keySource || '配置'}）${cred.enableHint ? ` · 开关：${cred.enableHint}` : ''}`
        : '请填写 API Key';
    }
    $('mcp-config-command') && ($('mcp-config-command').value = config.command || '内置');
    $('mcp-config-args') &&
      ($('mcp-config-args').value =
        (config.args || []).join('\n') ||
        String(config.openApiService || config.bundledServer || ''));
  } else if (isRemote) {
    $('mcp-config-url') && ($('mcp-config-url').value = config.remoteUrl || '');
    $('mcp-config-transport') && ($('mcp-config-transport').value = config.remoteTransport || 'streamable-http');
    $('mcp-config-auth-header') &&
      ($('mcp-config-auth-header').value = config.authHeaderName || 'Authorization');
    $('mcp-config-token') && ($('mcp-config-token').value = '');
    const tokenHint = $('mcp-config-token-hint');
    if (tokenHint) {
      const parts = [];
      if (config.authRequired) parts.push('该服务需要 Token / API Key');
      if (config.hasToken) parts.push('已保存鉴权信息（留空则不修改）');
      tokenHint.textContent = parts.join(' · ') || '可选：填写 Bearer Token 或 API Key';
    }
  } else {
    $('mcp-config-command') && ($('mcp-config-command').value = config.command || '');
    $('mcp-config-args') &&
      ($('mcp-config-args').value = (config.args || []).join('\n'));
    $('mcp-config-env') && ($('mcp-config-env').value = '');
    const envHint = $('mcp-config-env-hint');
    if (envHint) {
      if (config.envHint) {
        envHint.textContent = config.hasEnvValue
          ? `${config.envHint} 已保存（留空则不修改）`
          : `请填写 ${config.envHint}`;
      } else {
        envHint.textContent = '无需额外环境变量';
      }
    }
  }

  const toolsSection = $('mcp-config-tools-section');
  const toolsEl = $('mcp-config-tools');
  if (toolsSection && toolsEl) {
    toolsSection.hidden = true;
    toolsEl.textContent = '';
    if (skillsApi.getMcpRuntimeTools && config.enabled) {
      try {
        const catalog = await skillsApi.getMcpRuntimeTools({ catalogOnly: true });
        const tools = (catalog.tools || []).filter((item) => String(item.serverId) === String(server.id));
        if (tools.length) {
          toolsSection.hidden = false;
          toolsEl.textContent = buildMcpFullDescription({ ...config, ...server }, tools);
        }
      } catch {
        // ignore
      }
    }
  }
}

async function submitMcpConfig(e) {
  e.preventDefault();
  if (!mcpConfigServerId || !skillsApi.updateMcpConfig) return;
  const saveBtn = $('mcp-config-save');
  if (saveBtn) saveBtn.disabled = true;
  try {
    const config = await skillsApi.getMcpConfig({ id: mcpConfigServerId });
    const payload = { id: mcpConfigServerId };
    if (config.configKind === 'dieyun-service' || config.dieyunService) {
      payload.dieyunServiceUrl = ($('mcp-config-simple-url')?.value || '').trim();
      payload.dieyunServiceKey = ($('mcp-config-simple-key')?.value || '').trim();
    } else if (config.transportKind === 'remote') {
      payload.remoteUrl = ($('mcp-config-url')?.value || '').trim();
      payload.remoteTransport = $('mcp-config-transport')?.value || 'streamable-http';
      payload.authHeaderName = ($('mcp-config-auth-header')?.value || 'Authorization').trim();
      const token = $('mcp-config-token')?.value || '';
      if (token) payload.token = token;
    } else {
      const envValue = $('mcp-config-env')?.value || '';
      if (envValue) payload.envValue = envValue;
    }
    await skillsApi.updateMcpConfig(payload);
    closeMcpConfigDialog();
    await renderMcpList();
  } catch (err) {
    window.alert(`保存失败：${err.message || err}`);
  } finally {
    if (saveBtn) saveBtn.disabled = false;
  }
}

async function openSkillDetail(sk) {
  const overlay = $('skill-detail-overlay');
  const titleEl = $('skill-detail-title');
  const bodyEl = $('skill-detail-body');
  if (!overlay || !bodyEl) return;
  overlay.hidden = false;
  if (titleEl) titleEl.textContent = sk.name || '技能详情';
  bodyEl.innerHTML = '<p class="skills-empty">加载中…</p>';
  if (!skillsApi.readSkill || !sk.skillPath) {
    bodyEl.innerHTML = `<p class="skills-empty">无法读取技能文件</p>`;
    return;
  }
  try {
    const data = await skillsApi.readSkill(sk.skillPath);
    const zh = data.descriptionZh || sk.descriptionZh || '';
    const en = data.descriptionEn || sk.descriptionEn || '';
    let intro = '';
    if (zh) intro += `<section class="skill-detail-section"><h3>简介（中文）</h3><p>${escapeHtml(zh)}</p></section>`;
    if (en) {
      intro += `<section class="skill-detail-section"><h3>Description (English)</h3><p class="skill-detail-en">${escapeHtml(en)}</p></section>`;
    } else if (!zh && data.description) {
      intro += `<section class="skill-detail-section"><h3>简介</h3><p>${escapeHtml(data.description)}</p></section>`;
    }
    const bodyMd = data.content ? escapeHtml(data.content) : '';
    const bodyBlock = bodyMd
      ? `<section class="skill-detail-section"><h3>完整说明</h3><p>${bodyMd}</p></section>`
      : '';
    const pathLine = sk.skillPath
      ? `<p class="skill-detail-path"><span class="field-label">路径</span> <code>${escapeHtml(sk.skillPath)}</code></p>`
      : '';
    bodyEl.innerHTML = `${pathLine}${intro}${bodyBlock}`;
  } catch (e) {
    bodyEl.innerHTML = `<p class="skills-empty">加载失败：${escapeHtml(e.message || e)}</p>`;
  }
}

function normSkillPath(p) {
  return String(p || '')
    .replace(/\\/g, '/')
    .toLowerCase();
}

function findSkillInCatalog(created) {
  if (!created) return null;
  const dirNorm = normSkillPath(created.dir);
  const pathNorm = normSkillPath(created.skillPath);
  const key = created.skillKey ? String(created.skillKey) : '';
  return (skillsCatalog.skills || []).find((item) => {
    if (key && (item.id === key || item.id === `builtin:${key}`)) return true;
    if (dirNorm && normSkillPath(item.dir) === dirNorm) return true;
    if (pathNorm && normSkillPath(item.skillPath) === pathNorm) return true;
    return false;
  });
}

async function registerCreatedSkillInUi(created) {
  await refreshSkillsCatalog();
  const sk = findSkillInCatalog(created);
  if (sk) {
    const map = loadEnabledSkillIds();
    map[sk.id] = true;
    saveEnabledSkillIds(map);
    skillsCategoryFilter = 'user';
    renderSkillsCategoryTabs();
    renderSkillsList();
    updateSkillsEnabledCount();
    if (typeof showAgentToast === 'function') {
      showAgentToast('技能已创建', `「${sk.name || created.name}」已加入列表并启用`, { variant: 'info' });
    }
  } else if (typeof showAgentToast === 'function') {
    showAgentToast('技能已创建', '请打开「技能 → 技能列表 → 用户添加」查看', { variant: 'info' });
  }
  return sk;
}

async function refreshSkillsCatalog() {
  if (!skillsApi.scanSkills) return;
  const grid = $('skills-grid');
  if (grid) grid.innerHTML = '<div class="skills-empty">扫描中…</div>';
  try {
    skillsCatalog = await skillsApi.scanSkills();
    loadEnabledSkillIds();
    renderSkillsCategoryTabs();
    renderSkillsList();
    renderMcpList().catch(() => {});
  } catch (err) {
    if (grid) grid.innerHTML = `<div class="skills-empty">扫描失败：${escapeHtml(err.message || err)}</div>`;
  }
}

function closeSkillCreateDialog() {
  const overlay = $('skill-create-overlay');
  if (overlay) overlay.hidden = true;
}

function openSkillCreateDialog() {
  const overlay = $('skill-create-overlay');
  const form = $('skill-create-form');
  if (!overlay || !form) return;
  form.reset();
  overlay.hidden = false;
  $('skill-create-name')?.focus();
}

async function submitSkillCreate(e) {
  e.preventDefault();
  const name = ($('skill-create-name')?.value || '').trim();
  const description = ($('skill-create-description')?.value || '').trim();
  const content = ($('skill-create-content')?.value || '').trim();
  if (!name || !description) {
    window.alert('请填写名称与简介');
    return;
  }
  if (!skillsApi.createSkill) {
    window.alert('当前版本未提供技能创建接口');
    return;
  }
  const submitBtn = $('skill-create-submit');
  if (submitBtn) submitBtn.disabled = true;
  try {
    const created = await skillsApi.createSkill({ name, description, content });
    closeSkillCreateDialog();
    await registerCreatedSkillInUi(created);
    window.alert(`技能已创建：${created.skillPath || created.dir}`);
  } catch (err) {
    window.alert(`创建失败：${err.message || err}`);
  } finally {
    if (submitBtn) submitBtn.disabled = false;
  }
}

function closeMcpAddDialog() {
  const overlay = $('mcp-add-overlay');
  if (overlay) overlay.hidden = true;
}

function openMcpAddDialog() {
  const overlay = $('mcp-add-overlay');
  const form = $('mcp-add-form');
  if (!overlay || !form) return;
  form.reset();
  overlay.hidden = false;
  $('mcp-add-id')?.focus();
}

function parseMcpArgsText(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

async function submitMcpAdd(e) {
  e.preventDefault();
  const id = ($('mcp-add-id')?.value || '').trim();
  const name = ($('mcp-add-name')?.value || '').trim();
  const description = ($('mcp-add-description')?.value || '').trim();
  const command = ($('mcp-add-command')?.value || '').trim();
  const args = parseMcpArgsText($('mcp-add-args')?.value || '');
  if (!id || !name || !command) {
    window.alert('请填写 ID、名称与启动命令');
    return;
  }
  if (!skillsApi.addMcpServer) {
    window.alert('当前版本未提供 MCP 添加接口');
    return;
  }
  const submitBtn = $('mcp-add-submit');
  if (submitBtn) submitBtn.disabled = true;
  try {
    await skillsApi.addMcpServer({ id, name, description, command, args });
    closeMcpAddDialog();
    await renderMcpList();
    window.alert(`MCP「${name}」已添加，请在列表中启用。`);
  } catch (err) {
    window.alert(`添加失败：${err.message || err}`);
  } finally {
    if (submitBtn) submitBtn.disabled = false;
  }
}

async function deleteMcpItem(server) {
  const label = server.name || server.id;
  const builtinHint = server.builtin !== false ? '\n（预装 MCP 将从列表隐藏，不会删除安装文件）' : '';
  if (!window.confirm(`确定删除 MCP「${label}」？${builtinHint}`)) {
    return;
  }
  if (!skillsApi.deleteMcpServer) {
    window.alert('当前版本未提供 MCP 删除接口');
    return;
  }
  try {
    await skillsApi.deleteMcpServer({ id: server.id });
    await renderMcpList();
  } catch (err) {
    window.alert(`删除失败：${err.message || err}`);
  }
}

async function renderMcpList() {
  const grid = $('skills-mcp-grid');
  if (!grid) return;
  if (!skillsApi.listMcpServers) {
    grid.innerHTML = '<div class="skills-empty">当前版本未提供 MCP 管理接口</div>';
    updateGridPagination('mcp', 0, 0, 0);
    return;
  }
  if (!mcpServersCache.length) {
    grid.innerHTML = '<div class="skills-empty">加载中…</div>';
  }
  try {
    const servers = await skillsApi.listMcpServers();
    mcpServersCache = Array.isArray(servers) ? servers : [];
    renderMcpCategoryTabs();
    if (!mcpServersCache.length) {
      grid.innerHTML = '<div class="skills-empty">暂无 MCP 服务，点击上方「添加」创建</div>';
      updateGridPagination('mcp', 0, 0, 0);
      return;
    }
    const visible = getFilteredMcpServers();
    if (!visible.length) {
      const hint = mcpSearchQuery.trim()
        ? '没有匹配的 MCP，请调整搜索或分类'
        : '当前分类下暂无 MCP';
      grid.innerHTML = `<div class="skills-empty">${escapeHtml(hint)}</div>`;
      updateGridPagination('mcp', 0, 0, 0);
      return;
    }
    const pageCount = Math.max(1, Math.ceil(visible.length / SKILLS_PAGE_SIZE));
    if (mcpPageIndex >= pageCount) mcpPageIndex = pageCount - 1;
    if (mcpPageIndex < 0) mcpPageIndex = 0;
    const slice = visible.slice(
      mcpPageIndex * SKILLS_PAGE_SIZE,
      mcpPageIndex * SKILLS_PAGE_SIZE + SKILLS_PAGE_SIZE
    );
    grid.innerHTML = '';
    for (const server of slice) {
      const needsConfig = !!server.needsConfig;
      const isRemote = server.transportKind === 'remote';
      const hintText = needsConfig
        ? '待配置 — 点击填写 URL / Token'
        : isRemote
          ? '远程 MCP — 点击查看配置'
          : '点击查看配置';
      const tile = document.createElement('article');
      tile.className = `skill-tile mcp-tile${server.enabled ? ' enabled' : ''}${needsConfig ? ' mcp-pending' : ''}`;
      tile.setAttribute('role', 'button');
      tile.tabIndex = 0;
      tile.title = hintText;
      tile.innerHTML = `
        <div class="skill-tile-head">
          <div class="skill-tile-title">${escapeHtml(server.name || server.id)}</div>
          ${needsConfig ? '<span class="skill-tile-tag mcp-pending-tag">待配置</span>' : isRemote ? '<span class="skill-tile-tag">远程</span>' : ''}
        </div>
        <p class="skill-tile-desc">${escapeHtml(server.description || '暂无简介')}</p>
        <p class="skill-tile-hint">${escapeHtml(hintText)}</p>
        <div class="skill-tile-foot">
          <label>
            <input type="checkbox" ${server.enabled ? 'checked' : ''} ${needsConfig ? 'disabled' : ''} />
            <span>${server.enabled ? '已启用' : needsConfig ? '待配置' : '启用'}</span>
          </label>
          <button type="button" class="skill-tile-delete" title="删除 MCP">删除</button>
        </div>`;
      const cb = tile.querySelector('input[type="checkbox"]');
      cb.addEventListener('change', async (e) => {
        e.stopPropagation();
        if (needsConfig) {
          cb.checked = false;
          openMcpConfigDialog(server).catch((err) => window.alert(err.message || String(err)));
          return;
        }
        cb.disabled = true;
        try {
          await skillsApi.setMcpEnabled({ id: server.id, enabled: cb.checked });
          await renderMcpList();
        } catch (err) {
          cb.disabled = false;
          cb.checked = !cb.checked;
          window.alert(`MCP 设置失败：${err.message || err}`);
        }
      });
      tile.querySelector('.skill-tile-foot')?.addEventListener('click', (e) => {
        e.stopPropagation();
      });
      tile.querySelector('.skill-tile-delete')?.addEventListener('click', (e) => {
        e.stopPropagation();
        deleteMcpItem(server).catch(() => {});
      });
      const openConfig = () =>
        openMcpConfigDialog(server).catch((err) => window.alert(err.message || String(err)));
      tile.addEventListener('click', openConfig);
      tile.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          openConfig();
        }
      });
      grid.appendChild(tile);
    }
    updateGridPagination('mcp', mcpPageIndex, pageCount, visible.length);
  } catch (err) {
    grid.innerHTML = `<div class="skills-empty">加载失败：${escapeHtml(err.message || err)}</div>`;
    updateGridPagination('mcp', 0, 0, 0);
  }
}

function agentToolsIncludeCompactMcp(tools) {
  if (!Array.isArray(tools) || !tools.length) return false;
  return tools.some((t) => {
    const name = t && t.function && t.function.name ? String(t.function.name) : '';
    return name.startsWith('mcp_') && name !== 'mcp_tool_schema';
  });
}

async function buildSkillsPrompt(userQuery = '') {
  if (!(skillsCatalog.skills || []).length && skillsApi.scanSkills) {
    try {
      skillsCatalog = await skillsApi.scanSkills();
      loadEnabledSkillIds();
    } catch {
      // ignore
    }
  }
  const enabledMap = loadEnabledSkillIds();
  const ids = (skillsCatalog.skills || [])
    .filter((sk) => isSkillEnabled(enabledMap, sk.id))
    .map((sk) => sk.id);
  if (!ids.length) return '';
  let selected = [];
  let recallMeta = null;
  let recallFailed = false;
  const queryText = String(userQuery || '').trim();
  if (skillsApi.recallSkills && queryText) {
    try {
      const recalled = await skillsApi.recallSkills({
        query: queryText,
        enabledIds: ids,
        limit: SKILL_INJECT_TOTAL
      });
      recallMeta = recalled || null;
      selected = Array.isArray(recalled?.skills) ? recalled.skills : [];
    } catch {
      recallFailed = true;
      selected = [];
    }
  }
  if (!selected.length && recallFailed) {
    selected = ids.slice(0, SKILL_INJECT_TOTAL).map((id) => (skillsCatalog.skills || []).find((s) => s.id === id)).filter(Boolean);
  }
  if (!selected.length) return '';
  const parts = [];
  for (const item of selected.slice(0, SKILL_INJECT_TOTAL)) {
    const id = item.id || item;
    const fromCatalog = (skillsCatalog.skills || []).find((s) => s.id === id) || {};
    const meta = { ...fromCatalog, ...item };
    const skillPath =
      meta.skillPath ||
      (String(id).endsWith('SKILL.md') ? id : `${String(id).replace(/[/\\]$/, '')}/SKILL.md`);
    const skillDir = meta.dir ? String(meta.dir) : '';
    const scoreHint =
      Number.isFinite(Number(meta.score)) && recallMeta
        ? `> 召回分数：${Number(meta.score).toFixed(3)}${
            Number.isFinite(Number(meta.semanticScore)) ? `，语义 ${Number(meta.semanticScore).toFixed(3)}` : ''
          }\n`
        : '';
    const dirHint = skillDir ? `> 技能目录：${skillDir}\n> host_exec 时 cwd 设为该目录。\n` : '';
    const desc = String(meta.description || '').trim().slice(0, 320);
    parts.push(
      `### 技能：${meta.name || id}\n${scoreHint}> SKILL.md：${skillPath}\n${dirHint}${
        desc ? `${desc}\n` : ''
      }（索引；全文用 fs_read_file 读 SKILL.md）`
    );
  }
  if (!parts.length) return '';
  const modeLabel =
    recallMeta && recallMeta.mode === 'semantic'
      ? `语义召回 · ${recallMeta.embeddingModel || '向量模型'}`
      : recallMeta && recallMeta.mode === 'keyword'
        ? '关键词召回'
        : '已启用前置';
  return (
    `【相关技能 · 索引 · ${modeLabel}】\n` +
    `执行前请 fs_read_file 读取 SKILL.md。\n\n${parts.join('\n\n---\n\n')}`
  );
}

async function buildMcpPrompt(opts = {}) {
  if (!skillsApi.listMcpServers) return '';
  try {
    const enabled = (await skillsApi.listMcpServers()).filter((server) => server.enabled);
    if (!enabled.length) return '';
    if (opts.compactToolsPresent) {
      const names = enabled.map((s) => s.name || s.id).join('、');
      return (
        `【MCP · ${enabled.length} 个服务已启用】${names}\n` +
        '工具已注册为 mcp_*，参数见各工具 schema。嵌套结构可再调 mcp_tool_schema。'
      );
    }
    const lines = enabled.map((server) => {
      const command = [server.command, ...(server.args || [])].filter(Boolean).join(' ');
      const envLine = server.envHint ? `\n  环境变量：${server.envHint}` : '';
      return `- ${server.name || server.id} (${server.id})：${server.description || ''}\n  启动命令：${command || '未配置'}${envLine}`;
    });
    return (
      '【已启用 MCP 服务】\n' +
      lines.join('\n') +
      '\n说明：启用后叠云会 spawn MCP 子进程并将其工具注册到 Agent（以 mcp_ 开头）；首次连接可能需下载 npm 包。'
    );
  } catch {
    return '';
  }
}
function updateWorkspaceLabel(ws) {
  const el = $('composer-workspace');
  if (typeof window !== 'undefined') {
    window.activeViewSessionWorkspacePath =
      ws && ws.workspacePath ? String(ws.workspacePath) : null;
    window.activeViewSessionWorkspaceKind =
      ws && ws.kind ? String(ws.kind) : null;
  }
  if (typeof updateSshPanelVisibility === 'function') {
    updateSshPanelVisibility(ws);
  }
  if (!el) return;
  const display = ws && (ws.displayPath || ws.workspacePath) ? ws.displayPath || ws.workspacePath : null;
  if (display) {
    el.textContent = String(display);
    el.title = ws.workspacePath || display;
    el.classList.toggle('composer-workspace-ssh', ws.kind === 'ssh');
    el.classList.toggle('composer-workspace-disconnected', ws.kind === 'ssh' && !ws.sshConnected);
  } else {
    el.textContent = '默认 ~/.dieyun/workspace';
    el.title = '未单独选择工作空间；文件工具默认写入用户主目录下的 .dieyun/workspace';
    el.classList.remove('composer-workspace-ssh', 'composer-workspace-disconnected');
  }
  if (typeof touchAgentsMdForWorkspace === 'function' && ws && ws.workspacePath) {
    touchAgentsMdForWorkspace(ws.workspacePath);
  }
  if (typeof refreshWorkspaceMutateHint === 'function') {
    refreshWorkspaceMutateHint(ws && ws.workspacePath ? ws.workspacePath : null, currentSessionId);
  }
}

async function initWorkspaceUI() {
  if (!skillsApi.getWorkspace) return;
  try {
    const ws = await skillsApi.getWorkspace();
    updateWorkspaceLabel(ws);
  } catch {
    // ignore
  }
}

function initSkillsUI() {
  refreshSkillsCatalog();
  if (skillsApi.onSkillsChanged) {
    skillsApi.onSkillsChanged((detail) => {
      registerCreatedSkillInUi(detail).catch(() => refreshSkillsCatalog());
    });
  }

  const skillsPagePrev = $('skills-page-prev');
  const skillsPageNext = $('skills-page-next');
  if (skillsPagePrev) {
    skillsPagePrev.addEventListener('click', () => {
      if (skillsPageIndex > 0) {
        skillsPageIndex -= 1;
        renderSkillsList();
      }
    });
  }
  if (skillsPageNext) {
    skillsPageNext.addEventListener('click', () => {
      skillsPageIndex += 1;
      renderSkillsList();
    });
  }

  const skillDetailOverlay = $('skill-detail-overlay');
  const skillDetailClose = $('skill-detail-close');
  if (skillDetailClose) skillDetailClose.addEventListener('click', closeSkillDetail);
  if (skillDetailOverlay) {
    skillDetailOverlay.addEventListener('click', (e) => {
      if (e.target === skillDetailOverlay) closeSkillDetail();
    });
  }
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const skillDetail = $('skill-detail-overlay');
    if (skillDetail && !skillDetail.hidden) closeSkillDetail();
    const mcpConfig = $('mcp-config-overlay');
    if (mcpConfig && !mcpConfig.hidden) closeMcpConfigDialog();
  });

  $('skill-add-btn')?.addEventListener('click', openSkillCreateDialog);
  $('skill-create-close')?.addEventListener('click', closeSkillCreateDialog);
  $('skill-create-cancel')?.addEventListener('click', closeSkillCreateDialog);
  $('skill-create-form')?.addEventListener('submit', (e) => {
    submitSkillCreate(e).catch(() => {});
  });
  const skillCreateOverlay = $('skill-create-overlay');
  if (skillCreateOverlay) {
    skillCreateOverlay.addEventListener('click', (e) => {
      if (e.target === skillCreateOverlay) closeSkillCreateDialog();
    });
  }

  $('mcp-add-btn')?.addEventListener('click', openMcpAddDialog);
  $('mcp-add-close')?.addEventListener('click', closeMcpAddDialog);
  $('mcp-add-cancel')?.addEventListener('click', closeMcpAddDialog);
  $('mcp-add-form')?.addEventListener('submit', (e) => {
    submitMcpAdd(e).catch(() => {});
  });
  const mcpAddOverlay = $('mcp-add-overlay');
  if (mcpAddOverlay) {
    mcpAddOverlay.addEventListener('click', (e) => {
      if (e.target === mcpAddOverlay) closeMcpAddDialog();
    });
  }

  $('mcp-config-close')?.addEventListener('click', closeMcpConfigDialog);
  $('mcp-config-cancel')?.addEventListener('click', closeMcpConfigDialog);
  $('mcp-config-form')?.addEventListener('submit', (e) => {
    submitMcpConfig(e).catch(() => {});
  });
  $('mcp-config-install-local')?.addEventListener('click', () => {
    installMcpPackageForCurrent().catch(() => {});
  });
  $('mcp-config-repair-env')?.addEventListener('click', () => {
    repairMcpEnvForCurrent().catch(() => {});
  });
  $('mcp-config-check-update')?.addEventListener('click', () => {
    checkMcpUpdateForCurrent().catch(() => {});
  });
  $('mcp-config-upgrade')?.addEventListener('click', () => {
    upgradeMcpPackageForCurrent().catch(() => {});
  });
  const mcpConfigOverlay = $('mcp-config-overlay');
  if (mcpConfigOverlay) {
    mcpConfigOverlay.addEventListener('click', (e) => {
      if (e.target === mcpConfigOverlay) closeMcpConfigDialog();
    });
  }

  bindGridSearchInput(
    'mcp-search',
    () => mcpSearchQuery,
    (v) => {
      mcpSearchQuery = v;
    },
    () => mcpPageIndex,
    (v) => {
      mcpPageIndex = v;
    },
    () => renderMcpList().catch(() => {})
  );
  bindGridPagination(
    'mcp',
    () => mcpPageIndex,
    (v) => {
      mcpPageIndex = v;
    },
    () => renderMcpList().catch(() => {})
  );

  const skillsSearchInput = $('skills-search');
  if (skillsSearchInput) {
    let searchDebounce;
    skillsSearchInput.addEventListener('input', () => {
      skillsSearchQuery = skillsSearchInput.value || '';
      skillsPageIndex = 0;
      clearTimeout(searchDebounce);
      searchDebounce = setTimeout(() => renderSkillsList(), 200);
    });
    skillsSearchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        skillsSearchInput.value = '';
        skillsSearchQuery = '';
        skillsPageIndex = 0;
        renderSkillsList();
      }
    });
  }

  initWorkspaceUI().catch(() => {});
  if (typeof initPluginListFilters === 'function') initPluginListFilters();
}

window.renderGridCategoryTabs = renderGridCategoryTabs;
window.updateGridPagination = updateGridPagination;
window.bindGridSearchInput = bindGridSearchInput;
window.bindGridPagination = bindGridPagination;
window.PLUGIN_TAXONOMY = PLUGIN_TAXONOMY;
window.AUTOMATION_TAXONOMY = AUTOMATION_TAXONOMY;
window.SKILLS_GRID_PAGE_SIZE = SKILLS_PAGE_SIZE;
window.openMcpConfigDialog = openMcpConfigDialog;
window.renderMcpList = renderMcpList;
window.registerCreatedSkillInUi = registerCreatedSkillInUi;
window.refreshSkillsCatalog = refreshSkillsCatalog;
