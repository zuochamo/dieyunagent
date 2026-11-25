'use strict';

/**
 * 归纳的两条运行路径：
 *   - `runTaskMaintenance`：一轮任务收尾后的归纳（输入是这一轮的事实信号）；
 *   - `runPeriodicMaintenance`：定时完整归纳（输入是近期对话 + 已有记忆 + AGENTS.md 语料）。
 * 以及两者的公共件：语料收集（`gatherPeriodicCorpus`）、台账收尾（`finishJob`）、运行事实（`buildRunFacts`）。
 *
 * 为什么单独一个文件：这里只负责「什么时候跑、跑完怎么记账」，落库在 `apply.js`、
 * 提问在 `llm.js`、措辞在 `prompt.js`、门闩在 `signals.js`；此前它们一起住在 1600 行的归纳器里。
 *
 * 纯搬移（2026-11-21）：逻辑一行没改，`knowledge-maintainer.js` 继续再导出被外部用到的名字。
 */

const projectMemoryFile = require('../project-memory-file');
const { MAX_FILE_CHARS: AGENTS_MD_FILE_MAX_CHARS } = require('../../agents-md');
const { buildKnowledgeSystemPrompt, agentsPressureNote } = require('./prompt');
const {
  compactPlain,
  collectKnowledgeSignals,
  shouldRunKnowledgeMaintenance,
  parseKnowledgeJson
} = require('./signals');
const { resolveLlmCall, callLlm, extractContent } = require('./llm');
const { runSharedMemoryConsolidation } = require('./shared-memory');
const {
  formatMemoryRowsForPrompt,
  applyMemoryItems,
  applyArchiveMemoryIds,
  applyAgentsUpdates,
  projectFileCtx,
  readProjectMemoryText,
  materializeProjectMemoryFile,
  readWorkspaceText
} = require('./apply');
async function gatherPeriodicCorpus(ctx, settings, limits) {
  const scopes = (settings && settings.scopes) || {};
  const parts = [];
  const knownMemoryIds = new Set();
  const recentChatItems = Number(limits.knowledgeRecentChatItems) || 20;
  const memoryRows = Number(limits.knowledgeCorpusMemoryRows) || 24;

  if (scopes.recentChat !== false) {
    // 「近期对话」= 最近若干个活跃会话各取尾部几条。只取最近一个会话的尾巴既名不副实，
    // 也会和逐轮归纳覆盖同一段对话（去重只按完全相同内容，等于白跑）。
    const lines = [];
    try {
      const sessions = await ctx.invokeRpc('memory.sessions_with_messages', {});
      const sids = (Array.isArray(sessions) ? sessions : [])
        .map((s) => s && (s.id || s.sessionId))
        .filter(Boolean)
        .slice(0, Number(limits.knowledgeRecentChatSessions) || 5);
      const perSession = Math.max(2, Math.ceil(recentChatItems / Math.max(1, sids.length)));
      for (const sid of sids) {
        if (lines.length >= recentChatItems) break;
        const rows = await ctx.invokeRpc('memory.messages_recent', {
          sessionId: String(sid),
          limit: perSession
        });
        const tail = (Array.isArray(rows) ? rows : []).slice(-perSession);
        if (!tail.length) continue;
        lines.push(`— 会话 ${String(sid).slice(0, 8)} —`);
        for (const m of tail) lines.push(`${m.role}: ${compactPlain(m.content || '', 320)}`);
      }
    } catch {
      lines.length = 0;
    }
    parts.push(`【近期对话】\n${lines.slice(0, recentChatItems + 6).join('\n').slice(0, 8000) || '无'}`);
  }

  if (scopes.longMemory !== false) {
    try {
      const rows = await ctx.invokeRpc('memory.long_recent', { limit: memoryRows, scope: 'global' });
      const list = Array.isArray(rows) ? rows : (rows && rows.results) || [];
      for (const r of list) if (r && r.id != null) knownMemoryIds.add(String(r.id));
      parts.push(formatMemoryRowsForPrompt(list, '长期记忆（global）'));
    } catch {
      parts.push('【长期记忆（global）】\n读取失败');
    }
  }

  if (scopes.projectMemory !== false && ctx.workspacePath) {
    // 项目记忆的真相是文件：语料里给它看的就是文件当前内容（库里旧行只是历史残留，
    // 不再当成「当前项目记忆」喂给模型，否则模型会把已被手改掉的条目又写回来）。
    const fileText = await readProjectMemoryText(projectFileCtx(ctx));
    const entries = projectMemoryFile.parseProjectMemoryEntries(fileText);
    if (entries.length) {
      parts.push(
        `【项目记忆（${projectMemoryFile.PROJECT_MEMORY_REL_PATH}）】\n${entries
          .map((e) => `- ${e}`)
          .join('\n')
          .slice(0, 6000)}`
      );
    }
  }

  if (scopes.agents !== false && ctx.workspacePath && ctx.readAgentsMdPrefs().mode !== 'off') {
    const full = await readWorkspaceText(ctx, 'AGENTS.md', 96000);
    if (full && full.trim()) {
      const maxChars = Number(limits.knowledgeAgentsMaxChars) || 12000;
      parts.push(`【当前 AGENTS.md】\n${full.slice(0, maxChars)}${agentsPressureNote(full, AGENTS_MD_FILE_MAX_CHARS)}`);
    }
  }

  return { userContent: parts.join('\n\n'), knownMemoryIds };
}

