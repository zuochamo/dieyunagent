'use strict';

const {
  loadBundledTemplate,
  applySectionUpdates,
  agentsRelativePath,
  agentsMetaRelativePath,
  agentsDraftRelativePath,
  contentHash,
  defaultMeta,
  normalizeMeta
} = require('../agents-md');
const { readAgentsMdPrefs } = require('./agents-md-prefs');

const AGENTS_PENDING_REL = '.dieyun/agents-pending.json';
const AGENTS_MD_TOOL_SECTIONS = new Set([
  'overview',
  'structure',
  'commands',
  'conventions',
  'testing',
  'architecture',
  'gotchas'
]);

function withWs(params, ctx) {
  const ws = ctx.workspacePath || ctx.worktreePath || '';
  const out = { ...(params || {}) };
  if (ws) out.runWorkspaceRoot = ws;
  if (ctx.sessionId) out.sessionId = String(ctx.sessionId);
  return out;
}

function resolveWorkspacePath(args, ctx) {
  return String(
    (ctx && (ctx.workspacePath || ctx.worktreePath)) || (args && args.workspaceRoot) || ''
  ).trim();
}

async function gwReadText(gateway, filePath, ctx) {
  try {
    const r = await gateway.invokeRpc(
      'fs.read_file',
      withWs({ filePath, encoding: 'utf8', maxBytes: 96000 }, ctx)
    );
    if (!r || r.encoding === 'base64') return '';
    return String(r.data || '');
  } catch {
    return '';
  }
}

async function gwWriteText(gateway, filePath, data, ctx) {
  return gateway.invokeRpc(
    'fs.write_file',
    withWs({ filePath, data: String(data || ''), encoding: 'utf8' }, ctx)
  );
}

async function executePlaybookProposeMain(gateway, args, ctx = {}) {
  const a = args || {};
  const title = String(a.title || '').trim();
  const goal = String(a.goal || '').trim();
  const steps = String(a.steps || '').trim();
  if (!title || !goal || !steps) {
    return { error: 'title、goal、steps 必填', errorCode: 'MISSING_ARG', retryable: false };
  }
  if (!gateway || typeof gateway.invokeRpc !== 'function') {
    return { error: 'Gateway 未就绪', errorCode: 'GATEWAY', retryable: true };
  }
  const workspacePath = resolveWorkspacePath(a, ctx);
  if (!workspacePath) {
    return { error: '请先选择工作空间', errorCode: 'MISSING_WORKSPACE', retryable: false };
  }
  const draft = await gateway.invokeRpc(
    'playbook.draft_create',
    withWs(
      {
        workspacePath,
        title,
        domain: a.domain,
        goal,
        steps,
        commands: a.commands,
        acceptance: a.acceptance,
        pitfalls: a.pitfalls,
        relatedFiles: a.relatedFiles,
        tags: a.tags,
        trigger: 'manual'
      },
      ctx
    )
  );
  return {
    ok: true,
    pending: true,
    ui: 'playbook_preview',
    draftPath: draft && draft.draftPath,
    id: draft && draft.id,
    title: (draft && draft.title) || title,
    domain: draft && draft.domain,
    preview: draft && draft.preview,
    workspacePath,
    message: '已生成 Playbook 草稿，请在预览对话框中确认入库或放弃'
  };
}

async function ensureAgentsMdFile(gateway, ctx) {
  const rel = agentsRelativePath();
  const existing = await gwReadText(gateway, rel, ctx);
  if (existing && existing.trim()) return existing;
  const template = loadBundledTemplate();
  await gwWriteText(gateway, rel, template, ctx);
  return template;
}

