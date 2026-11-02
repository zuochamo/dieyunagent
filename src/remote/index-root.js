'use strict';

/**
 * 「这次索引操作针对哪个远端根」的**唯一解析处**。
 *
 * 为什么必须有这一个文件：一条远端索引链路上同时存在**三个**根的说法——
 * 1. 调用方显式传的 `workspaceRoot`（renderer 发的是 `ssh://user@host/<path>`）；
 * 2. 本次调用的作用域根 `resolveCallWorkspaceTarget().remotePath`（`runWorkspaceRoot` / 会话绑定）；
 * 3. 远端 daemon 那条连接在 `hello{workspace}` 里声明的根（= `<root>/.dieyun/index.sqlite` 的主人）。
 *
 * 三者只要有一个不一致，症状就完全一样且极难辨认：**面板/准备区永远「未建立」，而工具调用
 * 看起来都成功**——因为建的是 A 的库、查的是 B 的哈希。历史上第 1 个被第 2 个静默丢弃
 * （`resolveCodebaseContext` 不看 `workspaceRoot`），第 3 个则从来没被比对过。
 *
 * 本模块只做两件事：把根归一成 daemon 上的 POSIX 路径；不一致就报 `WORKSPACE_SCOPE_MISMATCH`。
 * **不做兜底、不做重试、不猜**：两个根对应两份 `index.sqlite`，猜错就是错的答案。
 */

const path = require('path');
const { normalizeRemotePath, parseWorkspaceInput, isRemoteWorkspacePath } = require('../workspace/target');

const WINDOWS_ABS_RE = /^[a-zA-Z]:[\\/]/;

/**
 * 归一成 daemon 上的 POSIX 绝对路径。
 *
 * - `ssh://user@host:port/<path>` → `<path>`（这才是 daemon 认的坐标）
 * - 绝对的 POSIX 路径 → 归一化（去尾斜杠、折叠 `..`）
 * - 相对路径 → 相对 `scopeRoot` 展开（调用方写 `./src` 时不该变成 `/src`）
 * - Windows 盘符 / UNC → 转成 `/` 分隔后**原样**返回：它是另一个坐标系（本机路径进了远端调用），
 *   交给上面的比对去报错，别在这里猜成某个远端路径。
 *
 * @param {string} input
 * @param {string} [scopeRoot]
 * @returns {string} 归一后的根；空输入返回 ''
 */
function normalizeIndexRoot(input, scopeRoot) {
  const raw = String(input == null ? '' : input).trim();
  if (!raw) return '';
  if (isRemoteWorkspacePath(raw)) {
    const target = parseWorkspaceInput(raw);
    // 形态不合法的 ssh 串（`ssh:user@host:/path`）→ 视为没给根，交给上层用作用域根
    return target && target.kind === 'ssh' ? normalizeRemotePath(target.remotePath) : '';
  }
  if (WINDOWS_ABS_RE.test(raw) || raw.startsWith('\\\\')) return raw.replace(/\\/g, '/');
  if (raw.startsWith('/')) return normalizeRemotePath(raw);
  const base = normalizeIndexRoot(scopeRoot) || '/';
  return normalizeRemotePath(path.posix.join(base, raw));
}

/**
 * 两个根不一致时的错误。**必须带两个根**：只说「作用域不一致」，现场没人能判断该改哪一边。
 *
 * @param {{ explicit?: string, scope?: string, scopeLabel?: string, label?: string }} p
 */
function indexRootMismatchError({ explicit, scope, scopeLabel, label } = {}) {
  const who = label ? `${label}：` : '';
  const e = new Error(
    `${who}索引根不一致——${scopeLabel || '本次作用域根'}是「${scope || '(未声明)'}」，` +
      `请求的根是「${explicit || '(未声明)'}」。两者对应两份不同的 index.sqlite` +
      '（`<根>/.dieyun/index.sqlite`）：在错的库里建/查，只会得到「永远未建立」。'
  );
  e.code = 'WORKSPACE_SCOPE_MISMATCH';
  e.retryable = false;
  e.suggestedFix =
    '不要重试；让调用方带上本会话的工作区根（sessionId + runWorkspaceRoot，SSH 会话是 worktree），或先切到目标工作区。';
  e.explicitRoot = explicit || '';
  e.scopeRoot = scope || '';
  return e;
}

/**
 * 解析本次操作唯一有效的索引根。
 *
 * 三种输入的组合都有确定答案：只给作用域 → 用作用域；只给显式 → 用显式；两个都给 → **必须相等**，
 * 不等就抛错。注意「相等」是在归一之后判断的（`ssh://h/p/` 与 `/p` 是同一个根）。
 *
 * @param {{ explicitRoot?: string, scopeRoot?: string, label?: string, scopeLabel?: string }} p
 * @returns {{ root: string, source: 'explicit'|'scope' }}
 */
function resolveIndexRoot({ explicitRoot, scopeRoot, label, scopeLabel } = {}) {
  const scope = normalizeIndexRoot(scopeRoot);
  const explicit = normalizeIndexRoot(explicitRoot, scope);
  if (!explicit && !scope) return { root: '', source: 'scope' };
  if (!explicit) return { root: scope, source: 'scope' };
  if (!scope) return { root: explicit, source: 'explicit' };
  if (explicit !== scope) {
    throw indexRootMismatchError({ explicit, scope, label, scopeLabel });
  }
  return { root: explicit, source: 'explicit' };
}

module.exports = {
  normalizeIndexRoot,
  indexRootMismatchError,
  resolveIndexRoot
};
