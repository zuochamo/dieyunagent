'use strict';

const { applyEditFromArgs, normalizeEditArgs } = require('./str-replace');
const { ABSOLUTE_READ_MAX_BYTES } = require('./fs-read-limits');

function missingFileResult(err, extra) {
  return {
    ok: false,
    error: err && err.message ? String(err.message) : '文件不存在或无法读取',
    errorCode: err && err.code ? String(err.code) : 'FS_EDIT_MISSING_FILE',
    suggestedFix: '确认路径存在；新建文件请用 fs_write_file',
    ...(extra || {})
  };
}

/**
 * Shared fs.edit_file body. Callers supply read/write ops (local Gateway or remote host).
 * @param {object} raw
 * @param {{
 *   readUtf8: (filePath: string, maxBytes: number) => Promise<{ data?: string, truncated?: boolean }>,
 *   writeUtf8: (filePath: string, data: string) => Promise<object>,
 *   extra?: object
 * }} ops
 */
async function runEditFile(raw, ops) {
  const args = normalizeEditArgs(raw || {});
  if (!args.filePath || !String(args.filePath).trim()) {
    const e = new Error('fs.edit_file 缺少 filePath');
    e.code = 'FS_EDIT_MISSING_PATH';
    throw e;
  }
  let before = null;
  let truncated = false;
  try {
    const read = await ops.readUtf8(args.filePath, ABSOLUTE_READ_MAX_BYTES);
    if (read && typeof read === 'object') {
      before = read.data != null ? String(read.data) : null;
      truncated = !!read.truncated;
    }
  } catch (err) {
    return missingFileResult(err, ops.extra);
  }
  if (before == null) {
    return missingFileResult(null, ops.extra);
  }
  if (truncated) {
    return {
      ok: false,
      error: '文件超过可编辑大小上限',
      errorCode: 'FS_EDIT_TOO_LARGE',
      suggestedFix: '对该文件改用 fs_write_file，或先缩小文件',
      ...(ops.extra || {})
    };
  }
  const applied = applyEditFromArgs(before, args);
  if (!applied.ok) return { ...applied, ...(ops.extra || {}) };
  const written = await ops.writeUtf8(args.filePath, applied.text);
  return {
    ...written,
    replacements: applied.replacements,
    operation: 'edit'
  };
}

module.exports = { runEditFile };
