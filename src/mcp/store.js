'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { listBuiltinMcpServers } = require('./registry');
// 服务形态判定：`server-config.transportKind` 是读服务定义的口径，`mcp/manage.js` 是入参口径。
// 这里起别名，避免与下面几个函数里同名的局部变量 `const transportKind = ...` 撞名。
const {
  enrichMcpServerForUi,
  isMcpServerConfigured,
  transportKind: resolveServerTransportKind
} = require('./server-config');
const { getEnvHintNames } = require('./env-hints');
const { createMcpCredentialsStore } = require('./credentials-store');
const mcpPackageStore = require('./package-store');
// transport 口径（服务形态 / 远端协议）唯一来源，见 mcp/manage.js 顶部说明
const { isRemoteTransport, normalizeRemoteTransport } = require('./manage');

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

  /**
   * 新增自定义服务（UI「新增」表单的入口；Agent 走 mcp_manage → upsert 同一路径）。
   *
   * 远端 HTTP 服务与 stdio 的条目构造都在 `upsertMcpFromCatalog`（唯一一处），这里只补
   * 「新增」语义：必填校验给出调用方习惯的中文提示、id 重复直接报错（不按升级覆盖）。
   * 原先这里只认 command，于是 UI 和 Agent 都造不出一个远端服务，remote + 自定义鉴权头
   * 只能靠「先建 stdio 再改 remoteUrl」的绕法。
   */
  function addMcpServer(userDataPath, payload) {
    const p = payload || {};
    const id = p.id != null ? String(p.id).trim() : '';
    const command = p.command != null ? String(p.command).trim() : '';
    const remoteUrl = String(p.remoteUrl || p.url || '').trim();
    // 「算不算远端」只有一份判定（mcp/manage.js#isRemoteTransport）：显式 transport 优先，
    // 没写就看有没有 url —— 以前这里自己推一遍，与校验 / 落库各写一份就会漂移。
    const transportKind = isRemoteTransport(p.transport != null ? p.transport : p.transportKind, remoteUrl)
      ? 'remote'
      : 'stdio';
    if (!id) throw new Error('MCP id 必填');
    if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(id)) {
      throw new Error('id 须以字母开头，仅允许字母、数字、下划线、连字符');
    }
    if (transportKind === 'remote' && !remoteUrl) throw new Error('远程 URL 必填');
    if (transportKind === 'stdio' && !command) throw new Error('启动命令必填');

    const store = loadMcpStore(userDataPath);
    if ((store.custom || []).some((s) => s.id === id)) {
      throw new Error('该 id 已存在');
    }

    return upsertMcpFromCatalog(userDataPath, {
      id,
      name: p.name,
      description: p.description,
      transportKind,
      remoteUrl,
      remoteTransport: p.remoteTransport || 'streamable-http',
      authHeaderName: p.authHeaderName || 'Authorization',
      authRequired: !!p.authRequired,
      command: command || undefined,
      args: p.args
    }).list;
  }

  /**
   * 启用 / 停用某个已存在的服务 —— **唯一实现**。
   *
   * 原先这段判定（「服务是否存在」「未配置不许启用」）写在 IPC handler 里，Agent 工具
   * （`mcp_manage`）需要同一套判定，复制一份必然漂移，故下移到 store。
   * @param {string} userDataPath
   * @param {{ id?: string, enabled?: boolean }} payload
   */
  function setMcpServerEnabled(userDataPath, payload) {
    const id = payload && payload.id != null ? String(payload.id).trim() : '';
    if (!id) throw new Error('MCP id 必填');
    const store = loadMcpStore(userDataPath);
    const removed = new Set(store.removed || []);
    const exists =
      listBuiltinMcpServers().some((s) => s.id === id && !removed.has(id)) ||
      (store.custom || []).some((s) => s.id === id);
    if (!exists) throw new Error('MCP 服务不存在');
    const enabled = !(payload && payload.enabled === false);
    if (enabled) {
      const creds = ensureMcpCredentialsStore(userDataPath);
      const server = listMcpServersForUi(userDataPath).find((s) => s.id === id);
      if (server && !isMcpServerConfigured(server, { getSecretMeta: (sid) => creds.getSecretMeta(sid) })) {
        throw new Error('请先完成配置（URL / Token / 环境变量）');
      }
    }
    store.enabled = store.enabled || {};
    store.enabled[id] = enabled;
    saveMcpStore(userDataPath, store);
    return listMcpServersForUi(userDataPath);
  }

  /**
   * 自定义服务的**创建/更新唯一入口**：stdio 与 remote 都在这里建条目，
   * id 已存在时按 upgrade 覆盖。市场安装、UI 安装、Agent `mcp_manage` 全都走它 ——
   * 新增一条「另写一份 entry 构造」的路径就是重复实现。
   */
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
    const remoteUrl = payload && payload.remoteUrl != null ? String(payload.remoteUrl).trim() : '';
    // 同上：远端判定只有 mcp/manage.js 一份；没给 url 但有 command 就是 stdio
    const transportKind = isRemoteTransport(
      payload && payload.transport != null ? payload.transport : payload && payload.transportKind,
      remoteUrl
    )
      ? 'remote'
      : command
        ? 'stdio'
        : 'remote';
    const remoteTransport = normalizeRemoteTransport(
      payload && payload.remoteTransport != null ? payload.remoteTransport : ''
    );
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
    // listMcpServersForUi 已经把声明规范化成带状态的逐项表（env-hints.js 是唯一来源）
    const envDefs = Array.isArray(server.envHints) ? server.envHints : [];
    const envRequirement = server.envRequirement === 'any' ? 'any' : 'all';
    const envSatisfied = envDefs.length
      ? envRequirement === 'any'
        ? envDefs.some((def) => def.saved)
        : envDefs.filter((def) => def.required).every((def) => def.saved)
      : false;
    const packageMeta = mcpPackageStore.getMcpNpmPackageMeta(server);
    const packageStatus = mcpPackageStore.getMcpPackageStatus(userDataPath, server);
    return {
      id: server.id,
      name: server.name,
      description: server.description || '',
      builtin: !!server.builtin,
      enabled: !!server.enabled,
      bundledServer: server.bundledServer || '',
      transportKind: resolveServerTransportKind(server),
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
      envHint: envDefs.length ? envDefs[0].name : String(server.envHint || '').trim(),
      /** 逐项环境变量（name/label/hint/required/saved/undecryptable）：配置页按它渲染输入框 */
      envHints: envDefs,
      envHintNames: envDefs.map((def) => def.name),
      envRequirement,
      /** 离线预装（随客户端分发，运行时不需要 npm install / 下载二进制） */
      bundled: !!server.bundledServer,
      homepage: server.homepage || '',
      catalogId: server.catalogId || '',
      configured: !!server.configured,
      needsConfig: !!server.needsConfig,
      hasToken: !!meta.hasToken,
      hasEnvValue: envDefs.length ? envSatisfied : meta.hasEnv,
      undecryptable: Array.isArray(meta.undecryptable) ? meta.undecryptable : []
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
      // 已经是远端的，改配置时不给 url 也仍然是远端（否则会掉进 stdio 分支）；
      // 判「要不要转成远端」同样只问 mcp/manage.js#isRemoteTransport。
      const nextRemoteUrl =
        payload.remoteUrl != null ? String(payload.remoteUrl).trim() : String(prev.remoteUrl || '');
      const kind =
        prev.transportKind === 'remote' ||
        isRemoteTransport(payload.transport != null ? payload.transport : payload.transportKind, nextRemoteUrl)
          ? 'remote'
          : 'stdio';
      if (kind === 'remote') {
        store.custom[customIdx] = {
          ...prev,
          transportKind: 'remote',
          remoteUrl: nextRemoteUrl,
          remoteTransport: normalizeRemoteTransport(
            payload.remoteTransport != null ? payload.remoteTransport : prev.remoteTransport
          ),
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
    // 环境变量白名单：只允许写服务**自己声明过**的变量名。
    // 旧实现把 payload.envHint 当键名用，等于让渲染层决定往子进程 env 里塞什么变量；
    // 多变量入口放开之后这个口子必须收紧，否则 IPC 就成了一条任意 env 注入路径。
    //
    // 白名单**只**来自服务定义（registry 的 envHints / store.custom 的 envHint），
    // 不并入 payload.envHint —— 否则 { envHint: 'LD_PRELOAD', envValues: { LD_PRELOAD: … } }
    // 就能直接绕过校验，写进 mcp-secrets.json 并随 spawn 的 env 生效（2026-10-16 实测确证）。
    // 旧渲染层本来就不发 envHint（它发的 envValue 靠服务声明定键名），去掉这行零回归。
    const declaredServer = isBuiltin ? builtin : store.custom[customIdx] || null;
    const declaredNames = getEnvHintNames(declaredServer || {});
    const allowedNames = new Set(declaredNames);

    const envPatch = {};
    if (payload.envValues && typeof payload.envValues === 'object' && !Array.isArray(payload.envValues)) {
      for (const [rawName, rawValue] of Object.entries(payload.envValues)) {
        const name = String(rawName || '').trim();
        if (!name) continue;
        if (!allowedNames.has(name)) throw new Error(`该服务未声明环境变量 ${name}`);
        // 空串＝清除这个变量（credentials-store 对空值就是删键）
        envPatch[name] = String(rawValue == null ? '' : rawValue);
      }
    }
    // 旧的单值字段（打包版里的旧渲染层仍会发它）：只落到第一个**已声明**的变量名上。
    // 变量名同样由服务定义决定，不接受渲染层指定；服务没声明就忽略（旧实现这里会回落到
    // payload.envHint，等于又开一条注入路径，而该回落实际不可达 —— UI 无声明时不渲染输入框）。
    if (payload.envValue != null) {
      const target = declaredNames[0];
      if (target) envPatch[target] = String(payload.envValue || '');
    }

    if (payload.token != null) {
      creds.saveSecrets(serverId, { token: String(payload.token || '') });
    }
    if (Object.keys(envPatch).length) {
      creds.saveSecrets(serverId, { env: envPatch });
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
    setMcpServerEnabled,
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
