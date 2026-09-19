'use strict';

/**
 * 源码管理语义层：porcelain v1 -z 解析、numstat 归并、分组口径。
 *
 * 回归点：
 *  1. 路径必须用 -z 解析（含空格/中文/重命名的旧路径），逐行 split 会把带空格的文件名切坏；
 *  2. 同一文件允许同时出现在 staged 与 unstaged（索引一份、工作区又一份），不能合并掉；
 *  3. numstat 的重命名写法 `dir/{old => new}.js` 要归到重命名后的路径，否则行数角标对不上。
 */

const {
  parseNumstat,
  normalizeNumstatPath,
  buildScmRows,
  scmStatusLabel,
  parseGitLog,
  parseLogDecorations,
  layoutCommitLanes
} = require('../../src/git/scm-service');
// porcelain 解析已收敛到 git/status.js（源码管理 / 回合基线 / worktree 列表 / diff 上下文共用）
const { parsePorcelainZ, parseBranchHeader } = require('../../src/git/status');
const { normalizeGitRelPath } = require('../../src/git/git-target');

function z(...tokens) {
  return `${tokens.join('\0')}\0`;
}

describe('parseBranchHeader', () => {
  it('解析 upstream 与 ahead/behind', () => {
    const info = { branch: '', upstream: '', ahead: 0, behind: 0, detached: false, unborn: false };
    parseBranchHeader('main...origin/main [ahead 2, behind 3]', info);
    expect(info.branch).toBe('main');
    expect(info.upstream).toBe('origin/main');
    expect(info.ahead).toBe(2);
    expect(info.behind).toBe(3);
  });

  it('无 upstream 时只给分支名', () => {
    const info = { branch: '', upstream: '', ahead: 0, behind: 0, detached: false, unborn: false };
    parseBranchHeader('feature/x', info);
    expect(info.branch).toBe('feature/x');
    expect(info.upstream).toBe('');
  });

  it('未出生分支 / detached HEAD', () => {
    const unborn = { branch: '', upstream: '', ahead: 0, behind: 0, detached: false, unborn: false };
    parseBranchHeader('No commits yet on main', unborn);
    expect(unborn.branch).toBe('main');
    expect(unborn.unborn).toBe(true);

    const detached = { branch: '', upstream: '', ahead: 0, behind: 0, detached: false, unborn: false };
    parseBranchHeader('HEAD (no branch)', detached);
    expect(detached.detached).toBe(true);
    expect(detached.branch).toBe('HEAD');
  });
});

describe('parsePorcelainZ', () => {
  it('拆出分支头与工作区条目', () => {
    const parsed = parsePorcelainZ(
      z('## main...origin/main [ahead 1]', ' M src/a.js', '?? 新 文件.txt', 'A  added.js')
    );
    expect(parsed.branch).toBe('main');
    expect(parsed.ahead).toBe(1);
    expect(parsed.entries).toHaveLength(3);

    const [modified, untracked, added] = parsed.entries;
    expect(modified).toMatchObject({ path: 'src/a.js', x: ' ', y: 'M', untracked: false });
    expect(untracked).toMatchObject({ path: '新 文件.txt', x: '?', y: '?', untracked: true });
    expect(added).toMatchObject({ path: 'added.js', x: 'A', y: ' ' });
  });

  it('重命名取「新路径 + 紧随其后的旧路径」，不把旧路径当成独立条目', () => {
    const parsed = parsePorcelainZ(z('## main', 'R  new/name.js', 'old/name.js', ' M keep.js'));
    expect(parsed.entries).toHaveLength(2);
    expect(parsed.entries[0]).toMatchObject({
      path: 'new/name.js',
      origPath: 'old/name.js',
      x: 'R'
    });
    expect(parsed.entries[1].path).toBe('keep.js');
  });

  it('忽略 ignored 条目', () => {
    const parsed = parsePorcelainZ(z('## main', '!! dist/bundle.js', ' M a.js'));
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.entries[0].path).toBe('a.js');
  });

  it('没有 branch 头时不误吞第一条目', () => {
    const parsed = parsePorcelainZ(z(' M a.js'));
    expect(parsed.branch).toBe('');
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.entries[0].path).toBe('a.js');
  });
});

describe('parseNumstat / normalizeNumstatPath', () => {
  it('解析常规行与二进制行', () => {
    const map = parseNumstat('3\t1\tsrc/a.js\n-\t-\timg/logo.png\n');
    expect(map.get('src/a.js')).toEqual({ added: 3, removed: 1 });
    expect(map.get('img/logo.png')).toEqual({ added: 0, removed: 0 });
  });

  it('重命名归一到新路径', () => {
    expect(normalizeNumstatPath('src/{old => new}/a.js')).toBe('src/new/a.js');
    expect(normalizeNumstatPath('old.js => new.js')).toBe('new.js');
  });
});

