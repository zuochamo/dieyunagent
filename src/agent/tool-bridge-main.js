'use strict';

const { delegateAgentToolViaGateway } = require('./delegate-tool-gateway');
// 手机摄像头（camera_look）的唯一出口：协议参数、结果校验、失败文案都在那边。
const { createPhoneCameraSource } = require('../mobile/camera-source');
const {
  PROJECT_MEMORY_REL_PATH,
  parseProjectMemoryEntries
} = require('./project-memory-file');
const { isRendererOnlyTool, requestToolFromRenderer } = require('./renderer-tool-delegate');
const { getToolHarnessSession, clearToolHarnessSession } = require('./tool-harness');
// 关卡装配（归一 + before/after 顺序）的唯一来源；本文件只追加自己的 after 关卡。
const { createToolCall } = require('./tool-gate');
const { isMutatingAgentTool, MUTATING_TOOLS } = require('./tool-classify');
const { sniffVisionImageMime } = require('./guardrails-shared');
const { getAgentLimits } = require('./agent-limits');
const { withTimeout } = require('../timeout');
const {
  collectWriteSmellHints,
  relDirOf,
  relDirGlobPattern,
  filterDirNames
} = require('./write-smell-hints');
const { executeAgentsMdProposeMain } = require('./propose-tools-main');
// 技能删除的唯一实现（与 IPC skills:delete 共用）
const { deleteUserSkill } = require('../agent-home');
// MCP 工具的「按用户提问召回」只此一份实现：渲染器装工具表用它，模型的
// mcp_tool_schema(query) 也用它 —— 两处若各写一套排序，检索结果会互相打架。
const { recallAgentTools } = require('../tools/tool-vector-index');
const { slimMcpInputSchema } = require('./tool-catalog');
// 目标型计划的两个收尾工具（goal_check / goal_finish）：事实与核对全在 plans/goal-run，
// 本文件只做「取上下文 → 调它 → 把事实回给模型」，不在这里判完成。
const {
  goalChecks,
  runGoalCheck,
  judgeGoalFinish,
  factLine
} = require('../plans/goal-run');
// 「是不是 MCP 服务注册的工具」唯一判定：mcp_manage / mcp_tool_schema 同前缀但不是远端工具
const { isMcpServerToolName } = require('../mcp/tool-name');
const { loadModelSettings, getEmbeddingConfig } = require('../model-settings');

const { runExclusive } = require('./mutate-queue');
const {
  recordBrowserScreenshot,
  recordVisionImage,
  resolveVisionLimits,
  extractShot,
  SOURCE_ATTACHMENT,
  SOURCE_MCP
} = require('./browser-vision');
const {
  storeVisionImage,
  visionHandleText,
  visionCameraText,
  visionOmitText,
  visionTokensForSize
} = require('./vision-image');

/**
 * 用文件头魔数判断 base64 是否为图片，并给出准确的 mime。
 * 单一来源是 guardrails-shared.sniffVisionImageMime：只认上游支持的
 * png/jpeg/gif/webp（bmp/svg/heic 等注入必被上游 400 打回，故不认），
 * 无法判定时返回空串，调用方退回原有「读文件」语义。
 */
const sniffImageMime = sniffVisionImageMime;

/**
 * 是否是「想把图片交给模型看」的读取请求。
 * 只认 fs_read_file + encoding=base64 + 整文件读（带 offset 视为分块续读，不当作视觉输入）。
 */
function isVisionImageReadRequest(toolName, args) {
  if (toolName !== 'fs_read_file') return false;
  if (!args || typeof args !== 'object') return false;
  if (String(args.encoding || '').toLowerCase() !== 'base64') return false;
  if (Number(args.offset) > 0) return false;
  return true;
}

function sanitizeToolResultForApi(name, result) {
  if (result == null) return result;
  if (typeof result !== 'object') return result;
  if (name === 'computer' && result.base64) {
    // 与 browser_screenshot 同一策略：base64 从工具 payload 剥离（走视觉缓冲注入下一轮），
    // 结果里只留动作事实（坐标/前台窗口/截图尺寸），模型据此衔接下一步。
    return {
      ok: result.ok,
      action: result.action,
      // 动作是否真的执行过：模型靠它区分「生效了」与「被系统丢了」（见 computer/service）
      ...(result.applied === true ? { applied: true } : {}),
      display: result.display,
      primary: result.primary,
      screen: result.screen,
      cursor: result.cursor,
      activeWindow: result.activeWindow,
      // type 动作实际投递的字符数：模型要靠它核对「打进去了多少」（见 computer/service 注释）
      ...(result.typed != null ? { typed: result.typed } : {}),
      // 画面事实：变了没有 / 是否已稳定（模型的下一步全靠这两条）
      ...(result.changed != null ? { changed: result.changed } : {}),
      ...(result.stable != null ? { stable: result.stable } : {}),
      // 等待事实：等到了没有、等了多久（wait_until 的核心信号是 timedOut）
      ...(result.timedOut != null ? { timedOut: result.timedOut } : {}),
      ...(result.waitedMs != null ? { waitedMs: result.waitedMs } : {}),
      mime: result.mime,
      width: result.width,
      height: result.height,
      ...(result.visionImage ? { visionImage: result.visionImage } : {}),
      ...(result.visionTokens ? { visionTokens: result.visionTokens } : {}),
      // 界面可渲染的图片凭证（见 record-browser-screenshot 关卡说明）；白名单字段，必须显式透传
      ...(Array.isArray(result.imagePaths) && result.imagePaths.length
        ? { imagePaths: result.imagePaths }
        : {}),
      base64Omitted: true,
      base64Length: String(result.base64).length,
      // 只陈述事实：是否真进了视觉通道由 after 关卡判定后改写本字段，
      // 这里绝不能再写「将作为视觉输入附到下一轮」（那正是模型干等一张图的根因）。
      note: result.note
        ? `${result.note}图片本体不随工具结果返回`
        : '已截取当前屏幕画面；图片本体不随工具结果返回'
    };
  }
  if (name === 'camera_look' && result.base64) {
    // 与截图同一策略：像素本体不随工具结果返回（走视觉缓冲注入下一轮），
    // 结果里只留「拍了哪颗、多大、什么时候拍的」这几条事实。
    return {
      ok: result.ok,
      facing: result.facing,
      mime: result.mime,
      width: result.width,
      height: result.height,
      capturedAt: result.capturedAt,
      ...(result.visionImage ? { visionImage: result.visionImage } : {}),
      ...(result.visionTokens ? { visionTokens: result.visionTokens } : {}),
      base64Omitted: true,
      base64Length: String(result.base64).length,
      note: result.note || '手机已拍好一张照片；图片本体不随工具结果返回'
    };
  }
  if (name === 'browser_screenshot' && result.base64) {
    return {
      ok: result.ok,
      engine: result.engine,
      mime: result.mime,
      width: result.width,
      height: result.height,
      renderHealth: result.renderHealth,
      warning: result.warning,
      fallbackFrom: result.fallbackFrom,
      fallbackReason: result.fallbackReason,
      fallbackError: result.fallbackError,
      path: result.path,
      bytes: result.bytes,
      savePath: result.savePath,
      saveError: result.saveError,
      ...(result.visionImage ? { visionImage: result.visionImage } : {}),
      ...(result.visionTokens ? { visionTokens: result.visionTokens } : {}),
      ...(Array.isArray(result.imagePaths) && result.imagePaths.length
        ? { imagePaths: result.imagePaths }
        : {}),
      base64Omitted: true,
      base64Length: String(result.base64).length,
      note: result.note || 'Screenshot captured; PNG kept out of this tool payload'
    };
  }
  if (name === 'browser_snapshot') {
    const out = { ...result };
    if (!out.outputFile && typeof out.textPreview === 'string' && out.textPreview.length > 6000) {
      out.textPreview = out.textPreview.slice(0, 6000) + '…';
    }
    return out;
  }
  if (name === 'browser_observe') {
    const out = { ...result };
    if (typeof out.textPreview === 'string' && out.textPreview.length > 6000) {
      out.textPreview = out.textPreview.slice(0, 6000) + '…';
    }
    if (out.screenshot && out.screenshot.base64) {
      out.screenshot = {
        mime: out.screenshot.mime,
        width: out.screenshot.width,
        height: out.screenshot.height,
        base64Omitted: true,
        base64Length: String(out.screenshot.base64).length
      };
    }
    return out;
  }
  return result;
}

/**
 * 写类工具串行入口。`meta` 只用于 stall 诊断（哪个工具把队列占住了），不参与判定。
 * @param {() => Promise<any>} fn
 * @param {string} workspaceKey
 * @param {{ tool?: string, sessionId?: string }} [meta]
 */
