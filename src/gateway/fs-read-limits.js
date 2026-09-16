'use strict';

const DEFAULT_READ_MAX_BYTES = 2 * 1024 * 1024;
const INDEX_FILE_MAX_BYTES = 2 * 1024 * 1024;
const ABSOLUTE_READ_MAX_BYTES = 16 * 1024 * 1024;

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
