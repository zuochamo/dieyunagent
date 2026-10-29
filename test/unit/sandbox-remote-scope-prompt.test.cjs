'use strict';

/**
 * 「完全放开路径限制」只管**本机**，模型看到的说明必须与执行侧一致。
 *
 * 执行侧（`gateway/path-policy.remoteAllowedRoots`）恒为「工作空间 + $HOME + /tmp」，
 * 远端 daemon 不认这个开关。提示里若写「远程 / 下任意路径均可读写」，模型就会去写
 * `/etc`、`/var`，然后拿到一串 PATH_NOT_ALLOWED —— 这类「说明比实现宽」比实现本身更费 token。
 */
const assert = require('node:assert/strict');

const { formatPermissionsChunk } = require('../../src/agent/agent-system-prompt');
const { remoteAllowedRoots } = require('../../src/gateway/path-policy');

const FULL = { hostControl: true, fsRead: true, fsWrite: true, shellExec: true, unrestrictedPaths: true };

describe('权限说明与远端根的单一来源一致', () => {
  it('放开档只声明本机，不许把远程也说成放开', () => {
    const text = formatPermissionsChunk(FULL);
    assert.match(text, /本机已完全放开/);
    assert.ok(!/远程\s*\/\s*下任意路径/.test(text), '不许声称远程 / 全放开');
    assert.match(text, /远程工作空间不受此开关影响/, '要明说远程不受影响，并给出真实范围');
  });

  it('执行侧：远端根与「放开」无关（同一份函数、同一份结果）', () => {
    assert.deepEqual(remoteAllowedRoots('/srv/ws', '/home/u'), ['/srv/ws', '/home/u', '/tmp']);
    // 老调用方还传第三参也无效——不能靠调用方自律
    assert.deepEqual(remoteAllowedRoots('/srv/ws', '/home/u', { unrestricted: true }), [
      '/srv/ws',
      '/home/u',
      '/tmp'
    ]);
  });

  it('默认（未放开）不提路径限制', () => {
    assert.ok(!/路径限制/.test(formatPermissionsChunk({ ...FULL, unrestrictedPaths: false })));
  });
});
