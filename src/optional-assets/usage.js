'use strict';

/** @type {Map<string, number>} */
const refCounts = new Map();

function beginComponentUse(componentId) {
  const id = String(componentId || '').trim();
  if (!id) return;
  refCounts.set(id, (refCounts.get(id) || 0) + 1);
}

function endComponentUse(componentId) {
  const id = String(componentId || '').trim();
  if (!id) return;
  const next = (refCounts.get(id) || 0) - 1;
  if (next <= 0) refCounts.delete(id);
  else refCounts.set(id, next);
}

function isComponentInUse(componentId) {
  return (refCounts.get(String(componentId || '').trim()) || 0) > 0;
}

function getUsageSnapshot() {
  const out = {};
  for (const [id, count] of refCounts.entries()) {
    out[id] = count;
  }
  return out;
}

module.exports = {
  beginComponentUse,
  endComponentUse,
  isComponentInUse,
  getUsageSnapshot
};
