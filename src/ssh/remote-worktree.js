'use strict';

const crypto = require('crypto');
const path = require('path');
const { shellQuoteSingle } = require('./remote-path');
const { normalizeRemotePath, stripWorktreeSuffix } = require('../workspace/target');

/**
 * 远端每会话一份 worktree（方案 C 的远端地基）。
 *
 * 为什么在远端执行 git：`src/git/worktree-service.js` 的 gitExec 跑的是 Main 所在机器的
 * git，workspace 在远端时必须由远端执行同一组命令。
 *
 * 为什么 key 由 sessionId 纯派生：同一会话永远映射到同一份 worktree —— 重连、重启后
 * 自动复用（索引和未合并的改动都在），不需要任何持久化状态，也不需要「陈旧锁回收」。
 * 目录/分支规则与本地 worktree-service 完全一致：
 *   .dieyun/worktrees/<runId>/<roleId>  +  dieyun/agent-<runId>-<roleId>
 * 单会话固定 roleId=main。
 */

const WORKTREES_DIR = '.dieyun/worktrees';
const SESSION_ROLE_ID = 'main';
const BRANCH_PREFIX = 'dieyun/agent-';

const MARK_CREATED = 'WT_CREATED';
const MARK_REUSED = 'WT_REUSED';
const MARK_NOT_GIT = 'WT_NOT_GIT';
const MARK_ADD_FAILED = 'WT_ADD_FAILED';
const MARK_BAD_BASE = 'WT_BAD_BASE';

const MARK_PRUNED = 'WT_PRUNED';
const MARK_KEPT_DIRTY = 'WT_KEPT_DIRTY';
const MARK_PRUNE_END = 'WT_PRUNE_END';
const MARK_PRUNE_NOT_GIT = 'WT_PRUNE_NOT_GIT';

/** @param {string} sessionId */
function remoteWorktreeKey(sessionId) {
  const sid = String(sessionId || '').trim();
  if (!sid) return '';
  return `sess-${crypto.createHash('sha1').update(sid).digest('hex').slice(0, 8)}`;
}

/**
 * @param {string} repoPath 远端仓库根
 * @param {string} sessionId
 * @returns {string} `<repo>/.dieyun/worktrees/sess-xxxxxxxx/main`，空 sessionId 返回 ''
 */
function remoteWorktreePath(repoPath, sessionId) {
  const key = remoteWorktreeKey(sessionId);
  if (!key) return '';
  const root = normalizeRemotePath(repoPath);
  return path.posix.join(root, WORKTREES_DIR, key, SESSION_ROLE_ID);
}

/** @param {string} sessionId */
function remoteWorktreeBranch(sessionId) {
  const key = remoteWorktreeKey(sessionId);
  return key ? `${BRANCH_PREFIX}${key}-${SESSION_ROLE_ID}` : '';
}

/**
 * 会话 worktree 路径 → 仓库根；不是 worktree 路径则原样返回（幂等）。
 * 有了它，worktree 路径可以被持久化成会话工作区，需要仓库时再反推，
 * 而不必同时保存两份路径。
 * 形状判定只有一份（`stripWorktreeSuffix`）：历史分组、会话身份、这里反推必须用同一个口径。
 * @param {string} remotePath
 */
function repoRemotePathOf(remotePath) {
  const p = normalizeRemotePath(remotePath);
  return stripWorktreeSuffix(p) || '/';
}

/**
 * 生成远端建 worktree 的脚本（幂等：已存在就复用，不重置分支）。
 * 基线先解析成具体 sha：存 ref 名会让基线随 HEAD 漂移，「相对基线的变更」就失去确定含义。
 * @param {{ repoPath: string, wtPath: string, branch: string, baseRef?: string }} opts
 * @returns {string[]}
 */
