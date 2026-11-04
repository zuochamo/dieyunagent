'use strict';

/**
 * 记忆归纳（knowledge maintenance）—— **Main / Node 侧唯一实现**。
 *
 * 曾经的实现散在 Renderer 两处（`renderer-knowledge-maintainer.js` 的 unified 版 +
 * `renderer-agent-llm.js` 的 legacy 版），带来三个问题：
 *   1. 长期 Agent 状态机（定时器 / 队列 / 冷却 / 重试）写在 Renderer，窗口一关就停摆；
 *   2. 同一职责两份 prompt、两份 project/global 判定，靠 `typeof X === 'function'` 选路；
 *   3. 门闩是「文本长度 >= 8 或 有任何工具轨迹」，几乎恒真，等于每个成功轮次一次小模型调用。
 *
 * 现在**触发与执行都在本模块**（Renderer 只剩设置页 UI）。Main 的三个运行入口跑完各调一次
 * `afterAgentRun({ result, opts })`：
 *   1. `agent:run`（对话，`src/main/ipc/agent-runtime.js`）；
 *   2. `agent:planner-run`（计划模式，planner 管线结果）；
 *   3. `runPlanAgentLoop`（定时计划 / 目标任务，`src/plans/plan-agent-runner.js`）。
 * 事实（trace / plan / review / 正文）本来就在 Main —— 于是手机端、定时计划、计划模式
 * 也会沉淀（以前只有 Renderer 收尾路径会归纳，这些轮次永远不沉淀）。
 *
 * 计划 worktree 的「应用后才归纳」也在本模块暂存（`pending` + `knowledgePlanApplyWaitMs`）：
 * Renderer 只在用户采纳/放弃时回一句结论（`resolvePending`），不再把上下文和兜底定时器
 * 放在窗口里 —— 窗口关掉、切会话都不会丢。
 *
 * 分层约定（AGENTS.md）：
 *   - 记忆数据真相源仍是 Rust `memory.*` RPC，本模块只经 Gateway `invokeRpc` 读写；
 *   - 项目记忆只能进 `.dieyun/memory.md`（`project-memory-file.js` 唯一实现），不往库里塞 scope 文本；
 *   - LLM 端点与请求头一律走 `llm-request.js`，这里不拼 URL、不写 Authorization；
 *   - 数字上限一律走 `agent-limits.js`（`knowledge*` 一组），本文件不存字面量；
 *   - 「哪些工具算写文件」用 `guardrails-shared.js` 的 `FILE_WRITE_TOOL_NAMES`，不写第二份正则。
 */

const fs = require('fs');
const path = require('path');

const { chatCompletionJson } = require('../llm-proxy');
const { buildLlmHeadersFromConfig, resolveLlmEndpoint } = require('./llm-request');
const { getAgentLimits } = require('./agent-limits');
const shared = require('./guardrails-shared');
// 「这次工具调用算不算失败」的单一来源（传输层 error / result.ok === false / host_exec 非 0 退出码）。
// 这里以前自带一份 `/失败|error/i.test(tool.summary)`：那是从**给人看的摘要文案**里猜成败，
// 工具输出里本来就常出现 error/失败 字样（比如 grep 命中一行 `error`），会把成功调用记成失败。
const { toolFailed } = require('./completion-readiness');
// AGENTS.md 的体积上限只有一个来源：`agents-md.js` 的 `MAX_FILE_CHARS`（剪裁/校验都用它）。
const { MAX_FILE_CHARS: AGENTS_MD_FILE_MAX_CHARS } = require('../agents-md');
const { executeAgentsMdProposeMain } = require('./propose-tools-main');
const { loadModelSettings, resolveTextApiConfig } = require('../model-settings');

/** 归纳设置落盘文件名（userData 下；与 agents-md-prefs.json 同级） */
const KNOWLEDGE_SETTINGS_FILE = 'knowledge-maintenance.json';

/** 定时档位只允许这三档（设置页 tab 与这里同源） */
const KNOWLEDGE_INTERVAL_CHOICES = Object.freeze([6, 12, 24]);

const KNOWLEDGE_MODES = Object.freeze(['off', 'idle', 'on']);

/**
 * scope 分流规则 + 项目条目的落点。两个 prompt（完整 / 收尾）共用同一份：
 * 项目记忆是仓库里的文件而不是库，写法要按「人也会读」来要求。
 */
const PROJECT_MEMORY_FILE_RULE =
  '与工作空间架构/约定/常用命令/目录结构相关的事实标 scope=project，其余标 scope=global。' +
  'scope=project 的条目会写进仓库里的 .dieyun/memory.md（人可读、可手改、会随仓库提交）：' +
  '一行一句短陈述、自包含（不写「上面说的那样」），不要写密钥/口令/隐私（这类只能用 scope=global）。\n';

const UNIFIED_KNOWLEDGE_SCHEMA = `只输出 JSON，不要 Markdown 包裹或额外说明。格式：
{
  "memories": [{"content":"…","kind":"normal|private|secret","importance":1-5,"scope":"global|project"}],
  "archive_memory_ids": ["记忆id"],
  "agents_updates": [{"section":"commands","action":"append|merge|replace","anchor":"merge 时填已有条目的开头片段","content":"- …","confidence":0.9}]
}`;

/**
 * 同主题合并的唯一可执行路径（merge + anchor）。
 *
 * 不给这条引导，后台归纳器只会 append —— 实测某项目文件在一天内被加了 20 条，
 * 其中 CameraCut 同主题重复两次，直接把文件顶到 24000 上限、要靠人工压。
 * 措辞与 `tool-catalog.js` 的 agents_md_propose 描述保持一致。
 */
const AGENTS_MERGE_RULE =
  '   **同主题已有条目要合并，不要追加第二条**：用 action:"merge" + anchor' +
  '（已有条目的开头片段，如 "**CameraCut"），content 写合并后的完整条目；' +
  '确实没有同主题条目时才用 action:"append"；整段重写用 action:"replace"。\n';

/**
 * 给归纳器一个体积感。没有这句，它不知道自己在往一个快写满的文件里塞东西，
 * 于是照旧 append（实测正是这条路径把文件顶到 24000）。
 */
function agentsPressureNote(content, maxChars) {
  const len = String(content || '').length;
  const limit = Number(maxChars) || AGENTS_MD_FILE_MAX_CHARS;
  if (len < limit * 0.75) return '';
  return `\n⚠ 当前已约 ${len} 字（上限 ${limit}，接近写满）：本次 agents_updates 只做合并（merge），不要 append 新增条目。`;
}

/**
 * 归纳器 system prompt。两种形态：
 *   - fullPeriodic：定时完整归纳（输入是「近期对话 + 已有记忆 + AGENTS.md」语料）；
 *   - 默认：一轮任务收尾（输入含 plan/验收/工具/变更）。
 */
