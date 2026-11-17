'use strict';

/**
 * 「本机 vs 会话工作空间」在 handler 层的落地：SSH 会话里也能读写本机文件、在本机跑命令、
 * 打印远端图片。锁的是**路由**（哪台机器）+ **判定照旧**（本机白名单 / 沙箱档位），
 * 不是文案。
 *
 * 这一组用例的存在理由：2026-11 的真实事故里，整条工具链在 SSH 会话下没有任何
 * 「碰本机」的入口（读一份本机 auth.json 只能绕共享盘），而 print_image 在 SSH 下直接
 * 报「暂不支持」。两处都是把「工作空间在哪台机器」与「操作哪台机器」混成一个判断。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const { createFsHandlers } = require('../../src/gateway/handlers/fs');
const { createHostHandlers } = require('../../src/gateway/handlers/host');
const { decideFsTarget } = require('../../src/gateway/host-local');
const { normalizeFilePathInput } = require('../../src/gateway/host-control');
const { assertAllowedPath } = require('../../src/gateway/path-policy');

const isWin = process.platform === 'win32';

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `dieyun-hostlocal-${prefix}-`));
}

/** 假远端 fs：记下每次调用，按需返回值。 */
function makeRemote(overrides = {}) {
  const calls = { readFile: [], writeFile: [], listDir: [], mkdir: [], stat: [] };
  const remote = {
    transport: 'rpc',
    root: '/srv/app',
    calls,
    resolve: (p) => (String(p).startsWith('/') ? String(p) : `${remote.root}/${p}`),
    readFile: async (p, enc, opts) => {
      calls.readFile.push({ p, enc, opts });
      return { data: 'REMOTE_CONTENT', encoding: enc || 'utf8', path: p };
    },
    writeFile: async (p, data, enc) => {
      calls.writeFile.push({ p, data, enc });
      return { ok: true, path: p };
    },
    listDir: async (p) => {
      calls.listDir.push({ p });
      return [{ name: 'remote.txt', isDirectory: false, size: 1, mtimeMs: 0 }];
    },
    mkdir: async (p) => {
      calls.mkdir.push({ p });
      return { ok: true, path: p };
    },
    stat: async (p) => {
      calls.stat.push({ p });
      return { isFile: true, isDirectory: false, size: 1, mtimeMs: 0 };
    },
    ...overrides
  };
  return remote;
}

/**
 * 起一套 fs handler：远端存在与否由 `remote` 决定，本机白名单只放行给出来的根。
 * resolveFsTarget 用的是**生产那份纯函数**（decideFsTarget），不另写一份假实现。
 */
