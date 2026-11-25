'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const DEB_PACKAGE = 'dieyun-headless';
const { compareSemver } = require('../mcp/package-store');

/**
 * 跑 apt 时**强制 C locale**：apt 的结论是人话（可翻译），而我们的解析是英文正则。
 * 真机现场（2026-11-08，Ubuntu 26.04 / zh_CN）：中文环境里 `is already the newest version`
 * 变成「已经是最新版」，于是「已是最新」被误报成
 * 「检查更新失败：升级了 0 个软件包…」。解析本地化文案是死路（每种语言一份），
 * 所以固定成 C —— 别让运行环境决定结论。
 */
const APT_ENV = { ...process.env, LC_ALL: 'C', LANG: 'C', LANGUAGE: 'C' };

/**
 * 解析 `apt-get -s install --only-upgrade <pkg>` 的输出（纯函数，可单测）。
 *
 * 三种形态（都以 C locale 为准）：
 *  - 已是最新：`dieyun-headless is already the newest version (0.1.75).`
 *  - 有新版本：`Inst dieyun-headless [0.1.75] (0.1.76 headless:headless [amd64])`
 *  - **同版本对齐**：`Inst dieyun-headless [0.1.75] (0.1.75 …)` —— 手工 dpkg 装过、apt 想把
 *    它跟归档里的同版本对齐时会出现。这不是「有新版本」，比版本号才判定，否则界面会谎报。
 *
 * 认不出的输出返回 `ok:false`（可带 `reason`），绝不假装「已是最新」。
 *
 * @param {string} stdout
 * @param {string} pkg
 * @returns {{ ok: boolean, upgradable: boolean, currentVersion: string, nextVersion: string, reason?: string }}
 */
function parseAptUpgradeSimulation(stdout, pkg) {
  const text = String(stdout || '');
  const escaped = pkg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const inst = new RegExp(`^Inst\\s+${escaped}\\s+\\[([^\\]]+)\\]\\s+\\(([^\\s)]+)`, 'm').exec(text);
  if (inst) {
    const current = inst[1];
    const next = inst[2];
    // 只有「确实更新」才算可升级（同版本重装不算）
    if (compareSemver(next, current) > 0) {
      return { ok: true, upgradable: true, currentVersion: current, nextVersion: next };
    }
    return { ok: true, upgradable: false, currentVersion: current, nextVersion: '' };
  }
  const newest = new RegExp(`${escaped} is already the newest version \\(([^)]+)\\)`).exec(text);
  if (newest) {
    return { ok: true, upgradable: false, currentVersion: newest[1], nextVersion: '' };
  }
  // 明确「这台机器没这个包 / 没这个候选」：原因要带出来，别只丢一行 apt 摘要
  if (/Unable to locate package/i.test(text)) {
    return { ok: false, upgradable: false, currentVersion: '', nextVersion: '', reason: 'NO_PACKAGE' };
  }
  if (new RegExp(`${escaped} is not installed`, 'i').test(text)) {
    return { ok: false, upgradable: false, currentVersion: '', nextVersion: '', reason: 'NOT_INSTALLED' };
  }
  return { ok: false, upgradable: false, currentVersion: '', nextVersion: '' };
}

/**
 * 解析 `apt-cache policy <pkg>`（C locale）里的「已安装 / 候选 / 有没有真配源」。
 *
 * 为什么要这一步：服务器上只 `dpkg -i` 装过 deb、**没配 apt 源**时，版本表里只有
 * `/var/lib/dpkg/status` 这一条 —— 那时「已是最新版本」是句**谎话**：真相是「我看不到任何
 * 新版本」。两者对运维的含义完全不同（后者得先去配源），所以这里把来源一起读出来。
 *
 * @param {string} stdout
 * @returns {{ installed: string, candidate: string, fromRepo: boolean, known: boolean }}
 */
