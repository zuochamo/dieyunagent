'use strict';

const path = require('path');

const { dieyunUserHome } = require('../agent-home');
const { isForeignPosixPath } = require('../workspace/target');

/**
 * 「本机」（= 运行叠云这台机器）的显式标记与判定 —— **单一来源**。
 *
 * 为什么需要它：会话工作空间在 SSH 远端时，所有路径都指远端主机，于是
 * 「读本机的一份配置 / 看一眼本机日志 / 在本机跑一条命令」在整条工具链上完全没有入口
 * （真实事故：为了拿本机的 auth.json 只能绕共享盘倒一次）。工作空间（哪台机器的项目）
 * 与「本机」（跑叠云这台机器）是两个正交的轴，路径必须能明确说出它指哪台机器。
 *
 * 语法只有一种前缀 `local:`：
 *   - 路径型参数写在路径里：`local:C:\Users\me\AppData\Roaming\dieyunagent\auth.json`
 *   - 命令型参数（`host_exec` 的 command 没有路径位）用同名布尔参数 `local:true`
 * 两种写法同一个词，判定都收在本模块；handler 里不许再各写一份 `startsWith('local:')`。
 *
 * 为什么**不**按路径形状猜（`C:\...` 就自动当本机）：SSH 到 Windows 主机时同一条路径
 * 是合法的远端路径，猜错会静默读写另一台机器上的同名文件 —— 比报错难查得多。
 * 所以只认显式前缀；忘了写的时候给一句可执行的补救（见 `localPathReminder`）。
 */

const LOCAL_PATH_PREFIX = 'local:';

/** 本机 / 远端后台进程句柄前缀：句柄自己说出它在哪台机器（见 host-control / remote-processes）。 */
const LOCAL_PROC_HANDLE_PREFIX = 'hostproc-';
const REMOTE_PROC_HANDLE_PREFIX = 'sshproc-';

/** `local:`（大小写不敏感）。 */
function isLocalPathRef(input) {
  return /^local:/i.test(String(input == null ? '' : input).trim());
}

/** Windows 本机绝对路径（含 UNC）：远端是 POSIX 时它必然指本机。 */
function looksLikeWindowsPath(input) {
  const s = String(input == null ? '' : input).trim();
  return /^[a-zA-Z]:[\\/]/.test(s) || s.startsWith('\\\\');
}

function hostLocalError(code, message, suggestedFix) {
  const e = new Error(message);
  e.code = code;
  e.retryable = false;
  if (suggestedFix) e.suggestedFix = suggestedFix;
  return e;
}

/** `~` / `~/x` → 本机用户主目录（与白名单里的 `dieyunUserHome()` 同一个根）。 */
function expandTilde(p) {
  const s = String(p == null ? '' : p).trim();
  if (s === '~') return dieyunUserHome();
  if (/^~[\\/]/.test(s)) return path.join(dieyunUserHome(), s.slice(2));
  return s;
}

/**
 * 拆一个路径参数：它指本机还是会话工作空间？
 *
 * 非 `local:` 前缀一律原样交回（`local:false`），由调用方按「会话工作空间」继续处理 ——
 * 本模块**不**做「远端还是本地」的判断，那是 `rpc.js:resolveFsTarget` 的活。
 *
 * 本机路径必须是绝对路径：SSH 会话里 cwd 是远端路径，拿它当本机基准会得到假位置，
 * 而「本机的相对路径」也没有唯一说得通的基准。
 *
 * @param {string} input
 * @returns {{ local: boolean, path: string }}
 */
