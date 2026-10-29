'use strict';
/**
 * 远程 git 目标的结果语义：**「没拿到退出码」不等于「成功」**。
 *
 * 这条 bug 的形状很具体：`Number(null) === 0`，于是「通道在命令中途断了、一个
 * exit-status 都没收到」会被换算成退出码 0 → `ok: true` + 空 stdout →
 * 上层看到「空」就报「工作区干净 / 文件不存在 / 没有匹配」。
 */
const assert = require('node:assert/strict');

const { createGitTarget } = require('../../src/git/git-target');

function targetWith(exec) {
  return createGitTarget({ kind: 'ssh', root: '/repo', sshExec: exec });
}

describe('ssh git target：退出码未知不许当成功', () => {
  it('code=0 → ok', async () => {
    const git = targetWith(async () => ({ code: 0, stdout: 'ok', stderr: '' }));
    const r = await git.run(['status']);
    assert.equal(r.ok, true);
    assert.equal(r.code, 0);
  });

  it('code=null（没收到 exit-status）→ ok:false，而不是 0', async () => {
    const git = targetWith(async () => ({ code: null, stdout: '', stderr: '' }));
    const r = await git.run(['status']);
    assert.equal(r.ok, false);
    assert.equal(r.code, null, '不许把 null 补成 0');
  });

  it('exec 抛错（含 SSH_EXEC_UNKNOWN_STATUS）→ ok:false 且 code 不是 0', async () => {
    const git = targetWith(async () => {
      throw Object.assign(new Error('通道已关闭'), { code: 'SSH_EXEC_UNKNOWN_STATUS' });
    });
    const r = await git.run(['status', '--porcelain']);
    assert.equal(r.ok, false);
    assert.equal(r.code, null);
    assert.match(r.stderr, /通道已关闭/);
  });

  it('非零退出码带 stderr 原样上抛（textOrThrow）', async () => {
    const git = targetWith(async () => ({ code: 128, stdout: '', stderr: 'fatal: not a git repository' }));
    await assert.rejects(() => git.textOrThrow(['log']), /not a git repository/);
  });

  it('pathExists：code=null → false（「不知道」不能报成「存在」）', async () => {
    const git = targetWith(async () => ({ code: null, stdout: '', stderr: '' }));
    assert.equal(await git.pathExists('.gitignore'), false);
  });

  it('pathExists：code=1 → false；code=0 → true', async () => {
    assert.equal(await targetWith(async () => ({ code: 1 })).pathExists('x'), false);
    assert.equal(await targetWith(async () => ({ code: 0 })).pathExists('x'), true);
  });
});

describe('ssh git target：读不到内容 vs 内容为空', () => {
  it('文件不存在（exit 44）→ 抛 ENOENT，不返回空文本', async () => {
    const git = targetWith(async () => ({ code: 44, stdout: '', stderr: '' }));
    await assert.rejects(() => git.readText('a.txt'), (e) => e.code === 'ENOENT');
  });

  it('无权限等真失败 → 抛 EIO 并带上远端 stderr', async () => {
    const git = targetWith(async () => ({ code: 1, stdout: '', stderr: 'Permission denied' }));
    await assert.rejects(
      () => git.readText('a.txt'),
      (e) => e.code === 'EIO' && /Permission denied/.test(e.message)
    );
  });

  it('真的是空文件（exit 0，无输出）→ ok + 空文本', async () => {
    const git = targetWith(async () => ({ code: 0, stdout: '', stderr: '' }));
    const r = await git.readText('empty.txt');
    assert.equal(r.ok, true);
    assert.equal(r.text, '');
  });

  it('用 `[ -e ]` 探测而不是 `|| true` 吞掉 head 的失败', async () => {
    let script = '';
    const git = targetWith(async (cmd) => {
      script = cmd;
      return { code: 0, stdout: 'x' };
    });
    await git.readText('a/b.txt');
    assert.match(script, /\[ -e /);
    assert.doesNotMatch(script, /\|\| true/);
  });

  it('超过上限的字节能被截断标记出来', async () => {
    const git = targetWith(async () => ({ code: 0, stdout: 'a'.repeat(64) }));
    const r = await git.readText('big.txt', { maxBytes: 8 });
    assert.equal(r.truncated, true);
    assert.equal(r.text.length, 8);
  });

  it('二进制（含 NUL）→ ok:false + binary', async () => {
    const git = targetWith(async () => ({ code: 0, stdout: 'a\u0000b' }));
    const r = await git.readText('bin.dat');
    assert.equal(r.ok, false);
    assert.equal(r.binary, true);
  });
});

describe('ssh git target：删除文件', () => {
  it('code=null → 抛错（不能当成已删除）', async () => {
    const git = targetWith(async () => ({ code: null, stdout: '', stderr: '' }));
    await assert.rejects(() => git.removeFile('x'), /远程删除文件失败/);
  });

  it('code=0 → ok', async () => {
    const git = targetWith(async () => ({ code: 0 }));
    assert.deepEqual(await git.removeFile('x'), { ok: true });
  });
});
