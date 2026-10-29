'use strict';
/**
 * 远端「应用回主目录」：命令拼装 + 结果解析。
 *
 * 这里验证的是决策边界：什么情况算成功、什么情况必须报失败、冲突后主目录是否回滚。
 * 真 git 行为由脚本里的标记行决定，不依赖 git 的报错文案。
 */
const assert = require('node:assert/strict');

const {
  parsePorcelainLine,
  buildPreviewScript,
  parsePreview,
  buildApplyScript,
  parseApply,
  previewRemoteWorktree,
  applyRemoteWorktree
} = require('../../src/ssh/remote-worktree-apply.js');

describe('porcelain 行解析', () => {
  it('取出状态码与路径', () => {
    assert.deepEqual(parsePorcelainLine(' M src/a.js'), { code: 'M', path: 'src/a.js' });
    assert.deepEqual(parsePorcelainLine('?? notes/new.md'), { code: '??', path: 'notes/new.md' });
    assert.deepEqual(parsePorcelainLine('MM src/b.js'), { code: 'MM', path: 'src/b.js' });
    assert.deepEqual(parsePorcelainLine('A  src/c.js'), { code: 'A', path: 'src/c.js' });
  });

  it('重命名取新路径；空行返回 null', () => {
    assert.deepEqual(parsePorcelainLine('R  old/a.js -> new/a.js'), { code: 'R', path: 'new/a.js' });
    assert.equal(parsePorcelainLine(''), null);
    assert.equal(parsePorcelainLine('   '), null);
  });
});

describe('预览脚本与解析', () => {
  const wt = '/srv/proj/.dieyun/worktrees/sess-abc/main';

  it('先判 git 工作树，再报分支与改动', () => {
    const script = buildPreviewScript({ wtPath: wt }).join('\n');
    assert.ok(script.includes('rev-parse --git-dir'));
    assert.ok(script.includes('WTA_NOT_GIT'));
    assert.ok(script.includes('status --porcelain'));
    assert.ok(script.includes(`WT='${wt}'`));
  });

  it('解析出分支和文件清单', () => {
    const out = ['WT_BRANCH dieyun/agent-sess-abc-main', 'WT_FILE  M src/a.js', 'WT_FILE ?? new.md'].join('\n');
    const r = parsePreview(out);
    assert.equal(r.ok, true);
    assert.equal(r.branch, 'dieyun/agent-sess-abc-main');
    assert.deepEqual(r.files, [
      { code: 'M', path: 'src/a.js' },
      { code: '??', path: 'new.md' }
    ]);
  });

  it('不是 git 工作树时明确失败，不当成「没有改动」', () => {
    const r = parsePreview('WTA_NOT_GIT\n');
    assert.equal(r.ok, false);
    assert.match(r.error, /不是 git 工作树/);
  });

  it('干净副本：ok 且零改动', () => {
    const r = parsePreview('WT_BRANCH main\n');
    assert.equal(r.ok, true);
    assert.deepEqual(r.files, []);
  });
});

describe('应用脚本', () => {
  const opts = { repoPath: '/srv/proj', wtPath: '/srv/proj/.dieyun/worktrees/sess-abc/main', branch: 'dieyun/agent-sess-abc-main' };
  const script = buildApplyScript(opts).join('\n');

  it('拒绝 detached HEAD 与非法仓库', () => {
    assert.ok(script.includes('WTA_NOT_GIT'));
    assert.ok(script.includes('WTA_DETACHED'));
    assert.ok(script.includes('rev-parse --abbrev-ref HEAD'));
  });

  it('先提交副本，再 --no-ff 合并到主目录', () => {
    assert.ok(script.includes('git -C "$WT" add -A'));
    assert.ok(script.includes('diff --cached --quiet'));
    assert.ok(/git -C "\$REPO" -c user\.name=.* merge --no-ff/.test(script));
  });

  it('冲突必须 abort，主目录不留半成品', () => {
    const conflictBlock = script.split('\n');
    const abortLine = conflictBlock.findIndex((l) => l.includes('merge --abort'));
    const conflictLine = conflictBlock.findIndex((l) => l.includes('WTA_CONFLICT'));
    const unmergedLine = conflictBlock.findIndex((l) => l.includes('--diff-filter=U'));
    assert.ok(abortLine >= 0, '缺少 merge --abort');
    assert.ok(conflictLine > abortLine, 'abort 必须在报告冲突之前');
    assert.ok(unmergedLine >= 0 && unmergedLine < abortLine, '必须先在 abort 前取到未合并清单');
  });

  it('副本不在自己分支上就拒绝（detached 提交进不了分支，merge 会假成功）', () => {
    assert.ok(script.includes('WTA_WT_DETACHED'));
    assert.ok(/\$WT_CUR"?\s*!=\s*"\$BR/.test(script), '缺少 worktree HEAD 分支比对');
  });

  it('非冲突的合并失败不能报成冲突', () => {
    assert.ok(script.includes('WTA_MERGE_FAILED'));
    // 冲突文件清单来自 diff --diff-filter=U，不再用主目录 status（会把用户原有脏文件算成冲突）
    assert.ok(!script.includes('status --porcelain | sed "s/^/WTA_FILE /"'));
  });

  it('提交身份固定，避免远端没配 user.name 就失败', () => {
    assert.ok(script.includes('user.name=dieyun-agent'));
    assert.ok(script.includes('user.email=agent@dieyun.local'));
  });

  it('分支名与消息单引号转义', () => {
    const evil = buildApplyScript({ ...opts, branch: "dieyun/it's", message: "msg'quote" }).join('\n');
    assert.ok(evil.includes(`'\\''`));
    assert.ok(!evil.includes(`BR='dieyun/it's'`));
  });
});