function buildKnowledgeSystemPrompt(opts = {}) {
  const { fullPeriodic, agentsEnabled } = opts;
  if (fullPeriodic) {
    let boundary =
      '你是叠云 Agent 的定时知识归纳器。根据输入中的对话与已有知识，合并去重、提炼稳定事实，并建议归档过时记忆。' +
      UNIFIED_KNOWLEDGE_SCHEMA +
      '【写入边界】\n' +
      '1. memories：可复用事实/偏好/密钥（标 kind）；不要寒暄与无结论过程。\n' +
      '2. ' +
      PROJECT_MEMORY_FILE_RULE +
      '3. archive_memory_ids：仅填输入里给出的过时/重复记忆 id。\n';
    if (agentsEnabled) {
      boundary +=
        '4. agents_updates：稳定命令/目录/规范/坑点短列表；section=overview|structure|commands|conventions|testing|architecture|gotchas。\n' +
        AGENTS_MERGE_RULE;
    } else {
      boundary += '4. 本次未启用 AGENTS.md 维护：agents_updates 必须为空数组。\n';
    }
    return `${boundary}5. 只写「未来任务仍会用到」的内容，不要复述本轮做了什么。`;
  }
  const agentsLine = agentsEnabled
    ? '4. agents_updates：稳定命令/目录/规范/坑点短列表；section=overview|structure|commands|conventions|testing|architecture|gotchas。\n' +
      AGENTS_MERGE_RULE
    : '4. 本次未启用 AGENTS.md 维护：agents_updates 必须为空数组。\n';
  return (
    '你是叠云 Agent 的知识归纳器。根据输入中的任务、结果、工具轨迹与文件变更，提炼稳定可复用的记忆，' +
    '并按需要提出 AGENTS.md 更新。' +
    UNIFIED_KNOWLEDGE_SCHEMA +
    '【写入边界】\n' +
    '1. memories：可复用事实/偏好/密钥（标 kind）；不要寒暄与无结论过程。\n' +
    '2. ' +
    PROJECT_MEMORY_FILE_RULE +
    '3. 只写「未来任务仍会用到」的内容，不要复述本轮做了什么。\n' +
    agentsLine
  );
}

// ---------------------------------------------------------------------------
// 设置（userData/knowledge-maintenance.json —— Main 侧唯一真相源）
// ---------------------------------------------------------------------------

function defaultKnowledgeSettings() {
  return {
    mode: 'on',
    intervalHours: 6,
    scopes: { recentChat: true, longMemory: true, projectMemory: true, agents: true },
    lastRunAt: 0,
    lastRunOk: null,
    lastRunSummary: ''
  };
}

function normalizeKnowledgeSettings(raw) {
  const base = defaultKnowledgeSettings();
  if (!raw || typeof raw !== 'object') return base;
  if (KNOWLEDGE_MODES.includes(raw.mode)) base.mode = raw.mode;
  const hours = Number(raw.intervalHours);
  if (KNOWLEDGE_INTERVAL_CHOICES.includes(hours)) base.intervalHours = hours;
  if (raw.scopes && typeof raw.scopes === 'object') {
    for (const key of Object.keys(base.scopes)) {
      if (typeof raw.scopes[key] === 'boolean') base.scopes[key] = raw.scopes[key];
    }
  }
  if (Number.isFinite(Number(raw.lastRunAt))) base.lastRunAt = Number(raw.lastRunAt);
  if (raw.lastRunOk === true || raw.lastRunOk === false) base.lastRunOk = raw.lastRunOk;
  if (typeof raw.lastRunSummary === 'string') base.lastRunSummary = raw.lastRunSummary.slice(0, 240);
  return base;
}

function knowledgeSettingsPath(userData) {
  const dir = String(userData || '').trim();
  if (!dir) return '';
  return path.join(dir, KNOWLEDGE_SETTINGS_FILE);
}

function readKnowledgeSettings(userData) {
  const fp = knowledgeSettingsPath(userData);
  if (!fp) return defaultKnowledgeSettings();
  try {
    return normalizeKnowledgeSettings(JSON.parse(fs.readFileSync(fp, 'utf8')));
  } catch {
    return defaultKnowledgeSettings();
  }
}

/**
 * 把 patch 合进当前设置。**非法字段一律忽略、不重置既有值** ——
 * 之前的实现用「默认值 + patch 再 normalize」，patch 里一个拼错的 mode 就会把
 * 用户已存的设置整体打回默认，设置页的偶发写错会直接改坏配置。
 */
function applyKnowledgeSettingsPatch(current, patch) {
  const next = normalizeKnowledgeSettings(current);
  const p = patch && typeof patch === 'object' ? patch : {};
  if (KNOWLEDGE_MODES.includes(p.mode)) next.mode = p.mode;
  const hours = Number(p.intervalHours);
  if (KNOWLEDGE_INTERVAL_CHOICES.includes(hours)) next.intervalHours = hours;
  if (p.scopes && typeof p.scopes === 'object') {
    for (const key of Object.keys(next.scopes)) {
      if (typeof p.scopes[key] === 'boolean') next.scopes[key] = p.scopes[key];
    }
  }
  if (Number.isFinite(Number(p.lastRunAt))) next.lastRunAt = Number(p.lastRunAt);
  if (p.lastRunOk === true || p.lastRunOk === false) next.lastRunOk = p.lastRunOk;
  if (typeof p.lastRunSummary === 'string') next.lastRunSummary = p.lastRunSummary.slice(0, 240);
  return next;
}

function writeKnowledgeSettings(userData, patch) {
  const next = applyKnowledgeSettingsPatch(readKnowledgeSettings(userData), patch);
  const fp = knowledgeSettingsPath(userData);
  if (!fp) return next;
  try {
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  } catch (err) {
    console.warn('[dieyun:memory] knowledge settings write failed:', err && (err.message || err));
  }
  return next;
}

// ---------------------------------------------------------------------------
// 信号与门闩（触发侧只提供事实，判定在这里）
// ---------------------------------------------------------------------------

function compactPlain(value, max) {
  return String(value == null ? '' : value)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, Number(max) || 360);
}

function summarizeTrace(trace, limit) {
  const lines = [];
  for (const entry of Array.isArray(trace) ? trace : []) {
    for (const tool of entry.tools || []) {
      if (tool.pending) continue;
      const brief = tool.argsBrief ? ` ${tool.argsBrief}` : '';
      lines.push(`- ${tool.name || 'tool'}${brief}: ${compactPlain(tool.summary || '', 180)}`);
    }
  }
  return lines.slice(0, Number(limit) || 28).join('\n');
}

/**
 * trace 里一次工具调用的目标文件路径（写文件工具一次只写一个文件）。
 *
 * 与 Renderer 的 `artifactPathFromTool` 同义，但 Main 侧只要 `filePath`/`path` 两个字段，
 * 不引入 Renderer 的产物状态机。取不到就当没有（变更清单宁可少一条，也不编）。
 */
function toolPathOf(tool) {
  if (!tool || typeof tool !== 'object') return '';
  const args = tool.toolArgs && typeof tool.toolArgs === 'object' ? tool.toolArgs : null;
  const result = tool.result && typeof tool.result === 'object' ? tool.result : null;
  const candidates = [
    args && args.filePath,
    args && args.path,
    tool.filePath,
    tool.path,
    result && result.path,
    result && result.filePath
  ];
  for (const c of candidates) {
    const p = String(c || '').trim();
    if (p) return p;
  }
  return '';
}

