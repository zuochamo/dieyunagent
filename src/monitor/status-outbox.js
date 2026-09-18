'use strict';

const fs = require('fs');
const path = require('path');

function readPersisted(persistPath) {
  if (!persistPath) return null;
  try {
    const raw = fs.readFileSync(persistPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    if (!parsed.payload || typeof parsed.payload !== 'object') return null;
    return parsed;
  } catch {
    return null;
  }
}

function writePersisted(persistPath, state) {
  if (!persistPath) return;
  try {
    const dir = path.dirname(persistPath);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      persistPath,
      JSON.stringify({ payload: state.payload, pending: !!state.pending }),
      'utf8'
    );
  } catch {
    // ignore disk errors; memory snapshot still works
  }
}

/**
 * Latest-wins monitor status outbox.
 * Disconnects keep updating the snapshot; reconnect emits the latest payload.
 */
function createStatusOutbox(opts = {}) {
  const persistPath = opts.persistPath || null;
  const loaded = readPersisted(persistPath);
  let payload = loaded && loaded.payload ? loaded.payload : null;
  let pending = !!(loaded && loaded.pending && payload);

  function persist() {
    writePersisted(persistPath, { payload, pending });
  }

  return {
    update(next, opts = {}) {
      if (!next || typeof next !== 'object') return payload;
      payload = next;
      if (opts.connected) {
        // 已连通时调用方会直接把 payload 发出去；这里仍要落盘，否则磁盘快照
        // 会长期停留在更旧的版本（重启后补发的是过期状态）
        persist();
        return payload;
      }
      pending = true;
      persist();
      return payload;
    },
    markDisconnected() {
      if (payload) pending = true;
      persist();
    },
    markFlushed() {
      pending = false;
      persist();
    },
    peek() {
      return payload;
    },
    isPending() {
      return !!(pending && payload);
    }
  };
}

module.exports = { createStatusOutbox };