function parseAptPolicy(stdout) {
  const text = String(stdout || '');
  const installed = /^\s*Installed:\s*(\S+)/m.exec(text);
  const candidate = /^\s*Candidate:\s*(\S+)/m.exec(text);
  const tableAt = text.indexOf('Version table:');
  const table = tableAt >= 0 ? text.slice(tableAt + 'Version table:'.length) : '';
  // 版本表里的来源行：`        100 /var/lib/dpkg/status`（只有本地记录）或
  // `        500 http://host/repo ./ Packages`（真配了源，源后面还跟 suite/component）。
  // 取优先级后面那一个 token 判断来源，别要求整行只有两个字段。
  const origins = [...table.matchAll(/^\s+\d+\s+(\S+)(?:\s+.*)?$/gm)].map((m) => m[1]);
  const fromRepo = origins.some((o) => !/\/var\/lib\/dpkg\/status$/.test(o));
  return {
    installed: installed ? installed[1] : '',
    candidate: candidate ? candidate[1] : '',
    fromRepo,
    known: !!(installed || candidate)
  };
}

/**
 * 跑一条只读 apt 命令（不需要 root）。失败时返回 `{ error }`，不抛。
 * @param {string} bin
 * @param {string[]} args
 * @param {number} [timeoutMs]
 * @returns {{ stdout?: string, stderr?: string, error?: string }}
 */
function runApt(bin, args, timeoutMs = 20000) {
  try {
    const res = spawnSync(bin, args, { encoding: 'utf8', timeout: timeoutMs, env: APT_ENV });
    if (res && res.error) return { error: res.error.message || String(res.error) };
    return { stdout: String((res && res.stdout) || ''), stderr: String((res && res.stderr) || '') };
  } catch (e) {
    return { error: (e && e.message) || `无法执行 ${bin}` };
  }
}

/**
 * 浏览器里的桌面界面（`/app/`）跑一轮对话。
 *
 * 为什么需要这一层（别再想别的办法绕开）：
 *  - 桌面窗口里，聊天轮是 `Renderer → preload IPC → Main`，Main 用 `runRustAgentLoop` 驱动
 *    Rust `agent.loop.*`，工具在 Main 执行。Renderer 负责拼 prompt / 选模型 / 展示。
 *  - 浏览器里没有 Main，也没有 IPC。但**循环只有一份实现**（`src/agent/rust-loop-runner.js`），
 *    所以这里不是「再写一个循环」，而是把 Main 那个 handler（`agent:rust-loop-run`）在这台
 *    服务器上等价地跑一遍：拿渲染层送上来的 messages/tools/apiConfig，交给同一个
 *    `runRustAgentLoop`，工具交给同一份 `createMainToolBridge()`，phase 事件推回浏览器。
 *  - 结果形状与 `agent:rust-loop-run` 保持一致（`content` / `trace` / `messages` /
 *    `hitRoundLimit`），渲染层不用改。
 *
 * 传输：手机端桥的 `/ws`（同一套 `{type:'call'|'result'|'event'}` 线协议），因为浏览器里
 * 那是唯一一条能跟 Main 侧说话的通道；phase 走 `event` 帧，按 `cancelToken` 归属到各自页面。
 *
 * @param {{
 *   gateway: { invokeRpc: Function },
 *   getCoreBridge: () => any,
 *   createToolBridge: () => any,
 *   getCompactionAgent: () => any,
 *   userData: string,
 *   loadModelSettings: (userData: string) => object,
 *   getSharedMemory?: () => any,
 *   getKnowledgeMaintainer?: () => any,
 *   getMobileBridge?: () => any,   // 保存模型设置后要推语音设置给手机端
 *   getAgentService?: () => any,   // 语音设置载荷的唯一来源
 *   log?: (msg: string) => void
 * }} deps
 */
