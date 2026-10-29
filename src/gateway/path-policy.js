'use strict';

const path = require('path');

/** 远程共享临时目录：构建产物 / 截图 / 一次性脚本的常规落点。 */
const REMOTE_SHARED_TMP_ROOT = '/tmp';

/**
 * 去掉尾部分隔符（盘符根 `C:\` 保留分隔符，否则 `C:` 会变成「该盘当前目录」）。
 * **只做这一步**：不转成正斜杠、不 normalize —— 路径方言由调用方决定
 * （桌面端是 POSIX 远端路径，daemon 是它自己的本机路径）。
 */
function trimRoot(p) {
  const s = String(p || '').trim();
  if (/^[A-Za-z]:[\\/]*$/.test(s)) return `${s.slice(0, 2)}\\`;
  const cut = s.replace(/[\\/]+$/, '');
  return cut === '' ? '/' : cut;
}

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

/**
 * 远程可用根（**单一来源**，桌面端与远端 daemon 都用这一份）：
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
 * 放在 `gateway/path-policy.js` 是因为远端 daemon 的 pack 里有这个文件、没有 `ssh/`；
 * 两侧各写一份就必然漂移（远端只认工作空间单根时，桌面端往 HOME 兜底目录写会被拒）。
 *
 * **这里没有「完全放开」开关，是故意的**：设置页的 danger-full-access 是**本地机器**的档位，
 * 远端 daemon 无从得知；桌面端若在远端侧放宽，同一操作就会「SFTP 能写、RPC 被 daemon 拒」。
 * 远端一律按这一份规则。
 *
 * @param {string} workspaceRoot
 * @param {string} [homeDir] 远程 HOME 绝对路径（同步缓存值，见 ssh/session-manager.getHomeDir）
 * @returns {string[]} 绝对根，首个恒为工作空间根（不做方言转换：调用方各自 normalize）
 */
function remoteAllowedRoots(workspaceRoot, homeDir) {
  const roots = [trimRoot(workspaceRoot || '/')];
  const home = trimRoot(homeDir);
  if (home !== '/' && !roots.includes(home)) roots.push(home);
  if (!roots.includes(REMOTE_SHARED_TMP_ROOT)) roots.push(REMOTE_SHARED_TMP_ROOT);
  return Array.from(new Set(roots));
}

module.exports = { assertAllowedPath, remoteAllowedRoots, REMOTE_SHARED_TMP_ROOT };
