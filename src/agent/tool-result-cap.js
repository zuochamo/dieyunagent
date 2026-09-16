'use strict';

const { AGENT_LIMITS_DEFAULTS } = require('./agent-limits');

const DEFAULT_TOOL_RESULT_MAX = AGENT_LIMITS_DEFAULTS.toolResultMaxJson;

function resolveToolResultMaxChars(maxChars) {
  const n = Number(maxChars);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_TOOL_RESULT_MAX;
}

/**
 * 头尾都保留的截断预览。
 * 列表类工具结果的关键摘要（total / truncated / note）往往排在明细之后，
 * 只留头部会把它们整段丢掉；只留尾部又会丢掉结构。所以头尾各留一段。
 */
function tailAwarePreview(text, max) {
  const s = String(text || '');
  const tailLen = Math.min(Math.floor(max * 0.3), 4000);
  const headLen = Math.max(0, max - tailLen);
  return {
    truncated: true,
    originalChars: s.length,
    preview: s.slice(0, headLen),
    previewTail: s.slice(Math.max(0, s.length - tailLen)),
    note: 'Tool result truncated for context budget'
  };
}

function capToolResultValue(value, maxChars) {
  const max = resolveToolResultMaxChars(maxChars);
  if (value == null) return value;
  if (typeof value !== 'object') {
    const s = String(value);
    if (s.length <= max) return s;
    return `${s.slice(0, max)}\n…（工具结果已截断，原文 ${s.length} 字符）`;
  }
  let json = '';
  try {
    json = JSON.stringify(value);
  } catch {
    return tailAwarePreview(String(value), max);
  }
  if (json.length <= max) return value;
  return tailAwarePreview(json, max);
}

function capDelegateResults(results, maxChars) {
  return (Array.isArray(results) ? results : []).map((row) => {
    if (!row || typeof row !== 'object') return row;
    if (row.error) return row;
    return { ...row, result: capToolResultValue(row.result, maxChars) };
  });
}

module.exports = {
  DEFAULT_TOOL_RESULT_MAX,
  tailAwarePreview,
  capToolResultValue,
  capDelegateResults
};
