'use strict';

const { delegateAgentToolViaGateway } = require('./delegate-tool-gateway');
const { isRendererOnlyTool, requestToolFromRenderer } = require('./renderer-tool-delegate');
const { getToolHarnessSession, clearToolHarnessSession } = require('./tool-harness');
// 关卡装配（归一 + before/after 顺序）的唯一来源；本文件只追加自己的 after 关卡。
const { createToolCall } = require('./tool-gate');
const { isMutatingAgentTool, MUTATING_TOOLS } = require('./tool-classify');
const { sniffVisionImageMime } = require('./guardrails-shared');
const { getAgentLimits } = require('./agent-limits');
const {
  collectWriteSmellHints,
  relDirOf,
  relDirGlobPattern,
  filterDirNames
} = require('./write-smell-hints');
const { executeAgentsMdProposeMain } = require('./propose-tools-main');

const { runExclusive } = require('./mutate-queue');
const {
  recordBrowserScreenshot,
  recordVisionImage,
  resolveVisionLimits,
  SOURCE_ATTACHMENT,
  SOURCE_MCP
} = require('./browser-vision');

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
      display: result.display,
      primary: result.primary,
      screen: result.screen,
      cursor: result.cursor,
      activeWindow: result.activeWindow,
      mime: result.mime,
      width: result.width,
      height: result.height,
      base64Omitted: true,
      base64Length: String(result.base64).length,
      note: result.note || '已截取当前屏幕画面；PNG 不随本工具结果返回，将作为视觉输入附到下一轮'
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
      base64Omitted: true,
      base64Length: String(result.base64).length,
      note: 'Screenshot captured; PNG kept out of this tool payload'
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
  const plansStore = deps.plansStore || null;
  const plansCreateFromText = deps.plansCreateFromText || null;
  const createUserSkill = deps.createUserSkill || null;
  const onSkillsChanged = deps.onSkillsChanged || null;
  const browserService = deps.browserService || null;
  const userDataPath = deps.userDataPath || '';

  /** 有界等待：超时或失败一律 resolve(null)，交由调用方降级。 */
  function withTimeout(promise, ms) {
    const wait = Number(ms);
    if (!Number.isFinite(wait) || wait <= 0) return Promise.resolve(promise);
    return new Promise((resolve) => {
      let done = false;
      const settle = (v) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(v);
      };
      const timer = setTimeout(() => settle(null), wait);
      Promise.resolve(promise).then(settle, () => settle(null));
    });
  }

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
        getAgentLimits(userDataPath, ctx.contextTierId).writeSmellScanTimeoutMs
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

  async function executeMainOnlyTool(name, args, ctx) {
    const a = args || {};
    switch (name) {
      case 'mcp_tool_schema': {
        if (!mcpRuntime || typeof mcpRuntime.lookupToolSchema !== 'function') {
          return { error: 'MCP 运行时未就绪', errorCode: 'MCP_UNAVAILABLE', retryable: false };
        }
        return mcpRuntime.lookupToolSchema(String(a.agentName || ''));
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
      case 'plan_create': {
        if (!plansCreateFromText) return { error: '计划 API 不可用' };
        const todoText =
          Array.isArray(a.todos) && a.todos.length
            ? `\n\nTODO：\n${a.todos.map((t, i) => `${i + 1}. ${String(t || '').trim()}`).join('\n')}`
            : '';
        const r = await plansCreateFromText({
          text: `${a.description || a.text || ''}${todoText}`,
          skillIds: a.skillIds || [],
          // 结构化优先：模型直接给出 rrule/onceAt 时免 LLM 解析
          structured: {
            name: a.name,
            rrule: a.rrule,
            onceAt: a.onceAt,
            prompt: a.prompt,
            todos: a.todos,
            skillIds: a.skillIds
          },
          // 计划绑定本次运行的路由：定时执行（无 Renderer）据此自洽解析模型配置
          modelRoute: ctx && ctx.modelRoute ? ctx.modelRoute : undefined,
          model: ctx && ctx.model ? ctx.model : undefined
        });
        return {
          ok: true,
          plan: r.plan,
          message: `已创建计划「${r.plan.name}」`
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
            rrule: p.rrule,
            onceAt: p.onceAt,
            todos: Array.isArray(p.todos) ? p.todos : [],
            // 计划绑定的模型与路由（只存路由不存 key）：便于判断到点会用哪个模型执行
            model: p.model || '',
            modelRoute: p.modelRoute || '',
            sessionId: p.deliver?.sessionId,
            lastRunAt: p.lastRunAt
          }))
        };
      }
      case 'plan_delete': {
        if (!plansStore) return { error: '计划 API 不可用' };
        plansStore.delete(a.id);
        return { ok: true, deleted: a.id };
      }
      case 'agents_md_propose':
        return executeAgentsMdProposeMain(gateway, a, ctx, userDataPath);
      default:
        if (String(name).startsWith('mcp_')) {
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
      base64Omitted: true,
      base64Length: base64.length,
      note: '图片已作为视觉输入附在下一轮消息中，请直接据此作答，无需重复读取。'
    };
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
    const { visionImages, ...rest } = result;
    const runId = ctx && ctx.runId;
    let queued = 0;
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
          if (ok) queued += 1;
        } catch {
          /* 单张失败不影响其它图片与工具结果 */
        }
      }
    }
    let suffix;
    if (queued > 0) {
      suffix = `图片已作为视觉输入附在下一轮（${queued} 张），请直接据此判断，无需重复调用。`;
    } else if (visionEnabled) {
      suffix =
        '图片未能注入（超出单张体积或每轮张数上限）；需要看图请降低分辨率后重取，或分批调用。';
    } else {
      suffix =
        '当前模型未开启视觉输入，图片不会被看到；请改用工具返回的文字/数值字段判断，或让用户看图确认。';
    }
    return {
      ...rest,
      visionInjected: queued > 0,
      visionImagesProvided: images.length,
      visionImagesDropped: images.length - queued,
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
      longHorizon: !!ctx.longHorizon,
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
              // 文本模型：截图照常剥离，但要明说「看不到」，否则模型以为画面已入眼
              if (c.name === 'computer' && c.result && c.result.base64) {
                c.result = {
                  ...c.result,
                  note:
                    '当前模型未开启视觉输入，这张截图不会被看到。请让用户在模型设置里选择多模态模型后重试，或改用文本途径（host_exec / browser_snapshot）获取信息。'
                };
              }
              return;
            }
            try {
              recordBrowserScreenshot(ctx.runId, c.name, c.result, visionLimits);
            } catch {
              /* 截图暂存失败不影响工具结果 */
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
