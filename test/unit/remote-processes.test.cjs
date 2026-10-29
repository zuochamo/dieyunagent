'use strict';

/**
 * 远端（SSH）后台进程句柄表：detached 启动 → list / output / kill 三件事与本地同形。
 * 用假 ssh 适配器（exec / sftpStat / sftpReadFile）跑，不需要真主机。
 */

const {
  LOG_DIR,
  startRemoteDetached,
  listRemoteProcesses,
  readRemoteOutput,
  killRemoteProcess,
  resetRemoteHandlesForTest
} = require('../../src/gateway/remote-processes');

function fakeSsh(handlers = {}) {
  const calls = { exec: [], stat: [], read: [] };
  const ssh = {
    calls,
    async exec(script, cwd, timeoutMs) {
      calls.exec.push({ script, cwd, timeoutMs });
      if (handlers.exec) return handlers.exec(script, cwd, timeoutMs);
      return { code: 0, stdout: '', stderr: '' };
    },
    async sftpStat(p) {
      calls.stat.push(p);
      if (handlers.stat) return handlers.stat(p);
      const size = handlers.fileSize ? handlers.fileSize(p) : 0;
      return { size, mode: 0o100644 };
    },
    async sftpReadFile(p, limit, start = 0) {
      calls.read.push({ p, limit, start });
      const text = handlers.fileText ? handlers.fileText(p) : '';
      const buf = Buffer.from(text.slice(start, start + limit), 'utf8');
      return { buf, truncated: false, size: Buffer.byteLength(text) };
    }
  };
  return ssh;
}

beforeEach(() => resetRemoteHandlesForTest());

describe('startRemoteDetached', () => {
  it('setsid + 输出落盘 + 返回句柄与 pid', async () => {
    const ssh = fakeSsh({ exec: () => ({ code: 0, stdout: '4242\n', stderr: '' }) });
    const res = await startRemoteDetached({ ssh, cwd: '/srv/app', command: 'python3 app.py', sessionId: 's1' });
    expect(res.pid).toBe(4242);
    expect(res.id).toMatch(/^sshproc-\d+$/);
    expect(res.logPath.startsWith(`${LOG_DIR}/`)).toBe(true);
    expect(res.errLogPath).toContain('.err.log');
    const script = ssh.calls.exec[0].script;
    expect(script).toContain('command -v setsid');
    expect(script).toContain('setsid bash -c');
    expect(script).toContain('echo $!');
    expect(script).toContain(res.logPath);
    expect(ssh.calls.exec[0].cwd).toBe('/srv/app');
  });

  it('命令里的单引号被安全转义（不会截断远端脚本）', async () => {
    const ssh = fakeSsh({ exec: () => ({ code: 0, stdout: '7\n' }) });
    await startRemoteDetached({ ssh, command: `python3 -c 'print("a b")'` });
    const script = ssh.calls.exec[0].script;
    // '\'' 是 POSIX 单引号转义：命令里的每个 ' 都变成 '\''，不会提前闭合外层引号
    expect(script).toContain(`setsid bash -c 'python3 -c '\\''print("a b")'\\'''`);
  });
});

describe('listRemoteProcesses', () => {
  it('判活走 kill -0，活着的才列出；includeFinished 才带已结束的', async () => {
    let alive = true;
    const ssh = fakeSsh({
      exec: (script) => {
        if (script.includes('kill -0')) return { code: 0, stdout: alive ? '4242:1' : '4242:0' };
        return { code: 0, stdout: '4242\n' };
      }
    });
    await startRemoteDetached({ ssh, command: 'sleep 100', sessionId: 's1' });

    const running = await listRemoteProcesses({ ssh, sessionId: 's1' });
    expect(running.count).toBe(1);
    expect(running.processes[0]).toMatchObject({ pid: 4242, alive: true, remote: true, detached: true });

    alive = false;
    const hidden = await listRemoteProcesses({ ssh, sessionId: 's1' });
    expect(hidden.count).toBe(0);
    const shown = await listRemoteProcesses({ ssh, sessionId: 's1', includeFinished: true });
    expect(shown.count).toBe(1);
    expect(shown.processes[0].alive).toBe(false);
  });

  it('别的会话的句柄不串到本会话', async () => {
    const ssh = fakeSsh({ exec: () => ({ code: 0, stdout: '9\n' }) });
    await startRemoteDetached({ ssh, command: 'sleep 1', sessionId: 'other' });
    const res = await listRemoteProcesses({ ssh, sessionId: 'mine', includeFinished: true });
    expect(res.count).toBe(0);
  });
});

