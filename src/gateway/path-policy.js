'use strict';

const path = require('path');

/**
 * @param {string} p
 * @param {string[]} allowedRoots 已 resolve 的根路径
 */
function assertAllowedPath(p, allowedRoots) {
  const resolved = path.resolve(p);
  const win = process.platform === 'win32';
  const norm = (x) => {
    const n = path.normalize(x);
    return win ? n.toLowerCase() : n;
  };
  const target = norm(resolved);
  const sep = path.sep;
  for (const root of allowedRoots) {
    const r = norm(path.resolve(root));
    if (target === r || target.startsWith(r + sep)) {
      return resolved;
    }
  }
  const err = new Error('路径不在白名单内');
  err.code = 'PATH_NOT_ALLOWED';
  throw err;
}

module.exports = { assertAllowedPath };
