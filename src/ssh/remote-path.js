'use strict';

const path = require('path');
const { normalizeRemotePath } = require('../workspace/target');

/** 远程共享临时目录：构建产物 / 截图 / 一次性脚本的常规落点。 */
const REMOTE_SHARED_TMP_ROOT = '/tmp';

function stripSshUriPath(input) {
  const s = String(input || '').trim();
  const m = s.match(/^ssh:(?:\/\/)?[^@/]+@[^/:]+(?::\d+)?(\/.*)?$/i);
  return m ? m[1] || '/' : s;
}

/**
 * 远程可用根（**单一来源**）：
 *   1. 工作空间根（相对路径基准）；
 *   2. 远程 HOME 整棵——含 `<HOME>/.dieyun/workspace` 这个与本地对称的兜底目录，
 *      以及用户自己的其它工程/脚本目录；
 *   3. `/tmp`——构建产物、截图、一次性脚本的常规落点。
 *
 * 原因：远程只绑工作空间单根时，"中途截个图 / 落个临时文件 / 跑个不在工作空间里的脚本"
 * 都会吃 PATH_NOT_ALLOWED，连落脚点都没有。本地默认 workspace 是恒定可用的
 * （见 gateway/server.js `_collectReadRoots`），远程这次取同一宽松档位。
 *
 * 仍未放开的：`/`（除工作空间与 HOME 外的系统目录）、`/etc`、其它用户目录。
 * homeDir 拿不到（未连接 / 服务端不认 realpath）时退化为「工作空间根 + /tmp」。
 *
 * @param {string} workspaceRoot
 * @param {string} [homeDir] 远程 HOME 绝对路径（同步缓存值，见 ssh/session-manager.getHomeDir）
 * @param {{ unrestricted?: boolean }} [opts] `unrestricted` = 设置页「完全放开路径限制」（默认关）
 * @returns {string[]} 已 normalize 的绝对根，首个恒为工作空间根
 */
function remoteAllowedRoots(workspaceRoot, homeDir, opts = {}) {
  if (opts.unrestricted === true) return ['/'];
  const roots = [normalizeRemotePath(workspaceRoot || '/')];
  const home = String(homeDir || '').trim().replace(/\\/g, '/').replace(/\/+$/, '');
  if (home && home !== '/') {
    const h = normalizeRemotePath(home);
    if (h !== '/' && !roots.includes(h)) roots.push(h);
  }
  if (!roots.includes(REMOTE_SHARED_TMP_ROOT)) roots.push(REMOTE_SHARED_TMP_ROOT);
  return Array.from(new Set(roots));
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
  REMOTE_SHARED_TMP_ROOT,
  remoteAllowedRoots,
  resolveRemotePath,
  shellQuoteSingle
};
