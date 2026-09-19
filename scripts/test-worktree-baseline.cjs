#!/usr/bin/env node
'use strict';

/**
 * worktree 产物落盘通道的回归测试（审计 P0-1 / P0-2 / P0-3）。
 *
 * 覆盖的全是「一旦回归就会静默毁数据」的路径：
 *  1. 子 Agent 自行 commit 后，预览仍必须显示产出（基线相对，而非 HEAD 相对）；
 *  2. 主工作区已有未提交改动时 apply 默认拒绝，显式允许时留下可回滚备份；
 *  3. 清理必须先归档到分支再删目录 —— 目录没了，产出还在。
 *
 * 用法：npm run test:worktree
 */

const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const svc = require('../src/git/worktree-service.js');

let passed = 0;
function ok(label) {
  passed += 1;
  console.log(`  ✓ ${label}`);
}

function git(repo, args) {
  return execFileSync('git', args, {
    cwd: repo,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  });
}

/** 固定提交身份：不能依赖跑测试的机器上有全局 git config */
function gitId(repo, args) {
  return git(repo, ['-c', 'user.name=T', '-c', 'user.email=t@t.local', ...args]);
}

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, 'utf8');
}

function read(file) {
  return fs.readFileSync(file, 'utf8');
}

async function scenarioAgentSelfCommit(repo, runId) {
  console.log('· 场景 1：子 Agent 在 worktree 内自行 commit');
  const created = await svc.createAgentWorktree(repo, { runId, roleId: 'A' });
  assert.strictEqual(created.ok, true, JSON.stringify(created));
  const wt = created.path;
  assert.ok(created.baseSha, '创建时应把基线固化成 sha');
  ok('创建时固化 baseSha');

  // 子 Agent 改文件 + 新建文件，然后自己 commit（改代码型 agent 的常见行为）
  write(path.join(wt, 'a.txt'), 'v2\n');
  write(path.join(wt, 'b.txt'), 'new\n');
  gitId(wt, ['add', '-A']);
  gitId(wt, ['commit', '-m', 'agent self commit']);

  const preview = await svc.previewRunWorktreeChanges(repo, runId);
  assert.strictEqual(preview.ok, true, JSON.stringify(preview));
  const kinds = new Map(preview.changes.map((c) => [c.repoPath, c.kind]));
  assert.strictEqual(kinds.get('a.txt'), 'modified', 'a.txt 应显示为 modified');
  assert.strictEqual(kinds.get('b.txt'), 'added', 'b.txt 应显示为 added');
  ok('commit 之后预览仍能看到产出（不再凭空消失）');

  const changeA = preview.changes.find((c) => c.repoPath === 'a.txt');
  const diff = await svc.getWorktreeChangeDiff(repo, changeA);
  assert.strictEqual(diff.ok, true, JSON.stringify(diff));
  assert.ok(
    diff.patch.includes('-v1') && diff.patch.includes('+v2'),
    `diff 必须相对基线，实际内容: ${JSON.stringify(diff.patch.slice(0, 200))}`
  );
  // gitExec 的 stdout 会 trim，故这里不含结尾换行
  assert.strictEqual(diff.beforeText, 'v1', 'beforeText 应取自基线而非 HEAD');
  ok('diff / beforeText 相对基线，提交后不为空');

  // 主工作区产生未提交改动 —— 必须被拦住
  write(path.join(repo, 'a.txt'), 'local dirty\n');
  const denied = await svc.applyRunWorktreeChanges(repo, runId, { paths: ['a.txt'] });
  assert.strictEqual(denied.applied, 0, '默认不应写入任何文件');
  assert.ok(
    denied.errors.some((e) => e.code === 'MAIN_DIRTY'),
    `应报 MAIN_DIRTY，实际: ${JSON.stringify(denied.errors)}`
  );
  assert.strictEqual(read(path.join(repo, 'a.txt')), 'local dirty\n', '主区内容必须原样保留');
  ok('mainDirty 默认拒绝，用户改动未被覆盖');

  const applied = await svc.applyRunWorktreeChanges(repo, runId, {
    paths: ['a.txt', 'b.txt'],
    allowOverwriteMainDirty: true
  });
  assert.strictEqual(applied.applied, 2, JSON.stringify(applied.errors));
  assert.strictEqual(read(path.join(repo, 'a.txt')), 'v2\n');
  assert.strictEqual(read(path.join(repo, 'b.txt')), 'new\n');
  assert.ok(applied.backupDir && fs.existsSync(applied.backupDir), '应留下备份目录');
  ok('显式允许后写入成功，且留下备份');

  const rolled = await svc.restoreApplyBackup(repo, applied.backupDir);
  assert.strictEqual(rolled.ok, true, JSON.stringify(rolled.errors));
  assert.strictEqual(read(path.join(repo, 'a.txt')), 'local dirty\n', 'a.txt 应还原为用户改动');
  assert.ok(!fs.existsSync(path.join(repo, 'b.txt')), '原本不存在的 b.txt 应被删除');
  ok('restoreApplyBackup 完整回滚（含「原本不存在则删除」）');

  const cleanup = await svc.cleanupRunWorktrees(repo, runId);
  assert.strictEqual(cleanup.ok, true, JSON.stringify(cleanup));
  assert.strictEqual(fs.existsSync(wt), false, 'worktree 目录应已删除');
  ok('清理后目录已回收');

  const branch = `dieyun/agent-${runId}-A`;
  const branchText = git(repo, ['show', `${branch}:a.txt`]);
  assert.strictEqual(branchText.replace(/\r\n/g, '\n'), 'v2\n', '分支应持有产出作为存档');
  ok('产出在分支上可追回');
}

