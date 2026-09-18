'use strict';

const { assembleSystemPrompt } = require('./agent-system-prompt');
const { skipAutoCodebaseForTaskTier } = require('./task-tier');
const { getAgentLimits, AGENT_LIMITS_DEFAULTS } = require('./agent-limits');
const { readAgentsMdPrefs } = require('./agents-md-prefs');
const {
  parseSections,
  formatAgentsMdSystemBlock,
  agentsRelativePath
} = require('../agents-md');
const { describeAgentHome } = require('../agent-home');

/**
 * 注入块的兜底上限。带「→ agent-limits」注释的键唯一来源是 `agent-limits.js`，
 * 这里只映射不重复字面量；其余键 agent-limits 无对应项，保持本文件独有。
 */
const DEFAULT_LIMITS = {
  // —— 与 agent-limits.js 单一来源 ——
  CODEBASE_AUTO_LIMIT: AGENT_LIMITS_DEFAULTS.codebaseAutoLimit,
  CODEBASE_SNIPPET_MAX: AGENT_LIMITS_DEFAULTS.codebaseSnippetMax,
  OPEN_FILES_MAX: AGENT_LIMITS_DEFAULTS.openFilesMax,
  FILE_PREVIEW_MAX_CHARS: AGENT_LIMITS_DEFAULTS.filePreviewMaxChars,

  // —— 本文件独有：agent-limits 无对应键 ——
  CODEBASE_MENTION_LIMIT: 16,
  FILE_PREVIEW_MAX_BYTES: 48000,
  RECENT_CHANGE_MAX: 16,
  /** 与 renderer-context-engine.js 的 CTX_LIMITS.AGENTS_MD_MAX 保持一致 */
  AGENTS_MD_MAX: 2800,
  GRAPH_REPO_MAP_LIMIT: 32,
  GRAPH_REPO_MAP_MAX_CHARS: 4500,
  PROJECT_MEMORY_LIMIT: 8,
  GLOBAL_MEMORY_LIMIT: 5,
  PLAYBOOK_RECALL_LIMIT: 3,
  PLAYBOOK_SUMMARY_MAX: 250,
  SKILL_BODY_MAX: 3500,
  SKILL_FULL_COUNT: 3,
  SKILL_TOTAL_COUNT: 5
};

function textHasCodebaseMention(text) {
  return /(^|\s)@Codebase\b/i.test(String(text || ''));
}

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

function shouldInjectCodeContext(userQuery, snapshot = {}) {
  const t = String(userQuery || '').trim();
  if (!t) return false;
  if (textHasCodebaseMention(t)) return true;
  if (extractPathHintsFromText(t).length) return true;
  if (snapshot.forceCodeContext === true) return true;
  const ed = snapshot.editor || {};
  if (snapshot.includeEditor !== false) {
    if (ed.hasActiveFile && ed.hasSelection) return true;
    if (ed.hasArtifact) return true;
  }
  return false;
}

function shouldAutoCodebaseSearch(userQuery, workspaceInfo, editor) {
  if (!workspaceInfo || !workspaceInfo.workspacePath) return false;
  if (workspaceInfo.kind === 'ssh' && !workspaceInfo.sshConnected) return false;
  const q = String(userQuery || '').trim();
  if (!q || q.length < 4) return false;
  if (textHasCodebaseMention(q)) return false;
  if (editor && (editor.hasActiveFile || editor.hasArtifact)) return false;
  return shouldInjectCodeContext(q, { workspaceInfo, includeEditor: false, editor });
}

function ctxLimitsFromUserData(userDataPath) {
  const L =
    userDataPath && typeof getAgentLimits === 'function'
      ? getAgentLimits(userDataPath)
      : typeof getAgentLimits === 'function'
        ? getAgentLimits()
        : {};
  return {
    ...DEFAULT_LIMITS,
    CODEBASE_SNIPPET_MAX: L.codebaseSnippetMax || DEFAULT_LIMITS.CODEBASE_SNIPPET_MAX,
    CODEBASE_AUTO_LIMIT: L.codebaseAutoLimit || DEFAULT_LIMITS.CODEBASE_AUTO_LIMIT,
    OPEN_FILES_MAX: L.openFilesMax || DEFAULT_LIMITS.OPEN_FILES_MAX,
    FILE_PREVIEW_MAX_CHARS: L.filePreviewMaxChars || DEFAULT_LIMITS.FILE_PREVIEW_MAX_CHARS
  };
}