function splitHostLocalRef(input) {
  const raw = String(input == null ? '' : input);
  if (!isLocalPathRef(raw)) return { local: false, path: raw };
  const rest = expandTilde(raw.trim().slice(LOCAL_PATH_PREFIX.length));
  const example =
    process.platform === 'win32'
      ? 'local:C:\\Users\\me\\AppData\\Roaming\\dieyunagent\\auth.json'
      : 'local:/home/me/.config/dieyunagent/auth.json';
  if (!rest) {
    throw hostLocalError('LOCAL_PATH_REQUIRED', 'local: 后面要跟本机绝对路径', `例：${example}`);
  }
  if (process.platform === 'win32' && isForeignPosixPath(rest)) {
    // win32 上 `path.isAbsolute('/x')` 为 true 且 resolve 会沿用 cwd 盘符 → 得到假路径
    throw hostLocalError(
      'LOCAL_PATH_WRONG_DIALECT',
      `本机是 Windows，local: 后面要写 Windows 路径（收到「${rest}」）`,
      `例：${example}；用户主目录可写 local:~\\...`
    );
  }
  if (!path.isAbsolute(rest) && !isForeignPosixPath(rest)) {
    throw hostLocalError(
      'LOCAL_PATH_NOT_ABSOLUTE',
      `local: 后面必须是绝对路径（收到「${rest}」）`,
      `例：${example}；本机相对路径没有唯一基准，需要相对位置请先 fs_list_dir 看清楚再写绝对路径`
    );
  }
  return { local: true, path: rest };
}

const GLOB_META_RE = /[*?[\]{}]/;

/**
 * 本机 glob 的拆分：`local:C:/u/a/**\/*.json` → `{ root: 'C:\\u\\a', pattern: '**\\*.json' }`。
 *
 * 为什么需要：`globWorkspace` 把 pattern 当 `rg -g` 的**相对 cwd** 参数用（见 rg-search），
 * 整条绝对 pattern 丢进去永远匹配不到；root 得由前缀里最长的那段字面目录来定。
 *
 * @param {string} rawPattern
 * @returns {{ root: string, pattern: string } | null} 不是本机 glob 时返回 null
 */
function splitLocalGlob(rawPattern) {
  const ref = splitHostLocalRef(rawPattern);
  if (!ref.local) return null;
  const abs = String(ref.path).replace(/[\\/]+$/, '');
  const meta = GLOB_META_RE.exec(abs);
  const literal = meta ? abs.slice(0, meta.index) : abs;
  const slash = Math.max(literal.lastIndexOf('/'), literal.lastIndexOf('\\'));
  const example =
    process.platform === 'win32'
      ? 'local:C:\\Users\\me\\logs\\**\\*.log'
      : 'local:/home/me/logs/**/*.log';
  if (slash < 0) {
    // 只剩「盘符根 / POSIX 根」：那等于「把整块盘列一遍」，不是模型想要的意思，也别猜
    throw hostLocalError(
      'LOCAL_GLOB_NEEDS_DIR',
      `本机 glob 需要带目录的绝对 pattern（收到「${abs}」）`,
      `例：${example}`
    );
  }
  let root = literal.slice(0, slash);
  if (!root) root = abs.slice(0, 1); // POSIX 根 `/`：`local:/*.log`
  // 盘符根必须保留分隔符，否则 `C:` 是「C 盘的当前目录」而不是根（path.resolve 会沿用进程 cwd）
  if (/^[a-zA-Z]:$/.test(root)) root = `${root}${path.sep}`;
  const pattern = abs.slice(slash + 1);
  if (!pattern) {
    throw hostLocalError(
      'LOCAL_GLOB_NEEDS_DIR',
      `本机 glob 需要带目录的绝对 pattern（收到「${abs}」）`,
      `例：${example}`
    );
  }
  return { root, pattern };
}

/**
 * `host_exec` / `host_proc` 的 `local` 参数：true（模型偶尔写成字符串 "true" / "local"）。
 * 缺省 false 才安全 —— 会话是远端时默认行为必须仍是远程。
 */
function isLocalFlag(value) {
  if (value === true) return true;
  if (value == null || value === false) return false;
  const s = String(value).trim().toLowerCase();
  return s === 'true' || s === 'local' || s === '1' || s === 'yes';
}

