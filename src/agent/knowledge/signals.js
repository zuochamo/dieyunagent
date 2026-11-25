'use strict';

/**
 * 归纳器的「输入事实 + 结构校验」：把这一轮发生了什么压成信号、判定该不该跑，
 * 以及把模型吐回来的 JSON 解析成受约束的记忆条目。
 *
 * 为什么单独一个文件：这部分此前和「设置 IO / 提示词 / 记忆落库 / 共享记忆 / 定时器」一起住在
 * `agent/knowledge-maintainer.js`（1600+ 行）里。它只依赖 guardrails 的工具名表与 `toolFailed`，
 * 与写库、调度、LLM 调用都无关，是最容易独立的一块。
 *
 * 纯搬移（2026-11-21）：逻辑一行没改，`knowledge-maintainer.js` 继续再导出被外部用到的名字。
 */

const shared = require('../guardrails-shared');
// 「这次工具调用算不算失败」的单一来源（传输层 error / result.ok === false / host_exec 非 0 退出码）。
const { toolFailed } = require('../completion-readiness');

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

module.exports = {
  MEMORY_SCOPES,
  MEMORY_KINDS,
  compactPlain,
  summarizeTrace,
  toolPathOf,
  collectKnowledgeSignals,
  shouldRunKnowledgeMaintenance,
  normalizeMemoryScope,
  parseKnowledgeJson
};
