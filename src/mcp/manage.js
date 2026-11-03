'use strict';

/**
 * MCP 服务变更的**唯一入口**：改配置 + 让运行时重建会话。
 *
 * 为什么要它：这件事原本在 IPC 里各写一遍（`mcp:add` / `mcp:set-enabled` / `mcp:update-config` /
 * `mcp:delete` / `mcp:catalog-install` / `mcp:install-package` / `mcp:upgrade-package` 七个 handler
 * 里重复「`invalidateToolsCache()` + `syncSessions()`」）。Agent 侧的 `mcp_manage` 工具要走同一条
 * 路径 —— 复制一份就会漂移，谁忘了 invalidate，工具表就永远是旧的。
 *
 * 分工：**配置写哪张表在 store（唯一实现），生效时机在这里**（写完立刻重挂会话）。
 * 与 UI 的区别仅在入参形状：`apply()` 收 store 的 payload，`applyToolRequest()` 收工具参数。
 */

/**
 * 工具 / IPC 共用的动作清单（`mcp_manage` 的 schema 也照它声明 enum）。
 *
 * `request_credential` 不是 store 变更：它只把「需要用户填凭据」这件事送到界面上
 * （模型永远拿不到明文）。之所以放在这里，是因为「哪个服务缺哪些键」只有 store 知道。
 */
const MCP_MANAGE_ACTIONS = Object.freeze([
  'list',
  'add',
  'update',
  'enable',
  'remove',
  'restore',
  'request_credential',
  // 包运维：npx 包的本地安装 / 版本检查 / 升级 / 环境修复（原先只有设置页按钮）
  'check_update',
  'install_package',
  'upgrade_package',
  'repair_env'
]);

/** 只做包/环境运维的动作（不改服务配置本身，但装完要重挂会话）。 */
const MCP_PACKAGE_ACTIONS = Object.freeze(['check_update', 'install_package', 'upgrade_package', 'repair_env']);

/**
 * 把 Agent 工具参数（面向模型的扁平形状）翻译成 store 的 payload。
 * 纯函数，便于单测；`transport` 省略时按「有 url 就是远端」判定。
 * @param {any} request
 * @returns {{ action: string, payload: any }}
 */
function toStoreRequest(request) {
  const a = request && typeof request === 'object' ? request : {};
  const action = String(a.action == null ? '' : a.action).trim();
  const id = a.id == null ? '' : String(a.id).trim();
  if (action === 'list') return { action, payload: {} };
  if (action === 'enable') return { action, payload: { id, enabled: a.enabled !== false } };
  if (action === 'remove' || action === 'restore') return { action, payload: { id } };
  if (action === 'request_credential') return { action, payload: { id } };
  if (action === 'check_update' || action === 'install_package') return { action, payload: { id } };
  if (action === 'upgrade_package') {
    const payload = { id };
    if (a.version != null) payload.version = String(a.version).trim();
    return { action, payload };
  }
  if (action === 'repair_env') {
    return { action, payload: { repairKind: a.repairKind == null ? '' : String(a.repairKind).trim() } };
  }

  const remote = a.transport === 'remote' || a.transport === 'streamable-http' || (!a.transport && a.url != null);
  const payload = { id };
  if (a.name != null) payload.name = String(a.name).trim();
  if (a.description != null) payload.description = String(a.description).trim();
  if (remote) {
    payload.transportKind = 'remote';
    if (a.url != null) payload.remoteUrl = String(a.url).trim();
    payload.remoteTransport = 'streamable-http';
    if (a.authHeaderName != null) payload.authHeaderName = String(a.authHeaderName).trim();
    // 声明了 token 却没写 authRequired 时按「需要鉴权」处理，否则 UI 会显示成「已配置」而实际 401
    payload.authRequired = a.authRequired != null ? !!a.authRequired : !!a.token;
  } else {
    if (a.command != null) payload.command = String(a.command).trim();
    if (Array.isArray(a.args)) payload.args = a.args.map((x) => String(x));
  }
  if (a.token != null) payload.token = String(a.token);
  // 环境变量只有**服务自己声明过**的键能写（白名单在 store 里），这里只做转交
  if (action === 'update' && a.env && typeof a.env === 'object' && !Array.isArray(a.env)) {
    payload.envValues = a.env;
  }
  return { action, payload };
}

