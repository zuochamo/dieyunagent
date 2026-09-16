'use strict';

const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

/** 并行 worker 同时 git worktree add 会争用 index.lock，串行化创建 */
const worktreeCreateQueue = { tail: Promise.resolve() };

function runWorktreeCreateExclusive(fn) {
  const run = worktreeCreateQueue.tail.then(() => fn());
  worktreeCreateQueue.tail = run.catch(() => {});
  return run;
}

async function gitExec(repoPath, args, opts = {}) {
  try {
    const { stdout, stderr } = await execFileAsync('git', args, {
      cwd: repoPath,
      maxBuffer: 12 * 1024 * 1024,
      windowsHide: true,
      ...opts
    });
    return String(stdout || stderr || '').trim();
  } catch (err) {
    const msg = (err.stderr || err.message || String(err)).trim();
    throw new Error(msg || 'git 命令失败');
  }
}

async function isGitRepo(repoPath) {
  if (!repoPath || !fs.existsSync(repoPath)) return false;
  try {
    await gitExec(repoPath, ['rev-parse', '--git-dir']);
    return true;
  } catch {
    return false;
  }
}

async function listWorktrees(repoPath) {
  if (!(await isGitRepo(repoPath))) return { ok: false, error: '不是 git 仓库', worktrees: [] };
  const out = await gitExec(repoPath, ['worktree', 'list', '--porcelain']);
  const worktrees = [];
  let cur = null;
  for (const line of out.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (cur) worktrees.push(cur);
      cur = { path: line.slice(9).trim(), branch: null, head: null };
    } else if (cur && line.startsWith('branch ')) {
      cur.branch = line.slice(7).trim();
    } else if (cur && line.startsWith('HEAD ')) {
      cur.head = line.slice(5).trim();
    }
  }
  if (cur) worktrees.push(cur);
  return { ok: true, worktrees };
}

/**
 * 解析 git status --porcelain
 * @param {string} out
 */
function parsePorcelainStatus(out) {
  const items = [];
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    const hasPorcelainGap = line.length >= 3 && line[2] === ' ';
    const xy = hasPorcelainGap ? line.slice(0, 2) : `${line[0] || ' '} `;
    let rel = (hasPorcelainGap ? line.slice(3) : line.slice(2)).trim();
    if (rel.includes(' -> ')) rel = rel.split(' -> ').pop().trim();
    rel = rel.replace(/\\/g, '/');
    const deleted = xy[0] === 'D' || xy[1] === 'D';
    const untracked = xy[0] === '?' && xy[1] === '?';
    items.push({
      path: rel,
      status: xy.trim(),
      kind: deleted ? 'deleted' : untracked ? 'untracked' : 'modified'
    });
  }
  return items;
}

async function listWorktreeChanges(wtPath) {
  if (!wtPath || !fs.existsSync(wtPath)) return [];
  if (!(await isGitRepo(wtPath))) return [];
  const out = await gitExec(wtPath, ['status', '--porcelain', '-u']);
  return parsePorcelainStatus(out);
}

/**
 * 为 Agent 角色创建独立 worktree。
 * @param {string} repoPath 工作空间 git 根
 * @param {{ runId: string, roleId: string, baseRef?: string }} opts
 */
async function createAgentWorktree(repoPath, opts) {
  return runWorktreeCreateExclusive(() => createAgentWorktreeInner(repoPath, opts));
}

async function createAgentWorktreeInner(repoPath, opts) {
  const runId = String(opts.runId || '').trim();
  const roleId = String(opts.roleId || 'A').trim();
  if (!runId) throw new Error('缺少 runId');
  if (!(await isGitRepo(repoPath))) {
    return { ok: false, error: '工作空间不是 git 仓库，无法创建 worktree', skipped: true };
  }

  const wtDir = path.join(repoPath, '.dieyun', 'worktrees', runId, roleId);
  fs.mkdirSync(path.dirname(wtDir), { recursive: true });
  if (fs.existsSync(wtDir)) {
    return {
      ok: true,
      path: wtDir,
      branch: `dieyun/agent-${runId}-${roleId}`,
      reused: true
    };
  }

  const branch = `dieyun/agent-${runId}-${roleId}`;
  const baseRef = opts.baseRef || 'HEAD';
  await gitExec(repoPath, ['worktree', 'add', '-B', branch, wtDir, baseRef]);
  return { ok: true, path: wtDir, branch, reused: false };
}

async function removeAgentWorktree(repoPath, wtPath) {
  if (!wtPath) return { ok: true, skipped: true };
  if (!(await isGitRepo(repoPath))) return { ok: false, error: '不是 git 仓库' };
  const resolved = path.resolve(wtPath);
  try {
    await gitExec(repoPath, ['worktree', 'remove', '--force', resolved]);
  } catch (e) {
    if (fs.existsSync(resolved)) {
      fs.rmSync(resolved, { recursive: true, force: true });
      await gitExec(repoPath, ['worktree', 'prune']).catch(() => {});
    } else {
      throw e;
    }
  }
  return { ok: true };
}

