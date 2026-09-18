'use strict';

/**
 * 工具「是否改动工作区」判定。单一来源是 guardrails-shared.js，
 * 本文件只做再导出（Main 与 renderer bundle 都走顶层 require）。
 */
const shared = require('./guardrails-shared');

if (!shared || !shared.MUTATING_TOOL_NAMES) {
  throw new Error('guardrails-shared.js must load before tool-classify.js');
}

module.exports = {
  MUTATING_TOOLS: shared.MUTATING_TOOL_NAMES,
  isMutatingAgentTool: shared.isMutatingAgentTool
};
