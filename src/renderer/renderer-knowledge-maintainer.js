/* global gatewayCall, gwState, fetchChatCompletion, resolveComposerModelForSend, getCustomModelApiConfig, compactPlainText, showAgentToast, getAgentsMdMode, ensureAgentsMd, loadAgentsMdRecord, parseMaintainerResponse, proposeAgentsMdUpdates, getPlaybookAutoMode, shouldRunPlaybookSedimentation, queuePlaybookDraftPreview, traceHasPlaybookPropose, messages, isSending, sessionActiveRuns, $, diecloud */
'use strict';

let knowledgeMaintenancePending = false;
let lastKnowledgeMaintenanceAt = 0;
/** @type {Map<string, object>} */
const pendingKnowledgeMaintenanceBySession = new Map();
/** @type {object[]} */
const knowledgeMaintenanceQueue = [];
/** @type {Map<string, number>} */
const backgroundKnowledgeFallbackTimers = new Map();
/** @type {string | null} */
let backgroundFallbackSessionId = null;

const KNOWLEDGE_CONSOL_KEY = 'dieyun.knowledge.consolidation.v1';
const KNOWLEDGE_CONSOL_DEFAULTS = Object.freeze({
  mode: 'on',
  intervalHours: 6,
  scopes: Object.freeze({
    recentChat: true,
    longMemory: true,
    projectMemory: true,
    wiki: true,
    playbook: true,
    agents: true
  }),
  lastRunAt: 0,
  lastRunOk: null,
  lastRunSummary: ''
});

/** @type {ReturnType<typeof setInterval> | null} */
let knowledgeConsolTimer = null;
/** @type {ReturnType<typeof setTimeout> | null} */
let knowledgeConsolKickTimer = null;
let knowledgeConsolRunning = false;

function planStepsFromInput(plan) {
  if (!plan) return [];
  if (Array.isArray(plan.subtasks)) return plan.subtasks;
  if (Array.isArray(plan.tasks)) return plan.tasks;
  return [];
}

const UNIFIED_KNOWLEDGE_SCHEMA = `只输出 JSON，不要 Markdown 包裹或额外说明。格式：
{
  "memories": [{"content":"…","kind":"normal|private|secret","importance":1-5,"scope":"global|project"}],
  "archive_memory_ids": ["记忆id"],
  "agents_updates": [{"section":"commands","action":"append","content":"- …","confidence":0.9}],
  "wiki_updates": [{"slug":"page-slug","title":"标题","body":"markdown正文","action":"upsert"}],
  "playbook": {"worthy":false,"confidence":0,"title":"","domain":"general","goal":"","steps":"","commands":"","acceptance":"","pitfalls":"","relatedFiles":"","tags":[]}
}`;

function getKnowledgeConsolidationSettings() {
  const base = {
    mode: KNOWLEDGE_CONSOL_DEFAULTS.mode,
    intervalHours: KNOWLEDGE_CONSOL_DEFAULTS.intervalHours,
    scopes: { ...KNOWLEDGE_CONSOL_DEFAULTS.scopes },
    lastRunAt: 0,
    lastRunOk: null,
    lastRunSummary: ''
  };
  try {
    const raw = window.localStorage.getItem(KNOWLEDGE_CONSOL_KEY);
    if (!raw) return base;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return base;
    if (parsed.mode === 'off' || parsed.mode === 'idle' || parsed.mode === 'on') base.mode = parsed.mode;
    const hours = Number(parsed.intervalHours);
    if (hours === 6 || hours === 12 || hours === 24) base.intervalHours = hours;
    if (parsed.scopes && typeof parsed.scopes === 'object') {
      for (const k of Object.keys(base.scopes)) {
        if (typeof parsed.scopes[k] === 'boolean') base.scopes[k] = parsed.scopes[k];
      }
    }
    if (Number.isFinite(Number(parsed.lastRunAt))) base.lastRunAt = Number(parsed.lastRunAt);
    if (parsed.lastRunOk === true || parsed.lastRunOk === false) base.lastRunOk = parsed.lastRunOk;
    if (typeof parsed.lastRunSummary === 'string') base.lastRunSummary = parsed.lastRunSummary.slice(0, 240);
  } catch {
    // ignore
  }
  return base;
}

function saveKnowledgeConsolidationSettings(patch) {
  const cur = getKnowledgeConsolidationSettings();
  const next = {
    ...cur,
    ...(patch || {}),
    scopes: { ...cur.scopes, ...((patch && patch.scopes) || {}) }
  };
  try {
    window.localStorage.setItem(KNOWLEDGE_CONSOL_KEY, JSON.stringify(next));
  } catch {
    // ignore
  }
  return next;
}

