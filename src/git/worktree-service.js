'use strict';

const { execFile } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

/** 并行 worker 同时 git worktree add 会争用 index.lock，串行化创建 */
const worktreeCreateQueue = { tail: Promise.resolve() };

/**
 * 固定提交身份。绝不依赖用户全局 git config：新机器 / CI 上 user.email 常为空，
 * 会导致 worktree 内 commit 直接失败，而失败又发生在"产出即将落盘"的关键路径上。
 */
const COMMIT_IDENTITY = [
  '-c',
  'user.name=Dieyun Agent',
  '-c',
  'user.email=agent@dieyun.local'
];

const WORKTREES_DIR = 'worktrees';
const BACKUP_DIR = 'backup';

/** worktree 元数据（各 role 的基线 sha）。放在 run 根，随 run 一起被清理。 */
const RUN_META_FILE = '.dieyun-run-meta.json';

/** 与 .gitignore 中 .dieyun/ 前缀保持一致 */
function dieyunPath(repoPath, ...segs) {
  return path.join(repoPath, '.dieyun', ...segs);
}

function runRootOf(repoPath, runId) {
  return dieyunPath(repoPath, WORKTREES_DIR, String(runId || '').trim());
}

/**
 * 统一变更种类词表：added | modified | deleted。
 * 下游（diff / apply / UI 标签）只认这三个值。
 * @param {string} kind
 */
function normalizeChangeKind(kind) {
  const k = String(kind || '').trim().toLowerCase();
  if (k === 'untracked' || k === 'added' || k === 'a' || k === '??' || k === 'new') return 'added';
  if (k === 'deleted' || k === 'd') return 'deleted';
  return 'modified';
}

function isNewKind(kind) {
  return normalizeChangeKind(kind) === 'added';
}

function sha256FileSync(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  try {
    if (!fs.statSync(filePath).isFile()) return null;
    return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
  } catch {
    return null;
  }
}

async function readHeadSha(repoPath) {
  try {
    return (await gitExec(repoPath, ['rev-parse', 'HEAD'])).trim() || null;
  } catch {
    return null;
  }
}

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
  return parsePorcelainStatus(out).map((it) => ({ ...it, kind: normalizeChangeKind(it.kind) }));
}

/**
 * 列出 worktree 相对「创建基线」的变更。
 *
 * 为什么不能只用 git status：worktree 里的子 Agent 完全可能自己跑 git commit
 * （改代码型 agent 的常见行为）。一旦它提交，`git status` 与 `git diff HEAD` 双双为空，
 * 它干的活就会在预览里凭空消失、应用变成空操作——静默丢产出。
 * 所以基线必须是创建时的 base sha，而非浮动的 HEAD。
 *
 * `git diff <base>` 覆盖「已提交 + 未暂存 + 已暂存」，但不含未跟踪文件，故补 `ls-files --others`。
 * @param {string} wtPath
 * @param {string|null} baseSha
 */
async function listWorktreeChangesVsBase(wtPath, baseSha) {
  if (!wtPath || !fs.existsSync(wtPath)) return [];
  if (!(await isGitRepo(wtPath))) return [];

  const byPath = new Map();

  if (baseSha) {
    let out = '';
    try {
      out = await gitExec(wtPath, ['diff', '--name-status', '--no-renames', baseSha]);
    } catch {
      out = '';
    }
    for (const raw of out.split('\n')) {
      const line = raw.trim();
      if (!line) continue;
      const tab = line.indexOf('\t');
      if (tab <= 0) continue;
      const code = line.slice(0, tab).trim().toUpperCase();
      const rel = line.slice(tab + 1).trim().replace(/\\/g, '/');
      if (!rel) continue;
      byPath.set(rel, {
        path: rel,
        status: code,
        kind: code === 'D' ? 'deleted' : code === 'A' ? 'added' : 'modified'
      });
    }
  }

  let untracked = '';
  try {
    untracked = await gitExec(wtPath, ['ls-files', '--others', '--exclude-standard']);
  } catch {
    untracked = '';
  }
  for (const raw of untracked.split('\n')) {
    const rel = raw.trim().replace(/\\/g, '/');
    if (!rel) continue;
    // diff 已判定为 added 的保留 added，其余未跟踪即 added
    if (!byPath.has(rel)) byPath.set(rel, { path: rel, status: '??', kind: 'added' });
  }

  return [...byPath.values()];
}

