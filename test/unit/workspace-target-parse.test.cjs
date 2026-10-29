'use strict';

const assert = require('node:assert');
const { parseWorkspaceInput, targetFromDisk } = require('../../src/workspace/target');

/**
 * 工作空间字符串的解析边界。
 *
 * 事故背景：模型照 `session_new` 的旧提示写成 `ssh:user@host:/path`（scp 风格），
 * 解析器认不出，静默 path.resolve 成 `E:\...\ssh:user@host:\path` —— 会话挂上一个
 * 不存在的本地目录，之后每个远程工具都 CWD_NOT_FOUND。
 * 这些用例锁定：合法远端 URI 必须解析成 ssh；认得出远端前缀但不合法的串必须返回
 * null（不挂工作区），不许降级成本地路径。
 */
describe('parseWorkspaceInput — 远端 URI', () => {
  it('ssh:// 规范串解析成 ssh 目标', () => {
    const t = parseWorkspaceInput('ssh://dieyunx@192.168.31.62/run/media/dieyunx/proj');
    assert.deepEqual(t, {
      kind: 'ssh',
      username: 'dieyunx',
      host: '192.168.31.62',
      port: 22,
      remotePath: '/run/media/dieyunx/proj'
    });
  });

  it('ssh:user@host/path（无 //）仍解析成 ssh —— 历史存量格式', () => {
    const t = parseWorkspaceInput('ssh:dieyunx@192.168.31.62/run/media/dieyunx/proj');
    assert.equal(t && t.kind, 'ssh');
    assert.equal(t.remotePath, '/run/media/dieyunx/proj');
  });

  it('ssh:user@host:/path（scp 风格）解析失败返回 null，不成本地路径', () => {
    assert.equal(
      parseWorkspaceInput('ssh:dieyunx@192.168.31.62:/run/media/dieyunx/dieyunserver/dieyuntools'),
      null
    );
  });

  it('带端口的规范串保留端口', () => {
    const t = parseWorkspaceInput('ssh://dieyunx@192.168.31.62:2222/srv/app');
    assert.equal(t.port, 2222);
    assert.equal(t.remotePath, '/srv/app');
  });
});

describe('parseWorkspaceInput — 本地路径', () => {
  it('绝对路径解析成 local', () => {
    const t = parseWorkspaceInput('D:\\work\\repo');
    assert.equal(t.kind, 'local');
    assert.match(t.path, /repo$/);
  });

  it('对象形态的 ssh 目标按原值归一', () => {
    const t = parseWorkspaceInput({
      kind: 'ssh',
      host: 'h',
      username: 'u',
      port: 0,
      remotePath: 'srv//app/'
    });
    assert.deepEqual(t, { kind: 'ssh', host: 'h', username: 'u', port: 22, remotePath: '/srv/app' });
  });

  it('对象形态 local 却带远端 URI → null，不 path.resolve 成假目录', () => {
    // 事故形态：索引面板/会话把 `ssh://user@host/path` 包成 {kind:'local'}，
    // path.resolve 后得到 `E:\...\ssh:\user@host\path`，本地 core 里从此多一个
    // 永远索引不到的键，面板恒「未建立 / 0 / 从未构建」。
    assert.equal(
      parseWorkspaceInput({
        kind: 'local',
        workspacePath: 'ssh://dieyunx@192.168.31.62/run/media/dieyunx/dieyunserver/dieyuntools'
      }),
      null
    );
    assert.equal(
      parseWorkspaceInput({ kind: 'local', path: 'ssh:dieyunx@192.168.31.62:/srv/app' }),
      null
    );
  });
});

describe('targetFromDisk — 被写坏的本地条目', () => {
  it('kind=local 但 workspacePath 是 ssh URI 时照样还原成 ssh 目标', () => {
    const t = targetFromDisk({
      kind: 'local',
      workspacePath: 'ssh://dieyunx@192.168.31.62/run/media/dieyunx/dieyunserver/dieyuntools'
    });
    assert.equal(t && t.kind, 'ssh');
    assert.equal(t.remotePath, '/run/media/dieyunx/dieyunserver/dieyuntools');
  });
});
