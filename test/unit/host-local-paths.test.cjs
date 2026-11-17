'use strict';

/**
 * 「本机 vs 会话工作空间」路径语义（`src/gateway/host-local.js`）的单元测试。
 *
 * 这一层锁的是判定形状，不是文案：
 * - 不带前缀 → 一律交给会话工作空间（SSH 会话里就是远端）；
 * - `local:` → 本机，且必须是绝对路径（本机相对路径没有唯一基准）；
 * - 本机 glob 要把绝对 pattern 拆成 root + 相对 pattern（rg -g 是相对 cwd 的）；
 * - 后台句柄前缀自己说出在哪台机器。
 */

const path = require('path');

const {
  isLocalPathRef,
  splitHostLocalRef,
  splitLocalGlob,
  decideFsTarget,
  isLocalFlag,
  procHandleScope,
  localPathReminder,
  annotateLocalPathMiss
} = require('../../src/gateway/host-local');
const { dieyunUserHome } = require('../../src/agent-home');

const isWin = process.platform === 'win32';
const absPath = isWin ? 'C:\\Users\\me\\auth.json' : '/home/me/auth.json';
const absDir = isWin ? 'C:\\Users\\me\\logs' : '/home/me/logs';

describe('isLocalPathRef', () => {
  it('只认 local: 前缀（大小写不敏感），不按路径形状猜', () => {
    expect(isLocalPathRef('local:/x')).toBe(true);
    expect(isLocalPathRef('LOCAL:C:\\x')).toBe(true);
    expect(isLocalPathRef('C:\\Users\\me\\a.json')).toBe(false);
    expect(isLocalPathRef('/home/me/a.json')).toBe(false);
    expect(isLocalPathRef('src/main.js')).toBe(false);
    expect(isLocalPathRef(null)).toBe(false);
  });
});

describe('splitHostLocalRef', () => {
  it('没有前缀时原样交回（local:false）', () => {
    expect(splitHostLocalRef('src/main.js')).toEqual({ local: false, path: 'src/main.js' });
    expect(splitHostLocalRef(undefined)).toEqual({ local: false, path: '' });
  });

  it('前缀后是绝对路径 → 本机路径', () => {
    expect(splitHostLocalRef(`local:${absPath}`)).toEqual({ local: true, path: absPath });
  });

  it('~ 展开到本机用户主目录', () => {
    expect(splitHostLocalRef('local:~').path).toBe(diyunHomeSafe());
    expect(splitHostLocalRef('local:~/a.json').path).toBe(path.join(diyunHomeSafe(), 'a.json'));
  });

  it('空 / 相对路径被拒，并给出可照抄的写法', () => {
    expect(() => splitHostLocalRef('local:')).toThrow(/local: 后面要跟本机绝对路径/);
    expect(() => splitHostLocalRef('local:')).toThrow(/local:/);
    let err;
    try {
      splitHostLocalRef('local:config/auth.json');
    } catch (e) {
      err = e;
    }
    expect(err.code).toBe('LOCAL_PATH_NOT_ABSOLUTE');
    expect(err.retryable).toBe(false);
    expect(err.suggestedFix).toContain('local:');
  });

  it.runIf(isWin)('Windows 本机上写 POSIX 风格路径要明确拒绝（否则 resolve 出动车盘符的假路径）', () => {
    let err;
    try {
      splitHostLocalRef('local:/Users/me/a.json');
    } catch (e) {
      err = e;
    }
    expect(err.code).toBe('LOCAL_PATH_WRONG_DIALECT');
    expect(err.suggestedFix).toContain('C:');
  });
});

describe('splitLocalGlob', () => {
  it('不是本机 glob → null（交给会话工作空间）', () => {
    expect(splitLocalGlob('**/*.ts')).toBeNull();
    expect(splitLocalGlob('src/**/*.js')).toBeNull();
  });

  it('拆成「字面目录 + 相对 pattern」', () => {
    const sep = isWin ? '\\' : '/';
    const out = splitLocalGlob(`local:${absDir}${sep}**${sep}*.log`);
    expect(out.root).toBe(absDir);
    expect(out.pattern).toBe(`**${sep}*.log`);
  });

  it('通配符紧贴文件名时，root 退到上一级目录', () => {
    const out = splitLocalGlob(`local:${absDir}${isWin ? '\\' : '/'}report*.txt`);
    expect(out.root).toBe(absDir);
    expect(out.pattern).toBe('report*.txt');
  });

  it('盘符根的 pattern 保留根分隔符（`C:` 是「C 盘当前目录」，不是根）', () => {
    if (!isWin) return;
    const out = splitLocalGlob('local:C:\\*.json');
    expect(out.root).toBe('C:\\');
    expect(out.pattern).toBe('*.json');
  });

  it('只剩盘符根 / POSIX 根时拒绝，别猜「把整块盘列一遍」', () => {
    const bare = isWin ? 'local:C:\\' : 'local:/';
    let err;
    try {
      splitLocalGlob(bare);
    } catch (e) {
      err = e;
    }
    expect(err.code).toBe('LOCAL_GLOB_NEEDS_DIR');
  });
});

