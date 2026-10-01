/* global gatewayCall, gwState, settings, getComposerAgentMode, compactPlainText, getContextFilePathsForAgent, getSessionChangeRowsForAgent, getAgentLimits, withSessionRpcScope, currentSessionId, getMergedContextFilePaths, resolveSessionWorkspacePath, resolveSessionWorkspacePathSync, extractPathHintsFromText */
'use strict';

/**
 * 结构信号纯函数（@Codebase 识别、路径提取、是否注入代码 / 自动检索、codebase 块格式化）
 * 的**唯一来源**是 src/agent/context-signals.js：Main 直接 require，Renderer 经
 * agent-bundle.js 注册为 window.ContextSignals（index.html 中先于本文件加载）。
 *
 * 本文件只保留「Renderer 编辑器状态 → snapshot.editor」的薄适配，勿再自抄判定逻辑；
 * textHasCodebaseMention / extractPathHintsFromText / formatCodebaseBlock /
 * extractCodebasePathsFromBlock 已由 bundle 的 compat 直接挂到 window，本文件不再复制。
 *
 * 各类 **召回** 同理不在此层：codebase（fetchCodebaseContext）、图谱 repo map
 * （fetchGraphRepoMap / scheduleGraphLspEnrichKick）、项目/全局记忆
 * （fetchProjectMemoryContext / fetchGlobalOnlyMemoryContext）的 Renderer 实现均已删除，
 * 召回统一由 Main 的 system-prompt-prep.js 承担（AGENTS.md：Renderer 只上报快照 + 编辑器块）。
 *
 * 注入门闩同理：shouldInjectProjectKnowledge / agentsMdInjectDepth /
 * shouldAutoCodebaseSearch 的 Renderer 实现已删除，判定归 Main + ContextSignals。
 */
let ctxSignalsMissingWarned = false;
function ctxContextSignals() {
  const CS = (typeof window !== 'undefined' && window.ContextSignals) || null;
  if (!CS && !ctxSignalsMissingWarned) {
    ctxSignalsMissingWarned = true;
    console.warn(
      '[ctx-signals] window.ContextSignals 不可用（agent-bundle 未加载？），代码上下文注入判定已降级'
    );
  }
  return CS;
}

/**
 * 是否注入代码相关上下文（薄适配）。
 * 信号判定在 ContextSignals.shouldInjectCodeContext：这里只把 Monaco / 已选 artifact
 * 适配成 snapshot.editor。保留改造前的调用方策略：仅在本地工作区
 * （workspaceInfo.workspacePath 存在）时才读编辑器信号。
 */
function shouldInjectCodeContext(userQuery, opts = {}) {
  const CS = ctxContextSignals();
  if (!CS) return false;
  const includeEditor = opts.includeEditor !== false;
  const ws = opts.workspaceInfo || null;
  const editor = {};
  if (includeEditor && ws && ws.workspacePath) {
    if (typeof window.getMonacoEditorContext === 'function') {
      const ctx = window.getMonacoEditorContext();
      if (ctx && ctx.activeFilePath) {
        editor.hasActiveFile = true;
        if (ctx.selection && ctx.selection.text) editor.hasSelection = true;
      }
    }
    if (typeof window.getSelectedArtifactPath === 'function' && window.getSelectedArtifactPath()) {
      editor.hasArtifact = true;
    }
  }
  return CS.shouldInjectCodeContext(userQuery, {
    forceCodeContext: opts.forceCodeContext === true,
    includeEditor,
    editor
  });
}

/**
 * CTX_LIMITS 中所有数字上限的唯一来源是 src/agent/agent-limits.js：
 * 值经 ctxAgentLimitDefault() 从 `AGENT_LIMITS_DEFAULTS` 映射，本文件不再重复字面量 ——
 * 改 agent-limits.js 的默认值即 Main 的 system-prompt-prep.js 与本文件同步生效。
 * agent-limits.js 在 index.html 中先于本文件加载（1951 < 1955），取法为懒读。
 * 兜底实参只在加载顺序异常时才会命中，届时会打一条 warn。
 */
const CTX_AGENT_LIMITS_DEFAULTS =
  (typeof window !== 'undefined' && window.AGENT_LIMITS_DEFAULTS) || {};

