'use strict';

/**
 * 远端（SSH）也要受沙箱档位管：同一套三档语义，换 POSIX 方言与远端根。
 *
 * 曾经的边界（`docs/SANDBOX.md` 原话）：「远程 fs 写不由本机沙箱判定，由 SSH 凭据与
 * remoteAllowedRoots 约束」—— 结果是 SSH 会话里「只读」档名存实亡、workspace-write 也不管
 * 远端落盘。现在远端判定走同一条链：`sandbox-policy` 判档位、`server.sandboxContext({remote})`
 * 供远端根、`remoteAllowedRoots` 兜传输边界。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  decideFsWrite,
  decideShellCommand,
  commandMayWrite,
  matchSystemInstall
} = require('../../src/gateway/sandbox-policy');

const REMOTE_ROOT = '/srv/app';
const REMOTE_CTX = {
  remote: true,
  workspaceRoots: [REMOTE_ROOT, '/tmp'],
  internalRoots: [],
  cwd: REMOTE_ROOT,
  homeDir: '/home/me'
};

describe('decideFsWrite：远端路径按档位判（POSIX 方言）', () => {
  it('workspace-write：远端工作区内放行，$HOME 其它位置问一次', () => {
    expect(
      decideFsWrite(`${REMOTE_ROOT}/src/a.js`, { ...REMOTE_CTX, mode: 'workspace-write' })
    ).toMatchObject({ action: 'allow', category: 'write' });
    expect(
      decideFsWrite('/tmp/build.log', { ...REMOTE_CTX, mode: 'workspace-write' })
    ).toMatchObject({ action: 'allow' });
    expect(
      decideFsWrite('/home/me/.bashrc', { ...REMOTE_CTX, mode: 'workspace-write' })
    ).toMatchObject({ action: 'ask', detail: '/home/me/.bashrc' });
    // 同名前缀的兄弟目录不算「在工作区内」
    expect(
      decideFsWrite('/srv/app2/x', { ...REMOTE_CTX, mode: 'workspace-write' })
    ).toMatchObject({ action: 'ask' });
  });

  it('read-only：远端写一律问一次（这正是以前名存实亡的那一档）', () => {
    expect(
      decideFsWrite(`${REMOTE_ROOT}/src/a.js`, { ...REMOTE_CTX, mode: 'read-only' })
    ).toMatchObject({ action: 'ask' });
  });

  it('danger-full-access：远端写放行（真边界是传输允许根，不是档位）', () => {
    expect(
      decideFsWrite('/home/me/.bashrc', { ...REMOTE_CTX, mode: 'danger-full-access' })
    ).toMatchObject({ action: 'allow' });
  });

  it('远端大小写敏感：/srv/App 不是 /srv/app', () => {
    expect(
      decideFsWrite('/srv/App/x', { ...REMOTE_CTX, mode: 'workspace-write' })
    ).toMatchObject({ action: 'ask' });
  });

  it('本机 Windows 仍按大小写不敏感比较（同一目录大小写随便写）', () => {
    if (process.platform !== 'win32') return;
    const ctx = { mode: 'workspace-write', workspaceRoots: ['C:\\Work\\Proj'], internalRoots: [] };
    expect(decideFsWrite('c:\\work\\proj\\a.js', ctx)).toMatchObject({ action: 'allow' });
  });
});

describe('decideShellCommand：远端命令不再「一律问一次」', () => {
  const remoteOpts = (mode) => ({ ...REMOTE_CTX, mode, remote: true });

  it('只读命令在远端也直接放行', () => {
    expect(decideShellCommand('ls -la /srv/app', remoteOpts('workspace-write'))).toMatchObject({
      action: 'allow',
      category: 'read'
    });
    expect(decideShellCommand('cat /etc/hosts', remoteOpts('workspace-write'))).toMatchObject({
      action: 'allow',
      category: 'read'
    });
  });

  it('写远端工作区内 → 放行；写 $HOME → 问一次并记下远端目录', () => {
    expect(decideShellCommand('echo x > /srv/app/out.txt', remoteOpts('workspace-write'))).toMatchObject({
      action: 'allow',
      category: 'write'
    });
    expect(
      decideShellCommand('echo x > /home/me/notes.txt', remoteOpts('workspace-write'))
    ).toMatchObject({ action: 'ask', category: 'write', path: '/home/me/notes.txt' });
  });

  it('相对路径按远端 cwd（POSIX）解析，不按本机 path.resolve', () => {
    // 若按 Windows 的 path.resolve 解析，`out.txt` 会变成 E:\srv\app\out.txt 而被判越界
    expect(decideShellCommand('echo x > out.txt', remoteOpts('workspace-write'))).toMatchObject({
      action: 'allow',
      category: 'write'
    });
  });

  it('read-only：远端落盘命令问一次；完全放开档放行', () => {
    expect(decideShellCommand('echo x > /srv/app/out.txt', remoteOpts('read-only'))).toMatchObject({
      action: 'ask'
    });
    expect(
      decideShellCommand('echo x > /home/me/out.txt', remoteOpts('danger-full-access'))
    ).toMatchObject({ action: 'allow' });
  });

  it('高危命令词表与档位无关：远端也恒拒', () => {
    expect(decideShellCommand('format c:', remoteOpts('danger-full-access'))).toMatchObject({
      action: 'deny'
    });
  });

  it('写目标藏在 `key=value` / 引号里也要认出来（否则区外写会被判成区外→区内）', () => {
    // 这两个是真实写法：按空白切 token 时目标是 `of=/home/me/blob` / 一整段引号文本
    expect(
      decideShellCommand('dd if=/dev/zero of=/home/me/blob bs=1M count=1', remoteOpts('workspace-write'))
    ).toMatchObject({ action: 'ask', category: 'write' });
    expect(
      decideShellCommand(
        `node -e "require('fs').writeFileSync('/home/me/x','1')"`,
        remoteOpts('workspace-write')
      )
    ).toMatchObject({ action: 'ask', category: 'write' });
    // 写在工作区内的写法照旧放行，别把正常命令也变成问一次
    expect(
      decideShellCommand('dd if=/dev/zero of=./blob bs=1M count=1', remoteOpts('workspace-write'))
    ).toMatchObject({ action: 'allow' });
  });
});

describe('远端命令的写目标盲区（安装类 / 建归档 / ~ 展开）', () => {
  const remoteOpts = (mode) => ({ ...REMOTE_CTX, mode, remote: true });

  it('安装类命令：文本里没有路径，但一定装到工作区外 → 问一次', () => {
    const asks = [
      'npm i -g left-pad',
      'npm install --global pnpm',
      'pip install --user requests',
      'cargo install ripgrep',
      'go install golang.org/x/tools@latest',
      'gem install bundler',
      'make install',
      'apt-get install -y curl',
      'brew install jq'
    ];
    for (const cmd of asks) {
      expect({ cmd, action: decideShellCommand(cmd, remoteOpts('workspace-write')).action }).toEqual({
        cmd,
        action: 'ask'
      });
    }
  });

  it('普通的「装到当前项目里」不算：pip install（venv）/ npm install 不弹窗', () => {
    expect(decideShellCommand('pip install requests', remoteOpts('workspace-write'))).toMatchObject({
      action: 'allow'
    });
    expect(decideShellCommand('npm install', remoteOpts('workspace-write'))).toMatchObject({
      action: 'allow'
    });
  });

  it('完全放开档不拦安装类（用户已明确选择全放开）', () => {
    expect(
      decideShellCommand('npm i -g left-pad', remoteOpts('danger-full-access'))
    ).toMatchObject({ action: 'allow' });
  });

  it('建归档也算写：tar czf 到工作区外 → 问一次；到工作区内 → 放行', () => {
    expect(decideShellCommand('tar czf ~/x.tgz .', remoteOpts('workspace-write'))).toMatchObject({
      action: 'ask'
    });
    expect(
      decideShellCommand('tar czf /home/me/x.tgz .', remoteOpts('workspace-write'))
    ).toMatchObject({ action: 'ask' });
    expect(
      decideShellCommand('tar czf ./dist.tgz ./dist', remoteOpts('workspace-write'))
    ).toMatchObject({ action: 'allow' });
  });

  it('`~` 按主目录展开，不再当成「工作区里的相对路径」', () => {
    // 展开前会被判成 /srv/app/~/x（工作区内）；展开后是 /home/me/x（工作区外）
    expect(decideShellCommand('cp ~/a.txt ./b.txt', remoteOpts('workspace-write'))).toMatchObject({
      action: 'ask'
    });
    // 拿不到主目录时不猜，按「不在允许根内」保守处理
    expect(
      decideShellCommand('tar czf ~/x.tgz .', { ...remoteOpts('workspace-write'), homeDir: '' })
    ).toMatchObject({ action: 'ask' });
  });

  it('本机同一条规则（只读档问一次、打包/安装都算写）', () => {
    const localOpts = {
      mode: 'read-only',
      workspaceRoots: ['/proj'],
      internalRoots: [],
      cwd: '/proj',
      homeDir: '/home/me'
    };
    expect(commandMayWrite('tar czf dist.tgz dist')).toBe(true);
    expect(decideShellCommand('tar czf dist.tgz dist', localOpts)).toMatchObject({ action: 'ask' });
    expect(decideShellCommand('npm i -g left-pad', localOpts)).toMatchObject({ action: 'ask' });
    expect(matchSystemInstall('make install')).toContain('make install');
    expect(matchSystemInstall('make build')).toBe('');
  });
});

describe('审批粒度：远端授权不进本机写白名单', () => {
  const { createSandboxApprovals } = require('../../src/gateway/sandbox-approvals');

  function makeApprovals(answer = true) {
    return createSandboxApprovals({
      request: async () => answer,
      log: () => {},
      now: () => Date.now()
    });
  }

  it('远端目录批准只对本会话的远端生效，不污染本机可写根', async () => {
    const approvals = makeApprovals();
    const decision = {
      action: 'ask',
      category: 'write',
      mode: 'workspace-write',
      reason: 'test'
    };
    const res = await approvals.ask(decision, {
      sessionId: 's1',
      tool: 'fs.write_file',
      path: '/home/me/notes.txt',
      remote: true
    });
    expect(res.granted).toBe(true);
    expect(approvals.grantedPathsFor('s1')).toEqual([]);
    // 本机目录的批准仍要进白名单（否则批准了也写不进去）
    await approvals.ask(decision, {
      sessionId: 's1',
      tool: 'fs.write_file',
      path: path.join(os.tmpdir(), 'outside', 'a.txt')
    });
    expect(approvals.grantedPathsFor('s1').length).toBe(1);
  });

  it('os-control 的授权按「哪台机器」分开：批准远端点一次不等于批准本机', async () => {
    const approvals = makeApprovals();
    const base = { action: 'ask', category: 'os-control', mode: 'workspace-write', reason: 'test' };
    await approvals.ask({ ...base, scope: 'remote-host:me@srv:22' }, { sessionId: 's2', tool: 'computer' });
    // 同一会话里的本机键鼠仍要再问（返回 ask 而不是命中 grant）
    const again = await approvals.ask(
      { ...base, scope: 'local-host' },
      { sessionId: 's2', tool: 'computer' }
    );
    expect(again.remembered).toBe(false);
  });
});

describe('传输边界（remoteAllowedRoots）在档位之前先把不可能的写挡掉', () => {
  it('resolveRemotePath 越界 → PATH_NOT_ALLOWED，并把实际开放的根列出来', () => {
    const { resolveRemotePath } = require('../../src/ssh/remote-path');
    const roots = [REMOTE_ROOT, '/home/me', '/tmp'];
    expect(resolveRemotePath('/srv/app/a.js', roots)).toBe('/srv/app/a.js');
    let err;
    try {
      resolveRemotePath('/etc/passwd', roots);
    } catch (e) {
      err = e;
    }
    expect(err.code).toBe('PATH_NOT_ALLOWED');
    expect(err.suggestedFix).toContain('/srv/app');
    expect(err.suggestedFix).toContain('/tmp');
    expect(err.suggestedFix).toContain('不要原样重试');
  });

  it('POSIX 大小写敏感：/Home/Me 与 /home/me 是两个位置', () => {
    const { resolveRemotePath } = require('../../src/ssh/remote-path');
    expect(() => resolveRemotePath('/Home/Me/a', ['/home/me', '/tmp'])).toThrow(/不在远端允许范围内/);
    // 档位侧同一口径：/srv/App 不属于 /srv/app
    expect(
      decideFsWrite('/srv/App/x', { ...REMOTE_CTX, mode: 'workspace-write' })
    ).toMatchObject({ action: 'ask' });
  });
});

describe('server.sandboxContext：远端分支给远端根', () => {
  const { LocalGateway } = require('../../src/gateway/server');

  function makeGateway() {
    const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'dieyun-sb-remote-'));
    return new LocalGateway({
      userDataPath: userData,
      readableDir: userData,
      extraReadRoots: [],
      log: () => {}
    });
  }

  it('remote 上下文：工作区 + /tmp，无「本机内部目录」，cwd 是远端根', () => {
    const gw = makeGateway();
    const ctx = gw.sandboxContext({ remote: { workspaceRoot: REMOTE_ROOT }, cwd: `${REMOTE_ROOT}/src` });
    expect(ctx).toMatchObject({
      remote: true,
      workspaceRoots: [REMOTE_ROOT, '/tmp'],
      internalRoots: [],
      cwd: `${REMOTE_ROOT}/src`
    });
    expect(typeof ctx.mode).toBe('string');
  });

  it('本机上下文不受影响（仍是本机根 + 内部目录）', () => {
    const gw = makeGateway();
    const ctx = gw.sandboxContext();
    expect(ctx.remote).toBeUndefined();
    expect(Array.isArray(ctx.workspaceRoots)).toBe(true);
    expect(Array.isArray(ctx.internalRoots)).toBe(true);
  });
});
