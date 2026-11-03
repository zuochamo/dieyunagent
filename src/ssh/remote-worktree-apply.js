'use strict';

const { normalizeRemotePath } = require('../workspace/target');
const { shellQuoteSingle } = require('./remote-path');
const { repoRemotePathOf } = require('./remote-worktree');

/**
 * 把远端会话 worktree 的改动「应用回主目录」。
 *
 * 做法是 git 原生的两步，而不是把文件逐个复制回去：
 *   1. 在 worktree 里把改动提交到它的分支（`dieyun/agent-sess-xxxx-main`）
 *   2. 回到主目录 `git merge --no-ff` 这个分支
 *
 * 为什么不是逐文件复制（本地那套 applyRunWorktreeChanges 的做法）：
 * - 逐文件要自己判冲突、自己做备份、自己回滚；git merge 已经把这三件事做完了
 * - 冲突时 `git merge --abort` 一行就把主目录恢复原样，不需要备份目录与 manifest
 * - 提交是一份可审计的记录，出问题能 `git revert`
 *
 * 所有 git 命令都在远端执行（`sshManager.execScript`）；本模块只拼命令、解析结果。
 */

const MARK_NOT_GIT = 'WTA_NOT_GIT';
const MARK_DETACHED = 'WTA_DETACHED';
const MARK_WT_DETACHED = 'WTA_WT_DETACHED';
const MARK_NO_CHANGES = 'WTA_NO_CHANGES';
const MARK_ADD_FAILED = 'WTA_ADD_FAILED';
const MARK_COMMIT_FAILED = 'WTA_COMMIT_FAILED';
const MARK_MERGED = 'WTA_MERGED';
const MARK_CONFLICT = 'WTA_CONFLICT';
const MARK_MERGE_FAILED = 'WTA_MERGE_FAILED';
const MARK_DONE = 'WTA_DONE';

const AGENT_GIT_NAME = 'dieyun-agent';
const AGENT_GIT_EMAIL = 'agent@dieyun.local';

/** 解析 `git status --porcelain` 行；重命名取新路径 */
function parsePorcelainLine(line) {
  const raw = String(line || '').replace(/\r/g, '');
  if (raw.trim().length < 3) return null;
  const code = raw.slice(0, 2).trim() || '?';
  let p = raw.slice(2).trim();
  const arrow = p.indexOf(' -> ');
  if (arrow >= 0) p = p.slice(arrow + 4).trim();
  if (!p) return null;
  return { code, path: p };
}

function parseStatusLines(stdout, prefix) {
  const out = [];
  for (const line of String(stdout || '').split('\n')) {
    if (!line.startsWith(prefix)) continue;
    const ch = parsePorcelainLine(line.slice(prefix.length));
    if (ch) out.push(ch);
  }
  return out;
}

/**
 * 解析 `WTA_FILE` 行：这些行是 `git diff --name-only` 的**裸路径**，没有 porcelain 那两列
 * 状态位。以前这里复用了 `parseStatusLines`（按 porcelain 砍头两字符），于是冲突文件列表
 * 整体错位（路径少两个字符）、短路径直接消失。列表型输出与状态型输出必须分开解析。
 */
function parsePathListLines(stdout, prefix) {
  const out = [];
  for (const line of String(stdout || '').split('\n')) {
    if (!line.startsWith(prefix)) continue;
    const p = line.slice(prefix.length).replace(/\r/g, '').trim();
    if (p) out.push({ code: 'U', path: p });
  }
  return out;
}

/**
 * 预览：worktree 当前分支 + 相对基线的未提交改动。
 * @param {{ wtPath: string }} opts
 * @returns {string[]}
 */
function buildPreviewScript(opts) {
  const wtQ = shellQuoteSingle(normalizeRemotePath(opts.wtPath));
  return [
    `WT=${wtQ}`,
    `if ! git -C "$WT" rev-parse --git-dir >/dev/null 2>&1; then echo ${MARK_NOT_GIT}; exit 3; fi`,
    'git -C "$WT" rev-parse --abbrev-ref HEAD 2>/dev/null | sed "s/^/WT_BRANCH /"',
    'git -C "$WT" status --porcelain | sed "s/^/WT_FILE /"'
  ];
}