let ctxLimitsWarnedMissingAgentDefaults = false;
function ctxAgentLimitDefault(key, fallback) {
  const n = Number(CTX_AGENT_LIMITS_DEFAULTS[key]);
  if (Number.isFinite(n)) return n;
  if (!ctxLimitsWarnedMissingAgentDefaults) {
    ctxLimitsWarnedMissingAgentDefaults = true;
    console.warn(`[ctx-limits] AGENT_LIMITS_DEFAULTS 不可用（${key}），已退回本地兜底值`);
  }
  return fallback;
}

const CTX_LIMITS = {
  // —— 与 agent-limits.js 单一来源（注入块尺寸上限）——
  // 这些键曾在本文件与 system-prompt-prep.js 各存一份字面量、靠「保持一致」注释互指来源，
  // 现已全部收敛到 agent-limits.js，本文件只做 camelCase → SCREAMING_SNAKE 映射。
  /** AGENTS.md 注入字符上限 */
  AGENTS_MD_MAX: ctxAgentLimitDefault('agentsMdMaxChars', 2800),
  DIEYUN_MD_MAX: ctxAgentLimitDefault('dieyunMdMaxChars', 6000),
  /** 可选工具（MCP 等）语义 Top-K 注入上限 */
  TOOL_RECALL_LIMIT: ctxAgentLimitDefault('toolRecallLimit', 10),
  FILE_PREVIEW_MAX_BYTES: ctxAgentLimitDefault('filePreviewMaxBytes', 48000),
  RECENT_CHANGE_MAX: ctxAgentLimitDefault('recentChangeMax', 16),
  // 工具结果按字段截断表：Renderer 侧独有（跨层无此表的第二份），暂留本文件维护。
  TOOL_FIELD_LIMITS: {
    fs_read_file: { data: 12000 },
    host_exec: { stdout: 8000, stderr: 4000, output: 8000 },
    web_fetch: { content: 10000, text: 10000, body: 10000 },
    codebase_search: { results: 8000 },
    grep: { matches: 8000 },
    glob: { files: 8000 },
    lsp: { locations: 8000, hover: 4000 }
  },

  // —— 与 agent-limits.js 单一来源（可在设置中调整的护栏）——
  /** 每段 Agent 请求的工具调用上限；继续后重置计数（可在设置中调整） */
  AGENT_TOOL_CALL_LIMIT: ctxAgentLimitDefault('ctxAgentToolCallLimit', 150),
  TOOL_RESULT_MAX_JSON: ctxAgentLimitDefault('toolResultMaxJson', 14000),
  OPEN_FILES_MAX: ctxAgentLimitDefault('openFilesMax', 12),
  FILE_PREVIEW_MAX_CHARS: ctxAgentLimitDefault('filePreviewMaxChars', 4000),
  COMPLETION_HISTORY_MAX_CHARS: ctxAgentLimitDefault('completionHistoryMaxChars', 96000),
  COMPLETION_MESSAGE_MAX_CHARS: ctxAgentLimitDefault('completionMessageMaxChars', 8000),
  COMPLETION_LAST_USER_MAX_CHARS: ctxAgentLimitDefault('completionLastUserMaxChars', 24000),
  COMPLETION_TURN_RIDE_MAX_CHARS: ctxAgentLimitDefault('completionTurnRideMaxChars', 32000),
  COMPLETION_RECENT_TURNS: ctxAgentLimitDefault('completionRecentTurns', 24),
  COMPLETION_FOLDED_MAX_CHARS: ctxAgentLimitDefault('completionFoldedMaxChars', 12000),
  LLM_REQUEST_MAX_CHARS: ctxAgentLimitDefault('llmRequestMaxChars', 800000),
  // LSP 诊断只限「注入字符数」；文件数 / 单文件条数 / 超时的唯一来源是 lsp-settings
  LSP_DIAG_MAX_CHARS: ctxAgentLimitDefault('lspDiagMaxChars', 10000)
};

/**
 * agent-limits 键（camelCase）→ CTX_LIMITS 键（SCREAMING_SNAKE）的**唯一**映射表。
 *
 * 两条路径共用这一份，勿在别处再抄：
 *   - 加载期：CTX_LIMITS 初值经 ctxAgentLimitDefault() 从 AGENT_LIMITS_DEFAULTS 派生；
 *   - 运行期：applyAgentLimitsTo() 按当前上下文档位把 getAgentLimits() 刷进目标对象
 *     （renderer-agent-limits-runtime.js 的启动/事件刷新、ctxLimitsFor() 的单次快照）。
 *
 * 此处曾与 renderer-agent-limits-runtime.js 各存一份 14 键表；漏一个键的表现是
 * 「设置里改了不生效」，且只在某个档位下复现 —— 极难定位。
 */