function createDesktopTurn(deps) {
  const { gateway, getCoreBridge, createToolBridge, getCompactionAgent, userData } = deps;
  const loadModelSettings =
    typeof deps.loadModelSettings === 'function'
      ? deps.loadModelSettings
      : (ud) => require('../model-settings').loadModelSettings(ud);
  const log = typeof deps.log === 'function' ? deps.log : () => {};

  const { runRustAgentLoop } = require('../agent/rust-loop-runner');
  const { resolveLoopToolCallLimit, resolveAgentMaxRounds } = require('../agent/agent-limits');
  const { applyTierRuntime, resolveContextTierIdFromSettings } = require('../agent/model-runtime-by-tier');
  const { getEffectiveInputBudget } = require('../agent/compaction-main');
  const { buildLoopCompactionHandler } = require('../agent/compaction-loop');
  const { isAbortError } = require('../llm-reconnect-retry');
  const { clearToolHarnessSessionsForSession } = require('../agent/tool-harness');
  const { buildPrepSystemPromptDeps } = require('../agent/system-prompt-prep-main');
  const { createSharedMemoryActions } = require('../memory-shared/actions');
  // 设置页「检测」的 payload → 结果只此一份（桌面 IPC `models:fetch-list` 也用它）
  const { detectModelsFromPayload } = require('../openai-models');
  // 「模型设置变了」之后的收尾（落盘 / 推语音设置 / core 重读配置）同样只此一份
  const { applyModelSettings } = require('../model-settings-apply');
  const { createPeerActions } = require('../peer/actions');

  // 「共享记忆」五个动作与桌面 IPC 共用同一份实现（`src/memory-shared/actions.js`），
  // 这里只做传输转发，不复制判定/SQL/模型调用。
  const sharedMemoryActions = createSharedMemoryActions({
    getSharedMemory: () => (typeof deps.getSharedMemory === 'function' ? deps.getSharedMemory() : null),
    getKnowledgeMaintainer: () =>
      typeof deps.getKnowledgeMaintainer === 'function' ? deps.getKnowledgeMaintainer() : null,
    log: { info: (m) => log(m), warn: (m) => log(m) }
  });

  // 内网 agent 互通的二十来个动作同样只有一份实现（`src/peer/actions.js`）：
  // 桌面走 IPC（`src/main/ipc/peer.js`），浏览器界面走这里转发的 `peer.*`。
  // 面板代码只有一套，所以两侧必须共用同一张动作表，否则必然出现「桌面能点、网页空白」。
  const peerActions = createPeerActions(() =>
    typeof deps.getPeerCoordinator === 'function' ? deps.getPeerCoordinator() : null
  );

  /** cancelToken → { abortController, sessionId } */
  const running = new Map();

  /** 服务账号名（报错里要说清「谁没有权限」，而不是让人猜） */
  const serviceUser = (() => {
    try {
      return os.userInfo().username;
    } catch {
      return 'dieyun';
    }
  })();

  /**
   * @param {object} payload 渲染层 `agentRustLoopRun` 的参数
   * @param {(frame: object) => void} sendPhase 推 phase 事件（event 帧）
   */
  async function runTurn(payload, sendPhase) {
    const coreBridge = getCoreBridge();
    if (!coreBridge || typeof coreBridge.isReady !== 'function' || !coreBridge.isReady()) {
      throw new Error('dieyun-core 未就绪');
    }
    const p = payload && typeof payload === 'object' ? payload : {};
    const cancelToken = String(p.cancelToken || `rl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`);
    const sessionId = p.sessionId || (p.startParams && p.startParams.sessionId) || undefined;
    const model = p.model || (p.startParams && p.startParams.model) || '';

    const rawSettings = loadModelSettings(userData);
    const contextTierId = p.contextTierId || resolveContextTierIdFromSettings(rawSettings, model);
    const runSettings = applyTierRuntime(rawSettings, userData, { tierId: contextTierId, model });
    const llmModel = model || runSettings.textModel || '';
    if (!llmModel) throw new Error('未选择模型');
    const tokenBudget = getEffectiveInputBudget(runSettings, llmModel);

    const apiConfig = p.apiConfig && typeof p.apiConfig === 'object' ? p.apiConfig : {};
    const baseUrl = apiConfig.baseUrl || runSettings.baseUrl;
    const apiKey = apiConfig.apiKey || runSettings.apiKey;
    // 逐字段重建会丢 headers / authMode / userAgent（与 Main handler 同一条注意点）
    const apiCfg = { ...apiConfig, baseUrl, apiKey, model: llmModel, sessionId };

    const startParams = { ...(p.startParams || {}) };
    startParams.model = llmModel;
    if (!startParams.maxToolCalls) startParams.maxToolCalls = resolveLoopToolCallLimit(runSettings);
    if (!startParams.maxRounds) startParams.maxRounds = resolveAgentMaxRounds(runSettings);
    const workspacePath = String(p.runWorkspaceRoot || startParams.workspaceRoot || '').trim() || undefined;
    if (workspacePath && !startParams.workspaceRoot) startParams.workspaceRoot = workspacePath;

    const abortController = new AbortController();
    running.set(cancelToken, { abortController, sessionId, ws: sendPhase.ws || null });
    const toolBridge = createToolBridge();
    try {
      const result = await runRustAgentLoop({
        coreBridge,
        llm: apiCfg,
        settings: runSettings,
        userData,
        useStream: true,
        signal: abortController.signal,
        sessionId,
        runSource: 'chat',
        browserVision: p.browserVision === true,
        contextAudit: p.contextAudit || null,
        contextTierId,
        startParams,
        onPhase: (phase, data) => sendPhase({ cancelToken, phase, data: data || {} }),
        compactMessages: buildLoopCompactionHandler({
          compactionAgent: getCompactionAgent(),
          gateway,
          userData,
          sessionId,
          workspacePath,
          tokenBudget,
          contextTierId,
          apiConfig: apiCfg,
          model: llmModel
        }),
        turnEndSynthesis: true,
        delegateTool: async (name, args) =>
          toolBridge.executeAgentTool(name, args, {
            workspacePath,
            sessionId,
            model: llmModel,
            contextTierId
          })
      });
      return result && typeof result === 'object' ? result : { content: '', trace: [], messages: [] };
    } catch (err) {
      if (!isAbortError(err)) throw err;
      // 用户点了停止：与 Main 一致地返回「已中止」而不是抛错，渲染层才不会弹失败
      sendPhase({ cancelToken, phase: 'done', data: { aborted: true } });
      return { aborted: true, phase: 'done', content: '', trace: [], hitRoundLimit: false, messages: [] };
    } finally {
      running.delete(cancelToken);
      try {
        clearToolHarnessSessionsForSession(sessionId);
      } catch {
        // 清理失败不影响本轮结果
      }
    }
  }

  /**
   * 把浏览器送来的路径归一成绝对路径（支持 `~`）。
   * @param {string} raw
   * @returns {string}
   */
  function resolveDirInput(raw) {
    const input = String(raw || '').trim();
    if (!input) return '';
    const expanded = input === '~' || input.startsWith('~/') ? path.join(os.homedir(), input.slice(1)) : input;
    return path.resolve(expanded);
  }

  /**
   * 证明「这个目录现在就能用」：存在 + 是目录 + **服务账号读得动**。
   *
   * 最后一条不能省：路径上的祖先只给通行权（`x`）时 `stat` 成功、列目录却 `EACCES`，
   * 不在这里拦，用户会换过去之后才在文件树/索引上撞一堆权限错（2026-11-05 现场）。
   * 报错要指名是哪个账号没权限，并给出能直接抄的 `setfacl`。
   *
   * @param {string} resolved 绝对路径
   */
  function assertUsableDir(resolved) {
    let st = null;
    try {
      st = fs.statSync(resolved);
    } catch (e) {
      const code = e && e.code;
      if (code === 'EACCES') {
        throw new Error(
          `${resolved} 的上级目录没有给服务账号通行权（需要 x）：` +
            `sudo setfacl -m u:${serviceUser}:x <上级目录>（逐层，见 docs/HEADLESS.md §3.3）`
        );
      }
      if (code === 'ENOTDIR') throw new Error(`路径中间有一段不是目录: ${resolved}`);
      throw new Error(`目录不存在或无法访问: ${resolved}`);
    }
    if (!st.isDirectory()) throw new Error(`不是目录（是文件）: ${resolved}`);
    try {
      fs.opendirSync(resolved).closeSync();
    } catch (e) {
      if (e && e.code === 'EACCES') {
        throw new Error(
          `目录存在，但服务账号 ${serviceUser} 没有读权限: ${resolved}` +
            `（sudo setfacl -m u:${serviceUser}:rx '${resolved}'；上级目录只需 x）`
        );
      }
      throw new Error(`无法读取目录: ${resolved}（${(e && e.message) || e}）`);
    }
  }

  /**
   * 浏览器版切工作空间（渲染层菜单 → `window.diecloud.setLocalWorkspace`）。
   *
   * 与桌面端 `workspace:set-local`（`src/main/ipc/workspace-remote.js`）同一语义：改 Gateway 的
   * 工作区根（**唯一真源**，`gateway.setLocalWorkspace`）并补 Agent 家目录，把生效结果回给页面。
   * 差别只有一处：桌面端路径来自系统目录框，一定存在；浏览器里的路径来自下面的目录浏览
   * （`desktop.list_dirs`），所以这里仍要自己证明「存在、是目录、读得动」。
   *
   * 生效范围如实说明：只改当前进程，`workspace.json` 也会被改写，但下次启动时
   * `boot` 仍用 `--workspace` / `DIEYUN_WORKSPACE` 显式覆盖 —— 要长期生效改那份配置。
   *
   * @param {string} rawPath 绝对路径（支持 `~`）；空串/null = 回到默认工作空间
   * @returns {object} 与 `workspace:get` 同形状
   */
  function setWorkspaceFromBrowser(rawPath) {
    const resolved = resolveDirInput(rawPath);
    if (resolved) assertUsableDir(resolved);
    const target = gateway.setLocalWorkspace(resolved || null);
    try {
      const { ensureAgentHomeDirs } = require('../agent-home');
      ensureAgentHomeDirs(userData, target && target.kind === 'local' ? target.workspacePath : null);
    } catch (e) {
      log(`切工作空间后初始化 Agent 目录失败：${(e && e.message) || e}`);
    }
    log(`浏览器版切工作空间：${resolved || '(默认)'}`);
    return target;
  }

  /**
   * 浏览器里的目录浏览（`window.diecloud.browseServerDir`）：只列**子目录**，不列文件。
   *
   * 为什么必须是服务端的新方法，而不是复用 Gateway 的 `fs.list_dir`：那条 RPC 被
   * `assertAllowedPath` 限死在**当前工作区根内**，正好没法用来挑「工作区之外」的目录。
   * 信任边界与 `set_workspace` 相同（服务账号读得动的地方就能看），不额外放开权限。
   *
   * @param {string} rawPath 空串 = 从服务账号家目录开始
   * @returns {{ path: string, parent: string, entries: Array<{name: string, path: string}>, hiddenCount: number, truncated: boolean }}
   */
  function listDirsFromBrowser(rawPath) {
    const resolved = resolveDirInput(rawPath) || os.homedir();
    assertUsableDir(resolved);
    const entries = [];
    let hiddenCount = 0;
    for (const dirent of fs.readdirSync(resolved, { withFileTypes: true })) {
      let isDir = dirent.isDirectory();
      if (!isDir && dirent.isSymbolicLink()) {
        try {
          isDir = fs.statSync(path.join(resolved, dirent.name)).isDirectory();
        } catch {
          isDir = false;
        }
      }
      if (!isDir) continue;
      // 点开头的目录（.git/.cache/.pnpm-store…）默认不列：挑工作区时它们只会碍事
      if (dirent.name.startsWith('.')) {
        hiddenCount += 1;
        continue;
      }
      entries.push({ name: dirent.name, path: path.join(resolved, dirent.name) });
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    const limit = 500;
    return {
      path: resolved,
      parent: path.dirname(resolved) === resolved ? '' : path.dirname(resolved),
      entries: entries.slice(0, limit),
      hiddenCount,
      truncated: entries.length > limit
    };
  }

  /**
   * 浏览器里的路径权限 / 沙箱档位（渲染层「输入区路径权限」开关与「设置 → 权限」页）。
   *
   * 桌面端走 `permissions:set` → `gateway.setPermissions`；浏览器里没有 IPC，这里等价转发。
   * 归一、落盘、收紧时作废旧的越界批准都在 `gateway.setPermissions` 里（唯一来源），
   * 这里只负责转发 + 留一条审计日志：改的是安全开关，日志里要能看出谁在什么时候改成了什么。
   *
   * @param {object} next
   * @returns {object} 生效后的权限（与 `permissions:get` 同形状）
   */
  function setPermissionsFromBrowser(next) {
    const before = typeof gateway.getSandboxMode === 'function' ? gateway.getSandboxMode() : '';
    const saved = gateway.setPermissions(next && typeof next === 'object' ? next : {});
    const after = saved && saved.sandboxMode ? saved.sandboxMode : '';
    log(
      `浏览器版改路径权限：${before || '?'} -> ${after || '?'}` +
        `（unrestrictedPaths=${saved && saved.unrestrictedPaths === true}）`
    );
    return saved;
  }

  /**
   * 浏览器里装配系统提示（渲染层 `window.diecloud.agentPrepSystemPrompt(snapshot)`）。
   *
   * 桌面端这条走 IPC `agent:prep-system-prompt`，装配是
   * `src/agent/system-prompt-prep-main.js` 的 `buildPrepSystemPromptDeps`；浏览器里没有 IPC，
   * 但装配只能有一份 —— 所以这里用**同一个** helper，把 snapshot 交上去。
   *
   * 这不只是「共享记忆」要它：AGENTS.md / 项目记忆 / 技能块 / MCP 工具块 / 召回范围全在这份
   * 装配里。少了它，浏览器里的会话拿到的 system prompt 会比桌面端少一大截
   * （渲染层会退到 `assembleSystemPrompt` 的本地兜底，只有用户自写提示 + 工作区信息）。
   *
   * @param {object} snapshot 渲染层上报的结构化快照
   * @returns {Promise<object>} 与 IPC 同形状（content / stable / turnRide / memoryAudit…）
   */
  async function prepSystemPromptFromBrowser(snapshot) {
    const snap = snapshot && typeof snapshot === 'object' ? snapshot : {};
    const built = buildPrepSystemPromptDeps({
      gateway,
      userData,
      snapshot: snap,
      // 共享记忆（跨机）：未配置 / 连不上时 active 为 false，块自动缺席（fail-open）
      sharedMemory: typeof deps.getSharedMemory === 'function' ? deps.getSharedMemory() : null,
      listMcpServers: deps.listMcpServers
    });
    return built.prepSystemPrompt(snap, built.deps);
  }

  /**
   * 「帮助 → 关于 → 检查更新」在**服务器版**里的语义。
   *
   * headless 不自建更新客户端，升级走 apt（`docs/HEADLESS.md` §8）。所以这里只做
   * **只读的 apt 模拟升级**：`apt-get -s` 不需要 root，服务账号就能跑；有新版本时把版本号与
   * 安装命令回报给界面，真装必须由管理员 `sudo apt install dieyun-headless`（这一步不能由
   * 服务进程代办，也不该给它 sudo）。
   *
   * 结论基于**上次 `apt update` 的索引**——不在这里顺手跑 `apt update`（那要 root）。
   *
   * @returns {{ ok: boolean, currentVersion: string, upgradable: boolean, nextVersion: string, message: string, error?: string }}
   */
  function checkUpdateFromBrowser() {
    const pkgVersion = String((require('../../package.json') || {}).version || '');
    const sim = runApt('apt-get', ['-s', '-o', 'Debug::NoLocking=1', 'install', '--only-upgrade', DEB_PACKAGE]);
    if (sim.error) {
      return {
        ok: false,
        currentVersion: pkgVersion,
        upgradable: false,
        nextVersion: '',
        message: '',
        error: sim.error
      };
    }
    const stdout = String(sim.stdout || '');
    const stderr = String(sim.stderr || '');
    const parsed = parseAptUpgradeSimulation(stdout, DEB_PACKAGE);
    // 来源也读一次：`apt-cache policy` 只读、不需要 root
    const policyRes = runApt('apt-cache', ['policy', DEB_PACKAGE], 15000);
    const policy = policyRes.error ? null : parseAptPolicy(policyRes.stdout);
    const current = parsed.currentVersion || (policy && policy.installed) || pkgVersion;
    const command = `sudo apt install ${DEB_PACKAGE}`;

    if (parsed.upgradable) {
      const message = `发现新版本 ${parsed.nextVersion}（当前 ${current}）；服务器版升级：${command}`;
      log(`浏览器版检查更新：${message}`);
      return { ok: true, currentVersion: current, upgradable: true, nextVersion: parsed.nextVersion, message };
    }

    if (parsed.ok) {
      // 「已是最新」只有在**真有源**时才成立。只 dpkg 装过、没配源时索引里根本没有新版本可看，
      // 说「已是最新」会让人以为「官方没发新版」，真正的动作是去配源（docs/HEADLESS.md §8.1）。
      const noRepo = policy && policy.known && policy.fromRepo === false;
      const message = noRepo
        ? `当前 ${current}；但本机没有配置 dieyun 的 apt 源（索引里只有已安装记录），` +
          '所以查不到任何新版本 —— 先在服务器上配源（docs/HEADLESS.md §8.1），或直接装包：' +
          `sudo apt install ./${DEB_PACKAGE}_<ver>_amd64.deb`
        : `已是最新版本（${current}，按上次 apt update 的索引）`;
      log(`浏览器版检查更新：${message}`);
      return { ok: true, currentVersion: current, upgradable: false, nextVersion: '', message };
    }

    // apt 没给出能用的结论：把最后一句话带出来，并给出下一步该查什么。
    const detail =
      (stderr || stdout)
        .trim()
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean)
        .slice(-1)[0] || 'apt-get 没有给出可解析的结果';
    const why =
      parsed.reason === 'NO_PACKAGE'
        ? `apt 找不到 ${DEB_PACKAGE} 这个包（索引里没有）：先确认 apt 源已配置并 sudo apt update`
        : parsed.reason === 'NOT_INSTALLED'
          ? `${DEB_PACKAGE} 在本机不是用 dpkg 安装的，apt 没有可升级的对象`
          : `无法从 apt 结论判定（原话：${detail.slice(0, 160)}）；先 sudo apt update 再试`;
    log(`浏览器版检查更新失败：${why}`);
    return {
      ok: false,
      currentVersion: current,
      upgradable: false,
      nextVersion: '',
      message: '',
      error: why
    };
  }

  /**
   * 手机端桥的 call 分派（见 `src/mobile/bridge.js#_handleCall`）。
   * @param {string} method
   */
  async function handleCall(method, params, sendEvent, ws) {
    // 内网 agent 互通：`peer.<name>` → 与桌面 IPC 同一张动作表（`src/peer/actions.js`）。
    // 事件不走这条 return 通道（面板靠 channel:'peer' 的 event 帧推送，见 headless/boot.js）。
    if (method.startsWith('peer.')) {
      return peerActions.handle(method.slice('peer.'.length), params);
    }
    if (method === 'desktop.check_update') {
      return checkUpdateFromBrowser();
    }
    if (method === 'desktop.prep_system_prompt') {
      return prepSystemPromptFromBrowser(params && params.snapshot);
    }
    if (method === 'desktop.shm_status') return sharedMemoryActions.status();
    if (method === 'desktop.shm_save') return sharedMemoryActions.save((params && params.patch) || {});
    if (method === 'desktop.shm_test') return sharedMemoryActions.test((params && params.patch) || {});
    if (method === 'desktop.shm_probe') return sharedMemoryActions.probe();
    if (method === 'desktop.shm_consolidate') return sharedMemoryActions.consolidate();
    if (method === 'desktop.fetch_models') {
      // 设置页「检测」：出网必须由服务端做（浏览器跨源会被模型端点的 CORS 拦掉，
      // 而且探测要真的打进 chat/completions）。语义与桌面 `models:fetch-list` 同源，
      // 渲染层拿到的仍是 `{ ok, models, removed, … }`。
      const res = await detectModelsFromPayload(params && params.payload);
      if (!res.ok) log(`浏览器版模型检测失败：${res.error}`);
      return res;
    }
    if (method === 'desktop.save_model_settings') {
      // 网页里改模型设置：与桌面 `model:sync-settings` 同一份收尾
      // （落盘 `<userData>/model-settings.json` + 推语音设置给手机端 + 让 core 重读配置）。
      // 服务器上这份文件就是唯一真源，写入后下一轮对话/下一次刷新页面都读新值。
      const res = applyModelSettings({
        userData,
        settings: params && params.settings,
        gateway,
        mobileBridge: typeof deps.getMobileBridge === 'function' ? deps.getMobileBridge() : null,
        agentService: typeof deps.getAgentService === 'function' ? deps.getAgentService() : null,
        log
      });
      log(res.ok ? `浏览器版保存模型设置：saved=${res.saved}` : '浏览器版保存模型设置失败');
      return res;
    }
    if (method === 'desktop.set_workspace') {
      return setWorkspaceFromBrowser(params && params.path);
    }
    if (method === 'desktop.list_dirs') {
      return listDirsFromBrowser(params && params.path);
    }
    if (method === 'desktop.get_permissions') {
      return gateway.getPermissions();
    }
    if (method === 'desktop.set_permissions') {
      return setPermissionsFromBrowser(params && params.permissions);
    }
    if (method === 'desktop.loop_cancel') {
      const cancelToken = String((params && params.cancelToken) || '');
      const box = running.get(cancelToken);
      if (box) {
        box.abortController.abort();
        log(`桌面界面停止本轮：${cancelToken}`);
      }
      return { stopped: !!box };
    }
    if (method === 'desktop.loop_run') {
      // 记下归属连接：页面关掉/刷新就和「点了停止」一样，不能留着循环在后台烧模型
      const send = (frame) => sendEvent(frame);
      send.ws = ws || null;
      return runTurn((params && params.payload) || {}, send);
    }
    throw new Error('未知方法: ' + method);
  }

  /** 连接断开：中止它发起的那些轮次 */
  function cancelForSocket(ws) {
    for (const [token, box] of running) {
      if (box.ws !== ws) continue;
      box.abortController.abort();
      running.delete(token);
    }
  }

  return {
    handleCall,
    runTurn,
    setWorkspaceFromBrowser,
    listDirsFromBrowser,
    setPermissionsFromBrowser,
    prepSystemPromptFromBrowser,
    checkUpdateFromBrowser,
    cancelForSocket,
    running
  };
}

module.exports = { createDesktopTurn, parseAptUpgradeSimulation, parseAptPolicy, APT_ENV };
