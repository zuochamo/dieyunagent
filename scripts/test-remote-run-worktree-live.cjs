'use strict';

/**
 * 远端（SSH）per-role worktree 的**真机**验收脚本（opt-in）。
 *
 * 为什么要有它：`remote-run-worktree.js` 的每一段都是「拼一段 shell + 解析 stdout」，
 * 单测只能验形状（假 ssh），验不了「这段脚本在真 bash 上到底跑不跑得动」——
 * 2026-11-19 就是在这层出的事（基线 `BASH` 变量插错位置 → baseSha 恒空，脚本看起来完全正常）。
 *
 * 用法（只碰它自己创建的临时目录，不碰任何既有仓库）：
 *   DIEYUN_LIVE_SSH=dieyunx@192.168.31.62 node scripts/test-remote-run-worktree-live.cjs
 * 可选：
 *   DIEYUN_LIVE_SSH_PORT=22
 *   DIEYUN_LIVE_SSH_TMP=/tmp        （父目录，脚本会在其下建 dieyun-rwt-live-<pid>）
 *   DIEYUN_LIVE_SSH_KEEP=1          （结束后保留临时目录，便于人工翻看）
 *
 * 覆盖的行为：
 * 1. 建副本：baseSha 必须非空（回归：以前插在 `BASE=` 之前 → 恒空）；
 * 2. 变更预览：diff + 未跟踪、kind 映射、同一路径多路 → conflict；
 * 3. 归档 + 删目录（停止/取消路径）：目录没了、**分支还在**、续跑 `reuse` 且改动还在副本里；
 * 4. 合并冲突：必须返回冲突文件清单（abort 之前取）；
 * 5. 过期回收：只留最新 N 个，先归档再删、保留分支。
 */

const { spawnSync } = require('child_process');
const path = require('path');
const {
  ensureRunWorktree,
  removeRunWorktree,
  archiveRunWorktree,
  previewRunWorktreeChanges,
  mergeRunWorktreeInto,
  pruneRunWorktreeRoots,
  runWorktreePath,
  runWorktreeBranch
} = require('../src/ssh/remote-run-worktree');

const TARGET = String(process.env.DIEYUN_LIVE_SSH || '').trim();
const PORT = String(process.env.DIEYUN_LIVE_SSH_PORT || '22').trim();
const TMP_PARENT = String(process.env.DIEYUN_LIVE_SSH_TMP || '/tmp').replace(/\/+$/, '') || '/tmp';
const KEEP = String(process.env.DIEYUN_LIVE_SSH_KEEP || '') === '1';
const SCRATCH = `${TMP_PARENT}/dieyun-rwt-live-${process.pid}`;

/** 真实的 ssh 执行体：把脚本通过 stdin 交给远端 bash，与 `sshManager.execScript` 同形状。 */
function createLiveSsh(target, port) {
  const calls = [];
  return {
    calls,
    async execScript(script, timeoutMs) {
      calls.push({ script, timeoutMs });
      const res = spawnSync(
        'ssh',
        [
          '-o',
          'BatchMode=yes',
          '-o',
          'ConnectTimeout=8',
          '-o',
          'StrictHostKeyChecking=accept-new',
          '-p',
          port,
          target,
          'bash -s'
        ],
        {
          input: String(script || ''),
          encoding: 'utf8',
          timeout: Math.max(15000, Number(timeoutMs) || 60000),
          maxBuffer: 8 * 1024 * 1024
        }
      );
      if (res.error) throw res.error;
      return { code: res.status == null ? 1 : res.status, stdout: res.stdout || '', stderr: res.stderr || '' };
    }
  };
}

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

function ok(message) {
  console.log(`OK ${message}`);
}

/** 在远端跑一段脚本并断言退出码 0。 */
async function sh(ssh, script) {
  const r = await ssh.execScript(script, 60000);
  if (r.code !== 0) {
    throw new Error(`远端命令失败（code=${r.code}）：${String(r.stderr || '').trim().slice(-400)}\n${script}`);
  }
  return r.stdout || '';
}