const CTX_LIMITS_FROM_AGENT_LIMITS = [
  ['ctxAgentToolCallLimit', 'AGENT_TOOL_CALL_LIMIT'],
  ['toolResultMaxJson', 'TOOL_RESULT_MAX_JSON'],
  ['openFilesMax', 'OPEN_FILES_MAX'],
  ['filePreviewMaxChars', 'FILE_PREVIEW_MAX_CHARS'],
  ['completionHistoryMaxChars', 'COMPLETION_HISTORY_MAX_CHARS'],
  ['completionMessageMaxChars', 'COMPLETION_MESSAGE_MAX_CHARS'],
  ['completionLastUserMaxChars', 'COMPLETION_LAST_USER_MAX_CHARS'],
  ['completionTurnRideMaxChars', 'COMPLETION_TURN_RIDE_MAX_CHARS'],
  ['completionRecentTurns', 'COMPLETION_RECENT_TURNS'],
  ['completionFoldedMaxChars', 'COMPLETION_FOLDED_MAX_CHARS'],
  ['llmRequestMaxChars', 'LLM_REQUEST_MAX_CHARS'],
  ['lspDiagMaxChars', 'LSP_DIAG_MAX_CHARS']
];

/**
 * 把 agent-limits 当前档位的值就地刷进 target 并返回它。
 *
 * @param {Record<string, unknown>} target
 * @param {object} [opts] 透传 getAgentLimits（tierId / editing 等）
 * @returns {Record<string, unknown>}
 */
function applyAgentLimitsTo(target, opts = {}) {
  const out = target && typeof target === 'object' ? target : {};
  const L = typeof getAgentLimits === 'function' ? getAgentLimits(opts) : {};
  for (const [srcKey, dstKey] of CTX_LIMITS_FROM_AGENT_LIMITS) {
    if (L[srcKey] != null) out[dstKey] = L[srcKey];
  }
  return out;
}

/**
 * 刷新全局 CTX_LIMITS 到当前档位。
 * 名字是渲染器全局契约（renderer-encoding-params.js 多处调用），勿改。
 */
function applyAgentLimitsToRuntime(opts = {}) {
  return applyAgentLimitsTo(CTX_LIMITS, opts);
}

/** 单次快照：不改全局，供按档位/按轮次取值的调用点使用。 */
function ctxLimitsFor(opts = {}) {
  return applyAgentLimitsTo({ ...CTX_LIMITS }, opts);
}

// textHasCodebaseMention 由 agent-bundle.js 的 ContextSignals compat 提供（唯一来源）。
// shouldInjectCodeContext 见文件顶部薄适配层（Monaco 状态 → snapshot.editor）。

function gatewayCallWithTimeout(method, params, ms = 15000) {
  const scoped =
    typeof withSessionRpcScope === 'function' ? withSessionRpcScope(params) : params;
  return Promise.race([
    gatewayCall(method, scoped),
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error(`${method} 超时`)), ms);
    })
  ]);
}

function capText(text, max) {
  const s = String(text || '');
  if (s.length <= max) return s;
  return `${s.slice(0, max)}\n\n…（已截断，原文 ${s.length} 字符）`;
}

function truncateStringField(val, max) {
  if (typeof val !== 'string') return val;
  if (val.length <= max) return val;
  return `${val.slice(0, max)}…[truncated ${val.length} chars]`;
}

function truncateToolResultDeep(name, obj, depth) {
  if (obj == null || depth > 8) return obj;
  if (typeof obj === 'string') {
    return truncateStringField(obj, CTX_LIMITS.TOOL_RESULT_MAX_JSON);
  }
  if (Array.isArray(obj)) {
    return obj.slice(0, 200).map((item) => truncateToolResultDeep(name, item, depth + 1));
  }
  if (typeof obj !== 'object') return obj;
  const fieldLimits = CTX_LIMITS.TOOL_FIELD_LIMITS[name] || {};
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === 'string' && fieldLimits[k]) {
      out[k] = truncateStringField(v, fieldLimits[k]);
    } else {
      out[k] = truncateToolResultDeep(name, v, depth + 1);
    }
  }
  const json = JSON.stringify(out);
  if (json.length > CTX_LIMITS.TOOL_RESULT_MAX_JSON) {
    return {
      truncated: true,
      originalBytes: json.length,
      preview: json.slice(0, CTX_LIMITS.TOOL_RESULT_MAX_JSON) + '…',
      note: 'Tool result truncated for context budget'
    };
  }
  return out;
}