describe('buildScmRows', () => {
  it('同一文件可同时进入 staged 与 unstaged', () => {
    const rows = buildScmRows([
      { path: 'a.js', origPath: '', x: 'M', y: 'M', untracked: false }
    ]);
    expect(rows.staged.map((r) => r.path)).toEqual(['a.js']);
    expect(rows.unstaged.map((r) => r.path)).toEqual(['a.js']);
    expect(rows.staged[0]).toMatchObject({ group: 'staged', staged: true, status: 'M' });
    expect(rows.unstaged[0]).toMatchObject({ group: 'unstaged', staged: false, status: 'M' });
  });

  it('冲突单独成组，不再重复计入 staged/unstaged', () => {
    const rows = buildScmRows([
      { path: 'c.js', origPath: '', x: 'U', y: 'U', untracked: false },
      { path: 'd.js', origPath: '', x: 'A', y: 'U', untracked: false }
    ]);
    expect(rows.conflicted.map((r) => r.path)).toEqual(['c.js', 'd.js']);
    expect(rows.staged).toHaveLength(0);
    expect(rows.unstaged).toHaveLength(0);
  });

  it('未跟踪进 untracked 组且状态标为 ?', () => {
    const rows = buildScmRows([{ path: 'n.txt', origPath: '', x: '?', y: '?', untracked: true }]);
    expect(rows.untracked).toHaveLength(1);
    expect(rows.untracked[0]).toMatchObject({ status: '?', untracked: true, group: 'untracked' });
    expect(scmStatusLabel('?')).toBe('未跟踪');
  });

  it('仅工作区改动（未暂存）不产生 staged 行', () => {
    const rows = buildScmRows([{ path: 'w.js', origPath: '', x: ' ', y: 'D', untracked: false }]);
    expect(rows.staged).toHaveLength(0);
    expect(rows.unstaged[0]).toMatchObject({ status: 'D', statusLabel: '删除' });
  });
});

describe('normalizeGitRelPath', () => {
  it('统一分隔符并去掉 ./ 前缀', () => {
    expect(normalizeGitRelPath('.\\src\\a.js')).toBe('src/a.js');
    expect(normalizeGitRelPath('./a.js')).toBe('a.js');
  });

  it('拒绝越界与绝对路径', () => {
    expect(normalizeGitRelPath('../etc/passwd')).toBe('');
    expect(normalizeGitRelPath('a/../../b')).toBe('');
    expect(normalizeGitRelPath('/etc/passwd')).toBe('etc/passwd');
    expect(normalizeGitRelPath('C:/Windows/system32')).toBe('');
    expect(normalizeGitRelPath('')).toBe('');
  });
});

describe('parseLogDecorations', () => {
  const remotes = new Set(['origin']);
  it('拆出 HEAD 指向、本地分支与 tag', () => {
    const refs = parseLogDecorations('HEAD -> main, feature/x, tag: v1.0', remotes);
    expect(refs.head).toBe('main');
    expect(refs.branches).toEqual(['main', 'feature/x']);
    expect(refs.tags).toEqual(['v1.0']);
    expect(refs.remotes).toEqual([]);
  });

  it('按 git remote 名单区分远端分支', () => {
    const refs = parseLogDecorations('main, origin/main, fork/x', remotes);
    expect(refs.branches).toEqual(['main', 'fork/x']);
    expect(refs.remotes).toEqual(['origin/main']);
  });

  it('空装饰给全空 refs', () => {
    expect(parseLogDecorations('', remotes)).toEqual({ head: '', branches: [], remotes: [], tags: [] });
  });
});

describe('parseGitLog', () => {
  const remotes = new Set(['origin']);
  it('按 \x1e/\x1f 拆提交记录与字段', () => {
    const out = [
      ['a1', 'a1', 'b2 c3', '张三', '1700000000', 'feat: 中文提交', 'HEAD -> main'],
      ['b2', 'b2', '', 'bob', '1700000001', 'init', '']
    ]
      .map((f) => f.join('\x1f'))
      .join('\x1e');
    const commits = parseGitLog(`${out}\x1e`, remotes);
    expect(commits).toHaveLength(2);
    expect(commits[0]).toMatchObject({
      sha: 'a1',
      parents: ['b2', 'c3'],
      author: '张三',
      time: 1700000000,
      subject: 'feat: 中文提交'
    });
    expect(commits[0].refs.head).toBe('main');
    expect(commits[1].parents).toEqual([]);
  });

  it('空输出与残缺记录被跳过', () => {
    expect(parseGitLog('', remotes)).toEqual([]);
    expect(parseGitLog('\x1e\x1eonly\x1fthree\x1e', remotes)).toEqual([]);
  });
});

