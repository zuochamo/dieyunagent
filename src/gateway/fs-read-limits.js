'use strict';

// 三个上限的唯一来源是 assets/agent-shared.json（Rust `config.rs` 的
// default_read_max_bytes / absolute_read_max_bytes / index_file_max_bytes 读同一份）。
const SHARED = require('../agent/shared-constants');

const DEFAULT_READ_MAX_BYTES = SHARED.readLimits.defaultMaxBytes;
const INDEX_FILE_MAX_BYTES = SHARED.readLimits.indexFileMaxBytes;
const ABSOLUTE_READ_MAX_BYTES = SHARED.readLimits.absoluteMaxBytes;

/**
 * @param {{ offset?: number, maxBytes?: number }} [opts]
 */
function normalizeReadParams(opts = {}) {
  const offset = Math.max(0, Number(opts.offset) || 0);
  let maxBytes = Number(opts.maxBytes);
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) maxBytes = DEFAULT_READ_MAX_BYTES;
  maxBytes = Math.min(ABSOLUTE_READ_MAX_BYTES, Math.max(1, Math.floor(maxBytes)));
  return { offset, maxBytes };
}

module.exports = {
  DEFAULT_READ_MAX_BYTES,
  INDEX_FILE_MAX_BYTES,
  ABSOLUTE_READ_MAX_BYTES,
  normalizeReadParams
};
