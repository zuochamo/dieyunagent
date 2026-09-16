'use strict';

/**
 * 协议级取消：run-cancel-registry + core-bridge.abortPending（无需真实 dieyun-core）
 */
const assert = require('assert');
const {
  ensureRunAbortController,
  getRunAbortSignal,
  isRunAborted,
  abortRun,
  abortSessionRuns,
  clearRunAbortController
} = require('../src/agent/run-cancel-registry');

function testRegistry() {
  const runId = `run-${Date.now()}`;
  const sessionId = `sess-${Date.now()}`;
  const ac = ensureRunAbortController(runId, sessionId);
  assert.ok(ac);
  assert.strictEqual(isRunAborted(runId), false);
  assert.ok(getRunAbortSignal(runId));
  assert.strictEqual(abortRun(runId), true);
  assert.strictEqual(isRunAborted(runId), true);
  assert.ok(getRunAbortSignal(runId).aborted);

  const runId2 = `${runId}-b`;
  ensureRunAbortController(runId2, sessionId);
  const aborted = abortSessionRuns(sessionId);
  assert.ok(aborted.includes(runId2));
  assert.strictEqual(isRunAborted(runId2), true);

  clearRunAbortController(runId);
  clearRunAbortController(runId2);
  console.log('[dieyun:test] run-cancel-registry ok');
}

function testAbortPendingLogic() {
  // 轻量模拟 pending Map 行为（与 core-bridge 同规则）
  const pending = new Map();
  pending.set(1, { runId: 'r1', method: 'agent.loop.continue', rejected: false });
  pending.set(2, { runId: 'r2', method: 'agent.loop.tool_results', rejected: false });
  pending.set(3, { runId: null, method: 'core.ping', rejected: false });

  function abortPending({ runId, ids }) {
    const idSet =
      Array.isArray(ids) && ids.length
        ? new Set(ids.map((x) => Number(x)).filter((n) => Number.isFinite(n)))
        : null;
    if (!runId && !idSet) return { abortedIds: [] };
    const abortedIds = [];
    for (const [id, entry] of [...pending.entries()]) {
      const matchId = idSet ? idSet.has(id) : false;
      const matchRun = !!(runId && entry.runId && entry.runId === runId);
      const shouldAbort = idSet && runId ? matchId || matchRun : idSet ? matchId : matchRun;
      if (!shouldAbort) continue;
      pending.delete(id);
      entry.rejected = true;
      abortedIds.push(id);
    }
    return { abortedIds };
  }

  const a = abortPending({ runId: 'r1' });
  assert.deepStrictEqual(a.abortedIds, [1]);
  assert.strictEqual(pending.has(1), false);
  assert.strictEqual(pending.has(2), true);

  const b = abortPending({ ids: [3] });
  assert.deepStrictEqual(b.abortedIds, [3]);
  assert.strictEqual(pending.has(3), false);

  console.log('[dieyun:test] abortPending match rules ok');
}

testRegistry();
testAbortPendingLogic();
console.log('[dieyun:test] test-run-cancel-protocol passed');
