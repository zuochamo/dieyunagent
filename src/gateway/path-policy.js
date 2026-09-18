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
    // 根目录（C:\ 或 /）本身已以分隔符结尾，再拼一个 sep 会得到 C:\\ 或 //，
    // 导致根目录下的文件无法 startsWith 而被误判为越界
    const prefix = r.endsWith(sep) ? r : r + sep;
    if (target === r || target.startsWith(prefix)) {
      return resolved;
    }
  }
  const err = new Error('路径不在白名单内');
  err.code = 'PATH_NOT_ALLOWED';
  throw err;
}

module.exports = { assertAllowedPath };