function makeFs({ remote = null, allowedRoots = [], sandboxMode = 'danger-full-access' } = {}) {
  const localCalls = { rustRead: [], textRead: [], sandboxWrites: [], undo: [], grep: [], glob: [] };
  const handlers = createFsHandlers({
    perms: { hostControl: true, fsRead: true, fsWrite: true, shellExec: true },
    getRemoteFs: () => remote,
    resolveFsTarget: (p) =>
      decideFsTarget(p, {
        remote,
        defaultCwd: allowedRoots[0] || null,
        sessionCwd: remote ? '/srv/app' : allowedRoots[0] || null
      }),
    resolveHostSidecarLocalPath: () => null,
    sidecarReadOpts: () => ({}),
    readSidecarFileAt: async () => ({ data: 'SIDECAR' }),
    listSidecarDirAt: async () => [],
    normalizeFilePathInput,
    cwdForCall: () => (remote ? '/srv/app' : allowedRoots[0]),
    assertAllowedPath,
    readRootsForCall: () => allowedRoots,
    writeRootsForCall: () => allowedRoots,
    assertSandboxWritable: async (absPath, tool, opts) => {
      localCalls.sandboxWrites.push({ absPath, tool, remote: !!(opts && opts.remote) });
    },
    invokeRustCore: async (method, params) => {
      localCalls.rustRead.push({ method, params });
      return null; // 让 read/list 走 Node 兜底，用例断言真实文件内容
    },
    invokeIndexCore: async () => null,
    resolveCodebaseContext: () => null,
    readAllowedTextFile: async (p, enc) => {
      localCalls.textRead.push({ p, enc });
      return { data: 'LOCAL_TEXT', path: p };
    },
    assertHostEnabled: () => {},
    ctx: { userDataPath: '' },
    captureUndoWrite: (info) => localCalls.undo.push(info),
    lspDiagnostics: null,
    isSshConnectedForCall: () => !!remote,
    requireSshForCall: () => {
      throw new Error('用例不该走 ssh');
    },
    graphIncremental: null,
    codebaseIncremental: null,
    summarizeLineDiff: () => null,
    runEditFile: async () => ({ ok: true }),
    getRemoteAgentInfo: () => ({ usable: true, socketPath: '/tmp/x.sock' }),
    getRemoteAgentClient: () => ({
      call: async (method, params) => {
        localCalls.remoteAgent = { method, params };
        return { ok: true, matches: [], source: 'remote-agent' };
      }
    }),
    grepViaRemoteExec: async (cwd, opts) => {
      localCalls.grepViaRemoteExec = { cwd, opts };
      return { ok: true, matches: [], source: 'remote_grep' };
    },
    grepWorkspace: async (root, opts) => {
      localCalls.grep.push({ root, opts });
      return { ok: true, matches: [], source: 'rg' };
    },
    globViaRemoteExec: async () => null,
    globWorkspace: async (root, opts) => {
      localCalls.glob.push({ root, opts });
      return { ok: true, files: [], source: 'rg' };
    },
    sandboxMode
  });
  return { handlers, localCalls };
}

