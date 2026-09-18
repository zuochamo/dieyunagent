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
    expect(() => resolveRemotePath('/etc/passwd', WS)).toThrow(/不在远程工作空间内/);
    expect(() => resolveRemotePath('../etc/passwd', WS)).toThrow(/不在远程工作空间内/);
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
    expect(() => resolveRemotePath('/etc/passwd', roots)).toThrow(/不在远程工作空间内/);
    expect(() => resolveRemotePath('/var/log/syslog', roots)).toThrow(/不在远程工作空间内/);
    expect(() => resolveRemotePath('/home/other-user/x', roots)).toThrow(/不在远程工作空间内/);
    expect(resolveRemotePath('tmp/x', roots)).toBe('/srv/app/tmp/x');
  });

  it('根列表为空或非法时拒绝（不允许退化成全盘放行）', () => {
    expect(() => resolveRemotePath('/etc/passwd', [])).toThrow(/未配置/);
    expect(() => resolveRemotePath('/etc/passwd', ['  '])).toThrow(/未配置/);
  });
});

describe('remoteAllowedRoots（完全放开路径限制开关，默认关）', () => {
  it('开关打开 → 只剩 /，任意绝对路径放行', () => {
    expect(remoteAllowedRoots(WS, HOME, { unrestricted: true })).toEqual(['/']);
    expect(remoteAllowedRoots(WS, '', { unrestricted: true })).toEqual(['/']);
    const roots = remoteAllowedRoots(WS, HOME, { unrestricted: true });
    expect(resolveRemotePath('/etc/passwd', roots)).toBe('/etc/passwd');
    expect(resolveRemotePath('/home/other-user/x', roots)).toBe('/home/other-user/x');
    expect(resolveRemotePath('/var/log/syslog', roots)).toBe('/var/log/syslog');
  });

  it('开关关闭（含未传）时行为不变', () => {
    expect(remoteAllowedRoots(WS, HOME, { unrestricted: false })).toEqual([WS, HOME, '/tmp']);
    expect(remoteAllowedRoots(WS, HOME)).toEqual([WS, HOME, '/tmp']);
    expect(remoteAllowedRoots(WS, HOME, {})).toEqual([WS, HOME, '/tmp']);
  });
});
