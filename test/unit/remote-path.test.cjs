'use strict';

/**
 * 远程路径白名单（多根，宽松档）。
 *
 * 回归点：只绑定工作空间单根时，远程连一个「工作空间之外但稳定可写」的落脚点都没有
 * ——中途截图 / 落临时文件 / 跑工作空间外的脚本直接吃 PATH_NOT_ALLOWED。
 * 现在放开到：工作空间根 + 远程 HOME 整棵 + /tmp（见 ssh/remote-path.remoteAllowedRoots）。
 */

const {
  REMOTE_SHARED_TMP_ROOT,
  remoteAllowedRoots,
  resolveRemotePath
} = require('../../src/ssh/remote-path');

const WS = '/srv/app';
const HOME = '/home/deploy';

describe('remoteAllowedRoots', () => {
  it('HOME 已知时给出「工作空间根 + HOME + /tmp」', () => {
    expect(remoteAllowedRoots(WS, HOME)).toEqual([WS, HOME, REMOTE_SHARED_TMP_ROOT]);
  });

  it('HOME 未知或为 / 时退化为「工作空间根 + /tmp」（不引入全盘放行）', () => {
    expect(remoteAllowedRoots(WS, '')).toEqual([WS, REMOTE_SHARED_TMP_ROOT]);
    expect(remoteAllowedRoots(WS, '/')).toEqual([WS, REMOTE_SHARED_TMP_ROOT]);
    expect(remoteAllowedRoots(WS, undefined)).toEqual([WS, REMOTE_SHARED_TMP_ROOT]);
  });

  it('去掉 HOME 尾部斜杠并去重', () => {
    expect(remoteAllowedRoots(WS, `${HOME}/`)).toEqual([WS, HOME, REMOTE_SHARED_TMP_ROOT]);
    // 工作空间恰在 HOME 下时只保留更宽的那条
    expect(remoteAllowedRoots(`${HOME}/proj`, HOME)).toEqual([`${HOME}/proj`, HOME, REMOTE_SHARED_TMP_ROOT]);
  });
});

describe('resolveRemotePath（单根）', () => {
  it('工作空间内放行，相对路径以工作空间根为基准', () => {
    expect(resolveRemotePath('/srv/app/a.ts', WS)).toBe('/srv/app/a.ts');
    expect(resolveRemotePath('a.ts', WS)).toBe('/srv/app/a.ts');
    expect(resolveRemotePath('.', WS)).toBe('/srv/app');
  });

  it('工作空间外拒绝', () => {
    expect(() => resolveRemotePath('/etc/passwd', WS)).toThrow(/不在远端允许范围内/);
    expect(() => resolveRemotePath('../etc/passwd', WS)).toThrow(/不在远端允许范围内/);
  });
});

describe('resolveRemotePath（多根宽松档）', () => {
  const roots = remoteAllowedRoots(WS, HOME);

  it('工作空间、HOME 任意子目录、/tmp 都放行', () => {
    expect(resolveRemotePath('/srv/app/a.ts', roots)).toBe('/srv/app/a.ts');
    expect(resolveRemotePath(`${HOME}/.dieyun/workspace/shot.png`, roots)).toBe(
      `${HOME}/.dieyun/workspace/shot.png`
    );
    expect(resolveRemotePath(`${HOME}/other-project/x.py`, roots)).toBe(`${HOME}/other-project/x.py`);
    expect(resolveRemotePath('/tmp/build/out.log', roots)).toBe('/tmp/build/out.log');
  });

  it('两棵根之外仍拒绝，相对路径基准仍是工作空间根', () => {
    expect(() => resolveRemotePath('/etc/passwd', roots)).toThrow(/不在远端允许范围内/);
    expect(() => resolveRemotePath('/var/log/syslog', roots)).toThrow(/不在远端允许范围内/);
    expect(() => resolveRemotePath('/home/other-user/x', roots)).toThrow(/不在远端允许范围内/);
    expect(resolveRemotePath('tmp/x', roots)).toBe('/srv/app/tmp/x');
  });

  it('根列表为空或非法时拒绝（不允许退化成全盘放行）', () => {
    expect(() => resolveRemotePath('/etc/passwd', [])).toThrow(/未配置/);
    expect(() => resolveRemotePath('/etc/passwd', ['  '])).toThrow(/未配置/);
  });
});

/**
 * 「完全放开路径限制」是**本地**档位，远端没有这个开关。
 *
 * 以前桌面端把 `unrestricted: true` 也传给远端根（SFTP 传输因此放宽），而远端 daemon 只按
 * ws + HOME + /tmp 校验（RPC 传输照旧拒）。同一个开关下同一操作两个答案，用户看到的是
 * 「SFTP 能写、RPC 报 PATH_NOT_ALLOWED」。现在开关这一层被删掉：远端只有一份规则。
 */
describe('远端根不接受「完全放开」开关（远端只认一份规则）', () => {
  it('无论传什么 opts，都只给 ws + HOME + /tmp', () => {
    expect(remoteAllowedRoots(WS, HOME)).toEqual([WS, HOME, '/tmp']);
    // 老调用方若还传 unrestricted，也必须无效（不能靠调用方自律）
    expect(remoteAllowedRoots(WS, HOME, { unrestricted: true })).toEqual([WS, HOME, '/tmp']);
    const roots = remoteAllowedRoots(WS, HOME, { unrestricted: true });
    expect(() => resolveRemotePath('/etc/passwd', roots)).toThrow(/不在远端允许范围内/);
  });
});
