'use strict';

/**
 * headless 的装配点：**只把既有工厂接起来**，不复制任何一处逻辑。
 *
 * 桌面那份装配在 `src/main-entry.js`（app.whenReady 里，夹着窗口/托盘/自动更新/工位监控…），
 * 纯 Node 入口既不能 require 也不能照抄。这里按「无窗口时仍然成立的部分」重新接一遍：
 *
 *   userData 目录 → LocalGateway（工具/文件/索引 RPC 面）
 *                → dieyun-core（循环账本 / memory / index）
 *                → MCP 运行时与目录
 *                → 工具桥（webContents=null）+ 压缩 Agent
 *                → AgentService + 本地执行器（Main 侧跑一轮）
 *                → 可选：内网 agent 互通（`src/peer/boot.js`，与桌面同一份装配）
 *                → 可选：浏览器前端（MobileBridge）、定时计划调度器
 *
 * 与桌面**必须一致**的东西都在下面的依赖里取自同一份实现：
 * `app-paths`（目录）、`gateway/server`（RPC 与沙箱）、`bootMcpSkillCatalogs` 与
 * `createMcpManager`（MCP）、`tool-bridge-main`（工具执行）、`compaction-main`（压缩）、
 * `agent/main-turn-runner`（一轮对话）。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const { resolveUserDataDir } = require('../app-paths');
const { LocalGateway } = require('../gateway/server');
const { createCoreBridge } = require('../core-bridge');
const { resolveDieyunCoreBinary, isRustCoreEnabled } = require('../core-bridge-path');
const { ensureAgentHomeDirs, dieyunDefaultWorkspaceDir } = require('../agent-home');
const { scheduleDefaultWorkspaceGc } = require('../default-workspace-gc');
const { ensureDieyunMdInHome } = require('../dieyun-instructions');
const { createMcpStore } = require('../mcp/store');
const { createMcpManager } = require('../mcp/manage');
const { bootMcpSkillCatalogs } = require('../main/mcp-plans-boot');
const { createMainToolBridge } = require('../agent/tool-bridge-main');
const { createMainCompactionAgent } = require('../agent/compaction-main');
const { AgentService } = require('../agent/service');
const { MobileBridge } = require('../mobile/bridge');
const { createSecretStorage } = require('./secret-storage');
const { createLocalExecutor } = require('./local-executor');
const { bootPeerRuntime } = require('../peer/boot');
const { createSharedMemoryService } = require('../memory-shared/service');
const { getAgentLimits } = require('../agent/agent-limits');
const { loadModelSettings, getEmbeddingConfig } = require('../model-settings');
const { createEmbeddingClient, setEmbeddingCoreBridge } = require('../codebase/embedding-client');
const { setLlmCompleteBridge } = require('../agent/llm-complete');

/** 无窗口时必然没有的能力：启动日志里如实打一行，而不是加一个开关表 */
const UNAVAILABLE_CAPABILITIES = [
  'browser_*（需 Electron 内嵌浏览器）',
  'computer_*（需桌面截图 / 输入）',
  'camera_look（需手机端连接）',
  'desktop_camera_look（需本机摄像头与 ffmpeg）',
  'desktop_camera_ptz（需带云台的本机摄像头：DirectShow / v4l2-ctl）',
  'agent_clarify / session_new / session_set_workspace（Renderer-only）'
];

/**
 * 端口是否已被监听（只看「有没有人在听」，不区分是谁）——启动告警用，不做鉴权/判定。
 * @param {string} host
 * @param {number} port
 * @returns {Promise<boolean>}
 */
function isPortBusy(host, port, timeoutMs = 400) {
  const net = require('net');
  return new Promise((resolve) => {
    const sock = net.connect({ host, port });
    const done = (busy) => {
      try {
        sock.destroy();
      } catch {
        // ignore
      }
      resolve(busy);
    };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => done(true));
    sock.once('timeout', () => done(false));
    sock.once('error', () => done(false));
  });
}

/**
 * @param {{
 *   userData?: string,
 *   workspace?: string,
 *   sandbox?: string,
 *   web?: boolean,
 *   host?: string,
 *   port?: number,
 *   plans?: boolean,
 *   model?: string,
 *   route?: string,
 *   secretKeyFile?: string,
 *   requireCore?: boolean,
 *   log: any
 * }} opts
 */
