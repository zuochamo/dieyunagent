// @ts-check
'use strict';

/** @typedef {'trivial' | 'normal' | 'heavy'} AgentTaskTier */
/**
 * @typedef {object} AgentTaskTierResult
 * @property {AgentTaskTier} taskTier
 * @property {string} reason
 * @property {boolean} readyToWrite
 * @property {string[]} suggestedFiles
 * @property {false} useFastPath
 * @property {'structure'} source
 */

const TASK_TIERS = ['trivial', 'normal', 'heavy'];

function uniquePaths(list, max = 6) {
  const out = [];
  const seen = new Set();
  for (const raw of list || []) {
    const p = String(raw || '').trim().replace(/\\/g, '/');
    if (!p || seen.has(p)) continue;
    seen.add(p);
    out.push(p);
    if (out.length >= max) break;
  }
  return out;
}

function isTaskTierFeatureEnabled() {
  /** @type {any} */
  const g = globalThis;
  if (typeof g.getAgentLimits !== 'function') return true;
  try {
    return g.getAgentLimits().taskTierEnabled !== false;
  } catch {
    return true;
  }
}

/**
 * 结构信号：路径 / 选区 / 产物 / @Codebase — 不用意图词表，不另打分级 LLM。
 *
 * 「trivial」的判据只有一条：用户已经把目标限定到 **1~2 个具体文件**（路径提示 / 编辑器选区 /
 * 产物），且没有 `@Codebase` 这种「整个仓库范围」的信号。以前还有一条
 * `userText.trim().length <= 240` 的**字数**门槛：字数既不说明改动范围，也会让「附了一个文件
 * + 一段长需求」被判成小改而跳过自动 codebase 检索（docs/AGENT-STRATEGY.md §4.1 的结构信号
 * 清单里本来也没有字数）。
 */
function inferTaskTierFromStructure(input = {}) {
  const suggestedFiles = uniquePaths([
    ...(input.pathHints || []),
    input.editorPath,
    input.artifactPath
  ]);
  const codebaseMention = !!input.codebaseMention;
  const scoped = suggestedFiles.length > 0 && suggestedFiles.length <= 2;
  if (scoped && !codebaseMention) {
    return {
      taskTier: 'trivial',
      reason: '路径或编辑器选区已限定，按小 diff 处理',
      readyToWrite: true,
      suggestedFiles,
      useFastPath: false,
      source: 'structure'
    };
  }
  return {
    taskTier: 'normal',
    reason: '',
    readyToWrite: false,
    suggestedFiles,
    useFastPath: false,
    source: 'structure'
  };
}

function skipAutoCodebaseForTaskTier(result, enabled) {
  const on = enabled == null ? isTaskTierFeatureEnabled() : !!enabled;
  if (!on) return false;
  if (!result || result.taskTier !== 'trivial') return false;
  return result.readyToWrite === true || (result.suggestedFiles && result.suggestedFiles.length > 0);
}

function formatTaskTierSystemBlock(result) {
  if (!result || !result.taskTier) return '';
  const files = (result.suggestedFiles || []).slice(0, 6);
  const lines = [`【任务分级 · ${result.taskTier}】`];
  if (result.reason) lines.push(result.reason);
  if (files.length) lines.push('建议文件：' + files.join('、'));
  return lines.join('\n');
}

const taskTierApi = {
  TASK_TIERS,
  inferTaskTierFromStructure,
  skipAutoCodebaseForTaskTier,
  formatTaskTierSystemBlock,
  isTaskTierFeatureEnabled
};

module.exports = taskTierApi;
