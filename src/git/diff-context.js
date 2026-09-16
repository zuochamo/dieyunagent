'use strict';

const path = require('path');
const { isGitRepo, gitExec } = require('./worktree-service');

const MAX_DIFF_CHARS = 12000;
const MAX_FILES = 8;
const TEXT_EXT =
  /\.(tsx?|jsx?|mjs|cjs|vue|py|go|rs|java|cs|cpp|c|h|hpp|sql|md|json|yaml|yml|toml|sh|bash|ps1|css|scss|html?)$/i;

function shellQuoteSingle(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

function isTextLikePath(relPath) {
  return TEXT_EXT.test(String(relPath || ''));
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

function parseStatusChangedEntries(statusOut) {
  const changed = [];
  const seen = new Set();
  for (const line of String(statusOut || '').split('\n')) {
    if (line.length < 2) continue;
    const hasPorcelainGap = line.length >= 3 && line[2] === ' ';
    const xy = hasPorcelainGap ? line.slice(0, 2) : `${line[0] || ' '} `;
    let rel = (hasPorcelainGap ? line.slice(3) : line.slice(2)).trim();
    if (rel.includes(' -> ')) rel = rel.split(' -> ').pop().trim();
    rel = rel.replace(/\\/g, '/');
    if (!rel || seen.has(rel)) continue;
    seen.add(rel);
    changed.push({ path: rel, untracked: xy[0] === '?' && xy[1] === '?' });
  }
  return changed;
}

function parseStatusChangedPaths(statusOut) {
  return parseStatusChangedEntries(statusOut).map((entry) => entry.path);
}

async function remoteGitExec(root, sshExec, args, timeoutMs = 20000) {
  if (typeof sshExec !== 'function') {
    throw new Error('remote git exec unavailable');
  }
  const cmd = ['git', ...args.map(shellQuoteSingle)].join(' ');
  const r = await sshExec(cmd, root, timeoutMs);
  const code = Number(r && r.code);
  if (Number.isFinite(code) && code !== 0) {
    throw new Error(String((r && r.stderr) || (r && r.stdout) || 'remote git command failed').trim());
  }
  return String((r && r.stdout) || (r && r.stderr) || '').trim();
}

async function localGitMaybe(root, args) {
  try {
    return await gitExec(root, args);
  } catch {
    return '';
  }
}

async function remoteGitMaybe(root, sshExec, args, timeoutMs = 30000) {
  try {
    return await remoteGitExec(root, sshExec, args, timeoutMs);
  } catch {
    return '';
  }
}

async function readUntrackedText(root, rel, opts) {
  const maxBytes = 12000;
  if (opts.remote) {
    const script = `head -c ${maxBytes + 1} -- ${shellQuoteSingle(rel)} 2>/dev/null || true`;
    const r = await opts.sshExec(script, root, 20000);
    return String((r && r.stdout) || '');
  }
  const fs = require('fs');
  const filePath = path.join(root, rel);
  if (!fs.existsSync(filePath)) return '';
  return fs.readFileSync(filePath, 'utf8').slice(0, maxBytes + 1);
}

async function buildDiffText(root, entries, opts) {
  const tracked = entries.filter((entry) => !entry.untracked).map((entry) => entry.path);
  const chunks = [];
  if (tracked.length) {
    const diff = opts.remote
      ? await remoteGitMaybe(root, opts.sshExec, ['diff', 'HEAD', '--unified=3', '--', ...tracked], 30000)
      : await localGitMaybe(root, ['diff', 'HEAD', '--unified=3', '--', ...tracked]);
    if (diff.trim()) chunks.push(diff.trim());
  }
  for (const entry of entries.filter((item) => item.untracked)) {
    if (!isTextLikePath(entry.path)) continue;
    const text = await readUntrackedText(root, entry.path, opts);
    if (!text) continue;
    const clipped = text.length > 12000 ? `${text.slice(0, 12000)}\n...(truncated)` : text;
    const body = clipped
      .split(/\r?\n/)
      .map((line) => (line ? `+${line}` : '+'))
      .join('\n');
    chunks.push(
      [
        `diff --git a/${entry.path} b/${entry.path}`,
        'new file mode 100644',
        '--- /dev/null',
        `+++ b/${entry.path}`,
        '@@ -0,0 +1 @@',
        body
      ].join('\n')
    );
  }
  return chunks.join('\n\n');
}

/**
 * @param {string} repoPath
 * @param {string[]} focusPaths absolute or relative paths to prioritize
 * @param {{ maxChars?: number, maxFiles?: number, sshExec?: Function, remote?: boolean }} opts
 */
async function getWorkspaceGitDiffContext(repoPath, focusPaths = [], opts = {}) {
  const root = String(repoPath || '').trim();
  const remote = !!opts.remote && typeof opts.sshExec === 'function';
  if (!root || (!remote && !(await isGitRepo(root)))) {
    return { ok: false, reason: 'not_git', text: '' };
  }

  const maxChars = opts.maxChars != null ? opts.maxChars : MAX_DIFF_CHARS;
  const maxFiles = opts.maxFiles != null ? opts.maxFiles : MAX_FILES;

  let statusOut = '';
  try {
    statusOut = remote
      ? await remoteGitExec(root, opts.sshExec, ['status', '--porcelain', '-u'])
      : await gitExec(root, ['status', '--porcelain', '-u']);
  } catch {
    return { ok: false, reason: 'status_failed', text: '' };
  }

  const changedEntries = parseStatusChangedEntries(statusOut);
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
    diffText = await buildDiffText(root, pickedEntries, { remote, sshExec: opts.sshExec });
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
  if (!root || (!remote && !(await isGitRepo(root)))) {
    return [];
  }
  const maxFiles = opts.maxFiles != null ? opts.maxFiles : 16;
  let statusOut = '';
  try {
    statusOut = remote
      ? await remoteGitExec(root, opts.sshExec, ['status', '--porcelain', '-u'])
      : await gitExec(root, ['status', '--porcelain', '-u']);
  } catch {
    return [];
  }
  const out = [];
  for (const rel of parseStatusChangedPaths(statusOut)) {
    if (!isTextLikePath(rel)) continue;
    out.push(remote ? `${root.replace(/\/+$/, '')}/${rel}` : path.join(root, rel));
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