function buildUnifiedKnowledgeSystemPrompt(opts = {}) {
  const { periodicOnly, fullPeriodic, agentsEnabled, playbookEnabled, wikiEnabled } = opts;
  if (fullPeriodic) {
    let boundary =
      '你是叠云 Agent 的定时知识归纳器。根据输入中的对话与已有知识，合并去重、提炼稳定事实，并建议归档过时记忆。' +
      UNIFIED_KNOWLEDGE_SCHEMA +
      '【写入边界】\n' +
      '1. memories：可复用事实/偏好/密钥（标 kind）；不要寒暄与无结论过程。\n' +
      '2. archive_memory_ids：仅填输入里给出的过时/重复记忆 id。\n';
    if (agentsEnabled) {
      boundary +=
        '3. agents_updates：稳定命令/目录/规范/坑点短列表；section=overview|structure|commands|conventions|testing|architecture|gotchas。\n';
    } else {
      boundary += '3. agents_updates 必须为 []。\n';
    }
    if (playbookEnabled) {
      boundary += '4. playbook：仅当可复用多步 SOP（≥3 步）时 worthy=true。\n';
    } else {
      boundary += '4. playbook.worthy 必须为 false。\n';
    }
    if (wikiEnabled) {
      boundary +=
        '5. wiki_updates：仅当有稳定项目说明值得入库时 upsert；slug 仅 a-z0-9-；body 简洁。无则 []。\n';
    } else {
      boundary += '5. wiki_updates 必须为 []。\n';
    }
    boundary += '禁止编造未出现的路径/命令；无内容则对应数组为空。';
    return boundary;
  }
  if (periodicOnly) {
    return (
      '你是叠云 Agent 的知识维护器（定时归纳）。只从近期对话提取 SQLite 碎片记忆。' +
      UNIFIED_KNOWLEDGE_SCHEMA +
      '【写入边界】memories：临时事实、偏好、密钥（标 kind）、未写入 AGENTS 的坑点；不要命令清单/目录树/多步流程。' +
      'archive_memory_ids / agents_updates / wiki_updates 必须为 []；playbook.worthy 必须为 false。'
    );
  }
  let boundary =
    '【存储分工 · 必须遵守】\n' +
    '1. memories（SQLite 碎片）：临时事实、未验证假设、单次踩坑、密钥/偏好（标 kind）。' +
    '不写：稳定命令清单、目录树、完整多步流程。与 AGENTS 将写入的内容重复则不要放 memories。\n' +
    '2. agents_updates（AGENTS.md 项目地图）：稳定命令、目录、规范、长期坑点（短列表项）。' +
    'section 取值：overview, structure, commands, conventions, testing, architecture, gotchas。' +
    '不写：完整 SOP、逐步操作过程。\n';
  if (playbookEnabled) {
    boundary +=
      '3. playbook：仅当存在可复用多步 SOP（≥3 步）或 Plan 验收通过时 worthy=true。' +
      '写目标、步骤、验收；命令只写关键几条。与已有 Playbook 高度重复则 worthy=false。\n';
  } else {
    boundary += '3. playbook.worthy 必须为 false。\n';
  }
  boundary +=
    '【互斥】同一命令优先 agents_updates.commands，不要同时写 memories；' +
    '完整流程优先 playbook，不要拆成多条 memories。无内容则对应数组为空或 worthy=false。' +
    '禁止编造未出现的命令或路径。wiki_updates 与 archive_memory_ids 在本触发下必须为 []。';
  if (!agentsEnabled) {
    boundary += '\nagents_updates 必须为 []（项目地图维护已关闭）。';
  }
  return `你是叠云 Agent 的统一知识维护器。一次决策，分路写入 memories / AGENTS.md / Playbook。\n${boundary}\n${UNIFIED_KNOWLEDGE_SCHEMA}`;
}

function extractJsonBlock(text) {
  const s = String(text || '').trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) {
    try {
      return JSON.parse(fence[1].trim());
    } catch {
      // ignore
    }
  }
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(s.slice(start, end + 1));
    } catch {
      // ignore
    }
  }
  return null;
}

function collectKnowledgeSignals(input) {
  const trace = input?.trace || [];
  const changes = (input?.changes || []).slice(0, 14).map((c) => {
    const p = c.relativePath || c.path || '';
    return `- ${p}${c.source ? ` (${c.source})` : ''}`;
  });
  const execLines = [];
  let writeCount = 0;
  for (const entry of trace) {
    for (const tool of entry.tools || []) {
      if (tool.pending) continue;
      if (tool.name === 'host_exec') {
        const s = String(tool.summary || '');
        if (/失败|error|exit\s*[1-9]/i.test(s)) continue;
        execLines.push(`- ${tool.argsBrief || 'host_exec'} → ${compactPlainText(s, 140)}`);
      }
      if (
        (tool.name === 'fs_write_file' || tool.name === 'fs_edit') &&
        !/失败|error/i.test(String(tool.summary || ''))
      ) {
        writeCount += 1;
      }
    }
  }
  const plan = input?.plan;
  const planSteps = planStepsFromInput(plan);
  let planSummary = '';
  if (planSteps.length) {
    planSummary = planSteps
      .slice(0, 12)
      .map((t, i) => `${i + 1}. ${compactPlainText(t.title || t.id || '', 120)}`)
      .join('\n');
  }
  return {
    userText: compactPlainText(input?.userText || '', 1400),
    assistantText: compactPlainText(input?.assistantText || '', 1800),
    recentText: compactPlainText(input?.recentText || '', 2400),
    toolTrace: summarizeTraceForKnowledge(trace),
    changes: changes.join('\n'),
    execLines: execLines.slice(0, 10).join('\n'),
    writeCount,
    planSummary,
    reviewNotes: compactPlainText(input?.review?.notes || '', 600),
    appliedPaths: (input?.appliedPaths || []).slice(0, 12).join('\n')
  };
}

function summarizeTraceForKnowledge(trace) {
  const lines = [];
  for (const entry of trace || []) {
    for (const tool of entry.tools || []) {
      if (tool.pending) continue;
      const name = tool.name || 'tool';
      const brief = tool.argsBrief ? ` ${tool.argsBrief}` : '';
      const sum = compactPlainText(tool.summary || '', 180);
      lines.push(`- ${name}${brief}: ${sum}`);
    }
  }
  return lines.slice(0, 28).join('\n');
}