function truncateToolResultForApi(name, result) {
  if (result == null) return result;
  if (typeof result !== 'object') {
    return truncateStringField(String(result), CTX_LIMITS.TOOL_RESULT_MAX_JSON);
  }
  return truncateToolResultDeep(name, result, 0);
}

async function buildOpenFilesContext(getPathsFn, codebasePaths, opts = {}) {
  if (!gwState.authed || typeof getPathsFn !== 'function') return '';
  const lim = ctxLimitsFor(opts);
  const skip = new Set((codebasePaths || []).map((p) => String(p || '').replace(/\\/g, '/')));
  const paths = getPathsFn().filter((p) => p && !skip.has(String(p).replace(/\\/g, '/')));
  if (!paths.length) return '';
  const maxPreviews = opts.maxPreviews != null ? opts.maxPreviews : 3;
  const parallel = opts.parallel === true;
  const lines = ['【当前关注文件 · 会话上下文】', '用户/Agent 最近触及的文件（类似 Cursor 打开文件上下文）：'];
  let used = 0;
  let previewCount = 0;

  async function readOne(fp) {
    try {
      const readParams =
        typeof withSessionRpcScope === 'function'
          ? withSessionRpcScope(
              {
                filePath: fp,
                maxBytes: lim.FILE_PREVIEW_MAX_BYTES,
                ...(opts.runWorkspaceRoot ? { runWorkspaceRoot: opts.runWorkspaceRoot } : {})
              },
              opts.sessionId
            )
          : {
              filePath: fp,
              maxBytes: lim.FILE_PREVIEW_MAX_BYTES,
              ...(opts.runWorkspaceRoot ? { runWorkspaceRoot: opts.runWorkspaceRoot } : {})
            };
      const r = await gatewayCall('fs.read_file', readParams);
      return { fp, r };
    } catch {
      return { fp, err: true };
    }
  }

  const slice = paths.slice(0, lim.OPEN_FILES_MAX);
  if (parallel && slice.length > 1) {
    const toRead = slice.filter((_fp, i) => i < maxPreviews);
    const rest = slice.filter((_fp, i) => i >= maxPreviews);
    const reads = await Promise.all(toRead.map(readOne));
    for (const item of reads) {
      if (previewCount >= maxPreviews || used >= lim.FILE_PREVIEW_MAX_CHARS * maxPreviews) break;
      if (item.err) {
        lines.push(`- ${item.fp}（读取失败）`);
        continue;
      }
      const enc = item.r && item.r.encoding === 'base64' ? null : String(item.r?.data || '');
      if (!enc || enc.length < 8) {
        lines.push(`- ${item.fp}（二进制或空，未注入全文）`);
        continue;
      }
      const body = capText(enc, lim.FILE_PREVIEW_MAX_CHARS);
      used += body.length;
      const trunc = item.r.truncated ? ' [文件未完，可用 offset 续读]' : '';
      lines.push(`### ${item.fp}${trunc}\n\`\`\`\n${body}\n\`\`\``);
      previewCount += 1;
    }
    for (const fp of rest) lines.push(`- ${fp}`);
  } else {
    for (const fp of slice) {
      if (previewCount >= maxPreviews) {
        lines.push(`- ${fp}`);
        continue;
      }
      if (used >= lim.FILE_PREVIEW_MAX_CHARS * maxPreviews) break;
      const item = await readOne(fp);
      if (item.err) {
        lines.push(`- ${item.fp}（读取失败）`);
        continue;
      }
      const enc = item.r && item.r.encoding === 'base64' ? null : String(item.r?.data || '');
      if (!enc || enc.length < 8) {
        lines.push(`- ${item.fp}（二进制或空，未注入全文）`);
        continue;
      }
      const body = capText(enc, lim.FILE_PREVIEW_MAX_CHARS);
      used += body.length;
      const trunc = item.r.truncated ? ' [文件未完，可用 offset 续读]' : '';
      lines.push(`### ${item.fp}${trunc}\n\`\`\`\n${body}\n\`\`\``);
      previewCount += 1;
    }
  }
  if (lines.length <= 2) return '';
  return lines.join('\n\n');
}

