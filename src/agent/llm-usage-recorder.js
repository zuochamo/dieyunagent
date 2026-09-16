'use strict';

/** @type {((usage: object, model?: string) => void) | null} */
let recorder = null;

function setLlmUsageRecorder(fn) {
  recorder = typeof fn === 'function' ? fn : null;
}

function recordLlmUsage(usage, model) {
  if (!usage || typeof recorder !== 'function') return;
  try {
    recorder(usage, model);
  } catch {
    // ignore
  }
}

module.exports = { setLlmUsageRecorder, recordLlmUsage };