function compactPlainText(s, n) {
  return String(s || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, n || 360);
}

function capText(text, max) {
  const s = String(text || '');
  if (s.length <= max) return s;
  return `${s.slice(0, max)}\n\n…（已截断，原文 ${s.length} 字符）`;
}

function formatCodebaseBlock(query, data, snippetMax, label) {
  const results = Array.isArray(data && data.results) ? data.results : [];
  const mode = data && data.vectorSearch ? '向量+全文' : data && data.grepFallback ? 'grep' : '全文/词元';
  const head = label || '【相关代码 · 自动检索】';
  if (!results.length) return '';
  const maxSnip = snippetMax || DEFAULT_LIMITS.CODEBASE_SNIPPET_MAX;
  const lines = results.map((r, i) => {
    const loc = `${r.path || ''}:${r.startLine || 1}-${r.endLine || r.startLine || 1}`;
    const snippet = String(r.snippet || '').trim().slice(0, maxSnip);
    return `### ${i + 1}. ${loc}\n${snippet}`;
  });
  return [head, `查询：${query}`, `模式：${mode}`, `候选：${data.totalCandidates ?? results.length}`, '', ...lines].join(
    '\n'
  );
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

function isCodebaseContextFailure(block) {
  return typeof block === 'string' && /状态：失败/.test(block);
}

function formatRecentChanges(rows, max) {
  const list = Array.isArray(rows) ? rows.slice(0, max || DEFAULT_LIMITS.RECENT_CHANGE_MAX) : [];
  if (!list.length) return '';
  const lines = list.map((r) => {
    const diff = r && r.diff ? ` +${r.diff.added || 0} -${r.diff.removed || 0}` : '';
    return `- ${r.path}${diff}`;
  });
  return `【本会话变更文件】\n${lines.join('\n')}`;
}

function lightAgentsMdContent(full) {
  const text = String(full || '');
  const sections = parseSections(text);
  if (!sections.length) return text;
  const lightIds = new Set(['overview']);
  const picked = sections.filter((s) => lightIds.has(s.id));
  if (!picked.length) {
    const first = text.indexOf('<!-- dieyun:section:');
    return (first > 0 ? text.slice(0, first) : '').trim();
  }
  if (picked.length >= sections.length) return text;
  const first = text.indexOf('<!-- dieyun:section:');
  const header = first > 0 ? text.slice(0, first) : '';
  let out = header;
  for (const sec of picked) {
    out += `${sec.marker}\n${sec.body}\n\n`;
  }
  return out.trim();
}

function rpcScope(snapshot, extra) {
  return {
    sessionId: snapshot.sessionId || undefined,
    runWorkspaceRoot:
      (snapshot.workspaceInfo && snapshot.workspaceInfo.workspacePath) ||
      snapshot.runWorkspaceRoot ||
      undefined,
    ...(extra || {})
  };
}

function withTimeout(promise, ms, label) {
  const t = Number(ms) > 0 ? Number(ms) : 15000;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error(`${label || 'rpc'} 超时`)), t);
    })
  ]);
}

async function fetchCodebaseBlock(snapshot, invokeRpc, lim) {
  const userQuery = String(snapshot.userQuery || '');
  const explicit = textHasCodebaseMention(userQuery);
  const query = explicit
    ? userQuery.replace(/@Codebase/gi, '').trim() || userQuery.trim()
    : userQuery.trim();
  if (!query) return '';
  if (!snapshot.indexOk) return '';
  const auto = shouldAutoCodebaseSearch(userQuery, snapshot.workspaceInfo, snapshot.editor);
  if (!explicit && snapshot.skipAuto) return '';
  if (!explicit && !auto && !snapshot.forceCodebase) return '';
  const limit = explicit ? lim.CODEBASE_MENTION_LIMIT : lim.CODEBASE_AUTO_LIMIT;
  const label = explicit ? '【Codebase 检索】' : '【相关代码 · 自动检索】';
  try {
    const data = await withTimeout(
      invokeRpc('codebase.search', {
        ...rpcScope(snapshot, { query, limit, autoIndex: false })
      }),
      15000,
      'codebase.search'
    );
    return formatCodebaseBlock(query, data, lim.CODEBASE_SNIPPET_MAX, label);
  } catch (e) {
    const msg = e && e.message ? String(e.message) : String(e);
    return `【相关代码】\n查询：${query}\n状态：失败，${msg}`;
  }
}

