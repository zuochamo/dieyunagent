'use strict';

/**
 * git 工作区状态的单一来源：porcelain 解析（git/status.js）与新增文件 patch（git/diff-text.js）。
 *
 * 回归点：
 *  1. 统一走 `--porcelain -z`：路径带空格/中文、重命名旧路径都不能被切坏；
 *  2. readGitStatus 必须读**原始 stdout**——` M file` 一旦被 trim 掉前导空格，
 *     XY 与路径边界就错位（这正是不能复用会 trim 的 gitExec 的原因）；
 *  3. 历史形态 `{path,status,kind}` 的词汇（deleted | untracked | modified）是
 *     回合基线捕获 / worktree 列表的既有契约，不能顺手「修正」。
 */

const {
  parsePorcelainZ,
  parsePorcelainStatus,
  toLegacyStatusItem,
  isConflictEntry,
  readGitStatus
} = require('../../src/git/status');
const { synthesizeNewFilePatch } = require('../../src/git/diff-text');

const NUL = '\0';
const z = (...tokens) => `${tokens.join(NUL)}${NUL}`;

/** 只实现 readGitStatus 需要的两个方法，避免为了单测起真实仓库 */
function fakeTarget(payload, opts = {}) {
  const calls = [];
  return {
    calls,
    async isRepo() {
      return opts.isRepo !== false;
    },
    async run(args) {
      calls.push(args);
      const ok = opts.ok !== false;
      return { ok, code: ok ? 0 : 1, stdout: payload, stderr: ok ? '' : 'boom' };
    }
  };
}

describe('readGitStatus', () => {
  it('用 -z + --branch 读取，并解析分支/上游/领先落后', async () => {
    const target = fakeTarget(z('## main...origin/main [ahead 1, behind 2]', ' M src/a.js'));
    const status = await readGitStatus(target);
    expect(status.isRepo).toBe(true);
    expect(status.branch).toBe('main');
    expect(status.upstream).toBe('origin/main');
    expect(status.ahead).toBe(1);
    expect(status.behind).toBe(2);
    expect(status.entries).toHaveLength(1);
    expect(target.calls[0]).toEqual(['status', '--porcelain', '-z', '--branch', '-uall']);
  });

  it('untrackedMode:normal 传 -unormal（基线/worktree 列表用的折叠口径）', async () => {
    const target = fakeTarget(z('## main'));
    await readGitStatus(target, { untrackedMode: 'normal' });
    expect(target.calls[0]).toContain('-unormal');
    expect(target.calls[0]).not.toContain('-uall');
  });

  it('首条记录以空格开头也不能错位（读原始 stdout 而非 trim 后的）', async () => {
    const target = fakeTarget(z('## main', ' M 目录/文件 名.js'));
    const status = await readGitStatus(target);
    expect(status.entries[0]).toMatchObject({ path: '目录/文件 名.js', x: ' ', y: 'M' });
  });

  it('非 git 目录返回 isRepo=false，不抛错也不发命令', async () => {
    const target = fakeTarget('', { isRepo: false });
    const status = await readGitStatus(target);
    expect(status.isRepo).toBe(false);
    expect(status.entries).toEqual([]);
    expect(target.calls).toHaveLength(0);
  });

  it('git status 失败时抛错，由调用方决定降级', async () => {
    const target = fakeTarget('', { ok: false });
    await expect(readGitStatus(target)).rejects.toThrow('boom');
  });
});

describe('parsePorcelainStatus（历史形态）', () => {
  it('保留 deleted | untracked | modified 三个词，供基线/worktree 列表消费', () => {
    const items = parsePorcelainStatus(z('## main', ' M a.js', ' D b.js', '?? c.js', 'A  d.js'));
    expect(items).toEqual([
      { path: 'a.js', status: 'M', kind: 'modified' },
      { path: 'b.js', status: 'D', kind: 'deleted' },
      { path: 'c.js', status: '??', kind: 'untracked' },
      // 旧口径下 `A ` 落在 modified，再由调用方 normalizeChangeKind 归一；
      // 这里刻意保持逐字不变，避免悄悄改变 worktree 预览的种类
      { path: 'd.js', status: 'A', kind: 'modified' }
    ]);
  });

  it('重命名取新路径，旧路径不混进列表', () => {
    const items = parsePorcelainStatus(z('## main', 'R  new.js', 'old.js'));
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ path: 'new.js', status: 'R' });
  });

  it('toLegacyStatusItem 与 parsePorcelainStatus 同源', () => {
    const entries = parsePorcelainZ(z('## main', '?? x.js')).entries;
    expect(entries.map(toLegacyStatusItem)).toEqual(parsePorcelainStatus(z('## main', '?? x.js')));
  });
});

describe('porcelain -z 解析', () => {
  it('未跟踪与冲突判定', () => {
    const { entries } = parsePorcelainZ(z('## main', '?? new.js', 'UU clash.js', 'AU both.js'));
    expect(entries[0].untracked).toBe(true);
    expect(isConflictEntry(entries[1])).toBe(true);
    expect(isConflictEntry(entries[2])).toBe(true);
    expect(isConflictEntry(entries[0])).toBe(false);
  });

  it('ignored 条目被跳过', () => {
    const { entries } = parsePorcelainZ(z('## main', '!! dist/x.js', ' M keep.js'));
    expect(entries.map((e) => e.path)).toEqual(['keep.js']);
  });
});

describe('synthesizeNewFilePatch', () => {
  it('产出合法的 new file diff 头，正文逐行加 +', () => {
    const patch = synthesizeNewFilePatch('src/a.js', 'one\ntwo\n');
    const lines = patch.split('\n');
    expect(lines[0]).toBe('diff --git a/src/a.js b/src/a.js');
    expect(lines[1]).toBe('new file mode 100644');
    expect(lines[2]).toBe('--- /dev/null');
    expect(lines[3]).toBe('+++ b/src/a.js');
    expect(lines[4]).toBe('@@ -0,0 +1 @@');
    expect(lines.slice(5)).toEqual(['+one', '+two', '+']);
  });

  it('空路径返回空串，超长正文被截断并标记', () => {
    expect(synthesizeNewFilePatch('', 'x')).toBe('');
    const long = 'x'.repeat(50);
    const patch = synthesizeNewFilePatch('a.txt', long, { maxChars: 10 });
    expect(patch).toContain('...(truncated)');
  });
});