async function cleanupRunWorktrees(repoPath, runId) {
  const root = path.join(repoPath, '.dieyun', 'worktrees', runId);
  if (!fs.existsSync(root)) return { ok: true };
  const entries = fs.readdirSync(root, { withFileTypes: true });
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    await removeAgentWorktree(repoPath, path.join(root, ent.name));
  }
  fs.rmSync(root, { recursive: true, force: true });
  return { ok: true };
}

function getDirectorySizeBytes(dirPath) {
  if (!dirPath || !fs.existsSync(dirPath)) return 0;
  let total = 0;
  const stack = [dirPath];
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      const full = path.join(cur, ent.name);
      try {
        if (ent.isDirectory()) stack.push(full);
        else if (ent.isFile()) total += fs.statSync(full).size || 0;
      } catch {
        // ignore unreadable entries
      }
    }
  }
  return total;
}

function getPathMtimeMs(targetPath) {
  if (!targetPath || !fs.existsSync(targetPath)) return 0;
  try {
    return fs.statSync(targetPath).mtimeMs || 0;
  } catch {
    return 0;
  }
}

/**
 * 列出当前工作空间下 Dieyun 管理的 Plan worktree（.dieyun/worktrees/{runId}/…）
 */
async function listManagedWorktreeRuns(repoPath) {
  if (!repoPath || !fs.existsSync(repoPath)) {
    return { ok: false, error: '未设置工作空间', runs: [], totalBytes: 0 };
  }
  const wtRoot = path.join(repoPath, '.dieyun', 'worktrees');
  if (!fs.existsSync(wtRoot)) {
    return { ok: true, repoPath, runs: [], totalBytes: 0 };
  }

  const runs = [];
  let totalBytes = 0;
  for (const ent of fs.readdirSync(wtRoot, { withFileTypes: true })) {
    if (!ent.isDirectory()) continue;
    const runId = ent.name;
    const runRoot = path.join(wtRoot, runId);
    const workers = [];
    let runBytes = 0;
    let runMtime = getPathMtimeMs(runRoot);
    for (const wEnt of fs.readdirSync(runRoot, { withFileTypes: true })) {
      if (!wEnt.isDirectory()) continue;
      const wtPath = path.join(runRoot, wEnt.name);
      const bytes = getDirectorySizeBytes(wtPath);
      const mtimeMs = getPathMtimeMs(wtPath);
      runBytes += bytes;
      runMtime = Math.max(runMtime, mtimeMs);
      workers.push({ roleId: wEnt.name, path: wtPath, bytes, mtimeMs });
    }
    totalBytes += runBytes;
    runs.push({
      runId,
      path: runRoot,
      bytes: runBytes,
      mtimeMs: runMtime,
      workers
    });
  }

  runs.sort((a, b) => Number(b.mtimeMs || 0) - Number(a.mtimeMs || 0));
  return { ok: true, repoPath, runs, totalBytes };
}

/**
 * 按数量/总容量上限清理最旧的 worktree run（可跳过待审 runId）。
 */
async function enforceWorktreeCleanupPolicy(repoPath, opts = {}) {
  const maxRuns = Math.max(0, Number(opts.maxRuns) || 0);
  const maxSizeGb = Math.max(0, Number(opts.maxSizeGb) || 0);
  const protectedRunIds = new Set(
    (Array.isArray(opts.protectedRunIds) ? opts.protectedRunIds : [])
      .map((id) => String(id || '').trim())
      .filter(Boolean)
  );

  const listed = await listManagedWorktreeRuns(repoPath);
  if (!listed.ok) return listed;

  let runs = listed.runs.slice().sort((a, b) => Number(a.mtimeMs || 0) - Number(b.mtimeMs || 0));
  const removed = [];
  const maxBytes = maxSizeGb > 0 ? maxSizeGb * 1024 * 1024 * 1024 : 0;

  function totalBytesOf(list) {
    return list.reduce((sum, r) => sum + (Number(r.bytes) || 0), 0);
  }

  function canRemove(run) {
    return run && run.runId && !protectedRunIds.has(String(run.runId));
  }

  if (maxRuns > 0) {
    while (runs.length > maxRuns) {
      const victim = runs.find(canRemove);
      if (!victim) break;
      await cleanupRunWorktrees(repoPath, victim.runId);
      removed.push(victim.runId);
      runs = runs.filter((r) => r.runId !== victim.runId);
    }
  }

  if (maxBytes > 0) {
    while (runs.length && totalBytesOf(runs) > maxBytes) {
      const victim = runs.find(canRemove);
      if (!victim) break;
      await cleanupRunWorktrees(repoPath, victim.runId);
      removed.push(victim.runId);
      runs = runs.filter((r) => r.runId !== victim.runId);
    }
  }

  const after = await listManagedWorktreeRuns(repoPath);
  return {
    ok: true,
    removed,
    protectedRunIds: [...protectedRunIds],
    ...after
  };
}

