'use strict';

const fs = require('fs');
const path = require('path');
const {
  createGitTarget,
  encodeWorktreeContent,
  WORKTREE_SNAPSHOT_MAX_BYTES
} = require('./git-target');
const { readGitStatus, toLegacyStatusItem } = require('./status');
const { captureTurnStartState, MAX_BASELINE_FILES } = require('./turn-tree');

/**
 * 捕获 turn 开始前工作区相对 git 根的脏文件内容（用于 git 策略撤回）。
 *
 * `opts.turnStartState`：只有**回合开始**需要「回合开始树 + 未跟踪清单」。
 * 每个工具批次结束时的 `capture_batch` 也会调这里（补脏文件内容），
 * 那里**不能**再跑 `git stash create` / `ls-files` —— 一轮 30+ 批就是 30+ 个不可达 commit
 * 加 30+ 次全工作区遍历。
 *
 * @param {string} repoPath
 * @param {{ turnStartState?: boolean }} [opts]
 * @returns {Promise<{ isRepo: boolean, head: string, stashSha: string, untracked: string[]|null, files: Record<string, { before: string|null, encoding: 'utf8'|'base64' }> }>}
 */
async function captureGitWorkingBaseline(repoPath, opts = {}) {
  const files = {};
  const target = createGitTarget({ kind: 'local', root: repoPath });
  // `isRepo` 由这里回答：调用方（`beginTurn`）不必再单独 `isGitRepo()` 问一次（省一次 git 往返）
  if (!(await target.isRepo())) {
    return { isRepo: false, head: '', stashSha: '', untracked: null, files };
  }
  const head = (await target.textOrEmpty(['rev-parse', 'HEAD'])) || '';

  let status;
  try {
    // untrackedMode:normal —— 与改造前 `git status --porcelain -u` 一致：
    // 未跟踪目录折叠成 `dir/`，不会在 turn_begin 里逐个展开
    status = await readGitStatus(target, { untrackedMode: 'normal' });
  } catch {
    return { isRepo: true, head, stashSha: '', untracked: null, files };
  }

  // 先拿 status 再决定建不建树（闸门看的就是脏条目数）
  const turnStart =
    opts.turnStartState === true
      ? await captureTurnStartState(target, { dirtyCount: status.entries.length })
      : null;
  const stashSha = turnStart ? turnStart.stashSha : '';
  const untracked = turnStart ? turnStart.untracked : null;

  for (const entry of status.entries) {
    if (Object.keys(files).length >= MAX_BASELINE_FILES) break;
    const item = toLegacyStatusItem(entry);
    const rel = item.path.replace(/\\/g, '/');
    if (!rel) continue;
    if (item.kind === 'deleted') {
      files[rel] = { before: null, encoding: 'utf8' };
      continue;
    }
    const full = path.join(repoPath, rel);
    if (!fs.existsSync(full) || !fs.statSync(full).isFile()) continue;
    try {
      const buf = fs.readFileSync(full);
      if (buf.length > WORKTREE_SNAPSHOT_MAX_BYTES) continue;
      const enc = encodeWorktreeContent(buf);
      files[rel] = { before: enc.before, encoding: enc.encoding };
    } catch {
      // ignore unreadable
    }
  }
  return { isRepo: true, head, stashSha, untracked, files };
}

/**
 * 将 baseline 文件合并进 turn 快照（不覆盖已有 path，保留最早 checkpoint 内容）。
 * @param {Record<string, { before: string|null, encoding: 'utf8'|'base64', remote?: boolean }>} target
 * @param {Record<string, { before: string|null, encoding: 'utf8'|'base64', remote?: boolean }>} incoming
 */
function mergeBaselineFilesInto(target, incoming) {
  let merged = 0;
  /** @type {string[]} */
  const mergedKeys = [];
  for (const [key, meta] of Object.entries(incoming || {})) {
    if (!key || target[key]) continue;
    target[key] = {
      before: meta.before == null ? null : String(meta.before),
      encoding: meta.encoding === 'base64' ? 'base64' : 'utf8',
      remote: !!meta.remote
    };
    mergedKeys.push(key);
    merged += 1;
  }
  return { merged, mergedKeys };
}

module.exports = {
  captureGitWorkingBaseline,
  mergeBaselineFilesInto
};