describe('fs_*：本机路径（local:）在 SSH 会话里可用', () => {
  let dir;
  beforeEach(() => {
    dir = tmpDir('fs');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'LOCAL_FILE_CONTENT', 'utf8');
    fs.mkdirSync(path.join(dir, 'sub'));
    fs.writeFileSync(path.join(dir, 'sub', 'b.txt'), 'B', 'utf8');
  });

  it('read_file 带 local: 前缀 → 读本机，不碰远端', async () => {
    const remote = makeRemote();
    const { handlers, localCalls } = makeFs({ remote, allowedRoots: [dir] });
    const out = await handlers['fs.read_file']({ filePath: `local:${path.join(dir, 'a.txt')}` });
    expect(remote.calls.readFile).toHaveLength(0);
    // 走 Node 兜底读到了真实内容（invokeRustCore 在用例里返回 null）
    expect(localCalls.textRead).toHaveLength(1);
    expect(localCalls.textRead[0].p).toBe(path.join(dir, 'a.txt'));
    expect(out).toBeTruthy();
  });

  it('read_file 不带前缀 → 仍然走远端（老行为不变）', async () => {
    const remote = makeRemote();
    const { handlers } = makeFs({ remote, allowedRoots: [dir] });
    await handlers['fs.read_file']({ filePath: 'config/a.json' });
    expect(remote.calls.readFile).toHaveLength(1);
    expect(remote.calls.readFile[0].p).toBe('config/a.json');
  });

  it('read_file 远端失败且路径像本机 Windows 路径 → 补一句 local: 的补救', async () => {
    const remote = makeRemote({
      readFile: async () => {
        throw Object.assign(new Error('ENOENT'), { code: 'FS_READ_FAILED' });
      }
    });
    const { handlers } = makeFs({ remote, allowedRoots: [dir] });
    await expect(
      handlers['fs.read_file']({ filePath: 'C:\\Users\\me\\AppData\\Roaming\\dieyunagent\\auth.json' })
    ).rejects.toMatchObject({ suggestedFix: expect.stringContaining('local:') });
  });

  it('list_dir 带 local: 前缀 → 列本机目录', async () => {
    const remote = makeRemote();
    const { handlers } = makeFs({ remote, allowedRoots: [dir] });
    const out = await handlers['fs.list_dir']({ dirPath: `local:${dir}` });
    expect(remote.calls.listDir).toHaveLength(0);
    expect(out.map((r) => r.name).sort()).toEqual(['a.txt', 'sub']);
  });

  it('write_file 带 local: 前缀 → 走本机沙箱判定 + 本机白名单，远端一次都不写', async () => {
    const remote = makeRemote();
    const { handlers, localCalls } = makeFs({ remote, allowedRoots: [dir] });
    const target = path.join(dir, 'new.txt');
    const out = await handlers['fs.write_file']({ filePath: `local:${target}`, data: 'hello' });
    expect(remote.calls.writeFile).toHaveLength(0);
    expect(localCalls.sandboxWrites).toHaveLength(1);
    expect(localCalls.sandboxWrites[0].absPath).toBe(target);
    expect(fs.readFileSync(target, 'utf8')).toBe('hello');
    expect(out.path).toBe(target);
    // 撤销记录按本机文件记（remote:false）
    expect(localCalls.undo.at(-1)).toMatchObject({ filePath: target, remote: false });
  });

  it('write_file 不带前缀 → 走远端，并且同样过档位判定（remote:true）', async () => {
    const remote = makeRemote();
    const { handlers, localCalls } = makeFs({ remote, allowedRoots: [dir] });
    await handlers['fs.write_file']({ filePath: 'src/x.js', data: 'x' });
    expect(remote.calls.writeFile).toHaveLength(1);
    expect(remote.calls.writeFile[0].p).toBe('src/x.js');
    // 远端路径按远端绝对路径交给档位（这里是 /srv/app/src/x.js），不再"静默直通"
    expect(localCalls.sandboxWrites).toHaveLength(1);
    expect(localCalls.sandboxWrites[0]).toMatchObject({
      absPath: '/srv/app/src/x.js',
      tool: 'fs.write_file',
      remote: true
    });
  });

  it('mkdir / stat 同样认 local: 前缀', async () => {
    const remote = makeRemote();
    const { handlers } = makeFs({ remote, allowedRoots: [dir] });
    const mk = path.join(dir, 'made');
    await handlers['fs.mkdir']({ dirPath: `local:${mk}` });
    expect(remote.calls.mkdir).toHaveLength(0);
    expect(fs.statSync(mk).isDirectory()).toBe(true);

    const st = await handlers['fs.stat']({ filePath: `local:${path.join(dir, 'a.txt')}` });
    expect(remote.calls.stat).toHaveLength(0);
    expect(st.isFile).toBe(true);
  });

  it('grep 带 local: path → 用本机 grep 搜那个目录，不叫远端 Agent', async () => {
    const remote = makeRemote();
    const { handlers, localCalls } = makeFs({ remote, allowedRoots: [dir] });
    await handlers['fs.grep']({ pattern: 'x', path: `local:${dir}` });
    expect(localCalls.remoteAgent).toBeUndefined();
    expect(localCalls.grep).toHaveLength(1);
    expect(localCalls.grep[0].root).toBe(dir);
    expect(localCalls.grep[0].opts.path).toBeUndefined();
  });

  it('grep 不带 path → 仍然走远端（老行为不变）', async () => {
    const remote = makeRemote({ transport: 'sftp' });
    const { handlers, localCalls } = makeFs({ remote, allowedRoots: [dir] });
    await handlers['fs.grep']({ pattern: 'x' });
    // 远端没有 Agent → 走 ssh exec 的 grep，cwd 是远端工作区根，不是本机
    expect(localCalls.grepViaRemoteExec.cwd).toBe('/srv/app');
    expect(localCalls.grep).toHaveLength(0);
  });

  it('glob 带 local: 绝对 pattern → 拆成本机 root + 相对 pattern', async () => {
    const remote = makeRemote();
    const { handlers, localCalls } = makeFs({ remote, allowedRoots: [dir] });
    const sep = isWin ? '\\' : '/';
    await handlers['fs.glob']({ pattern: `local:${dir}${sep}**${sep}*.txt` });
    expect(localCalls.glob).toHaveLength(1);
    expect(localCalls.glob[0].root).toBe(dir);
    expect(localCalls.glob[0].opts.pattern).toBe(`**${sep}*.txt`);
  });

  it('read_symbol 收到 local: 前缀 → 明确拒绝并给出替代路径（本机不在会话索引里）', async () => {
    const remote = makeRemote();
    const { handlers } = makeFs({ remote, allowedRoots: [dir] });
    await expect(
      handlers['fs.read_symbol']({ filePath: `local:${path.join(dir, 'a.txt')}`, name: 'x' })
    ).rejects.toMatchObject({ code: 'LOCAL_PATH_UNSUPPORTED', retryable: false });
  });

  it('本机路径越界（不在白名单）→ 仍报 PATH_NOT_ALLOWED，不为 local: 开路', async () => {
    const remote = makeRemote();
    const other = tmpDir('outside');
    const { handlers } = makeFs({ remote, allowedRoots: [dir] });
    await expect(
      handlers['fs.read_file']({ filePath: `local:${path.join(other, 'secret.txt')}` })
    ).rejects.toMatchObject({ code: 'PATH_NOT_ALLOWED' });
  });
});

