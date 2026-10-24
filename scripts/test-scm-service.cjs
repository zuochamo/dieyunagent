'use strict';

/**
 * 源码管理服务层（src/git/scm-service.js + git-target.js）真实仓库集成测试。
 *
 * 为什么要真跑 git：
 *  - discard 的语义（删文件 / 取消暂存 / 还原）取决于 cat-file 实际状态，纯 mock 测不出来；
 *  - porcelain -z 与 numstat 的重命名写法只有真 git 才会产出。
 * 全程只用本地 target；SSH 分支复用同一份实现（git-target 按 kind 分派），
 * 所以这里覆盖的语义对远端同样成立。
 */

const os = require('os');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const { createGitTarget } = require('../src/git/git-target');
const scm = require('../src/git/scm-service');

let passed = 0;
const failures = [];

function check(label, cond, detail) {
  if (cond) {
    passed += 1;
    console.log(`  ✓ ${label}`);
    return;
  }
  failures.push(detail ? `${label} — ${detail}` : label);
  console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
}

function eq(label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  check(label, a === e, a === e ? '' : `实际 ${a}，期望 ${e}`);
}

const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'dieyun-scm-'));
const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Dieyun Test',
  GIT_AUTHOR_EMAIL: 'test@dieyun.local',
  GIT_COMMITTER_NAME: 'Dieyun Test',
  GIT_COMMITTER_EMAIL: 'test@dieyun.local'
};

function raw(args) {
  return execFileSync('git', args, {
    cwd: repo,
    env: gitEnv,
    stdio: ['ignore', 'pipe', 'pipe']
  }).toString();
}

/** 初始分支名随 git 版本可能是 main 或 master，测试断言不能硬编码 */
let mainBranch = '';

function write(rel, text) {
  const abs = path.join(repo, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text);
}

function readText(rel) {
  return fs.readFileSync(path.join(repo, rel), 'utf8').replace(/\r\n/g, '\n');
}

function paths(rows) {
  return rows.map((r) => r.path).sort();
}

