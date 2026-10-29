'use strict';
/**
 * 远端每会话一份 worktree：命名规则 + 建库脚本 + 结果解析。
 *
 * 这些是纯函数，所以能脱离远端验证。真正的 git 行为靠脚本里的标记行判定，
 * 不猜 stderr（git 的成功/失败文案不稳定）。
 */
const assert = require('node:assert/strict');

const {
  remoteWorktreeKey,
  remoteWorktreePath,
  remoteWorktreeBranch,
  repoRemotePathOf,
  buildEnsureWorktreeScript,
  parseEnsureWorktreeResult
} = require('../../src/ssh/remote-worktree.js');

describe('远端会话 worktree 命名', () => {
  it('key 由 sessionId 纯派生：同一会话永远同一份', () => {
    assert.equal(remoteWorktreeKey('sess-abc'), remoteWorktreeKey('sess-abc'));
    assert.notEqual(remoteWorktreeKey('sess-abc'), remoteWorktreeKey('sess-abd'));
    assert.match(remoteWorktreeKey('sess-abc'), /^sess-[0-9a-f]{8}$/);
    assert.equal(remoteWorktreeKey(''), '');
  });

  it('目录规则与本地 worktree-service 一致：.dieyun/worktrees/<id>/<role>', () => {
    const key = remoteWorktreeKey('sess-abc');
    assert.equal(remoteWorktreePath('/srv/proj', 'sess-abc'), `/srv/proj/.dieyun/worktrees/${key}/main`);
    // 尾斜杠 / 反斜杠都要归一，不能拼出双斜杠或 Windows 分隔符
    assert.equal(remoteWorktreePath('/srv/proj/', 'sess-abc'), `/srv/proj/.dieyun/worktrees/${key}/main`);
    assert.ok(!remoteWorktreePath('/srv/proj', 'sess-abc').includes('\\'));
    assert.equal(remoteWorktreePath('/srv/proj', ''), '');
  });

  it('分支名为 dieyun/agent-<id>-main', () => {
    assert.match(remoteWorktreeBranch('sess-abc'), /^dieyun\/agent-sess-[0-9a-f]{8}-main$/);
    assert.equal(remoteWorktreeBranch(''), '');
  });

  it('两个会话拿到两个不同目录（这是隔离的全部意义）', () => {
    assert.notEqual(remoteWorktreePath('/srv/proj', 'a'), remoteWorktreePath('/srv/proj', 'b'));
  });

  it('能从 worktree 路径反推回仓库根，非 worktree 路径原样返回', () => {
    const wt = remoteWorktreePath('/srv/proj', 'sess-abc');
    assert.equal(repoRemotePathOf(wt), '/srv/proj');
    // 幂等：仓库根本身不能再被削
    assert.equal(repoRemotePathOf('/srv/proj'), '/srv/proj');
    assert.equal(repoRemotePathOf('/'), '/');
    assert.equal(repoRemotePathOf(''), '/');
    // 反推后再派生，必须回到同一个 worktree（保证重连不产生嵌套目录）
    assert.equal(remoteWorktreePath(repoRemotePathOf(wt), 'sess-abc'), wt);
  });
});

describe('远端建 worktree 脚本', () => {
  const lines = buildEnsureWorktreeScript({
    repoPath: '/srv/proj',
    wtPath: '/srv/proj/.dieyun/worktrees/sess-x/main',
    branch: 'dieyun/agent-sess-x-main'
  });

  it('先判 git 仓库，不是就报专门标记退出', () => {
    const guard = lines.find((l) => l.includes('rev-parse --git-dir'));
    assert.ok(guard, '缺少 git 仓库判定');
    assert.ok(guard.includes('WT_NOT_GIT'));
  });

  it('幂等：目录已存在就复用，不重置分支', () => {
    const reuse = lines.find((l) => l.includes('test -d "$WT"'));
    assert.ok(reuse, '缺少已存在判定');
    assert.ok(reuse.includes('WT_REUSED'));
    // 复用分支必须是 exit 0，不能掉进下面的 worktree add
    assert.ok(reuse.includes('exit 0'));
  });

  it('基线解析成具体 sha；解不出来明确失败，不静默退回 HEAD', () => {
    assert.ok(lines.some((l) => l.includes('rev-parse "$BASE^{commit}"')));
    assert.ok(lines.some((l) => l.includes('WT_BAD_BASE')));
    // 静默退回 HEAD 会让「相对基线的变更」含义漂移
    assert.ok(!lines.some((l) => /SHA=HEAD/.test(l)), '基线失败不得回落 HEAD');
  });

  it('分支已存在时挂上去，不用 -B 重置（否则丢掉上次会话的提交）', () => {
    const joined = lines.join('\n');
    assert.ok(!/-B/.test(joined), '不应用 -B 强制重置分支');
    assert.ok(joined.includes('refs/heads/$BR'), '缺少「分支已存在」判定');
    assert.ok(joined.includes('worktree add "$WT" "$BR"'), '已存在的分支应直接 attach');
    assert.ok(joined.includes('worktree add -b "$BR"'), '新分支才用 -b');
  });

  it('路径与分支都单引号转义（远端 shell 拼接安全）', () => {
    const evil = buildEnsureWorktreeScript({
      repoPath: "/srv/a'b",
      wtPath: "/srv/a'b/.dieyun/worktrees/sess-x/main",
      branch: "dieyun/agent-it's-main"
    });
    const joined = evil.join('\n');
    // 单引号必须被转义成 '\'' ，否则远端 shell 会在引号处截断参数
    assert.ok(joined.includes(`'\\''`), '单引号未被转义');
    assert.ok(!joined.includes(`REPO='/srv/a'b'`), '出现了裸单引号直接闭合的写法');
    assert.ok(!joined.includes(`BR='dieyun/agent-it's-main'`), '分支名裸单引号未转义');
  });
});

describe('远端建 worktree 结果解析', () => {
  it('识别创建 / 复用', () => {
    assert.deepEqual(parseEnsureWorktreeResult('WT_CREATED\n'), { ok: true, reused: false, reason: 'WT_CREATED' });
    assert.deepEqual(parseEnsureWorktreeResult('WT_REUSED\n'), { ok: true, reused: true, reason: 'WT_REUSED' });
  });

  it('识别两类失败，不误判成功', () => {
    assert.equal(parseEnsureWorktreeResult('WT_NOT_GIT').ok, false);
    assert.equal(parseEnsureWorktreeResult('WT_ADD_FAILED').ok, false);
    assert.equal(parseEnsureWorktreeResult('').ok, false);
    // 标记是子串匹配，混杂的 git 输出不干扰
    assert.equal(parseEnsureWorktreeResult('Preparing worktree\nWT_CREATED\n').ok, true);
  });
});
