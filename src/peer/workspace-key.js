// @ts-check
'use strict';

/**
 * 「同一个项目」的判定依据（**唯一来源**）。
 *
 * 跨机器比较绝对路径是错的：`E:\dieyunagent` 与 `/run/media/x/dieyunagent` 是同一个项目，
 * 但 `D:\a\app` 与 `D:\b\app` 不是。所以：
 * - 有 git remote（origin）时用 remote URL —— 这是天然的项目身份；
 * - 没有 remote（纯本地仓库 / 非 git 目录）时退到「仓库根目录名 + 首提提交 hash」，
 *   再没有就退到路径指纹（此时只对同机实例有意义，跨机必然不等，这是如实的结果）。
 *
 * 不做 git 子进程：只读 `.git/config` 与 `.git/HEAD`，几十字节的同步读，
 * 在「列 peer / 发消息」这类高频路径上绝不能 fork 一个 git。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function readText(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
}

/**
 * 解析 `.git/config` 里 `[remote "origin"] url = ...`（也接受没有 remote 名限定的 `[remote "upstream"]`）。
 * 只取第一个出现的 remote，避免多 remote 时随机抖动。
 * @param {string} workspacePath
 */
function readGitRemoteUrl(workspacePath) {
  const root = String(workspacePath || '');
  if (!root) return '';
  const gitDir = resolveGitDir(root);
  if (!gitDir) return '';
  const cfg = readText(path.join(gitDir, 'config'));
  if (!cfg) return '';
  let current = '';
  for (const line of cfg.split(/\r?\n/)) {
    const section = line.match(/^\s*\[remote\s+"([^"]+)"\]\s*$/);
    if (section) {
      current = section[1];
      continue;
    }
    if (/^\s*\[/.test(line)) {
      current = '';
      continue;
    }
    const url = line.match(/^\s*url\s*=\s*(.+?)\s*$/);
    if (url && current) return normalizeRemoteUrl(url[1]);
  }
  return '';
}

/** 把 `git@host:org/repo.git` / `https://host/org/repo.git` 归一成同一个 key 形态。 */
function normalizeRemoteUrl(raw) {
  let s = String(raw || '').trim();
  if (!s) return '';
  s = s.replace(/^ssh:\/\//i, '');
  s = s.replace(/^git@([^:]+):/i, '$1/');
  s = s.replace(/^[a-z]+:\/\//i, '');
  s = s.replace(/\/+$/, '');
  s = s.replace(/\.git$/i, '');
  return s.toLowerCase();
}

/**
 * worktree 场景下 `.git` 可能是文件（`gitdir: ...`），要顺着找到真正的 git 目录。
 *
 * 注意 worktree 的 gitdir 是 `<主仓库>/.git/worktrees/<name>`：它自己没有 `config`，
 * 真正的 remote 在主仓库 git 目录里，由 `commondir` 指过去（通常 `../..`）。
 * 不跟这一跳的话，多 agent worktree 并行时两个 worktree 会被判成不同项目。
 * @param {string} workspacePath
 */
function resolveGitDir(workspacePath) {
  const root = String(workspacePath || '');
  if (!root) return '';
  const dotGit = path.join(root, '.git');
  try {
    const stat = fs.statSync(dotGit);
    if (stat.isDirectory()) return dotGit;
    if (stat.isFile()) {
      const content = readText(dotGit);
      const m = content.match(/^gitdir:\s*(.+)$/m);
      if (m) {
        const resolved = m[1].trim();
        const gitDir = path.isAbsolute(resolved) ? resolved : path.resolve(root, resolved);
        return followCommonDir(gitDir);
      }
    }
  } catch {
    return '';
  }
  return '';
}

/** worktree 的 gitdir → 主仓库 git 目录（有 `commondir` 就跳过去，没有就原样返回）。 */
function followCommonDir(gitDir) {
  const common = readText(path.join(gitDir, 'commondir')).trim();
  if (!common) return gitDir;
  return path.resolve(gitDir, common);
}

function hashShort(input) {
  return crypto.createHash('sha1').update(String(input || '')).digest('hex').slice(0, 12);
}

/**
 * 项目身份 key（12 位十六进制）。空路径返回空串。
 * @param {string} workspacePath
 */
function workspaceKeyFor(workspacePath) {
  const root = String(workspacePath || '').trim();
  if (!root) return '';
  const remote = readGitRemoteUrl(root);
  if (remote) return hashShort(`git:${remote}`);
  const gitDir = resolveGitDir(root);
  if (gitDir) return hashShort(`repo:${path.basename(path.resolve(root)).toLowerCase()}`);
  return hashShort(`path:${path.resolve(root).toLowerCase()}`);
}

/**
 * 线上宣告用的 workspace 三元组：`key` 用于判定同一项目，`name/path` 只用于展示。
 * @param {string} workspacePath
 */
function workspaceInfoFor(workspacePath) {
  const root = String(workspacePath || '').trim();
  if (!root) return { key: '', name: '', path: '' };
  const resolved = path.resolve(root);
  return {
    key: workspaceKeyFor(resolved),
    name: path.basename(resolved),
    path: resolved
  };
}

module.exports = {
  normalizeRemoteUrl,
  readGitRemoteUrl,
  workspaceKeyFor,
  workspaceInfoFor
};