function parseUnifiedKnowledgeJson(text) {
  const json = extractJsonBlock(text) || {};
  const memories = (Array.isArray(json.memories) ? json.memories : Array.isArray(json.items) ? json.items : [])
    .map((item) => ({
      content: compactPlainText(item.content || item.memory || item.text || '', 420),
      kind: ['normal', 'private', 'secret'].includes(String(item.kind || '').toLowerCase())
        ? String(item.kind).toLowerCase()
        : undefined,
      importance: Math.min(5, Math.max(1, Number(item.importance) || 3)),
      scope: compactPlainText(item.scope || 'global', 80)
    }))
    .filter((item) => item.content && item.content.length >= 8)
    .slice(0, 8);
  const agents_updates = Array.isArray(json.agents_updates)
    ? json.agents_updates
    : Array.isArray(json.updates)
      ? json.updates
      : [];
  const playbook = json.playbook && typeof json.playbook === 'object' ? json.playbook : { worthy: false };
  const archive_memory_ids = (Array.isArray(json.archive_memory_ids) ? json.archive_memory_ids : [])
    .map((id) => String(id || '').trim())
    .filter(Boolean)
    .slice(0, 24);
  const wiki_updates = (Array.isArray(json.wiki_updates) ? json.wiki_updates : [])
    .map((w) => ({
      slug: compactPlainText(w.slug || w.id || '', 64)
        .toLowerCase()
        .replace(/[^a-z0-9-]+/g, '-')
        .replace(/^-+|-+$/g, ''),
      title: compactPlainText(w.title || '', 120),
      body: String(w.body || w.content || '').trim().slice(0, 8000),
      action: String(w.action || 'upsert').toLowerCase()
    }))
    .filter((w) => w.slug && w.body.length >= 24)
    .slice(0, 3);
  return { memories, agents_updates, playbook, archive_memory_ids, wiki_updates };
}

function shouldRunUnifiedMaintenance(input) {
  const signals = collectKnowledgeSignals(input);
  if (input?.periodicOnly) {
    return !!signals.recentText;
  }
  if (traceHasPlaybookPropose(input?.trace)) {
    // 用户/Agent 已手动提议 Playbook，仍可做 memory/agents
  }
  // 结构信号（文本长度/工具/变更）；禁用寒暄关键词门闩
  return (
    signals.userText.length >= 8 ||
    !!signals.toolTrace ||
    !!signals.changes ||
    !!signals.execLines ||
    !!signals.planSummary
  );
}

async function applyMemoryItems(items, input) {
  const wsPath = input?.workspacePath ? String(input.workspacePath).trim() : '';
  let saved = 0;
  for (const item of items || []) {
    const useProject =
      wsPath &&
      (String(item.scope || '').toLowerCase() === 'project' ||
        String(item.scope || '').toLowerCase() === 'workspace' ||
        Number(item.importance) >= 4);
    if (useProject) {
      await gatewayCall('memory.project_add', {
        workspacePath: wsPath,
        content: item.content,
        source: input?.memorySource || 'auto_consolidation',
        kind: item.kind,
        importance: item.importance
      });
    } else {
      await gatewayCall('memory.long_add', {
        content: item.content,
        source: input?.memorySource || 'auto_consolidation',
        kind: item.kind,
        scope: item.scope,
        importance: item.importance
      });
    }
    saved += 1;
  }
  return saved;
}

async function applyAgentsUpdates(updates, workspacePath, source, input) {
  if (!updates?.length || !workspacePath || getAgentsMdMode() === 'off') {
    return { applied: 0 };
  }
  await ensureAgentsMd(workspacePath);
  return proposeAgentsMdUpdates(updates, source || 'task-completed', workspacePath);
}

async function applyPlaybookDraft(playbook, input) {
  if (!playbook || !playbook.worthy || getPlaybookAutoMode() === 'off') {
    return { skipped: true };
  }
  const fromPeriodic =
    input?.source === 'periodic_consolidation' || input?.memorySource === 'periodic_consolidation';
  if (!fromPeriodic && !shouldRunPlaybookSedimentation(input)) {
    return { skipped: true, reason: 'gate' };
  }
  const confidence = Number(playbook.confidence);
  if (Number.isFinite(confidence) && confidence < 0.62) {
    return { skipped: true, reason: 'low_confidence' };
  }
  const workspacePath = input?.workspacePath;
  if (!workspacePath) return { skipped: true, reason: 'no_workspace' };

  const title = String(playbook.title || '').trim();
  const goal = String(playbook.goal || '').trim();
  const steps = String(playbook.steps || '').trim();
  if (!title || !goal || !steps) return { skipped: true, reason: 'invalid' };

  const draft = await gatewayCall('playbook.draft_create', {
    workspacePath,
    title,
    domain: playbook.domain,
    goal,
    steps,
    commands: playbook.commands,
    acceptance: playbook.acceptance,
    pitfalls: playbook.pitfalls,
    relatedFiles: playbook.relatedFiles,
    tags: playbook.tags,
    trigger:
      input?.source === 'plan-worktree-applied'
        ? 'plan-worktree'
        : input?.source === 'plan-completed'
          ? 'plan-review'
          : 'auto'
  });
  await queuePlaybookDraftPreview({ ...draft, auto: true }, workspacePath, { auto: true });
  showAgentToast('Playbook 自动沉淀', '已生成草稿，请确认入库或放弃', { variant: 'info' });
  return { ok: true, draftPath: draft.draftPath };
}