function buildEnsureWorktreeScript(opts) {
  const repoQ = shellQuoteSingle(normalizeRemotePath(opts.repoPath));
  const wtQ = shellQuoteSingle(opts.wtPath);
  const branchQ = shellQuoteSingle(opts.branch);
  const baseQ = shellQuoteSingle(opts.baseRef || 'HEAD');
  return [
    `REPO=${repoQ}`,
    `WT=${wtQ}`,
    `BR=${branchQ}`,
    `BASE=${baseQ}`,
    'if ! git -C "$REPO" rev-parse --git-dir >/dev/null 2>&1; then echo ' + MARK_NOT_GIT + '; exit 3; fi',
    `if test -d "$WT"; then echo ${MARK_REUSED}; exit 0; fi`,
    'mkdir -p "$(dirname "$WT")" || exit 4',
    // 分支已存在就直接挂上去：`-b` 建不了，`-B` 会把它重置回基线、丢掉上一次会话的提交
    'if git -C "$REPO" rev-parse --verify --quiet "refs/heads/$BR" >/dev/null 2>&1; then',
    `  if git -C "$REPO" worktree add "$WT" "$BR" >/dev/null 2>&1; then echo ${MARK_CREATED}; else echo ${MARK_ADD_FAILED}; exit 4; fi`,
    '  exit 0',
    'fi',
    // 基线必须解析成具体 sha：解不出来就明确失败，别静默退回 HEAD（会让「相对基线的变更」含义漂移）
    `SHA=$(git -C "$REPO" rev-parse "$BASE^{commit}" 2>/dev/null) || { echo ${MARK_BAD_BASE}; exit 4; }`,
    `if git -C "$REPO" worktree add -b "$BR" "$WT" "$SHA" >/dev/null 2>&1; then echo ${MARK_CREATED}; else echo ${MARK_ADD_FAILED}; exit 4; fi`
  ];
}

/**
 * @param {string} stdout
 * @returns {{ ok: boolean, reused: boolean, reason: string }}
 */
function parseEnsureWorktreeResult(stdout) {
  const text = String(stdout || '');
  if (text.includes(MARK_REUSED)) return { ok: true, reused: true, reason: MARK_REUSED };
  if (text.includes(MARK_CREATED)) return { ok: true, reused: false, reason: MARK_CREATED };
  if (text.includes(MARK_NOT_GIT)) return { ok: false, reused: false, reason: MARK_NOT_GIT };
  if (text.includes(MARK_BAD_BASE)) return { ok: false, reused: false, reason: MARK_BAD_BASE };
  if (text.includes(MARK_ADD_FAILED)) return { ok: false, reused: false, reason: MARK_ADD_FAILED };
  return { ok: false, reused: false, reason: 'WT_UNKNOWN' };
}

const REASON_HINT = {
  [MARK_NOT_GIT]: '远端工作目录不是 git 仓库，无法创建 worktree',
  [MARK_BAD_BASE]: '基线提交解析不出来（仓库可能还没有任何提交）',
  [MARK_ADD_FAILED]: 'git worktree add 失败',
  WT_UNKNOWN: '远端 worktree 脚本无输出'
};

/**
 * 确保远端 worktree 存在（不存在则创建），幂等。
 * @param {{ execScript: (script: string, timeoutMs?: number) => Promise<{ code?: number, stdout?: string, stderr?: string }> }} sshManager
 * @param {{ repoPath: string, sessionId: string, baseRef?: string, timeoutMs?: number }} opts
 */
async function ensureRemoteWorktree(sshManager, opts) {
  const repoPath = normalizeRemotePath(opts.repoPath);
  const wtPath = remoteWorktreePath(repoPath, opts.sessionId);
  const branch = remoteWorktreeBranch(opts.sessionId);
  if (!wtPath || !branch) {
    return { ok: false, path: '', branch: '', reused: false, error: '缺少 sessionId' };
  }
  const res = await sshManager.execScript(
    buildEnsureWorktreeScript({ repoPath, wtPath, branch, baseRef: opts.baseRef }).join('\n'),
    opts.timeoutMs || 60000
  );
  const parsed = parseEnsureWorktreeResult(res && res.stdout);
  if (!parsed.ok) {
    const detail = String((res && res.stderr) || '').trim().split('\n').slice(-3).join(' / ');
    return {
      ok: false,
      path: wtPath,
      branch,
      reused: false,
      reason: parsed.reason,
      error: `${REASON_HINT[parsed.reason] || parsed.reason}${detail ? `：${detail}` : ''}`
    };
  }
  return { ok: true, path: wtPath, branch, reused: parsed.reused, reason: parsed.reason };
}