/**
 * @param {string} stdout
 * @returns {{ ok: boolean, branch: string, files: Array<{code: string, path: string}>, error?: string }}
 */
function parsePreview(stdout) {
  const text = String(stdout || '');
  if (text.includes(MARK_NOT_GIT)) return { ok: false, branch: '', files: [], error: '远端副本不是 git 工作树' };
  const branchLine = text.split('\n').find((l) => l.startsWith('WT_BRANCH '));
  return {
    ok: true,
    branch: branchLine ? branchLine.slice('WT_BRANCH '.length).trim() : '',
    files: parseStatusLines(text, 'WT_FILE ')
  };
}

/**
 * 应用：worktree 提交 → 主目录合并；冲突自动 abort（主目录不留半成品）。
 * @param {{ repoPath: string, wtPath: string, branch: string, message?: string }} opts
 * @returns {string[]}
 */
function buildApplyScript(opts) {
  const repoQ = shellQuoteSingle(normalizeRemotePath(opts.repoPath));
  const wtQ = shellQuoteSingle(normalizeRemotePath(opts.wtPath));
  const brQ = shellQuoteSingle(opts.branch);
  const msgQ = shellQuoteSingle(opts.message || 'dieyun: 会话产出');
  const id = `-c user.name=${AGENT_GIT_NAME} -c user.email=${AGENT_GIT_EMAIL}`;
  return [
    `REPO=${repoQ}`,
    `WT=${wtQ}`,
    `BR=${brQ}`,
    `MSG=${msgQ}`,
    `if ! git -C "$REPO" rev-parse --git-dir >/dev/null 2>&1; then echo ${MARK_NOT_GIT}; exit 3; fi`,
    `CUR=$(git -C "$REPO" rev-parse --abbrev-ref HEAD 2>/dev/null) || CUR=''`,
    `if test -z "$CUR" || test "$CUR" = "HEAD"; then echo ${MARK_DETACHED}; exit 6; fi`,
    'echo "WTA_BASE $CUR"',
    // 副本必须还站在自己的分支上：detached 时提交进不了 $BR，merge 会「成功」但一个改动都没合
    `WT_CUR=$(git -C "$WT" rev-parse --abbrev-ref HEAD 2>/dev/null) || WT_CUR=''`,
    `if test "$WT_CUR" != "$BR"; then echo ${MARK_WT_DETACHED}; exit 6; fi`,
    // 1) 副本里有改动就先提交，否则 merge 无从下手
    'git -C "$WT" add -A >/dev/null 2>&1 || { echo ' + MARK_ADD_FAILED + '; exit 5; }',
    'if git -C "$WT" diff --cached --quiet >/dev/null 2>&1; then',
    `  echo ${MARK_NO_CHANGES}`,
    'else',
    `  if git -C "$WT" ${id} commit -q -m "$MSG" >/dev/null 2>&1; then`,
    '    git -C "$WT" rev-parse HEAD | sed "s/^/WTA_COMMIT /"',
    '  else',
    `    echo ${MARK_COMMIT_FAILED}; exit 5`,
    '  fi',
    'fi',
    // 2) 合回主目录；失败一律 abort，主目录保持进入前的状态
    `if git -C "$REPO" ${id} merge --no-ff -m "$MSG" "$BR" >/dev/null 2>&1; then`,
    `  echo ${MARK_MERGED}`,
    'else',
    // 只有真有未合并路径才是「冲突」；主目录脏、钩子拒绝、分支缺失都不是冲突，别一律甩给用户
    '  UNMERGED=$(git -C "$REPO" -c core.quotepath=false diff --name-only --diff-filter=U 2>/dev/null)',
    '  git -C "$REPO" merge --abort >/dev/null 2>&1 || true',
    '  if test -n "$UNMERGED"; then',
    `    echo ${MARK_CONFLICT}`,
    '    echo "$UNMERGED" | sed "s/^/WTA_FILE /"',
    '  else',
    `    echo ${MARK_MERGE_FAILED}`,
    '  fi',
    'fi',
    `echo ${MARK_DONE}`
  ];
}