async function scenarioUncommittedArchive(repo, runId) {
  console.log('· 场景 2：子 Agent 从不 commit');
  const created = await svc.createAgentWorktree(repo, { runId, roleId: 'B' });
  assert.strictEqual(created.ok, true, JSON.stringify(created));
  const wt = created.path;
  write(path.join(wt, 'c.txt'), 'uncommitted\n');

  const preview = await svc.previewRunWorktreeChanges(repo, runId);
  assert.ok(
    preview.changes.some((c) => c.repoPath === 'c.txt' && c.kind === 'added'),
    '未跟踪文件应显示为新增'
  );
  ok('未提交产出可见');

  // 关键：默认清理必须先归档再删，否则「加了未提交拦截」会变成永远清不掉
  const cleanup = await svc.cleanupRunWorktrees(repo, runId);
  assert.strictEqual(cleanup.ok, true, JSON.stringify(cleanup));
  assert.strictEqual(fs.existsSync(wt), false, 'worktree 目录应已删除');
  const archived = cleanup.archived.find((a) => a.roleId === 'B');
  assert.ok(archived, `未提交产出必须先归档，实际: ${JSON.stringify(cleanup.archived)}`);
  const text = git(repo, ['show', `${archived.branch}:c.txt`]);
  assert.strictEqual(text.replace(/\r\n/g, '\n'), 'uncommitted\n');
  ok('未提交产出先归档、再删目录');
}

async function main() {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
  } catch {
    console.log('[worktree-baseline] git 不可用，跳过');
    return;
  }

  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'dieyun-wt-'));
  try {
    git(repo, ['init']);
    // 与真实仓库一致：worktree 位于仓库内，必须自忽略，否则会污染主区状态
    write(path.join(repo, '.gitignore'), '.dieyun/\n');
    write(path.join(repo, 'a.txt'), 'v1\n');
    gitId(repo, ['add', '-A']);
    gitId(repo, ['commit', '-m', 'baseline']);

    await scenarioAgentSelfCommit(repo, 'run-test-1');
    await scenarioUncommittedArchive(repo, 'run-test-2');

    console.log(`\n[worktree-baseline] ${passed} 项通过`);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error('[worktree-baseline] FAILED:', (e && e.stack) || e);
  process.exit(1);
});
