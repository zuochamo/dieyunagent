'use strict';

const { delegateAgentToolViaGateway } = require('./delegate-tool-gateway');
const { isRendererOnlyTool, requestToolFromRenderer } = require('./renderer-tool-delegate');
const { getToolHarnessSession, clearToolHarnessSession } = require('./tool-harness');
const { isMutatingAgentTool, MUTATING_TOOLS } = require('./tool-classify');
const { normalizeAgentToolName } = require('./guardrails-shared');
const { getAgentLimits } = require('./agent-limits');
const {
  collectWriteSmellHints,
  relDirOf,
  relDirGlobPattern,
  filterDirNames
} = require('./write-smell-hints');
const {
  executePlaybookProposeMain,
  executeAgentsMdProposeMain
} = require('./propose-tools-main');

const { runExclusive, isWorkspaceMutateBusy } = require('./mutate-queue');
const {
  recordBrowserScreenshot,
  recordVisionImage,
  resolveVisionLimits,
  SOURCE_ATTACHMENT
} = require('./browser-vision');

/**
 * 用文件头魔数判断 base64 是否为图片，并给出准确的 mime。
 * 只认确定无歧义的魔数：无法判定时返回空串，调用方退回原有「读文件」语义。
 */
function sniffImageMime(base64) {
  if (typeof base64 !== 'string' || base64.length < 12) return '';
  let head;
  try {
    head = Buffer.from(base64.slice(0, 24), 'base64');
  } catch {
    return '';
  }
  if (head.length >= 8 && head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47) {
    return 'image/png';
  }
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) {
    return 'image/jpeg';
  }
  if (head.length >= 6) {
    const six = head.subarray(0, 6).toString('latin1');
    if (six === 'GIF87a' || six === 'GIF89a') return 'image/gif';
  }
  if (
    head.length >= 12 &&
    head.subarray(0, 4).toString('latin1') === 'RIFF' &&
    head.subarray(8, 12).toString('latin1') === 'WEBP'
  ) {
    return 'image/webp';
  }
  if (head.length >= 2 && head[0] === 0x42 && head[1] === 0x4d) return 'image/bmp';
  return '';
}

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

function runExclusiveMain(fn, workspaceKey) {
  return runExclusive(fn, workspaceKey);
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
          skillIds: a.skillIds || []
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
      case 'playbook_propose':
        return executePlaybookProposeMain(gateway, a, ctx);
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
      ? runExclusiveMain(invoke, ctx.workspacePath || ctx.worktreePath || ctx.sessionId)
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
    const raw = await harness.execute(name, args, (n, a) =>
      visionEnabled && ctx.runId && isVisionImageReadRequest(n, a)
        ? invokeVisionImageRead(n, a, ctx, visionLimits, invokeTool)
        : invokeTool(n, a)
    );
    if (visionEnabled && ctx.runId) {
      try {
        recordBrowserScreenshot(ctx.runId, name, raw, visionLimits);
      } catch {
        /* 截图暂存失败不影响工具结果 */
      }
    }
    // harness 内部已归一化并据此执行，但这里拿到的是原始 name/args：再归一一次，
    // 否则模型用 write_file / edit / str_replace_editor 等别名时判定会被整体跳过。
    const norm = normalizeAgentToolName(name, args);
    return withWriteSmellHints(norm.name, norm.args, sanitizeToolResultForApi(name, raw), ctx);
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