async function executeAgentsMdProposeMain(gateway, args, ctx = {}, userDataPath = '') {
  const a = args || {};
  const section = String(a.section || '').trim();
  const content = String(a.content || '').trim();
  const action = String(a.action || 'append').trim() || 'append';
  const reason = String(a.reason || '').trim();
  if (!section || !content) {
    return { error: 'section 与 content 必填', errorCode: 'MISSING_ARG', retryable: false };
  }
  if (!AGENTS_MD_TOOL_SECTIONS.has(section)) {
    return {
      error: `section 无效，可用：${[...AGENTS_MD_TOOL_SECTIONS].join(', ')}`,
      errorCode: 'MISSING_ARG',
      retryable: false
    };
  }
  if (!gateway || typeof gateway.invokeRpc !== 'function') {
    return { error: 'Gateway 未就绪', errorCode: 'GATEWAY', retryable: true };
  }
  const workspacePath = resolveWorkspacePath(a, ctx);
  if (!workspacePath) {
    return { error: '请先选择工作空间', errorCode: 'MISSING_WORKSPACE', retryable: false };
  }
  const prefs = readAgentsMdPrefs(userDataPath);
  if (prefs.mode === 'off') {
    return { error: '项目地图维护已关闭（设置 → 电脑权限）', errorCode: 'DISABLED', retryable: false };
  }

  const line = reason ? `- ${content}（${reason}）` : content.startsWith('- ') ? content : `- ${content}`;
  const before = await ensureAgentsMdFile(gateway, ctx);
  const merged = applySectionUpdates(
    before,
    [{ section, action, content: line, confidence: 0.92 }],
    { source: 'agents_md_propose' }
  );
  const applied = merged.applied || [];
  if (!applied.length) {
    return { ok: true, applied: 0, message: '变更已存在或置信度过低，已跳过' };
  }
  const sizeMeta = {
    nearLimit: !!merged.nearLimit,
    truncated: !!merged.truncated,
    contentLength: merged.contentLength || String(merged.content || '').length
  };

  if (prefs.mode === 'draft-only') {
    const draftBody =
      `# AGENTS.md 维护草稿\n\n\`\`\`json\n${JSON.stringify(
        {
          before,
          after: merged.content,
          updates: applied,
          source: 'agents_md_propose',
          at: new Date().toISOString()
        },
        null,
        2
      )}\n\`\`\`\n`;
    await gwWriteText(gateway, agentsDraftRelativePath(), draftBody, ctx);
    return {
      ok: true,
      draft: true,
      applied: applied.length,
      sizeMeta,
      message: '已写入草稿 .dieyun/agents-draft.md，未修改 AGENTS.md'
    };
  }

  if (prefs.preview) {
    const pending = {
      before,
      after: merged.content,
      updates: applied,
      source: 'agents_md_propose',
      workspacePath,
      sizeMeta,
      at: Date.now()
    };
    await gwWriteText(gateway, AGENTS_PENDING_REL, JSON.stringify(pending, null, 2), ctx);
    return {
      ok: true,
      pending: true,
      ui: 'agents_md_preview',
      applied: applied.length,
      workspacePath,
      sizeMeta,
      message: '已打开 Diff 预览，请采纳或放弃'
    };
  }

  const wr = await gwWriteText(gateway, agentsRelativePath(), merged.content, ctx);
  if (wr && wr.ok === false) {
    return { error: wr.error || '写入 AGENTS.md 失败', errorCode: 'WRITE_FAILED', retryable: false };
  }
  let meta = defaultMeta();
  try {
    const raw = await gwReadText(gateway, agentsMetaRelativePath(), ctx);
    if (raw && raw.trim()) meta = normalizeMeta(JSON.parse(raw));
  } catch {
    meta = defaultMeta();
  }
  meta.updatedAt = Date.now();
  meta.lastMaintenanceAt = Date.now();
  meta.contentHash = contentHash(merged.content);
  meta.coldStartDone = true;
  await gwWriteText(gateway, agentsMetaRelativePath(), JSON.stringify(meta, null, 2), ctx);
  await gwWriteText(gateway, AGENTS_PENDING_REL, '', ctx);
  return {
    ok: true,
    applied: applied.length,
    sizeMeta,
    message: `已更新 AGENTS.md（${applied.length} 条）`
  };
}

module.exports = {
  AGENTS_MD_TOOL_SECTIONS,
  executePlaybookProposeMain,
  executeAgentsMdProposeMain
};
