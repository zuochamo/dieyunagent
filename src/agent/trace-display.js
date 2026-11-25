'use strict';

/**
 * 回放用的「展示态」trace 整形（唯一实现）。
 *
 * 为什么需要：思考区回放时，每条历史 assistant 回合都要取一份**整份** trace
 * （`agent.trace_get`），首屏窗口最多 32 次；而其中一大半字段**收起状态根本用不到**。
 * 全库实测（501 行 / 58.7MB）：
 *   `tool.result` 11.5%、`tool.toolArgs` 9.9%（界面只读 `filePath`，占 0.1%）、
 *   `tool.args` 2.4%、`diff.beforeText/afterText` 12.1%、普通回合的 `fullThought` 27.9%。
 *
 * 展示态保留什么：
 * - 结构与摘要：`round/phase/label/subagentId/checkpointId/isolated/answerPhase/visibleContent`；
 * - `thought`（短版原文，摘要行按它渲染）原样保留；
 * - `fullThought` 只留前 `thoughtHeadChars` 字并打 `fullThoughtTruncated`（+ 原长度）——
 *   用户展开这一轮时由渲染层换完整态补上（`renderer/agent/trace-store.js#upgradeAgentTraceRecord`）；
 * - 工具行：`name/argsBrief/summary/pending/failed/imagePaths/error` + `toolArgs.filePath`
 *   + `diff` 的统计与片段；被裁掉正文的 diff 保留空串并打 `textTrimmed`
 *   （空串而不是删键：`toolDiffHasBody` 用它判断「这一行要不要出现」，
 *   删了键会让「查看 diff · +N -M」这一行整块消失 —— 那是改变界面，不是省流量）；
 * - `isolated`（子 Agent 卡片）**不裁思考与嵌套轮次**：卡片默认展开，裁了当场就变样。
 *
 * 铁律：**只给回放看**。任何要把 trace 写回账本、或参与判定的调用方（例如
 * `trace-store.js#recoverInterruptedAssistantTurn` 会把取到的 trace 落库）必须取完整态。
 */

/** 工具行里纯粹是"搬运成本"、界面从来不读的字段 */
const TOOL_DROP_FIELDS = ['result', 'args'];

function isNonEmptyString(v) {
  return typeof v === 'string' && v !== '';
}

/** @returns {{ tool: object, trimmed: boolean }} */
function trimToolForDisplay(tool) {
  if (!tool || typeof tool !== 'object') return { tool, trimmed: false };
  let trimmed = false;
  const out = { ...tool };
  for (const key of TOOL_DROP_FIELDS) {
    if (key in out) {
      delete out[key];
      trimmed = true;
    }
  }
  if (out.toolArgs && typeof out.toolArgs === 'object') {
    const filePath = out.toolArgs.filePath;
    if (filePath == null || filePath === '') {
      delete out.toolArgs;
      trimmed = true;
    } else if (Object.keys(out.toolArgs).length > 1) {
      out.toolArgs = { filePath };
      trimmed = true;
    }
  }
  const diff = out.diff;
  if (diff && typeof diff === 'object' && diff.textTrimmed !== true) {
    if (isNonEmptyString(diff.beforeText) || isNonEmptyString(diff.afterText)) {
      out.diff = { ...diff, beforeText: '', afterText: '', textTrimmed: true };
      trimmed = true;
    } else if ('beforeText' in diff || 'afterText' in diff) {
      // 本来就没有正文：留着空串（`toolDiffHasBody` 判断用），不必带标记
      out.diff = { ...diff };
    }
  }
  return { tool: out, trimmed };
}

function trimNestedRoundForDisplay(round, stats) {
  if (!round || typeof round !== 'object') return round;
  if (!Array.isArray(round.tools)) return round;
  const tools = round.tools.map((t) => {
    const r = trimToolForDisplay(t);
    if (r.trimmed) stats.fields += 1;
    return r.tool;
  });
  return { ...round, tools };
}

function trimEntryForDisplay(entry, headChars, stats) {
  if (!entry || typeof entry !== 'object') return entry;
  const out = { ...entry };
  if (Array.isArray(entry.tools)) {
    out.tools = entry.tools.map((t) => {
      const r = trimToolForDisplay(t);
      if (r.trimmed) stats.fields += 1;
      return r.tool;
    });
  }
  if (Array.isArray(entry.rounds)) {
    out.rounds = entry.rounds.map((r) => trimNestedRoundForDisplay(r, stats));
  }
  // 子 Agent 卡片默认展开 → 思考正文必须原样给
  if (!entry.isolated && headChars > 0 && typeof entry.fullThought === 'string') {
    const full = entry.fullThought;
    if (full.length > headChars) {
      out.fullThought = full.slice(0, headChars);
      out.fullThoughtTruncated = true;
      out.fullThoughtChars = full.length;
      stats.thoughts += 1;
    }
  }
  return out;
}

/**
 * @param {object} row `agent.trace_get` 返回的行（`{ trace: [...] }`）
 * @param {{ thoughtHeadChars?: number }} [opts]
 * @returns {object} 新行；不修改入参（缓存 / 落库方可能还在用它）
 */
function shapeTraceForDisplay(row, opts = {}) {
  if (!row || typeof row !== 'object') return row;
  if (!Array.isArray(row.trace) || !row.trace.length) return row;
  const headChars = Math.max(0, Math.floor(Number(opts.thoughtHeadChars) || 0));
  const stats = { thoughts: 0, fields: 0 };
  const trace = row.trace.map((entry) => trimEntryForDisplay(entry, headChars, stats));
  return {
    ...row,
    trace,
    displayShape: { thoughtHeadChars: headChars, truncatedThoughts: stats.thoughts, trimmedFields: stats.fields }
  };
}

module.exports = { shapeTraceForDisplay, trimToolForDisplay };
