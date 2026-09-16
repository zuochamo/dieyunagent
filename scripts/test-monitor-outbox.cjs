'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { createStatusOutbox } = require('../src/monitor/status-outbox');

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed');
}

const mem = createStatusOutbox();
assert(mem.peek() == null, 'empty peek');
assert(mem.isPending() === false, 'empty not pending');
mem.update({ cpu: 1, tokensToday: 10 });
assert(mem.peek().cpu === 1, 'first snapshot');
mem.update({ cpu: 9, tokensToday: 20 });
assert(mem.peek().cpu === 9 && mem.peek().tokensToday === 20, 'latest-wins');
assert(mem.isPending() === true, 'update marks pending');
mem.markFlushed();
assert(mem.isPending() === false, 'flushed');
mem.update({ cpu: 3 }, { connected: true });
assert(mem.isPending() === false, 'connected update does not re-pend');
assert(mem.peek().cpu === 3, 'connected update still replaces snapshot');
mem.markDisconnected();
assert(mem.isPending() === true, 'disconnect re-pends last snapshot');
assert(mem.peek().cpu === 3, 'peek still has snapshot');
mem.markFlushed();
assert(mem.isPending() === false, 'flush clears pending');
assert(mem.peek().cpu === 3, 'flush keeps snapshot');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dieyun-outbox-'));
const persistPath = path.join(dir, 'monitor-status-outbox.json');
const disk = createStatusOutbox({ persistPath });
disk.update({ cpu: 42, hostname: 'box' });
const reloaded = createStatusOutbox({ persistPath });
assert(reloaded.peek().cpu === 42, 'persist roundtrip');
assert(reloaded.isPending() === true, 'persisted pending');
reloaded.markFlushed();
const afterFlush = createStatusOutbox({ persistPath });
assert(afterFlush.peek().cpu === 42, 'flushed payload still on disk');
assert(afterFlush.isPending() === false, 'flushed pending false on disk');

fs.rmSync(dir, { recursive: true, force: true });
console.log('test-monitor-outbox.cjs ok');