/**
 * 把「这一轮发生了什么」压成归纳器输入信号。
 * 全部是**结构事实**（工具名/退出状态/变更文件/plan 步骤），不含寒暄关键词判定。
 */
function collectKnowledgeSignals(input, limits = {}) {
  const trace = Array.isArray(input && input.trace) ? input.trace : [];
  const execLines = [];
  let writeCount = 0;
  // 变更路径优先用显式上报的（计划应用后的 appliedPaths / 变更行），没有再按 trace 里
  // 写文件工具的入参路径推导 —— Renderer 不再上报 changes，Main 自己就能算。
  const changedPaths = new Map();
  for (const c of (Array.isArray(input && input.changes) ? input.changes : []).slice(0, 14)) {
    const p = String((c && (c.relativePath || c.path)) || '').trim();
    if (p) changedPaths.set(p, (c && c.source) || '');
  }
  for (const entry of trace) {
    for (const tool of entry.tools || []) {
      if (tool.pending) continue;
      const norm = shared.normalizeAgentToolName(tool.name, tool.toolArgs);
      const toolName = String((norm && norm.name) || tool.name || '')
        .trim()
        .toLowerCase();
      const failed = toolFailed(tool, toolName);
      if (toolName === 'host_exec') {
        // 只收成功的命令当「这一轮跑过什么」的证据；失败与否看结构化退出码，不看输出里写没写 error
        if (!failed) execLines.push(`- ${tool.argsBrief || 'host_exec'} → ${compactPlain(String(tool.summary || ''), 140)}`);
      }
      // 「哪些工具算写文件」只看 guardrails-shared 的单一来源，这里不写第二份工具名正则
      if (shared.FILE_WRITE_TOOL_NAMES.has(toolName) && !failed) {
        writeCount += 1;
        const p = toolPathOf(tool);
        if (p && changedPaths.size < 14 && !changedPaths.has(p)) changedPaths.set(p, toolName);
      }
    }
  }
  const changes = [...changedPaths.entries()].map(
    ([p, src]) => `- ${p}${src ? ` (${src})` : ''}`
  );
  const plan = input && input.plan;
  const planSteps = plan && (Array.isArray(plan.subtasks) ? plan.subtasks : Array.isArray(plan.tasks) ? plan.tasks : []);
  const planSummary = (planSteps || [])
    .slice(0, 12)
    .map((t, i) => `${i + 1}. ${compactPlain(t.title || t.id || '', 120)}`)
    .join('\n');
  return {
    userText: compactPlain(input && input.userText, 1400),
    assistantText: compactPlain(input && input.assistantText, 1800),
    toolTrace: summarizeTrace(trace, limits.knowledgeTraceLinesMax || 28),
    changes: changes.join('\n'),
    execLines: execLines.slice(0, 10).join('\n'),
    writeCount,
    planSummary,
    reviewNotes: compactPlain(input && input.review && input.review.notes, 600),
    appliedPaths: (Array.isArray(input && input.appliedPaths) ? input.appliedPaths : [])
      .slice(0, 12)
      .join('\n')
  };
}

/**
 * 该不该跑归纳。**唯一判定点**（Renderer 不再自带一份）。
 *
 * 老门闩是「userText.length >= 8 或 任何 toolTrace」，实测几乎恒真——每个成功轮次都会
 * 多打一次小模型调用。现在的口径：
 *   - 有结构证据（工具轨迹 / 文件变更 / 成功命令 / plan 步骤）→ 跑；
 *   - 纯文字轮次：用户需求与答复都要够长（`knowledgeMinUserChars` / `knowledgeMinReplyChars`）。
 *
 * 只服务「一轮任务收尾」这一种形态：定时归纳走的是自己的语料判空
 * （`runPeriodicMaintenance` 里的 `stripped`），不吃这个门闩 —— 曾经为此留过一个
 * `periodicOnly` 分支，生产路径从未调用，等于死代码。
 */
function shouldRunKnowledgeMaintenance({ signals, limits = {} }) {
  const s = signals || {};
  if (s.toolTrace || s.changes || s.execLines || s.planSummary) return true;
  const minUser = Number(limits.knowledgeMinUserChars) || 40;
  const minReply = Number(limits.knowledgeMinReplyChars) || 20;
  return s.userText.length >= minUser && s.assistantText.length >= minReply;
}

/**
 * 记忆 scope 只允许两个值：`project` / `global` —— 这里的枚举就是**唯一来源**
 * （`UNIFIED_KNOWLEDGE_SCHEMA` 里已经写死同样的两值，提示词另有 `PROJECT_MEMORY_FILE_RULE`
 * 说明怎么选，所以「选哪个」是模型的判断，不是代码的判断）。
 *
 * 本函数只做**结构校验**：不在枚举里的一律落 `global`，不再用中英文词表去猜
 * （曾经的 `/project|workspace|repo|项目|工程|仓库/` 会把模型的自由文本 scope 强行改写成
 * project —— 那是拿词表推翻模型已经做出的判断，且把它推进「写仓库文件」这条泄露边界：
 * kind=secret 的项目条目会被 `filterEntriesForFile` 丢弃，等于静默丢记忆）。
 * 落 global 不会丢：条目仍进 SQLite，只是不再进 `.dieyun/memory.md`。
 */
const MEMORY_SCOPES = Object.freeze(['global', 'project']);
/** 记忆 kind 的枚举（同样只是校验，判断归模型；Rust 侧 `detect_memory_kind` 只做兜底）。 */
const MEMORY_KINDS = Object.freeze(['normal', 'private', 'secret']);

function normalizeMemoryScope(raw) {
  const v = String(raw || '')
    .trim()
    .toLowerCase()
    .slice(0, 40);
  return MEMORY_SCOPES.includes(v) ? v : 'global';
}

function parseKnowledgeJson(text) {
  const raw = String(text || '').trim();
  if (!raw) return { memories: [], agents_updates: [], archive_memory_ids: [] };
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1].trim() : raw;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) return { memories: [], agents_updates: [], archive_memory_ids: [] };
  let json = {};
  try {
    json = JSON.parse(body.slice(start, end + 1)) || {};
  } catch {
    return { memories: [], agents_updates: [], archive_memory_ids: [] };
  }
  const rawMemories = Array.isArray(json.memories) ? json.memories : Array.isArray(json.items) ? json.items : [];
  const memories = rawMemories
    .map((item) => ({
      content: compactPlain(item.content || item.memory || item.text || '', 420),
      kind: MEMORY_KINDS.includes(String(item.kind || '').toLowerCase())
        ? String(item.kind).toLowerCase()
        : undefined,
      importance: Math.min(5, Math.max(1, Number(item.importance) || 3)),
      scope: normalizeMemoryScope(item.scope)
    }))
    .filter((item) => item.content && item.content.length >= 8)
    .slice(0, 8);
  const agents_updates = Array.isArray(json.agents_updates)
    ? json.agents_updates
    : Array.isArray(json.updates)
      ? json.updates
      : [];
  const archive_memory_ids = (Array.isArray(json.archive_memory_ids) ? json.archive_memory_ids : [])
    .map((id) => String(id || '').trim())
    .filter(Boolean)
    .slice(0, 24);
  return { memories, agents_updates, archive_memory_ids };
}