/**
 * 汇总一次 Agent 运行在各路 worktree 中的文件变更。
 */
async function previewRunWorktreeChanges(repoPath, runId) {
  const id = String(runId || '').trim();
  if (!id) return { ok: false, error: '缺少 runId', changes: [] };
  if (!(await isGitRepo(repoPath))) {
    return { ok: false, error: '工作空间不是 git 仓库', changes: [] };
  }

  const runRoot = path.join(repoPath, '.dieyun', 'worktrees', id);
  if (!fs.existsSync(runRoot)) {
    return { ok: true, runId: id, changes: [], empty: true };
  }

  const mainFiles = await listWorktreeChanges(repoPath);
  const mainDirty = new Set(mainFiles.map((f) => f.path));

  const changes = [];
  const rolesByPath = new Map();
  for (const ent of fs.readdirSync(runRoot, { withFileTypes: true })) {
    if (!ent.isDirectory()) continue;
    const roleId = ent.name;
    const wtPath = path.join(runRoot, roleId);
    const files = await listWorktreeChanges(wtPath);
    for (const f of files) {
      const key = f.path;
      const entry = {
        changeId: `${roleId}::${key}`,
        repoPath: key,
        kind: f.kind,
        status: f.status,
        roleId,
        worktreePath: wtPath,
        mainDirty: mainDirty.has(key)
      };
      changes.push(entry);
      if (!rolesByPath.has(key)) rolesByPath.set(key, []);
      rolesByPath.get(key).push(roleId);
    }
  }

  for (const ch of changes) {
    const roles = [...new Set(rolesByPath.get(ch.repoPath) || [])];
    if (roles.length > 1) {
      ch.conflict = true;
      ch.conflictRoles = roles;
    }
  }

  changes.sort((a, b) => {
    const byPath = a.repoPath.localeCompare(b.repoPath);
    if (byPath) return byPath;
    return String(a.roleId || '').localeCompare(String(b.roleId || ''), undefined, { numeric: true });
  });
  return { ok: true, runId: id, changes, empty: changes.length === 0 };
}

async function getWorktreeChangeDiff(repoPath, change) {
  const rel = change.repoPath;
  const wtPath = change.worktreePath;
  if (!wtPath || !rel) {
    return { ok: false, added: 0, removed: 0, patch: '', error: '缺少路径' };
  }

  const DIFF_TEXT_LIMIT = 180000;
  const clipDiffText = (text) => {
    const s = String(text || '');
    if (s.length <= DIFF_TEXT_LIMIT) return s;
    return `${s.slice(0, DIFF_TEXT_LIMIT)}\n… (内容过长已截断)`;
  };

  const readWorktreeFile = (basePath, fileRel) => {
    const src = path.join(basePath, fileRel);
    if (!fs.existsSync(src)) return '';
    return fs.readFileSync(src, 'utf8');
  };

  const readHeadFile = async (basePath, fileRel) => {
    try {
      return await gitExec(basePath, ['show', `HEAD:${fileRel}`]);
    } catch {
      return '';
    }
  };

  try {
    if (change.kind === 'untracked') {
      const src = path.join(wtPath, rel);
      if (!fs.existsSync(src)) {
        return {
          ok: true,
          added: 0,
          removed: 0,
          patch: '',
          beforeText: '',
          afterText: '',
          untracked: true
        };
      }
      const content = readWorktreeFile(wtPath, rel);
      const lines = content.split('\n').length;
      const afterText = clipDiffText(content);
      const patch =
        content.length > 12000 ? `${content.slice(0, 12000)}\n… (截断)` : content;
      return {
        ok: true,
        added: lines,
        removed: 0,
        patch,
        beforeText: '',
        afterText,
        untracked: true,
        isNew: true
      };
    }

    if (change.kind === 'deleted') {
      let patch = '';
      try {
        patch = await gitExec(wtPath, ['diff', '--no-color', 'HEAD', '--', rel]);
      } catch {
        patch = '';
      }
      const beforeText = clipDiffText(await readHeadFile(wtPath, rel));
      const removed = patch
        ? patch.split('\n').filter((l) => l.startsWith('-') && !l.startsWith('---')).length
        : beforeText
          ? beforeText.split('\n').length
          : 0;
      const clipped = patch.length > 12000 ? `${patch.slice(0, 12000)}\n… (截断)` : patch;
      return {
        ok: true,
        added: 0,
        removed,
        patch: clipped,
        beforeText,
        afterText: '',
        deleted: true
      };
    }

    const numstat = await gitExec(wtPath, ['diff', '--numstat', 'HEAD', '--', rel]);
    const parts = numstat.split('\t');
    const added = parseInt(parts[0], 10) || 0;
    const removed = parseInt(parts[1], 10) || 0;
    let patch = await gitExec(wtPath, ['diff', '--no-color', 'HEAD', '--', rel]);
    if (patch.length > 12000) patch = `${patch.slice(0, 12000)}\n… (截断)`;
    const beforeText = clipDiffText(await readHeadFile(wtPath, rel));
    const afterText = clipDiffText(readWorktreeFile(wtPath, rel));
    return { ok: true, added, removed, patch, beforeText, afterText };
  } catch (e) {
    return { ok: false, added: 0, removed: 0, patch: '', error: e.message || String(e) };
  }
}