async function bootHeadless(opts) {
  const log = opts.log || (() => {});
  // 目录解析只有 app-paths 一处：`DIEYUN_USER_DATA` > `--user-data` > 平台默认。
  const userData = resolveUserDataDir({ overrideDir: opts.userData });
  fs.mkdirSync(userData, { recursive: true });

  // 工作空间：命令行 --workspace > DIEYUN_WORKSPACE > ~/.dieyun/workspace。
  // 服务端 unit 里是 `${DIEYUN_WORKSPACE}` 展开成 --workspace，两个入口必须同一个含义，
  // 否则手工跑 CLI 会写到默认目录（真机踩过：服务的工作空间配在 /run/media/…，
  // 命令行却把文件写进了 ~/.dieyun/workspace，两边各一套）。
  const workspacePath = path.resolve(
    opts.workspace || String(process.env.DIEYUN_WORKSPACE || '').trim() || dieyunDefaultWorkspaceDir()
  );
  fs.mkdirSync(workspacePath, { recursive: true });

  // 凭据加密密钥：`--secret-key` 显式给，否则读文档声明的唯一环境入口
  // `DIEYUN_SECRET_KEY_FILE`（systemd EnvironmentFile / 启动器都写它）。
  const secretStorage = createSecretStorage({
    keyFile: opts.secretKeyFile || String(process.env.DIEYUN_SECRET_KEY_FILE || '').trim(),
    log: (m) => log.warn(m)
  });
  if (!secretStorage.isEncryptionAvailable()) {
    log.warn('未配置 DIEYUN_SECRET_KEY_FILE：MCP / SSH / 频道凭据将无法保存（不会回退明文）');
  }

  const readableDir = path.join(userData, 'gateway-readable');
  const gateway = new LocalGateway({
    userDataPath: userData,
    readableDir,
    extraReadRoots: [],
    // `--sandbox` 只是**本次运行**的覆盖，不写 host-permissions.json：
    // 无人值守跑一次 danger-full-access 不该把桌面端同目录的档位一起改掉。
    sandboxModeOverride: opts.sandbox || undefined,
    log: (m) => log.info(m),
    logDebug: (m) => log.debug(m)
    // 故意不注入 requestSandboxApproval：没有窗口可问 ⇒ 越界动作 fail-closed（见 docs/SANDBOX.md）
  });
  if (opts.sandbox) {
    log.info(`沙箱档位已覆盖（仅本次运行，未落盘）：${gateway.getSandboxMode()}`);
  } else {
    log.info(`沙箱档位：${gateway.getSandboxMode()}（无审批通道，越界动作一律拒绝）`);
  }

  // dieyun-core：Agent / memory / index 的唯一实现，缺了就没有循环（不做 JS 回退）
  let coreBridge = null;
  if (isRustCoreEnabled()) {
    const bin = resolveDieyunCoreBinary();
    if (bin) {
      coreBridge = createCoreBridge({
        binaryPath: bin,
        log: (m) => log.info(m)
      });
      await coreBridge.start();
      gateway.setRustCore(coreBridge);
      // 无界面入口同样要接上向量桥（否则 headless 的召回 / 建库始终没有向量通道）
      setEmbeddingCoreBridge(coreBridge);
    setLlmCompleteBridge(coreBridge);
      log.info(`dieyun-core 已启动：${bin}`);
    }
  }
  if (!coreBridge && opts.requireCore !== false) {
    const e = new Error(
      'dieyun-core 未就绪：请设置 DIEYUN_CORE_BIN 或把 bin/dieyun-core 放到探测路径（见 docs/HEADLESS.md）'
    );
    e.code = 'CORE_UNAVAILABLE';
    throw e;
  }

  ensureAgentHomeDirs(userData, workspacePath);
  try {
    const r = ensureDieyunMdInHome();
    if (r && r.created) log.info(`已创建 dieyun.md：${r.path}`);
  } catch (err) {
    log.warn(`dieyun.md 初始化失败：${(err && err.message) || err}`);
  }
  // 默认工作区回收：与桌面同一份语义（src/default-workspace-gc.js）。headless 常年不退出，
  // 更是这一趟周期回收的主要受益者。
  scheduleDefaultWorkspaceGc({ log, limits: getAgentLimits(userData, 'default') });

  // MCP：凭据走 secret-storage 替身；没有界面，凭据缺失时工具层会明确报「需要重新填写」
  const mcpStore = createMcpStore({ safeStorage: secretStorage });
  const { mcpRuntime, mcpCatalog, skillCatalog } = bootMcpSkillCatalogs({
    userData,
    mcpStore,
    getLocalGateway: () => gateway,
    log
  });
  const mcpManager = createMcpManager({
    userDataPath: userData,
    mcpStore,
    getRuntime: () => mcpRuntime
  });

  const compactionAgent = createMainCompactionAgent(userData, coreBridge);

  /** 晚绑定：mobileBridge / plansStore 在本函数后半段才就绪 */
  let mobileBridge = null;
/** 浏览器里的桌面界面（Electron 渲染层 + preload 替身）；只在 --web 时装配 */
let desktopUi = null;
  let plansBoot = null;
  /**
   * 内网 agent 互通：装配在 `src/peer/boot.js`（与桌面同一份），这里只持有引用。
   * 必须在 `createToolBridge` 被**第一次调用之前**赋值 —— 工具桥在创建时取一次
   * `deps.peerCoordinator`（`src/agent/tool-bridge-main.js`），拿到 null 就整轮没有 peer_*。
   * 所以它在 AgentService 之后、任何一轮开始之前装配。
   */
  let peerCoordinator = null;

  const createToolBridge = () =>
    createMainToolBridge({
      gateway,
      // 没有 Renderer：Renderer-only 工具会 fail-fast（RENDERER_UNAVAILABLE），
      // 且它们本来就不在 Main 侧工具表里，模型拿不到这些 schema。
      webContents: null,
      mcpRuntime,
      mcpManager,
      plansStore: plansBoot ? plansBoot.plansStore : null,
      getPlansScheduler: () => (plansBoot ? plansBoot.plansScheduler : null),
      // --plans 没开时（没有计划运行时）这两个回调不会有人调，但仍要给兜底实现
      finishPlanRun: (plan, result) => (plansBoot ? plansBoot.finishPlanRun(plan, result) : result),
      cancelPlanRun: (planId) => (plansBoot ? plansBoot.cancelPlanRun(planId) : { ok: false }),
      userDataPath: userData,
      getMobileBridge: () => mobileBridge,
      peerCoordinator
    });

  // 共享记忆（跨机 PostgreSQL）：数据层唯一实现 `src/memory-shared/service.js`，
  // 与桌面端（`src/main-entry.js`）同一份装配参数。默认开启，口令由「设置 → 扩展 → 共享记忆」填；
  // 探活失败 = 本轮及以后按关闭处理（fail-open：不重试、不阻塞对话）。
  // 桌面端有 `safeStorage`，headless 用 `src/headless/secret-storage.js`（同一形状，
  // 缺 `DIEYUN_SECRET_KEY_FILE` 时 `isEncryptionAvailable() === false`，按既有语义拒绝保存、不落明文）。
  const sharedMemory = createSharedMemoryService({
    userDataPath: userData,
    safeStorage: secretStorage,
    nodeId: os.hostname(),
    hostname: os.hostname(),
    clientVersion: String((require('../../package.json') || {}).version || ''),
    limits: () => getAgentLimits(userData),
    // 向量复用「设置 → 模型 → 向量索引」的端点：没配就没有向量，召回自动落到文本排名
    embedding: () => {
      try {
        return createEmbeddingClient(getEmbeddingConfig(loadModelSettings(userData)));
      } catch {
        return null;
      }
    },
    log: { info: (msg) => log.info(msg), warn: (msg) => log.warn(msg) }
  });
  void sharedMemory.probe();

  const agentService = new AgentService({
    gateway,
    userDataPath: userData,
    log: (m) => log.info(m)
  });
  const executor = createLocalExecutor({
    agentService,
    userData,
    getGateway: () => gateway,
    getCoreBridge: () => coreBridge,
    getMcpRuntime: () => mcpRuntime,
    getCompactionAgent: () => compactionAgent,
    createToolBridge,
    workspacePath,
    model: opts.model || '',
    route: opts.route || '',
    runSource: 'headless',
    listMcpServers: mcpStore.listMcpServersForUi,
    // 频道 / 定时计划 / headless 的轮次与桌面走同一份装配（`main-turn-runner` 读这个）
    getSharedMemory: () => sharedMemory,
    log
  });
  agentService.setExecutor(executor.executor);
  agentService.setCanceller(executor.canceller);

  // 内网 agent 互通：与桌面装配的是同一份（`src/peer/boot.js`）—— 服务器也是一台可以
  // 被呼叫 / 主动派活的 agent，没有界面不该等于没有信道。开关不新增：仍是
  // `<userData>/peer/settings.json` 的 enabled / autoTurn（默认都开），信任清单同目录
  // `trusted-peers.json`（服务器上没有「设置」页，只能手工维护这两份文件，见 docs/HEADLESS.md）。
  peerCoordinator = bootPeerRuntime({
    userDataPath: userData,
    // 服务器上没有「确认对方」的按钮：授权默认值由 unattended 落成 autoTrust=true
    // （首次启动写进 peer/settings.json，之后人改的值优先；明确 deny 仍拦）。
    unattended: true,
    // 取 Gateway **当前**的工作空间：`session_set_workspace` 换过项目后，
    // 「同项目」判定要跟着变，否则服务器会一直用启动时的目录去比。
    getWorkspace: () => {
      try {
        const ws = gateway.getWorkspace();
        return { workspacePath: ws && ws.workspacePath ? String(ws.workspacePath) : workspacePath };
      } catch {
        return { workspacePath };
      }
    },
    rpc: (method, params) => gateway.invokeRpc(method, params),
    submitTask: (task) => agentService.submitTask(task),
    agentService,
    limits: () => getAgentLimits(userData),
    log
  });

  gateway.setWorkspace(workspacePath);
  // 端口被占**不是**致命错误：本地 Gateway WS 只是桌面端 Renderer 的接口，headless 自己
  // 走 `invokeRpc` 不经过它。但被占通常意味着「同一个数据目录已经有另一个进程在用」，
  // 这条告警比让它静默失败有用（不引入锁文件：那会是第二套「谁在跑」的真相）。
  const portBusy = await isPortBusy('127.0.0.1', gateway.port);
  if (portBusy) {
    log.warn(
      `本地 Gateway 端口 ${gateway.port} 已被占用：可能已有另一个叠云进程在使用同一数据目录（或桌面端正在运行）。` +
        ' headless 自身不受影响，但两个进程同时读写同一数据库会让索引重复监听。'
    );
  }
  gateway.start();

  if (opts.plans) {
    const { bootPlansRuntime } = require('../main/mcp-plans-boot');
    plansBoot = bootPlansRuntime({
      userData,
      getLocalGateway: () => gateway,
      getCoreBridge: () => coreBridge,
      getMcpRuntime: () => mcpRuntime,
      // 没有窗口 / 托盘：计划事件静默丢弃（只少 UI 提示，不影响执行与落库）
      getWindowTray: () => null,
      getTrayNotify: () => null,
      createToolBridge,
      ensureMainCompactionAgent: () => compactionAgent,
      log
    });
    log.info('定时计划调度器已启动');
  }

  if (opts.web) {
    // MobileBridge 在**构造时**读这两个环境变量，所以必须先落环境再 new。
    // 缺省只听回环：服务器上的 0.0.0.0 + 单 token 不是个好默认，要对外请显式 --host。
    process.env.DIEYUN_MOBILE_HOST = String(opts.host || process.env.DIEYUN_MOBILE_HOST || '127.0.0.1');
    if (opts.port) process.env.DIEYUN_MOBILE_PORT = String(opts.port);
    mobileBridge = new MobileBridge({
      agentService,
      userDataPath: userData,
      log: (m) => log.info(m)
    });
    // 浏览器里的桌面界面要在服务器上跑「渲染层驱动的那一轮」：循环仍是同一份
    // `runRustAgentLoop`，工具仍是同一份 `createMainToolBridge`
    const { createDesktopTurn } = require('./desktop-turn');
    mobileBridge.desktopTurn = createDesktopTurn({
      gateway,
      getCoreBridge: () => coreBridge,
      createToolBridge,
      getCompactionAgent: () => compactionAgent,
      userData,
      // 内网互通面板在网页里同样可用：`peer.*` 走同一张动作表（src/peer/actions.js）
      getPeerCoordinator: () => peerCoordinator,
      // 浏览器里那一轮也要和桌面同一份装配：共享记忆召回、AGENTS.md / 记忆 / 技能 / MCP 块
      getSharedMemory: () => sharedMemory,
      listMcpServers: mcpStore.listMcpServersForUi,
      getKnowledgeMaintainer: () => require('../agent/knowledge-maintainer').getActiveKnowledgeMaintainer(),
      loadModelSettings,
      // 网页里保存模型设置 = 改服务器上的 model-settings.json；收尾时把语音设置推给手机端
      // （与桌面 model:sync-settings 同一份实现 model-settings-apply.js）
      getMobileBridge: () => mobileBridge,
      getAgentService: () => agentService,
      log: (m) => log.info(m)
    });
    try {
      await mobileBridge.start();
    } catch (err) {
      // `--web` 的唯一目的就是提供界面：监听失败就必须让进程失败退出，
      // 不能打印一个点不开的 URL 让运维以为服务是好的。
      const e = new Error(
        `Web 界面启动失败（${process.env.DIEYUN_MOBILE_HOST}:${process.env.DIEYUN_MOBILE_PORT || ''} 无法监听）：` +
          `${(err && err.message) || err}`
      );
      e.code = 'WEB_LISTEN_FAILED';
      e.userSafe = true;
      throw e;
    }
    const info = mobileBridge.getInfo();
    log.info(`Web 界面：http://${info.host}:${info.port}/#token=${info.token}`);
    if (info.host === '0.0.0.0' || info.host === '::') {
      log.warn('Web 监听在所有网卡上：访问控制只有 URL 里的 token，请自行在反代上加认证/TLS');
    }
    // 桌面界面（Electron 渲染层）当网页提供：同一个端口、同一个 token，走 /app/
    try {
      const { createDesktopUi } = require('./desktop-ui');
      desktopUi = createDesktopUi({
        packageRoot: path.join(__dirname, '..', '..'),
        getGatewayInfo: () => gateway.getInfo(),
        getWebToken: () => info.token,
        // 取 **Gateway 当前**的工作区根而不是启动参数：浏览器版可以点「工作空间 → 本地」换目录
        // （`desktop.set_workspace`），换完刷新页面必须看到新目录，否则页面显示和实际写入分叉。
        getWorkspace: () => {
          const ws = gateway.getWorkspace();
          return ws && ws.kind === 'local' ? ws.workspacePath || '' : '';
        },
        // 模型配置的唯一来源仍是 model-settings.json（与 Main 同一份读写规则）
        getModelSettings: () => require('../model-settings').loadModelSettings(userData),
        getPermissions: () => gateway.getPermissions(),
        getRustCoreReady: () => !!(coreBridge && typeof coreBridge.isReady === 'function' && coreBridge.isReady()),
        log: (m) => log.info(m)
      });
      mobileBridge.extraHttp = desktopUi.handleHttp;
      mobileBridge.upgradeHook = desktopUi.handleUpgrade;
      log.info(`桌面界面（浏览器版）：http://${info.host}:${info.port}/app/?token=${info.token}`);
      // 互通事件推送：桌面走 `peer:event` IPC，网页走同源 `/ws` 的 event 帧。
      // 打上 `channel:'peer'` 分流 —— 聊天轮的 phase 事件与面板事件共用这一条流，
      // 不标记的话面板事件会被 loop 的处理器当成 phase（反之亦然）。
      if (peerCoordinator) {
        peerCoordinator.on('event', (event) => {
          if (!mobileBridge) return;
          try {
            mobileBridge.broadcast({ channel: 'peer', event });
          } catch {
            // 推送失败只影响面板刷新，不影响互通本身
          }
        });
      }
    } catch (e) {
      // 桌面界面只是「附带提供一个界面」，起不来不该拖垮 headless 本体（手机端/CLI 照常可用）
      log.warn(`桌面界面未启用：${e && e.message}`);
    }
  }

  log.info(`工作空间：${workspacePath}`);
  log.info(`数据目录：${userData}`);
  log.info(`无窗口模式不可用的能力：${UNAVAILABLE_CAPABILITIES.join('、')}`);

  let stopped = false;
  async function stop() {
    if (stopped) return;
    stopped = true;
    executor.abortAll();
    if (plansBoot && plansBoot.plansScheduler && typeof plansBoot.plansScheduler.clearAll === 'function') {
      try {
        plansBoot.plansScheduler.clearAll();
      } catch {
        // ignore
      }
    }
    if (mobileBridge) {
      try {
        mobileBridge.stop();
      } catch {
        // ignore
      }
      mobileBridge = null;
    }
    if (peerCoordinator) {
      try {
        peerCoordinator.stop();
      } catch {
        // ignore
      }
      peerCoordinator = null;
    }
    try {
      gateway.stop();
    } catch {
      // ignore
    }
    if (mcpRuntime && typeof mcpRuntime.shutdown === 'function') {
      await mcpRuntime.shutdown().catch(() => {});
    }
    // 连接池要显式关，否则 --web 重启时旧 socket 会挂着等超时
    if (sharedMemory && typeof sharedMemory.dispose === 'function') {
      try {
        sharedMemory.dispose();
      } catch {
        // ignore
      }
    }
    if (coreBridge) {
      await coreBridge.stop().catch(() => {});
      coreBridge = null;
    }
  }

  return {
    userData,
    workspacePath,
    gateway,
    coreBridge,
    mcpRuntime,
    mcpCatalog,
    skillCatalog,
    mcpManager,
    mcpStore,
    secretStorage,
    sharedMemory,
    compactionAgent,
    agentService,
    executor,
    get mobileBridge() {
      return mobileBridge;
    },
    get peer() {
      return peerCoordinator;
    },
    get plans() {
      return plansBoot;
    },
    createToolBridge,
    stop
  };
}

module.exports = { bootHeadless, UNAVAILABLE_CAPABILITIES };
