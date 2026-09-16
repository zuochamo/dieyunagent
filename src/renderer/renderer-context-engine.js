/* global gatewayCall, gwState, settings, getComposerAgentMode, compactPlainText, getContextFilePathsForAgent, getSessionChangeRowsForAgent, getAgentLimits, withSessionRpcScope, currentSessionId, getMergedContextFilePaths, resolveSessionWorkspacePath, resolveSessionWorkspacePathSync */
'use strict';

function extractPathHintsFromText(text) {
  const t = String(text || '');
  const paths = [];
  const re =
    /(?:^|[\s"'`(])((?:[\w.-]+\/)+[\w.-]+\.\w{1,8}|[A-Za-z]:\\(?:[^\\:\n"]+\\)*[^\\:\n"]+\.\w{1,8})(?=[\s"'`,]|$)/gi;
  let m;
  while ((m = re.exec(t))) {
    const p = String(m[1] || '').trim();
    if (p && !paths.includes(p)) paths.push(p);
  }
  return paths.slice(0, 6);
}

const CTX_LIMITS = {
  AGENTS_MD_MAX: 8000,
  DIEYUN_MD_MAX: 6000,
  SKILL_BODY_MAX: 3500,
  SKILL_FULL_COUNT: 3,
  SKILL_TOTAL_COUNT: 5,
  /** 技能只注入索引，全文用 fs_read_file */
  SKILL_CATALOG_MODE: true,
  CODEBASE_AUTO_LIMIT: 12,
  CODEBASE_MENTION_LIMIT: 16,
  CODEBASE_SNIPPET_MAX: 2400,
  /** 结构索引 repo map 枢纽符号上限 */
  GRAPH_REPO_MAP_LIMIT: 32,
  GRAPH_REPO_MAP_MAX_CHARS: 4500,
  PROJECT_MEMORY_LIMIT: 8,
  GLOBAL_MEMORY_LIMIT: 5,
  /** 可选工具（MCP 等）语义 Top-K 注入上限 */
  TOOL_RECALL_LIMIT: 10,
  /** Playbook 语义召回条数与摘要字符上限 */
  PLAYBOOK_RECALL_LIMIT: 3,
  PLAYBOOK_SUMMARY_MAX: 250,
  /** Wiki 召回条数与摘要字符上限 */
  WIKI_RECALL_LIMIT: 5,
  WIKI_SUMMARY_MAX: 120,
  TOOL_RESULT_MAX_JSON: 14000,
  TOOL_FIELD_LIMITS: {
    fs_read_file: { data: 12000 },
    host_exec: { stdout: 8000, stderr: 4000, output: 8000 },
    web_fetch: { content: 10000, text: 10000, body: 10000 },
    codebase_search: { results: 8000 },
    grep: { matches: 8000 },
    glob: { files: 8000 },
    lsp: { locations: 8000, hover: 4000 },
    sql_query: { rows: 6000, data: 6000 }
  },
  /** 每段 Agent 请求的工具调用上限；继续后重置计数（可在设置中调整） */
  AGENT_TOOL_CALL_LIMIT: 150,
  OPEN_FILES_MAX: 12,
  FILE_PREVIEW_MAX_BYTES: 48000,
  FILE_PREVIEW_MAX_CHARS: 4000,
  COMPLETION_HISTORY_MAX_CHARS: 96000,
  COMPLETION_MESSAGE_MAX_CHARS: 8000,
  COMPLETION_LAST_USER_MAX_CHARS: 24000,
  COMPLETION_TURN_RIDE_MAX_CHARS: 32000,
  COMPLETION_RECENT_TURNS: 12,
  COMPLETION_FOLDED_MAX_CHARS: 8000,
  LLM_REQUEST_MAX_CHARS: 800000,
  RECENT_CHANGE_MAX: 16,
  LSP_DIAG_MAX_CHARS: 10000,
  LSP_DIAG_MAX_FILES: 24,
  LSP_DIAG_TIMEOUT_MS: 5000
};

function ctxLimitsFor(opts = {}) {
  const L = typeof getAgentLimits === 'function' ? getAgentLimits(opts) : {};
  const out = { ...CTX_LIMITS };
  if (L.ctxAgentToolCallLimit != null) out.AGENT_TOOL_CALL_LIMIT = L.ctxAgentToolCallLimit;
  if (L.toolResultMaxJson != null) out.TOOL_RESULT_MAX_JSON = L.toolResultMaxJson;
  if (L.codebaseSnippetMax != null) out.CODEBASE_SNIPPET_MAX = L.codebaseSnippetMax;
  if (L.codebaseAutoLimit != null) out.CODEBASE_AUTO_LIMIT = L.codebaseAutoLimit;
  if (L.openFilesMax != null) out.OPEN_FILES_MAX = L.openFilesMax;
  if (L.filePreviewMaxChars != null) out.FILE_PREVIEW_MAX_CHARS = L.filePreviewMaxChars;
  if (L.completionHistoryMaxChars != null) out.COMPLETION_HISTORY_MAX_CHARS = L.completionHistoryMaxChars;
  if (L.completionMessageMaxChars != null) out.COMPLETION_MESSAGE_MAX_CHARS = L.completionMessageMaxChars;
  if (L.completionLastUserMaxChars != null) out.COMPLETION_LAST_USER_MAX_CHARS = L.completionLastUserMaxChars;
  if (L.completionTurnRideMaxChars != null) out.COMPLETION_TURN_RIDE_MAX_CHARS = L.completionTurnRideMaxChars;
  if (L.completionRecentTurns != null) out.COMPLETION_RECENT_TURNS = L.completionRecentTurns;
  if (L.completionFoldedMaxChars != null) out.COMPLETION_FOLDED_MAX_CHARS = L.completionFoldedMaxChars;
  if (L.llmRequestMaxChars != null) out.LLM_REQUEST_MAX_CHARS = L.llmRequestMaxChars;
  if (L.lspDiagMaxChars != null) out.LSP_DIAG_MAX_CHARS = L.lspDiagMaxChars;
  if (L.lspDiagMaxFiles != null) out.LSP_DIAG_MAX_FILES = L.lspDiagMaxFiles;
  if (L.lspDiagTimeoutMs != null) out.LSP_DIAG_TIMEOUT_MS = L.lspDiagTimeoutMs;
  return out;
}

function textHasCodebaseMention(text) {
  return /(^|\s)@Codebase\b/i.test(String(text || ''));
}

function stripCodebaseMention(text) {
  return String(text || '')
    .replace(/(^|\s)@Codebase\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 是否注入代码相关上下文。禁用关键词/寒暄词表硬编码：
 * 仅看显式 @Codebase、消息内路径、编辑器选区/打开文件等结构信号。
 */
function shouldInjectCodeContext(userQuery, opts = {}) {
  const t = String(userQuery || '').trim();
  if (!t) return false;
  if (textHasCodebaseMention(t)) return true;
  if (extractPathHintsFromText(t).length) return true;
  if (opts.forceCodeContext === true) return true;

  const ws = opts.workspaceInfo || null;
  if (ws && ws.workspacePath && opts.includeEditor !== false) {
    if (typeof window.getMonacoEditorContext === 'function') {
      const ctx = window.getMonacoEditorContext();
      if (ctx && ctx.activeFilePath && ctx.selection?.text) return true;
    }
    if (typeof window.getSelectedArtifactPath === 'function' && window.getSelectedArtifactPath()) {
      return true;
    }
  }
  return false;
}

/**
 * 项目知识（记忆/Playbook/Wiki）是否自动注入。
 * 不做寒暄/关键词门闩：有非空用户输入即尝试召回；无命中则不注入。
 */
function shouldInjectProjectKnowledge(userQuery) {
  return !!String(userQuery || '').trim();
}

/** AGENTS.md 固定轻量注入（仅 overview）；全文按需 fs_read，禁用关键词分级 */
function agentsMdInjectDepth(_userQuery) {
  return 'light';
}

function shouldAutoCodebaseSearch(userQuery, ws) {
  if (!gwState.authed) return false;
  if (!ws || !ws.workspacePath) return false;
  if (ws.kind === 'ssh' && !ws.sshConnected) return false;
  const q = String(userQuery || '').trim();
  if (!q || q.length < 4) return false;
  if (textHasCodebaseMention(q)) return false;
  return shouldInjectCodeContext(q, { workspaceInfo: ws, includeEditor: false });
}

function formatCodebaseBlock(query, data, snippetMax) {
  const results = Array.isArray(data?.results) ? data.results : [];
  const mode = data?.vectorSearch ? '向量+全文' : data?.grepFallback ? 'grep' : '全文/词元';
  if (!results.length) return '';
  const maxSnip = snippetMax || CTX_LIMITS.CODEBASE_SNIPPET_MAX;
  const lines = results.map((r, i) => {
    const loc = `${r.path || ''}:${r.startLine || 1}-${r.endLine || r.startLine || 1}`;
    const snippet = String(r.snippet || '').trim().slice(0, maxSnip);
    return `### ${i + 1}. ${loc}\n${snippet}`;
  });
  return [
    '【相关代码 · 自动检索】',
    `查询：${query}`,
    `模式：${mode}`,
    `候选：${data?.totalCandidates ?? results.length}`,
    '',
    ...lines
  ].join('\n');
}

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

async function fetchCodebaseContext(userQuery, opts = {}) {
  if (!gwState.authed) return '';
  const lim = ctxLimitsFor(opts);
  const explicit = textHasCodebaseMention(userQuery);
  const query = explicit
    ? stripCodebaseMention(userQuery) || String(userQuery || '').replace(/@Codebase/gi, '').trim()
    : String(userQuery || '').trim();
  if (!query) return '';
  const limit = opts.limit || (explicit ? lim.CODEBASE_MENTION_LIMIT : lim.CODEBASE_AUTO_LIMIT);
  const timeoutMs = opts.timeoutMs || 15000;
  try {
    const searchParams =
      typeof withSessionRpcScope === 'function'
        ? withSessionRpcScope(
            {
              query,
              limit,
              autoIndex: false,
              ...(opts.runWorkspaceRoot ? { runWorkspaceRoot: opts.runWorkspaceRoot } : {})
            },
            opts.sessionId
          )
        : {
            query,
            limit,
            autoIndex: false,
            ...(opts.runWorkspaceRoot ? { runWorkspaceRoot: opts.runWorkspaceRoot } : {})
          };
    const data = await gatewayCallWithTimeout('codebase.search', searchParams, timeoutMs);
    const label = explicit ? '【Codebase 检索】' : '【相关代码 · 自动检索】';
    const block = formatCodebaseBlock(query, data, lim.CODEBASE_SNIPPET_MAX);
    return block.replace(/^【[^】]+】/, label);
  } catch (e) {
    return `【相关代码】\n查询：${query}\n状态：失败，${e.message || e}`;
  }
}

/**
 * 结构索引压缩地图（枢纽文件/符号/依赖），供 Agent prep 注入。
 * @param {string} workspacePath
 * @param {{ limit?: number, sessionId?: string, runWorkspaceRoot?: string }} [opts]
 */
async function fetchGraphRepoMap(workspacePath, opts = {}) {
  if (!gwState || !gwState.authed || !workspacePath) return '';
  const lim = ctxLimitsFor(opts);
  const limit = opts.limit != null ? Number(opts.limit) : lim.GRAPH_REPO_MAP_LIMIT;
  try {
    const params =
      typeof withSessionRpcScope === 'function'
        ? withSessionRpcScope(
            {
              workspaceRoot: workspacePath,
              limit,
              ...(opts.runWorkspaceRoot ? { runWorkspaceRoot: opts.runWorkspaceRoot } : {})
            },
            opts.sessionId
          )
        : {
            workspaceRoot: workspacePath,
            limit,
            ...(opts.runWorkspaceRoot ? { runWorkspaceRoot: opts.runWorkspaceRoot } : {})
          };
    const data = await gatewayCallWithTimeout('graph.repo_map', params, 25000);
    if (!data || data.indexed === false) return '';
    let md = data.markdown != null ? String(data.markdown).trim() : '';
    if (!md) return '';
    const maxChars = lim.GRAPH_REPO_MAP_MAX_CHARS || 4500;
    if (md.length > maxChars) md = `${md.slice(0, maxChars)}\n…`;
    return md;
  } catch {
    return '';
  }
}

/**
 * 后台触发 LSP 调用边增强（不阻塞发消息）。
 */
function scheduleGraphLspEnrichKick(workspacePath) {
  if (!gwState || !gwState.authed || !workspacePath || typeof gatewayCall !== 'function') return;
  void gatewayCall(
    'graph.lsp_enrich',
    { workspaceRoot: workspacePath, limit: 16 },
    5000
  ).catch(() => {});
}

function formatMemoryLines(rows, maxLen) {
  return (rows || [])
    .slice(0, 20)
    .map((r) => {
      const kind = r.kind && r.kind !== 'normal' ? ` · ${r.kind}` : '';
      const score = Number.isFinite(Number(r.score)) && Number(r.score) > 0 ? ` · ${Number(r.score).toFixed(2)}` : '';
      return `- #${r.id}${kind}${score} ${compactPlainText(r.content || '', maxLen || 360)}`;
    })
    .filter(Boolean);
}

async function fetchProjectMemoryContext(userQuery, workspacePath, opts = {}) {
  if (!gwState.authed || !workspacePath) return '';
  const lim = ctxLimitsFor(opts);
  try {
    const q = String(userQuery || '').trim();
    const params =
      typeof withSessionRpcScope === 'function'
        ? withSessionRpcScope(
            {
              workspacePath,
              query: q,
              limit: lim.PROJECT_MEMORY_LIMIT,
              runWorkspaceRoot: workspacePath
            },
            opts.sessionId
          )
        : {
            workspacePath,
            query: q,
            limit: lim.PROJECT_MEMORY_LIMIT,
            runWorkspaceRoot: workspacePath
          };
    const recall = await gatewayCallWithTimeout('memory.project_recall', params, 10000);
    const rows = recall && Array.isArray(recall.results) ? recall.results : [];
    const minScore = recall?.mode === 'semantic' ? 0.32 : recall?.mode === 'keyword' ? 0.12 : 0;
    const filtered =
      minScore > 0
        ? rows.filter((r) => (Number(r.score) || 0) >= minScore)
        : rows;
    if (!filtered.length) return '';
    const lines = formatMemoryLines(filtered, 420);
    const modeLabel =
      recall.mode === 'semantic' ? '语义' : recall.mode === 'keyword' ? '关键词' : '最近';
    return (
      `【项目记忆 · ${modeLabel} · 跨会话/历史沉淀，非本轮对话记录】\n` +
      `绑定工作空间：${workspacePath}\n` +
      `与当前任务相关时优先遵守；与用户最新输入或【本会话近期对话】冲突时以会话对话为准。\n` +
      `${lines.join('\n')}`
    );
  } catch {
    return '';
  }
}

/** 仅召回 scope=global 的用户级长期记忆，不跨项目泄漏。 */
async function fetchGlobalOnlyMemoryContext(userQuery) {
  if (!gwState.authed) return '';
  try {
    const q = String(userQuery || '').trim();
    const recall = q
      ? await gatewayCallWithTimeout('memory.long_recall', {
          query: q,
          limit: CTX_LIMITS.GLOBAL_MEMORY_LIMIT,
          scope: 'global'
        })
      : {
          mode: 'recent',
          results: await gatewayCallWithTimeout('memory.long_recent', {
            limit: CTX_LIMITS.GLOBAL_MEMORY_LIMIT,
            scope: 'global'
          })
        };
    const rows = recall && Array.isArray(recall.results) ? recall.results : [];
    const minScore = recall?.mode === 'semantic' ? 0.32 : recall?.mode === 'keyword' ? 0.12 : 0;
    const filtered =
      minScore > 0
        ? rows.filter((r) => (Number(r.score) || 0) >= minScore)
        : rows;
    if (!filtered.length || recall?.mode === 'none') return '';
    const lines = formatMemoryLines(filtered, 360);
    const modeLabel =
      recall && recall.mode === 'semantic'
        ? '语义召回'
        : recall && recall.mode === 'keyword'
          ? '关键词召回'
          : '最近记忆';
    return (
      `【长期记忆（用户级 · ${modeLabel} · 非项目专属）】\n` +
      `以下为跨工作区的用户偏好/事实沉淀，不是本会话刚才的往来，也不含其他项目的任务记录。\n` +
      `${lines.join('\n')}`
    );
  } catch {
    return '';
  }
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

function estimateTextTokens(text) {
  const s = String(text || '');
  const cjk = (s.match(/[\u3400-\u9fff\uf900-\ufaff]/g) || []).length;
  const other = s.length - cjk;
  return Math.ceil(cjk / 1.5 + other / 3.2);
}

function estimateMessagesTokens(msgs) {
  return (msgs || []).reduce((n, m) => {
    let content = m.content;
    if (Array.isArray(content)) {
      content = content
        .map((p) => (typeof p === 'string' ? p : p?.text || p?.content || ''))
        .join('\n');
    }
    if (m.tool_calls) content = `${content || ''}\n${JSON.stringify(m.tool_calls)}`;
    return n + estimateTextTokens(content) + 6;
  }, 0);
}

function estimateToolsTokens(tools) {
  if (!tools || !tools.length) return 0;
  try {
    return estimateTextTokens(JSON.stringify(tools));
  } catch {
    return Math.ceil(tools.length * 120);
  }
}

function estimateFullContextUsage({ systemContent, messages, tools, draft }) {
  let total = estimateTextTokens(systemContent || '');
  total += estimateMessagesTokens(messages || []);
  total += estimateToolsTokens(tools || []);
  if (draft && String(draft).trim()) {
    total += estimateTextTokens(draft) + 6;
  }
  return total;
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

function resetCodebaseWarmCache() {
  // Codebase indexing is lazy now: it starts from user intent via fetchCodebaseContext().
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

function extractCodebasePathsFromBlock(block) {
  const paths = [];
  const re = /^###\s+\d+\.\s+([^:\n]+):/gm;
  let m;
  while ((m = re.exec(String(block || '')))) {
    paths.push(m[1].trim());
  }
  return paths;
}

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
  return {
    enabled: true,
    timeoutMs: CTX_LIMITS.LSP_DIAG_TIMEOUT_MS,
    maxFiles: CTX_LIMITS.LSP_DIAG_MAX_FILES,
    maxPerFile: 20,
    minSeverity: 'warning'
  };
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

  const maxFiles = opts.maxFiles != null ? opts.maxFiles : CTX_LIMITS.LSP_DIAG_MAX_FILES;
  return out.slice(0, maxFiles);
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

  const files = mergeDiagnosticsFilePaths(userQuery, {
    pathHints: mergedPaths,
    maxFiles: opts.maxFiles || lspSettings.maxFiles || lim.LSP_DIAG_MAX_FILES,
    sessionId: opts.sessionId,
    skipUiPaths
  });

  const timeoutMs =
    opts.timeoutMs != null
      ? opts.timeoutMs
      : lspSettings.timeoutMs || lim.LSP_DIAG_TIMEOUT_MS;

  const maxFiles = opts.maxFiles || lspSettings.maxFiles || lim.LSP_DIAG_MAX_FILES;

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
    const data = await gatewayCallWithTimeout('workspace.diagnostics', diagParams, timeoutMs + 4000);
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
window.estimateFullContextUsage = estimateFullContextUsage;
window.estimateToolsTokens = estimateToolsTokens;
window.estimateMessagesTokens = estimateMessagesTokens;
window.truncateToolResultForApi = truncateToolResultForApi;
window.fetchProjectMemoryContext = fetchProjectMemoryContext;
window.fetchGlobalOnlyMemoryContext = fetchGlobalOnlyMemoryContext;
window.fetchCodebaseContext = fetchCodebaseContext;
window.fetchGraphRepoMap = fetchGraphRepoMap;
window.scheduleGraphLspEnrichKick = scheduleGraphLspEnrichKick;
window.buildOpenFilesContext = buildOpenFilesContext;
window.buildRecentChangesContext = buildRecentChangesContext;
window.extractCodebasePathsFromBlock = extractCodebasePathsFromBlock;
window.resetCodebaseWarmCache = resetCodebaseWarmCache;
window.getLspSettingsCached = getLspSettingsCached;
window.invalidateLspSettingsCache = invalidateLspSettingsCache;
window.mergeDiagnosticsFilePaths = mergeDiagnosticsFilePaths;
window.shouldFetchWorkspaceDiagnostics = shouldFetchWorkspaceDiagnostics;
window.shouldInjectCodeContext = shouldInjectCodeContext;
window.shouldInjectProjectKnowledge = shouldInjectProjectKnowledge;
window.agentsMdInjectDepth = agentsMdInjectDepth;
window.fetchWorkspaceDiagnosticsContext = fetchWorkspaceDiagnosticsContext;
window.formatDiagnosticsBlock = formatDiagnosticsBlock;
window.extractPathHintsFromText = extractPathHintsFromText;

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