async function runUnifiedKnowledgeMaintenance(input) {
  if (!gwState.authed) return { ok: false, reason: 'gateway_disconnected' };
  if (!shouldRunUnifiedMaintenance(input)) return { ok: false, reason: 'skip' };

  const signals = collectKnowledgeSignals(input);
  const workspacePath = input?.workspacePath ? String(input.workspacePath).trim() : '';
  const agentsEnabled = !!workspacePath && getAgentsMdMode() !== 'off';
  const playbookEnabled = !!workspacePath && getPlaybookAutoMode() !== 'off';
  const periodicOnly = !!input?.periodicOnly;

  const model =
    input?.model || resolveComposerModelForSend(signals.userText || signals.recentText || 'x').model;
  const apiConfig =
    input?.apiConfig ||
    resolveComposerModelForSend(signals.userText || signals.recentText || 'x').apiConfig ||
    getCustomModelApiConfig();
  if (!model || !apiConfig?.baseUrl) return { ok: false, reason: 'no_model' };

  let agentsContext = '';
  if (agentsEnabled && !periodicOnly) {
    if (input?.agentsMdSnapshot) {
      agentsContext = String(input.agentsMdSnapshot).slice(0, 12000);
    } else {
      try {
        await ensureAgentsMd(workspacePath);
        const rec = await loadAgentsMdRecord(workspacePath);
        agentsContext = String(rec?.content || '').slice(0, 12000);
      } catch {
        agentsContext = '';
      }
    }
  }

  let playbookTitles = '';
  if (playbookEnabled && !periodicOnly) {
    try {
      const listed = await gatewayCall('playbook.list', { workspacePath });
      playbookTitles = (listed?.entries || [])
        .filter((e) => e && e.status === 'active')
        .slice(0, 16)
        .map((e) => `- ${e.title || e.id} (${e.domain || 'general'})`)
        .join('\n');
    } catch {
      // ignore
    }
  }

  const sourceLabel = periodicOnly
    ? '定时归纳'
    : input?.source === 'plan-worktree-applied'
      ? 'Plan 验收通过且 worktree 已应用'
      : input?.source === 'plan-completed'
        ? 'Plan 验收通过'
        : 'Agent 任务完成';

  const job = await gatewayCall('memory.consolidation_job_create', {
    scope: periodicOnly ? 'global' : workspacePath ? 'unified' : 'global',
    reason: input?.reason || (periodicOnly ? 'periodic' : 'task_completed')
  }).catch(() => null);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 65000);
  let llmText = '';
  try {
    llmText = await fetchChatCompletion({
      model,
      apiConfig,
      temperature: 0.12,
      max_tokens: 2800,
      signal: controller.signal,
      messages: [
        {
          role: 'system',
          content: buildUnifiedKnowledgeSystemPrompt({ periodicOnly, agentsEnabled, playbookEnabled })
        },
        {
          role: 'user',
          content: periodicOnly
            ? `【触发】${sourceLabel}\n\n【近期上下文】\n${signals.recentText || '无'}`
            : [
                `【触发】${sourceLabel}`,
                `【当前 AGENTS.md】\n${agentsContext || '（未启用或无工作空间）'}`,
                `【已有 Playbook】\n${playbookTitles || '无'}`,
                `【用户任务】\n${signals.userText || '无'}`,
                `【Agent 结果】\n${signals.assistantText || '无'}`,
                `【Plan 步骤】\n${signals.planSummary || '无'}`,
                `【验收说明】\n${signals.reviewNotes || '无'}`,
                `【工具执行】\n${signals.toolTrace || '无'}`,
                `【成功命令】\n${signals.execLines || '无'}`,
                `【文件变更】\n${signals.changes || '无'}`,
                `【已应用路径】\n${signals.appliedPaths || '无'}`
              ].join('\n\n')
        }
      ]
    });
  } catch (err) {
    console.warn('unified knowledge maintenance llm', err);
    if (job?.jobId) {
      await gatewayCall('memory.consolidation_job_finish', {
        jobId: job.jobId,
        status: 'failed',
        error: err.message || String(err)
      }).catch(() => {});
    }
    return { ok: false, reason: 'llm_failed' };
  } finally {
    clearTimeout(timeout);
  }

  const parsed = parseUnifiedKnowledgeJson(llmText);
  let memorySaved = 0;
  let agentsApplied = 0;
  let playbookResult = { skipped: true };

  try {
    memorySaved = await applyMemoryItems(parsed.memories, input);

    if (agentsEnabled && !periodicOnly && parsed.agents_updates?.length) {
      const agentsParsed = await parseMaintainerResponse(JSON.stringify({ updates: parsed.agents_updates }));
      const updates = agentsParsed?.updates || parsed.agents_updates;
      const agentsRes = await applyAgentsUpdates(updates, workspacePath, 'task-completed', input);
      agentsApplied = agentsRes?.applied || 0;
    }

    if (playbookEnabled && !periodicOnly && parsed.playbook?.worthy) {
      playbookResult = await applyPlaybookDraft(parsed.playbook, input);
    }

    if (job?.jobId) {
      await gatewayCall('memory.consolidation_job_finish', {
        jobId: job.jobId,
        status: 'completed'
      }).catch(() => {});
    }
    lastKnowledgeMaintenanceAt = Date.now();
    return {
      ok: true,
      memorySaved,
      agentsApplied,
      playbook: playbookResult
    };
  } catch (err) {
    if (job?.jobId) {
      await gatewayCall('memory.consolidation_job_finish', {
        jobId: job.jobId,
        status: 'failed',
        error: err.message || String(err)
      }).catch(() => {});
    }
    return { ok: false, error: err.message || String(err) };
  }
}

function formatMemoryRowsForPrompt(rows, label) {
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length) return `【${label}】\n无`;
  const lines = list.slice(0, 28).map((r) => {
    const id = r.id != null ? r.id : r.memoryId;
    const content = compactPlainText(r.content || '', 220);
    return `- id=${id} · ${content}`;
  });
  return `【${label}】\n${lines.join('\n')}`;
}

async function resolveConsolidationWorkspacePath() {
  if (gwState?.workspacePath) return String(gwState.workspacePath).trim();
  try {
    if (window.diecloud?.getWorkspace) {
      const ws = await window.diecloud.getWorkspace();
      if (ws?.workspacePath) return String(ws.workspacePath).trim();
    }
  } catch {
    // ignore
  }
  return '';
}

