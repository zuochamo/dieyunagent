'use strict';

const { delegateAgentToolViaGateway } = require('./delegate-tool-gateway');
// Main 专属工具的执行体：工具名 → 执行体（每个域一个文件，见 main-tools/）
const { createMainToolHandlers } = require('./main-tools');
// 手机摄像头（camera_look）的唯一出口：协议参数、结果校验、失败文案都在那边。
const { createPhoneCameraSource } = require('../mobile/camera-source');
// 本机摄像头（desktop_camera_look）的唯一出口：ffmpeg 抓帧、设备挑选、失败文案都在那边。
const { createDesktopCameraSource } = require('./desktop-camera-source');
const { createDesktopCameraPtz } = require('./desktop-camera-ptz');
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
const { getAgentLimits, resolveAgentLoopSpec } = require('./agent-limits');
// 自检工具（agent_inspect）要报「最近哪些工具老失败」：摘要是唯一来源，不在这里另算一份。
const { summarizeTelemetry } = require('./tool-telemetry');
// 视觉注入预算的编码器（缩长边 → PNG → JPEG → 再缩）唯一实现在 computer/capture.js，
// 浏览器截图的整页大图也走它，避免两处各写一套缩放规则。
const { encodeWithinBudget } = require('../computer/capture');
const { withTimeout } = require('../timeout');
const {
  collectWriteSmellHints,
  relDirOf,
  relDirGlobPattern,
  filterDirNames
} = require('./write-smell-hints');
const { executeAgentsMdProposeMain } = require('./propose-tools-main');
// 技能删除的唯一实现（与 IPC skills:delete 共用）
const { deleteUserSkill, updateUserSkill: updateUserSkillImpl } = require('../agent-home');
// MCP 工具的「按用户提问召回」只此一份实现：渲染器装工具表用它，模型的
// mcp_tool_schema(query) 也用它 —— 两处若各写一套排序，检索结果会互相打架。
const { recallAgentTools } = require('../tools/tool-vector-index');
const { slimMcpInputSchema } = require('./tool-catalog');
// 目标（计划目标 / 会话目标）的三个工具：事实与核对全在 plans/goal-run，
// 本文件只做「取上下文 → 调它 → 把事实回给模型」，不在这里判完成。
const {
  goalChecks,
  runGoalCheck,
  judgeGoalFinish,
  factLine
} = require('../plans/goal-run');
// 会话目标的唯一读写点（计划目标走 plansStore，两者共用同一份 goal 语义）
const sessionGoalStore = require('../goals/session-goal');
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

/** 默认解码器：Electron 主进程的 nativeImage。测试可注入替身。 */
function decodeNativeImage(buffer) {
  const { nativeImage } = require('electron');
  const img = nativeImage.createFromBuffer(buffer);
  if (!img || (typeof img.isEmpty === 'function' && img.isEmpty())) return null;
  return img;
}

/**
 * 把一张工具产出的图片压进「视觉注入预算」（长边 `visionShotMaxEdge` + 单张 base64 上限）。
 *
 * 为什么必须在**入队前**压，而不是「超限就丢」：`browser_screenshot` 按原生分辨率出图，
 * 整页截图实测 2656×11460（长宽比 1:4.3、3000 万像素），这种图既不是模型能用的输入，
 * 也会被上游当成「图片不合规」把**整轮**请求打成 HTTP 400（`image data rejected`），
 * 于是 agent 循环连文字都发不出去。agent-limits 里 `visionShotMaxEdge` 的注释一直写着
 * 「电脑控制 / 浏览器截图」，但过去只有 computer 走了这条缩放。
 *
 * 只改「注入给模型的那一份」：落盘留证仍是原生分辨率（模型按只读副本看细节）。
 * 编码与降级顺序（缩长边 → PNG → 仍超体积换 JPEG → 再缩）复用
 * `computer/capture.js:encodeWithinBudget`，不在这里另写一份。
 *
 * @param {{ base64?: string, mime?: string, width?: number, height?: number, source?: string, tool?: string }} shot
 * @param {object} [limits] agent-limits 解析结果
 * @param {{ decode?: Function }} [opts] `decode(buffer)` 返回 nativeImage（测试注入用）
 * @returns {{ source?: string, tool?: string, mime: string, base64: string, width: number, height: number } | null}
 *   已在预算内、或解码/编码失败时返回 null（调用方按原图入队，让既有「为什么没注入」的判定照常工作）
 */