async function applyOneChange(repoPath, change) {
  const rel = change.repoPath;
  const src = path.join(change.worktreePath, rel);
  const dest = path.join(repoPath, rel);

  if (change.kind === 'deleted') {
    if (fs.existsSync(dest)) {
      const st = fs.statSync(dest);
      if (st.isDirectory()) fs.rmSync(dest, { recursive: true, force: true });
      else fs.unlinkSync(dest);
    }
    return { repoPath: rel, action: 'deleted' };
  }

  if (!fs.existsSync(src)) {
    throw new Error(`worktree 中找不到文件: ${rel}`);
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  return { repoPath: rel, action: 'copied' };
}

/**
 * 将选中变更从 worktree 写回主工作区（文件级覆盖，非 git merge）。
 * @param {string} repoPath
 * @param {string} runId
 * @param {{ paths?: string[], changeIds?: string[] }} opts paths 为 repo 相对路径；changeIds 可精确到某个 worker 版本
 */
async function applyRunWorktreeChanges(repoPath, runId, opts = {}) {
  const preview = await previewRunWorktreeChanges(repoPath, runId);
  if (!preview.ok) return preview;
  if (!preview.changes.length) {
    return { ok: true, applied: 0, skipped: 0, errors: [], empty: true };
  }

  const selected = opts.paths && opts.paths.length ? new Set(opts.paths.map(String)) : null;
  const selectedIds = opts.changeIds && opts.changeIds.length ? new Set(opts.changeIds.map(String)) : null;
  let applied = 0;
  let skipped = 0;
  const errors = [];
  const actions = [];

  if (selectedIds) {
    const selectedByPath = new Map();
    for (const ch of preview.changes) {
      const id = ch.changeId || `${ch.roleId}::${ch.repoPath}`;
      if (!selectedIds.has(id)) continue;
      const count = selectedByPath.get(ch.repoPath) || 0;
      selectedByPath.set(ch.repoPath, count + 1);
    }
    for (const [repoPath, count] of selectedByPath) {
      if (count > 1) {
        return {
          ok: false,
          applied: 0,
          skipped: 0,
          errors: [{ repoPath, error: '同一文件选择了多个 worker 版本，请只保留一个' }],
          actions: [],
          runId: preview.runId
        };
      }
    }
  }
  for (const ch of preview.changes) {
    if (selectedIds && !selectedIds.has(ch.changeId || `${ch.roleId}::${ch.repoPath}`)) {
      skipped += 1;
      continue;
    }
    if (!selectedIds && selected && !selected.has(ch.repoPath)) {
      skipped += 1;
      continue;
    }
    if (ch.conflict && !opts.forceConflict) {
      errors.push({
        repoPath: ch.repoPath,
        error: `多路 worktree 同时修改（${(ch.conflictRoles || []).join(' vs ')}）`
      });
      continue;
    }
    try {
      const r = await applyOneChange(repoPath, ch);
      actions.push(r);
      applied += 1;
    } catch (e) {
      errors.push({ repoPath: ch.repoPath, error: e.message || String(e) });
    }
  }

  return {
    ok: errors.length === 0,
    applied,
    skipped,
    errors,
    actions,
    runId: preview.runId
  };
}

module.exports = {
  isGitRepo,
  gitExec,
  parsePorcelainStatus,
  listWorktrees,
  createAgentWorktree,
  removeAgentWorktree,
  cleanupRunWorktrees,
  getDirectorySizeBytes,
  listManagedWorktreeRuns,
  enforceWorktreeCleanupPolicy,
  listWorktreeChanges,
  previewRunWorktreeChanges,
  applyRunWorktreeChanges,
  getWorktreeChangeDiff
};