async function fetchOpenFilesBlock(snapshot, invokeRpc, lim, skipPaths) {
  const skip = new Set((skipPaths || []).map((p) => String(p || '').replace(/\\/g, '/')));
  const paths = (Array.isArray(snapshot.openFilePaths) ? snapshot.openFilePaths : []).filter(
    (p) => p && !skip.has(String(p).replace(/\\/g, '/'))
  );
  if (!paths.length) return '';
  const maxPreviews = snapshot.maxPreviews != null ? Number(snapshot.maxPreviews) : 4;
  const lines = ['【当前关注文件 · 会话上下文】', '用户/Agent 最近触及的文件（类似 Cursor 打开文件上下文）：'];
  let used = 0;
  let previewCount = 0;
  const slice = paths.slice(0, lim.OPEN_FILES_MAX);
  for (const fp of slice) {
    if (previewCount >= maxPreviews) {
      lines.push(`- ${fp}`);
      continue;
    }
    if (used >= lim.FILE_PREVIEW_MAX_CHARS * maxPreviews) break;
    try {
      const r = await invokeRpc(
        'fs.read_file',
        rpcScope(snapshot, { filePath: fp, maxBytes: lim.FILE_PREVIEW_MAX_BYTES })
      );
      const enc = r && r.encoding === 'base64' ? null : String((r && r.data) || '');
      if (!enc || enc.length < 8) {
        lines.push(`- ${fp}（二进制或空，未注入全文）`);
        continue;
      }
      const body = capText(enc, lim.FILE_PREVIEW_MAX_CHARS);
      used += body.length;
      const trunc = r && r.truncated ? ' [文件未完，可用 offset 续读]' : '';
      lines.push(`### ${fp}${trunc}\n\`\`\`\n${body}\n\`\`\``);
      previewCount += 1;
    } catch {
      lines.push(`- ${fp}（读取失败）`);
    }
  }
  if (lines.length <= 2) return '';
  return lines.join('\n\n');
}

async function fetchGitDiffBlock(snapshot, invokeRpc) {
  const root =
    (snapshot.workspaceInfo && snapshot.workspaceInfo.workspacePath) || snapshot.runWorkspaceRoot;
  if (!root) return '';
  try {
    const data = await invokeRpc(
      'workspace.git_diff',
      rpcScope(snapshot, {
        workspaceRoot: root,
        files: (snapshot.openFilePaths || []).slice(0, 12),
        maxChars: 12000,
        maxFiles: 8
      })
    );
    if (!data || !data.ok || !data.text) return '';
    return String(data.text);
  } catch {
    return '';
  }
}

async function fetchAgentsMdBlock(snapshot, invokeRpc, userDataPath) {
  const root =
    (snapshot.workspaceInfo && snapshot.workspaceInfo.workspacePath) || snapshot.runWorkspaceRoot;
  if (!root) return '';
  const prefs = readAgentsMdPrefs(userDataPath);
  if (prefs.mode === 'off') return '';
  const rel = agentsRelativePath();
  let raw = '';
  try {
    const r = await invokeRpc(
      'fs.read_file',
      rpcScope(snapshot, { filePath: rel, maxBytes: 96000 })
    );
    raw = r && r.encoding === 'base64' ? '' : String((r && r.data) || '');
  } catch {
    raw = '';
  }
  if (!String(raw).trim()) return '';
  const content = lightAgentsMdContent(raw);
  const block = formatAgentsMdSystemBlock({
    content,
    relativePath: rel,
    workspacePath: root
  });
  const max = DEFAULT_LIMITS.AGENTS_MD_MAX;
  if (block.length > max) return `${block.slice(0, max)}\n…（已截断）`;
  return block;
}