describe('decideFsTarget（去哪台机器）', () => {
  const remote = { transport: 'sftp' };

  it('SSH 会话 + 不带前缀 → 远端，路径原样（相对路径由远端按远端根解析）', () => {
    const t = decideFsTarget('src/main.js', { remote, defaultCwd: absDir, sessionCwd: '/srv/app' });
    expect(t.remote).toBe(remote);
    expect(t.path).toBe('src/main.js');
    expect(t.base).toBeNull();
    expect(t.explicitLocal).toBe(false);
  });

  it('SSH 会话 + local: 前缀 → 本机，基准是本机默认工作区（绝不是远端 cwd）', () => {
    const t = decideFsTarget(`local:${absPath}`, { remote, defaultCwd: absDir, sessionCwd: '/srv/app' });
    expect(t.remote).toBeNull();
    expect(t.path).toBe(absPath);
    expect(t.explicitLocal).toBe(true);
    expect(t.base).toBe(absDir);
  });

  it('本地会话 → 本机，基准是会话工作区根', () => {
    const t = decideFsTarget('src/main.js', { remote: null, defaultCwd: '/dw', sessionCwd: '/proj' });
    expect(t.remote).toBeNull();
    expect(t.base).toBe('/proj');
    expect(t.explicitLocal).toBe(false);
  });
});

describe('isLocalFlag（host_exec 的 local 参数）', () => {
  it('true / "local" / "true" 算开；缺省与 false 不算', () => {
    expect(isLocalFlag(true)).toBe(true);
    expect(isLocalFlag('local')).toBe(true);
    expect(isLocalFlag('TRUE')).toBe(true);
    expect(isLocalFlag(false)).toBe(false);
    expect(isLocalFlag(undefined)).toBe(false);
    expect(isLocalFlag('')).toBe(false);
    expect(isLocalFlag('no')).toBe(false);
  });
});

describe('procHandleScope（句柄前缀自己说在哪台机器）', () => {
  it('hostproc- → 本机；sshproc- → 远端；其它 → null', () => {
    expect(procHandleScope('hostproc-3')).toBe('local');
    expect(procHandleScope('sshproc-11')).toBe('remote');
    expect(procHandleScope('3')).toBeNull();
    expect(procHandleScope('')).toBeNull();
  });
});

describe('localPathReminder / annotateLocalPathMiss', () => {
  it('看起来是本机 Windows 路径却没写前缀 → 给一句可执行补救', () => {
    const hint = localPathReminder('C:\\Users\\me\\auth.json');
    expect(hint).toContain('local:');
    expect(hint).toContain('C:\\Users\\me\\auth.json');
  });

  it('已经写了前缀、或不是 Windows 形状 → 不打扰', () => {
    expect(localPathReminder('local:C:\\Users\\me\\auth.json')).toBe('');
    expect(localPathReminder('/home/me/auth.json')).toBe('');
    expect(localPathReminder('')).toBe('');
  });

  it('补在失败上，不动错误码（不替模型改道到另一台机器）', () => {
    const err = Object.assign(new Error('ENOENT'), { code: 'FS_READ_FAILED', retryable: true });
    const out = annotateLocalPathMiss(err, 'C:\\nope\\a.json');
    expect(out).toBe(err);
    expect(out.code).toBe('FS_READ_FAILED');
    expect(out.retryable).toBe(true);
    expect(out.suggestedFix).toContain('local:');
  });

  it('不需要提示时原样返回同一个错误对象', () => {
    const err = new Error('boom');
    expect(annotateLocalPathMiss(err, 'src/x.js')).toBe(err);
    expect(err.suggestedFix).toBeUndefined();
  });
});

function diyunHomeSafe() {
  return dieyunUserHome();
}
