'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { listBuiltinMcpServers } = require('./registry');
const { enrichMcpServerForUi } = require('./server-config');
const { createMcpCredentialsStore } = require('./credentials-store');
const mcpPackageStore = require('./package-store');
const {
  isOpenApiMcpId,
  getOpenApiMcpDef,
  buildDieyunServiceConfigForUi,
  writeDieyunServiceToDeployLocal
} = require('./open-api-deploy-env');

/**
 * safeStorage 不可用时会降级写 deploy.local.json；该文件损坏时写入会抛错。
 * 这里只告警不向上抛：本次保存仍通过 process.env 生效（当前会话可用），
 * 避免中断用户操作，也避免影响 MCP 安装 / 打包流程。
 */
function warnDeployLocalWriteFailure(serverId, err) {
  console.warn(
    `[mcp] ${serverId} 凭据未能写入 deploy.local.json（本次仍生效，重启后可能丢失）：${
      err && err.message ? err.message : err
    }`
  );
}

/**
 * MCP json store + catalog install/upgrade/repair. Bound to Electron safeStorage.
 * @param {{ safeStorage: import('electron').SafeStorage }} opts
 */
function createMcpStore(opts) {
  const safeStorage = opts && opts.safeStorage;
  let mcpCredentialsStore = null;

  function ensureMcpCredentialsStore(userDataPath) {
    if (!mcpCredentialsStore) {
      mcpCredentialsStore = createMcpCredentialsStore({ safeStorage, userDataPath });
    }
    return mcpCredentialsStore;
  }

  function loadMcpStore(userDataPath) {
    const file = path.join(userDataPath, 'mcp.json');
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      return {
        version: 1,
        enabled: raw && typeof raw.enabled === 'object' ? raw.enabled : {},
        // 手工编辑或半截写入可能留下 null/字符串元素；listMcpServersForUi 会直接读
        // server.id，脏数据会让整个 MCP 列表接口抛异常
        custom:
          raw && Array.isArray(raw.custom)
            ? raw.custom.filter((s) => s && typeof s === 'object' && !Array.isArray(s))
            : [],
        removed: raw && Array.isArray(raw.removed) ? raw.removed.map(String) : [],
        overrides: raw && raw.overrides && typeof raw.overrides === 'object' ? raw.overrides : {}
      };
    } catch {
      return { version: 1, enabled: {}, custom: [], removed: [], overrides: {} };
    }
  }

  function saveMcpStore(userDataPath, store) {
    const file = path.join(userDataPath, 'mcp.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify(
        {
          version: 1,
          enabled: store.enabled || {},
          custom: store.custom || [],
          removed: store.removed || [],
          overrides: store.overrides || {}
        },
        null,
        2
      ),
      'utf8'
    );
  }

  function listMcpServersForUi(userDataPath) {
    const store = loadMcpStore(userDataPath);
    const removed = new Set(store.removed || []);
    const enabled = store.enabled || {};
    const overrides = store.overrides || {};
    const creds = ensureMcpCredentialsStore(userDataPath);
    const enrich = (server) =>
      enrichMcpServerForUi(server, {
        getSecretMeta: (id) => creds.getSecretMeta(id)
      });
    const builtins = listBuiltinMcpServers()
      .filter((server) => !removed.has(server.id))
      .map((server) => {
        const merged = {
          ...server,
          ...(overrides[server.id] && typeof overrides[server.id] === 'object'
            ? { ...overrides[server.id], id: server.id }
            : {}),
          builtin: true,
          enabled: Object.prototype.hasOwnProperty.call(enabled, server.id)
            ? enabled[server.id] !== false
            : !!server.defaultEnabled
        };
        if (merged.bundledServer) {
          merged.command = '内置';
          merged.args = [String(merged.openApiService || merged.bundledServer)];
        }
        return enrich(merged);
      });
    const customs = (store.custom || []).map((server) =>
      enrich({
        ...server,
        builtin: false,
        enabled: Object.prototype.hasOwnProperty.call(enabled, server.id)
          ? enabled[server.id] !== false
          : server.defaultEnabled !== false
      })
    );
    return [...builtins, ...customs];
  }

  function deleteMcpServer(userDataPath, id) {
    const serverId = String(id || '');
    if (!serverId) throw new Error('MCP id 必填');
    const store = loadMcpStore(userDataPath);
    const customIdx = (store.custom || []).findIndex((s) => s.id === serverId);
    if (customIdx >= 0) {
      store.custom.splice(customIdx, 1);
    } else if (listBuiltinMcpServers().some((s) => s.id === serverId)) {
      if (!store.removed.includes(serverId)) store.removed.push(serverId);
    } else {
      throw new Error('MCP 服务不存在');
    }
    if (store.enabled && Object.prototype.hasOwnProperty.call(store.enabled, serverId)) {
      delete store.enabled[serverId];
    }
    ensureMcpCredentialsStore(userDataPath).clearSecrets(serverId);
    saveMcpStore(userDataPath, store);
    return listMcpServersForUi(userDataPath);
  }

  function addMcpServer(userDataPath, payload) {
    const id = payload && payload.id != null ? String(payload.id).trim() : '';
    const name = payload && payload.name != null ? String(payload.name).trim() : '';
    const description =
      payload && payload.description != null ? String(payload.description).trim() : '';
    const command = payload && payload.command != null ? String(payload.command).trim() : '';
    const args = Array.isArray(payload.args)
      ? payload.args.map((a) => String(a).trim()).filter(Boolean)
      : [];
    if (!id) throw new Error('MCP id 必填');
    if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(id)) {
      throw new Error('id 须以字母开头，仅允许字母、数字、下划线、连字符');
    }
    if (!name) throw new Error('名称必填');
    if (!command) throw new Error('启动命令必填');

    const store = loadMcpStore(userDataPath);
    const removed = new Set(store.removed || []);
    const builtin = listBuiltinMcpServers().find((s) => s.id === id);
    if (builtin && !removed.has(id)) {
      throw new Error('该 id 已被预装 MCP 占用');
    }
    if ((store.custom || []).some((s) => s.id === id)) {
      throw new Error('该 id 已存在');
    }

    store.custom = store.custom || [];
    store.custom.push({
      id,
      name,
      description,
      command,
      args,
      defaultEnabled: false
    });
    saveMcpStore(userDataPath, store);
    return listMcpServersForUi(userDataPath);
  }

  function upsertMcpFromCatalog(userDataPath, payload) {
    const restoreBuiltinId =
      payload && payload.restoreBuiltinId != null ? String(payload.restoreBuiltinId).trim() : '';
    if (restoreBuiltinId) {
      const store = loadMcpStore(userDataPath);
      store.removed = (store.removed || []).filter((x) => x !== restoreBuiltinId);
      saveMcpStore(userDataPath, store);
      return {
        list: listMcpServersForUi(userDataPath),
        action: 'restore',
        mcpId: restoreBuiltinId
      };
    }

    const id = payload && payload.id != null ? String(payload.id).trim() : '';
    const name = payload && payload.name != null ? String(payload.name).trim() : '';
    const description =
      payload && payload.description != null ? String(payload.description).trim() : '';
    const command = payload && payload.command != null ? String(payload.command).trim() : '';
    const args = Array.isArray(payload.args)
      ? payload.args.map((a) => String(a).trim()).filter(Boolean)
      : [];
    const catalogId = payload && payload.catalogId != null ? String(payload.catalogId).trim() : '';
    const registryVersion =
      payload && payload.registryVersion != null ? String(payload.registryVersion).trim() : '';
    const envHint = payload && payload.envHint != null ? String(payload.envHint).trim() : '';
    const homepage = payload && payload.homepage != null ? String(payload.homepage).trim() : '';
    const transportKind =
      payload && payload.transportKind === 'remote' ? 'remote' : command ? 'stdio' : 'remote';
    const remoteUrl = payload && payload.remoteUrl != null ? String(payload.remoteUrl).trim() : '';
    const remoteTransport =
      payload && payload.remoteTransport != null
        ? String(payload.remoteTransport).trim()
        : 'streamable-http';
    const authHeaderName =
      payload && payload.authHeaderName != null
        ? String(payload.authHeaderName).trim()
        : 'Authorization';
    const authRequired = !!(payload && payload.authRequired);

    if (!id) throw new Error('MCP id 必填');
    if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(id)) {
      throw new Error('id 须以字母开头，仅允许字母、数字、下划线、连字符');
    }
    if (!name) throw new Error('名称必填');
    if (transportKind === 'stdio' && !command) throw new Error('启动命令必填');
    if (transportKind === 'remote' && !remoteUrl) throw new Error('远程 URL 必填');

    const store = loadMcpStore(userDataPath);
    const removed = new Set(store.removed || []);
    const activeBuiltin = listBuiltinMcpServers().find((s) => s.id === id);
    if (activeBuiltin && !removed.has(id)) {
      throw new Error('该 id 已被预装 MCP 占用');
    }

    store.custom = store.custom || [];
    const customIdx = store.custom.findIndex(
      (s) => s.id === id || (catalogId && String(s.catalogId || '') === catalogId)
    );
    /** @type {Record<string, unknown>} */
    const entry = {
      id,
      name,
      description,
      defaultEnabled: false
    };
    if (transportKind === 'remote') {
      entry.transportKind = 'remote';
      entry.remoteUrl = remoteUrl;
      entry.remoteTransport = remoteTransport || 'streamable-http';
      entry.authHeaderName = authHeaderName || 'Authorization';
      entry.authRequired = authRequired;
    } else {
      entry.transportKind = 'stdio';
      entry.command = command;
      entry.args = args;
      if (envHint) entry.envHint = envHint;
    }
    if (catalogId) entry.catalogId = catalogId;
    if (registryVersion) entry.registryVersion = registryVersion;
    if (homepage) entry.homepage = homepage;

    let action = 'install';
    if (customIdx >= 0) {
      store.custom[customIdx] = { ...store.custom[customIdx], ...entry };
      action = 'upgrade';
    } else if (store.custom.some((s) => s.id === id)) {
      throw new Error('该 id 已存在');
    } else {
      store.custom.push(entry);
    }

    saveMcpStore(userDataPath, store);
    return { list: listMcpServersForUi(userDataPath), action, mcpId: id };
  }

  function getMcpServerConfigForUi(userDataPath, id) {
    const serverId = String(id || '').trim();
    if (!serverId) throw new Error('MCP id 必填');
    const servers = listMcpServersForUi(userDataPath);
    const server = servers.find((s) => s.id === serverId);
    if (!server) throw new Error('MCP 服务不存在');
    const creds = ensureMcpCredentialsStore(userDataPath);
    const meta = creds.getSecretMeta(serverId);
    const secrets = creds.loadSecrets(serverId);
    const envHint = String(server.envHint || '').trim();
    const packageMeta = mcpPackageStore.getMcpNpmPackageMeta(server);
    const packageStatus = mcpPackageStore.getMcpPackageStatus(userDataPath, server);
    const openApiDef = getOpenApiMcpDef(serverId) || (server.openApiService ? getOpenApiMcpDef(`mcp-${server.openApiService}`) : null);
    const isDieyunService = isOpenApiMcpId(serverId) || !!server.openApiService;
    const serviceId = openApiDef ? openApiDef.service : server.openApiService || '';
    const dieyunService = isDieyunService && serviceId ? buildDieyunServiceConfigForUi(serviceId, secrets) : null;
    return {
      id: server.id,
      name: server.name,
      description: server.description || '',
      builtin: !!server.builtin,
      enabled: !!server.enabled,
      bundledServer: server.bundledServer || '',
      openApiService: serviceId || '',
      configKind: dieyunService ? dieyunService.configKind : '',
      dieyunService,
      transportKind: server.transportKind || (server.remoteUrl ? 'remote' : 'stdio'),
      remoteUrl: server.remoteUrl || '',
      remoteTransport: server.remoteTransport || 'streamable-http',
      authHeaderName: server.authHeaderName || 'Authorization',
      authRequired: !!server.authRequired,
      command: server.command || '',
      args: Array.isArray(server.args) ? server.args : [],
      packageName: server.packageName || packageMeta?.name || '',
      packageVersion: server.packageVersion || packageMeta?.version || '',
      packageInstalled: !!packageStatus.installed,
      packageInstallRoot: packageStatus.installRoot || '',
      packageInstalledVersion: packageStatus.installedVersion || '',
      envHint,
      homepage: server.homepage || '',
      catalogId: server.catalogId || '',
      configured: !!server.configured,
      needsConfig: !!server.needsConfig,
      hasToken: !!meta.hasToken,
      hasEnvValue: envHint
        ? meta.envKeys.includes(envHint)
        : dieyunService
          ? dieyunService.hasKey
          : meta.hasEnv
    };
  }

  function updateMcpServerConfig(userDataPath, payload) {
    const serverId = payload && payload.id != null ? String(payload.id).trim() : '';
    if (!serverId) throw new Error('MCP id 必填');

    const store = loadMcpStore(userDataPath);
    const removed = new Set(store.removed || []);
    const builtin = listBuiltinMcpServers().find((s) => s.id === serverId);
    const customIdx = (store.custom || []).findIndex((s) => s.id === serverId);
    const isBuiltin = !!(builtin && !removed.has(serverId));
    if (!isBuiltin && customIdx < 0) throw new Error('MCP 服务不存在');

    if (!isBuiltin && customIdx >= 0) {
      const prev = store.custom[customIdx];
      const kind =
        prev.transportKind === 'remote' || prev.remoteUrl || payload.remoteUrl != null
          ? 'remote'
          : 'stdio';
      if (kind === 'remote') {
        store.custom[customIdx] = {
          ...prev,
          transportKind: 'remote',
          remoteUrl:
            payload.remoteUrl != null ? String(payload.remoteUrl).trim() : String(prev.remoteUrl || ''),
          remoteTransport:
            payload.remoteTransport != null
              ? String(payload.remoteTransport).trim()
              : String(prev.remoteTransport || 'streamable-http'),
          authHeaderName:
            payload.authHeaderName != null
              ? String(payload.authHeaderName).trim()
              : String(prev.authHeaderName || 'Authorization'),
          authRequired: payload.authRequired != null ? !!payload.authRequired : !!prev.authRequired
        };
      } else if (payload.command != null || payload.args != null) {
        store.custom[customIdx] = {
          ...prev,
          command: payload.command != null ? String(payload.command).trim() : prev.command,
          args: Array.isArray(payload.args)
            ? payload.args.map((a) => String(a).trim()).filter(Boolean)
            : prev.args
        };
      }
      saveMcpStore(userDataPath, store);
    }

    const creds = ensureMcpCredentialsStore(userDataPath);
    const envHint =
      (isBuiltin ? builtin.envHint : store.custom[customIdx]?.envHint) ||
      String(payload.envHint || '').trim();
    if (payload.token != null) {
      creds.saveSecrets(serverId, { token: String(payload.token || '') });
    }
    if (envHint && payload.envValue != null) {
      creds.saveSecrets(serverId, { env: { [envHint]: String(payload.envValue || '') } });
    }
    if (
      (isOpenApiMcpId(serverId) || (builtin && builtin.openApiService)) &&
      (payload.dieyunServiceUrl != null || payload.dieyunServiceKey != null)
    ) {
      const def = getOpenApiMcpDef(serverId) || (builtin && builtin.openApiService
        ? { service: builtin.openApiService }
        : null);
      const serviceId = def && def.service ? def.service : '';
      const svc = serviceId ? require('./servers/dieyun-open-api/client').SERVICES[serviceId] : null;
      if (svc) {
        const url = String(payload.dieyunServiceUrl != null ? payload.dieyunServiceUrl : '')
          .trim()
          .replace(/\/+$/, '');
        const key = String(payload.dieyunServiceKey != null ? payload.dieyunServiceKey : '').trim();
        const env = {};
        if (url) env[svc.urlEnv] = url;
        if (key) env[svc.keyEnv] = key;
        if (Object.keys(env).length) {
          try {
            creds.saveSecrets(serverId, { env });
          } catch (err) {
            if (err && err.code === 'CREDENTIALS_ENCRYPT_UNAVAILABLE') {
              try {
                writeDieyunServiceToDeployLocal(serviceId, { url, key });
              } catch (writeErr) {
                warnDeployLocalWriteFailure(serverId, writeErr);
              }
            } else {
              throw err;
            }
          }
          for (const [k, v] of Object.entries(env)) {
            process.env[k] = v;
          }
        }
      }
    }

    return listMcpServersForUi(userDataPath);
  }

  function findMcpServerForStore(userDataPath, id) {
    const serverId = String(id || '').trim();
    if (!serverId) throw new Error('MCP id 必填');
    const store = loadMcpStore(userDataPath);
    const server = listMcpServersForUi(userDataPath).find((s) => s.id === serverId);
    if (!server) throw new Error('MCP 服务不存在');
    return { serverId, store, server };
  }

  function formatMcpPackageFailure(serverId, err) {
    const diagnostic =
      err && err.repairKind
        ? { repairKind: err.repairKind, message: err.message, detail: err.diagnostic || '' }
        : mcpPackageStore.classifyMcpInstallError(err);
    return {
      ok: false,
      serverId,
      error: diagnostic.message || err?.message || 'MCP 包安装失败',
      repairKind: diagnostic.repairKind || '',
      diagnostic: diagnostic.detail || ''
    };
  }

  async function checkMcpServerUpdate(userDataPath, id) {
    const { serverId, server } = findMcpServerForStore(userDataPath, id);
    const meta = mcpPackageStore.getMcpNpmPackageMeta(server);
    if (!meta) {
      return {
        ok: true,
        serverId,
        supported: false,
        message: '该 MCP 不是 npx npm 包，暂不支持自动检查版本。'
      };
    }
    const latestVersion = await mcpPackageStore.fetchNpmLatestVersion(meta.name);
    const currentVersion = meta.version || 'latest';
    const pinned = !!meta.version;
    const updateAvailable =
      pinned && latestVersion && mcpPackageStore.compareSemver(latestVersion, currentVersion) > 0;
    return {
      ok: true,
      supported: true,
      serverId,
      packageName: meta.name,
      currentVersion,
      latestVersion,
      pinned,
      updateAvailable,
      message: pinned
        ? updateAvailable
          ? `发现新版本 ${latestVersion}`
          : '当前已是配置版本的最新状态'
        : `当前跟随 npm latest（${latestVersion || '未知'}）`
    };
  }

  async function installMcpServerPackage(userDataPath, id) {
    const { serverId, server } = findMcpServerForStore(userDataPath, id);
    const meta = mcpPackageStore.getMcpNpmPackageMeta(server);
    if (!meta) throw new Error('该 MCP 不是 npx npm 包，暂不支持本地安装');
    let installed;
    try {
      installed = await mcpPackageStore.ensureMcpNpmPackage({ userDataPath, server });
    } catch (err) {
      return formatMcpPackageFailure(serverId, err);
    }
    return {
      ok: true,
      serverId,
      packageName: meta.name,
      packageVersion: installed.packageVersion || meta.version || '',
      installRoot: installed.installRoot || '',
      list: listMcpServersForUi(userDataPath)
    };
  }

  async function upgradeMcpServerPackage(userDataPath, payload) {
    const id = payload && payload.id != null ? String(payload.id).trim() : '';
    const { serverId, store, server } = findMcpServerForStore(userDataPath, id);
    const meta = mcpPackageStore.getMcpNpmPackageMeta(server);
    if (!meta) throw new Error('该 MCP 不是 npx npm 包，暂不支持自动升级');
    const latestVersion = await mcpPackageStore.fetchNpmLatestVersion(meta.name);
    const targetVersion =
      payload && payload.version != null
        ? String(payload.version).trim()
        : String(latestVersion || '').trim();
    if (!targetVersion) throw new Error('未获取到可升级版本');
    const nextArgs = mcpPackageStore.replaceNpmPackageVersion(server.args || [], meta, targetVersion);
    let installed;
    try {
      installed = await mcpPackageStore.installMcpNpmPackage({
        userDataPath,
        serverId,
        packageName: meta.name,
        version: targetVersion
      });
    } catch (err) {
      return formatMcpPackageFailure(serverId, err);
    }

    const customIdx = (store.custom || []).findIndex((s) => s.id === serverId);
    if (customIdx >= 0) {
      store.custom[customIdx] = {
        ...store.custom[customIdx],
        command: 'npx',
        args: nextArgs,
        packageName: meta.name,
        packageVersion: targetVersion
      };
    } else {
      store.overrides = store.overrides || {};
      store.overrides[serverId] = {
        ...(store.overrides[serverId] && typeof store.overrides[serverId] === 'object'
          ? store.overrides[serverId]
          : {}),
        command: 'npx',
        args: nextArgs,
        packageName: meta.name,
        packageVersion: targetVersion,
        upgradedAt: new Date().toISOString()
      };
    }
    saveMcpStore(userDataPath, store);
    return {
      ok: true,
      serverId,
      packageName: meta.name,
      currentVersion: meta.version || 'latest',
      latestVersion,
      targetVersion,
      installRoot: installed.root,
      list: listMcpServersForUi(userDataPath)
    };
  }

  function spawnPersistentWindowsConsole(batPath, title = 'Dieyun MCP Repair') {
    const child = spawn('cmd.exe', ['/c', 'start', title, 'cmd.exe', '/k', batPath], {
      detached: true,
      stdio: 'ignore',
      windowsHide: false
    });
    child.unref();
    return child;
  }

  function writeWindowsMcpRepairBat() {
    const batPath = path.join(os.tmpdir(), 'dieyun-mcp-repair-env.bat');
    const lines = [
      '@echo off',
      'chcp 65001 >nul',
      'title Dieyun MCP Environment Repair',
      'echo [Dieyun MCP] Installing Visual Studio Build Tools C++ workload for node-gyp...',
      'echo This may take a long time and may request administrator permission.',
      'echo.',
      'winget install --id Microsoft.VisualStudio.2022.BuildTools -e --source winget --accept-package-agreements --accept-source-agreements --override "--wait --passive --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"',
      'echo.',
      'echo [Dieyun MCP] Done. Return to Dieyun Agent and retry MCP local install.',
      'pause'
    ];
    fs.writeFileSync(batPath, `${lines.join('\r\n')}\r\n`, 'utf8');
    return batPath;
  }

  async function repairMcpEnvironment(_userDataPath, payload = {}) {
    const repairKind = String(payload.repairKind || '').trim();
    if (repairKind !== 'windows-vctools') {
      return {
        ok: false,
        message:
          repairKind === 'npm-cache-busy'
            ? '该问题通常需要关闭正在运行的 Node/MCP 进程后重试。'
            : '当前问题暂不支持自动修复。'
      };
    }
    if (process.platform !== 'win32') {
      return { ok: false, message: '当前环境不是 Windows，无法使用 winget 安装 VS Build Tools。' };
    }
    try {
      await mcpPackageStore.execFileText('where.exe', ['winget'], { timeout: 10000 });
    } catch {
      return {
        ok: false,
        message: '未检测到 winget。请先安装 App Installer，或手动安装 Visual Studio Build Tools。'
      };
    }

    const batPath = writeWindowsMcpRepairBat();
    spawnPersistentWindowsConsole(batPath, 'Dieyun MCP Repair');
    return {
      ok: true,
      message: '已打开环境修复窗口。安装完成后，请回到 MCP 配置页重新点击“安装到本地”。'
    };
  }

  return {
    ensureMcpCredentialsStore,
    loadMcpStore,
    saveMcpStore,
    listMcpServersForUi,
    deleteMcpServer,
    addMcpServer,
    upsertMcpFromCatalog,
    getMcpServerConfigForUi,
    updateMcpServerConfig,
    checkMcpServerUpdate,
    installMcpServerPackage,
    upgradeMcpServerPackage,
    repairMcpEnvironment
  };
}

module.exports = { createMcpStore };