describe('应用结果解析', () => {
  it('合并成功', () => {
    const r = parseApply('WTA_BASE main\nWTA_COMMIT abc1234\nWTA_MERGED\nWTA_DONE\n');
    assert.equal(r.ok, true);
    assert.equal(r.code, 'MERGED');
    assert.equal(r.baseBranch, 'main');
    assert.equal(r.commit, 'abc1234');
  });

  it('冲突：失败 + 文件清单（主目录已 abort）', () => {
    const out = ['WTA_BASE main', 'WTA_COMMIT abc1234', 'WTA_CONFLICT', 'WTA_FILE src/a.js', 'WTA_DONE'].join('\n');
    const r = parseApply(out);
    assert.equal(r.ok, false);
    assert.equal(r.code, 'CONFLICT');
    assert.deepEqual(r.files, [{ code: 'U', path: 'src/a.js' }]);
    assert.equal(r.commit, 'abc1234', '副本提交应保留');
    assert.match(r.error, /回滚/);
  });

  /**
   * 冲突清单来自 `git diff --name-only`，是**裸路径**，没有 porcelain 那两列状态位。
   * 以前这里复用 porcelain 解析（砍头两个字符）：`src/a.js` 变 `c/a.js`，`a` 这种短路径
   * 直接被当成空行丢掉 —— 用户看到的冲突文件清单是错的。
   */
  it('冲突清单按裸路径解析：不砍头两个字符，短路径与带空格的路径都要保留', () => {
    const out = [
      'WTA_CONFLICT',
      'WTA_FILE src/a.js',
      'WTA_FILE a',
      'WTA_FILE my dir/a b.js',
      'WTA_DONE'
    ].join('\n');
    const r = parseApply(out);
    assert.deepEqual(
      r.files.map((f) => f.path),
      ['src/a.js', 'a', 'my dir/a b.js']
    );
  });

  it('冲突清单的行首空白不算路径内容', () => {
    const r = parseApply('WTA_CONFLICT\nWTA_FILE   src/x.js\nWTA_DONE\n');
    assert.deepEqual(r.files, [{ code: 'U', path: 'src/x.js' }]);
  });

  it('各类失败各有独立 code', () => {
    assert.equal(parseApply('WTA_NOT_GIT\n').code, 'NOT_GIT');
    assert.equal(parseApply('WTA_DETACHED\n').code, 'DETACHED');
    assert.equal(parseApply('WTA_WT_DETACHED\n').code, 'WT_DETACHED');
    assert.equal(parseApply('WTA_ADD_FAILED\n').code, 'ADD_FAILED');
    assert.equal(parseApply('WTA_COMMIT_FAILED\n').code, 'COMMIT_FAILED');
    assert.equal(parseApply('WTA_MERGE_FAILED\n').code, 'MERGE_FAILED');
    assert.equal(parseApply('').code, 'UNKNOWN');
  });
});

describe('编排（假 ssh）', () => {
  const repoPath = '/srv/proj';
  // 用真实命名规则生成副本路径：否则反推不出仓库根
  const wtPath = require('../../src/ssh/remote-worktree.js').remoteWorktreePath(repoPath, 'sess-abc');
  const fakeSsh = (stdout) => {
    const state = { scripts: [] };
    return {
      state,
      async execScript(s) {
        state.scripts.push(s);
        return { code: 0, stdout, stderr: '' };
      }
    };
  };

  it('preview 给出仓库根与「会不会是会话副本」', async () => {
    const ssh = fakeSsh('WT_BRANCH b1\nWT_FILE  M a.js\n');
    const r = await previewRemoteWorktree(ssh, { wtPath });
    assert.equal(r.ok, true);
    assert.equal(r.repoPath, repoPath);
    assert.equal(r.isSessionWorktree, true);
    assert.equal(r.files.length, 1);
  });

  it('仓库根本身被当成副本时 isSessionWorktree=false（不该应用）', async () => {
    const ssh = fakeSsh('WT_BRANCH main\n');
    const r = await previewRemoteWorktree(ssh, { wtPath: repoPath });
    assert.equal(r.isSessionWorktree, false);
  });

  it('apply 带 stderr 时把原因附在 error 上', async () => {
    const state = [];
    const ssh = {
      async execScript(s) {
        state.push(s);
        return { code: 0, stdout: 'WTA_NOT_GIT\n', stderr: 'fatal: not a git repository' };
      }
    };
    const r = await applyRemoteWorktree(ssh, { repoPath, wtPath, branch: 'b' });
    assert.equal(r.ok, false);
    assert.match(r.error, /not a git repository/);
    assert.equal(state.length, 1);
  });
});
