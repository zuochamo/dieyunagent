'use strict';

/**
 * run 残留回收（`src/git/worktree-service.js#sweepRunArtifacts`）。
 *
 * 守的是三条边界（2026-11-21 现场：19 份 worktree / 473 MB + 171 条 `dieyun/agent-run-*`
 * 分支没人收 —— 回收原来只挂在桌面 Renderer 启动路径上，无人值守与强杀进程的残留永远不扫）：
 *
 * 1. 没有活 worktree 登记的 run 目录（只剩空壳 + `.dieyun-run-meta.json`）→ 删；
 * 2. 仍有 worktree 登记（可能在跑）或列在 `protectRunIds`（续跑复用）→ 原样保留；
 * 3. 分支只回收**已并入 HEAD** 的；未合并的是还没处置的产出，一律保留。
 *
 * 用真 git 仓库跑：这些判断全部依赖 `git worktree list` / `merge-base` 的实际口径，
 * mock 掉就等于不测。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const { sweepRunArtifacts } = require('../../src/git/worktree-service');

const hasGit = (() => {
  try {
    return spawnSync('git', ['--version'], { stdio: 'ignore' }).status === 0;
  } catch {
    return false;
  }
})();

function git(cwd, args) {
  return execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.com', ...args], {
    cwd,
    encoding: 'utf8'
  });
}

function agentBranches(repo) {
  const out = git(repo, [
    'for-each-ref',
    '--format=%(refname:short)',
    'refs/heads/dieyun/agent-*'
  ]);
  return out
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
    .sort();
}

function registeredWorktrees(repo) {
  const out = git(repo, ['worktree', 'list', '--porcelain']);
  return out
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s.startsWith('worktree '))
    .map((s) => s.slice('worktree '.length).replace(/\\/g, '/').toLowerCase());
}

describe.skipIf(!hasGit)('run 残留回收（sweepRunArtifacts）', () => {
  /** @type {string} */
  let repo;
  /** @type {string} */
  let baseBranch;

  function runDir(runId) {
    return path.join(repo, '.dieyun', 'worktrees', runId);
  }

  beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'dieyun-sweep-'));
    git(repo, ['init', '-q']);
    // 与真仓库同口径：`.dieyun/` 是运行时数据，不进索引（否则 worktree 会被当内嵌仓库）
    fs.writeFileSync(path.join(repo, '.gitignore'), '.dieyun/\n');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
    git(repo, ['add', '.gitignore', 'a.txt']);
    git(repo, ['commit', '-q', '-m', 'init']);
    baseBranch = git(repo, ['symbolic-ref', '--short', 'HEAD']).trim();
  });

  afterEach(() => {
    try {
      fs.rmSync(repo, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      /* Windows 上偶发占用：临时目录留给 os 清 */
    }
  });

  it('删空壳 run、保留活 worktree、只回收已并入 HEAD 的分支', async () => {
    // 活 worktree：git 登记着的目录
    const liveRole = path.join(runDir('run-live'), 'A');
    git(repo, ['worktree', 'add', '-q', '-b', 'dieyun/agent-run-live-A', liveRole, 'HEAD']);

    // 空壳：目录 + 元数据都在，git 不登记（cleanupRunWorktrees 被强杀后的现场形状）
    const shell = runDir('run-shell');
    fs.mkdirSync(path.join(shell, 'A'), { recursive: true });
    fs.writeFileSync(path.join(shell, '.dieyun-run-meta.json'), '{}');

    // 已并入 HEAD 的分支 / 未合并的分支
    git(repo, ['branch', 'dieyun/agent-run-merged-A', 'HEAD']);
    git(repo, ['checkout', '-q', '-b', 'dieyun/agent-run-unmerged-A']);
    fs.writeFileSync(path.join(repo, 'b.txt'), 'b\n');
    git(repo, ['add', 'b.txt']);
    git(repo, ['commit', '-q', '-m', 'work']);
    git(repo, ['checkout', '-q', baseBranch]);

    const r = await sweepRunArtifacts(repo);

    expect(r.ok).toBe(true);
    // 空壳被删，活 worktree 与它的 run 目录原样保留
    expect(r.removedRuns).toEqual(['run-shell']);
    expect(fs.existsSync(shell)).toBe(false);
    expect(fs.existsSync(liveRole)).toBe(true);

    // 分支：已合并的回收，未合并的与「仍被 worktree 占用」的保留
    expect(agentBranches(repo)).toEqual(['dieyun/agent-run-live-A', 'dieyun/agent-run-unmerged-A']);
    expect(r.pruned.deleted).toEqual(['dieyun/agent-run-merged-A']);
    expect(r.pruned.kept).toContain('dieyun/agent-run-unmerged-A');
  });

  it('protectRunIds 里的 run 目录原样保留（续跑复用同一 runId）', async () => {
    const keep = runDir('run-keep');
    fs.mkdirSync(path.join(keep, 'A'), { recursive: true });
    const drop = runDir('run-drop');
    fs.mkdirSync(path.join(drop, 'A'), { recursive: true });

    const r = await sweepRunArtifacts(repo, { protectRunIds: ['run-keep'] });

    expect(r.removedRuns).toEqual(['run-drop']);
    expect(fs.existsSync(keep)).toBe(true);
    expect(fs.existsSync(drop)).toBe(false);
  });

  it('目录已被手删但 git 还留着登记时，顺带 prune 掉登记（不留悬挂项）', async () => {
    const staleRole = path.join(runDir('run-crashed'), 'A');
    git(repo, ['worktree', 'add', '-q', '-b', 'dieyun/agent-run-crashed-A', staleRole, 'HEAD']);
    // 模拟「目录被外部删掉、登记还在」
    fs.rmSync(runDir('run-crashed'), { recursive: true, force: true });

    await sweepRunArtifacts(repo);

    const regs = registeredWorktrees(repo);
    expect(regs.some((p) => p.endsWith('/run-crashed/a'))).toBe(false);
    expect(regs.length).toBe(1); // 只剩主工作区
  });

  it('不是 git 仓库时如实拒绝，且一个目录都不动', async () => {
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'dieyun-plain-'));
    const shell = path.join(plain, '.dieyun', 'worktrees', 'run-shell');
    fs.mkdirSync(path.join(shell, 'A'), { recursive: true });
    try {
      const r = await sweepRunArtifacts(plain);
      expect(r.ok).toBe(false);
      expect(fs.existsSync(shell)).toBe(true);
    } finally {
      fs.rmSync(plain, { recursive: true, force: true, maxRetries: 3 });
    }
  });
});