function readRunMeta(repoPath, runId) {
  const file = path.join(runRootOf(repoPath, runId), RUN_META_FILE);
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (parsed && typeof parsed === 'object') return parsed;
  } catch {
    // 缺失/损坏都按"没有基线"处理，由调用方回退到 HEAD
  }
  return { runId: String(runId || ''), bases: {} };
}

function writeRunMeta(repoPath, runId, meta) {
  const root = runRootOf(repoPath, runId);
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, RUN_META_FILE), JSON.stringify(meta, null, 2), 'utf8');
}

/**
 * 记录某 role 的创建基线。
 * keepExisting=true 时只在缺失时补写，避免复用 worktree 时把真实基线覆盖成当前 HEAD
 * （那会让该 role 之前的产出从预览里消失）。
 */
function recordRunBase(repoPath, runId, roleId, baseSha, opts = {}) {
  if (!baseSha) return;
  const meta = readRunMeta(repoPath, runId);
  if (!meta.bases || typeof meta.bases !== 'object') meta.bases = {};
  if (opts.keepExisting && meta.bases[roleId]) return;
  meta.bases[roleId] = String(baseSha).trim();
  meta.runId = String(runId || '');
  meta.updatedAt = new Date().toISOString();
  writeRunMeta(repoPath, runId, meta);
}

/**
 * 取某个 role 的基线 sha：优先 run 元数据，其次 worktree 分支的 merge-base，最后 HEAD。
 */
async function resolveWorktreeBase(repoPath, runId, roleId, wtPath) {
  const meta = readRunMeta(repoPath, runId);
  const recorded = meta.bases && meta.bases[roleId];
  if (recorded) {
    try {
      await gitExec(repoPath, ['cat-file', '-e', `${recorded}^{commit}`]);
      return recorded;
    } catch {
      // 基线对象已不可达（如 gc 后被裁），退回 merge-base
    }
  }
  // 老 run（本次改动前创建）没有元数据：worktree 分支与主分支的 merge-base 就是真实基线。
  // 子 Agent 在 worktree 内自行 commit 也不会影响分叉点，所以这个回退是可靠的。
  const branch = `dieyun/agent-${runId}-${roleId}`;
  try {
    const mb = await gitExec(repoPath, ['merge-base', 'HEAD', branch]);
    if (mb) return mb.trim();
  } catch {
    // ignore
  }
  return readHeadSha(wtPath);
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

  const wtDir = path.join(runRootOf(repoPath, runId), roleId);
  fs.mkdirSync(path.dirname(wtDir), { recursive: true });

  const branch = `dieyun/agent-${runId}-${roleId}`;
  const baseRef = opts.baseRef || 'HEAD';
  // 先把 baseRef 解析成具体 sha 再落盘。存 ref 名会让基线随后续 HEAD 漂移，
  // 那样"相对基线的变更"就失去了确定含义。
  let baseSha = null;
  try {
    baseSha = (await gitExec(repoPath, ['rev-parse', `${baseRef}^{commit}`])).trim() || null;
  } catch {
    baseSha = await readHeadSha(repoPath);
  }

  if (fs.existsSync(wtDir)) {
    recordRunBase(repoPath, runId, roleId, baseSha, { keepExisting: true });
    return { ok: true, path: wtDir, branch, baseSha, reused: true };
  }

  await gitExec(repoPath, ['worktree', 'add', '-B', branch, wtDir, baseSha || baseRef]);
  recordRunBase(repoPath, runId, roleId, baseSha);
  return { ok: true, path: wtDir, branch, baseSha, reused: false };
}