function runExclusiveMain(fn, workspaceKey, meta) {
  return runExclusive(fn, workspaceKey, null, meta);
}

/**
 * @param {object} deps
 * @param {{ invokeRpc: Function } | null} deps.gateway
 * @param {import('electron').WebContents} [deps.webContents]
 * @param {object} [deps.mcpRuntime]
 * @param {{ applyToolRequest: Function } | null} [deps.mcpManager]
 * @param {object} [deps.plansStore]
 * @param {Function} [deps.plansCreateFromText]
 * @param {Function} [deps.createUserSkill]
 * @param {Function} [deps.onSkillsChanged]
 * @param {object} [deps.browserService]
 * @param {string} [deps.userDataPath]
 */
function createMainToolBridge(deps) {
  const gateway = deps.gateway || null;
  const webContents = deps.webContents || null;
  const mcpRuntime = deps.mcpRuntime || null;
  const mcpManager = deps.mcpManager || null;
  const plansStore = deps.plansStore || null;
  const plansCreateFromText = deps.plansCreateFromText || null;
  const createUserSkill = deps.createUserSkill || null;
  const onSkillsChanged = deps.onSkillsChanged || null;
  const browserService = deps.browserService || null;
  const userDataPath = deps.userDataPath || '';
  // 内网 agent 互通（src/peer）：Main 创建的协调器；未启用时三个 peer_* 工具退化为结构化错误，
  // 不做「静默无此工具」——模型需要知道「这个能力没开」而不是「能力不存在」。
  const peerCoordinator = deps.peerCoordinator || null;
  // SSH 动作（连/断/端口转发/切远端工作空间）：与 IPC 同一份实现，见 src/ssh/actions.js
  const sshActions = deps.sshActions || null;
  // Worktree（并行副本）：与设置页同一份实现，见 src/worktree/actions.js
  const worktreeActions = deps.worktreeActions || null;
  // 手机摄像头：`getMobileBridge` 用取值函数传进来（手机桥由 Main 启动时创建，
  // 工具桥装配时刻可能还没有它；重连/换端口后也总是拿到最新实例）。
  // 没接手机桥时保留 null —— camera_look 会退化成一句结构化错误，而不是「工具不存在」。
  const cameraSource = typeof deps.getMobileBridge === 'function'
    ? createPhoneCameraSource({ getBridge: deps.getMobileBridge })
    : null;

  /**
   * 取写入文件所在目录的直接子项文件名（只要名字，不做 stat）。
   * 走 Gateway 的 glob RPC，因此本地 / SSH 远程工作区都成立；
   * 权限不足、路径越界、连接失败或超时一律返回 null（降级为「只看得见本轮」）。
   */
  async function readSiblingNames(filePath, ctx) {
    if (!gateway) return null;
    const wsRoot = ctx.workspacePath || ctx.worktreePath || '';
    const relDir = relDirOf(filePath, wsRoot);
    const pattern = relDirGlobPattern(filePath, wsRoot);
    if (relDir === null || !pattern) return null;
    let res = null;
    try {
      res = await withTimeout(
        delegateAgentToolViaGateway(gateway, 'glob', { pattern }, ctx),
        getAgentLimits(userDataPath, ctx.contextTierId).writeSmellScanTimeoutMs,
        { mode: 'null' }
      );
    } catch {
      return null;
    }
    if (!res || res.ok === false || !Array.isArray(res.files)) return null;
    // 再按目录筛一遍：工作区根的模式是 '*'，ripgrep 会递归匹配
    return filterDirNames(res.files, relDir, wsRoot);
  }

  /**
   * 写入即反馈：把刚落盘文件的结构性坏味道（同族文件 / 吞异常 / 明文凭据 / 常量重复）
   * 作为附加信息挂到该次工具结果上，让模型下一步就看见自己产出的形状。
   *
   * 只附加信息：失败、无提示、开关关闭（上限 0）时一律原样返回，
   * 不改变工具成败语义、不阻断交付、不触发重跑。
   */
  async function withWriteSmellHints(name, args, result, ctx = {}) {
    if (!result || typeof result !== 'object') return result;
    let hints = [];
    try {
      hints = await collectWriteSmellHints({
        toolName: name,
        args,
        result,
        runKey: `${ctx.sessionId || ''}:${ctx.runId || ''}`,
        limits: () => getAgentLimits(userDataPath, ctx.contextTierId),
        readDirNames: (filePath) => readSiblingNames(filePath, ctx)
      });
    } catch {
      return result; // 提示是附加信息，判定失败不影响工具结果
    }
    if (!hints.length) return result;
    const prev = Array.isArray(result.warnings) ? result.warnings : [];
    return { ...result, warnings: [...prev, ...hints] };
  }

  async function ensureBrowserReady(name) {
    if (!name.startsWith('browser_') || name === 'browser_close' || name === 'browser_status') {
      return;
    }
    if (browserService && typeof browserService.setPanelState === 'function') {
      try {
        await browserService.setPanelState({ visible: true, openedByAgent: true });
      } catch {
        // ignore
      }
    }
  }

  async function executeGatewayTool(name, args, ctx) {
    if (!gateway) throw new Error('Gateway 未就绪');
    await ensureBrowserReady(name);
    return delegateAgentToolViaGateway(gateway, name, args, ctx);
  }

  /**
   * 按 query 检索「本轮工具表里没有」的 MCP 工具，返回可直接调用的 agentName + 精简 schema。
   *
   * 为什么需要它：mcp_* 工具是每个用户回合按提问召回的子集（renderer-tool-defs.js），
   * run 内不再刷新。任务中途换向时，未被召回的工具对模型完全不可见 —— 它连名字都不知道，
   * 无法补救。此函数把「渐进披露」的最后一步交给模型自己触发：披露要能按需再发生。
   *
   * 召回走 tools/tool-vector-index 的同一份实现；召回不可用（无向量模型 / 全被阈值挡掉）时
   * 退到名字与描述的子串匹配 —— 宁可粗排，也不能让「有工具却找不到」。
   */
  async function searchMcpToolSchemas(query, limit) {
    if (!mcpRuntime || typeof mcpRuntime.listAgentTools !== 'function') {
      return { error: 'MCP 运行时未就绪', errorCode: 'MCP_UNAVAILABLE', retryable: false };
    }
    const listed = await mcpRuntime.listAgentTools({ catalogOnly: true });
    const all = Array.isArray(listed.tools) ? listed.tools : [];
    if (!all.length) {
      return {
        ok: true,
        matched: [],
        total: 0,
        note: '已启用的 MCP 服务当前没有任何缓存工具；请先在 MCP 设置页刷新工具目录'
      };
    }
    const candidates = all.map((item) => ({
      id: item.agentName,
      name: item.agentName,
      description: `[MCP · ${item.serverId || ''}] ${item.description || item.toolName || ''}`,
      source: 'mcp',
      serverId: item.serverId || ''
    }));
    const max = Math.min(5, Math.max(1, Number(limit) || 3));
    let picked = [];
    try {
      const recalled = await recallAgentTools({
        userData: userDataPath,
        embeddingConfig: getEmbeddingConfig(loadModelSettings(userDataPath)),
        candidates,
        query,
        limit: max
      });
      picked = Array.isArray(recalled && recalled.tools) ? recalled.tools : [];
    } catch {
      picked = [];
    }
    if (!picked.length) {
      const q = String(query || '').toLowerCase();
      picked = candidates
        .filter(
          (c) =>
            c.id.toLowerCase().includes(q) || String(c.description || '').toLowerCase().includes(q)
        )
        .slice(0, max)
        .map((c) => ({ id: c.id }));
    }
    const byName = new Map(all.map((item) => [item.agentName, item]));
    const matched = picked
      .map((row) => byName.get(row && row.id))
      .filter(Boolean)
      .map((item) => ({
        agentName: item.agentName,
        serverId: item.serverId || '',
        description: String(item.description || item.toolName || '').slice(0, 240),
        inputSchema: slimMcpInputSchema(item.inputSchema || {})
      }));
    return {
      ok: true,
      matched,
      total: all.length,
      note: matched.length
        ? 'matched[].agentName 可直接当工具名调用（不必等它进入工具列表）。嵌套字段被折叠时，再用 agentName 模式查完整 schema。'
        : '没有命中；换个说法，或直接给 agentName'
    };
  }

  async function executeMainOnlyTool(name, args, ctx) {
    const a = args || {};
    switch (name) {
      case 'camera_look': {
        if (!cameraSource) {
          return {
            ok: false,
            errorCode: 'CAMERA_UNAVAILABLE',
            retryable: false,
            error: '这台机器没有手机桥，无法调用手机摄像头。请改用其它方式（让用户描述，或用 computer 看屏幕）。'
          };
        }
        const cameraLimits = getAgentLimits(userDataPath, ctx.contextTierId);
        return cameraSource.capture({
          focus: a.focus,
          maxEdge: cameraLimits.cameraShotMaxEdge,
          timeoutMs: cameraLimits.cameraCaptureTimeoutMs
        });
      }
      case 'mcp_tool_schema': {
        if (!mcpRuntime) {
          return { error: 'MCP 运行时未就绪', errorCode: 'MCP_UNAVAILABLE', retryable: false };
        }
        const query = String(a.query || '').trim();
        if (query) return searchMcpToolSchemas(query, a.limit);
        if (typeof mcpRuntime.lookupToolSchema !== 'function') {
          return { error: 'MCP 运行时未就绪', errorCode: 'MCP_UNAVAILABLE', retryable: false };
        }
        return mcpRuntime.lookupToolSchema(String(a.agentName || ''));
      }
      case 'mcp_manage': {
        // 装/改/启停 MCP 服务：与 IPC 共用 mcp/manage.js（同一份 store + 同一次运行时重挂）。
        // 没有管理器时明确说「能力没开」，而不是装作工具不存在。
        if (!mcpManager) {
          return {
            ok: false,
            error: 'MCP 管理未就绪（运行时尚未装配）',
            errorCode: 'MCP_UNAVAILABLE',
            retryable: true
          };
        }
        try {
          // request_credential 需要把「请人填凭据」推到界面：只有这条通道能让模型既发起、又看不到明文。
          // 没有可用窗口（后台频道轮次）时传 null —— 让 manager 明确回「界面未就绪」，不假装弹过。
          const canNotify = !!webContents && !webContents.isDestroyed();
          return await mcpManager.applyToolRequest(a, {
            notifyCredentialRequest: canNotify
              ? (payload) => {
                  if (!webContents.isDestroyed()) webContents.send('mcp:credential-request', payload);
                }
              : null
          });
        } catch (err) {
          return {
            ok: false,
            error: String((err && err.message) || err || 'MCP 变更失败'),
            errorCode: 'MCP_MANAGE_FAILED',
            retryable: false
          };
        }
      }
      case 'ssh': {
        // 远端能力：与「连接」面板共用 ssh/actions.js。不接密钥参数 —— 密码/私钥只能来自本机。
        if (!sshActions) {
          return { ok: false, error: 'SSH 不可用（未装配）', errorCode: 'SSH_UNAVAILABLE', retryable: false };
        }
        const action = String(a.action || 'status').trim();
        try {
          if (action === 'list') {
            return { ok: true, action, ...sshActions.listTargets() };
          }
          if (action === 'status') {
            return { ok: true, action, status: sshActions.status() };
          }
          if (action === 'home') {
            return { ok: true, action, ...(await sshActions.home()) };
          }
          if (action === 'browse') {
            const listing = await sshActions.browse(a.path);
            return { ok: true, action, path: String(a.path || '/'), listing };
          }
          if (action === 'use_workspace') {
            const remotePath = String(a.remotePath || '').trim();
            if (!remotePath) return { error: 'use_workspace 需要 remotePath', errorCode: 'MISSING_ARG' };
            const workspace = sshActions.useWorkspace(remotePath);
            return {
              ok: true,
              action,
              workspace,
              note: '工作空间已切到远端：fs_* 与 host_exec 现在作用在这台服务器上'
            };
          }
          if (action === 'connect') {
            const payload = {
              host: String(a.profile || a.host || '').trim(),
              hostname: a.profile ? '' : String(a.host || '').trim(),
              port: a.port,
              username: a.username,
              authType: a.authType,
              privateKeyPath: a.privateKeyPath,
              // 已存凭据要生效必须带 remember（connect-payload 里那一支才会去凭据库取密码）
              remember: true,
              useSaved: true,
              acceptNewHostKey: a.acceptNewHostKey === true
            };
            const r = await sshActions.connect(payload);
            if (!r || r.ok === false) {
              // 首次连接：主机指纹没被信任过，必须由人确认（工具不替人做这个决定）。
              //
              // 注意：失败结果在关卡里会被 `wrapStructuredError` 归一成
              // `{ok,error,errorCode,retryable,suggestedFix}` —— 额外字段（指纹、主机）会被丢掉。
              // 所以「指纹 + 下一步」必须写进 error / suggestedFix 这两个能活下来的字段里，
              // 否则模型只看到一句「没被信任过」，既拿不到指纹也没法重试。
              if (r && r.needHostKeyTrust) {
                const fp = r.fingerprint || '未知';
                return {
                  ok: false,
                  action,
                  connected: false,
                  fingerprint: r.fingerprint || '',
                  hostKeyMismatch: !!r.hostKeyMismatch,
                  host: r.host,
                  username: r.username,
                  error: r.hostKeyMismatch
                    ? `主机 ${r.host || ''} 的指纹与已保存的不一致（现在：${fp}，已存：${r.savedFingerprint || '未知'}）。可能是换了机器，也可能是中间人 —— 不要自己继续。`
                    : `主机 ${r.host || ''} 的指纹还没被信任过：${fp}`,
                  errorCode: r.hostKeyMismatch ? 'SSH_HOST_KEY_MISMATCH' : 'SSH_HOST_KEY_UNTRUSTED',
                  // 不能标 retryable：那是「同一参数自动重试」的信号，harness 会连打 4 次，
                  // 而这里什么都不会变 —— 要做的是去问人，然后**换参数**重来。
                  retryable: false,
                  suggestedFix: r.hostKeyMismatch
                    ? '把这个不一致告诉用户并停下：只有用户确认那台机器被重装/换过之后，才由用户在连接面板处理，不要带 acceptNewHostKey 重试。'
                    : '把指纹念给用户核对（"这台机器是 10.x，指纹 SHA256:xxx，可以信任吗？"）；用户明确同意后，再带 acceptNewHostKey=true 重试同一条 connect。'
                };
              }
              return {
                ok: false,
                action,
                connected: false,
                ...(r || {}),
                error: (r && (r.error || r.message)) || 'SSH 连接失败',
                errorCode: (r && r.errorCode) || 'SSH_CONNECT_FAILED'
              };
            }
            const out = {
              ok: true,
              action,
              connected: true,
              resolved: r.resolved || {},
              credentialsWarning: r.credentialsWarning || '',
              note: '已连上。要把工作空间切过去就再调 action=use_workspace + remotePath。'
            };
            const remotePath = String(a.remotePath || '').trim();
            if (remotePath) {
              out.workspace = sshActions.useWorkspace(remotePath);
              out.note = '已连上并切到远端工作空间：fs_* 与 host_exec 现在作用在这台服务器上';
            }
            return out;
          }
          if (action === 'disconnect') {
            const r = await sshActions.disconnect({ force: a.force === true });
            return { ok: true, action, ...(r || {}) };
          }
          if (action === 'port_forward') {
            const sub = String(a.forwardAction || 'list').trim();
            if (sub === 'add') {
              const r = await sshActions.portForwardAdd({
                localPort: a.localPort,
                remoteHost: a.remoteHost,
                remotePort: a.remotePort
              });
              return { ok: true, action, forwardAction: sub, ...(r || {}) };
            }
            if (sub === 'remove') {
              const r = await sshActions.portForwardRemove({ id: a.id });
              return { ok: true, action, forwardAction: sub, ...(r || {}) };
            }
            const r = sshActions.portForwardList();
            return { ok: true, action, forwardAction: 'list', forwards: (r && r.forwards) || [] };
          }
          return {
            ok: false,
            error: `ssh 的 action 不支持「${action}」`,
            errorCode: 'INVALID_ARG',
            retryable: false
          };
        } catch (err) {
          return {
            ok: false,
            action,
            error: String((err && err.message) || err || 'SSH 操作失败'),
            errorCode: (err && err.code) || 'SSH_FAILED',
            retryable: false
          };
        }
      }
      case 'worktree': {
        // 副本隔离：与设置页「副本」面板共用 src/worktree/actions.js。
        if (!worktreeActions) {
          return { ok: false, error: 'Worktree 不可用（未装配）', errorCode: 'WORKTREE_UNAVAILABLE', retryable: false };
        }
        const action = String(a.action || 'list').trim();
        try {
          if (action === 'list') return { ok: true, action, ...(await worktreeActions.list()) };
          if (action === 'list_runs') return { ok: true, action, ...(await worktreeActions.listManaged()) };
          if (action === 'create') {
            const r = await worktreeActions.create({
              runId: a.runId,
              roleId: a.roleId,
              baseRef: a.baseRef
            });
            return { ok: !!(r && r.ok !== false), action, result: r };
          }
          if (action === 'remove') {
            const p = String(a.path || '').trim();
            if (!p) return { ok: false, error: 'worktree remove 需要 path', errorCode: 'MISSING_ARG' };
            const r = await worktreeActions.remove({ path: p });
            return { ok: !!(r && r.ok !== false), action, result: r };
          }
          if (action === 'preview_run') {
            const r = await worktreeActions.previewRun({ runId: a.runId });
            return { ok: !!(r && r.ok !== false), action, result: r };
          }
          if (action === 'apply_run') {
            const r = await worktreeActions.applyRun({
              runId: a.runId,
              paths: a.paths,
              changeIds: a.changeIds,
              forceConflict: a.forceConflict === true,
              allowOverwriteMainDirty: a.allowOverwriteMainDirty === true
            });
            return { ok: !!(r && r.ok !== false), action, result: r };
          }
          if (action === 'cleanup_run') {
            const r = await worktreeActions.cleanupRun({
              runId: a.runId,
              archive: a.archive !== false,
              allowDiscardUncommitted: a.allowDiscardUncommitted === true,
              deleteBranches: a.deleteBranches === true
            });
            return { ok: !!(r && r.ok !== false), action, result: r };
          }
          if (action === 'prune') {
            // keep 是该动作唯一的安全阀（省略 = 0 = 全删已合并的 dieyun 分支），必须从参数里来，
            // 不能读一个 schema 里不存在的字段（那样永远是 {}，等于「无差别清理」）。
            const r = await worktreeActions.pruneBranches({ keep: a.keep });
            return { ok: !!(r && r.ok !== false), action, result: r };
          }
          return { ok: false, error: `worktree 的 action 不支持「${action}」`, errorCode: 'INVALID_ARG', retryable: false };
        } catch (err) {
          return {
            ok: false,
            action,
            error: String((err && err.message) || err || 'worktree 操作失败'),
            errorCode: 'WORKTREE_FAILED',
            retryable: false
          };
        }
      }
      case 'skill_create': {
        if (!createUserSkill) return { error: '技能创建不可用' };
        const created = await createUserSkill(deps.userDataPath, ctx.workspacePath || null, {
          name: a.name,
          description: a.description,
          content: a.content
        });
        if (typeof onSkillsChanged === 'function') {
          try {
            onSkillsChanged(created);
          } catch {
            // ignore
          }
        }
        return {
          ok: true,
          name: created.name,
          dir: created.dir,
          skillPath: created.skillPath,
          message: `技能「${created.name}」已创建`
        };
      }
      case 'skill_delete': {
        // 与设置页删除按钮共用 agent-home.js#deleteUserSkill（扫描根白名单 + 种子技能保护）
        const dir = String(a.dir || '').trim();
        if (!dir) return { ok: false, error: 'skill_delete 需要 dir', errorCode: 'MISSING_ARG', retryable: false };
        try {
          const r = await deleteUserSkill(userDataPath, ctx.workspacePath || ctx.worktreePath || null, dir);
          if (typeof onSkillsChanged === 'function') {
            try {
              onSkillsChanged({ deleted: r.dir });
            } catch {
              // ignore
            }
          }
          return { ok: true, dir: r.dir, message: '技能目录已删除' };
        } catch (err) {
          return {
            ok: false,
            error: String((err && err.message) || err || '删除失败'),
            errorCode: 'SKILL_DELETE_FAILED',
            retryable: false
          };
        }
      }
      case 'plan_create': {
        if (!plansCreateFromText) return { error: '计划 API 不可用' };
        const todoText =
          Array.isArray(a.todos) && a.todos.length
            ? `\n\nTODO：\n${a.todos.map((t, i) => `${i + 1}. ${String(t || '').trim()}`).join('\n')}`
            : '';
        const r = await plansCreateFromText({
          // text 只服务「缺结构化信息时的 LLM 解析」与空描述校验：prompt 就是任务的完整说明，可作兜底
          text: `${a.description || a.text || a.prompt || ''}${todoText}`,
          skillIds: a.skillIds || [],
          // 结构化优先：模型直接给出 rrule/onceAt/goal 时免 LLM 解析
          structured: {
            name: a.name,
            rrule: a.rrule,
            onceAt: a.onceAt,
            prompt: a.prompt,
            todos: a.todos,
            skillIds: a.skillIds,
            // 目标型：{ checks: [...], cwd } —— 检查清单是它唯一的验收面（不解析提示词）
            goal: a.goal,
            // 计划工作空间：不填 = 跟随执行时当前工作空间
            workspace: a.workspace
          },
          // 计划绑定本次运行的路由：定时执行（无 Renderer）据此自洽解析模型配置
          modelRoute: ctx && ctx.modelRoute ? ctx.modelRoute : undefined,
          model: ctx && ctx.model ? ctx.model : undefined,
          // 定时型默认投递到「发起这次对话的会话」；目标型在 parser 里改投专用会话
          sessionId: ctx && ctx.sessionId ? ctx.sessionId : undefined
        });
        const goalChecksDeclared =
          r.plan.trigger === 'goal' && r.plan.goal && Array.isArray(r.plan.goal.checks)
            ? r.plan.goal.checks.map((c) => c && c.command).filter(Boolean)
            : [];
        return {
          ok: true,
          plan: r.plan,
          message:
            r.plan.trigger === 'goal'
              ? `已创建目标型计划「${r.plan.name}」：` +
                (goalChecksDeclared.length
                  ? `验收检查 ${goalChecksDeclared.map((c) => `「${c}」`).join('、')}。`
                  : '未声明检查（未验证模式：完成申请不会被代码核对）。') +
                '它会在后台一轮轮自动跑，跑到申请完成或预算用完为止 —— 别在这里等结果，' +
                '需要看进度或停掉时用 plan_list / plan_run / plan_delete。'
              : `已创建计划「${r.plan.name}」`
        };
      }
      case 'plan_list': {
        if (!plansStore) return { error: '计划 API 不可用' };
        const plans = plansStore.list();
        return {
          plans: (plans || []).map((p) => ({
            id: p.id,
            name: p.name,
            enabled: p.enabled,
            trigger: p.trigger || 'schedule',
            rrule: p.rrule,
            onceAt: p.onceAt,
            todos: Array.isArray(p.todos) ? p.todos : [],
            // 目标型：报状态时要说得清「跑了几轮、声明的检查是什么、最后一条事实、怎么收的尾」
            goal:
              p.trigger === 'goal'
                ? {
                    checks: (p.goal && Array.isArray(p.goal.checks) ? p.goal.checks : []).map((c) => c && c.command),
                    cwd: (p.goal && p.goal.cwd) || ''
                  }
                : undefined,
            attempt: Number(p.attempt) || 0,
            outcome: p.outcome || null,
            lastCheck: Array.isArray(p.evidence) && p.evidence.length
              ? {
                  command: p.evidence[p.evidence.length - 1].command,
                  ok: !!p.evidence[p.evidence.length - 1].ok,
                  exitCode: p.evidence[p.evidence.length - 1].exitCode,
                  at: p.evidence[p.evidence.length - 1].at
                }
              : null,
            // 计划绑定的模型与路由（只存路由不存 key）：便于判断到点会用哪个模型执行
            model: p.model || '',
            modelRoute: p.modelRoute || '',
            sessionId: p.deliver?.sessionId,
            // 计划绑定的工作空间（空 = 跟随当前工作空间）
            workspace: p.workspace || '',
            lastRunAt: p.lastRunAt
          }))
        };
      }
      case 'plan_delete': {
        if (!plansStore) return { error: '计划 API 不可用' };
        plansStore.delete(a.id);
        return { ok: true, deleted: a.id };
      }
      case 'plan_run': {
        // 与 IPC plans:run-now 同一条路（scheduler.runNow → 收尾 → reload），不另写一份调度逻辑。
        const scheduler = typeof deps.getPlansScheduler === 'function' ? deps.getPlansScheduler() : null;
        if (!scheduler || !plansStore) return { ok: false, error: '计划调度未就绪', errorCode: 'PLANS_UNAVAILABLE' };
        const id = String(a.id || '').trim();
        if (!id) return { ok: false, error: 'plan_run 需要 id', errorCode: 'MISSING_ARG' };
        const plan = plansStore.get(id);
        if (!plan) return { ok: false, error: `没有这个计划：${id}`, errorCode: 'PLAN_NOT_FOUND' };
        let result;
        try {
          result = await scheduler.runNow(id);
        } catch (err) {
          result = { ok: false, error: String((err && err.message) || err) };
          if (typeof deps.finishPlanRun === 'function') {
            deps.finishPlanRun(plan, result).catch(() => {});
          }
        }
        try {
          scheduler.reload();
        } catch {
          // ignore
        }
        return {
          ok: !!(result && result.ok !== false),
          planId: id,
          name: plan.name,
          result,
          note: '已触发一次执行：跑完的结果会出现在该计划绑定的会话里，不要在这里等'
        };
      }
      case 'goal_check': {
        if (!plansStore) return { ok: false, error: '计划 API 不可用', errorCode: 'PLANS_UNAVAILABLE' };
        if (!gateway) return { ok: false, error: 'Gateway 未就绪', errorCode: 'GATEWAY_UNAVAILABLE' };
        const planId = String((ctx && ctx.planId) || '').trim();
        if (!planId) {
          return {
            ok: false,
            error: '当前不在目标型计划轮次里，没有可记录检查事实的计划',
            errorCode: 'NO_GOAL_PLAN',
            retryable: false
          };
        }
        const goalPlan = plansStore.get(planId);
        if (!goalPlan) return { ok: false, error: `没有这个计划：${planId}`, errorCode: 'PLAN_NOT_FOUND' };
        const goalLimits = getAgentLimits(userDataPath, ctx.contextTierId);
        const wantId = String(a.check_id || a.checkId || '').trim();
        const declared = goalChecks(goalPlan);
        const picked = wantId
          ? declared.find((c) => c.id === wantId || c.command === wantId) || null
          : null;
        if (wantId && !picked) {
          return {
            ok: false,
            error: `没有这条声明检查：${wantId}`,
            errorCode: 'CHECK_NOT_FOUND',
            retryable: false,
            suggestedFix: declared.length
              ? `可用的 check_id：${declared.map((c) => c.id).join(' / ')}；也可以直接给 command`
              : '这个计划没有声明检查，直接给 command 一条能失败的命令'
          };
        }
        const goalFact = await runGoalCheck({
          gateway,
          plan: goalPlan,
          command: picked ? picked.command : a.command,
          checkId: picked ? picked.id : '',
          cwd: (goalPlan.goal && goalPlan.goal.cwd) || '',
          limits: goalLimits,
          sessionId: ctx.sessionId,
          runId: ctx.runId,
          round: goalPlan.attempt
        });
        plansStore.pushEvidence(planId, goalFact, goalLimits.goalEvidenceKeep);
        return {
          ok: true,
          passed: goalFact.ok,
          exitCode: goalFact.exitCode,
          note: goalFact.note,
          round: goalFact.round,
          fact: factLine(goalFact),
          tail: goalFact.tail,
          hint: goalFact.ok
            ? '这条检查通过并已记为事实；要收尾就调用 goal_finish(outcome=complete)'
            : '这条检查没通过，事实已记录：先修再重跑，别现在申请完成'
        };
      }
      case 'goal_finish': {
        if (!plansStore) return { ok: false, error: '计划 API 不可用', errorCode: 'PLANS_UNAVAILABLE' };
        const finishPlanId = String((ctx && ctx.planId) || '').trim();
        if (!finishPlanId) {
          return {
            ok: false,
            error: '当前不在目标型计划轮次里，没有可收尾的计划',
            errorCode: 'NO_GOAL_PLAN',
            retryable: false
          };
        }
        const finishPlan = plansStore.get(finishPlanId);
        if (!finishPlan) return { ok: false, error: `没有这个计划：${finishPlanId}`, errorCode: 'PLAN_NOT_FOUND' };
        const outcome = String(a.outcome || '').trim() === 'blocked' ? 'blocked' : 'complete';
        // 只核对「主张与事实是否一致」：不够通过就打回并把事实回灌，判断继续归模型
        const verdict = judgeGoalFinish({ plan: finishPlan, outcome });
        plansStore.recordClaim(finishPlanId, {
          outcome,
          round: finishPlan.attempt,
          accepted: verdict.accept,
          note: String(a.note || '')
        });
        if (!verdict.accept) {
          return {
            ok: true,
            accepted: false,
            outcome,
            reason: verdict.reason,
            facts: verdict.facts,
            hint: '这次收尾申请没有事实支撑（已记录）：继续推进，用 goal_check 取新的事实再申请'
          };
        }
        plansStore.setOutcome(finishPlanId, outcome);
        return {
          ok: true,
          accepted: true,
          outcome,
          facts: verdict.facts,
          hint:
            outcome === 'complete'
              ? '已按完成收尾：本轮结束后不再续跑。把结论、证据出处与遗留项写给用户。'
              : '已记为阻塞：本轮结束后不再续跑。把确切卡点与需要人做什么写给用户。'
        };
      }
      case 'plan_cancel': {
        const cancelPlanRun = typeof deps.cancelPlanRun === 'function' ? deps.cancelPlanRun : null;
        if (!cancelPlanRun) return { ok: false, error: '计划调度未就绪', errorCode: 'PLANS_UNAVAILABLE' };
        const id = String(a.id || '').trim();
        if (!id) return { ok: false, error: 'plan_cancel 需要 id', errorCode: 'MISSING_ARG' };
        const r = cancelPlanRun(id);
        return { ok: !!(r && r.ok !== false), planId: id, result: r };
      }
      case 'agents_md_propose':
        return executeAgentsMdProposeMain(gateway, a, ctx, userDataPath);
      // —— 记忆工具：轮内召回与纠错 ——
      //
      // 自动注入每轮只带 8+5 条，此前模型想不起别的只能认。这里把检索与纠错交回模型；
      // 写入策略（低价值闸 / 近重复）仍然只在 memory.long_add 一处，工具不绕过它。
      case 'session_recall': {
        if (!gateway) return { error: 'Gateway 未就绪', errorCode: 'GATEWAY_UNAVAILABLE' };
        const query = String(a.query || '').trim();
        if (!query) return { error: 'query 必填' };
        const sessionLimits = getAgentLimits(userDataPath, ctx.contextTierId);
        const wantScope = String(a.scope || 'workspace') === 'session' ? 'session' : 'workspace';
        const limit = Math.min(20, Math.max(1, Number(a.limit) || sessionLimits.sessionRecallLimit));
        const wsRoot = ctx.workspacePath || ctx.worktreePath || '';
        if (wantScope === 'workspace' && !wsRoot) {
          return {
            ok: true,
            total: 0,
            results: [],
            note: '当前会话没有绑定工作空间，无法跨会话检索；可改用 scope=session 只看本会话'
          };
        }
        // 路径归一与工作空间圈定都在 Rust 侧（`memory::search_messages` 复用
        // `project_path_key`），这里不写第二份比较口径。
        const searchArgs = {
          query,
          workspacePath: wantScope === 'workspace' ? wsRoot : undefined,
          sessionId: wantScope === 'session' ? ctx.sessionId || undefined : undefined,
          limit,
          snippetChars: sessionLimits.sessionRecallSnippetChars
        };
        const messages = await gateway.invokeRpc('memory.messages_search', searchArgs);
        let folded = null;
        if (a.folded) {
          folded = await gateway.invokeRpc('memory.compaction_folded', {
            ...searchArgs,
            limit: Math.min(limit, sessionLimits.sessionRecallFoldedLimit),
            snippetChars: sessionLimits.sessionRecallSnippetChars * 3
          });
        }
        const msgRows = Array.isArray(messages && messages.results) ? messages.results : [];
        const foldedRows = Array.isArray(folded && folded.results) ? folded.results : [];
        if (!msgRows.length && !foldedRows.length) {
          return {
            ok: true,
            total: 0,
            results: [],
            note: '没找到匹配的既往对话（也可能那段对话在别的工作空间里，或关键词太具体）'
          };
        }
        return {
          ok: true,
          mode: (messages && messages.mode) || 'none',
          total: msgRows.length + foldedRows.length,
          results: [
            ...msgRows.map((r) => ({
              kind: 'message',
              sessionId: r.sessionId || null,
              title: r.title || null,
              role: r.role || '',
              createdAt: r.createdAt || 0,
              snippet: String(r.snippet || '')
            })),
            ...foldedRows.map((r) => ({
              kind: 'folded',
              sessionId: r.sessionId || null,
              createdAt: r.createdAt || 0,
              chars: r.chars || 0,
              snippet: String(r.snippet || '')
            }))
          ],
          note:
            'kind=message 是账本里的原话摘录；kind=folded 是被压缩摘要吞掉的原文片段。' +
            '两者都只是摘录，需要完整上下文就带上 sessionId 问用户是否要继续那次会话'
        };
      }
      case 'memory_recall': {
        if (!gateway) return { error: 'Gateway 未就绪', errorCode: 'GATEWAY_UNAVAILABLE' };
        const query = String(a.query || '').trim();
        if (!query) return { error: 'query 必填' };
        const recallLimits = getAgentLimits(userDataPath, ctx.contextTierId);
        const wantScope = String(a.scope || 'all');
        const limit = Math.min(12, Math.max(1, Number(a.limit) || recallLimits.memoryToolRecallLimit));
        const wsRoot = ctx.workspacePath || ctx.worktreePath || '';
        const collected = [];
        const take = (res, tag) => {
          const rows = res && Array.isArray(res.results) ? res.results : [];
          for (const r of rows) collected.push({ ...r, memoryScope: tag });
        };
        if (wantScope !== 'global' && wsRoot) {
          // 项目记忆的真相是文件 `<workspace>/.dieyun/memory.md`：这里按关键词过滤文件条目
          // 就够了（≤200 条、最新在前），不必为此维护一套项目向量索引。
          try {
            const fr = await gateway.invokeRpc('fs.read_file', {
              filePath: PROJECT_MEMORY_REL_PATH,
              maxBytes: 96000,
              runWorkspaceRoot: wsRoot
            });
            const text = fr && fr.encoding === 'base64' ? '' : String((fr && fr.data) || '');
            const tokens = String(query)
              .toLowerCase()
              .split(/[\s,，、;；/\\]+/)
              .filter((t) => t.length >= 2);
            for (const entry of parseProjectMemoryEntries(text)) {
              const hay = entry.toLowerCase();
              if (tokens.length && !tokens.some((t) => hay.includes(t))) continue;
              collected.push({ memoryScope: 'project', source: PROJECT_MEMORY_REL_PATH, content: entry });
            }
          } catch {
            // 没有文件 = 这个项目还没有沉淀，不是错误
          }
        }
        if (wantScope !== 'project') {
          take(await gateway.invokeRpc('memory.long_recall', { query, scope: 'global', limit }), 'global');
        }
        const seen = new Set();
        const rows = collected
          .filter((r) => r && (r.source === PROJECT_MEMORY_REL_PATH || Number.isFinite(Number(r.id))))
          .filter((r) => {
            const key = r.source === PROJECT_MEMORY_REL_PATH ? `md:${String(r.content || '').slice(0, 80)}` : `id:${Number(r.id)}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
          })
          // 文件条目没有相似度分数：项目记忆在前（它就是本项目的「硬约定」），DB 结果按分数排
          .sort((x, y) => {
            const fx = x.source === PROJECT_MEMORY_REL_PATH ? 1 : 0;
            const fy = y.source === PROJECT_MEMORY_REL_PATH ? 1 : 0;
            if (fx !== fy) return fy - fx;
            return (Number(y.score) || 0) - (Number(x.score) || 0);
          })
          .slice(0, limit);
        if (!rows.length) {
          return {
            ok: true,
            total: 0,
            results: [],
            note: '没找到相关记忆（可能确实没记过，或换个更具体的说法再试）'
          };
        }
        return {
          ok: true,
          total: rows.length,
          results: rows.map((r) =>
            r.source === PROJECT_MEMORY_REL_PATH
              ? {
                  scope: 'project',
                  source: PROJECT_MEMORY_REL_PATH,
                  content: String(r.content || '').slice(0, 400)
                }
              : {
                  id: Number(r.id),
                  scope: r.memoryScope,
                  kind: r.kind || 'normal',
                  importance: r.importance,
                  score: Number(r.score) || 0,
                  content: String(r.content || '').slice(0, 400)
                }
          ),
          note:
            'source=.dieyun/memory.md 的条目没有 id：它们就是文件里的一行，改/删请直接编辑文件；' +
            '其余带 id 的条目可在用户说记错时交给 memory_forget 归档'
        };
      }
      case 'memory_forget': {
        if (!gateway) return { error: 'Gateway 未就绪', errorCode: 'GATEWAY_UNAVAILABLE' };
        const forgetLimits = getAgentLimits(userDataPath, ctx.contextTierId);
        const ids = (Array.isArray(a.memoryIds) ? a.memoryIds : [a.memoryId])
          .map((n) => Number(n))
          .filter((n) => Number.isFinite(n) && n > 0)
          .slice(0, forgetLimits.memoryToolForgetMaxIds);
        if (!ids.length) return { error: 'memoryIds 必填（来自 memory_recall 的结果）' };
        const archived = [];
        for (const id of ids) {
          try {
            await gateway.invokeRpc('memory.long_status_set', { memoryId: id, status: 'archived' });
            archived.push(id);
          } catch {
            // 单条失败不影响其余（id 不存在就是 0 影响）
          }
        }
        if (a.reason) {
          console.log(`[dieyun:memory] forget ${archived.join(',')} · ${String(a.reason).slice(0, 200)}`);
        }
        return {
          ok: archived.length > 0,
          archived,
          requested: ids.length,
          note: archived.length
            ? '已软归档（可恢复）：不再参与注入与召回'
            : '没有可归档的条目（id 可能不存在或已归档）'
        };
      }
      // —— 内网 agent 互通（语义全在 src/peer/coordinator.js，这里只做形状转换）——
      case 'peer_list': {
        if (!peerCoordinator) return { ok: false, error: '内网互通未启用', errorCode: 'PEER_UNAVAILABLE' };
        let peers = peerCoordinator.peers();
        if (a.refresh && typeof peerCoordinator.refresh === 'function') {
          peerCoordinator.refresh();
          peers = peerCoordinator.peers();
        }
        if (a.sameProjectOnly) peers = peers.filter((p) => p.sameWorkspace);
        return {
          ok: true,
          total: peers.length,
          peers: peers.map((p) => ({
            name: p.name,
            peerId: p.peerId,
            address: p.host && p.port ? `${p.host}:${p.port}` : '',
            sameProject: !!p.sameWorkspace,
            lastSeenSec: Math.max(0, Math.round((Date.now() - Number(p.lastSeenAt || 0)) / 1000)),
            claims: (p.claims || []).map((c) => ({
              kind: c.kind,
              key: c.key,
              note: c.note || '',
              expiresInSec: Math.max(0, Math.round((Number(c.expiresAt || 0) - Date.now()) / 1000))
            }))
          })),
          note: peers.length
            ? '同项目（sameProject=true）的对端可以问它正在改什么；它已声明的租约见 claims。'
            : '当前没有发现其他在线 Agent。若确定对方在线，可试 refresh=true 再列一次。'
        };
      }
      case 'peer_claim': {
        if (!peerCoordinator) return { ok: false, error: '内网互通未启用', errorCode: 'PEER_UNAVAILABLE' };
        const action = String(a.action || 'list');
        const r = await peerCoordinator.claim({
          action,
          kind: a.kind,
          key: a.key,
          note: a.note,
          sessionId: ctx.sessionId
        });
        if (r.ok) return r;
        const holders = (r.holders || []).map((c) => ({
          peerName: c.peerName || c.peerId,
          kind: c.kind,
          key: c.key,
          note: c.note || ''
        }));
        return {
          ok: false,
          error: r.error === 'CLAIM_CONFLICT' ? '该文件/任务已被同项目的其他 Agent 声明' : String(r.error || '申领失败'),
          errorCode: String(r.error || 'CLAIM_FAILED'),
          retryable: false,
          // 归一化失败信封会收窄字段，结构化细节一律走 diagnostics（模型能看到、日志也留得住）
          diagnostics: holders.length ? { holders } : undefined,
          suggestedFix:
            r.error === 'CLAIM_CONFLICT'
              ? `先用 peer_send 问 ${holders.map((h) => h.peerName).join('、') || '对方'} 能否让给你，或改做别的文件；不要绕过租约直接改。`
              : undefined
        };
      }
      case 'peer_send': {
        if (!peerCoordinator) return { ok: false, error: '内网互通未启用', errorCode: 'PEER_UNAVAILABLE' };
        const target = String(a.peer || '').trim();
        const host = String(a.host || '').trim();
        const port = Number(a.port) || 0;
        const knownPeers = () => peerCoordinator.peers().map((p) => ({ name: p.name, peerId: p.peerId }));
        if (!target && !(host && port)) {
          const peers = knownPeers();
          return {
            ok: false,
            error: `缺少对端：请给 peer（名称/peerId）或 host+port${peers.length ? `。当前在线：${peers.map((p) => p.name).join('、')}` : '（当前没有其他在线 Agent）'}`,
            errorCode: 'MISSING_ARG',
            retryable: false,
            diagnostics: { peers }
          };
        }
        const r = await peerCoordinator.sendToPeer({
          peer: target,
          host,
          port,
          text: a.text,
          expectReply: !!a.expectReply,
          timeoutMs: a.timeoutMs,
          sessionId: ctx.sessionId
        });
        if (r.ok) {
          return {
            ok: true,
            delivered: true,
            peer: r.peer ? r.peer.name || r.peer.peerId : target,
            reply: r.reply == null ? null : String(r.reply),
            waitedForReply: !!a.expectReply,
            timedOut: r.timeout === true,
            note:
              a.expectReply && r.reply == null && r.timeout
                ? '对方收下了消息，但在超时前没跑完一轮；稍后它的答复会作为你的下一条消息出现。'
                : undefined
          };
        }
        return {
          ok: false,
          error:
            r.error === 'PEER_NOT_FOUND'
              ? '没找到这个对端（可能不在线，或名字不对）'
              : r.error === 'PEER_UNREACHABLE'
                ? '连不上这个对端（不在线 / 防火墙挡住了 peer 端口）'
                : r.error === 'NOT_TRUSTED'
                  ? '对方还没确认这台机器（它那边会弹一次「允许 / 拒绝」，通过后会补投这条消息）'
                  : String(r.error || '发送失败'),
          errorCode: String(r.errorCode || r.error || 'PEER_SEND_FAILED'),
          retryable: r.retryable === true,
          diagnostics: { peers: knownPeers(), address: r.address, detail: r.detail }
        };
      }
      default:
        if (isMcpServerToolName(name)) {
          if (!mcpRuntime) return { error: 'MCP 运行时未就绪', errorCode: 'MCP_UNAVAILABLE', retryable: true };
          return mcpRuntime.callAgentTool(name, a);
        }
        return null;
    }
  }

  async function executeAgentToolInner(name, args, ctx = {}) {
    const toolName = String(name || '');
    const invoke = async () => {
      if (isRendererOnlyTool(toolName)) {
        return requestToolFromRenderer(webContents, toolName, args, 300000, {
          sessionId: ctx.sessionId
        });
      }
      const mainResult = await executeMainOnlyTool(toolName, args, ctx);
      if (mainResult != null) return mainResult;
      return executeGatewayTool(toolName, args, ctx);
    };
    return isMutatingAgentTool(toolName)
      ? runExclusiveMain(invoke, ctx.workspacePath || ctx.worktreePath || ctx.sessionId, {
          tool: toolName,
          sessionId: ctx.sessionId
        })
      : invoke();
  }

  /**
   * 图片读取的视觉注入：模型用 fs_read_file 设 encoding=base64「看图」时，
   * 不再把巨大的 base64 文本塞进工具结果，而是暂存到本轮视觉缓冲，
   * 由 rust-loop-runner 在下一轮 LLM 请求前作为 image_url 注入。
   *
   * 非图片、超限、额度用尽时一律返回结构化说明，不改变读文件本身的失败语义；
   * 读权限与路径白名单仍由底层 fs.read_file 负责，这里不做绕过。
   */
  async function invokeVisionImageRead(toolName, args, ctx, limits, invokeTool) {
    const cfg = resolveVisionLimits(limits);
    const maxBase64Chars = cfg.maxBase64Chars;
    const maxPerRun = cfg.maxPerSource[SOURCE_ATTACHMENT];
    if (!(maxBase64Chars > 0)) return invokeTool(toolName, args);
    // 一次读满到视觉上限对应的原始字节数，避免默认分块把图片截断成坏 base64
    const maxBytes = Math.max(1, Math.floor((maxBase64Chars * 3) / 4));
    const raw = await invokeTool(toolName, { ...args, offset: 0, maxBytes });
    if (!raw || typeof raw !== 'object' || raw.error || raw.ok === false) return raw;
    const base64 = typeof raw.data === 'string' ? raw.data : '';
    const mime = sniffImageMime(base64);
    if (!mime) return raw;
    const path = raw.path || args.filePath;
    if (raw.truncated === true) {
      return {
        ok: false,
        errorCode: 'IMAGE_TOO_LARGE',
        retryable: false,
        error:
          `图片超过单张视觉输入上限（约 ${Math.round(maxBase64Chars / 1024 / 1024)}MB base64），未注入。` +
          '请改用文字描述，或让用户重新发送更小的图片。',
        path
      };
    }
    let queued = false;
    try {
      queued = recordVisionImage(ctx.runId, { source: SOURCE_ATTACHMENT, mime, base64, path }, limits);
    } catch {
      queued = false;
    }
    if (!queued) {
      return {
        ok: false,
        errorCode: 'VISION_BUDGET_EXCEEDED',
        retryable: false,
        error: `本轮补看额度已用完（每轮最多 ${maxPerRun} 张）；请基于已见内容作答，下一轮可再补看。`,
        path
      };
    }
    // 不回传 base64 文本：图片本体只经视觉缓冲进入下一轮
    const out = { ...raw };
    delete out.data;
    return {
      ...out,
      ok: true,
      visionInjected: true,
      mime,
      // 与 record-browser-screenshot 同一契约：这就是「这张图在界面上可以渲染」的凭证
      ...(path ? { imagePaths: [path] } : {}),
      base64Omitted: true,
      base64Length: base64.length,
      note: '图片已作为视觉输入附在下一轮消息中，请直接据此作答，无需重复读取。'
    };
  }

  /**
   * 截图没进视觉通道时的**原因**。
   *
   * 文案本身不在这里拼：成功/失败两句都归 `vision-image` 的单一来源
   * （`visionHandleText` / `visionOmitText`），本函数只负责判定「为什么」。
   */
  function visionDropReason(result, limits) {
    const len = result && typeof result.base64 === 'string' ? result.base64.length : 0;
    // 上限口径必须经 resolveVisionLimits 归一：agent-limits 的键是 visionMaxBase64Chars，
    // 过去这里直接读 limits.maxBase64Chars，取到 undefined，于是「超体积」被误报成
    // 「张数已满或格式不支持」—— 说明文案比没有文案更误导。
    const cap = resolveVisionLimits(limits).maxBase64Chars;
    return cap > 0 && len > cap
      ? `编码后 base64 ${len} 字符，超过单张上限 ${cap}`
      : '本轮同来源截图张数已满，或图片格式不被上游支持';
  }

  /**
   * 取这张图的「可寻址凭证」。
   *
   * 已有落盘路径就直接用（browser_screenshot 自己会存盘），否则现写一份内容寻址副本
   * （computer / browser_observe 的图只活在内存里，base64 注入完即丢）。
   * 模型拿到路径后可以 fs_read_file / host_exec 再看局部细节，不必重拍。
   */
  function visionHandleForShot(shot, result, opts) {
    if (!shot) return null;
    const saved =
      (typeof result.path === 'string' && result.path) ||
      (typeof result.savePath === 'string' && result.savePath) ||
      '';
    const width = Number(shot.width) || 0;
    const height = Number(shot.height) || 0;
    if (saved) {
      return {
        path: saved,
        width,
        height,
        mime: shot.mime || 'image/png',
        bytes: Number(result.bytes) || 0,
        tokens: visionTokensForSize(width, height)
      };
    }
    try {
      return storeVisionImage(shot, opts);
    } catch {
      return null;
    }
  }

  /**
   * MCP 工具返回的图片：送进视觉缓冲，并把 base64 从工具结果里摘掉。
   *
   * 为什么必须在这里做：runtime-manager 把 image part 提炼成 visionImages，
   * 但只有渲染进程侧才持有 runId 与 vision 额度；不接这一段，图片就还是
   * 「模型知道有张图、却看不见像素」，3D 建模的看图闭环断在最后一步。
   *
   * 视觉未开启（模型不支持图）时不注入，但必须**明说**——否则模型会以为自己看过图。
   */
  function absorbMcpVision(result, toolName, ctx, visionEnabled, visionLimits) {
    if (!result || typeof result !== 'object' || !Array.isArray(result.visionImages)) return result;
    const images = result.visionImages;
    const rest = { ...result };
    delete rest.visionImages;
    const runId = ctx && ctx.runId;
    const storeOpts = {
      workspacePath: (ctx && (ctx.workspacePath || ctx.worktreePath)) || '',
      userDataPath,
      limits: visionLimits
    };
    let queued = 0;
    const handles = [];
    if (visionEnabled && runId) {
      for (const img of images) {
        try {
          const ok = recordVisionImage(
            runId,
            {
              source: SOURCE_MCP,
              tool: toolName,
              mime: img && img.mime,
              base64: img && img.base64
            },
            visionLimits,
            { evictOldest: true }
          );
          if (ok) {
            queued += 1;
            // 入队的图才留副本：没入队的图模型本来就够不着，留文件只是占盘
            const handle = storeVisionImage(img, storeOpts);
            if (handle) handles.push(handle);
          }
        } catch {
          /* 单张失败不影响其它图片与工具结果 */
        }
      }
    }
    let suffix;
    if (queued > 0) {
      // 副本路径一并给出：MCP 图往往「看过一次就想放大看细节」，重调工具未必拿得到同一帧
      const shown = handles.slice(0, 2).map((h) => visionHandleText(h)).join('');
      const more = handles.length > 2 ? `（另有 ${handles.length - 2} 张副本同目录）` : '';
      suffix = `图片已作为视觉输入附在下一轮（${queued} 张），请直接据此判断，无需重复调用。${shown}${more}`;
    } else if (visionEnabled) {
      // 失败句与截图路径同一来源（vision-image），这里只补「怎么办」
      suffix =
        visionOmitText('超出单张体积或每轮张数上限', null) +
        '需要看图请降低分辨率后重取，或分批调用。';
    } else {
      suffix =
        visionOmitText('当前模型未开启视觉输入', null) +
        '请改用工具返回的文字/数值字段判断，或让用户看图确认。';
    }
    return {
      ...rest,
      visionInjected: queued > 0,
      visionImagesProvided: images.length,
      visionImagesDropped: images.length - queued,
      // 界面可渲染的图片凭证（与 record-browser-screenshot 同一契约）：只列真的留下来副本的那些
      ...(handles.length ? { imagePaths: handles.map((h) => h.path) } : {}),
      note: [rest.note, suffix].filter(Boolean).join(' ')
    };
  }

  async function executeAgentTool(name, args, ctx = {}) {
    if (ctx.signal?.aborted) {
      const err = new Error('已停止');
      err.name = 'AbortError';
      err.code = 'ABORT_ERR';
      throw err;
    }
    if (ctx.runId) {
      try {
        const { isRunAborted, ensureRunAbortController } = require('./run-cancel-registry');
        ensureRunAbortController(ctx.runId, ctx.sessionId);
        if (isRunAborted(ctx.runId)) {
          const err = new Error('已停止');
          err.name = 'AbortError';
          err.code = 'ABORT_ERR';
          throw err;
        }
      } catch (e) {
        if (e && (e.name === 'AbortError' || e.code === 'ABORT_ERR')) throw e;
      }
    }
    const harnessCtx = {
      runId: ctx.runId,
      sessionId: ctx.sessionId,
      model: ctx.model,
      contextTierId: ctx.contextTierId,
      taskTier: ctx.taskTier || null,
      workspacePath: ctx.workspacePath || ctx.worktreePath,
      userDataPath
    };
    const harness = getToolHarnessSession(harnessCtx);
    const visionEnabled = ctx && ctx.browserVision === true;
    const visionLimits = visionEnabled ? getAgentLimits(userDataPath, ctx.contextTierId) : null;
    const invokeTool = (n, a) => executeAgentToolInner(n, a, ctx);
    // 归一**一次**：之后关卡、视觉判定、出站净化、写味提示都只看 `call.name`（别名已展开）。
    const call = createToolCall({
      name,
      args,
      harness,
      // 权限快照由 Main 直接给（这里 `gateway` 就是那份 store 的主人），关卡不必每次调用再读盘；
      // 拿不到（gateway 未起）时传 null，关卡自己按 userDataPath 读**同一个** host-permissions.json。
      permissions: gateway && typeof gateway.getPermissions === 'function' ? gateway.getPermissions() : null,
      // 外层追加的 after 关卡：与 harness 自带的遥测/落盘共用一个顺序机制，
      // 位置即语义（落盘 → 视觉吸收 → 截图暂存 → 出站净化 → 写味提示）。
      extraAfterHooks: [
        {
          id: 'absorb-mcp-vision',
          stage: 'after',
          run(c) {
            c.result = absorbMcpVision(c.result, c.name, ctx, visionEnabled, visionLimits);
          }
        },
        {
          id: 'record-browser-screenshot',
          stage: 'after',
          run(c) {
            if (!ctx.runId) return;
            if (!visionEnabled) {
              // 文本模型：截图/照片照常剥离，但要明说「看不到」，否则模型以为画面已入眼
              // （camera_look 同样处理：拍了照却没进视觉通道时，模型最容易编造看到的内容）
              if ((c.name === 'computer' || c.name === 'camera_look') && c.result && c.result.base64) {
                c.result = {
                  ...c.result,
                  note:
                    visionOmitText('当前模型未开启视觉输入', null) +
                    '请让用户在模型设置里选择多模态模型后重试，或改用文本途径（host_exec / browser_snapshot）获取信息。'
                };
              }
              return;
            }
            // 结果里确实带了图（base64 还没被 sanitize 摘掉）却没能入队时，必须明说。
            // 过去这里忽略返回值，而工具结果默认还写着「将作为视觉输入附到下一轮」——
            // 4K 整屏 PNG 顶穿单张上限被整张丢弃，模型却一直在等一张永不到来的图。
            const shot = extractShot(c.name, c.result);
            // 手机照片**不落盘**：现实画面（人、房间、桌上的东西）留副本等于把手机变成
            // 一台没人要求的录音笔，而「再看细节」的正当解法是再拍一张。
            const isCameraShot = c.name === 'camera_look';
            // 先落盘再入队：入队失败时模型至少还有一份可读副本，不至于彻底够不着这一帧。
            const handle = shot && !isCameraShot
              ? visionHandleForShot(shot, c.result, {
                  workspacePath: ctx.workspacePath || ctx.worktreePath,
                  userDataPath,
                  limits: visionLimits
                })
              : null;
            let queued = false;
            try {
              queued = recordBrowserScreenshot(ctx.runId, c.name, c.result, visionLimits);
            } catch {
              /* 截图暂存失败不影响工具结果 */
            }
            if (shot || handle) {
              // 成功也明说，失败更明说：模型对「我到底看见没看见」的判断只能靠这句话。
              c.result = {
                ...c.result,
                ...(handle
                  ? {
                      ...(handle.id ? { visionImage: handle.id } : {}),
                      ...(handle.tokens > 0 ? { visionTokens: handle.tokens } : {}),
                      // UI 侧「这张图能在界面上渲染」的唯一字段（渲染进程只认它，不解析文案里的路径）。
                      // 只在结果本身没有落盘路径时补：browser_screenshot 自带 path / savePath，
                      // 再写一遍就是同一事实的第二个表示。
                      ...(!c.result.path && !c.result.savePath ? { imagePaths: [handle.path] } : {})
                    }
                  : {}),
                note: queued
                  ? isCameraShot
                    ? visionCameraText(shot.width, shot.height)
                    : visionHandleText(handle, '这张图会作为图片输入附在下一轮；不要重复截同一屏。') ||
                      '截图已进入视觉通道，会作为图片输入附在下一轮；不要重复截同一屏。'
                  : visionOmitText(
                      visionDropReason(shot ? { base64: shot.base64 } : c.result, visionLimits),
                      handle
                    )
              };
            }
          }
        },
        {
          id: 'sanitize-result',
          stage: 'after',
          run(c) {
            c.result = sanitizeToolResultForApi(c.name, c.result);
          }
        },
        {
          id: 'write-smell-hints',
          stage: 'after',
          async run(c) {
            c.result = await withWriteSmellHints(c.name, c.args, c.result, ctx);
          }
        }
      ]
    });
    return harness.execute(call, (n, a) =>
      visionEnabled && ctx.runId && isVisionImageReadRequest(n, a)
        ? invokeVisionImageRead(n, a, ctx, visionLimits, invokeTool)
        : invokeTool(n, a)
    );
  }

  return {
    executeAgentTool,
    isMutatingAgentTool,
    sanitizeToolResultForApi,
    clearHarnessSession: (ctx) => clearToolHarnessSession(ctx)
  };
}

module.exports = {
  createMainToolBridge,
  isMutatingAgentTool,
  sanitizeToolResultForApi,
  sniffImageMime,
  isVisionImageReadRequest,
  MUTATING_TOOLS
};