async function main() {
  if (!TARGET) {
    console.log('SKIP 未设置 DIEYUN_LIVE_SSH（这是 opt-in 的真机脚本）');
    return;
  }
  const ssh = createLiveSsh(TARGET, PORT);
  const repo = `${SCRATCH}/repo`;
  const sessionWt = `${SCRATCH}/sess-main`;
  const runId = 'live-run-1';

  try {
    // —— 0. 造一个和真实场景同形状的临时仓库（仓库 + 会话副本 worktree）——
    await sh(
      ssh,
      [
        `mkdir -p ${SCRATCH}`,
        `cd ${SCRATCH}`,
        'git init --quiet repo',
        'cd repo',
        'git config user.email live@test.local',
        'git config user.name live-test',
        'printf ".dieyun/\\n" > .gitignore',
        'printf "a0\\n" > a.txt',
        'printf "b0\\n" > b.txt',
        'printf "s0\\n" > shared.txt',
        'git add -A',
        'git commit -qm base',
        `git worktree add --quiet -b dieyun/agent-sess-main ${sessionWt} HEAD`,
        'echo READY'
      ].join('\n')
    );
    ok(`临时仓库已就绪 ${repo}`);

    // —— 1. 建两路执行器副本：baseSha 必须非空 ——
    const roleA = await ensureRunWorktree(ssh, { repoPath: repo, runId, roleId: 'A' });
    const roleB = await ensureRunWorktree(ssh, { repoPath: repo, runId, roleId: 'B' });
    assert(roleA.ok && roleB.ok, `建副本失败：${JSON.stringify(roleA)} / ${JSON.stringify(roleB)}`);
    assert(
      /^[0-9a-f]{7,40}$/i.test(String(roleA.baseSha || '')),
      `baseSha 必须是非空 sha（回归：以前插在 BASE= 之前恒空），实际 ${JSON.stringify(roleA.baseSha)}`
    );
    assert(roleA.path === runWorktreePath(repo, runId, 'A'), `副本路径形状不对：${roleA.path}`);
    ok(`两路副本建好，baseSha=${roleA.baseSha.slice(0, 8)}`);

    // —— 2. 模拟两个执行器各自改文件（A 改 a.txt，B 改 b.txt 与 shared.txt）——
    await sh(
      ssh,
      [
        `printf "a1\\n" >> ${roleA.path}/a.txt`,
        `printf "b1\\n" >> ${roleB.path}/b.txt`,
        `printf "s-b\\n" >> ${roleB.path}/shared.txt`,
        `printf "new\\n" > ${roleB.path}/brand-new.txt`
      ].join('\n')
    );

    // —— 3. 变更预览：diff + 未跟踪 + kind ——
    const preview = await previewRunWorktreeChanges(ssh, { repoPath: repo, runId });
    assert(preview.ok, `预览失败：${preview.error}`);
    const byId = new Map(preview.changes.map((c) => [c.changeId, c]));
    assert(byId.has('A::a.txt'), `预览缺 A::a.txt：${JSON.stringify(preview.changes)}`);
    assert(byId.has('B::b.txt'), '预览缺 B::b.txt');
    assert(byId.has('B::brand-new.txt'), '未跟踪文件没被算成新增');
    assert(byId.get('B::brand-new.txt').kind === 'added', 'untracked 的 kind 必须是 added');
    assert(byId.get('A::a.txt').kind === 'modified', 'A::a.txt 的 kind 必须是 modified');
    assert(
      String(byId.get('A::a.txt').baseSha || '') === String(roleA.baseSha),
      '预览里的 baseSha 必须是建副本时的基线'
    );
    ok(`变更预览正确（${preview.changes.length} 条，含未跟踪）`);

    // —— 4. 同一路径多路 → conflict ——
    await sh(ssh, `printf "s-a\\n" >> ${roleA.path}/shared.txt`);
    const preview2 = await previewRunWorktreeChanges(ssh, { repoPath: repo, runId });
    const sharedA = preview2.changes.find((c) => c.changeId === 'A::shared.txt');
    assert(sharedA && sharedA.conflict === true, 'A/B 都改了 shared.txt，必须标 conflict');
    assert(
      Array.isArray(sharedA.conflictRoles) && sharedA.conflictRoles.length === 2,
      `conflictRoles 应含两路，实际 ${JSON.stringify(sharedA.conflictRoles)}`
    );
    ok('同一路径多路命中已标 conflict');

    // —— 5. 停止/取消路径：先归档再删目录、保留分支 ——
    const archived = await archiveRunWorktree(ssh, {
      wtPath: roleA.path,
      message: 'dieyun: live test 归档'
    });
    assert(archived.ok && archived.committed, `归档失败：${JSON.stringify(archived)}`);
    const removed = await removeRunWorktree(ssh, {
      repoPath: repo,
      runId,
      roleId: 'A',
      deleteBranch: false
    });
    assert(removed.ok, `删目录失败：${JSON.stringify(removed)}`);
    const afterCleanup = await sh(
      ssh,
      [
        `test -d ${roleA.path} && echo DIR_STILL_THERE || echo DIR_GONE`,
        `cd ${repo}`,
        `git branch --list ${runWorktreeBranch(runId, 'A')}`,
        `git log -1 --format=%s ${runWorktreeBranch(runId, 'A')}`
      ].join('\n')
    );
    assert(afterCleanup.includes('DIR_GONE'), '清理后副本目录应该消失');
    assert(
      afterCleanup.includes(runWorktreeBranch(runId, 'A')),
      `分支必须留着（产出存档），实际输出：${afterCleanup}`
    );
    assert(afterCleanup.includes('归档'), `分支上应有一条归档提交，实际：${afterCleanup}`);
    ok('停止=归档+删目录，分支与产出都还在');

    // —— 6. 续跑（同一 runId）：目录已删，但分支还在 → 挂回原分支、归档的改动还在 ——
    // 注意 `reused` 的语义是「目录本来就在」，这里目录刚被清掉，所以它会是 false；
    // 真正要验的是「挂回来的是**分支**，不是重新从基线开一份」。
    const resumed = await ensureRunWorktree(ssh, { repoPath: repo, runId, roleId: 'A' });
    assert(resumed.ok, `续跑建副本失败：${JSON.stringify(resumed)}`);
    const resumedHead = await sh(ssh, `git -C ${resumed.path} log -1 --format=%s`);
    assert(
      resumedHead.includes('归档'),
      `续跑挂回的应是归档后的分支 HEAD（否则等于重开一份、产出丢了），实际：${resumedHead}`
    );
    const content = await sh(ssh, `cat ${resumed.path}/a.txt && cat ${resumed.path}/shared.txt`);
    assert(content.includes('a1'), `续跑后归档的改动必须还在（a.txt），实际：${content}`);
    assert(content.includes('s-a'), `续跑后归档的改动必须还在（shared.txt），实际：${content}`);
    ok('同一 runId 续跑：挂回原分支，上一轮改动还在');

    // —— 7. 合并冲突：返回冲突文件清单（abort 之前取）——
    // 会话副本先**提交**一处对 shared.txt 的改动，再并 B 路 → 产生真冲突（未提交改动会让
    // git 直接拒绝合并、不产生 unmerged 文件，测不出清单）。
    await sh(
      ssh,
      [
        `printf "s-session\\n" >> ${sessionWt}/shared.txt`,
        `cd ${sessionWt}`,
        'git add -A',
        'git -c user.email=live@test.local -c user.name=live-test commit -qm session-change'
      ].join('\n')
    );
    const mergeB = await mergeRunWorktreeInto(ssh, {
      wtPath: roleB.path,
      branch: runWorktreeBranch(runId, 'B'),
      targetWtPath: sessionWt,
      message: 'dieyun: live test 并回副本'
    });
    assert(mergeB.ok === false && mergeB.conflict === true, `应当冲突，实际 ${JSON.stringify(mergeB)}`);
    assert(
      Array.isArray(mergeB.paths) && mergeB.paths.includes('shared.txt'),
      `冲突文件清单必须含 shared.txt，实际 ${JSON.stringify(mergeB.paths)}`
    );
    ok(`合并冲突返回了文件清单：${mergeB.paths.join('、')}`);

    // 冲突之后会话副本必须干净（merge --abort 生效）
    const sessionClean = await sh(ssh, `cd ${sessionWt} && git status --porcelain`);
    assert(!sessionClean.trim(), `冲突后会话副本应已 abort 干净，实际：${sessionClean}`);
    ok('冲突后 merge --abort 生效，会话副本未被污染');

    // —— 8. 过期回收：只留最新 N 个，先归档再删、保留分支 ——
    const oldRun = 'live-run-old';
    const oldWt = await ensureRunWorktree(ssh, { repoPath: repo, runId: oldRun, roleId: 'Z' });
    assert(oldWt.ok, '旧 run 副本建失败');
    await sh(ssh, `printf "z1\\n" >> ${oldWt.path}/b.txt`);
    // prune 按 mtime 取「最新 N 个」：把 live-run-1 的目录 touch 成最新，old 才落在过期一侧
    await sh(ssh, `touch ${repo}/.dieyun/worktrees/live-run-1`);
    const pruned = await pruneRunWorktreeRoots(ssh, { repoPath: repo, keep: 1 });
    assert(pruned.ok, `回收失败：${JSON.stringify(pruned)}`);
    const dirs = await sh(ssh, `ls -1 ${repo}/.dieyun/worktrees`);
    const dirList = dirs.split('\n').map((s) => s.trim()).filter(Boolean);
    assert(!dirList.includes(oldRun), `过期 run 目录应被回收，实际剩下：${dirList.join('、')}`);
    assert(dirList.includes('live-run-1'), `最新的 run 必须保留，实际剩下：${dirList.join('、')}`);
    const oldBranch = await sh(
      ssh,
      [
        `cd ${repo}`,
        `git branch --list ${runWorktreeBranch(oldRun, 'Z')}`,
        `git log -1 --format=%s ${runWorktreeBranch(oldRun, 'Z')}`
      ].join('\n')
    );
    assert(
      oldBranch.includes(runWorktreeBranch(oldRun, 'Z')) && oldBranch.includes('过期副本归档'),
      `回收前必须归档到分支，实际：${oldBranch}`
    );
    ok('过期回收：只留最新一份，旧的那份已归档到分支');

    console.log('\n全部通过（真机 SSH：' + TARGET + '）');
  } finally {
    if (KEEP) {
      console.log(`（保留临时目录 ${SCRATCH}）`);
    } else {
      try {
        await ssh.execScript(`rm -rf ${SCRATCH}`, 30000);
      } catch {
        // ignore
      }
    }
  }
}

main().catch((e) => {
  console.error(`\nFAIL ${e && e.message ? e.message : e}`);
  process.exit(1);
});