function buildRecentChangesContext(getChangesFn, sessionId) {
  if (typeof getChangesFn !== 'function') return '';
  const rows = getChangesFn(sessionId).slice(0, CTX_LIMITS.RECENT_CHANGE_MAX);
  if (!rows.length) return '';
  const lines = rows.map((r) => {
    const diff = r.diff ? ` +${r.diff.added || 0} -${r.diff.removed || 0}` : '';
    return `- ${r.path}${diff}`;
  });
  return `【本会话变更文件】\n${lines.join('\n')}`;
}

// extractCodebasePathsFromBlock 由 agent-bundle.js 的 ContextSignals compat 提供（唯一来源）。

let lspSettingsCache = null;
let lspSettingsCacheTs = 0;

async function getLspSettingsCached() {
  if (lspSettingsCache && Date.now() - lspSettingsCacheTs < 30000) {
    return lspSettingsCache;
  }
  try {
    const r = await gatewayCall('lsp.settings_get', {});
    if (r && r.ok && r.settings) {
      lspSettingsCache = r.settings;
      lspSettingsCacheTs = Date.now();
      return r.settings;
    }
  } catch {
    // ignore
  }
  // settings_get 失败时不编造文件数/超时：留空交给 Gateway 侧 lsp-settings 决定
  return { enabled: true, minSeverity: 'warning' };
}

function invalidateLspSettingsCache() {
  lspSettingsCache = null;
  lspSettingsCacheTs = 0;
}

function normalizePathKey(p) {
  return String(p || '')
    .trim()
    .replace(/\\/g, '/')
    .toLowerCase();
}

/**
 * 诊断 RPC 传输超时兜底：lsp-settings 未给出超时（如 settings_get 失败）时，
 * 只决定「这次调用等多久」，不改变 LSP 分析超时本身 —— 后者归 lsp-settings。
 */
const LSP_DIAG_RPC_FALLBACK_TIMEOUT_MS = 8000;

function mergeDiagnosticsFilePaths(userQuery, opts = {}) {
  const out = [];
  const seen = new Set();
  function add(p) {
    const raw = String(p || '').trim();
    if (!raw) return;
    const key = normalizePathKey(raw);
    if (seen.has(key)) return;
    seen.add(key);
    out.push(raw);
  }

  const pathHints = opts.pathHints || [];
  const skipUi =
    opts.skipUiPaths === true ||
    !!(
      opts.sessionId &&
      String(opts.sessionId).trim() &&
      typeof currentSessionId !== 'undefined' &&
      String(opts.sessionId).trim() !== String(currentSessionId || '')
    );
  if (!skipUi && typeof window.getMonacoEditorContextPaths === 'function') {
    for (const p of window.getMonacoEditorContextPaths()) add(p);
  }
  if (pathHints.length) {
    for (const p of pathHints) add(p);
  } else {
    for (const p of extractPathHintsFromText(userQuery)) add(p);
  }

  if (typeof getContextFilePathsForAgent === 'function') {
    for (const p of getContextFilePathsForAgent(opts.sessionId)) add(p);
  }

  if (typeof getSessionChangeRowsForAgent === 'function') {
    for (const r of getSessionChangeRowsForAgent(opts.sessionId).slice(0, 3)) {
      add(r && r.path);
    }
  }

  // 未显式给上限就不在本地截断：文件数由 Gateway 侧 lsp-settings 统一裁决
  const maxFiles = Number(opts.maxFiles);
  return Number.isFinite(maxFiles) && maxFiles > 0 ? out.slice(0, maxFiles) : out;
}

function toDisplayPath(filePath, workspaceRoot) {
  const file = String(filePath || '').replace(/\\/g, '/');
  const root = String(workspaceRoot || '')
    .replace(/\\/g, '/')
    .replace(/\/$/, '');
  if (!root) return filePath;
  const prefix = `${root.toLowerCase()}/`;
  if (file.toLowerCase().startsWith(prefix)) {
    return file.slice(root.length + 1);
  }
  return filePath;
}