// ---------------------------------------------------------------------------
// 写入（全部经 Gateway → Rust memory.*）
// ---------------------------------------------------------------------------

function formatMemoryRowsForPrompt(rows, label) {
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length) return `【${label}】\n无`;
  const lines = list.slice(0, 28).map((r) => `- id=${r.id != null ? r.id : r.memoryId} · ${compactPlain(r.content || '', 220)}`);
  return `【${label}】\n${lines.join('\n')}`;
}

async function applyMemoryItems(ctx, items, opts = {}) {
  const wsPath = String(opts.workspacePath || '').trim();
  const source = opts.source || 'auto_consolidation';
  const max = Number(opts.maxItems) || 8;
  // 写入溯源：任务级归纳知道自己是哪个会话；定时归纳跨会话，用 jobId 记账（不编造 sessionId）。
  const sessionId = String(opts.sessionId || '').trim();
  const metadata = opts.metadata && typeof opts.metadata === 'object' ? opts.metadata : undefined;
  let saved = 0;
  let merged = 0;
  let skipped = 0;
  /** 本轮真正落进用户级库的条目 → 归纳结束后镜像到共享库（跨机） */
  const shareable = [];
  for (const item of (items || []).slice(0, max)) {
    // 落点只由 scope 决定（scope 已在 parseKnowledgeJson 归一成 project / global），
    // importance 只是排序权重，不参与选通道。
    // 曾写成 `|| importance >= 4`：于是「scope=global 的密钥条」被抢进项目文件，
    // 又被 filterEntriesForFile 按「文件会进版本库」丢弃 —— 库里和文件里都没有，
    // 静默丢记忆且只记一次 skipped。泄露边界是不变式，重要性不能改写它。
    const useProject = !!wsPath && item.scope === 'project';
    try {
      // 项目记忆写文件（唯一真相）；用户级记忆写 SQLite（写入侧策略在 Rust 的
      // memory.long_add 唯一实现：近重复合并 / 低价值闸）。这里只按事实计数。
      if (useProject) {
        const fileRes = await appendProjectMemoryToFile(ctx, [item], wsPath);
        if (fileRes.added) saved += 1;
        else if (fileRes.duplicate) merged += 1;
        else skipped += 1;
        continue;
      }
      const res = await ctx.invokeRpc('memory.long_add', {
        content: item.content,
        source,
        kind: item.kind,
        // 走到这里的只可能是用户级：项目级已经进文件，库里不再有第二种 scope 写法
        scope: 'global',
        importance: item.importance,
        sessionId: sessionId || undefined,
        metadata
      });
      if (res && res.skipped) skipped += 1;
      else if (res && res.duplicate) merged += 1;
      else saved += 1;
      // 上传的是「这轮新写进库的正文」，与本地库同一条：不额外记 id，靠 content_hash 幂等
      if (!(res && res.skipped)) {
        shareable.push({ content: item.content, kind: item.kind, importance: item.importance, source });
      }
    } catch (err) {
      console.warn('[dieyun:memory] memory add failed:', err && (err.message || err));
    }
  }
  const shared = await mirrorShareable(ctx, shareable);
  return { saved, merged, skipped, shared };
}

/**
 * 把本机新写入的用户级记忆**镜像**到共享库（跨机）。
 *
 * 三条边界：
 * 1. 只上传「能离开本机」的条目 —— 判定复用 `project-memory-file.js#isShareableKind`
 *    （与写 `.dieyun/memory.md` 同一口径：secret / private 永不出本机）；
 * 2. 只上传用户级（global）记忆：项目记忆的真相是仓库文件，跨机共享会变成「别人的项目结论」；
 * 3. 失败只记日志：共享库挂掉不该影响本地记忆与归纳结果（fail-open）。
 */
async function mirrorShareable(ctx, items) {
  const list = Array.isArray(items) ? items : [];
  const sm = ctx.sharedMemory;
  if (!list.length) return { ok: true, uploaded: 0, skipped: 0 };
  if (!sm || typeof sm.mirrorItems !== 'function' || !sm.active()) {
    return { ok: false, reason: 'inactive', uploaded: 0, skipped: list.length };
  }
  const kept = list.filter((it) => projectMemoryFile.isShareableKind(it.kind));
  const dropped = list.length - kept.length;
  if (!kept.length) return { ok: true, uploaded: 0, skipped: dropped };
  try {
    const res = await sm.mirrorItems(kept, { scope: 'global' });
    return { ...res, skipped: (Number(res && res.skipped) || 0) + dropped };
  } catch (err) {
    console.warn('[dieyun:memory] shared memory upload failed:', err && (err.message || err));
    return { ok: false, error: err && (err.message || String(err)), uploaded: 0, skipped: dropped };
  }
}

async function applyArchiveMemoryIds(ctx, ids, knownMemoryIds) {
  let n = 0;
  for (const id of ids || []) {
    const memoryId = Number(id);
    if (!Number.isFinite(memoryId) || memoryId <= 0) continue;
    // 只允许归档「本次语料里出现过的 id」，模型编不出库里没有的行
    if (knownMemoryIds && knownMemoryIds.size && !knownMemoryIds.has(String(memoryId))) continue;
    try {
      await ctx.invokeRpc('memory.long_status_set', { memoryId, status: 'archived' });
      n += 1;
    } catch {
      // 归档失败不影响其余写入
    }
  }
  return n;
}

/**
 * AGENTS.md 更新 → 走 Main 侧既有 propose 通道（唯一实现，含 off / draft-only / 预览三态）。
 * 预览态会写 `.dieyun/agents-pending.json`，Renderer 已有读取路径。
 */
async function applyAgentsUpdates(ctx, updates, workspacePath, source) {
  const prefs = ctx.readAgentsMdPrefs();
  if (!workspacePath || prefs.mode === 'off' || !Array.isArray(updates) || !updates.length) {
    return { applied: 0 };
  }
  let applied = 0;
  let pending = false;
  let draft = false;
  for (const u of updates.slice(0, 6)) {
    const section = String(u.section || '').trim();
    const content = String(u.content || '').trim();
    if (!section || !content) continue;
    try {
      const res = await executeAgentsMdProposeMain(
        ctx.gateway,
        {
          section,
          action: String(u.action || 'append').trim() || 'append',
          anchor: u.anchor ? String(u.anchor).trim() : undefined,
          content,
          confidence: Number(u.confidence),
          reason: '',
          workspaceRoot: workspacePath
        },
        { workspacePath, sessionId: ctx.sessionId || '' },
        ctx.userData
      );
      if (res && res.error) continue;
      applied += Number(res && res.applied) || 0;
      pending = pending || !!(res && res.pending);
      draft = draft || !!(res && res.draft);
      if (res && (res.pending || res.draft)) break; // 预览/草稿只做一次，别叠多个待采纳项
    } catch (err) {
      console.warn('[dieyun:memory] agents.md update failed:', err && (err.message || err));
    }
  }
  return { applied, pending, draft, source };
}