async function main() {
  raw(['init', '-q']);
  // 关掉行尾转换：测试断言的是内容语义，不该随宿主机 autocrlf 变红
  raw(['config', 'core.autocrlf', 'false']);
  raw(['config', 'commit.gpgsign', 'false']);
  // repo 级身份自给：scmCommit 按设计不伪造身份，宿主全局 gitconfig 可能没配 user.name，
  // 缺了它场景 5 会以 GIT_IDENTITY_MISSING 失败（不是产品回归）
  raw(['config', 'user.name', 'Dieyun Test']);
  raw(['config', 'user.email', 'test@dieyun.local']);
  mainBranch = raw(['symbolic-ref', '--short', 'HEAD']).trim();
  write('a.txt', 'one\n');
  write('keep.txt', 'k\n');
  write('dir/ren.txt', 'r\n');
  fs.writeFileSync(path.join(repo, 'bin.dat'), Buffer.from([0, 1, 2, 3]));
  raw(['add', '.']);
  raw(['commit', '-qm', 'init']);

  const git = createGitTarget({ kind: 'local', root: repo });

  console.log('· 场景 1：status 分组与行数角标');
  write('a.txt', 'one\ntwo\n');
  fs.writeFileSync(path.join(repo, 'bin.dat'), Buffer.from([0, 9, 9, 9]));
  write('b.txt', 'bee\n');
  raw(['add', 'b.txt']);
  write('新 文件.txt', 'n\n');
  fs.unlinkSync(path.join(repo, 'keep.txt'));
  raw(['mv', 'dir/ren.txt', 'dir/renamed.txt']);

  let st = await scm.getScmStatus(git);
  check('识别为 git 仓库', st.isRepo === true);
  check('分支名非空', !!st.branch, `branch=${st.branch}`);
  eq('已暂存含新增与重命名', paths(st.groups.staged), ['b.txt', 'dir/renamed.txt']);
  eq('未暂存含修改与删除', paths(st.groups.unstaged), ['a.txt', 'bin.dat', 'keep.txt']);
  eq('未跟踪含带空格中文名', paths(st.groups.untracked), ['新 文件.txt']);
  check(
    '重命名行保留旧路径',
    st.groups.staged.some((r) => r.path === 'dir/renamed.txt' && r.origPath === 'dir/ren.txt'),
    JSON.stringify(st.groups.staged)
  );
  const statA = st.groups.unstaged.find((r) => r.path === 'a.txt');
  eq('修改行行数为 +1 -0', { added: statA.added, removed: statA.removed }, { added: 1, removed: 0 });
  const untrackedRow = st.groups.untracked[0];
  check('未跟踪不给行数（避免逐个 --no-index）', untrackedRow.added === null);

  console.log('· 场景 2：单文件 diff 的 before/after');
  const diffUnstaged = await scm.getScmFileDiff(git, { path: 'a.txt', group: 'unstaged' });
  eq('未暂存 diff 取索引版本为 before', diffUnstaged.beforeText, 'one\n');
  eq('未暂存 diff 取工作区版本为 after', diffUnstaged.afterText, 'one\ntwo\n');
  eq(
    '未暂存 diff 行数',
    { added: diffUnstaged.added, removed: diffUnstaged.removed },
    { added: 1, removed: 0 }
  );

  const diffStaged = await scm.getScmFileDiff(git, { path: 'b.txt', group: 'staged' });
  eq('已暂存新增 before 为空', diffStaged.beforeText, '');
  eq('已暂存新增 after 为索引内容', diffStaged.afterText, 'bee\n');
  check('已暂存新增标记 created', diffStaged.created === true);

  const diffDeleted = await scm.getScmFileDiff(git, { path: 'keep.txt', group: 'unstaged' });
  eq('删除文件 after 为空', diffDeleted.afterText, '');
  eq(
    '删除文件行数',
    { added: diffDeleted.added, removed: diffDeleted.removed },
    { added: 0, removed: 1 }
  );

  const diffBinary = await scm.getScmFileDiff(git, { path: 'bin.dat', group: 'unstaged' });
  check('二进制文件标记 binary 且不给文本', diffBinary.binary === true && diffBinary.afterText === '');

  const diffTraversal = await scm.getScmFileDiff(git, { path: '../outside.txt', group: 'unstaged' });
  check('越界路径被拒', diffTraversal.ok === false);

  console.log('· 场景 3：暂存 / 取消暂存');
  eq('取消暂存 b.txt', (await scm.scmUnstage(git, ['b.txt'])).ok, true);
  st = await scm.getScmStatus(git);
  check('b.txt 回到未跟踪', paths(st.groups.untracked).includes('b.txt'));

  eq('暂存指定文件', (await scm.scmStage(git, ['a.txt', 'b.txt', '新 文件.txt'])).ok, true);
  st = await scm.getScmStatus(git);
  eq('全部进入已暂存', paths(st.groups.staged), ['a.txt', 'b.txt', 'dir/renamed.txt', '新 文件.txt']);
  eq('未暂存只剩删除的 keep.txt 与二进制', paths(st.groups.unstaged), ['bin.dat', 'keep.txt']);
  eq('越界路径被过滤后无剩余项', (await scm.scmStage(git, ['../outside.txt'])).ok, false);

  console.log('· 场景 4：discard（按 git 实际状态判定，不信 UI 分组）');
  // b.txt 此刻已在索引（A）却不在 HEAD：UI 传来的 group 是过期快照（untracked），
  // 必须「取消暂存 + 删除文件」，而不是只删文件、把索引里的新增记录留下。
  // dir/renamed.txt 带 origPath：重命名要连旧名一起撤销，否则工作区会留下
  // 「旧名消失 + 新名残留」的悬空状态。
  const disc = await scm.scmDiscard(git, {
    entries: [
      { path: 'b.txt', group: 'untracked' },
      { path: '新 文件.txt', group: 'untracked' },
      { path: 'a.txt', group: 'unstaged' },
      { path: 'keep.txt', group: 'unstaged' },
      { path: 'bin.dat', group: 'unstaged' },
      { path: 'dir/renamed.txt', group: 'staged', origPath: 'dir/ren.txt' }
    ],
    deleteUntracked: true
  });
  check('丢弃整体成功', disc.ok === true, JSON.stringify(disc.failed));
  check('新增文件被删除', !fs.existsSync(path.join(repo, 'b.txt')));
  check('未跟踪文件被删除', !fs.existsSync(path.join(repo, '新 文件.txt')));
  check('删除的受控文件被还原', fs.existsSync(path.join(repo, 'keep.txt')));
  eq('a.txt 工作区还原为 HEAD 内容', readText('a.txt'), 'one\n');
  check(
    '重命名被撤销（旧名回归、新名清掉）',
    fs.existsSync(path.join(repo, 'dir/ren.txt')) && !fs.existsSync(path.join(repo, 'dir/renamed.txt'))
  );
  st = await scm.getScmStatus(git);
  eq('丢弃后工作区完全干净', st.total, 0);

  write('untracked-keep.txt', 'x\n');
  const noDelete = await scm.scmDiscard(git, {
    entries: [{ path: 'untracked-keep.txt', group: 'untracked' }],
    deleteUntracked: false
  });
  check(
    '关闭删除时明确失败且不删文件',
    noDelete.ok === false && fs.existsSync(path.join(repo, 'untracked-keep.txt')),
    JSON.stringify(noDelete)
  );
  fs.rmSync(path.join(repo, 'untracked-keep.txt'), { force: true });

  console.log('· 场景 5：提交');
  eq('空提交信息被拒', (await scm.scmCommit(git, { message: '   ' })).code, 'EMPTY_MESSAGE');
  write('a.txt', 'one\nthree\n');
  // 带 paths：走「先暂存这些文件再提交」的分支
  const committed = await scm.scmCommit(git, {
    message: 'feat: scm e2e\n\nbody line',
    paths: ['a.txt']
  });
  check('提交成功', committed.ok === true, committed.error);
  check('返回短 sha', /^[0-9a-f]{7,}$/.test(String(committed.sha || '')), String(committed.sha));
  eq('提交标题原样落盘', raw(['log', '-1', '--pretty=%s']).trim(), 'feat: scm e2e');
  eq('提交正文多行保留', raw(['log', '-1', '--pretty=%b']).trim(), 'body line');
  st = await scm.getScmStatus(git);
  eq('提交后工作区干净', st.total, 0);

  console.log('· 场景 6：非 git 目录');
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'dieyun-plain-'));
  try {
    const plainStatus = await scm.getScmStatus(createGitTarget({ kind: 'local', root: plain }));
    check('非 git 目录返回 isRepo=false 而不是抛错', plainStatus.ok === true && plainStatus.isRepo === false);
  } finally {
    fs.rmSync(plain, { recursive: true, force: true });
  }

  console.log('· 场景 7：提交历史（log / commit_files / commit_diff）');
  // 此时仓库里已有两个提交（init + feat: scm e2e）；再造一个分支提交 + merge，
  // 验证泳道布局吃到真实的 fork/merge 拓扑。
  raw(['checkout', '-qb', 'feature']);
  write('dir/feat.txt', 'feature\n');
  raw(['add', '.']);
  raw(['commit', '-qm', 'feat: feature work']);
  raw(['checkout', '-q', mainBranch]);
  write('a.txt', 'one\nthree\nfour\n');
  raw(['add', '.']);
  raw(['commit', '-qm', 'chore: main moves on']);
  raw(['merge', '--no-ff', '-qm', 'merge: feature', 'feature']);

  const logAll = await scm.getScmLog(git, { limit: 50 });
  check('log 成功', logAll.ok === true, logAll.error);
  eq('拿到全部 5 个提交', logAll.commits.length, 5);
  eq('date-order 顶部是 merge 提交', logAll.commits[0].subject, 'merge: feature');
  check(
    'merge 提交带两个 parent',
    logAll.commits[0].parents.length === 2,
    JSON.stringify(logAll.commits[0].parents)
  );
  check(
    'HEAD 装饰落在 merge 提交上',
    logAll.commits[0].refs.head === mainBranch &&
      logAll.commits[0].refs.branches.includes(mainBranch),
    JSON.stringify(logAll.commits[0].refs)
  );
  check(
    'feature 分支装饰落在对应提交上',
    logAll.commits.some((c) => c.subject === 'feat: feature work' && c.refs.branches.includes('feature')),
    JSON.stringify(logAll.commits.map((c) => c.refs))
  );
  const lanes = logAll.commits.map((c) => c.lane);
  check(
    '泳道布局出现过第二列（fork/merge 拓扑）',
    lanes.includes(1),
    JSON.stringify(lanes)
  );
  check(
    '每条提交的 edges 从自身 lane 引出',
    logAll.commits.every((c) => c.edges.every((e) => e.from === c.lane)),
    JSON.stringify(logAll.commits.map((c) => c.edges))
  );

  const logPage1 = await scm.getScmLog(git, { limit: 2 });
  eq('分页第一页 2 条', logPage1.commits.length, 2);
  check('还有更多（done=false）', logPage1.done === false);
  check('页尾带回延伸线', Array.isArray(logPage1.active) && logPage1.active.length > 0, JSON.stringify(logPage1.active));
  const logPage2 = await scm.getScmLog(git, { limit: 2, skip: 2, resume: logPage1.active });
  eq('分页第二页衔接第一页', logPage2.commits[0].sha, logAll.commits[2].sha);
  check(
    '跨页续算后第二页泳道无缝（无凭空新线）',
    logPage2.commits.every((c) => c.appears === false),
    JSON.stringify(logPage2.commits.map((c) => [c.sha, c.lane, c.appears]))
  );
  check(
    '跨页续算的泳道与整仓一次算完一致',
    JSON.stringify(logPage2.commits.map((c) => [c.lane, c.edges])),
    JSON.stringify(logAll.commits.slice(2, 4).map((c) => [c.lane, c.edges]))
  );
  const logTail = await scm.getScmLog(git, { limit: 50, skip: 4 });
  eq('翻到尽头只剩根提交', logTail.commits.length, 1);
  check('根提交标 done', logTail.done === true);
  check('根提交没有父线', logTail.commits[0].parents.length === 0 && logTail.commits[0].edges.length === 0);

  const mergeSha = logAll.commits[0].sha;
  const files = await scm.getScmCommitFiles(git, { sha: mergeSha });
  // --no-ff merge 的树与主线一致：merge 提交本身没有独立变更文件
  check('merge 提交文件列表可读', files.ok === true, files.error);
  const featSha = logAll.commits.find((c) => c.subject === 'feat: feature work').sha;
  const featFiles = await scm.getScmCommitFiles(git, { sha: featSha });
  eq(
    'feature 提交文件列表',
    featFiles.files.map((f) => `${f.status}:${f.path}`),
    ['A:dir/feat.txt']
  );
  check('文件列表带行数', featFiles.files[0].added === 1, JSON.stringify(featFiles.files[0]));

  const featDiff = await scm.getScmCommitDiff(git, { sha: featSha, path: 'dir/feat.txt' });
  check('提交内 diff 成功', featDiff.ok === true, featDiff.error);
  eq('提交内 diff before 为空（新建）', featDiff.beforeText, '');
  eq('提交内 diff after 为文件内容', featDiff.afterText, 'feature\n');
  check('提交内 diff 标记 created', featDiff.created === true);
  eq('提交内 diff 行数', { added: featDiff.added, removed: featDiff.removed }, { added: 1, removed: 0 });

  // 重命名提交：commit_diff 要能从旧路径拿 before
  raw(['mv', 'dir/feat.txt', 'dir/feat-renamed.txt']);
  raw(['add', '.']);
  raw(['commit', '-qm', 'chore: rename feature file']);
  const logAfterRename = await scm.getScmLog(git, { limit: 5 });
  const renameSha = logAfterRename.commits[0].sha;
  const renameDiff = await scm.getScmCommitDiff(git, { sha: renameSha, path: 'dir/feat-renamed.txt' });
  check('重命名 diff 成功', renameDiff.ok === true, renameDiff.error);
  eq('重命名 diff 旧路径为 before', renameDiff.beforeText, 'feature\n');
  check('重命名 diff 标记 R 状态与 origPath', renameDiff.status === 'R' && renameDiff.origPath === 'dir/feat.txt');

  check('无效 sha 被拒', (await scm.getScmCommitFiles(git, { sha: 'zzzz' })).ok === false);
  check(
    '提交 diff 拒绝越界路径',
    (await scm.getScmCommitDiff(git, { sha: featSha, path: '../outside' })).ok === false
  );
}

main()
  .catch((err) => {
    failures.push(`未捕获异常：${(err && err.stack) || err}`);
  })
  .finally(() => {
    fs.rmSync(repo, { recursive: true, force: true });
    if (failures.length) {
      console.error('\n[scm-service] 失败项：');
      for (const f of failures) console.error(`  - ${f}`);
      process.exit(1);
    }
    console.log(`\n[scm-service] ${passed} 项通过`);
  });