function formatDiagnosticsBlock(workspaceRoot, items, maxChars, opts = {}) {
  const withDiags = (items || []).filter(
    (it) => Array.isArray(it.diagnostics) && it.diagnostics.length > 0
  );
  if (!withDiags.length) return '';

  const lines = [
    opts.mode === 'diagnostic_store'
      ? '【工作区诊断 · Diagnostic Store】'
      : '【工作区诊断 · LSP】',
    `工作区：${workspaceRoot}`,
    '说明：语言服务 + 项目级 tsc/pyright/eslint/ruff/prettier 扫描 + 文件 watch/SSH 脏文件轮询（Diagnostic Store 多引擎合并）；修 bug 时优先 error，勿臆造行号。',
    ''
  ];
  let used = lines.join('\n').length;
  let truncated = false;

  for (const item of withDiags) {
    const rel = toDisplayPath(item.file, workspaceRoot);
    const blockLines = [`### ${rel}`];
    for (const d of item.diagnostics) {
      const sev =
        d.severity === 'error' ? 'error' : d.severity === 'warning' ? 'warning' : d.severity || 'info';
      const code = d.code ? ` ${d.code}` : '';
      blockLines.push(`- [${sev}] L${d.line}:${d.col}${code} — ${d.message}`);
    }
    const chunk = `${blockLines.join('\n')}\n\n`;
    if (used + chunk.length > maxChars) {
      truncated = true;
      break;
    }
    lines.push(blockLines.join('\n'), '');
    used += chunk.length;
  }

  if (truncated) lines.push('…（诊断块已截断）');
  return lines.join('\n').trim();
}

function shouldFetchWorkspaceDiagnostics(userQuery, workspaceInfo, opts = {}) {
  if (!gwState.authed) return false;
  if (!workspaceInfo || !workspaceInfo.workspacePath) return false;
  if (workspaceInfo.kind === 'ssh') {
    return workspaceInfo.sshConnected === true;
  }
  if (opts.force) return true;

  if (typeof getComposerAgentMode === 'function' && getComposerAgentMode(opts.sessionId) === 'plan') {
    return false;
  }
  const viewSid =
    typeof currentSessionId !== 'undefined' && currentSessionId
      ? String(currentSessionId)
      : '';
  const sid = opts.sessionId != null ? String(opts.sessionId).trim() : '';
  const includeEditor = !sid || !viewSid || sid === viewSid;
  // 结构信号（非意图关键词）：本地工作区在编辑器里打开着文件，即为「报错现场」。
  // 与 shouldInjectCodeContext 的「有选区」并列；SSH 分支本就不看信号，保持一致。
  if (includeEditor && typeof window.getMonacoEditorContext === 'function') {
    const editorCtx = window.getMonacoEditorContext();
    if (editorCtx && editorCtx.activeFilePath) return true;
  }
  return shouldInjectCodeContext(userQuery, { ...opts, workspaceInfo, includeEditor });
}

