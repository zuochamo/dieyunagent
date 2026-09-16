'use strict';

/** Renderer-only mutate queue (no CommonJS — loaded via <script> in index.html). */

/** @type {Map<string, { tail: Promise<void>, pending: number, holders: Set<string> }>} */
const mutateQueues = new Map();

function normalizeWorkspaceMutateKey(workspaceKey) {
  const key = String(workspaceKey || '__global__').trim();
  return key || '__global__';
}

function getMutateQueue(workspaceKey) {
  const key = normalizeWorkspaceMutateKey(workspaceKey);
  if (!mutateQueues.has(key)) {
    mutateQueues.set(key, { tail: Promise.resolve(), pending: 0, holders: new Set() });
  }
  return mutateQueues.get(key);
}

function runExclusive(fn, workspaceKey, holderId) {
  const q = getMutateQueue(workspaceKey);
  q.pending += 1;
  const holder = holderId != null && String(holderId).trim() ? String(holderId).trim() : '';
  if (holder) q.holders.add(holder);
  const run = q.tail.then(async () => {
    try {
      return await fn();
    } finally {
      q.pending = Math.max(0, q.pending - 1);
      if (holder) q.holders.delete(holder);
    }
  });
  q.tail = run.catch(() => {});
  return run;
}

function getWorkspaceMutatePending(workspaceKey) {
  const q = mutateQueues.get(normalizeWorkspaceMutateKey(workspaceKey));
  return q ? q.pending : 0;
}

function isWorkspaceMutateBusy(workspaceKey, excludeHolderId) {
  const q = mutateQueues.get(normalizeWorkspaceMutateKey(workspaceKey));
  if (!q || q.pending <= 0) return false;
  const exclude =
    excludeHolderId != null && String(excludeHolderId).trim()
      ? String(excludeHolderId).trim()
      : '';
  if (!exclude) return true;
  if (q.holders.size === 0) return q.pending > 0;
  for (const holder of q.holders) {
    if (holder !== exclude) return true;
  }
  return q.pending > 1;
}

function listWorkspaceMutateHolders(workspaceKey) {
  const q = mutateQueues.get(normalizeWorkspaceMutateKey(workspaceKey));
  return q ? [...q.holders] : [];
}

window.MutateQueue = {
  normalizeWorkspaceMutateKey,
  getMutateQueue,
  runExclusive,
  getWorkspaceMutatePending,
  isWorkspaceMutateBusy,
  listWorkspaceMutateHolders
};