function isKnowledgeConsolAgentBusy() {
  try {
    if (typeof isSending !== 'undefined' && isSending) return true;
  } catch {
    // ignore
  }
  try {
    if (sessionActiveRuns && typeof sessionActiveRuns.size === 'number' && sessionActiveRuns.size > 0) {
      return true;
    }
  } catch {
    // ignore
  }
  return false;
}

async function gatherFullConsolidationCorpus(settings, workspacePath) {
  const scopes = settings.scopes || {};
  const parts = [];
  let knownMemoryIds = new Set();

  if (scopes.recentChat !== false) {
    const recent =
      typeof messages !== 'undefined' && Array.isArray(messages)
        ? messages
            .slice(-20)
            .map((m) => `${m.role}: ${compactPlainText(m.content || '', 360)}`)
            .join('\n')
        : '';
    parts.push(`【近期对话】\n${recent || '无'}`);
  }

  if (scopes.longMemory !== false) {
    try {
      const rows = await gatewayCall('memory.long_recent', { limit: 24, scope: 'global' });
      const list = Array.isArray(rows) ? rows : rows?.results || [];
      for (const r of list) {
        if (r?.id != null) knownMemoryIds.add(String(r.id));
      }
      parts.push(formatMemoryRowsForPrompt(list, '长期记忆（global）'));
    } catch {
      parts.push('【长期记忆（global）】\n读取失败');
    }
  }

  if (scopes.projectMemory !== false && workspacePath) {
    try {
      const scopeRes = await gatewayCall('memory.project_scope', { workspacePath });
      const scope = scopeRes?.scope;
      if (scope) {
        const rows = await gatewayCall('memory.long_recent', { limit: 24, scope });
        const list = Array.isArray(rows) ? rows : rows?.results || [];
        for (const r of list) {
          if (r?.id != null) knownMemoryIds.add(String(r.id));
        }
        parts.push(formatMemoryRowsForPrompt(list, '项目记忆'));
      } else {
        parts.push('【项目记忆】\n无 scope');
      }
    } catch {
      parts.push('【项目记忆】\n读取失败');
    }
  }

  if (scopes.wiki !== false && workspacePath) {
    try {
      const listed = await gatewayCall('wiki.list', { workspacePath });
      const pages = (listed?.pages || []).slice(0, 12);
      if (!pages.length) {
        parts.push('【Wiki】\n无页面');
      } else {
        const chunks = [];
        for (const p of pages.slice(0, 6)) {
          const slug = p.slug || p.path || '';
          let body = compactPlainText(p.summary || '', 160);
          if (slug) {
            try {
              const page = await gatewayCall('wiki.read', { workspacePath, slug });
              body = compactPlainText(page?.body || page?.content || body, 500);
            } catch {
              // keep summary
            }
          }
          chunks.push(`### ${p.title || slug}\nslug=${slug}\n${body}`);
        }
        parts.push(`【Wiki】\n${chunks.join('\n\n')}`);
      }
    } catch {
      parts.push('【Wiki】\n读取失败');
    }
  }

  if (scopes.playbook !== false && workspacePath) {
    try {
      const listed = await gatewayCall('playbook.list', { workspacePath });
      const titles = (listed?.entries || [])
        .filter((e) => e && e.status === 'active')
        .slice(0, 16)
        .map((e) => `- ${e.title || e.id} (${e.domain || 'general'})`)
        .join('\n');
      parts.push(`【已有 Playbook】\n${titles || '无'}`);
    } catch {
      parts.push('【已有 Playbook】\n读取失败');
    }
  }

  if (scopes.agents !== false && workspacePath && getAgentsMdMode() !== 'off') {
    try {
      await ensureAgentsMd(workspacePath);
      const rec = await loadAgentsMdRecord(workspacePath);
      parts.push(`【当前 AGENTS.md】\n${String(rec?.content || '').slice(0, 10000) || '空'}`);
    } catch {
      parts.push('【当前 AGENTS.md】\n读取失败');
    }
  }

  return { userContent: parts.join('\n\n'), knownMemoryIds };
}

async function applyArchiveMemoryIds(ids, knownMemoryIds) {
  let n = 0;
  for (const id of ids || []) {
    const memoryId = Number(id);
    if (!Number.isFinite(memoryId) || memoryId <= 0) continue;
    if (knownMemoryIds && knownMemoryIds.size && !knownMemoryIds.has(String(memoryId))) continue;
    try {
      await gatewayCall('memory.long_status_set', { memoryId, status: 'archived' });
      n += 1;
    } catch {
      // ignore
    }
  }
  return n;
}

async function applyWikiUpdates(updates, workspacePath) {
  if (!workspacePath || !updates?.length) return 0;
  let n = 0;
  for (const w of updates) {
    try {
      await gatewayCall('wiki.write', {
        workspacePath,
        slug: w.slug,
        title: w.title || w.slug,
        body: w.body
      });
      n += 1;
    } catch (err) {
      console.warn('wiki consolidate write', err);
    }
  }
  return n;
}

/**
 * 完整版定时知识归纳：对话模型整理记忆 + 可选 Wiki/Playbook/AGENTS。
 * @param {{ force?: boolean, reason?: string }} opts
 */
