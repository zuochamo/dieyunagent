'use strict';

const path = require('path');
const { normalizeRemotePath } = require('../workspace/target');
const { parsePorcelainStatus } = require('./worktree-service');

const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_BASELINE_FILES = 120;

/**
 * SSH 工作区：捕获回合开始前远端 git 脏文件（与 captureGitWorkingBaseline 对齐）。
 * @param {ReturnType<import('../ssh/session-manager').createSshSessionManager>} ssh
 * @param {string} remoteRoot
 * @returns {Promise<{ isGitRepo: boolean, head: string, files: Record<string, { before: string|null, encoding: 'utf8'|'base64', remote: true }> }>}
 */
async function captureRemoteGitWorkingBaseline(ssh, remoteRoot) {
  const empty = { isGitRepo: false, head: '', files: {} };
  if (!ssh || !remoteRoot) return empty;

  const root = normalizeRemotePath(remoteRoot);

  let check;
  try {
    check = await ssh.exec('git rev-parse --git-dir', root, 20000);
  } catch {
    return empty;
  }
  if (!check || check.code !== 0) return empty;

  let head = '';
  try {
    const headR = await ssh.exec('git rev-parse HEAD', root, 20000);
    if (headR && headR.code === 0) head = String(headR.stdout || '').trim();
  } catch {
    // ignore
  }

  let statusOut = '';
  try {
    const st = await ssh.exec('git status --porcelain -u', root, 60000);
    if (!st || st.code !== 0) return { isGitRepo: true, head, files: {} };
    statusOut = String(st.stdout || '');
  } catch {
    return { isGitRepo: true, head, files: {} };
  }

  /** @type {Record<string, { before: string|null, encoding: 'utf8'|'base64', remote: true }>} */
  const files = {};
  const items = parsePorcelainStatus(statusOut);

  for (const item of items) {
    if (Object.keys(files).length >= MAX_BASELINE_FILES) break;
    const rel = item.path.replace(/\\/g, '/');
    if (!rel) continue;

    if (item.kind === 'deleted') {
      files[rel] = { before: null, encoding: 'utf8', remote: true };
      continue;
    }

    const full = path.posix.join(root, rel);
    try {
      const { buf, truncated } = await ssh.sftpReadFile(full, MAX_FILE_BYTES + 1, 0);
      if (truncated || buf.length > MAX_FILE_BYTES) continue;
      const isBinary = buf.includes(0);
      files[rel] = isBinary
        ? { before: buf.toString('base64'), encoding: 'base64', remote: true }
        : { before: buf.toString('utf8'), encoding: 'utf8', remote: true };
    } catch {
      // ignore unreadable
    }
  }

  return { isGitRepo: true, head, files };
}

module.exports = { captureRemoteGitWorkingBaseline };