describe('host.exec / host_proc：本机那条分支在 SSH 会话里可用', () => {
  function makeHost({ remote = null, allowedRoots = [], mode = 'danger-full-access' } = {}) {
    const calls = {
      shell: [],
      remoteExec: [],
      print: [],
      procLocal: [],
      procRemote: [],
      contexts: [],
      decisions: []
    };
    const handlers = createHostHandlers({
      assertHostEnabled: () => {},
      ctx: { userDataPath: '' },
      perms: { shellExec: true },
      validateShellCommand: () => ({ ok: true }),
      resolveCallWorkspaceTarget: () => (remote ? { kind: 'ssh', remotePath: '/srv/app' } : null),
      normalizeRemotePath: (p) => p,
      getRemoteFs: () => remote,
      resolveFsTarget: (p) =>
        decideFsTarget(p, {
          remote,
          defaultCwd: allowedRoots[0] || null,
          sessionCwd: remote ? '/srv/app' : allowedRoots[0] || null
        }),
      requireSshForCall: () => ({
        exec: async (command, cwd) => {
          calls.remoteExec.push({ command, cwd });
          return { code: 0, stdout: 'REMOTE', stderr: '' };
        }
      }),
      cwdForCall: () => (remote ? '/srv/app' : allowedRoots[0]),
      readRootsForCall: () => allowedRoots,
      runShellDetached: async (command, opts) => {
        calls.shell.push({ command, opts, detached: true });
        return { code: 0, handle: 'hostproc-9' };
      },
      runShell: async (command, opts) => {
        calls.shell.push({ command, opts });
        return { code: 0, stdout: 'LOCAL', stderr: '' };
      },
      listProcessHandles: (opts) => {
        calls.procLocal.push({ op: 'list', opts });
        return { ok: true, processes: [] };
      },
      takeSettledReports: () => ({ ok: true, count: 0, jobs: [] }),
      killProcessHandle: async (opts) => {
        calls.procLocal.push({ op: 'kill', opts });
        return { ok: true };
      },
      readProcessOutput: async (opts) => {
        calls.procLocal.push({ op: 'output', opts });
        return { ok: true, stdout: 'LOCAL_OUT' };
      },
      getActiveCallSessionId: () => 's1',
      isSshConnectedForCall: () => !!remote,
      defaultCwd: allowedRoots[0],
      openExternalUrl: async () => ({ ok: true }),
      normalizeFilePathInput,
      printImage: async (abs) => {
        calls.print.push(abs);
        return { ok: true, path: abs, method: 'mspaint' };
      },
      assertAllowedPath,
      // 远端沙箱作用域：远端命令的档位判定用它（生产实现见 rpc.js:remoteSandboxScope）
      remoteSandboxScope: () =>
        remote ? { workspaceRoot: '/srv/app', allowedRoots: ['/srv/app', '/home/me', '/tmp'] } : null,
      sandbox: {
        // 与生产 sandboxContext 同形：远端调用换根（工作区 + /tmp），本机调用给本机根
        context: (extra) => {
          calls.contexts.push(extra || {});
          if (extra && extra.remote) {
            return {
              mode,
              remote: true,
              workspaceRoots: [extra.remote.workspaceRoot, '/tmp'],
              internalRoots: [],
              cwd: extra.cwd
            };
          }
          return { mode, ...(extra || {}) };
        },
        guard: async (decision) => {
          calls.decisions.push(decision);
          return null;
        }
      },
      startRemoteDetached: async () => ({ code: 0, pid: 11, id: 'sshproc-1', logPath: '/tmp/l' }),
      listRemoteProcesses: (opts) => {
        calls.procRemote.push({ op: 'list', opts });
        return { ok: true, processes: [] };
      },
      takeSettledRemoteReports: async () => ({ ok: true, count: 0, jobs: [], remote: true }),
      readRemoteOutput: async (opts) => {
        calls.procRemote.push({ op: 'output', opts });
        return { ok: true, stdout: 'REMOTE_OUT' };
      },
      killRemoteProcess: async (opts) => {
        calls.procRemote.push({ op: 'kill', opts });
        return { ok: true };
      }
    });
    return { handlers, calls };
  }

  let dir;
  beforeEach(() => {
    dir = tmpDir('host');
  });

  it('host_exec local:true → 在本机跑（cwd 用本机默认工作区），一次都不走 ssh', async () => {
    const remote = makeRemote();
    const { handlers, calls } = makeHost({ remote, allowedRoots: [dir] });
    const out = await handlers['host.exec']({ command: 'echo hi', local: true });
    expect(calls.remoteExec).toHaveLength(0);
    expect(calls.shell).toHaveLength(1);
    expect(calls.shell[0].opts.cwd).toBe(dir);
    expect(out.stdout).toBe('LOCAL');
    // 档位判定仍走本机那份（不是 remote:true 分支）
    expect(calls.contexts.at(-1).remote).toBeUndefined();
  });

  it('host_exec cwd 带 local: 前缀 → 也算本机执行，cwd 用那个目录', async () => {
    const remote = makeRemote();
    const { handlers, calls } = makeHost({ remote, allowedRoots: [dir] });
    await handlers['host.exec']({ command: 'echo hi', cwd: `local:${dir}` });
    expect(calls.remoteExec).toHaveLength(0);
    expect(calls.shell[0].opts.cwd).toBe(dir);
  });

  it('host_exec 缺省 → 仍然在远端跑，档位按远端工作区判', async () => {
    const remote = makeRemote();
    const { handlers, calls } = makeHost({ remote, allowedRoots: [dir] });
    await handlers['host.exec']({ command: 'echo hi' });
    expect(calls.shell).toHaveLength(0);
    expect(calls.remoteExec[0]).toMatchObject({ command: 'echo hi', cwd: '/srv/app' });
    // 远端命令按远端工作区判档位（root 是 /srv/app + /tmp，不是本机根）
    expect(calls.contexts.at(-1).remote).toEqual({
      workspaceRoot: '/srv/app',
      allowedRoots: ['/srv/app', '/home/me', '/tmp']
    });
    expect(calls.contexts.at(-1).cwd).toBe('/srv/app');
    // 纯只读命令在远端也直接放行（不再"一律问一次"）
    expect(calls.decisions.at(-1)).toMatchObject({ action: 'allow', category: 'read' });
  });

  it('远端命令写工作区外 → 问一次，且批准记忆的位置是远端目录', async () => {
    const remote = makeRemote();
    const { handlers, calls } = makeHost({ remote, allowedRoots: [dir], mode: 'workspace-write' });
    await handlers['host.exec']({ command: 'echo x > /home/me/notes.txt' });
    expect(calls.decisions.at(-1)).toMatchObject({
      action: 'ask',
      category: 'write',
      path: '/home/me/notes.txt'
    });
  });

  it('远端命令写工作区内 → 直接放行（workspace-write 的应有语义）', async () => {
    const remote = makeRemote();
    const { handlers, calls } = makeHost({ remote, allowedRoots: [dir], mode: 'workspace-write' });
    await handlers['host.exec']({ command: 'echo x > /srv/app/out.txt' });
    expect(calls.decisions.at(-1)).toMatchObject({ action: 'allow', category: 'write' });
  });

  it('只读档下远端命令落盘 → 问一次（不再名存实亡）', async () => {
    const remote = makeRemote();
    const { handlers, calls } = makeHost({ remote, allowedRoots: [dir], mode: 'read-only' });
    await handlers['host.exec']({ command: 'echo x > /srv/app/out.txt' });
    expect(calls.decisions.at(-1)).toMatchObject({ action: 'ask', category: 'write' });
  });

  it.runIf(process.platform === 'win32')(
    'local:true 却给 POSIX cwd（照抄了远端路径）→ 明确报「方言不对」，而不是 PATH_NOT_ALLOWED',
    async () => {
      const { handlers } = makeHost({ remote: makeRemote(), allowedRoots: [dir] });
      await expect(
        handlers['host.exec']({ command: 'echo hi', local: true, cwd: '/srv/app' })
      ).rejects.toMatchObject({ code: 'LOCAL_PATH_WRONG_DIALECT', retryable: false });
    }
  );

  it('host_print_image 远端图片 → 取回本机临时副本再打印', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    const remote = makeRemote();
    remote.readFile = async (p, enc) => {
      remote.calls.readFile.push({ p, enc });
      return { data: png.toString('base64'), encoding: enc, path: p };
    };
    const { handlers, calls } = makeHost({ remote, allowedRoots: [dir] });
    const out = await handlers['host.print_image']({ filePath: 'reports/chart.png' });
    expect(remote.calls.readFile).toHaveLength(1);
    expect(remote.calls.readFile[0].p).toBe('reports/chart.png');
    expect(calls.print).toHaveLength(1);
    expect(path.extname(calls.print[0])).toBe('.png');
    expect(fs.existsSync(calls.print[0])).toBe(true);
    expect(out).toMatchObject({ ok: true, source: 'remote', remotePath: 'reports/chart.png' });
  });

  it('host_print_image 本机文件带 local: → 直接打印本机路径', async () => {
    const remote = makeRemote();
    const img = path.join(dir, 'local.png');
    fs.writeFileSync(img, Buffer.from([1, 2, 3]));
    const { handlers, calls } = makeHost({ remote, allowedRoots: [dir] });
    await handlers['host.print_image']({ filePath: `local:${img}` });
    expect(calls.print).toEqual([img]);
  });

  it('host_proc 按句柄前缀路由：hostproc- 走本机表（SSH 会话里不会被当成远端句柄）', async () => {
    const remote = makeRemote();
    const { handlers, calls } = makeHost({ remote, allowedRoots: [dir] });
    await handlers['host.proc_output']({ id: 'hostproc-3' });
    expect(calls.procLocal.map((c) => c.op)).toEqual(['output']);
    expect(calls.procRemote).toHaveLength(0);
  });

  it('host_proc list 缺省跟随会话，local:true 看本机那张表', async () => {
    const remote = makeRemote();
    const { handlers, calls } = makeHost({ remote, allowedRoots: [dir] });
    await handlers['host.proc_list']({ local: true });
    expect(calls.procLocal.map((c) => c.op)).toEqual(['list']);
  });
});