/** 取 worktree 当前分支名（detached 或失败返回 null）。 */
async function resolveWorktreeBranch(wtPath) {
  try {
    const name = (await gitExec(wtPath, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
    return name && name !== 'HEAD' ? name : null;
  } catch {
    return null;
  }
}

/**
 * 把 worktree 中的产出提交到它自己的分支，形成存档点。
 *
 * 这是「清理不再毁数据」与「产出可追责」的前提：只要产出已提交，
 * worktree 目录即便被 --force 删除，分支仍持有全部内容，可随时 diff / cherry-pick / 恢复。
 */
async function commitWorktreeChanges(repoPath, wtPath, opts = {}) {
  const resolved = wtPath ? path.resolve(wtPath) : '';
  if (!resolved || !fs.existsSync(resolved)) {
    return { ok: false, committed: false, error: 'worktree 不存在' };
  }
  if (!(await isGitRepo(resolved))) {
    return { ok: false, committed: false, error: 'worktree 不是 git 仓库' };
  }

  const branch = await resolveWorktreeBranch(resolved);
  const previousSha = await readHeadSha(resolved);
  const pending = await listWorktreeChanges(resolved);
  if (!pending.length) {
    return { ok: true, committed: false, reason: 'no_changes', sha: previousSha, branch, files: [] };
  }

  const runId = String(opts.runId || '').trim();
  const roleId = String(opts.roleId || path.basename(resolved)).trim();
  const message =
    String(opts.message || '').trim() ||
    `dieyun(agent): ${runId ? `run ${runId}` : 'worktree'} / ${roleId} 产出快照`;

  await gitExec(resolved, ['add', '-A']);
  await gitExec(resolved, [...COMMIT_IDENTITY, 'commit', '--no-verify', '-m', message]);
  const sha = await readHeadSha(resolved);

  return {
    ok: true,
    committed: true,
    sha,
    previousSha,
    branch,
    message,
    files: pending.map((f) => f.path)
  };
}

/**
 * 移除 worktree。
 * 默认拒绝删除仍有未提交产出的 worktree——原来的裸 `--force` + `rmSync`
 * 会连存档一起撕掉，是这套流程里唯一真正会丢代码的操作。
 * @param {{ allowDiscardUncommitted?: boolean, deleteBranch?: boolean }} opts
 */
async function removeAgentWorktree(repoPath, wtPath, opts = {}) {
  if (!wtPath) return { ok: true, skipped: true };
  if (!(await isGitRepo(repoPath))) return { ok: false, error: '不是 git 仓库' };
  const resolved = path.resolve(wtPath);
  const exists = fs.existsSync(resolved);

  let pending = [];
  if (exists) {
    try {
      pending = await listWorktreeChanges(resolved);
    } catch {
      pending = [];
    }
  }
  const branch = exists ? await resolveWorktreeBranch(resolved) : null;

  if (pending.length && !opts.allowDiscardUncommitted) {
    return {
      ok: false,
      removed: false,
      needsCommit: true,
      branch,
      error: `worktree 仍有 ${pending.length} 个未提交变更，已阻止删除以免丢失产出`,
      pending: pending.map((f) => f.path)
    };
  }

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

  // 分支默认保留：worktree 目录已删，分支是产出唯一的存档。
  // 需显式 deleteBranch 才回收（且只回收本工具自己建的命名空间）。
  if (opts.deleteBranch && branch && branch.startsWith('dieyun/agent-')) {
    await gitExec(repoPath, ['branch', '-D', branch]).catch(() => {});
  }

  return { ok: true, removed: true, branch, discarded: pending.length };
}

/**
 * 清理一个 run 下的全部 worktree。
 *
 * 默认「先归档再删」：删除前把产出 commit 到该 role 的分支。
 * 这样「产出不丢」和「磁盘能回收」不再互斥——否则加了未提交拦截之后，
 * 正常流程（子 Agent 从不 commit）会永远清不掉，磁盘只增不减。
 *
 * 若调用方已确认用户处置过产出（应用 / 显式放弃），可 archive:false 跳过归档；
 * 放弃场景仍需 allowDiscardUncommitted:true 才允许丢弃未提交内容。
 *
 * 任一路仍被拦截时整体保留（不 rmSync 根目录），避免元数据与兄弟 worktree 被连带清掉。
 * @param {{ archive?: boolean, allowDiscardUncommitted?: boolean, deleteBranches?: boolean }} opts
 */
async function cleanupRunWorktrees(repoPath, runId, opts = {}) {
  const root = runRootOf(repoPath, runId);
  if (!fs.existsSync(root)) return { ok: true, removed: [], archived: [], blocked: [] };

  const archive = opts.archive !== false;
  const removed = [];
  const archived = [];
  const blocked = [];

  for (const ent of fs.readdirSync(root, { withFileTypes: true })) {
    if (!ent.isDirectory()) continue;
    const wtPath = path.join(root, ent.name);

    if (archive) {
      let c;
      try {
        c = await commitWorktreeChanges(repoPath, wtPath, { runId, roleId: ent.name });
      } catch (e) {
        c = { ok: false, error: (e && e.message) || String(e) };
      }
      if (!c.ok) {
        // 归档失败绝不静默降级为删除：那正好是「丢产出」的路径。
        blocked.push({ roleId: ent.name, error: `归档失败，已保留: ${c.error}` });
        continue;
      }
      if (c.committed) archived.push({ roleId: ent.name, sha: c.sha, branch: c.branch });
    }

    const r = await removeAgentWorktree(repoPath, wtPath, {
      allowDiscardUncommitted: !!opts.allowDiscardUncommitted,
      deleteBranch: !!opts.deleteBranches
    });
    if (r.ok) removed.push(ent.name);
    else blocked.push({ roleId: ent.name, error: r.error, pending: r.pending || [] });
  }

  if (blocked.length) {
    return {
      ok: false,
      removed,
      archived,
      blocked,
      error: `有 ${blocked.length} 个 worktree 未被清理`
    };
  }
  fs.rmSync(root, { recursive: true, force: true });
  return { ok: true, removed, archived, blocked: [] };
}

/**
 * 回收 dieyun/agent-* 分支。
 * 分支是产出的存档，所以默认只删「已并入 HEAD」的分支；未合并的一律保留，
 * 除非显式 deleteUnmerged（那等于主动放弃这些产出）。
 */
async function pruneRunBranches(repoPath, opts = {}) {
  if (!(await isGitRepo(repoPath))) return { ok: false, error: '不是 git 仓库', deleted: [], kept: [] };
  const keep = Math.max(0, Number(opts.keep) || 0);
  const deleteUnmerged = !!opts.deleteUnmerged;

  const out = await gitExec(repoPath, [
    'for-each-ref',
    '--sort=-committerdate',
    '--format=%(refname:short)',
    'refs/heads/dieyun/agent-'
  ]);
  const branches = out.split('\n').map((s) => s.trim()).filter(Boolean);
  const deleted = [];
  const kept = [];

  for (let i = 0; i < branches.length; i += 1) {
    const name = branches[i];
    if (i < keep) {
      kept.push(name);
      continue;
    }
    if (!deleteUnmerged) {
      let merged = false;
      try {
        await gitExec(repoPath, ['merge-base', '--is-ancestor', name, 'HEAD']);
        merged = true;
      } catch {
        merged = false;
      }
      if (!merged) {
        kept.push(name);
        continue;
      }
    }
    try {
      // 仍被 worktree 占用的分支 git 会拒绝删除，这里是天然的安全网
      await gitExec(repoPath, ['branch', '-D', name]);
      deleted.push(name);
    } catch {
      kept.push(name);
    }
  }
  return { ok: true, deleted, kept };
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
  const blocked = [];
  const blockedIds = new Set();
  const maxBytes = maxSizeGb > 0 ? maxSizeGb * 1024 * 1024 * 1024 : 0;

  function totalBytesOf(list) {
    return list.reduce((sum, r) => sum + (Number(r.bytes) || 0), 0);
  }

  function canRemove(run) {
    return (
      run &&
      run.runId &&
      !protectedRunIds.has(String(run.runId)) &&
      !blockedIds.has(String(run.runId))
    );
  }

  /**
   * 清理失败（有未提交产出被拦截）时把该 run 记为 blocked 并换下一个候选，
   * 而不是像原来那样无条件计入 removed —— 否则容量永远降不下来，又谎报成功。
   */
  async function tryRemove(victim) {
    let r;
    try {
      r = await cleanupRunWorktrees(repoPath, victim.runId, opts);
    } catch (e) {
      r = { ok: false, error: (e && e.message) || String(e) };
    }
    if (r.ok) {
      removed.push(victim.runId);
      runs = runs.filter((x) => x.runId !== victim.runId);
      return true;
    }
    blockedIds.add(String(victim.runId));
    blocked.push({ runId: victim.runId, error: r.error, workers: r.blocked || [] });
    return false;
  }

  if (maxRuns > 0) {
    while (runs.length > maxRuns) {
      const victim = runs.find(canRemove);
      if (!victim) break;
      await tryRemove(victim);
    }
  }

  if (maxBytes > 0) {
    while (runs.length && totalBytesOf(runs) > maxBytes) {
      const victim = runs.find(canRemove);
      if (!victim) break;
      await tryRemove(victim);
    }
  }

  // 目录清完顺手回收分支：默认只删「已并入 HEAD」的，未合并的一律保留
  // （它们是产出的存档）。这样分支不会像原来那样无限累积。
  let pruned;
  try {
    pruned = await pruneRunBranches(repoPath, { keep: 0, deleteUnmerged: false });
  } catch (e) {
    pruned = { ok: false, error: (e && e.message) || String(e) };
  }

  const after = await listManagedWorktreeRuns(repoPath);
  return {
    ok: true,
    removed,
    blocked,
    pruned,
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

  const runRoot = runRootOf(repoPath, id);
  if (!fs.existsSync(runRoot)) {
    return { ok: true, runId: id, changes: [], empty: true };
  }

  const meta = readRunMeta(repoPath, id);
  const mainFiles = await listWorktreeChanges(repoPath);
  const mainDirty = new Set(mainFiles.map((f) => f.path));

  const changes = [];
  const rolesByPath = new Map();
  for (const ent of fs.readdirSync(runRoot, { withFileTypes: true })) {
    if (!ent.isDirectory()) continue;
    const roleId = ent.name;
    const wtPath = path.join(runRoot, roleId);
    // 基线取自 run 元数据；缺失时回退 merge-base（兼容本次改动前创建的 run）
    const baseSha =
      (meta.bases && meta.bases[roleId]) || (await resolveWorktreeBase(repoPath, id, roleId, wtPath));
    const files = await listWorktreeChangesVsBase(wtPath, baseSha);
    for (const f of files) {
      const key = f.path;
      const entry = {
        changeId: `${roleId}::${key}`,
        repoPath: key,
        kind: f.kind,
        status: f.status,
        roleId,
        worktreePath: wtPath,
        baseSha,
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
  // 基线必须与预览一致：子 Agent 在 worktree 内自行 commit 后，HEAD 已不等于基线，
  // 用 HEAD 会让 diff 变空。缺 baseSha 时回退 HEAD（兼容旧调用/旧 run）。
  const baseRef = String(change.baseSha || '').trim() || 'HEAD';

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

  const readBaseFile = async (basePath, fileRel) => {
    try {
      return await gitExec(basePath, ['show', `${baseRef}:${fileRel}`]);
    } catch {
      return '';
    }
  };

  const isNew = isNewKind(change.kind);

  try {
    if (isNew) {
      const src = path.join(wtPath, rel);
      if (!fs.existsSync(src)) {
        return {
          ok: true,
          added: 0,
          removed: 0,
          patch: '',
          beforeText: '',
          afterText: '',
          untracked: true,
          isNew: true
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
        patch = await gitExec(wtPath, ['diff', '--no-color', baseRef, '--', rel]);
      } catch {
        patch = '';
      }
      const beforeText = clipDiffText(await readBaseFile(wtPath, rel));
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

    const numstat = await gitExec(wtPath, ['diff', '--numstat', baseRef, '--', rel]);
    const parts = numstat.split('\t');
    const added = parseInt(parts[0], 10) || 0;
    const removed = parseInt(parts[1], 10) || 0;
    let patch = await gitExec(wtPath, ['diff', '--no-color', baseRef, '--', rel]);
    if (patch.length > 12000) patch = `${patch.slice(0, 12000)}\n… (截断)`;
    const beforeText = clipDiffText(await readBaseFile(wtPath, rel));
    const afterText = clipDiffText(readWorktreeFile(wtPath, rel));
    return { ok: true, added, removed, patch, beforeText, afterText, baseSha: baseRef };
  } catch (e) {
    return { ok: false, added: 0, removed: 0, patch: '', error: e.message || String(e) };
  }
}

/** 每次 apply 独占一个备份会话目录，避免多次应用互相覆盖备份。 */
function backupSessionDir(repoPath, runId) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const suffix = crypto.randomBytes(3).toString('hex');
  const dir = dieyunPath(repoPath, BACKUP_DIR, String(runId || 'unknown'), `${stamp}-${suffix}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * 原子替换：先写同目录临时文件，再 rename 覆盖目标。
 * 直接 copyFileSync 到目标路径时，中途崩溃/断电会留下半截文件——
 * 而这里覆盖的正是用户的正式代码，半截文件比不覆盖更糟。
 */
function atomicWriteFromSource(dest, src) {
  const dir = path.dirname(dest);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(
    dir,
    `.dieyun-apply-${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.tmp`
  );
  try {
    fs.copyFileSync(src, tmp);
    fs.renameSync(tmp, dest);
  } catch (e) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // 清理临时文件失败不应掩盖真正的错误
    }
    throw e;
  }
}

/**
 * 覆盖前把主工作区**当前**内容备份进备份会话目录，使 apply 可回滚。
 * 用 existed 区分「原本没有这个文件」——回滚时要删除它，而不是恢复。
 */
function backupBeforeWrite(repoPath, backupDir, rel) {
  const dest = path.join(repoPath, rel);
  let existed = false;
  try {
    existed = fs.existsSync(dest) && fs.statSync(dest).isFile();
  } catch {
    existed = false;
  }
  const entry = { repoPath: rel, existed, sha256: existed ? sha256FileSync(dest) : null };
  if (existed) {
    const target = path.join(backupDir, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(dest, target);
  }
  return entry;
}

function writeManifest(backupDir, manifest) {
  fs.writeFileSync(path.join(backupDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
}

function removeDirQuiet(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // 备份目录清不掉不影响主流程
  }
}

/**
 * 用备份回滚一次 apply。按 manifest 逐条还原（原本不存在的文件则删除）。
 * @param {string} repoPath
 * @param {string} backupDir applyRunWorktreeChanges 返回的 backupDir
 */
async function restoreApplyBackup(repoPath, backupDir) {
  const dir = String(backupDir || '').trim();
  if (!dir || !fs.existsSync(dir)) {
    return { ok: false, error: '备份目录不存在', restored: [], errors: [] };
  }
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  } catch (e) {
    return { ok: false, error: `备份清单不可读: ${e.message || e}`, restored: [], errors: [] };
  }

  const restored = [];
  const errors = [];
  for (const ent of Array.isArray(manifest.entries) ? manifest.entries : []) {
    try {
      const dest = path.join(repoPath, ent.repoPath);
      if (!ent.existed) {
        if (fs.existsSync(dest)) fs.rmSync(dest, { recursive: true, force: true });
        restored.push({ repoPath: ent.repoPath, action: 'removed' });
        continue;
      }
      const saved = path.join(dir, ent.repoPath);
      if (!fs.existsSync(saved)) {
        errors.push({ repoPath: ent.repoPath, error: '备份副本缺失' });
        continue;
      }
      atomicWriteFromSource(dest, saved);
      restored.push({ repoPath: ent.repoPath, action: 'restored' });
    } catch (e) {
      errors.push({ repoPath: ent.repoPath, error: e.message || String(e) });
    }
  }
  return { ok: errors.length === 0, restored, errors, backupDir: dir };
}

async function applyOneChange(repoPath, change, ctx = {}) {
  const rel = change.repoPath;
  const src = path.join(change.worktreePath, rel);
  const dest = path.join(repoPath, rel);
  const backupDir = ctx.backupDir || null;

  if (change.kind === 'deleted') {
    const backup = backupDir ? backupBeforeWrite(repoPath, backupDir, rel) : null;
    if (fs.existsSync(dest)) {
      const st = fs.statSync(dest);
      if (st.isDirectory()) fs.rmSync(dest, { recursive: true, force: true });
      else fs.unlinkSync(dest);
    }
    return { repoPath: rel, action: 'deleted', backup };
  }

  if (!fs.existsSync(src)) {
    throw new Error(`worktree 中找不到文件: ${rel}`);
  }
  const backup = backupDir ? backupBeforeWrite(repoPath, backupDir, rel) : null;
  atomicWriteFromSource(dest, src);
  return { repoPath: rel, action: 'copied', backup, sha256: sha256FileSync(dest) };
}

/**
 * 将选中变更从 worktree 写回主工作区（文件级覆盖，非 git merge）。
 *
 * 覆盖前有三道闸：
 * 1. `conflict`：多路 worktree 改同一文件，需按变更显式强制；
 * 2. `mainDirty`：主工作区该文件有未提交改动 —— 默认拒绝，需 allowOverwriteMainDirty；
 * 3. 写入本身是「备份 + 原子 rename」，失败可 restoreApplyBackup 回滚。
 *
 * @param {string} repoPath
 * @param {string} runId
 * @param {{
 *   paths?: string[],
 *   changeIds?: string[],
 *   forceConflict?: boolean,
 *   forceChangeIds?: string[],
 *   allowOverwriteMainDirty?: boolean
 * }} opts paths 为 repo 相对路径；changeIds 可精确到某个 worker 版本
 */
async function applyRunWorktreeChanges(repoPath, runId, opts = {}) {
  const preview = await previewRunWorktreeChanges(repoPath, runId);
  if (!preview.ok) return preview;
  if (!preview.changes.length) {
    return { ok: true, applied: 0, skipped: 0, errors: [], empty: true };
  }

  const allowOverwriteMainDirty = !!opts.allowOverwriteMainDirty;
  const selected = opts.paths && opts.paths.length ? new Set(opts.paths.map(String)) : null;
  const selectedIds = opts.changeIds && opts.changeIds.length ? new Set(opts.changeIds.map(String)) : null;
  // 冲突强制按变更粒度。原来只要任一选中项冲突就把 forceConflict 全局置真，
  // 等于勾中一个冲突文件就解除了其余所有文件的覆盖保护。
  const forceIds = new Set(
    (Array.isArray(opts.forceChangeIds) ? opts.forceChangeIds : []).map(String)
  );
  const forceAll = !!opts.forceConflict;

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

  const backupDir = backupSessionDir(repoPath, preview.runId);

  for (const ch of preview.changes) {
    const chId = ch.changeId || `${ch.roleId}::${ch.repoPath}`;
    if (selectedIds && !selectedIds.has(chId)) {
      skipped += 1;
      continue;
    }
    if (!selectedIds && selected && !selected.has(ch.repoPath)) {
      skipped += 1;
      continue;
    }

    const forced = forceAll || forceIds.has(chId);
    if (ch.conflict && !forced) {
      errors.push({
        repoPath: ch.repoPath,
        code: 'CONFLICT',
        error: `多路 worktree 同时修改（${(ch.conflictRoles || []).join(' vs ')}）`
      });
      continue;
    }
    if (ch.mainDirty && !allowOverwriteMainDirty) {
      errors.push({
        repoPath: ch.repoPath,
        code: 'MAIN_DIRTY',
        error: '主工作区该文件已有未提交改动，应用会覆盖它；需显式允许覆盖'
      });
      continue;
    }
    try {
      const r = await applyOneChange(repoPath, ch, { backupDir });
      actions.push(r);
      applied += 1;
    } catch (e) {
      errors.push({ repoPath: ch.repoPath, code: 'APPLY_FAILED', error: e.message || String(e) });
    }
  }

  const entries = actions.filter((a) => a.backup).map((a) => a.backup);
  if (entries.length) {
    writeManifest(backupDir, {
      runId: preview.runId,
      createdAt: new Date().toISOString(),
      entries
    });
  } else {
    removeDirQuiet(backupDir);
  }

  return {
    ok: errors.length === 0,
    applied,
    skipped,
    errors,
    actions,
    runId: preview.runId,
    backupDir: entries.length ? backupDir : null,
    appliedChanges: actions.map((a) => ({
      repoPath: a.repoPath,
      action: a.action,
      sha256: a.sha256 || null
    }))
  };
}

module.exports = {
  isGitRepo,
  gitExec,
  parsePorcelainStatus,
  normalizeChangeKind,
  isNewKind,
  listWorktrees,
  createAgentWorktree,
  commitWorktreeChanges,
  removeAgentWorktree,
  cleanupRunWorktrees,
  pruneRunBranches,
  getDirectorySizeBytes,
  listManagedWorktreeRuns,
  enforceWorktreeCleanupPolicy,
  listWorktreeChanges,
  listWorktreeChangesVsBase,
  previewRunWorktreeChanges,
  applyRunWorktreeChanges,
  restoreApplyBackup,
  getWorktreeChangeDiff
};