describe('readRemoteOutput', () => {
  it('读落盘日志的尾部，并支持 offset 增量', async () => {
    const text = 'line1\nline2\nline3\n';
    const ssh = fakeSsh({
      exec: (script) =>
        script.includes('kill -0') ? { code: 0, stdout: setAlive ? '4242:1' : '4242:0' } : { code: 0, stdout: '4242\n' },
      fileSize: () => Buffer.byteLength(text),
      fileText: () => text
    });
    let setAlive = true;
    const started = await startRemoteDetached({ ssh, command: 'tail -f x', sessionId: 's1' });

    const first = await readRemoteOutput({ ssh, id: started.id, tailBytes: 4096, sessionId: 's1' });
    expect(first.ok).toBe(true);
    expect(first.stdout).toContain('line3');
    expect(first.alive).toBe(true);
    expect(first.offset.stdout).toBe(text.length);

    const next = await readRemoteOutput({
      ssh,
      id: started.id,
      offset: first.offset.stdout,
      tailBytes: 4096,
      sessionId: 's1'
    });
    expect(next.stdout).toBe(''); // 没有新输出
    expect(next.offset.stdout).toBe(text.length);
  });

  it('未登记的句柄给出可执行提示（不允许猜任意远端进程）', async () => {
    const ssh = fakeSsh();
    const res = await readRemoteOutput({ ssh, id: 'sshproc-404' });
    expect(res.ok).toBe(false);
    expect(res.errorCode).toBe('PROC_NOT_FOUND');
    expect(res.hint).toContain('host_proc');
  });
});

describe('killRemoteProcess', () => {
  it('按进程组结束并回报结果', async () => {
    const ssh = fakeSsh({
      exec: (script) => {
        if (script.includes('kill -TERM')) return { code: 0, stdout: 'DEAD' };
        return { code: 0, stdout: '4242\n' };
      }
    });
    const started = await startRemoteDetached({ ssh, command: 'sleep 100', sessionId: 's1' });
    const res = await killRemoteProcess({ ssh, id: started.id, sessionId: 's1' });
    expect(res.ok).toBe(true);
    expect(res.killed[0]).toMatchObject({ id: started.id, pid: 4242, alive: false });
    const killScript = ssh.calls.exec.find((c) => c.script.includes('kill -TERM'));
    expect(killScript.script).toContain('kill -TERM -4242');
    expect(killScript.script).toContain('kill -KILL -4242');
  });

  it('拒绝结束不是 host_exec 启动的 PID', async () => {
    const ssh = fakeSsh();
    const res = await killRemoteProcess({ ssh, pid: 999999, sessionId: 's1' });
    expect(res.ok).toBe(false);
    expect(res.errorCode).toBe('PROC_NOT_FOUND');
  });

  it('会话不匹配时拒绝', async () => {
    const ssh = fakeSsh({ exec: () => ({ code: 0, stdout: '11\n' }) });
    const started = await startRemoteDetached({ ssh, command: 'sleep 1', sessionId: 'other' });
    const res = await killRemoteProcess({ ssh, id: started.id, sessionId: 'mine' });
    expect(res.ok).toBe(false);
    expect(res.errorCode).toBe('PROC_SESSION_MISMATCH');
  });
});
