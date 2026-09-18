'use strict';
// @ts-check

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

/** 结构信号：路径 / 选区 / @Codebase / 产物 — 不用意图词表，不另打分级 LLM */
function inferTaskTierFromStructure(input = {}) {
  const userText = String(input.userText || '');
  const suggestedFiles = uniquePaths([
    ...(input.pathHints || []),
    input.editorPath,
    input.artifactPath
  ]);
  const codebaseMention = !!input.codebaseMention;
  const short = userText.trim().length > 0 && userText.trim().length <= 240;
  const scoped = suggestedFiles.length > 0 && suggestedFiles.length <= 2;
  if (scoped && short && !codebaseMention) {
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
