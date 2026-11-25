'use strict';

const path = require('path');
const { normalizeRemotePath } = require('../workspace/target');
const {
  createGitTarget,
  encodeWorktreeContent,
  WORKTREE_SNAPSHOT_MAX_BYTES
} = require('./git-target');
const { readGitStatus, toLegacyStatusItem } = require('./status');
const { captureTurnStartState, MAX_BASELINE_FILES } = require('./turn-tree');

/**
 * SSH 工作区：捕获回合开始前远端 git 脏文件（与 captureGitWorkingBaseline 对齐）。
 *
 * git 调用走 createGitTarget（与源码管理同一套远端执行），
 * 文件内容仍走 SFTP：`head -c` 拿到的是已解码字符串，二进制文件会失真，
 * 而回撤基线必须拿到精确字节（按 utf8 / base64 分别落档）。
 *
 * @param {ReturnType<import('../ssh/session-manager').createSshSessionManager>} ssh
 * @param {string} remoteRoot
 * @param {{ turnStartState?: boolean }} [opts] 只有回合开始需要「回合开始树 + 未跟踪清单」
 *   （`capture_batch` 每批也调这里，那里跑 `stash create` 就是一轮几十个不可达 commit）
 * @returns {Promise<{ isGitRepo: boolean, head: string, stashSha: string, untracked: string[]|null, files: Record<string, { before: string|null, encoding: 'utf8'|'base64', remote: true }> }>}
 */
async function captureRemoteGitWorkingBaseline(ssh, remoteRoot, opts = {}) {
  const empty = { isGitRepo: false, head: '', stashSha: '', untracked: null, files: {} };
  if (!ssh || !remoteRoot) return empty;

  const root = normalizeRemotePath(remoteRoot);
  const target = createGitTarget({
    kind: 'ssh',
    root,
    sshExec: (command, cwd, timeoutMs) => ssh.exec(command, cwd, timeoutMs)
  });

  if (!(await target.isRepo())) return empty;

  const head = (await target.textOrEmpty(['rev-parse', 'HEAD'])) || '';

  let status;
  try {
    status = await readGitStatus(target, { untrackedMode: 'normal' });
  } catch {
    return { isGitRepo: true, head, stashSha: '', untracked: null, files: {} };
  }

  // 回合开始树 + 当时的未跟踪清单：整轮撤回的唯一可靠来源
  // （shell 改的文件只有树里有「改前」；shell 新建的未跟踪文件只有清单能判出「本轮新建」）
  // 建树放在 status 之后：脏条目过多时闸门会跳过建树（见 baseline-capture.MAX_TURN_START_TREE_FILES）
  const turnStart =
    opts.turnStartState === true
      ? await captureTurnStartState(target, { dirtyCount: status.entries.length })
      : null;
  const stashSha = turnStart ? turnStart.stashSha : '';
  const untracked = turnStart ? turnStart.untracked : null;

  /** @type {Record<string, { before: string|null, encoding: 'utf8'|'base64', remote: true }>} */
  const files = {};
  for (const entry of status.entries) {
    if (Object.keys(files).length >= MAX_BASELINE_FILES) break;
    const item = toLegacyStatusItem(entry);
    const rel = item.path.replace(/\\/g, '/');
    if (!rel) continue;

    if (item.kind === 'deleted') {
      files[rel] = { before: null, encoding: 'utf8', remote: true };
      continue;
    }

    const full = path.posix.join(root, rel);
    try {
      const { buf, truncated } = await ssh.sftpReadFile(full, WORKTREE_SNAPSHOT_MAX_BYTES + 1, 0);
      if (truncated || buf.length > WORKTREE_SNAPSHOT_MAX_BYTES) continue;
      const enc = encodeWorktreeContent(buf);
      files[rel] = { before: enc.before, encoding: enc.encoding, remote: true };
    } catch {
      // ignore unreadable
    }
  }

  return { isGitRepo: true, head, stashSha, untracked, files };
}

module.exports = { captureRemoteGitWorkingBaseline };
