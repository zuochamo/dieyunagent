'use strict';

/**
 * planner 并行写入执行器 —— 集成测试（不联网、不需要真模型）。
 *
 * 验的是「多路写入子 Agent」真正落地时要成立的两件事：
 *  ① 写类队列**按 worktree 分桶**：不同副本并行、同一副本串行
 *     （键取主工作区的话，多路并行会静默退化成排队 —— 上一步的修复点）；
 *  ② 多路改同一文件时，合并阶段**必须**报冲突并要求逐项强制，
 *     且只有被选中的那一路写回主工作区（不是「谁最后写谁赢」）。
 *
 * 用的是生产代码本身：`createMainToolBridge`（工具桥 + mutate 队列）、
 * `git/worktree-service`（worktree 创建 / 预览 / 应用）。没有另写一份被测逻辑。
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { createMainToolBridge } = require('../src/agent/tool-bridge-main');
const { DEFAULTS: PERMISSION_DEFAULTS } = require('../src/gateway/permissions-store');
const worktreeService = require('../src/git/worktree-service');

const WRITE_DELAY_MS = 120;

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function tempDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `dieyun-${label}-`));
}

/**
 * ① 写类队列按 worktree 分桶：并发度就是证据。
 *
 * 直接对「同时在跑的写」计数：不同 worktree 的两路写应当同为 2；
 * 同一个 worktree 的两路写必须为 1（串行）。用并发度而不是墙钟时间，
 * 免得在慢机器上误判。
 */
async function partQueueKeyPerWorktree() {
  const root = tempDir('queue-key');
  const ws = path.join(root, 'ws');
  const wtA = path.join(ws, '.dieyun', 'worktrees', 'r1', 'A');
  const wtB = path.join(ws, '.dieyun', 'worktrees', 'r1', 'B');
  fs.mkdirSync(wtA, { recursive: true });
  fs.mkdirSync(wtB, { recursive: true });

  const stats = { inFlight: 0, maxInFlight: 0, writes: 0 };
  const gateway = {
    getPermissions: () => ({ ...PERMISSION_DEFAULTS }),
    invokeRpc: async (method, params) => {
      if (method !== 'fs.write_file') return { ok: true };
      stats.writes += 1;
      stats.inFlight += 1;
      stats.maxInFlight = Math.max(stats.maxInFlight, stats.inFlight);
      try {
        await new Promise((resolve) => setTimeout(resolve, WRITE_DELAY_MS));
        return { ok: true, path: params && params.filePath };
      } finally {
        stats.inFlight -= 1;
      }
    }
  };

  const bridge = createMainToolBridge({ gateway, userDataPath: root, webContents: null });
  const base = { sessionId: 's1', workspacePath: ws, model: 'test-model' };

  const reset = () => {
    stats.inFlight = 0;
    stats.maxInFlight = 0;
    stats.writes = 0;
  };

  // 不同 worktree：两路写应并发
  reset();
  const parallel = await Promise.all([
    bridge.executeAgentTool('fs_write_file', { filePath: 'a.js', content: 'a' }, { ...base, worktreePath: wtA }),
    bridge.executeAgentTool('fs_write_file', { filePath: 'b.js', content: 'b' }, { ...base, worktreePath: wtB })
  ]);
  for (const r of parallel) {
    assert(!r || !r.error, `并行写不应报错: ${JSON.stringify(r)}`);
  }
  assert.strictEqual(stats.writes, 2, `应发生 2 次写，实际 ${stats.writes}`);
  assert.strictEqual(
    stats.maxInFlight,
    2,
    `不同 worktree 的写必须并行（同时在跑 = ${stats.maxInFlight}，期望 2）`
  );

  // 同一个 worktree：两路写必须串行
  reset();
  const serial = await Promise.all([
    bridge.executeAgentTool('fs_write_file', { filePath: 'c.js', content: 'c' }, { ...base, worktreePath: wtA }),
    bridge.executeAgentTool('fs_write_file', { filePath: 'd.js', content: 'd' }, { ...base, worktreePath: wtA })
  ]);
  for (const r of serial) {
    assert(!r || !r.error, `串行写不应报错: ${JSON.stringify(r)}`);
  }
  assert.strictEqual(stats.writes, 2, `应发生 2 次写，实际 ${stats.writes}`);
  assert.strictEqual(
    stats.maxInFlight,
    1,
    `同一 worktree 的写必须串行（同时在跑 = ${stats.maxInFlight}，期望 1）`
  );

  fs.rmSync(root, { recursive: true, force: true });
  console.log('ok 写类队列按 worktree 分桶（跨副本并行 / 同副本串行）');
}

/**
 * ② 真 git：两路执行器各写一份副本 → 合并时必须报冲突、逐项强制。
 */
