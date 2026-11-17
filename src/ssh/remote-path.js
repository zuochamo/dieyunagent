'use strict';

const path = require('path');
const { normalizeRemotePath } = require('../workspace/target');
// 「远程可用根」的唯一实现在 gateway/path-policy.js（远端 daemon 的 pack 里也有它）。
// 这里保留 re-export，是为了不把 SSH 侧调用点改成跨层 require。
const { remoteAllowedRoots, REMOTE_SHARED_TMP_ROOT } = require('../gateway/path-policy');

function stripSshUriPath(input) {
  const s = String(input || '').trim();
  const m = s.match(/^ssh:(?:\/\/)?[^@/]+@[^/:]+(?::\d+)?(\/.*)?$/i);
  return m ? m[1] || '/' : s;
}

/**
 * @param {string} input
 * @param {string|string[]} remoteRoots 一个或多个允许根（绝对路径）
 * @param {string} [defaultCwd] 相对路径的基准（缺省取首个根）
 */
function resolveRemotePath(input, remoteRoots, defaultCwd) {
  let p = stripSshUriPath(input).replace(/\\/g, '/');
  if (!p) {
    const err = new Error('路径必填');
    err.code = 'INVALID_PATH';
    throw err;
  }
  p = p.replace(/^["']+|["']+$/g, '');
  const roots = (Array.isArray(remoteRoots) ? remoteRoots : [remoteRoots])
    .filter((r) => r != null && String(r).trim() !== '')
    .map((r) => normalizeRemotePath(r));
  if (!roots.length) {
    const err = new Error('远程工作空间根未配置');
    err.code = 'PATH_NOT_ALLOWED';
    throw err;
  }
  const root = roots[0];
  if (!path.posix.isAbsolute(p)) {
    const base = normalizeRemotePath(defaultCwd || root);
    p = path.posix.join(base, p);
  }
  const safe = normalizeRemotePath(p);
  // 根为 '/' 时前缀就是 '/'（拼 `${r}/` 会得到 '//'，导致整盘被误拒）
  const allowed = roots.some(
    (r) => safe === r || (r === '/' ? safe.startsWith('/') : safe.startsWith(`${r}/`))
  );
  if (!allowed) {
    const err = new Error('路径不在远端允许范围内');
    err.code = 'PATH_NOT_ALLOWED';
    // 远端只开放这几个根（工作区 / $HOME / /tmp 之类）。把「哪些根」直接列出来，
    // 比让模型猜「远程工作空间」到底指哪一棵有用得多；沙箱档位问的也是这些根之内的事。
    err.path = safe;
    err.roots = roots;
    err.suggestedFix = `远端只开放这些根：${roots.join('、')}。把目标放到其中一个下面；不要原样重试。`;
    throw err;
  }
  return safe;
}

function shellQuoteSingle(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

module.exports = {
  REMOTE_SHARED_TMP_ROOT,
  remoteAllowedRoots,
  resolveRemotePath,
  shellQuoteSingle
};
