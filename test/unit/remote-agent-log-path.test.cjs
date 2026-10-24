'use strict';
/**
 * 远程 Agent 日志按项目分开（2026-10-23）。
 *
 * 原来所有 remotePath 共用 `~/.dieyun/remote-agent/current/agent.log`：同一台机器两个项目
 * 各起一个 remote agent 进程，用 `>>` 追加同一个文件 ⇒ 日志交错、分不清归属；
 * 而且 `current` 是随版本切换的软链，升级安装包会把日志一起换掉。
 */
const assert = require('node:assert/strict');

const {
  remoteLogDir,
  remoteLogFileName,
  remoteLogPathFor,
  remoteLogDisplayPath
} = require('../../src/ssh/remote-gateway-manager.js');

describe('远程 Agent 日志按项目分开', () => {
  const HOME = '/home/dieyunx';

  it('落在 ~/.dieyun/remote-agent/logs/ 下，不随 current 软链切换', () => {
    assert.equal(remoteLogDir(HOME), '/home/dieyunx/.dieyun/remote-agent/logs');
    assert.equal(remoteLogPathFor(HOME, '/srv/projA'), `/home/dieyunx/.dieyun/remote-agent/logs/${remoteLogFileName('/srv/projA')}`);
    // 不出现 current / 版本目录
    assert.ok(!remoteLogPathFor(HOME, '/srv/projA').includes('/current/'));
  });

  it('同机器两个项目拿到不同文件', () => {
    const a = remoteLogFileName('/srv/projA');
    const b = remoteLogFileName('/srv/projB');
    assert.notEqual(a, b);
    // 可读 slug + 稳定 hash
    assert.match(a, /^agent-srv_projA-[0-9a-f]{8}\.log$/);
    assert.match(b, /^agent-srv_projB-[0-9a-f]{8}\.log$/);
  });

  it('同一路径永远同名（与端口、版本、调用次数无关）', () => {
    assert.equal(remoteLogFileName('/srv/projA'), remoteLogFileName('/srv/projA'));
    // 末尾斜杠的归一化由 normalizeRemotePath 负责，这里只要求不同字符串不撞车
    assert.notEqual(remoteLogFileName('/srv/projA'), remoteLogFileName('/srv/projA/'));
  });

  it('非 ASCII / 纯符号路径退化成 hash 名，且互不冲突', () => {
    const cn1 = remoteLogFileName('/中文/项目一');
    const cn2 = remoteLogFileName('/中文/项目二');
    assert.match(cn1, /^agent-path-[0-9a-f]{8}\.log$/);
    assert.notEqual(cn1, cn2);
    // 根目录
    assert.match(remoteLogFileName('/'), /^agent-path-[0-9a-f]{8}\.log$/);
  });

  it('文件名里不含路径分隔符（远端 shell 拼路径安全）', () => {
    for (const p of ['/srv/a b/c', '/x/../y', 'C:\\proj\\a', '/中文/项目']) {
      const name = remoteLogFileName(p);
      assert.ok(!name.includes('/'), name);
      assert.ok(!name.includes('\\'), name);
      assert.ok(name.length <= 80, name);
    }
  });

  it('展示路径是 ~/ 形式（UI/状态回报用）', () => {
    const disp = remoteLogDisplayPath('/srv/projA');
    assert.ok(disp.startsWith('~/.dieyun/remote-agent/logs/agent-srv_projA-'), disp);
  });
});
