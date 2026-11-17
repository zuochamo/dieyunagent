'use strict';

const assert = require('node:assert');
const {
  stripWorktreeSuffix,
  projectWorkspacePath,
  buildSshUri
} = require('../../src/workspace/target');

/**
 * 会话副本（worktree）是「会话写到哪儿」的实现细节，不是它对外的身份。
 * 这些用例锁住两件事：能正确剥掉副本尾巴；非副本路径一律原样返回（不许误伤）。
 */
describe('stripWorktreeSuffix', () => {
  it('剥掉远端会话副本尾巴，回到仓库根', () => {
    assert.equal(
      stripWorktreeSuffix('/srv/proj/.dieyun/worktrees/sess-1a2b3c4d/main'),
      '/srv/proj'
    );
  });

  it('剥掉本地 Plan 副本尾巴（没有 role 段）', () => {
    assert.equal(stripWorktreeSuffix('/home/u/proj/.dieyun/worktrees/run-7'), '/home/u/proj');
  });

  it('Windows 分隔符同样认', () => {
    assert.equal(
      stripWorktreeSuffix('E:\\work\\proj\\.dieyun\\worktrees\\sess-1a2b3c4d\\main'),
      'E:\\work\\proj'
    );
  });

  it('不是副本的路径原样返回（幂等）', () => {
    for (const p of ['/srv/proj', 'E:\\work\\proj', '/srv/proj/.dieyun', '', '/']) {
      assert.equal(stripWorktreeSuffix(p), p, `不该改动 ${p}`);
    }
  });

  it('嵌套更深的副本路径不剥（只认末尾形状，防止误伤真实目录）', () => {
    // 这是「副本形状」这一层的保守口径（沙箱边界 / 建副本用）；「这是哪个项目」的问题
    // 归 projectWorkspacePath（下面那组用例），它会把中间段也折掉。
    const deep = '/srv/proj/.dieyun/worktrees/sess-1a2b3c4d/main/sub';
    assert.equal(stripWorktreeSuffix(deep), deep);
  });

  it('剥两次与剥一次结果相同', () => {
    const once = stripWorktreeSuffix('/srv/proj/.dieyun/worktrees/sess-1a2b3c4d/main');
    assert.equal(stripWorktreeSuffix(once), once);
  });
});

describe('projectWorkspacePath', () => {
  it('ssh URI：同一个仓库的两个会话得到同一个项目身份', () => {
    const a = 'ssh://u@h:22/srv/proj/.dieyun/worktrees/sess-11111111/main';
    const b = 'ssh://u@h:22/srv/proj/.dieyun/worktrees/sess-22222222/main';
    const repo = projectWorkspacePath(a);
    assert.equal(repo, 'ssh://u@h:22/srv/proj');
    assert.equal(projectWorkspacePath(b), repo);
  });

  it('ssh URI：非默认端口要保住', () => {
    assert.equal(
      projectWorkspacePath('ssh://u@h:2200/srv/proj/.dieyun/worktrees/sess-11111111/main'),
      'ssh://u@h:2200/srv/proj'
    );
  });

  it('本地路径：回到仓库根，形态不变（仍可被 parseWorkspaceInput 解析）', () => {
    const p = projectWorkspacePath('E:\\work\\proj\\.dieyun\\worktrees\\sess-11111111\\main');
    assert.equal(p, 'E:\\work\\proj');
  });

  it('非副本工作区原样返回（用户自己选的目录不许被改）', () => {
    assert.equal(projectWorkspacePath('E:\\work\\proj'), 'E:\\work\\proj');
    assert.equal(
      projectWorkspacePath('ssh://u@h:22/srv/proj'),
      'ssh://u@h:22/srv/proj',
      '远端非副本工作区必须原样'
    );
  });

  it('空值返回空串，不抛', () => {
    assert.equal(projectWorkspacePath(''), '');
    assert.equal(projectWorkspacePath(null), '');
    assert.equal(projectWorkspacePath(undefined), '');
  });

  it('副本里再开副本（交接链留下的脏路径）：每一段都折掉，回到真正的仓库根', () => {
    // 2026-11-17 现场：交接的来源会话工作区是这样两层副本，只折末尾一段会得到
    // `…/worktrees/sess-691b95cb/main/Dieyunkno` —— 一个落在**别人会话的副本里**的目录。
    assert.equal(
      projectWorkspacePath(
        'ssh://u@h:22/srv/proj/.dieyun/worktrees/sess-11111111/main/Sub/.dieyun/worktrees/sess-22222222/main'
      ),
      'ssh://u@h:22/srv/proj/Sub'
    );
  });

  it('折到没有副本段就停（幂等，不误伤普通目录）', () => {
    const repo = projectWorkspacePath(
      'ssh://u@h:22/srv/proj/.dieyun/worktrees/sess-11111111/main'
    );
    assert.equal(repo, 'ssh://u@h:22/srv/proj');
    assert.equal(projectWorkspacePath(repo), repo);
  });

  it('Windows 本地嵌套副本同样折到仓库根', () => {
    assert.equal(
      projectWorkspacePath('E:\\work\\proj\\.dieyun\\worktrees\\sess-11111111\\main\\Sub'),
      'E:\\work\\proj\\Sub'
    );
  });

  it('与 buildSshUri 往返一致（远端会话落库/反推不会漂移）', () => {
    const uri = buildSshUri({ kind: 'ssh', host: 'h', port: 22, username: 'u', remotePath: '/srv/proj' });
    assert.equal(projectWorkspacePath(uri), uri);
  });
});