// ---------------------------------------------------------------------------
// 语料收集（定时归纳：不依赖任何 Renderer 状态）
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 项目记忆文件（唯一真相）读写
// ---------------------------------------------------------------------------

const projectMemoryFile = require('./project-memory-file');
const { projectWorkspacePath } = require('../workspace/target');

/**
 * 文件 IO 归属哪个工作空间：归纳语料带 `payload.workspacePath` 时以它为准。
 *
 * 必须先剥 worktree 后缀（`projectWorkspacePath` 与项目记忆 scope 同一口径）：
 * 多 agent 并行时 payload 里可能是临时 worktree，写进去的 memory.md 会随 worktree 删除而丢，
 * 而项目记忆本来就该落在项目根（换会话、换 worktree 都读同一份）。
 */
function projectFileCtx(ctx, workspacePath) {
  const root = projectWorkspacePath(workspacePath || ctx.workspacePath || '');
  if (!root || root === ctx.workspacePath) return ctx;
  return Object.assign({}, ctx, { workspacePath: root });
}

async function readProjectMemoryText(ctx) {
  return readWorkspaceText(ctx, projectMemoryFile.PROJECT_MEMORY_REL_PATH, 96000);
}

async function writeProjectMemoryText(ctx, text) {
  await ctx.invokeRpc('fs.write_file', {
    filePath: projectMemoryFile.PROJECT_MEMORY_REL_PATH,
    data: String(text || ''),
    encoding: 'utf8',
    ...(ctx.workspacePath ? { runWorkspaceRoot: ctx.workspacePath } : {})
  });
}

/**
 * 把条目并进 `<workspace>/.dieyun/memory.md`。
 *
 * 项目记忆的写入终点就是这里：不再往 SQLite 里塞项目行 —— 库里写进去的项目记忆没人看得见、
 * 改不动、也删不掉。secret / private 一律丢弃（文件会进版本库）。
 */
async function appendProjectMemoryToFile(ctx, items, workspacePath) {
  const target = projectFileCtx(ctx, workspacePath);
  const { kept, dropped } = projectMemoryFile.filterEntriesForFile(items);
  if (!kept.length) return { added: 0, duplicate: 0, dropped };
  const before = await readProjectMemoryText(target);
  const existing = projectMemoryFile.parseProjectMemoryEntries(before);
  const beforeKeys = new Set(existing.map(projectMemoryFile.entryKey));
  const merged = projectMemoryFile.mergeProjectMemoryEntries(existing, kept);
  const fresh = kept.filter((e) => !beforeKeys.has(projectMemoryFile.entryKey(e))).length;
  if (fresh) {
    await writeProjectMemoryText(target, projectMemoryFile.renderProjectMemoryFile(merged));
  }
  return { added: fresh, duplicate: kept.length - fresh, dropped };
}

/**
 * 一次性材料化：旧版本把项目记忆写在 SQLite 里（注入只给 8 条，等于藏起来）。
 * 文件还不存在时，把库里高价值的项目行搬进文件 —— 之后注入只读文件，库里的行退化为
 * 「历史残留」，由内存衰减自然归档。
 */
async function materializeProjectMemoryFile(ctx, limits) {
  if (!ctx.workspacePath) return { seeded: 0 };
  const target = projectFileCtx(ctx);
  const existingText = await readProjectMemoryText(target);
  if (projectMemoryFile.parseProjectMemoryEntries(existingText).length) return { seeded: 0 };
  let rows = [];
  try {
    // 用「scope + 最近」而不是语义召回：材料化要的是这个项目历史上写过的全部条目，
    // 不是与某句话最像的几条（语义召回还需要 embedding，冷启动时常常直接返回空）。
    const scopeRes = await ctx.invokeRpc('memory.project_scope', { workspacePath: target.workspacePath });
    const scope = scopeRes && scopeRes.scope;
    if (scope) {
      const res = await ctx.invokeRpc('memory.long_recent', {
        limit: Math.max(40, Number(limits && limits.knowledgeCorpusMemoryRows) || 24),
        scope
      });
      rows = Array.isArray(res) ? res : (res && res.results) || [];
    }
  } catch {
    rows = [];
  }
  const items = rows
    .filter((r) => String((r && r.kind) || 'normal').toLowerCase() === 'normal')
    .filter((r) => Number((r && r.importance) || 3) >= 3)
    .map((r) => ({ content: r.content, kind: r.kind }));
  if (!items.length) return { seeded: 0 };
  const res = await appendProjectMemoryToFile(ctx, items, target.workspacePath);
  return { seeded: res.added };
}

async function readWorkspaceText(ctx, relPath, maxBytes) {
  try {
    const r = await ctx.invokeRpc('fs.read_file', {
      filePath: relPath,
      encoding: 'utf8',
      maxBytes: Number(maxBytes) || 96000,
      ...(ctx.workspacePath ? { runWorkspaceRoot: ctx.workspacePath } : {})
    });
    if (!r || r.encoding === 'base64') return '';
    return String(r.data || '');
  } catch {
    return '';
  }
}

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
// LLM 调用（端点/头唯一来源 llm-request.js）
// ---------------------------------------------------------------------------

function resolveLlmCall(ctx, payload, limits) {
  const model = String((payload && payload.model) || '').trim();
  const cfg = (payload && payload.apiConfig) || {};
  let baseUrl = String(cfg.baseUrl || '').trim();
  let apiKey = cfg.apiKey;
  let headers = cfg.headers;
  let authMode = cfg.authMode;
  let userAgent = cfg.userAgent;
  let modelId = model;
  if (!baseUrl) {
    // 定时归纳没有 Renderer 会话：用设置页的默认文本模型（与定时计划同一条解析）
    const text = resolveTextApiConfig(loadModelSettings(ctx.userData));
    baseUrl = String(text.baseUrl || '').trim();
    apiKey = text.apiKey;
    headers = text.headers;
    authMode = text.authMode;
    userAgent = text.userAgent;
    modelId = modelId || String(text.model || '').trim();
  }
  if (!baseUrl || !modelId) return null;
  const url = resolveLlmEndpoint(baseUrl, 'chat');
  if (!url) return null;
  const head = buildLlmHeadersFromConfig({
    apiKey,
    authMode,
    headers,
    userAgent,
    model: modelId,
    sessionId: ctx.sessionId || ''
  });
  return { url, headers: head, model: modelId, timeoutMs: Number(limits.knowledgeTimeoutMs) || 65000 };
}

/**
 * 一次归纳请求。`fetch` 默认是 Main 的 `chatCompletionJson`；
 * 测试可注入替身（与 session-title 的 `opts.fetchTitleOnce` 同一手法）。
 */
async function callLlm(llm, body, fetch) {
  const doFetch = typeof fetch === 'function' ? fetch : chatCompletionJson;
  const child = new AbortController();
  const timer = setTimeout(() => {
    try {
      child.abort();
    } catch {
      // ignore
    }
  }, llm.timeoutMs);
  try {
    return await doFetch(llm.url, {
      headers: llm.headers,
      body: JSON.stringify(body),
      signal: child.signal
    });
  } finally {
    clearTimeout(timer);
  }
}