async function fetchWorkspaceDiagnosticsContext(userQuery, opts = {}) {
  const lspSettings = await getLspSettingsCached();
  if (!lspSettings.enabled) return '';
  const lim = ctxLimitsFor(opts);

  const workspaceInfo = opts.workspaceInfo || null;
  const workspaceRoot =
    opts.workspaceRoot || (workspaceInfo && workspaceInfo.workspacePath) || null;
  if (!workspaceRoot) return '';

  const wsInfo = workspaceInfo || { workspacePath: workspaceRoot, kind: 'local' };
  if (!shouldFetchWorkspaceDiagnostics(userQuery, wsInfo, opts)) return '';

  const pathHintsProvided = Object.prototype.hasOwnProperty.call(opts, 'pathHints');
  const prepSid =
    opts.sessionId != null && String(opts.sessionId).trim()
      ? String(opts.sessionId).trim()
      : '';
  const viewingSid =
    typeof currentSessionId !== 'undefined' && currentSessionId
      ? String(currentSessionId)
      : '';
  const skipUiPaths =
    opts.skipUiPathHints === true || !!(prepSid && viewingSid && prepSid !== viewingSid);

  let mergedPaths;
  if (pathHintsProvided) {
    // 显式 pathHints（含空数组）优先，避免 [] 被当成「未提供」而回退到当前 tab
    mergedPaths = Array.isArray(opts.pathHints) ? opts.pathHints : [];
  } else if (skipUiPaths) {
    mergedPaths =
      typeof getContextFilePathsForAgent === 'function' ? getContextFilePathsForAgent(prepSid) : [];
  } else {
    mergedPaths =
      typeof getMergedContextFilePaths === 'function'
        ? getMergedContextFilePaths(prepSid || undefined)
        : typeof getContextFilePathsForAgent === 'function'
          ? getContextFilePathsForAgent(prepSid || undefined)
          : [];
  }

  // 文件数与超时的唯一来源是 lsp-settings（Gateway 侧 lsp-settings.json）；
  // agent-limits 只提供注入字符上限（lim.LSP_DIAG_MAX_CHARS）。
  const maxFiles = opts.maxFiles || lspSettings.maxFiles;
  const timeoutMs = opts.timeoutMs != null ? opts.timeoutMs : lspSettings.timeoutMs;

  const files = mergeDiagnosticsFilePaths(userQuery, {
    pathHints: mergedPaths,
    maxFiles,
    sessionId: opts.sessionId,
    skipUiPaths
  });

  try {
    const diagParams =
      typeof withSessionRpcScope === 'function'
        ? withSessionRpcScope(
            {
              workspaceRoot,
              files,
              maxFiles,
              maxPerFile: lspSettings.maxPerFile,
              minSeverity: lspSettings.minSeverity,
              timeoutMs,
              useDiagnosticStore: opts.useDiagnosticStore !== false,
              includeGitDirty: opts.includeGitDirty !== false
            },
            opts.sessionId
          )
        : {
            workspaceRoot,
            files,
            maxFiles,
            maxPerFile: lspSettings.maxPerFile,
            minSeverity: lspSettings.minSeverity,
            timeoutMs,
            useDiagnosticStore: opts.useDiagnosticStore !== false,
            includeGitDirty: opts.includeGitDirty !== false
          };
    const analysisTimeoutMs = Number(timeoutMs);
    const rpcTimeoutMs =
      (Number.isFinite(analysisTimeoutMs) && analysisTimeoutMs > 0
        ? analysisTimeoutMs
        : LSP_DIAG_RPC_FALLBACK_TIMEOUT_MS) + 4000;
    const data = await gatewayCallWithTimeout('workspace.diagnostics', diagParams, rpcTimeoutMs);
    let block = '';
    if (data && data.ok && data.enabled !== false && Array.isArray(data.items) && data.items.length) {
      block = formatDiagnosticsBlock(
        workspaceRoot,
        data.items,
        opts.maxChars || lim.LSP_DIAG_MAX_CHARS,
        { mode: data.mode }
      );
    }
    if (!block && typeof window.getCachedMonacoDiagnostics === 'function') {
      const probePaths = files.length ? files : mergedPaths;
      const cached = window.getCachedMonacoDiagnostics(probePaths);
      if (cached.length) {
        block = formatDiagnosticsBlock(
          workspaceRoot,
          cached,
          opts.maxChars || lim.LSP_DIAG_MAX_CHARS
        );
        if (block) {
          block = block.replace(
            '【工作区诊断 · LSP】',
            '【工作区诊断 · Monaco 缓存】'
          );
        }
      }
    }
    return block;
  } catch {
    if (typeof window.getCachedMonacoDiagnostics === 'function') {
      const probePaths = files.length ? files : mergedPaths;
      const cached = window.getCachedMonacoDiagnostics(probePaths);
      if (cached.length) {
        return formatDiagnosticsBlock(
          workspaceRoot,
          cached,
          opts.maxChars || lim.LSP_DIAG_MAX_CHARS
        );
      }
    }
    return '';
  }
}

window.CTX_LIMITS = CTX_LIMITS;
window.ctxLimitsFor = ctxLimitsFor;
// applyAgentLimitsTo 是内部助手（仅 ctxLimitsFor / applyAgentLimitsToRuntime 消费），不导出；
// applyAgentLimitsToRuntime 是渲染器全局契约：renderer-encoding-params.js 多处调用。
window.applyAgentLimitsToRuntime = applyAgentLimitsToRuntime;
// estimateFullContextUsage / estimateToolsTokens / estimateMessagesTokens 已由 agent-bundle
// 的 TokenEstimate compat 挂到 window（唯一来源），本文件不再重复导出。
window.truncateToolResultForApi = truncateToolResultForApi;
window.buildOpenFilesContext = buildOpenFilesContext;
window.buildRecentChangesContext = buildRecentChangesContext;
// extractCodebasePathsFromBlock / extractPathHintsFromText 已由 agent-bundle 的
// ContextSignals compat 挂到 window（唯一来源），本文件不再重复导出。
window.getLspSettingsCached = getLspSettingsCached;
window.invalidateLspSettingsCache = invalidateLspSettingsCache;
window.mergeDiagnosticsFilePaths = mergeDiagnosticsFilePaths;
window.shouldFetchWorkspaceDiagnostics = shouldFetchWorkspaceDiagnostics;
window.shouldInjectCodeContext = shouldInjectCodeContext;
window.fetchWorkspaceDiagnosticsContext = fetchWorkspaceDiagnosticsContext;
window.formatDiagnosticsBlock = formatDiagnosticsBlock;