// ---------------------------------------------------------------------------
// 两种运行形态
// ---------------------------------------------------------------------------

/**
 * 一轮任务收尾归纳（Main 触发：`afterAgentRun` 装配事实后入队，结构信号驱动）。
 * @returns {Promise<{ok: boolean, reason?: string, memorySaved?: number, agentsApplied?: number}>}
 */
async function runTaskMaintenance(ctx, payload = {}) {
  const limits = ctx.limits();
  const signals = collectKnowledgeSignals(payload, limits);
  if (!shouldRunKnowledgeMaintenance({ signals, limits })) {
    return { ok: false, reason: 'skip' };
  }
  const workspacePath = String(payload.workspacePath || '').trim();
  const agentsEnabled = !!workspacePath && ctx.readAgentsMdPrefs().mode !== 'off';
  const llm = resolveLlmCall(ctx, payload, limits);
  if (!llm) return { ok: false, reason: 'no_model' };

  let agentsContext = '';
  let agentsPressure = '';
  if (agentsEnabled) {
    // 不再接受 Renderer 带过来的 AGENTS.md 快照（唯一读取点就在 Main，避免两份口径）
    const full = await readWorkspaceText(ctx, 'AGENTS.md', 96000);
    const maxChars = Number(limits.knowledgeAgentsMaxChars) || 12000;
    agentsContext = full.slice(0, maxChars);
    agentsPressure = agentsPressureNote(full, AGENTS_MD_FILE_MAX_CHARS);
  }

  const sourceLabel =
    payload.source === 'plan-worktree-applied'
      ? 'Plan 验收通过且 worktree 已应用'
      : payload.source === 'plan-completed'
        ? 'Plan 验收通过'
        : 'Agent 任务完成';

  const job = await ctx
    .invokeRpc('memory.consolidation_job_create', {
      scope: workspacePath ? 'unified' : 'global',
      reason: payload.reason || 'task_completed'
    })
    .catch(() => null);

  let text = '';
  try {
    const body = {
      model: llm.model,
      temperature: 0.12,
      max_tokens: Number(limits.knowledgeMaxTokens) || 2800,
      stream: false,
      messages: [
        { role: 'system', content: buildKnowledgeSystemPrompt({ agentsEnabled }) },
        {
          role: 'user',
          content: [
            `【触发】${sourceLabel}`,
            `【当前 AGENTS.md】\n${agentsContext || '（未启用或无工作空间）'}${agentsPressure}`,
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
    };
    text = extractContent(await callLlm(llm, body, ctx.fetchChatCompletion, ctx.coreBridge));
  } catch (err) {
    await finishJob(ctx, job, 'failed', err && (err.message || err));
    return { ok: false, reason: 'llm_failed' };
  }

  const parsed = parseKnowledgeJson(text);
  try {
    const memory = await applyMemoryItems(ctx, parsed.memories, {
      workspacePath,
      source: payload.memorySource || 'auto_consolidation',
      maxItems: limits.knowledgeMemoryItemsMax,
      sessionId: String(payload.sessionId || ctx.sessionId || ''),
      // 溯源：哪一轮 Agent 跑出来的记忆（会话 id 是列，run 是 metadata —— 一个会话可以有很多 run）
      metadata: payload.runId ? { sourceRunId: String(payload.runId) } : undefined
    });
    let agentsApplied = 0;
    const agentsRes = await applyAgentsUpdates(ctx, parsed.agents_updates, workspacePath, sourceLabel);
    agentsApplied = agentsRes.applied;
    await finishJob(ctx, job, 'completed');
    // 共享记忆提炼：抢到锁就整理一次（冷却期在库里判，跨机口径），失败不影响本次归纳
    // `void` + `.catch`：这是 fire-and-forget，没人 await，漏 catch 就是未处理拒绝
    void runSharedMemoryConsolidation(ctx, 'after_task_maintenance').catch(() => {});
    return {
      ok: true,
      memorySaved: memory.saved,
      memoryMerged: memory.merged,
      memorySkipped: memory.skipped,
      agentsApplied
    };
  } catch (err) {
    await finishJob(ctx, job, 'failed', err && (err.message || err));
    return { ok: false, error: err && (err.message || String(err)) };
  }
}

async function finishJob(ctx, job, status, error) {
  if (!job || !job.jobId) return;
  try {
    await ctx.invokeRpc('memory.consolidation_job_finish', {
      jobId: job.jobId,
      status,
      ...(error ? { error: String(error) } : {})
    });
  } catch {
    // 任务账只是审计，失败不阻塞
  }
}

/**
 * 定时完整归纳：机械维护（衰减 + 向量重建）→ LLM 整理 → 写记忆/归档/AGENTS.md。
 */
async function runPeriodicMaintenance(ctx, opts = {}) {
  const settings = ctx.getSettings();
  if (!opts.force && settings.mode === 'off') return { ok: false, reason: 'disabled' };
  if (!opts.force && settings.mode === 'idle' && ctx.isAgentBusy()) {
    return { ok: false, reason: 'agent_busy' };
  }
  const limits = ctx.limits();
  // 机械维护第一步：库里旧的项目记忆行 → `.dieyun/memory.md`（只在文件为空时发生一次）。
  // 必须早于语料组装：语料里给模型看的项目记忆就是文件内容。
  await materializeProjectMemoryFile(ctx, limits).catch(() => {});
  const corpus = await gatherPeriodicCorpus(ctx, settings, limits);
  const stripped = String(corpus.userContent || '')
    .replace(/【[^】]+】/g, '')
    .replace(/无|读取失败/g, '')
    .trim();
  if (!stripped) {
    ctx.updateSettings({ lastRunAt: Date.now(), lastRunOk: true, lastRunSummary: '无可整理内容' });
    return { ok: true, skipped: true, reason: 'empty' };
  }

  const llm = resolveLlmCall(ctx, { model: opts.model, apiConfig: opts.apiConfig }, {
    ...limits,
    knowledgeTimeoutMs: Number(limits.knowledgePeriodicTimeoutMs) || 90000
  });
  if (!llm) {
    ctx.updateSettings({ lastRunAt: Date.now(), lastRunOk: false, lastRunSummary: '无可用对话模型' });
    return { ok: false, reason: 'no_model' };
  }

  const job = await ctx
    .invokeRpc('memory.consolidation_job_create', {
      scope: ctx.workspacePath ? 'workspace' : 'global',
      reason: opts.reason || 'periodic_full'
    })
    .catch(() => null);

  // 机械维护：衰减 + 向量重建（只在这里发生一次，不在每轮里重复）。
  // 窗口与批量都来自 agent-limits（与 Rust 默认一致，但只有这一处声明）。
  await ctx
    .invokeRpc('memory.long_decay', {
      staleDays: Number(limits.knowledgeDecayStaleDays) || 120,
      archiveDays: Number(limits.knowledgeDecayArchiveDays) || 240
    })
    .catch(() => {});
  await ctx
    .invokeRpc('memory.long_reindex', { limit: Number(limits.knowledgeReindexLimit) || 100 })
    .catch(() => {});

  let text = '';
  try {
    const body = {
      model: llm.model,
      temperature: 0.12,
      max_tokens: Number(limits.knowledgePeriodicMaxTokens) || 3500,
      stream: false,
      messages: [
        {
          role: 'system',
          content: buildKnowledgeSystemPrompt({
            fullPeriodic: true,
            agentsEnabled: !!ctx.workspacePath && ctx.readAgentsMdPrefs().mode !== 'off'
          })
        },
        {
          role: 'user',
          content:
            `【触发】定时知识归纳（完整版）\n工作空间：${ctx.workspacePath || '（未绑定，仅全局记忆）'}\n模型：跟随设置 · ${llm.model}\n\n` +
            corpus.userContent
        }
      ]
    };
    text = extractContent(await callLlm(llm, body, ctx.fetchChatCompletion, ctx.coreBridge));
  } catch (err) {
    await finishJob(ctx, job, 'failed', err && (err.message || err));
    ctx.updateSettings({ lastRunAt: Date.now(), lastRunOk: false, lastRunSummary: '模型调用失败' });
    return { ok: false, reason: 'llm_failed' };
  }

  const parsed = parseKnowledgeJson(text);
  try {
    const memory = await applyMemoryItems(ctx, parsed.memories, {
      workspacePath: ctx.workspacePath,
      source: 'periodic_consolidation',
      maxItems: limits.knowledgeMemoryItemsMax,
      // 定时归纳跨多个会话：不编造 sessionId，用归纳作业 id 记账
      metadata: job && job.jobId ? { consolidationJobId: job.jobId } : undefined
    });
    const archived = await applyArchiveMemoryIds(ctx, parsed.archive_memory_ids, corpus.knownMemoryIds);
    const agentsRes = await applyAgentsUpdates(ctx, parsed.agents_updates, ctx.workspacePath, 'periodic');
    await finishJob(ctx, job, 'completed');
    const summary = `记忆+${memory.saved} 合并${memory.merged} 弃${memory.skipped} 归档${archived} AGENTS${agentsRes.applied}`;
    ctx.updateSettings({ lastRunAt: Date.now(), lastRunOk: true, lastRunSummary: summary });
    // 定时归纳是「跨机提炼」最自然的心跳：抢到锁的机器整理一次共享库
    void runSharedMemoryConsolidation(ctx, 'after_periodic_maintenance').catch(() => {});
    return {
      ok: true,
      memorySaved: memory.saved,
      memoryMerged: memory.merged,
      memorySkipped: memory.skipped,
      archived,
      agentsApplied: agentsRes.applied
    };
  } catch (err) {
    await finishJob(ctx, job, 'failed', err && (err.message || err));
    ctx.updateSettings({
      lastRunAt: Date.now(),
      lastRunOk: false,
      lastRunSummary: err && (err.message || String(err))
    });
    return { ok: false, error: err && (err.message || String(err)) };
  }
}

// ---------------------------------------------------------------------------
// 一轮 Agent 运行 → 归纳语料（Main 装配；Renderer 不再上报这一包）
// ---------------------------------------------------------------------------

/**
 * 把一次 `runRustAgentLoop` 的结果装成归纳语料。
 *
 * 以前这包东西由 Renderer 拼（userText / assistantText / trace / changes / plan / review /
 * model / apiConfig 全从 UI 侧带过来），代价有两个：计划任务、定时计划、手机端轮次
 * 根本没有这条路径（只覆盖了对话框），payload 里还塞着上千行 trace。
 * 这些事实本来就都在 Main（`result` 是 Rust 账本的 done 帧），这里装配一次。
 *
 * @param {{result?: object, opts?: object}} run
 * @returns {object | null} 没有会话归属就返回 null —— 归纳必须能溯源到会话或归纳作业
 */
function buildRunFacts(run = {}) {
  const result = run.result || {};
  const opts = run.opts || {};
  const sessionId = String(opts.sessionId || result.sessionId || '').trim();
  if (!sessionId) return null;
  const plan = result.plan || null;
  const review = result.review || null;
  const isPlanRun = !!plan;
  const reviewAccepted = !!(review && review.accepted);
  const gateFailed = !!(result.readiness && result.readiness.ok === false);
  return {
    reason: gateFailed ? 'task_not_completed' : 'task_completed',
    memorySource: 'auto_consolidation',
    source: gateFailed
      ? (result.readiness && result.readiness.reason) || 'task_not_completed'
      : isPlanRun && reviewAccepted
        ? 'plan-completed'
        : 'task-completed',
    userText: String(opts.userText || ''),
    assistantText: String(result.content || ''),
    trace: Array.isArray(result.trace) ? result.trace : [],
    sessionId,
    runId: String(result.runId || opts.runId || ''),
    workspacePath: String(opts.workspacePath || result.workspacePath || '').trim(),
    model: String(opts.model || ''),
    apiConfig: opts.apiConfig || null,
    plan,
    review,
    reviewAccepted,
    isPlanRun,
    // 计划 worktree 还没应用：用户可能丢弃这些变更，等应用结果再决定写不写
    deferWorktree: !!result.deferWorktreeCleanup
  };
}

module.exports = {
  gatherPeriodicCorpus,
  runTaskMaintenance,
  finishJob,
  runPeriodicMaintenance,
  buildRunFacts
};
