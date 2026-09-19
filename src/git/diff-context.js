'use strict';

const path = require('path');
const { createGitTarget } = require('./git-target');
const { readGitStatus } = require('./status');
const { synthesizeNewFilePatch } = require('./diff-text');

const MAX_DIFF_CHARS = 12000;
const MAX_FILES = 8;
const TEXT_EXT =
  /\.(tsx?|jsx?|mjs|cjs|vue|py|go|rs|java|cs|cpp|c|h|hpp|sql|md|json|yaml|yml|toml|sh|bash|ps1|css|scss|html?)$/i;

const UNTRACKED_TEXT_MAX_BYTES = 12000;

function isTextLikePath(relPath) {
  return TEXT_EXT.test(String(relPath || ''));
}

/**
 * 取本次调用的 git 目标。调用方已按工作区类型给出 remote/sshExec，
 * 这里统一收敛成 git-target，避免再出现「本地一份、远端一份」的实现分叉。
 * @param {string} root
 * @param {{ remote?: boolean, sshExec?: Function, gitTarget?: object }} opts
 */
function resolveDiffGitTarget(root, opts) {
  const o = opts || {};
  if (o.gitTarget) return o.gitTarget;
  if (o.remote && typeof o.sshExec === 'function') {
    return createGitTarget({ kind: 'ssh', root, sshExec: o.sshExec });
  }
  return createGitTarget({ kind: 'local', root });
}

function normalizeRelPath(repoPath, filePath) {
  const repo = path.resolve(String(repoPath || ''));
  const abs = path.resolve(String(filePath || ''));
  const rel = path.relative(repo, abs).replace(/\\/g, '/');
  if (!rel || rel.startsWith('..')) return null;
  return rel;
}

function normalizeRemoteRelPath(root, filePath) {
  const r = String(root || '/').replace(/\\/g, '/').replace(/\/+$/, '') || '/';
  const f = String(filePath || '').replace(/\\/g, '/');
  if (!f) return null;
  if (f.startsWith('/')) {
    const prefix = r === '/' ? '/' : `${r}/`;
    if (f === r) return null;
    if (!f.startsWith(prefix)) return null;
    return f.slice(prefix.length).replace(/^\/+/, '') || null;
  }
  return f.replace(/^\/+/, '') || null;
}

/** 未跟踪文件读正文：git 不产出 patch，要自己拼「新增」diff */
async function readUntrackedText(git, rel) {
  try {
    const r = await git.readText(rel, { maxBytes: UNTRACKED_TEXT_MAX_BYTES });
    return r && r.text ? String(r.text) : '';
  } catch {
    return '';
  }
}

async function buildDiffText(git, entries) {
  const tracked = entries.filter((entry) => !entry.untracked).map((entry) => entry.path);
  const chunks = [];
  if (tracked.length) {
    const diff = await git.textOrEmpty(['diff', 'HEAD', '--unified=3', '--', ...tracked], {
      timeoutMs: 30000
    });
    if (diff.trim()) chunks.push(diff.trim());
  }
  for (const entry of entries.filter((item) => item.untracked)) {
    if (!isTextLikePath(entry.path)) continue;
    const text = await readUntrackedText(git, entry.path);
    if (!text) continue;
    chunks.push(synthesizeNewFilePatch(entry.path, text, { maxChars: UNTRACKED_TEXT_MAX_BYTES }));
  }
  return chunks.join('\n\n');
}

/**
 * @param {string} repoPath
 * @param {string[]} focusPaths absolute or relative paths to prioritize
 * @param {{ maxChars?: number, maxFiles?: number, sshExec?: Function, remote?: boolean, gitTarget?: object }} opts
 */
async function getWorkspaceGitDiffContext(repoPath, focusPaths = [], opts = {}) {
  const root = String(repoPath || '').trim();
  const remote = !!opts.remote && typeof opts.sshExec === 'function';
  if (!root) return { ok: false, reason: 'not_git', text: '' };

  const git = resolveDiffGitTarget(root, opts);

  let status;
  try {
    status = await readGitStatus(git, { untrackedMode: 'normal' });
  } catch {
    return { ok: false, reason: 'status_failed', text: '' };
  }
  if (!status.isRepo) return { ok: false, reason: 'not_git', text: '' };

  const maxChars = opts.maxChars != null ? opts.maxChars : MAX_DIFF_CHARS;
  const maxFiles = opts.maxFiles != null ? opts.maxFiles : MAX_FILES;

  const changedEntries = status.entries;
  const changed = changedEntries.map((entry) => entry.path);

  if (!changed.length) {
    return { ok: true, reason: 'clean', text: '', files: [] };
  }

  const focusRel = [];
  for (const p of focusPaths || []) {
    const rel = remote ? normalizeRemoteRelPath(root, p) : normalizeRelPath(root, p);
    if (rel) focusRel.push(rel);
  }

  const prioritized = [];
  const rest = [];
  for (const rel of changed) {
    if (!isTextLikePath(rel)) continue;
    if (focusRel.some((f) => f === rel || rel.startsWith(`${f}/`) || f.startsWith(`${rel}/`))) {
      prioritized.push(rel);
    } else {
      rest.push(rel);
    }
  }
  const pick = [...new Set([...prioritized, ...rest])].slice(0, maxFiles);
  const pickSet = new Set(pick);
  const pickedEntries = changedEntries.filter((entry) => pickSet.has(entry.path));
  if (!pick.length) {
    return { ok: true, reason: 'no_text_changes', text: '', files: changed.slice(0, maxFiles) };
  }

  let diffText = '';
  try {
    diffText = await buildDiffText(git, pickedEntries);
  } catch {
    return { ok: false, reason: 'diff_failed', text: '', files: pick };
  }

  if (!diffText.trim()) {
    return { ok: true, reason: 'empty_diff', text: '', files: pick };
  }

  let body = diffText.trim();
  let truncated = false;
  if (body.length > maxChars) {
    body = `${body.slice(0, maxChars)}\n\n…（git diff 已截断，原文 ${diffText.length} 字符）`;
    truncated = true;
  }

  const text = [
    '【Git 变更 · 相对 HEAD】',
    `仓库：${root}`,
    `文件：${pick.join(', ')}`,
    '说明：以下为未提交改动（含 staged/unstaged）；修 bug 时结合 diagnostics 与当前编辑器内容。',
    '',
    '```diff',
    body,
    '```'
  ].join('\n');

  return { ok: true, reason: truncated ? 'truncated' : 'ok', text, files: pick };
}

async function getWorkspaceGitChangedAbsPaths(repoPath, opts = {}) {
  const root = String(repoPath || '').trim();
  const remote = !!opts.remote && typeof opts.sshExec === 'function';
  if (!root) return [];

  const git = resolveDiffGitTarget(root, opts);

  let status;
  try {
    status = await readGitStatus(git, { untrackedMode: 'normal' });
  } catch {
    return [];
  }
  if (!status.isRepo) return [];

  const maxFiles = opts.maxFiles != null ? opts.maxFiles : 16;
  const out = [];
  for (const entry of status.entries) {
    if (!isTextLikePath(entry.path)) continue;
    out.push(
      remote
        ? `${root.replace(/\/+$/, '')}/${entry.path}`
        : path.join(root, entry.path)
    );
    if (out.length >= maxFiles) break;
  }
  return out;
}

module.exports = {
  getWorkspaceGitDiffContext,
  getWorkspaceGitChangedAbsPaths,
  MAX_DIFF_CHARS,
  MAX_FILES
};