async function fetchGraphRepoMapBlock(snapshot, invokeRpc, lim) {
  if (!snapshot.injectCode) return '';
  const root =
    (snapshot.workspaceInfo && snapshot.workspaceInfo.workspacePath) || snapshot.runWorkspaceRoot;
  if (!root || snapshot.skipAuto || snapshot.skipFastIndex || !snapshot.graphIndexOk) return '';
  try {
    const data = await withTimeout(
      invokeRpc(
        'graph.repo_map',
        rpcScope(snapshot, {
          workspaceRoot: root,
          limit: lim.GRAPH_REPO_MAP_LIMIT
        })
      ),
      25000,
      'graph.repo_map'
    );
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

function kickGraphLspEnrich(snapshot, invokeRpc) {
  if (!snapshot.injectCode) return;
  const root =
    (snapshot.workspaceInfo && snapshot.workspaceInfo.workspacePath) || snapshot.runWorkspaceRoot;
  if (
    !root ||
    snapshot.skipAuto ||
    snapshot.skipFastIndex ||
    !snapshot.graphIndexOk ||
    typeof invokeRpc !== 'function'
  ) {
    return;
  }
  void invokeRpc('graph.lsp_enrich', { workspaceRoot: root, limit: 16 }).catch(() => {});
}

function formatMemoryLines(rows, maxLen) {
  return (rows || [])
    .slice(0, 20)
    .map((r) => {
      const kind = r.kind && r.kind !== 'normal' ? ` · ${r.kind}` : '';
      const score =
        Number.isFinite(Number(r.score)) && Number(r.score) > 0 ? ` · ${Number(r.score).toFixed(2)}` : '';
      return `- #${r.id}${kind}${score} ${compactPlainText(r.content || '', maxLen || 360)}`;
    })
    .filter(Boolean);
}

async function fetchProjectMemoryBlock(snapshot, invokeRpc, lim) {
  const root =
    (snapshot.workspaceInfo && snapshot.workspaceInfo.workspacePath) || snapshot.runWorkspaceRoot;
  if (!root) return '';
  try {
    const recall = await withTimeout(
      invokeRpc(
        'memory.project_recall',
        rpcScope(snapshot, {
          workspacePath: root,
          query: String(snapshot.userQuery || '').trim(),
          limit: lim.PROJECT_MEMORY_LIMIT
        })
      ),
      10000,
      'memory.project_recall'
    );
    const rows = recall && Array.isArray(recall.results) ? recall.results : [];
    const minScore = recall && recall.mode === 'semantic' ? 0.32 : recall && recall.mode === 'keyword' ? 0.12 : 0;
    const filtered = minScore > 0 ? rows.filter((r) => (Number(r.score) || 0) >= minScore) : rows;
    if (!filtered.length) return '';
    const modeLabel =
      recall.mode === 'semantic' ? '语义' : recall.mode === 'keyword' ? '关键词' : '最近';
    return (
      `【项目记忆 · ${modeLabel} · 跨会话/历史沉淀，非本轮对话记录】\n` +
      `绑定工作空间：${root}\n` +
      `与当前任务相关时优先遵守；与用户最新输入或【本会话近期对话】冲突时以会话对话为准。\n` +
      `${formatMemoryLines(filtered, 420).join('\n')}`
    );
  } catch {
    return '';
  }
}

async function fetchGlobalMemoryBlock(snapshot, invokeRpc, lim) {
  try {
    const q = String(snapshot.userQuery || '').trim();
    const recall = q
      ? await withTimeout(
          invokeRpc('memory.long_recall', {
            query: q,
            limit: lim.GLOBAL_MEMORY_LIMIT,
            scope: 'global'
          }),
          10000,
          'memory.long_recall'
        )
      : {
          mode: 'recent',
          results: await withTimeout(
            invokeRpc('memory.long_recent', {
              limit: lim.GLOBAL_MEMORY_LIMIT,
              scope: 'global'
            }),
            10000,
            'memory.long_recent'
          )
        };
    const rows = recall && Array.isArray(recall.results) ? recall.results : [];
    const minScore = recall && recall.mode === 'semantic' ? 0.32 : recall && recall.mode === 'keyword' ? 0.12 : 0;
    const filtered = minScore > 0 ? rows.filter((r) => (Number(r.score) || 0) >= minScore) : rows;
    if (!filtered.length || (recall && recall.mode === 'none')) return '';
    const modeLabel =
      recall && recall.mode === 'semantic'
        ? '语义召回'
        : recall && recall.mode === 'keyword'
          ? '关键词召回'
          : '最近记忆';
    return (
      `【长期记忆（用户级 · ${modeLabel} · 非项目专属）】\n` +
      `以下为跨工作区的用户偏好/事实沉淀，不是本会话刚才的往来，也不含其他项目的任务记录。\n` +
      `${formatMemoryLines(filtered, 360).join('\n')}`
    );
  } catch {
    return '';
  }
}

async function fetchPlaybookBlock(snapshot, invokeRpc, lim) {
  const root =
    (snapshot.workspaceInfo && snapshot.workspaceInfo.workspacePath) || snapshot.runWorkspaceRoot;
  if (!root) return '';
  try {
    const recall = await withTimeout(
      invokeRpc(
        'playbook.recall',
        rpcScope(snapshot, {
          workspacePath: root,
          query: String(snapshot.userQuery || '').trim(),
          limit: lim.PLAYBOOK_RECALL_LIMIT
        })
      ),
      10000,
      'playbook.recall'
    );
    const rows = recall && Array.isArray(recall.results) ? recall.results : [];
    if (!rows.length) return '';
    if (!recall.mode || recall.mode === 'none' || recall.mode === 'recent') return '';
    const minScore = recall.mode === 'semantic' ? 0.32 : 0.12;
    const filtered = rows.filter((r) => (Number(r.score) || 0) >= minScore);
    if (!filtered.length) return '';
    const modeLabel = recall.mode === 'semantic' ? '语义' : '关键词';
    const lines = filtered.map((row) => {
      const summary = compactPlainText(row.summary || '', lim.PLAYBOOK_SUMMARY_MAX);
      return `- ${row.id} · ${row.title || row.id}（${row.domain || 'general'}）\n  步骤摘要：${summary}\n  路径：${row.path || ''}`;
    });
    return (
      `【相关 Playbook · ${modeLabel}】\n` +
      `工作空间：${root}\n` +
      `命中时可优先按 SOP 执行；细节用 fs_read_file 读取路径全文。与用户最新输入冲突时以用户为准。\n` +
      `${lines.join('\n')}`
    );
  } catch {
    return '';
  }
}

async function fetchCompactionBlock(snapshot, invokeRpc) {
  const sid = String(snapshot.sessionId || '').trim();
  if (!sid) return '';
  try {
    const { formatCompactionArchiveBlock } = require('./session-context');
    const rows = await invokeRpc('memory.compaction_recent', { sessionId: sid, limit: 1 });
    return formatCompactionArchiveBlock(rows);
  } catch {
    return '';
  }
}

function formatAgentStateBlock(state) {
  if (!state || (!state.summary && !state.stateSnapshot && !state.plan)) return '';
  const snap = state.stateSnapshot && typeof state.stateSnapshot === 'object' ? state.stateSnapshot : {};
  const completed = Array.isArray(snap.completedSubtasks) ? snap.completedSubtasks : [];
  const pending = Array.isArray(snap.pendingItems) ? snap.pendingItems : [];
  const constraints = Array.isArray(snap.importantConstraints) ? snap.importantConstraints : [];
  const planSummary = snap.planSummary || (state.plan && state.plan.summary) || '';
  const stepLines =
    Array.isArray(state.steps) && state.steps.length
      ? state.steps
          .slice(0, 12)
          .map((s) => `- ${s.status || 'pending'} · ${s.step_key || s.step_number}: ${s.title || ''}`)
          .join('\n')
      : '';
  return [
    '## 工作记忆快照',
    `- 核心结论：${compactPlainText(state.summary || planSummary || '暂无', 200)}`,
    `- 任务阶段：${snap.taskStage || state.status || '待处理'}`,
    `- 已完成：${completed.length ? completed.map((x) => compactPlainText(x, 80)).join('；') : '暂无'}`,
    `- 待处理：${pending.length ? pending.map((x) => compactPlainText(x, 80)).join('；') : '以本轮输入为准'}`,
    constraints.length ? `- 约束：${constraints.map((x) => compactPlainText(x, 80)).join('；')}` : '',
    state.runId || (state.plan && state.plan.id)
      ? `- 标识：runId=${state.runId || 'none'}${state.plan && state.plan.id ? `, planId=${state.plan.id}` : ''}`
      : '',
    stepLines ? `\n## 最近步骤\n${stepLines}` : '',
    '与本轮 user 消息冲突时以用户输入为准；勿把本块当作刚结束的对话原文。'
  ]
    .filter(Boolean)
    .join('\n');
}

function shouldInjectWorkMemory(state, snapshot) {
  if (!state || (!state.summary && !state.stateSnapshot && !state.plan)) return false;
  if (snapshot.hasContinueCheckpoint) return true;
  const status = String(state.status || '').toLowerCase();
  if (status !== 'running') return false;
  return !!snapshot.hasActiveRun;
}

async function fetchWorkMemoryBlock(snapshot, invokeRpc) {
  const sid = String(snapshot.sessionId || '').trim();
  if (!sid) return '';
  try {
    const state = await withTimeout(
      invokeRpc('agent.state_get', { sessionId: sid }),
      8000,
      'agent.state_get'
    );
    if (!shouldInjectWorkMemory(state, snapshot)) return '';
    const block = formatAgentStateBlock(state);
    return block ? `【工作记忆模板】\n${block}` : '';
  } catch {
    return '';
  }
}

function shouldDefaultEnableSkillId(id) {
  const s = String(id || '');
  return s === 'builtin:weather' || s.startsWith('builtin:minimax:') || s.startsWith('builtin:curated:');
}

function isSkillEnabled(map, id) {
  if (map && Object.prototype.hasOwnProperty.call(map, id)) return !!map[id];
  return shouldDefaultEnableSkillId(id);
}

async function fetchSkillsBlock(snapshot, deps, lim) {
  const skills = deps && deps.skills;
  if (!skills || typeof skills.scan !== 'function') return '';
  const userQuery = String(snapshot.userQuery || '').trim();
  let catalog = { skills: [] };
  try {
    catalog = (await skills.scan()) || { skills: [] };
  } catch {
    return '';
  }
  const enabledMap =
    snapshot.enabledSkillMap && typeof snapshot.enabledSkillMap === 'object' ? snapshot.enabledSkillMap : {};
  const ids = (catalog.skills || []).filter((sk) => isSkillEnabled(enabledMap, sk.id)).map((sk) => sk.id);
  if (!ids.length) return '';
  let selected = [];
  let recallMeta = null;
  let recallFailed = false;
  if (typeof skills.recall === 'function' && userQuery) {
    try {
      const recalled = await skills.recall({
        query: userQuery,
        enabledIds: ids,
        limit: lim.SKILL_TOTAL_COUNT
      });
      recallMeta = recalled || null;
      selected = Array.isArray(recalled && recalled.skills) ? recalled.skills : [];
    } catch {
      recallFailed = true;
      selected = [];
    }
  }
  if (!selected.length && recallFailed) {
    selected = ids
      .slice(0, lim.SKILL_TOTAL_COUNT)
      .map((id) => (catalog.skills || []).find((s) => s.id === id))
      .filter(Boolean);
  }
  if (!selected.length) return '';
  const parts = [];
  const pick = selected.slice(0, lim.SKILL_TOTAL_COUNT);
  for (const item of pick) {
    const id = item.id || item;
    const fromCatalog = (catalog.skills || []).find((s) => s.id === id) || {};
    const meta = { ...fromCatalog, ...item };
    const skillPath =
      meta.skillPath ||
      (String(id).endsWith('SKILL.md') ? id : `${String(id).replace(/[/\\]$/, '')}/SKILL.md`);
    const skillDir = meta.dir ? String(meta.dir) : '';
    const scoreHint =
      Number.isFinite(Number(meta.score)) && recallMeta
        ? `> 召回分数：${Number(meta.score).toFixed(3)}${
            Number.isFinite(Number(meta.semanticScore))
              ? `，语义 ${Number(meta.semanticScore).toFixed(3)}`
              : ''
          }\n`
        : '';
    const dirHint = skillDir
      ? `> 技能目录：${skillDir}\n> host_exec 时 cwd 设为该目录。\n`
      : '';
    const desc = String(meta.description || '').trim().slice(0, 320);
    parts.push(
      `### 技能：${meta.name || id}\n${scoreHint}> SKILL.md：${skillPath}\n${dirHint}${
        desc ? `${desc}\n` : ''
      }（索引；全文用 fs_read_file 读 SKILL.md）`
    );
  }
  if (!parts.length) return '';
  const modeLabel =
    recallMeta && recallMeta.mode === 'semantic'
      ? `语义召回 · ${recallMeta.embeddingModel || '向量模型'}`
      : recallMeta && recallMeta.mode === 'keyword'
        ? '关键词召回'
        : '已启用前置';
  return (
    `【相关技能 · 索引 · ${modeLabel}】\n` +
    `执行前请 fs_read_file 读取 SKILL.md。\n\n${parts.join('\n\n---\n\n')}`
  );
}

function formatMcpPromptBlock(servers, compactToolsPresent) {
  const enabled = (Array.isArray(servers) ? servers : []).filter((s) => s && s.enabled);
  if (!enabled.length) return '';
  if (compactToolsPresent) {
    const names = enabled.map((s) => s.name || s.id).join('、');
    return (
      `【MCP · ${enabled.length} 个服务已启用】${names}\n` +
      '工具已注册为 mcp_*，参数见各工具 schema。嵌套结构可再调 mcp_tool_schema。'
    );
  }
  const lines = enabled.map((server) => {
    const command = [server.command, ...(server.args || [])].filter(Boolean).join(' ');
    const envLine = server.envHint ? `\n  环境变量：${server.envHint}` : '';
    return `- ${server.name || server.id} (${server.id})：${server.description || ''}\n  启动命令：${command || '未配置'}${envLine}`;
  });
  return (
    '【已启用 MCP 服务】\n' +
    lines.join('\n') +
    '\n说明：启用后叠云会 spawn MCP 子进程并将其工具注册到 Agent（以 mcp_ 开头）；首次连接可能需下载 npm 包。'
  );
}

async function fetchMcpBlock(snapshot, deps) {
  if (!deps || typeof deps.listMcpServers !== 'function') return '';
  try {
    const list = await deps.listMcpServers();
    return formatMcpPromptBlock(list, !!snapshot.compactMcpTools);
  } catch {
    return '';
  }
}

/**
 * Main-side recall: codebase / files / AGENTS.md / graph / memory / skills / MCP, then assemble.
 * Renderer still supplies editor selection and diagnostics as extra chunks.
 */
async function prepSystemPrompt(snapshot = {}, deps = {}) {
  const invokeRpc = deps.invokeRpc;
  if (typeof invokeRpc !== 'function') {
    throw new Error('prepSystemPrompt 需要 invokeRpc');
  }
  const lim = ctxLimitsFromUserData(deps.userDataPath);
  const userQuery = String(snapshot.userQuery || '');
  const injectCode =
    snapshot.injectCode != null
      ? !!snapshot.injectCode
      : shouldInjectCodeContext(userQuery, snapshot);
  const allowCodebase =
    snapshot.allowCodebase != null
      ? !!snapshot.allowCodebase
      : injectCode || textHasCodebaseMention(userQuery);
  let taskTierEnabled;
  try {
    const agentLimits = deps.userDataPath ? getAgentLimits(deps.userDataPath) : getAgentLimits();
    taskTierEnabled = agentLimits && agentLimits.taskTierEnabled;
  } catch {
    taskTierEnabled = undefined;
  }
  const skipAuto = skipAutoCodebaseForTaskTier(snapshot.taskTier, taskTierEnabled);
  const snap = {
    ...snapshot,
    injectCode,
    allowCodebase,
    skipAuto,
    skipFastIndex: !!(snapshot.skipFastIndex || skipAuto)
  };

  const turnHost = [];
  if (allowCodebase) {
    const codebaseBlock = await fetchCodebaseBlock(
      {
        ...snap,
        forceCodebase: false
      },
      invokeRpc,
      lim
    );
    if (isCodebaseContextFailure(codebaseBlock)) {
      const line = String(codebaseBlock)
        .split(/\r?\n/)
        .find((l) => /状态：失败/.test(l));
      const detail = line || '代码库检索失败';
      if (!/INDEX_REQUIRED|INDEXING_IN_PROGRESS|尚未索引|构建中/i.test(detail)) {
        throw new Error(detail.replace(/^.*状态：失败[，,]?/, '').trim() || detail);
      }
    } else if (codebaseBlock) {
      turnHost.push(codebaseBlock);
    }
  }
  if (injectCode) {
    const gitBlock = await fetchGitDiffBlock(snap, invokeRpc);
    if (gitBlock) turnHost.push(gitBlock);
    const changes = formatRecentChanges(snapshot.changeRows, lim.RECENT_CHANGE_MAX);
    if (changes) turnHost.push(changes);
    const skip = extractCodebasePathsFromBlock(
      turnHost.find((c) => String(c).includes('【相关代码】') || String(c).includes('【Codebase')) || ''
    );
    const openBlock = await fetchOpenFilesBlock(snap, invokeRpc, lim, skip);
    if (openBlock) turnHost.push(openBlock);
  }

  const agentsBlock = await fetchAgentsMdBlock(snap, invokeRpc, deps.userDataPath);
  if (agentsBlock) turnHost.push(agentsBlock);

  kickGraphLspEnrich(snap, invokeRpc);
  const injectKnowledge = !!String(userQuery || '').trim();
  const knowledgeBlocks = await Promise.all([
    fetchGraphRepoMapBlock(snap, invokeRpc, lim),
    injectKnowledge ? fetchProjectMemoryBlock(snap, invokeRpc, lim) : Promise.resolve(''),
    fetchGlobalMemoryBlock(snap, invokeRpc, lim),
    injectKnowledge ? fetchPlaybookBlock(snap, invokeRpc, lim) : Promise.resolve(''),
    fetchCompactionBlock(snap, invokeRpc),
    fetchWorkMemoryBlock(snap, invokeRpc),
    fetchSkillsBlock(snap, deps, lim)
  ]);
  for (const block of knowledgeBlocks) {
    if (block) turnHost.push(block);
  }
  const mcpBlock = await fetchMcpBlock(snapshot, deps);

  let permissions = deps.permissions;
  if (permissions == null && typeof deps.getPermissions === 'function') {
    try {
      permissions = deps.getPermissions();
    } catch {
      permissions = null;
    }
  }
  let agentHome = deps.agentHome;
  if (!agentHome && typeof deps.getAgentHome === 'function') {
    try {
      agentHome = deps.getAgentHome();
    } catch {
      agentHome = null;
    }
  }
  let sqlConfig = deps.sqlConfig;
  if (sqlConfig == null && typeof invokeRpc === 'function') {
    try {
      sqlConfig = await invokeRpc('sql.config_get', {});
    } catch {
      sqlConfig = null;
    }
  }

  return assembleSystemPrompt({
    languagePrompt: snapshot.languagePrompt,
    userSystem: snapshot.userSystem,
    composerMode: snapshot.composerMode,
    taskTier: snapshot.taskTier,
    agentHome,
    workspaceInfo: snapshot.workspaceInfo,
    permissions,
    sqlConfig,
    stableDataChunks: [
      ...(Array.isArray(snapshot.stableDataChunks) ? snapshot.stableDataChunks : []),
      ...(mcpBlock ? [mcpBlock] : [])
    ],
    turnDataChunks: [
      ...(Array.isArray(snapshot.turnDataChunks) ? snapshot.turnDataChunks : []),
      ...turnHost
    ],
    now: snapshot.now
  });
}

function resolveAgentHome(userDataPath, workspacePath) {
  return describeAgentHome(userDataPath, workspacePath);
}

module.exports = {
  textHasCodebaseMention,
  extractPathHintsFromText,
  shouldInjectCodeContext,
  shouldAutoCodebaseSearch,
  formatCodebaseBlock,
  formatRecentChanges,
  lightAgentsMdContent,
  extractCodebasePathsFromBlock,
  fetchCodebaseBlock,
  fetchOpenFilesBlock,
  fetchAgentsMdBlock,
  prepSystemPrompt,
  resolveAgentHome
};