/**
 * 改后 LSP/tsc 校验 — 供完成验收在 fs_write_file 后注入。
 * @returns {Promise<{ text: string, hasErrors: boolean, hasDiagnostics: boolean } | null>}
 */
async function fetchWorkspaceVerifyDiagnostics(filePaths, opts = {}) {
  if (!gwState.authed || !filePaths?.length) return null;

  const files = [...new Set(filePaths.map((p) => String(p || '').trim()).filter(Boolean))].slice(0, 6);
  if (!files.length) return null;

  let workspaceRoot = opts.workspaceRoot || null;
  if (!workspaceRoot && opts.sessionId && typeof resolveSessionWorkspacePath === 'function') {
    try {
      workspaceRoot = await resolveSessionWorkspacePath(opts.sessionId);
    } catch {
      workspaceRoot = null;
    }
  }
  if (!workspaceRoot && opts.sessionId && typeof resolveSessionWorkspacePathSync === 'function') {
    workspaceRoot = resolveSessionWorkspacePathSync(opts.sessionId);
  }
  // 有 sessionId 时禁止回落到当前视图工作区
  if (!workspaceRoot && !opts.sessionId && window.diecloud?.getWorkspace) {
    try {
      const ws = await window.diecloud.getWorkspace();
      workspaceRoot = ws?.workspacePath || null;
    } catch {
      // ignore
    }
  }
  if (!workspaceRoot) return null;

  const lspSettings =
    typeof getLspSettingsCached === 'function'
      ? await getLspSettingsCached()
      : { maxPerFile: 20, minSeverity: 'warning' };
  const timeoutMs = opts.timeoutMs != null ? opts.timeoutMs : 8000;
  const limits = typeof getAgentLimits === 'function' ? getAgentLimits() : {};
  const maxChars = opts.maxChars != null ? opts.maxChars : limits.verifyDiagMaxChars || 6000;

  try {
    const data = await gatewayCall(
      'workspace.diagnostics',
      typeof withSessionRpcScope === 'function'
        ? withSessionRpcScope(
            {
              workspaceRoot,
              files,
              maxFiles: files.length,
              maxPerFile: lspSettings.maxPerFile,
              minSeverity: 'warning',
              timeoutMs
            },
            opts.sessionId
          )
        : {
            workspaceRoot,
            files,
            maxFiles: files.length,
            maxPerFile: lspSettings.maxPerFile,
            minSeverity: 'warning',
            timeoutMs
          }
    );
    if (!data?.ok) return null;

    const items = data.items || [];
    const allDiags = items.flatMap((it) =>
      (it.diagnostics || []).map((d) => ({ ...d, file: it.file }))
    );
    const hasErrors = allDiags.some((d) => d.severity === 'error');
    const hasDiagnostics = allDiags.length > 0;

    if (!hasDiagnostics) {
      return {
        text: '【改后静态检查 · LSP/tsc】\n说明：已检查刚写入的文件，未发现 warning/error 级诊断。',
        hasErrors: false,
        hasDiagnostics: false
      };
    }

    let text =
      typeof formatDiagnosticsBlock === 'function'
        ? formatDiagnosticsBlock(workspaceRoot, items, maxChars)
        : '';
    if (text) {
      text = text
        .replace('【工作区诊断 · LSP】', '【改后静态检查 · LSP/tsc】')
        .replace(
          '说明：以下为语言服务静态分析结果；修 bug 时优先处理 error，勿臆造不存在的行号。',
          '说明：这是你刚写入文件后的语言服务/tsc 结果；若有 error 请继续修复。'
        );
    } else {
      text = '【改后静态检查 · LSP/tsc】\n（诊断格式化失败）';
    }

    return { text, hasErrors, hasDiagnostics };
  } catch {
    return null;
  }
}

window.fetchWorkspaceVerifyDiagnostics = fetchWorkspaceVerifyDiagnostics;