async function runFullPeriodicKnowledgeConsolidation(opts = {}) {
  if (!gwState.authed) return { ok: false, reason: 'gateway_disconnected' };
  if (knowledgeConsolRunning) return { ok: false, reason: 'busy' };

  const settings = getKnowledgeConsolidationSettings();
  if (!opts.force && settings.mode === 'off') return { ok: false, reason: 'disabled' };
  if (!opts.force && settings.mode === 'idle' && isKnowledgeConsolAgentBusy()) {
    return { ok: false, reason: 'agent_busy' };
  }

  knowledgeConsolRunning = true;
  const workspacePath = await resolveConsolidationWorkspacePath();
  const agentsEnabled =
    !!workspacePath && settings.scopes.agents !== false && getAgentsMdMode() !== 'off';
  const playbookEnabled =
    !!workspacePath && settings.scopes.playbook !== false && getPlaybookAutoMode() !== 'off';
  const wikiEnabled = !!workspacePath && settings.scopes.wiki !== false;

  const model = resolveComposerModelForSend('knowledge consolidation').model;
  const apiConfig =
    resolveComposerModelForSend('knowledge consolidation').apiConfig || getCustomModelApiConfig();
  if (!model || !apiConfig?.baseUrl) {
    knowledgeConsolRunning = false;
    const summary = '无可用对话模型';
    saveKnowledgeConsolidationSettings({
      lastRunAt: Date.now(),
      lastRunOk: false,
      lastRunSummary: summary
    });
    refreshKnowledgeConsolStatusUi();
    return { ok: false, reason: 'no_model' };
  }

  let corpus;
  try {
    corpus = await gatherFullConsolidationCorpus(settings, workspacePath);
  } catch (err) {
    knowledgeConsolRunning = false;
    return { ok: false, reason: 'gather_failed', error: err.message || String(err) };
  }

  if (!String(corpus.userContent || '').replace(/【[^】]+】/g, '').replace(/无|读取失败|空|scope/gi, '').trim()) {
    knowledgeConsolRunning = false;
    const summary = '无可整理内容';
    saveKnowledgeConsolidationSettings({
      lastRunAt: Date.now(),
      lastRunOk: true,
      lastRunSummary: summary
    });
    refreshKnowledgeConsolStatusUi();
    return { ok: true, skipped: true, reason: 'empty' };
  }

  const job = await gatewayCall('memory.consolidation_job_create', {
    scope: workspacePath ? 'workspace' : 'global',
    reason: opts.reason || 'periodic_full'
  }).catch(() => null);

  // 机械维护：衰减 + 向量重建
  await gatewayCall('memory.long_decay', { staleDays: 120, archiveDays: 240 }).catch(() => {});
  await gatewayCall('memory.long_reindex', { limit: 100 }).catch(() => {});

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 90000);
  let llmText = '';
  try {
    llmText = await fetchChatCompletion({
      model,
      apiConfig,
      temperature: 0.12,
      max_tokens: 3500,
      signal: controller.signal,
      messages: [
        {
          role: 'system',
          content: buildUnifiedKnowledgeSystemPrompt({
            fullPeriodic: true,
            agentsEnabled,
            playbookEnabled,
            wikiEnabled
          })
        },
        {
          role: 'user',
          content:
            `【触发】定时知识归纳（完整版）\n工作空间：${workspacePath || '（未绑定，仅全局记忆）'}\n模型：跟随对话 · ${model}\n\n` +
            corpus.userContent
        }
      ]
    });
  } catch (err) {
    console.warn('full periodic consolidation llm', err);
    if (job?.jobId) {
      await gatewayCall('memory.consolidation_job_finish', {
        jobId: job.jobId,
        status: 'failed',
        error: err.message || String(err)
      }).catch(() => {});
    }
    knowledgeConsolRunning = false;
    saveKnowledgeConsolidationSettings({
      lastRunAt: Date.now(),
      lastRunOk: false,
      lastRunSummary: err.message || '模型调用失败'
    });
    refreshKnowledgeConsolStatusUi();
    return { ok: false, reason: 'llm_failed' };
  } finally {
    clearTimeout(timeout);
  }

  const parsed = parseUnifiedKnowledgeJson(llmText);
  const input = {
    workspacePath,
    memorySource: 'periodic_consolidation',
    source: 'periodic_consolidation'
  };

  try {
    const memorySaved = await applyMemoryItems(parsed.memories, input);
    const archived = await applyArchiveMemoryIds(parsed.archive_memory_ids, corpus.knownMemoryIds);

    let agentsApplied = 0;
    if (agentsEnabled && parsed.agents_updates?.length) {
      const agentsParsed = await parseMaintainerResponse(
        JSON.stringify({ updates: parsed.agents_updates })
      );
      const updates = agentsParsed?.updates || parsed.agents_updates;
      const agentsRes = await applyAgentsUpdates(updates, workspacePath, 'periodic', input);
      agentsApplied = agentsRes?.applied || 0;
    }

    let playbookResult = { skipped: true };
    if (playbookEnabled && parsed.playbook?.worthy) {
      playbookResult = await applyPlaybookDraft(parsed.playbook, input);
    }

    let wikiWritten = 0;
    if (wikiEnabled && parsed.wiki_updates?.length) {
      wikiWritten = await applyWikiUpdates(parsed.wiki_updates, workspacePath);
    }

    if (job?.jobId) {
      await gatewayCall('memory.consolidation_job_finish', {
        jobId: job.jobId,
        status: 'completed'
      }).catch(() => {});
    }

    lastKnowledgeMaintenanceAt = Date.now();
    const summary = `记忆+${memorySaved} 归档${archived} AGENTS${agentsApplied} Wiki${wikiWritten}${
      playbookResult?.ok ? ' Playbook草稿' : ''
    }`;
    saveKnowledgeConsolidationSettings({
      lastRunAt: Date.now(),
      lastRunOk: true,
      lastRunSummary: summary
    });
    refreshKnowledgeConsolStatusUi();
    return {
      ok: true,
      memorySaved,
      archived,
      agentsApplied,
      wikiWritten,
      playbook: playbookResult
    };
  } catch (err) {
    if (job?.jobId) {
      await gatewayCall('memory.consolidation_job_finish', {
        jobId: job.jobId,
        status: 'failed',
        error: err.message || String(err)
      }).catch(() => {});
    }
    saveKnowledgeConsolidationSettings({
      lastRunAt: Date.now(),
      lastRunOk: false,
      lastRunSummary: err.message || String(err)
    });
    refreshKnowledgeConsolStatusUi();
    return { ok: false, error: err.message || String(err) };
  } finally {
    knowledgeConsolRunning = false;
  }
}