async function partWorktreeConflictAndApply() {
  const root = tempDir('wt-conflict');
  const repo = path.join(root, 'repo');
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  // `.dieyun/` 必须被忽略：worktree 就建在仓库内的这个目录下（与生产一致）
  fs.writeFileSync(path.join(repo, '.gitignore'), '.dieyun/\nnode_modules/\n');
  fs.writeFileSync(path.join(repo, 'src', 'shared.js'), 'base\n');
  fs.writeFileSync(path.join(repo, 'src', 'keep.js'), 'keep\n');
  git(repo, 'init');
  git(repo, 'add', '-A');
  git(repo, '-c', 'user.email=test@dieyun.local', '-c', 'user.name=dieyun-test', 'commit', '-m', 'init');

  const runId = 'run-parallel-1';
  const a = await worktreeService.createAgentWorktree(repo, { runId, roleId: 'A' });
  const b = await worktreeService.createAgentWorktree(repo, { runId, roleId: 'B' });
  assert(a && a.ok && a.path, `worktree A 创建失败: ${JSON.stringify(a)}`);
  assert(b && b.ok && b.path, `worktree B 创建失败: ${JSON.stringify(b)}`);
  assert.notStrictEqual(a.path, b.path, '两路执行器必须拿到不同的目录');

  // 两路各写自己的副本：两个文件被两路同时改，另各自独占一个文件
  fs.writeFileSync(path.join(a.path, 'src', 'shared.js'), 'from-A\n');
  fs.writeFileSync(path.join(b.path, 'src', 'shared.js'), 'from-B\n');
  fs.writeFileSync(path.join(a.path, 'src', 'shared2.js'), 'a2\n');
  fs.writeFileSync(path.join(b.path, 'src', 'shared2.js'), 'b2\n');
  fs.writeFileSync(path.join(a.path, 'src', 'only-a.js'), 'a\n');
  fs.writeFileSync(path.join(b.path, 'src', 'only-b.js'), 'b\n');

  // 隔离真的生效：此刻主工作区必须一字未动
  assert.strictEqual(
    fs.readFileSync(path.join(repo, 'src', 'shared.js'), 'utf8'),
    'base\n',
    '执行器写入期间主工作区不允许被改动'
  );
  assert(!fs.existsSync(path.join(repo, 'src', 'only-a.js')), '执行器的产出不得直接落在主工作区');

  const preview = await worktreeService.previewRunWorktreeChanges(repo, runId);
  assert(preview && preview.ok, `预览失败: ${JSON.stringify(preview)}`);
  const shared = preview.changes.filter((c) => c.repoPath === 'src/shared.js');
  assert.strictEqual(shared.length, 2, `同一文件应有两路变更，实际 ${shared.length}`);
  const sharedA = shared.find((c) => c.roleId === 'A');
  const sharedB = shared.find((c) => c.roleId === 'B');
  assert(sharedA && sharedB, '共享文件的变更应分别来自 A / B');
  assert(sharedA.conflict === true && sharedB.conflict === true, '多路改同一文件必须标记冲突');
  assert.deepStrictEqual(
    [...(sharedA.conflictRoles || [])].sort(),
    ['A', 'B'],
    `冲突参与方应是 A/B，实际 ${JSON.stringify(sharedA.conflictRoles)}`
  );
  const shared2A = preview.changes.find((c) => c.repoPath === 'src/shared2.js' && c.roleId === 'A');
  assert(shared2A && shared2A.conflict === true, '第二个被两路同改的文件也应标记冲突');
  const onlyA = preview.changes.find((c) => c.repoPath === 'src/only-a.js');
  assert(onlyA && onlyA.conflict !== true, '各自独占的文件不应被标记冲突');

  // 未强制 → 必须拒绝（不能「谁最后写谁赢」）
  const refused = await worktreeService.applyRunWorktreeChanges(repo, runId, { paths: ['src/shared.js'] });
  assert.strictEqual(refused.ok, false, `冲突未强制时必须拒绝应用，实际 ${JSON.stringify(refused)}`);
  assert(
    (refused.errors || []).some((e) => e.code === 'CONFLICT'),
    `应给出 CONFLICT 错误，实际 ${JSON.stringify(refused.errors)}`
  );
  assert.strictEqual(
    fs.readFileSync(path.join(repo, 'src', 'shared.js'), 'utf8'),
    'base\n',
    '被拒绝的合并不得改动主工作区'
  );

  // 同时选两个版本 → 明确拒绝
  const both = await worktreeService.applyRunWorktreeChanges(repo, runId, {
    changeIds: [sharedA.changeId, sharedB.changeId]
  });
  assert.strictEqual(both.ok, false, `同一文件选两个版本必须拒绝，实际 ${JSON.stringify(both)}`);
  assert(
    (both.errors || []).some((e) => /多个 worker 版本/.test(e.error || '')),
    `应明确拒绝多版本，实际 ${JSON.stringify(both.errors)}`
  );

  // 界面契约（renderer-changes-pane 同一条路径）：选中冲突文件时按 changeId 粒度强制。
  // 只强制 shared.js 这一条 → 它被写回，而同样冲突但未选中的 shared2.js 仍然报错（
  // 不能被顺带解除保护 —— 这正是「按变更粒度」要防的事）。
  const granular = await worktreeService.applyRunWorktreeChanges(repo, runId, {
    paths: ['src/shared.js', 'src/shared2.js'],
    forceChangeIds: [sharedA.changeId]
  });
  assert.strictEqual(granular.ok, false, `未强制的那条冲突仍应报错，实际 ${JSON.stringify(granular)}`);
  assert.strictEqual(granular.applied, 1, `只应应用被选中的 1 处，实际 ${granular.applied}`);
  assert(
    (granular.errors || []).some((e) => e.code === 'CONFLICT' && e.repoPath === 'src/shared2.js'),
    `未选中的冲突文件必须仍报 CONFLICT，实际 ${JSON.stringify(granular.errors)}`
  );
  assert.strictEqual(
    fs.readFileSync(path.join(repo, 'src', 'shared.js'), 'utf8'),
    'from-A\n',
    '应用后主工作区应是所选那一路（A）的内容'
  );
  assert(
    !fs.existsSync(path.join(repo, 'src', 'shared2.js')),
    '未被强制的冲突文件不得被写入（它在基线里不存在：两路都是新建）'
  );

  // 独占文件可以一并应用（无冲突）
  const rest = await worktreeService.applyRunWorktreeChanges(repo, runId, {
    paths: ['src/only-a.js', 'src/only-b.js']
  });
  assert.strictEqual(rest.ok, true, `无冲突文件应能应用，实际 ${JSON.stringify(rest)}`);
  assert(fs.existsSync(path.join(repo, 'src', 'only-a.js')), 'only-a.js 应已合并进主工作区');
  assert(fs.existsSync(path.join(repo, 'src', 'only-b.js')), 'only-b.js 应已合并进主工作区');

  await worktreeService.cleanupRunWorktrees(repo, runId).catch(() => {});
  fs.rmSync(root, { recursive: true, force: true });
  console.log('ok 真 git：两路副本隔离 + 冲突必须逐项强制 + 只写回被选中的那一路');
}