function extractContent(raw) {
  if (typeof raw === 'string') return raw;
  if (raw && typeof raw.content === 'string') return raw.content;
  const choice = raw && Array.isArray(raw.choices) ? raw.choices[0] : null;
  const msg = (choice && choice.message) || {};
  return msg.content != null ? String(msg.content) : '';
}

// ---------------------------------------------------------------------------
// 共享记忆（跨机 PostgreSQL）的提炼
// ---------------------------------------------------------------------------

/**
 * 提炼用的提示词。输出格式**复用归纳器同一套 JSON**（`memories` / `archive_memory_ids`），
 * 因此解析不用第二份：`parseKnowledgeJson` 就是唯一实现。
 *
 * 为什么提炼放在这里而不是 `src/memory-shared`：记忆提炼本来就只有这一个实现
 * （模型调用、端点与请求头也在这个模块的 `resolveLlmCall`/`callLlm`）。数据层只管
 * 「谁抢到锁、候选是谁、结果怎么落库」，不重复写 prompt 与 LLM 传输。
 */
const SHARED_CONSOLIDATE_SYSTEM = [
  '你是局域网共享记忆库的整理员。多台机器的 Agent 会把各自的记忆条目上传到这里。',
  '你的任务：把下面这批条目里**重复 / 近重复 / 过度琐碎**的合并，其余保持原样。',
  '规则：',
  '1. 不编造原文没有的信息；合并后的一句话要能独立看懂（不依赖别的条目）。',
  '2. 只合并确实同义的条目；不确定就不要合并 —— 少合并远好于错合并。',
  '3. 保留具体的路径、命令、约定、版本号；删掉「已解决」「已完成」这类一次性过程信息。',
  '4. 被合并掉的原始条目 id 全部列进 archive_memory_ids；没有被合并的条目不要出现在里面。',
  '只输出 JSON，不要 Markdown 包裹或额外说明。格式：',
  '{"memories":[{"content":"合并后的知识点（一行，<=200 字）","kind":"normal","scope":"global","importance":1-5}],',
  ' "archive_memory_ids":[1,2,3]}',
  '如果这批条目里没有任何值得合并的内容，输出 {"memories":[],"archive_memory_ids":[]}。'
].join('\n');

/**
 * 共享记忆提炼：抢锁 → 取候选 → 模型合并 → 落库 → 记录台账。
 *
 * 抢不到锁（别的机器正在提炼）或还在冷却期就**直接返回**，不排队、不重试 ——
 * 这是唯一需要的调度，不再有 master/slave 模式与「现在就提炼」的授权密码。
 */
