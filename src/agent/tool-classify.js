(function () {
(function (root, factory) {
  const shared =
    typeof module === 'object' && module.exports
      ? require('./guardrails-shared')
      : root.GuardrailsShared || null;
  const exported = factory(shared);
  if (typeof module === 'object' && module.exports) {
    module.exports = exported;
  }
  root.DieyunToolClassify = exported;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (shared) {
  if (!shared || !shared.MUTATING_TOOL_NAMES) {
    throw new Error('guardrails-shared.js must load before tool-classify.js');
  }

  // 单一来源：guardrails-shared.js
  return {
    MUTATING_TOOLS: shared.MUTATING_TOOL_NAMES,
    isMutatingAgentTool: shared.isMutatingAgentTool
  };
});
}());