/**
 * ③ 重试前必须把副本清回基线：否则上一次失败的半成品会被当成「这一次」的产出合并。
 *    （执行器 retry 走的就是 createAgentWorktree 的 reused 分支，目录不重置。）
 */
async function partRetryResetsWorktree() {
  const root = tempDir('wt-retry');
  const repo = path.join(root, 'repo');
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.gitignore'), '.dieyun/\nnode_modules/\n');
  fs.writeFileSync(path.join(repo, 'src', 'keep.js'), 'keep\n');
  git(repo, 'init');
  git(repo, 'add', '-A');
  git(repo, '-c', 'user.email=test@dieyun.local', '-c', 'user.name=dieyun-test', 'commit', '-m', 'init');

  const runId = 'run-retry-1';
  const first = await worktreeService.createAgentWorktree(repo, { runId, roleId: 'A' });
  assert(first && first.ok && first.baseSha, `worktree 创建失败: ${JSON.stringify(first)}`);

  // 第一次尝试留下的半成品（含一个被改坏的文件）
  fs.writeFileSync(path.join(first.path, 'src', 'half.js'), 'half\n');
  fs.writeFileSync(path.join(first.path, 'src', 'keep.js'), 'BROKEN\n');
  const dirty = await worktreeService.previewRunWorktreeChanges(repo, runId);
  assert.strictEqual(dirty.changes.length, 2, `半成品应被看到 2 处，实际 ${dirty.changes.length}`);

  // 重试：复用同一个目录（reused），必须显式重置
  const second = await worktreeService.createAgentWorktree(repo, { runId, roleId: 'A' });
  assert.strictEqual(second.reused, true, '重试应复用同一个 worktree 目录');
  const reset = await worktreeService.resetAgentWorktree(repo, second.path, second.baseSha || first.baseSha);
  assert(reset && reset.ok, `重置失败: ${JSON.stringify(reset)}`);

  const afterReset = await worktreeService.previewRunWorktreeChanges(repo, runId);
  assert.strictEqual(
    afterReset.changes.length,
    0,
    `重置后不应再有残留变更，实际 ${JSON.stringify(afterReset.changes)}`
  );
  // 读回的内容要按 LF 归一后再比：git 在 Windows 上 checkout 会按 autocrlf 落成 CRLF
  assert.strictEqual(
    fs.readFileSync(path.join(second.path, 'src', 'keep.js'), 'utf8').replace(/\r\n/g, '\n'),
    'keep\n',
    '重置后副本内容应回到基线'
  );
  assert(!fs.existsSync(path.join(second.path, 'src', 'half.js')), '重置应清掉未跟踪的半成品文件');

  await worktreeService.cleanupRunWorktrees(repo, runId).catch(() => {});
  fs.rmSync(root, { recursive: true, force: true });
  console.log('ok 真 git：重试前重置副本（半成品不会混进本次产出）');
}

async function main() {
  await partQueueKeyPerWorktree();
  await partWorktreeConflictAndApply();
  await partRetryResetsWorktree();
  console.log('test-planner-workers.cjs ok');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