/** 工具结果里只需要「有什么服务、能不能用」，不要把整份 server 对象丢给模型。 */
function summarizeServers(list) {
  return (Array.isArray(list) ? list : []).map((s) => ({
    id: s.id,
    name: s.name,
    builtin: s.builtin !== false,
    enabled: !!s.enabled,
    configured: !!s.configured,
    transport: s.transportKind === 'remote' ? 'remote' : 'stdio',
    ...(s.transportKind === 'remote' ? { url: s.remoteUrl || '' } : {})
  }));
}

/**
 * @param {{ userDataPath: string, mcpStore: object, getRuntime?: () => any }} deps
 *   `getRuntime` 用取值函数传：MCP 运行时在启动过程中才装配好，管理器可以先建。
 */
function createMcpManager(deps) {
  const userDataPath = String((deps && deps.userDataPath) || '');
  const store = deps && deps.mcpStore;
  const getRuntime = deps && typeof deps.getRuntime === 'function' ? deps.getRuntime : () => null;
  // 把「请用户填凭据」送到界面（Main → Renderer 事件）。没有界面（无窗口 / headless）时为空。
  const notifyCredentialRequest =
    deps && typeof deps.notifyCredentialRequest === 'function' ? deps.notifyCredentialRequest : null;
  if (!store) throw new Error('createMcpManager 需要 mcpStore');

  /** 让运行时忘掉工具目录并重建会话；没有运行时（未装配 / 已关闭）时静默跳过。 */
  async function reload() {
    const runtime = getRuntime();
    if (!runtime) return;
    runtime.invalidateToolsCache();
    await runtime.syncSessions().catch(() => {});
  }

  const changes = {
    list: () => store.listMcpServersForUi(userDataPath),
    add: (p) => store.upsertMcpFromCatalog(userDataPath, p),
    update: (p) => store.updateMcpServerConfig(userDataPath, p),
    enable: (p) => store.setMcpServerEnabled(userDataPath, p),
    remove: (p) => store.deleteMcpServer(userDataPath, String((p && p.id) || '')),
    restore: (p) => store.upsertMcpFromCatalog(userDataPath, { restoreBuiltinId: String((p && p.id) || '') })
  };

  /**
   * 包运维动作：实现全在 store（`checkMcpServerUpdate` / `installMcpServerPackage` /
   * `upgradeMcpServerPackage` / `repairMcpEnvironment`），这里只做「谁来重挂会话」。
   * 原先这四个动作只有设置页按钮，Agent 装了个 npx 服务却没法把它装到本地、也没法自查版本。
   */
  const packageOps = {
    check_update: {
      method: 'checkMcpServerUpdate',
      args: (p) => [userDataPath, String((p && p.id) || '')]
    },
    install_package: {
      method: 'installMcpServerPackage',
      args: (p) => [userDataPath, String((p && p.id) || '')]
    },
    upgrade_package: { method: 'upgradeMcpServerPackage', args: (p) => [userDataPath, p || {}] },
    repair_env: { method: 'repairMcpEnvironment', args: (p) => [userDataPath, p || {}] }
  };

  /**
   * 执行一次变更并让运行时生效。写失败（id 非法 / 未配置不许启用 …）直接抛出，
   * 调用方各自决定怎么呈现（IPC 抛给渲染层，工具转成结构化错误）。
   */
  async function apply(action, payload) {
    const key = String(action == null ? '' : action).trim();
    if (key === 'request_credential') {
      throw new Error('request_credential 不是 store 变更，只能经 applyToolRequest 触发界面');
    }
    const p = payload && typeof payload === 'object' ? payload : {};
    const pkg = packageOps[key];
    if (pkg) {
      if (typeof store[pkg.method] !== 'function') {
        throw new Error(`当前 MCP store 不支持「${key}」（缺少 ${pkg.method}）`);
      }
      const out = await store[pkg.method](...pkg.args(p));
      // 只有 check_update 不改磁盘；装/升级后必须重挂，否则工具表还指向旧包
      if (key !== 'check_update') await reload();
      return out;
    }
    const run = changes[key];
    if (!run) throw new Error(`未知操作「${key}」，可用：${MCP_MANAGE_ACTIONS.join(' / ')}`);
    const result = run(p);
    // token 落在加密凭据库而不是 mcp.json：仍走 updateMcpServerConfig 这个唯一写入口，
    // 必须在 reload 之前 —— 会话签名包含凭据，晚了就还是用旧签名建连。
    if (key === 'add' && p.token != null) {
      store.updateMcpServerConfig(userDataPath, { id: p.id, token: String(p.token) });
    }
    if (key !== 'list') await reload();
    return result;
  }

  /**
   * 「请用户填凭据」：只把请求送到界面，模型拿不到明文。
   *
   * 缺这一步时，带鉴权的服务只能加到一半——`add` 写了 url，token 却没人能填：
   * 用户得自己想到去设置页找那条服务，Agent 既不能触发也不能确认结果。
   * 现在 Agent 发起 → 界面弹同一个 MCP 配置弹窗（人填、凭据库加密存）→ Agent 用 `list` 复查 configured。
   */
  function requestCredential(a, notify) {
    const id = String((a && a.id) || '').trim();
    if (!id) return { ok: false, error: 'request_credential 需要 id', errorCode: 'MCP_BAD_REQUEST' };
    const server = store.listMcpServersForUi(userDataPath).find((s) => s.id === id);
    if (!server) {
      return {
        ok: false,
        error: `没有这个服务：${id}（先用 action=list 看现有 id；新服务要 add 之后才谈凭据）`,
        errorCode: 'MCP_SERVER_NOT_FOUND'
      };
    }
    const defs = Array.isArray(server.envHints) ? server.envHints : [];
    const fields = defs
      .map((d) => String((d && d.name) || '').trim())
      .filter(Boolean);
    const remote = server.transportKind === 'remote' || !!server.remoteUrl;
    if (!fields.length && remote) fields.push('token');
    const send = typeof notify === 'function' ? notify : notifyCredentialRequest;
    if (!send) {
      return {
        ok: false,
        error: '界面未就绪，无法弹出输入框（可在设置 → 技能 → MCP 里手动填写）',
        errorCode: 'MCP_CREDENTIAL_UI_UNAVAILABLE'
      };
    }
    try {
      send({
        serverId: id,
        name: server.name || id,
        fields,
        reason: String((a && a.reason) || '').trim()
      });
    } catch (err) {
      return {
        ok: false,
        error: String((err && err.message) || err || '无法弹出输入框'),
        errorCode: 'MCP_CREDENTIAL_UI_UNAVAILABLE'
      };
    }
    return {
      ok: true,
      action: 'request_credential',
      id,
      requested: true,
      fields,
      note: `已在界面上为「${server.name || id}」打开凭据输入框，等用户填写并保存。**别让用户把 Key 贴进对话**；保存后用 action=list 复查该服务 configured 是否变 true。`
    };
  }

  /** Agent 工具入口：收工具参数，回一份小而确定的摘要。 */
  async function applyToolRequest(request, opts) {
    const { action, payload } = toStoreRequest(request);
    if (action === 'request_credential') {
      return requestCredential(request, opts && opts.notifyCredentialRequest);
    }
    const applied = await apply(action, payload);
    // 包运维的实际结论在 `applied` 里（store 会回 `{ok:false, message}` 这种"动作跑了但没修好"）。
    // 那是失败就得报失败：外层套个 ok:true 再配一句"已完成"，模型会以为问题解决了。
    if (MCP_PACKAGE_ACTIONS.includes(action) && applied && applied.ok === false) {
      return {
        ok: false,
        action,
        id: payload.id || '',
        error: String(applied.message || applied.error || '包运维未成功'),
        errorCode: 'MCP_PACKAGE_FAILED',
        retryable: false,
        result: applied
      };
    }
    const servers = store.listMcpServersForUi(userDataPath);
    const note = MCP_PACKAGE_ACTIONS.includes(action)
      ? action === 'check_update'
        ? '只是查了版本（没改任何文件）。要升级用 upgrade_package，版本号从这里的 latestVersion 取。'
        : '包运维已完成并重挂了 MCP 会话：下一轮工具表按新包装载。'
      : action === 'list'
        ? 'enabled=true 且 configured=true 的服务，其工具会以 mcp_<serverId>__<tool> 出现在工具表里（可用 mcp_tool_schema 检索具体名字）。'
        : '已写盘并重建 MCP 会话：下一轮工具表里就会出现（或消失）该服务的 mcp_<serverId>__* 工具。';
    return {
      ok: true,
      action,
      id: payload.id || '',
      ...(applied && applied.action ? { applied: applied.action } : {}),
      // 包运维的结论（版本 / 安装根目录 / 失败诊断）原样带回，别让模型猜
      ...(MCP_PACKAGE_ACTIONS.includes(action) && applied && typeof applied === 'object'
        ? { result: applied }
        : {}),
      servers: summarizeServers(servers),
      note
    };
  }

  return { apply, applyToolRequest, reload };
}

module.exports = {
  createMcpManager,
  MCP_MANAGE_ACTIONS,
  toStoreRequest
};
