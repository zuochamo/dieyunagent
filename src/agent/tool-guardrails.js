'use strict';

const { getAgentLimits, resolveContextTierIdForNode } = require('./agent-limits');
const shared = require('./guardrails-shared');

function resolveTierId(userDataPath, contextTierId, model) {
  if (contextTierId) return String(contextTierId);
  if (model) return resolveContextTierIdForNode(userDataPath, model);
  return 'default';
}

function apiFor(userDataPath, contextTierId, model) {
  const tierId = resolveTierId(userDataPath, contextTierId, model);
  return shared.createGuardrailApi(() => getAgentLimits(userDataPath, tierId));
}

module.exports = {
  ...shared,
  shouldBlockRepeatToolCall(name, args, history, limit, userDataPath, contextTierId, model) {
    return apiFor(userDataPath, contextTierId, model).shouldBlockRepeatToolCall(name, args, history, limit);
  },
  recordToolCallFingerprint(history, name, args, userDataPath, contextTierId, model) {
    return apiFor(userDataPath, contextTierId, model).recordToolCallFingerprint(history, name, args);
  },
  repeatToolBlockMessage(name, argsBrief, userDataPath, contextTierId, model, limit) {
    return apiFor(userDataPath, contextTierId, model).repeatToolBlockMessage(name, argsBrief, limit);
  }
};