function formatKnowledgeConsolLastRun(settings) {
  if (!settings.lastRunAt) return '尚未运行';
  const t = new Date(settings.lastRunAt);
  const when = Number.isNaN(t.getTime()) ? String(settings.lastRunAt) : t.toLocaleString();
  const flag = settings.lastRunOk === false ? '失败' : settings.lastRunOk === true ? '成功' : '';
  return `上次：${when}${flag ? ` · ${flag}` : ''}${settings.lastRunSummary ? ` · ${settings.lastRunSummary}` : ''}`;
}

function refreshKnowledgeConsolStatusUi() {
  const el = typeof $ === 'function' ? $('knowledge-consol-status') : null;
  if (!el) return;
  const s = getKnowledgeConsolidationSettings();
  el.textContent = formatKnowledgeConsolLastRun(s);
}

function syncKnowledgeConsolModeTabs(mode) {
  document.querySelectorAll('.knowledge-consol-mode-tab').forEach((btn) => {
    const active = btn.dataset.mode === mode;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-checked', active ? 'true' : 'false');
  });
}

function syncKnowledgeConsolIntervalTabs(hours) {
  document.querySelectorAll('.knowledge-consol-interval-tab').forEach((btn) => {
    const active = Number(btn.dataset.hours) === Number(hours);
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-checked', active ? 'true' : 'false');
  });
}

function syncKnowledgeConsolScopeChecks(scopes) {
  document.querySelectorAll('#knowledge-consol-scopes input[data-scope]').forEach((input) => {
    const key = input.dataset.scope;
    input.checked = scopes[key] !== false;
  });
}

function setKnowledgeConsolHint(text) {
  const el = typeof $ === 'function' ? $('knowledge-consol-hint') : null;
  if (!el) return;
  el.textContent = text || '';
  if (text) {
    el.classList.add('show');
    setTimeout(() => el.classList.remove('show'), 2200);
  }
}

function initKnowledgeConsolidationSettingsUI() {
  const settings = getKnowledgeConsolidationSettings();
  syncKnowledgeConsolModeTabs(settings.mode);
  syncKnowledgeConsolIntervalTabs(settings.intervalHours);
  syncKnowledgeConsolScopeChecks(settings.scopes);
  refreshKnowledgeConsolStatusUi();

  document.querySelectorAll('.knowledge-consol-mode-tab').forEach((btn) => {
    if (btn.dataset.bound === '1') return;
    btn.dataset.bound = '1';
    btn.addEventListener('click', () => {
      const mode = btn.dataset.mode;
      if (!mode || mode === getKnowledgeConsolidationSettings().mode) return;
      saveKnowledgeConsolidationSettings({ mode });
      syncKnowledgeConsolModeTabs(mode);
      setKnowledgeConsolHint('已保存');
      startKnowledgeConsolidationTimers({ reschedule: true });
    });
  });

  document.querySelectorAll('.knowledge-consol-interval-tab').forEach((btn) => {
    if (btn.dataset.bound === '1') return;
    btn.dataset.bound = '1';
    btn.addEventListener('click', () => {
      const hours = Number(btn.dataset.hours);
      if (!(hours === 6 || hours === 12 || hours === 24)) return;
      if (hours === getKnowledgeConsolidationSettings().intervalHours) return;
      saveKnowledgeConsolidationSettings({ intervalHours: hours });
      syncKnowledgeConsolIntervalTabs(hours);
      setKnowledgeConsolHint('已保存');
      startKnowledgeConsolidationTimers({ reschedule: true });
    });
  });

  document.querySelectorAll('#knowledge-consol-scopes input[data-scope]').forEach((input) => {
    if (input.dataset.bound === '1') return;
    input.dataset.bound = '1';
    input.addEventListener('change', () => {
      const scopes = { ...getKnowledgeConsolidationSettings().scopes };
      scopes[input.dataset.scope] = !!input.checked;
      saveKnowledgeConsolidationSettings({ scopes });
      setKnowledgeConsolHint('已保存');
    });
  });
}

function startKnowledgeConsolidationTimers(opts = {}) {
  if (knowledgeConsolTimer) {
    clearInterval(knowledgeConsolTimer);
    knowledgeConsolTimer = null;
  }
  if (knowledgeConsolKickTimer) {
    clearTimeout(knowledgeConsolKickTimer);
    knowledgeConsolKickTimer = null;
  }

  const settings = getKnowledgeConsolidationSettings();
  if (settings.mode === 'off') return;

  const intervalMs = Math.max(1, Number(settings.intervalHours) || 6) * 60 * 60 * 1000;

  const tick = () => {
    if (!gwState.authed) return;
    runFullPeriodicKnowledgeConsolidation({ reason: 'periodic' }).catch((err) =>
      console.warn('knowledge consolidation', err)
    );
  };

  knowledgeConsolTimer = setInterval(tick, intervalMs);

  const due = !settings.lastRunAt || Date.now() - settings.lastRunAt >= intervalMs;
  if (due || opts.reschedule) {
    knowledgeConsolKickTimer = setTimeout(tick, opts.immediate ? 2000 : 90 * 1000);
  }
}

