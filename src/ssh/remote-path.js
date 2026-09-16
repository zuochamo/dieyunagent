'use strict';

const path = require('path');
const { normalizeRemotePath } = require('../workspace/target');

function stripSshUriPath(input) {
  const s = String(input || '').trim();
  const m = s.match(/^ssh:(?:\/\/)?[^@/]+@[^/:]+(?::\d+)?(\/.*)?$/i);
  return m ? m[1] || '/' : s;
}

function resolveRemotePath(input, remoteRoot, defaultCwd) {
  let p = stripSshUriPath(input).replace(/\\/g, '/');
  if (!p) {
    const err = new Error('路径必填');
    err.code = 'INVALID_PATH';
    throw err;
  }
  p = p.replace(/^["']+|["']+$/g, '');
  const root = normalizeRemotePath(remoteRoot || '/');
  if (!path.posix.isAbsolute(p)) {
    const base = normalizeRemotePath(defaultCwd || root);
    p = path.posix.join(base, p);
  }
  const safe = normalizeRemotePath(p);
  if (safe !== root && !safe.startsWith(`${root}/`)) {
    const err = new Error('路径不在远程工作空间内');
    err.code = 'PATH_NOT_ALLOWED';
    throw err;
  }
  return safe;
}

function shellQuoteSingle(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

module.exports = {
  resolveRemotePath,
  shellQuoteSingle
};