const FAILURE_CODE = {
  [MARK_NOT_GIT]: { code: 'NOT_GIT', error: '主目录不是 git 仓库' },
  [MARK_DETACHED]: { code: 'DETACHED', error: '主目录不在任何分支上（detached HEAD），无法合并' },
  [MARK_WT_DETACHED]: { code: 'WT_DETACHED', error: '会话副本不在自己的分支上，提交无处可去' },
  [MARK_ADD_FAILED]: { code: 'ADD_FAILED', error: '副本暂存改动失败' },
  [MARK_COMMIT_FAILED]: { code: 'COMMIT_FAILED', error: '副本提交失败（工作树可能有冲突标记）' },
  [MARK_MERGE_FAILED]: { code: 'MERGE_FAILED', error: '合并失败（不是冲突，主目录已回滚）' }
};

/**
 * @param {string} stdout
 * @returns {{ ok: boolean, code: string, baseBranch: string, commit: string, files: Array<{code: string,path: string}>, error: string }}
 */
function parseApply(stdout) {
  const text = String(stdout || '');
  for (const [mark, info] of Object.entries(FAILURE_CODE)) {
    if (text.includes(mark)) return { ok: false, code: info.code, baseBranch: '', commit: '', files: [], error: info.error };
  }
  const baseLine = text.split('\n').find((l) => l.startsWith('WTA_BASE '));
  const commitLine = text.split('\n').find((l) => l.startsWith('WTA_COMMIT '));
  const base = {
    baseBranch: baseLine ? baseLine.slice('WTA_BASE '.length).trim() : '',
    commit: commitLine ? commitLine.slice('WTA_COMMIT '.length).trim() : ''
  };
  if (text.includes(MARK_CONFLICT)) {
    return {
      ok: false,
      code: 'CONFLICT',
      ...base,
      files: parsePathListLines(text, 'WTA_FILE '),
      error: '主目录与副本冲突，已自动回滚主目录（副本提交保留）'
    };
  }
  if (text.includes(MARK_MERGED)) {
    return { ok: true, code: 'MERGED', ...base, files: [], error: '' };
  }
  return { ok: false, code: 'UNKNOWN', ...base, files: [], error: '合并脚本无结果标记' };
}

async function previewRemoteWorktree(sshManager, opts) {
  const wtPath = normalizeRemotePath(opts.wtPath);
  const res = await sshManager.execScript(buildPreviewScript({ wtPath }).join('\n'), opts.timeoutMs || 30000);
  const parsed = parsePreview(res && res.stdout);
  const repoPath = repoRemotePathOf(wtPath);
  return { ...parsed, repoPath, wtPath, isSessionWorktree: repoPath !== wtPath };
}

async function applyRemoteWorktree(sshManager, opts) {
  const repoPath = normalizeRemotePath(opts.repoPath);
  const wtPath = normalizeRemotePath(opts.wtPath);
  const res = await sshManager.execScript(
    buildApplyScript({ repoPath, wtPath, branch: opts.branch, message: opts.message }).join('\n'),
    opts.timeoutMs || 120000
  );
  const parsed = parseApply(res && res.stdout);
  const detail = String((res && res.stderr) || '').trim().split('\n').slice(-3).join(' / ');
  return {
    ...parsed,
    repoPath,
    wtPath,
    branch: opts.branch,
    error: parsed.error && detail ? `${parsed.error}：${detail}` : parsed.error
  };
}

module.exports = {
  parsePorcelainLine,
  buildPreviewScript,
  parsePreview,
  buildApplyScript,
  parseApply,
  previewRemoteWorktree,
  applyRemoteWorktree
};