function pumpKnowledgeMaintenanceQueue() {
  if (!gwState.authed || knowledgeMaintenancePending || knowledgeMaintenanceQueue.length === 0) return;
  const now = Date.now();
  const waitMs = 50 * 1000 - (now - lastKnowledgeMaintenanceAt);
  if (waitMs > 0) {
    setTimeout(pumpKnowledgeMaintenanceQueue, waitMs + 50);
    return;
  }
  const next = knowledgeMaintenanceQueue.shift();
  if (!next) return;
  knowledgeMaintenancePending = true;
  const delayMs = Math.max(4000, Number(next.delayMs) || 15000);
  setTimeout(() => {
    runUnifiedKnowledgeMaintenance(next)
      .catch((err) => console.warn('unified knowledge maintenance', err))
      .finally(() => {
        knowledgeMaintenancePending = false;
        pumpKnowledgeMaintenanceQueue();
      });
  }, delayMs);
}

function scheduleUnifiedKnowledgeMaintenance(input) {
  if (!gwState.authed || !input) return;
  knowledgeMaintenanceQueue.push({ ...input, enqueuedAt: Date.now() });
  pumpKnowledgeMaintenanceQueue();
}

function stashKnowledgeMaintenanceContext(input) {
  const sid = String(input && input.sessionId ? input.sessionId : '').trim();
  if (!sid || !input) return;
  pendingKnowledgeMaintenanceBySession.set(sid, { ...input, sessionId: sid });
}

function restoreKnowledgeMaintenanceContext(input) {
  stashKnowledgeMaintenanceContext(input);
}

function clearKnowledgeMaintenanceContext(sessionId) {
  const sid = String(sessionId || '').trim();
  if (sid) pendingKnowledgeMaintenanceBySession.delete(sid);
  else pendingKnowledgeMaintenanceBySession.clear();
}

function hasKnowledgeMaintenanceContext(sessionId) {
  const sid = String(sessionId || '').trim();
  if (sid) return pendingKnowledgeMaintenanceBySession.has(sid);
  return pendingKnowledgeMaintenanceBySession.size > 0;
}

function flushKnowledgeMaintenanceAfterPlan(outcome, extra = {}) {
  const sid = String(extra.sessionId || '').trim();
  const ctx = sid
    ? pendingKnowledgeMaintenanceBySession.get(sid)
    : pendingKnowledgeMaintenanceBySession.size === 1
      ? pendingKnowledgeMaintenanceBySession.values().next().value
      : null;
  if (sid) clearKnowledgeMaintenanceContext(sid);
  else if (ctx && ctx.sessionId) clearKnowledgeMaintenanceContext(ctx.sessionId);
  if (ctx?.sessionId) cancelBackgroundKnowledgeFallback(ctx.sessionId);
  if (!ctx) return;

  const merged = { ...ctx, ...extra };

  if (outcome === 'applied') {
    scheduleUnifiedKnowledgeMaintenance({
      ...merged,
      source: 'plan-worktree-applied',
      delayMs: 5000
    });
    return;
  }
  if (outcome === 'skipped-no-changes' && merged.reviewAccepted) {
    scheduleUnifiedKnowledgeMaintenance({
      ...merged,
      source: 'plan-completed',
      delayMs: 5000
    });
  }
  // 用户放弃应用 worktree 变更时不写入 plan 相关知识
}

function scheduleBackgroundKnowledgeFallback(sessionId) {
  const key = String(sessionId || '');
  if (!key) return;
  backgroundFallbackSessionId = key;
  const prev = backgroundKnowledgeFallbackTimers.get(key);
  if (prev) clearTimeout(prev);
  const timer = setTimeout(() => {
    backgroundKnowledgeFallbackTimers.delete(key);
    if (!hasKnowledgeMaintenanceContext(key)) return;
    flushKnowledgeMaintenanceAfterPlan('skipped-no-changes', { sessionId: key });
  }, 20 * 60 * 1000);
  backgroundKnowledgeFallbackTimers.set(key, timer);
}

function cancelBackgroundKnowledgeFallback(sessionId) {
  const key = String(sessionId || '');
  if (backgroundFallbackSessionId === key) backgroundFallbackSessionId = null;
  const timer = backgroundKnowledgeFallbackTimers.get(key);
  if (timer) {
    clearTimeout(timer);
    backgroundKnowledgeFallbackTimers.delete(key);
  }
}

window.runUnifiedKnowledgeMaintenance = runUnifiedKnowledgeMaintenance;
window.scheduleUnifiedKnowledgeMaintenance = scheduleUnifiedKnowledgeMaintenance;
window.stashKnowledgeMaintenanceContext = stashKnowledgeMaintenanceContext;
window.restoreKnowledgeMaintenanceContext = restoreKnowledgeMaintenanceContext;
window.flushKnowledgeMaintenanceAfterPlan = flushKnowledgeMaintenanceAfterPlan;
window.hasKnowledgeMaintenanceContext = hasKnowledgeMaintenanceContext;
window.clearKnowledgeMaintenanceContext = clearKnowledgeMaintenanceContext;
window.scheduleBackgroundKnowledgeFallback = scheduleBackgroundKnowledgeFallback;
window.cancelBackgroundKnowledgeFallback = cancelBackgroundKnowledgeFallback;
window.getKnowledgeConsolidationSettings = getKnowledgeConsolidationSettings;
window.runFullPeriodicKnowledgeConsolidation = runFullPeriodicKnowledgeConsolidation;
window.startKnowledgeConsolidationTimers = startKnowledgeConsolidationTimers;
window.initKnowledgeConsolidationSettingsUI = initKnowledgeConsolidationSettingsUI;

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      initKnowledgeConsolidationSettingsUI();
    });
  } else {
    initKnowledgeConsolidationSettingsUI();
  }
}
