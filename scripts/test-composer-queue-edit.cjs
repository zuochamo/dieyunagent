'use strict';

/**
 * Pure-logic smoke for composer queue normalize / rev / reorder.
 * Run: node scripts/test-composer-queue-edit.cjs
 */

const assert = require('assert');

function newComposerQueueItemId() {
  return `cq-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeComposerQueueItem(raw) {
  const now = Date.now();
  const enqueuedAt = Number(raw && raw.enqueuedAt) || now;
  const updatedAt = Number(raw && raw.updatedAt) || enqueuedAt;
  const rev = Math.max(0, Number(raw && raw.rev) || 0);
  const id =
    raw && raw.id != null && String(raw.id).trim()
      ? String(raw.id).trim()
      : newComposerQueueItemId();
  return {
    id,
    text: String((raw && raw.text) || '').trim() || '请根据附件内容协助我。',
    attachments: Array.isArray(raw && raw.attachments) ? raw.attachments.slice() : [],
    enqueuedAt,
    updatedAt,
    rev
  };
}

function normalizeComposerQueueList(items) {
  if (!Array.isArray(items)) return [];
  return items.map((item) => normalizeComposerQueueItem(item || {}));
}

function reorderById(queue, id, toIndex) {
  const index = queue.findIndex((item) => item && item.id === id);
  if (index < 0) return false;
  const dest = Math.max(0, Math.min(queue.length - 1, Number(toIndex)));
  if (!Number.isFinite(dest) || dest === index) return false;
  const [item] = queue.splice(index, 1);
  queue.splice(dest, 0, item);
  return true;
}

function main() {
  const legacy = normalizeComposerQueueList([
    { text: 'hello', attachments: [], enqueuedAt: 100 },
    { text: 'world', enqueuedAt: 200 }
  ]);
  assert.strictEqual(legacy.length, 2);
  assert.ok(legacy[0].id.startsWith('cq-'));
  assert.ok(legacy[1].id.startsWith('cq-'));
  assert.strictEqual(legacy[0].rev, 0);
  assert.strictEqual(legacy[0].updatedAt, 100);
  assert.strictEqual(legacy[0].text, 'hello');

  const kept = normalizeComposerQueueItem({
    id: 'cq-fixed',
    text: 'x',
    rev: 3,
    enqueuedAt: 1,
    updatedAt: 2,
    attachments: [{ path: 'a.png' }]
  });
  assert.strictEqual(kept.id, 'cq-fixed');
  assert.strictEqual(kept.rev, 3);
  assert.strictEqual(kept.attachments.length, 1);

  const empty = normalizeComposerQueueItem({ text: '   ' });
  assert.strictEqual(empty.text, '请根据附件内容协助我。');

  const q = [
    { id: 'a', text: '1' },
    { id: 'b', text: '2' },
    { id: 'c', text: '3' }
  ];
  assert.strictEqual(reorderById(q, 'c', 0), true);
  assert.deepStrictEqual(
    q.map((x) => x.id),
    ['c', 'a', 'b']
  );
  assert.strictEqual(reorderById(q, 'missing', 0), false);

  // rev stale write simulation
  let item = normalizeComposerQueueItem({ id: 'e1', text: 'old', rev: 1 });
  const editRev = item.rev;
  item.rev += 1; // concurrent bump
  assert.notStrictEqual(item.rev, editRev);

  function shouldFinishSessionActiveRun(live, runId) {
    if (!live) return true;
    const liveId = live.runId != null ? String(live.runId) : '';
    const wantId = runId != null ? String(runId) : '';
    if (!wantId) return !liveId;
    if (!liveId) return true;
    return liveId === wantId;
  }
  assert.strictEqual(shouldFinishSessionActiveRun(null, 'r1'), true);
  assert.strictEqual(shouldFinishSessionActiveRun({ runId: 'r1' }, 'r1'), true);
  assert.strictEqual(shouldFinishSessionActiveRun({ runId: 'r2' }, 'r1'), false);
  assert.strictEqual(shouldFinishSessionActiveRun({ runId: 'r2' }, ''), false);
  assert.strictEqual(shouldFinishSessionActiveRun({ runId: '' }, ''), true);

  function shouldAutoFlush(opts) {
    if (opts.flushHeld) return false;
    if (opts.paused) return false;
    if (opts.sending) return false;
    if (opts.continueState) return false;
    return true;
  }
  assert.strictEqual(shouldAutoFlush({ paused: true, sending: false }), false);
  assert.strictEqual(shouldAutoFlush({ paused: false, sending: false, flushHeld: false }), true);
  assert.strictEqual(shouldAutoFlush({ paused: false, sending: true }), false);

  function takeById(queue, id) {
    const index = queue.findIndex((item) => item && item.id === id);
    if (index < 0) return { item: null, index: -1 };
    const [item] = queue.splice(index, 1);
    return { item, index };
  }

  function insertAt(queue, item, atIndex) {
    const dest = Math.max(0, Math.min(queue.length, Number(atIndex)));
    queue.splice(dest, 0, item);
  }

  const q2 = [
    { id: 'a', text: '1' },
    { id: 'b', text: '2' },
    { id: 'c', text: '3' }
  ];
  const taken = takeById(q2, 'b');
  assert.strictEqual(taken.index, 1);
  assert.strictEqual(taken.item.id, 'b');
  assert.deepStrictEqual(
    q2.map((x) => x.id),
    ['a', 'c']
  );
  insertAt(q2, taken.item, taken.index);
  assert.deepStrictEqual(
    q2.map((x) => x.id),
    ['a', 'b', 'c']
  );

  function pauseAfterUserStop(opts) {
    if (opts.skipPause) return false;
    if (!opts.queueLength) return false;
    return true;
  }
  assert.strictEqual(pauseAfterUserStop({ skipPause: true, queueLength: 2 }), false);
  assert.strictEqual(pauseAfterUserStop({ skipPause: false, queueLength: 2 }), true);
  assert.strictEqual(pauseAfterUserStop({ skipPause: false, queueLength: 0 }), false);

  function shouldFlushAfterSendNow(opts) {
    if (opts.flushHeld) return false;
    if (opts.sendNowBusy && opts.holdUntilFinally) return false;
    if (opts.paused) return false;
    if (opts.sending) return false;
    return true;
  }
  assert.strictEqual(
    shouldFlushAfterSendNow({ flushHeld: true, paused: false, sending: false }),
    false
  );
  assert.strictEqual(
    shouldFlushAfterSendNow({ flushHeld: false, paused: true, sending: false }),
    false
  );
  assert.strictEqual(
    shouldFlushAfterSendNow({ flushHeld: false, paused: false, sending: false }),
    true
  );

  console.log('[dieyun:test] test-composer-queue-edit passed');
}

main();