function fitVisionShotToBudget(shot, limits, opts = {}) {
  const base64 = shot && typeof shot.base64 === 'string' ? shot.base64 : '';
  if (!base64) return null;
  const cfg = resolveVisionLimits(limits);
  const width = Math.floor(Number(shot.width)) || 0;
  const height = Math.floor(Number(shot.height)) || 0;
  const longEdge = Math.max(width, height);
  const withinEdge = !(cfg.maxEdge > 0) || (longEdge > 0 && longEdge <= cfg.maxEdge);
  // 上限为 0 表示「不按体积判」——与 recordVisionImage 的口径一致（那边 0 即不限）
  const withinChars = !(cfg.maxBase64Chars > 0) || base64.length <= cfg.maxBase64Chars;
  // 预算内的常见情形：不解码、不重编码，零成本直通
  if (withinEdge && withinChars) return null;
  let image;
  try {
    const decode = typeof opts.decode === 'function' ? opts.decode : decodeNativeImage;
    image = decode(Buffer.from(base64, 'base64'));
  } catch {
    return null;
  }
  if (!image) return null;
  const enc = encodeWithinBudget(image, {
    maxEdge: cfg.maxEdge,
    maxBase64Chars: cfg.maxBase64Chars
  });
  // 缩到底预算仍不够：不假装成功，交回原图让 recordVisionImage 按既有口径拒绝并如实说明
  if (!enc || !enc.base64 || enc.overBudget) return null;
  return {
    ...(shot.source ? { source: shot.source } : {}),
    ...(shot.tool ? { tool: shot.tool } : {}),
    mime: enc.mime,
    base64: enc.base64,
    width: enc.width,
    height: enc.height
  };
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
  if (name === 'desktop_camera_look' && result.base64) {
    // 本机摄像头同一条契约：像素走视觉缓冲，结果只留事实（哪台设备、多大、什么时候）。
    return {
      ok: result.ok,
      device: result.device,
      mime: result.mime,
      width: result.width,
      height: result.height,
      capturedAt: result.capturedAt,
      ...(result.visionImage ? { visionImage: result.visionImage } : {}),
      ...(result.visionTokens ? { visionTokens: result.visionTokens } : {}),
      base64Omitted: true,
      base64Length: String(result.base64).length,
      note: result.note || '本机摄像头已抓好一张照片；图片本体不随工具结果返回'
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
  // 改技能正文：与删除同一条路（agent-home#updateUserSkill），测试可注入替身
  const updateUserSkill = deps.updateUserSkill || updateUserSkillImpl || null;
  const onSkillsChanged = deps.onSkillsChanged || null;
  const userDataPath = deps.userDataPath || '';
  /**
   * 「申请开某项能力」送到界面：与 `mcp_manage.request_credential` 合流成同一条通道
   * （`agent:capability-request`，payload 带 `kind`）。没有窗口（频道 / headless / 计划轮）
   * 时为 null —— 工具会如实回 `CAPABILITY_UI_UNAVAILABLE`，不假装弹过。
   */
  const notifyCapabilityRequest =
    typeof deps.notifyCapabilityRequest === 'function'
      ? deps.notifyCapabilityRequest
      : webContents && typeof webContents.isDestroyed === 'function'
        ? (payload) => {
            if (!webContents.isDestroyed()) webContents.send('agent:capability-request', payload || {});
          }
        : null;
  // 内网 agent 互通（src/peer）：Main 创建的协调器；未启用时三个 peer_* 工具退化为结构化错误，
  // 不做「静默无此工具」——模型需要知道「这个能力没开」而不是「能力不存在」。
  const peerCoordinator = deps.peerCoordinator || null;
  // SSH 动作（连/断/端口转发/切远端工作空间）：与 IPC 同一份实现，见 src/ssh/actions.js
  const sshActions = deps.sshActions || null;
  // Worktree（并行副本）：与设置页同一份实现，见 src/worktree/actions.js
  const worktreeActions = deps.worktreeActions || null;

  /**
   * 身体（点点）：`pet_set` / `pet_act` 的执行体只认这一个桥（显隐 / 参数 / 瞬时动作）。
   * 无界面宿主没有宠物，取到 null → 工具回结构化 PEER 式的 PET_UNAVAILABLE。
   */
  const getPetBridge = typeof deps.getPetBridge === 'function' ? deps.getPetBridge : null;
  // 手机摄像头：`getMobileBridge` 用取值函数传进来（手机桥由 Main 启动时创建，
  // 工具桥装配时刻可能还没有它；重连/换端口后也总是拿到最新实例）。
  // 没接手机桥时保留 null —— camera_look 会退化成一句结构化错误，而不是「工具不存在」。
  const cameraSource = typeof deps.getMobileBridge === 'function'
    ? createPhoneCameraSource({ getBridge: deps.getMobileBridge })
    : null;
  // 本机摄像头：不需要外部桥（ffmpeg + 本机 UVC），所以总是装得上；
  // 没有 ffmpeg / 没有设备时由来源自己回结构化错误，而不是「工具不存在」。
  // `deps.desktopCameraSource` 供 smoke 测试注入桩（不插摄像头也能验证工具分支）。
  const desktopCameraSource =
    deps.desktopCameraSource && typeof deps.desktopCameraSource.capture === 'function'
      ? deps.desktopCameraSource
      : createDesktopCameraSource();
  // 本机云台：与取帧同一台设备，但走另一条通道（DirectShow COM / v4l2-ctl），见
  // `desktop-camera-ptz.js`。`deps.desktopCameraPtz` 供 smoke 测试注入桩。
  const desktopCameraPtz =
    deps.desktopCameraPtz && typeof deps.desktopCameraPtz.apply === 'function'
      ? deps.desktopCameraPtz
      : createDesktopCameraPtz();


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

  async function executeGatewayTool(name, args, ctx) {
    if (!gateway) throw new Error('Gateway 未就绪');
    return delegateAgentToolViaGateway(gateway, name, args, ctx);
  }

  /**
   * Main 专属工具的注册表（域文件见 `main-tools/`，装配只在这里）。
   */
  const mainToolHandlers = createMainToolHandlers({
    cameraSource,
    desktopCameraSource,
    desktopCameraPtz,
    getAgentLimits,
    // 自检工具：循环预算与遥测算子都从既有单一来源取（不在这里重算）
    resolveAgentLoopSpec,
    summarizeTelemetry,
    notifyCapabilityRequest,
    userDataPath,
    mcpRuntime,
    mcpManager,
    webContents,
    sshActions,
    worktreeActions,
    createUserSkill,
    updateUserSkill,
    onSkillsChanged,
    deleteUserSkill,
    plansStore,
    plansCreateFromText,
    gateway,
    sessionGoalStore,
    peerCoordinator,
    deps,
    judgeGoalFinish,
    goalChecks,
    runGoalCheck,
    factLine,
    PROJECT_MEMORY_REL_PATH,
    parseProjectMemoryEntries,
    isMcpServerToolName,
    executeAgentsMdProposeMain,
    recallAgentTools,
    slimMcpInputSchema,
    loadModelSettings,
    getEmbeddingConfig,
    // 身体（点点）：聊天轮的 pet_set / pet_act（语义在 alive/pet-tools.js）
    getPetBridge
  });

  /**
   * 执行「只有 Main 能做」的工具：查注册表 → 命中就执行；未命中返回 null，
   * 由调用方继续走 Gateway 委托。**null 是协议**（不是失败），别改成抛错。
   */
  async function executeMainOnlyTool(name, args, ctx) {
    const a = args || {};
    const handler = mainToolHandlers[name];
    if (handler) return handler(a, ctx);
    // 用户自己装的 MCP 服务注册出来的工具：远端执行；缺运行时就说清「能力没开」。
    if (isMcpServerToolName(name)) {
      if (!mcpRuntime) return { error: 'MCP 运行时未就绪', errorCode: 'MCP_UNAVAILABLE', retryable: true };
      return mcpRuntime.callAgentTool(name, a);
    }
    return null;
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
    // 队列键 = **这一轮真正写的地方**：worktree 优先。
    //
    // 顺序不能写反：planner 的并行 worker 会同时带上 workspacePath（主工作区，供沙箱/索引用）
    // 与 worktreePath（自己的副本）。键取主工作区 → 所有 worker 挤在同一把锁上，
    // 「并行」退化成排队（还查不出来：日志里每个工具都成功，只是慢）。
    // 单循环运行没有 worktreePath，行为不变。
    return isMutatingAgentTool(toolName)
      ? runExclusiveMain(invoke, ctx.worktreePath || ctx.workspacePath || ctx.sessionId, {
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
    // **整份 ctx 透传**，不逐字段手抄：关卡读的 ctx 字段（`readOnly` / `senses` / `wakePower` /
    // `wakeRoot` / `wakeBudget` / `allowedToolNames` / `harnessRunKey`）由 `tool-gate.callContext`
    // 统一归一，这里再抄一遍就必然漏 —— 漏掉的正是 `allowedToolNames`，于是子 Agent 的
    // 只读白名单（`hookSubagentScope`）在生产链路上恒为 null = 不拦（2026-11-21 审计 P0）。
    const harnessCtx = {
      ...ctx,
      // 工作区口径仍在这里归一：调用方有用 workspacePath、有用 worktreePath（子 Agent/worker）
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
              // （camera_look / desktop_camera_look 同样处理：拍了照却没进视觉通道时，
              // 模型最容易编造看到的内容）
              const CAMERA_TOOL_NAMES = ['camera_look', 'desktop_camera_look'];
              if (
                (c.name === 'computer' || CAMERA_TOOL_NAMES.includes(c.name)) &&
                c.result &&
                c.result.base64
              ) {
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
            // 摄像头照片**不落盘**：现实画面（人、房间、桌上的东西）留副本等于把摄像头变成
            // 一台没人要求的录音笔，而「再看细节」的正当解法是再拍一张。
            // 手机与本机（desktop_camera_look）是同一契约，只有称呼不同。
            const isDesktopCameraShot = c.name === 'desktop_camera_look';
            const isCameraShot = c.name === 'camera_look' || isDesktopCameraShot;
            const cameraSubject = isDesktopCameraShot ? '本机摄像头' : '手机摄像头';
            // 整页截图可能到 2656×11460：注入前先按视觉预算（长边 + 单张体积）缩小，
            // 否则这张图会以「图片不合规」把整轮请求打成上游 400（见 fitVisionShotToBudget）。
            const fitted = shot && !isCameraShot ? fitVisionShotToBudget(shot, visionLimits) : null;
            // 先落盘再入队：入队失败时模型至少还有一份可读副本，不至于彻底够不着这一帧。
            // 凭证里的尺寸按**注入的那一份**报（缩小后模型看的就不是原生像素了），
            // 但 base64 保持原生：落盘副本是全分辨率的，模型据此能裁剪放大看小字。
            const handle = shot && !isCameraShot
              ? visionHandleForShot(
                  fitted ? { ...shot, width: fitted.width, height: fitted.height } : shot,
                  c.result,
                  {
                    workspacePath: ctx.workspacePath || ctx.worktreePath,
                    userDataPath,
                    limits: visionLimits
                  }
                )
              : null;
            let queued = false;
            try {
              queued = fitted
                ? recordVisionImage(ctx.runId, fitted, visionLimits, { evictOldest: true })
                : recordBrowserScreenshot(ctx.runId, c.name, c.result, visionLimits);
            } catch {
              /* 截图暂存失败不影响工具结果 */
            }
            if (shot || handle) {
              // 成功也明说，失败更明说：模型对「我到底看见没看见」的判断只能靠这句话。
              // 缩小过就必须说明：看到的像素不是原生尺寸，小字要按只读副本核。
              const shrinkHint = fitted && shot.width > 0 && shot.height > 0
                ? `${shot.width}×${shot.height} 的图已缩到 ${fitted.width}×${fitted.height} 注入，小字细节请读只读副本或用 host_exec 裁剪。`
                : '';
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
                    ? visionCameraText(shot.width, shot.height, cameraSubject)
                    : visionHandleText(
                        handle,
                        '这张图会作为图片输入附在下一轮；不要重复截同一屏。' + shrinkHint
                      ) || '截图已进入视觉通道，会作为图片输入附在下一轮；不要重复截同一屏。'
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
  fitVisionShotToBudget,
  MUTATING_TOOLS
};
