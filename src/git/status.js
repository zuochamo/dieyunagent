'use strict';

/**
 * git 工作区状态的单一来源：porcelain 解析 + 状态读取。
 *
 * 这里只认「git 说了什么」（XY 字段、分支/上游），不认「UI 怎么展示」——
 * 分组口径与中文标签在 scm-service，变更词表在 worktree-service。
 *
 * 消费方一律从这里取状态，不要再各写一份逐行 split：
 *   - 源码管理（scm-service）
 *   - 回合基线捕获（baseline-capture / remote-baseline-capture）
 *   - worktree 变更列表（worktree-service）
 *   - 注入 LLM 的 git 变更上下文（diff-context）
 *
 * 统一走 `--porcelain -z`：路径不带 C 风格引号，含空格 / 中文 / 换行的文件名原样返回。
 * 注意读输出必须用 target.run()（原始 stdout），不能用会 trim 的包装——首条记录形如
 * ` M file`，一旦被 trim 掉前导空格，XY 与路径的边界就错位了。
 */

const { normalizeGitRelPath, normalizeGitText } = require('./git-target');

/** 冲突的 porcelain XY 组合（git status §Short Format） */
const CONFLICT_XY = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']);

/** untracked 模式：'normal' 会把未跟踪目录折叠成 `dir/`，'all' 逐个列文件 */
const UNTRACKED_MODE_ARGS = { normal: '-unormal', all: '-uall' };

/**
 * 解析 branch 头，如：
 *   `## main...origin/main [ahead 1, behind 2]`
 *   `## No commits yet on main`
 *   `## HEAD (no branch)`
 * @param {string} raw 去掉前导 `## ` 后的内容
 * @param {{branch: string, upstream: string, ahead: number, behind: number, detached: boolean, unborn: boolean}} info
 */
function parseBranchHeader(raw, info) {
  let s = String(raw || '').trim();
  if (!s) return;
  let m = /^No commits yet on (.+)$/.exec(s);
  if (m) {
    info.branch = m[1].trim();
    info.unborn = true;
    return;
  }
  m = /^Initial commit on (.+)$/.exec(s);
  if (m) {
    info.branch = m[1].trim();
    info.unborn = true;
    return;
  }
  if (s.startsWith('HEAD (no branch)')) {
    info.detached = true;
    info.branch = 'HEAD';
    return;
  }
  const ab = /\[([^\]]*)\]\s*$/.exec(s);
  if (ab) {
    s = s.slice(0, ab.index).trim();
    const ahead = /ahead (\d+)/.exec(ab[1]);
    const behind = /behind (\d+)/.exec(ab[1]);
    info.ahead = ahead ? Number(ahead[1]) || 0 : 0;
    info.behind = behind ? Number(behind[1]) || 0 : 0;
  }
  if (s.includes('...')) {
    const parts = s.split('...');
    info.branch = parts[0].trim();
    info.upstream = String(parts[1] || '').trim();
    return;
  }
  info.branch = s;
}

/**
 * @param {string} out `git status --porcelain=v1 -z --branch` 的原始输出（NUL 分隔）
 * @returns {{ branch: string, upstream: string, ahead: number, behind: number, detached: boolean, unborn: boolean, entries: Array<{path: string, origPath: string, x: string, y: string, untracked: boolean}> }}
 */
function parsePorcelainZ(out) {
  const tokens = String(out || '').split('\0');
  const info = {
    branch: '',
    upstream: '',
    ahead: 0,
    behind: 0,
    detached: false,
    unborn: false
  };
  /** @type {Array<{path: string, origPath: string, x: string, y: string, untracked: boolean}>} */
  const entries = [];

  let i = 0;
  if (tokens.length && String(tokens[0]).startsWith('## ')) {
    parseBranchHeader(String(tokens[0]).slice(3), info);
    i = 1;
  }

  for (; i < tokens.length; i++) {
    const tok = String(tokens[i] || '');
    if (tok.length < 3) continue;
    const x = tok[0];
    const y = tok[1];
    if (x === '!' && y === '!') continue; // ignored 文件不进列表
    const rawPath = tok.slice(3);

    if (x === '?' && y === '?') {
      const p = normalizeGitRelPath(rawPath);
      if (p) entries.push({ path: p, origPath: '', x: '?', y: '?', untracked: true });
      continue;
    }

    // 重命名 / 复制：新路径在前，旧路径是紧随其后的一个 token
    let origPath = '';
    if (x === 'R' || x === 'C' || y === 'R' || y === 'C') {
      origPath = normalizeGitRelPath(tokens[i + 1] || '');
      i += 1;
    }
    const p = normalizeGitRelPath(rawPath);
    if (!p) continue;
    entries.push({ path: p, origPath, x, y, untracked: false });
  }

  return { ...info, entries };
}

function isConflictEntry(entry) {
  return CONFLICT_XY.has(`${entry.x}${entry.y}`) || entry.x === 'U' || entry.y === 'U';
}

/**
 * 历史形态的条目：`{ path, status, kind }`，`kind` 词汇为 deleted | untracked | modified。
 * 保留给回合基线捕获 / worktree 列表等老消费方，语义与改造前逐字一致
 * （注意 `A ` 在旧口径下仍是 modified，由调用方再走 normalizeChangeKind 归一）。
 * @param {ReturnType<typeof parsePorcelainZ>['entries'][number]} entry
 */
function toLegacyStatusItem(entry) {
  let kind = 'modified';
  if (entry.untracked) kind = 'untracked';
  else if (entry.x === 'D' || entry.y === 'D') kind = 'deleted';
  return {
    path: entry.path,
    status: `${entry.x}${entry.y}`.trim(),
    kind
  };
}

/** @param {string} out porcelain 原始输出 */
function parsePorcelainStatus(out) {
  return parsePorcelainZ(out).entries.map(toLegacyStatusItem);
}

/**
 * 读取工作区状态。
 * @param {ReturnType<import('./git-target').createGitTarget>} git
 * @param {{ untrackedMode?: 'normal'|'all' }} [opts]
 */
async function readGitStatus(git, opts = {}) {
  const untrackedArg = UNTRACKED_MODE_ARGS[opts.untrackedMode] || UNTRACKED_MODE_ARGS.all;
  if (!(await git.isRepo())) {
    return {
      ok: true,
      isRepo: false,
      branch: '',
      upstream: '',
      ahead: 0,
      behind: 0,
      detached: false,
      unborn: false,
      entries: []
    };
  }
  const r = await git.run(['status', '--porcelain', '-z', '--branch', untrackedArg]);
  if (!r.ok) {
    throw new Error(normalizeGitText(r.stdout, r.stderr) || 'git status 失败');
  }
  return { ok: true, isRepo: true, ...parsePorcelainZ(r.stdout) };
}

module.exports = {
  CONFLICT_XY,
  UNTRACKED_MODE_ARGS,
  parseBranchHeader,
  parsePorcelainZ,
  parsePorcelainStatus,
  toLegacyStatusItem,
  isConflictEntry,
  readGitStatus
};