describe('layoutCommitLanes', () => {
  function shas(seq) {
    return seq.map((c) => c.sha);
  }

  it('线性历史全部走第 0 泳道', () => {
    const commits = parseGitLog(
      [
        ['c3', 'c3', 'c2', 'a', 1, 'three', 'HEAD -> main'],
        ['c2', 'c2', 'c1', 'a', 2, 'two', ''],
        ['c1', 'c1', '', 'a', 3, 'one', '']
      ]
        .map((f) => f.join('\x1f'))
        .join('\x1e'),
      new Set()
    );
    layoutCommitLanes(commits);
    expect(commits.map((c) => c.lane)).toEqual([0, 0, 0]);
    expect(commits[0].columns).toBe(1);
    // 根提交没有父线：lane 到此为止
    expect(commits[2].edges).toEqual([]);
  });

  it('merge 提交把第二条父线弯出新泳道', () => {
    // c3 merge 了 feature（b2），主线上是 c2
    const commits = parseGitLog(
      [
        ['c3', 'c3', 'c2 b2', 'a', 1, 'merge', 'HEAD -> main'],
        ['c2', 'c2', 'c1', 'a', 2, 'main work', ''],
        ['b2', 'b2', 'c1', 'a', 3, 'feature work', 'feature'],
        ['c1', 'c1', '', 'a', 4, 'root', '']
      ]
        .map((f) => f.join('\x1f'))
        .join('\x1e'),
      new Set()
    );
    layoutCommitLanes(commits);
    expect(commits.map((c) => c.lane)).toEqual([0, 0, 1, 0]);
    // merge 节点引出两条线：主线直行（0→0），feature 线弯到新 lane 1
    expect(commits[0].edges).toEqual([{ from: 0, to: 0 }, { from: 0, to: 1 }]);
    // b2 占用 lane 1；它的父 c1 已在 lane 0（c2 占用），线从节点弯回 lane 0
    expect(commits[2].edges).toEqual([{ from: 1, to: 0 }]);
    expect(commits[3].columns).toBe(1);
  });

  it('窗口首行总是 appears，被子提交占线的不是', () => {
    const commits = parseGitLog(
      [
        ['c2', 'c2', 'c1', 'a', 1, 'two', ''],
        ['c1', 'c1', '', 'a', 2, 'one', '']
      ]
        .map((f) => f.join('\x1f'))
        .join('\x1e'),
      new Set()
    );
    // 只保留 c1（子提交在窗口外）：lane 由自身新开
    const single = [commits[1]];
    layoutCommitLanes(single);
    expect(single[0].lane).toBe(0);
    expect(single[0].appears).toBe(true);
    // 完整窗口：首行 c2 appears，c1 已被 c2 占线
    const full = layoutCommitLanes(commits);
    expect(commits[0].appears).toBe(true);
    expect(commits[1].appears).toBe(false);
    expect(commits[1].inRails).toEqual([0]);
    // active 带回页尾延伸线，供下一页续算：根提交收尾后没有延伸线
    expect(full.active).toEqual([]);
    // 若窗口截到 c2 为止，c1 就是页尾仍在延伸的线
    expect(layoutCommitLanes(commits.slice(0, 1)).active).toEqual(['c1']);
  });

  it('跨页续算：把上一页 active 传回，泳道不重新长线', () => {
    const mk = (list) =>
      parseGitLog(
        list.map((f) => f.join('\x1f')).join('\x1e'),
        new Set()
      );
    // c3 merge 了 feature 线（b2）。第一页 [c3, c2]，第二页 [b2, c1]
    const all = mk([
      ['c3', 'c3', 'c2 b2', 'a', 1, 'merge', 'HEAD -> main'],
      ['c2', 'c2', 'c1', 'a', 2, 'main work', ''],
      ['b2', 'b2', 'c1', 'a', 3, 'feature work', 'feature'],
      ['c1', 'c1', '', 'a', 4, 'root', '']
    ]);
    const page1 = layoutCommitLanes(all.slice(0, 2));
    expect(page1.commits.map((c) => c.lane)).toEqual([0, 0]);
    expect(page1.active).toEqual(['c1', 'b2']);

    const page2 = layoutCommitLanes(all.slice(2), page1.active.map((sha) => ({ sha })));
    expect(page2.commits[0].lane).toBe(1); // b2 延续第一页的 lane 1
    expect(page2.commits[0].appears).toBe(false);
    expect(page2.commits[1].lane).toBe(0);
    // 与整仓一次算完的结果完全一致
    layoutCommitLanes(all);
    expect(all.slice(2).map((c) => c.lane)).toEqual(page2.commits.map((c) => c.lane));
  });

  it('分叉：两个子提交共享父，汇合线各自弯回父 lane', () => {
    const commits = parseGitLog(
      [
        ['cA', 'cA', 'c0', 'a', 1, 'left', ''],
        ['cB', 'cB', 'c0', 'a', 2, 'right', ''],
        ['c0', 'c0', '', 'a', 3, 'root', '']
      ]
        .map((f) => f.join('\x1f'))
        .join('\x1e'),
      new Set()
    );
    layoutCommitLanes(commits);
    expect(commits.map((c) => c.lane)).toEqual([0, 1, 0]);
    // cA 主线直行；cB 是分支 tip（appears，无进入线），父 c0 已被 lane 0 占用 → 弯回
    expect(commits[0].edges).toEqual([{ from: 0, to: 0 }]);
    expect(commits[1].appears).toBe(true);
    expect(commits[1].edges).toEqual([{ from: 1, to: 0 }]);
    expect(commits[2].columns).toBe(1);
  });
});