/**
 * 「这批文件操作去哪台机器」的**纯判定**（`rpc.js:resolveFsTarget` 只负责把环境塞进来）。
 *
 * 两条正交的轴：会话工作空间（本机项目 / SSH 远端项目）与**本机**（跑叠云这台机器）。
 * 缺省跟随会话工作空间（老行为）；路径写了 `local:` 前缀就明确指本机，与工作空间无关。
 *
 * @param {string} rawPath 模型给的原始路径（可带 `local:` 前缀）
 * @param {{ remote?: object|null, defaultCwd?: string|null, sessionCwd?: string|null }} env
 *   remote：远端 fs 适配器（非空 = 会话工作空间在远端）
 *   defaultCwd：本机默认工作区（显式本机时相对路径的基准；本机路径本来就要求绝对）
 *   sessionCwd：会话工作区根（本地会话的相对路径基准；SSH 会话里是远端路径）
 * @returns {{ remote: object|null, path: string, base: string|null, explicitLocal: boolean }}
 */
function decideFsTarget(rawPath, env = {}) {
  const ref = splitHostLocalRef(rawPath);
  if (ref.local) {
    return { remote: null, path: ref.path, base: env.defaultCwd || null, explicitLocal: true };
  }
  const raw = String(rawPath == null ? '' : rawPath);
  const remote = env.remote || null;
  if (remote) return { remote, path: raw, base: null, explicitLocal: false };
  return { remote: null, path: raw, base: env.sessionCwd == null ? null : env.sessionCwd, explicitLocal: false };
}

/**
 * 后台进程句柄说自己在哪台机器：`hostproc-3` 本机、`sshproc-3` 远端。
 * @param {string} id
 * @returns {'local'|'remote'|null}
 */
function procHandleScope(id) {
  const s = String(id == null ? '' : id).trim();
  if (!s) return null;
  if (s.startsWith(LOCAL_PROC_HANDLE_PREFIX)) return 'local';
  if (s.startsWith(REMOTE_PROC_HANDLE_PREFIX)) return 'remote';
  return null;
}

/**
 * 远端调用失败时的补救提示：输入看起来是本机 Windows 绝对路径，却按会话工作空间（远端）
 * 处理了 —— 这是模型在 SSH 会话里最容易犯的错。只在**已经失败之后**追加，
 * 不改判定（不替模型改道到另一台机器）。
 *
 * @param {string} rawPath
 * @returns {string} 不需要提示时返回空串
 */
function localPathReminder(rawPath) {
  const raw = String(rawPath == null ? '' : rawPath).trim();
  if (!raw || isLocalPathRef(raw) || !looksLikeWindowsPath(raw)) return '';
  return (
    `「${raw}」看起来是本机 Windows 路径，而这次按会话工作空间（SSH 远端主机）去找了：` +
    `远端是 Linux/macOS 时那里必然没有这个文件。要读写本机文件，路径加 local: 前缀（例 local:${raw}）；` +
    '要碰远端文件就用远端路径（绝对路径以 / 开头）。'
  );
}

/**
 * 给一个已经失败的错误补上本机路径提示（错误码与 retryable 不动，只补 suggestedFix）。
 * @template T
 * @param {T} err
 * @param {string} rawPath
 * @returns {T}
 */
function annotateLocalPathMiss(err, rawPath) {
  const reminder = localPathReminder(rawPath);
  if (!reminder) return err;
  const e = err instanceof Error ? err : new Error(String(err == null ? '远端操作失败' : err));
  e.suggestedFix = e.suggestedFix ? `${e.suggestedFix} ${reminder}` : reminder;
  return e;
}

module.exports = {
  LOCAL_PATH_PREFIX,
  LOCAL_PROC_HANDLE_PREFIX,
  REMOTE_PROC_HANDLE_PREFIX,
  isLocalPathRef,
  looksLikeWindowsPath,
  splitHostLocalRef,
  splitLocalGlob,
  decideFsTarget,
  isLocalFlag,
  procHandleScope,
  localPathReminder,
  annotateLocalPathMiss
};
