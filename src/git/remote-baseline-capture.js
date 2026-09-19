'use strict';

const path = require('path');
const { normalizeRemotePath } = require('../workspace/target');
const {
  createGitTarget,
  encodeWorktreeContent,
  WORKTREE_SNAPSHOT_MAX_BYTES
} = require('./git-target');
const { readGitStatus, toLegacyStatusItem } = require('./status');

const MAX_BASELINE_FILES = 120;

/**
 * SSH 工作区：捕获回合开始前远端 git 脏文件（与 captureGitWorkingBaseline 对齐）。
 *
 * git 调用走 createGitTarget（与源码管理同一套远端执行），
 * 文件内容仍走 SFTP：`head -c` 拿到的是已解码字符串，二进制文件会失真，
 * 而回撤基线必须拿到精确字节（按 utf8 / base64 分别落档）。
 *
 * @param {ReturnType<import('../ssh/session-manager').createSshSessionManager>} ssh
 * @param {string} remoteRoot
 * @returns {Promise<{ isGitRepo: boolean, head: string, files: Record<string, { before: string|null, encoding: 'utf8'|'base64', remote: true }> }>}
 */
async function captureRemoteGitWorkingBaseline(ssh, remoteRoot) {
  const empty = { isGitRepo: false, head: '', files: {} };
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
    return { isGitRepo: true, head, files: {} };
  }

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

  return { isGitRepo: true, head, files };
}

module.exports = { captureRemoteGitWorkingBaseline };