async function runSharedMemoryConsolidation(ctx, trigger) {
  const sm = ctx.sharedMemory;
  if (!sm || typeof sm.claimConsolidation !== 'function' || !sm.active()) {
    return { ok: false, reason: 'inactive' };
  }
  const limits = ctx.limits() || {};
  const claim = await sm.claimConsolidation(trigger || 'scheduled', {
    // 冷却期的缺省值只在 agent-limits 里有一份，这里不再写死 6 小时
    minIntervalMs: Number(limits.sharedMemoryConsolidateIntervalMs)
  });
  if (!claim) return { ok: false, reason: 'locked_or_cooldown' };

  let scanned = 0;
  let model = '';
  try {
    const rows = await sm.listConsolidationCandidates(claim);
    scanned = rows.length;
    // 少于 3 条没有合并意义（本次仍记台账，冷却期从这里起算）
    if (rows.length < 3) {
      await sm.releaseConsolidation(claim, { scanned });
      return { ok: true, scanned, merged: 0, created: 0 };
    }
    const llm = resolveLlmCall(ctx, {}, limits);
    if (!llm) throw new Error('未配置可用的文本模型');
    model = llm.model;
    const lines = rows.map(
      (r) =>
        `- id=${r.id} · 重要度${Number(r.importance).toFixed(2)} · 被召回${r.accessCount}次 · ${compactPlain(r.content, 400)}`
    );
    const body = {
      model: llm.model,
      temperature: 0.2,
      max_tokens: Number(limits.knowledgeMaxTokens) || 2800,
      messages: [
        { role: 'system', content: SHARED_CONSOLIDATE_SYSTEM },
        {
          role: 'user',
          content: `以下是共享记忆库里的 ${rows.length} 条条目（来自局域网多台机器）：\n\n${lines.join('\n')}`
        }
      ]
    };
    const text = extractContent(await callLlm(llm, body, ctx.fetchChatCompletion));
    const parsed = parseKnowledgeJson(text);
    // 只允许归档「本次候选里出现过的 id」：模型编不出库里没有的行
    const known = new Set(rows.map((r) => String(r.id)));
    const mergedIds = (parsed.archive_memory_ids || []).filter((id) => known.has(String(id)));
    const created = (parsed.memories || []).filter((m) => m && m.content);
    const applied = await sm.applyConsolidation(claim, { mergedIds, created });
    // 落库失败必须走失败分支：否则台账会记成「按时完成、无错误」（finished_at 有值、error 为空），
    // 跨机冷却把这一轮当成成功，设置页也会显示成「这批没有可合并的」。
    if (!applied.ok) throw new Error(applied.error || '共享记忆落库失败');
    await sm.releaseConsolidation(claim, {
      scanned,
      merged: applied.marked,
      created: applied.inserted,
      model
    });
    return { ok: true, scanned, merged: applied.marked, created: applied.inserted };
  } catch (err) {
    const msg = (err && (err.message || String(err))) || 'unknown';
    await sm.releaseConsolidation(claim, { scanned, model, error: msg });
    console.warn('[dieyun:memory] shared memory consolidation failed:', msg);
    return { ok: false, error: msg };
  }
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
    text = extractContent(await callLlm(llm, body, ctx.fetchChatCompletion));
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
    text = extractContent(await callLlm(llm, body, ctx.fetchChatCompletion));
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

// ---------------------------------------------------------------------------
// 调度器（Main 侧唯一定时器；队列与冷却都用 agent-limits 的数字）
// ---------------------------------------------------------------------------

/**
 * @param {{
 *   getGateway: () => any,
 *   getUserDataPath: () => string,
 *   getAgentBusy: () => boolean,
 *   notify?: (event: string, payload?: object) => void
 * }} deps
 */
function createKnowledgeMaintainer(deps) {
  const state = {
    queue: [],
    running: false,
    lastRunAt: 0,
    pumpTimer: null,
    intervalTimer: null,
    kickTimer: null,
    idleTimer: null,
    workspacePath: ''
  };

  /** @type {Map<string, {facts: object, timer: any}>} 计划 worktree 待应用期间的暂存（按会话） */
  const pending = new Map();

  const invokeRpc = async (method, params) => {
    const gateway = deps.getGateway();
    if (!gateway || typeof gateway.invokeRpc !== 'function') {
      throw new Error('Gateway 未就绪');
    }
    return gateway.invokeRpc(method, params);
  };

  const ctx = {
    get gateway() {
      return deps.getGateway();
    },
    get userData() {
      return deps.getUserDataPath();
    },
    get workspacePath() {
      return state.workspacePath;
    },
    sessionId: '',
    invokeRpc,
    /** 测试注入点：默认走 llm-proxy 的 chatCompletionJson */
    fetchChatCompletion: typeof deps.fetchChatCompletion === 'function' ? deps.fetchChatCompletion : null,
    limits: () => getAgentLimits(deps.getUserDataPath()),
    readAgentsMdPrefs: () => require('./agents-md-prefs').readAgentsMdPrefs(deps.getUserDataPath()),
    getSettings: () => readKnowledgeSettings(deps.getUserDataPath()),
    updateSettings: (patch) => {
      const next = writeKnowledgeSettings(deps.getUserDataPath(), patch);
      notify('agent:knowledge-maintenance-status', next);
      return next;
    },
    isAgentBusy: () => {
      try {
        return typeof deps.getAgentBusy === 'function' ? !!deps.getAgentBusy() : false;
      } catch {
        return false;
      }
    },
    /** 共享记忆（跨机）实例；未装配（headless / 扩展关闭）时为 null —— 调用方据此跳过 */
    get sharedMemory() {
      try {
        return typeof deps.getSharedMemory === 'function' ? deps.getSharedMemory() : null;
      } catch {
        return null;
      }
    }
  };

  function notify(event, payload) {
    try {
      if (typeof deps.notify === 'function') deps.notify(event, payload);
    } catch {
      // 通知失败不影响归纳本身
    }
  }

  function pump() {
    if (state.running || !state.queue.length) return;
    const limits = ctx.limits();
    const waitMs = (Number(limits.knowledgeMaintenanceCooldownMs) || 50000) - (Date.now() - state.lastRunAt);
    if (waitMs > 0) {
      if (state.pumpTimer) clearTimeout(state.pumpTimer);
      state.pumpTimer = setTimeout(() => {
        state.pumpTimer = null;
        pump();
      }, Math.min(waitMs + 50, 60000));
      return;
    }
    const next = state.queue.shift();
    if (!next) return;
    state.running = true;
    ctx.sessionId = String(next.sessionId || '');
    state.workspacePath = String(next.workspacePath || '').trim();
    runTaskMaintenance(ctx, next)
      .then((res) => notify('agent:knowledge-maintenance-done', { ...res, sessionId: next.sessionId }))
      .catch((err) => console.warn('[dieyun:memory] knowledge maintenance', err && (err.message || err)))
      .finally(() => {
        state.running = false;
        state.lastRunAt = Date.now();
        state.workspacePath = '';
        pump();
      });
  }

  /**
   * 任务收尾触发（`afterRun` / 计划应用结果共用）。返回是否入队，不等 LLM。
   *
   * `mode=off` 是「关掉归纳」而不是「只关定时」：曾经 off 只管定时，逐轮归纳照样
   * 每轮打一次模型，设置页写着「关闭」却还在后台花钱。
   */
  function schedule(payload = {}) {
    if (ctx.getSettings().mode === 'off') return { ok: false, reason: 'disabled' };
    const limits = ctx.limits();
    const max = Number(limits.knowledgeMaintenanceQueueMax) || 8;
    if (state.queue.length >= max) {
      return { ok: false, reason: 'queue_full' };
    }
    const minDelay = Number(limits.knowledgeMaintenanceDelayMs) || 15000;
    const maxDelay = Number(limits.knowledgeMaintenanceDelayMaxMs) || 300000;
    const delayMs = Math.min(maxDelay, Math.max(1000, Number(payload.delayMs) || minDelay));
    state.queue.push({ ...payload, delayMs });
    if (state.pumpTimer) clearTimeout(state.pumpTimer);
    state.pumpTimer = setTimeout(() => {
      state.pumpTimer = null;
      pump();
    }, delayMs);
    return { ok: true, queued: state.queue.length };
  }

  /**
   * 计划 worktree 暂存：等用户采纳/放弃（`resolvePending`）。
   * 暂存在 Main，所以切会话、关窗口都不丢；超时按「验收通过但未应用」补一次。
   */
  function armPending(facts) {
    const sid = facts.sessionId;
    const prev = pending.get(sid);
    if (prev && prev.timer) clearTimeout(prev.timer);
    const waitMs = Number(ctx.limits().knowledgePlanApplyWaitMs) || 20 * 60 * 1000;
    const timer = setTimeout(() => {
      pending.delete(sid);
      if (facts.reviewAccepted) schedule({ ...facts, source: 'plan-completed' });
    }, waitMs);
    if (timer.unref) timer.unref();
    pending.set(sid, { facts, timer });
    return { ok: true, deferred: true };
  }

  /**
   * 计划 worktree 的应用结果。Renderer 只报结论，不带上下文。
   * @param {string} sessionId
   * @param {'applied'|'no_changes'|'skipped'} outcome
   * @param {{appliedPaths?: string[]}} extra
   */
  function resolvePending(sessionId, outcome, extra = {}) {
    const sid = String(sessionId || '').trim();
    const row = sid ? pending.get(sid) : null;
    if (!row) return { ok: false, reason: 'none' };
    pending.delete(sid);
    if (row.timer) clearTimeout(row.timer);
    if (outcome === 'applied') {
      return schedule({
        ...row.facts,
        source: 'plan-worktree-applied',
        appliedPaths: Array.isArray(extra.appliedPaths) ? extra.appliedPaths : []
      });
    }
    if (outcome === 'no_changes') {
      // 非 git 工作空间 / 纯读计划：验收通过但没有待合并项，按「计划完成」整理
      return schedule({ ...row.facts, source: 'plan-completed' });
    }
    // 用户放弃应用：plan 相关的产出不写进长期记忆
    return { ok: true, dropped: true };
  }

  /**
   * 一轮 Agent 运行结束（Main 侧三个 loop 调用点的统一入口）。
   * 事实装配 → 门闩 → 立即入队 / 计划 pending / 丢弃。
   */
  function afterRun(run = {}) {
    const facts = buildRunFacts(run);
    if (!facts) return { ok: false, reason: 'no_session' };
    if (ctx.getSettings().mode === 'off') return { ok: false, reason: 'disabled' };
    const limits = ctx.limits();
    const signals = collectKnowledgeSignals(facts, limits);
    if (!shouldRunKnowledgeMaintenance({ signals, limits })) {
      maybeRunIdlePeriodic();
      return { ok: false, reason: 'skip' };
    }
    if (facts.reason === 'task_not_completed') {
      // 验收没过、且没有交付物：不把半成品写进长期记忆
      maybeRunIdlePeriodic();
      return { ok: false, reason: 'not_completed' };
    }
    if (facts.isPlanRun && !facts.reviewAccepted) {
      maybeRunIdlePeriodic();
      return { ok: false, reason: 'plan_not_accepted' };
    }
    const res = facts.deferWorktree ? armPending(facts) : schedule(facts);
    maybeRunIdlePeriodic();
    return res;
  }

  /**
   * idle 模式的「忙完补跑」。
   *
   * 老实现撞上忙碌就直接返回，下次机会是 +intervalHours（6h 后）——整天在用 Agent 的用户
   * 等于永远不归纳。这里改成：每轮收尾时检查「已过间隔且现在不忙」，是就跑；
   * 仍在忙则排一次 5 分钟后的重试（只排一次，不叠兜底层）。
   */
  function maybeRunIdlePeriodic() {
    const settings = ctx.getSettings();
    if (settings.mode === 'off') return;
    const intervalMs = Math.max(1, Number(settings.intervalHours) || 6) * 60 * 60 * 1000;
    if (settings.lastRunAt && Date.now() - settings.lastRunAt < intervalMs) return;
    if (state.running || state.queue.length) return;
    if (ctx.isAgentBusy()) {
      scheduleIdleRetry();
      return;
    }
    runPeriodic({ reason: 'idle_after_run' }).catch(() => {});
  }

  function scheduleIdleRetry() {
    if (state.idleTimer) return;
    const waitMs = Number(ctx.limits().knowledgeIdleRetryMs) || 5 * 60 * 1000;
    state.idleTimer = setTimeout(() => {
      state.idleTimer = null;
      // 还忙就交给下一轮收尾去判：定时器只重排一次，避免多层兜底互相打架
      if (ctx.isAgentBusy()) return;
      maybeRunIdlePeriodic();
    }, waitMs);
    if (state.idleTimer.unref) state.idleTimer.unref();
  }

  /** 定时归纳（Main 定时器 / 设置页「立即运行」共用）。 */
  async function runPeriodic(opts = {}) {
    if (state.running) return { ok: false, reason: 'busy' };
    state.running = true;
    // 定时运行没有 composer 会话：项目记忆与 AGENTS.md 的语料只能来自「当前工作空间」。
    // 不注入这一步，定时归纳会退化成「只整理用户级记忆」。
    if (!state.workspacePath) {
      try {
        state.workspacePath = String(
          (typeof deps.getWorkspacePath === 'function' && deps.getWorkspacePath()) || ''
        ).trim();
      } catch {
        state.workspacePath = '';
      }
    }
    try {
      const res = await runPeriodicMaintenance(ctx, opts);
      notify('agent:knowledge-maintenance-done', res);
      return res;
    } finally {
      state.running = false;
      state.lastRunAt = Date.now();
      state.workspacePath = '';
    }
  }

  function stopSchedule() {
    for (const key of ['intervalTimer', 'kickTimer', 'pumpTimer', 'idleTimer']) {
      if (state[key]) clearTimeout(state[key]);
      state[key] = null;
    }
    for (const row of pending.values()) {
      if (row && row.timer) clearTimeout(row.timer);
    }
    pending.clear();
    state.queue.length = 0;
  }

  function startSchedule(opts = {}) {
    stopSchedule();
    const settings = ctx.getSettings();
    if (settings.mode === 'off') return settings;
    const intervalMs = Math.max(1, Number(settings.intervalHours) || 6) * 60 * 60 * 1000;
    state.intervalTimer = setInterval(() => {
      runPeriodic({ reason: 'periodic' }).catch(() => {});
    }, intervalMs);
    if (state.intervalTimer.unref) state.intervalTimer.unref();
    const due = !settings.lastRunAt || Date.now() - settings.lastRunAt >= intervalMs;
    if (due || opts.reschedule) {
      state.kickTimer = setTimeout(
        () => {
          state.kickTimer = null;
          runPeriodic({ reason: 'periodic' }).catch(() => {});
        },
        opts.immediate ? 2000 : 90 * 1000
      );
      if (state.kickTimer.unref) state.kickTimer.unref();
    }
    return settings;
  }

  return {
    schedule,
    afterRun,
    resolvePending,
    runPeriodic,
    startSchedule,
    stopSchedule,
    /** 设置页「立即提炼」：抢锁后整理一次共享记忆（抢不到就返回 locked_or_cooldown） */
    consolidateSharedMemory: (trigger) => runSharedMemoryConsolidation(ctx, trigger || 'manual'),
    getSettings: () => ctx.getSettings(),
    updateSettings: (patch) => {
      const next = ctx.updateSettings(patch || {});
      startSchedule({ reschedule: true });
      return next;
    }
  };
}

// ---------------------------------------------------------------------------
// Main 侧唯一实例注册（三个 loop 调用点共用一个入口）
// ---------------------------------------------------------------------------

let activeMaintainer = null;

/** 由 `main/ipc/agent-runtime.js` 在创建实例后注册；测试可传 null 注销。 */
function registerKnowledgeMaintainer(maintainer) {
  activeMaintainer = maintainer && typeof maintainer.afterRun === 'function' ? maintainer : null;
  return activeMaintainer;
}

/**
 * 当前生效的归纳器实例（可能为 null）。
 * 唯一用途：不经过 `agent-runtime` 闭包的调用方（如扩展页签的「立即提炼」IPC）拿同一个实例 ——
 * 再 `createKnowledgeMaintainer()` 一份就会有两套队列与定时器。
 */
function getActiveKnowledgeMaintainer() {
  return activeMaintainer;
}

/**
 * 一轮 Agent 运行结束的统一入口（对话 / 计划模式对话 / 定时计划 / 子代理）。
 *
 * 归纳不是主链路：没有实例（测试、sidecar 未就绪）时静默跳过，调用方不需要判空。
 * @param {{result?: object, opts?: object}} run
 */
function afterAgentRun(run = {}) {
  if (!activeMaintainer) return { ok: false, reason: 'no_maintainer' };
  try {
    return activeMaintainer.afterRun(run);
  } catch (err) {
    return { ok: false, reason: 'error', error: err && (err.message || String(err)) };
  }
}

/**
 * 计划 worktree 的应用结果（Renderer → IPC → 这里）。outcome: applied | skipped。
 */
function resolveKnowledgePlanOutcome(sessionId, outcome, extra = {}) {
  if (!activeMaintainer) return { ok: false, reason: 'no_maintainer' };
  try {
    return activeMaintainer.resolvePending(sessionId, outcome, extra);
  } catch (err) {
    return { ok: false, reason: 'error', error: err && (err.message || String(err)) };
  }
}

module.exports = {
  KNOWLEDGE_SETTINGS_FILE,
  KNOWLEDGE_INTERVAL_CHOICES,
  KNOWLEDGE_MODES,
  buildKnowledgeSystemPrompt,
  agentsPressureNote,
  collectKnowledgeSignals,
  shouldRunKnowledgeMaintenance,
  parseKnowledgeJson,
  normalizeMemoryScope,
  buildRunFacts,
  normalizeKnowledgeSettings,
  readKnowledgeSettings,
  writeKnowledgeSettings,
  runTaskMaintenance,
  runPeriodicMaintenance,
  runSharedMemoryConsolidation,
  mirrorShareable,
  createKnowledgeMaintainer,
  registerKnowledgeMaintainer,
  getActiveKnowledgeMaintainer,
  afterAgentRun,
  resolveKnowledgePlanOutcome
};