/**
 * 生成「回收过期会话 worktree」的脚本。
 *
 * 每会话一份 worktree、里面还有一份索引库（实测 19–38 MB / 份），不回收就是无限增长。
 * 三条安全线：
 *   1. **只删 `keepKeys` 之外的** —— 「哪份会话还活着」在 Main 判定（会话表是唯一来源），
 *      远端不猜 mtime：只读的会话几天不改文件，按 mtime 会把正在用的 worktree 当旧的删掉；
 *   2. 只认 `sess-*` 这种我们自己命名的目录形状，别人的目录一律不碰；
 *   3. 有未提交改动的 worktree **跳过并报出来** —— 那是会话里的真改动，不是缓存。
 *
 * 分支 `dieyun/agent-<key>-main` 不删：它可能装着会话的提交，删目录不等于丢它们。
 * @param {{ repoPath: string, keepKeys?: string[] }} opts
 * @returns {string[]}
 */
function buildPruneWorktreesScript(opts) {
  const repoQ = shellQuoteSingle(normalizeRemotePath(opts.repoPath));
  const keep = (opts.keepKeys || []).filter((k) => typeof k === 'string' && k);
  // 逗号包住做整词匹配，否则 `sess-ab` 会命中 `sess-abc`
  const keepQ = shellQuoteSingle(keep.length ? `,${keep.join(',')},` : ',');
  return [
    `REPO=${repoQ}`,
    `KEEP=${keepQ}`,
    'if ! git -C "$REPO" rev-parse --git-dir >/dev/null 2>&1; then echo ' + MARK_PRUNE_NOT_GIT + '; exit 3; fi',
    `ROOT="$REPO/${WORKTREES_DIR}"`,
    `if ! test -d "$ROOT"; then echo ${MARK_PRUNE_END}; exit 0; fi`,
    'for d in "$ROOT"/sess-*; do',
    '  test -d "$d" || continue',
    '  key=$(basename "$d")',
    '  case "$KEEP" in *",$key,"*) continue;; esac',
    '  WT="$d/main"',
    // 只有真的是一份 worktree（`.git` 是文件）才谈得上「未提交改动」。
    // 少了这个前提，`git -C` 会顺着父仓库往上找到外层的 git，把 worktrees 目录里
    // 任意一个未跟踪文件当成脏，于是删不掉的残骸永远留在这里。
    '  if test -f "$WT/.git" && [ -n "$(git -C "$WT" status --porcelain 2>/dev/null)" ]; then',
    `    echo "${MARK_KEPT_DIRTY} $key"; continue`,
    '  fi',
    '  git -C "$REPO" worktree remove --force "$WT" >/dev/null 2>&1 || rm -rf "$WT"',
    '  rm -rf "$d"',
    `  echo "${MARK_PRUNED} $key"`,
    'done',
    'git -C "$REPO" worktree prune >/dev/null 2>&1',
    `echo ${MARK_PRUNE_END}`
  ];
}

/**
 * @param {string} stdout
 * @returns {{ ok: boolean, reason: string, pruned: string[], keptDirty: string[] }}
 */
function parsePruneResult(stdout) {
  const text = String(stdout || '');
  const pruned = [];
  const keptDirty = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (t.startsWith(`${MARK_PRUNED} `)) pruned.push(t.slice(MARK_PRUNED.length + 1).trim());
    else if (t.startsWith(`${MARK_KEPT_DIRTY} `)) {
      keptDirty.push(t.slice(MARK_KEPT_DIRTY.length + 1).trim());
    }
  }
  const notGit = text.includes(MARK_PRUNE_NOT_GIT);
  return { ok: !notGit, reason: notGit ? MARK_NOT_GIT : '', pruned, keptDirty };
}

/**
 * 回收远端过期会话 worktree（幂等）。
 * @param {{ execScript: (script: string, timeoutMs?: number) => Promise<{ code?: number, stdout?: string, stderr?: string }> }} sshManager
 * @param {{ repoPath: string, keepKeys?: string[], timeoutMs?: number }} opts
 */
async function pruneRemoteWorktrees(sshManager, opts) {
  const repoPath = normalizeRemotePath(opts.repoPath);
  const script = buildPruneWorktreesScript({ repoPath, keepKeys: opts.keepKeys }).join('\n');
  const res = await sshManager.execScript(script, opts.timeoutMs || 120000);
  return parsePruneResult(res && res.stdout);
}

module.exports = {
  WORKTREES_DIR,
  remoteWorktreeKey,
  remoteWorktreePath,
  remoteWorktreeBranch,
  repoRemotePathOf,
  buildEnsureWorktreeScript,
  parseEnsureWorktreeResult,
  ensureRemoteWorktree,
  buildPruneWorktreesScript,
  parsePruneResult,
  pruneRemoteWorktrees
};
