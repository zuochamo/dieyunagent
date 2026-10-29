'use strict';

/**
 * 后台任务「静默补报」（B 方案，对齐 DSH 的 completionDelivery: 'quiet'）。
 *
 * 语义：只补报**模型拿不到退出码**的后台/长任务（detached、waitMs 转后台）；
 * 取走一次即标记已投递（不重复刷屏）；前台命令当轮已有 exit code，不该再报。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const {
  registerProcessHandle,
  takeSettledReports,
  readProcessOutput
} = require('../../src/gateway/host-control');
const { formatSettledJobsBlock } = require('../../src/agent/system-prompt-prep');

const nodeBin = process.execPath;

function waitExit(child) {
  return new Promise((resolve) => {
    if (child.exitCode != null) {
      resolve(child.exitCode);
      return;
    }
    child.once('exit', (code) => resolve(code));
  });
}

function logFileWith(text) {
  const file = path.join(os.tmpdir(), `dy-settled-${process.pid}-${Date.now()}-${Math.random()}.log`);
  fs.writeFileSync(file, text, 'utf8');
  return file;
}

describe('takeSettledReports：只报「模型没拿到退出码」的后台任务', () => {
  it('后台任务结束后补报一次，第二次为空', async () => {
    const logPath = logFileWith('build ok\nexit 0\n');
    const child = spawn(nodeBin, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
    registerProcessHandle({
      command: 'npm run build',
      sessionId: 'session-settled-a',
      pid: child.pid,
      child,
      awaitReport: true,
      logPath
    });
    await waitExit(child);
    // 让 'exit' 事件派发到句柄记录上
    await new Promise((r) => setTimeout(r, 50));

    const first = takeSettledReports({ sessionId: 'session-settled-a' });
    expect(first.count).toBe(1);
    expect(first.jobs[0].stdout).toContain('build ok');
    expect(first.jobs[0].exitCode).toBe(0);

    const second = takeSettledReports({ sessionId: 'session-settled-a' });
    expect(second.count).toBe(0);
  });

  it('前台命令（不含 awaitReport）永不补报', async () => {
    const child = spawn(nodeBin, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
    registerProcessHandle({
      command: 'npm run lint',
      sessionId: 'session-settled-foreground',
      pid: child.pid,
      child,
      logPath: logFileWith('lint ok\n')
    });
    await waitExit(child);
    await new Promise((r) => setTimeout(r, 50));

    expect(takeSettledReports({ sessionId: 'session-settled-foreground' }).count).toBe(0);
  });

  it('仍在运行的任务不报', async () => {
    const child = spawn(nodeBin, ['-e', 'setTimeout(() => {}, 5000)'], { stdio: 'ignore' });
    try {
      registerProcessHandle({
        command: 'npm run dev',
        sessionId: 'session-settled-running',
        pid: child.pid,
        child,
        awaitReport: true,
        logPath: logFileWith('starting\n')
      });
      expect(takeSettledReports({ sessionId: 'session-settled-running' }).count).toBe(0);
    } finally {
      child.kill('SIGKILL');
    }
  });

  it('模型自己读过退出的后台任务，就不再补报', async () => {
    const logPath = logFileWith('done\n');
    const child = spawn(nodeBin, ['-e', 'process.exit(3)'], { stdio: 'ignore' });
    const rec = registerProcessHandle({
      command: 'npm test',
      sessionId: 'session-settled-read',
      pid: child.pid,
      child,
      awaitReport: true,
      logPath
    });
    await waitExit(child);
    await new Promise((r) => setTimeout(r, 50));

    const read = await readProcessOutput({ id: rec.id, sessionId: 'session-settled-read' });
    expect(read.alive).toBe(false);
    expect(takeSettledReports({ sessionId: 'session-settled-read' }).count).toBe(0);
  });

  it('别的会话的任务不会串到本会话', async () => {
    const child = spawn(nodeBin, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
    registerProcessHandle({
      command: 'npm run other',
      sessionId: 'session-settled-owner',
      pid: child.pid,
      child,
      awaitReport: true,
      logPath: logFileWith('other\n')
    });
    await waitExit(child);
    await new Promise((r) => setTimeout(r, 50));
    expect(takeSettledReports({ sessionId: 'session-settled-other' }).count).toBe(0);
  });

  it('没有会话归属的句柄不往任何会话推（推送不像 list 那样是「你问我才给」）', async () => {
    const child = spawn(nodeBin, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
    registerProcessHandle({
      command: 'npm run unattributed',
      pid: child.pid,
      child,
      awaitReport: true,
      logPath: logFileWith('unattributed\n')
    });
    await waitExit(child);
    await new Promise((r) => setTimeout(r, 50));
    expect(takeSettledReports({ sessionId: 'session-settled-someone' }).count).toBe(0);
  });

  it('当初就没起来的句柄（无 pid 无 child）不误报「已结束」', () => {
    registerProcessHandle({
      command: 'start-process 没解析出 pid',
      sessionId: 'session-settled-nopid',
      pid: null,
      awaitReport: true,
      logPath: logFileWith('')
    });
    expect(takeSettledReports({ sessionId: 'session-settled-nopid' }).count).toBe(0);
  });
});

describe('formatSettledJobsBlock：补报文案', () => {
  it('给出 handle、退出码与尾部输出，并明确「已结束不要再等」', () => {
    const block = formatSettledJobsBlock([
      { id: 'hostproc-7', command: 'npm run build', exitCode: 0, stdout: 'vite build ok' }
    ]);
    expect(block).toContain('【后台任务已结束】');
    expect(block).toContain('hostproc-7');
    expect(block).toContain('exit 0');
    expect(block).toContain('vite build ok');
    expect(block).toContain('host_proc action=output id=hostproc-7');
    expect(block).toContain('不要再等或轮询');
  });

  it('退出码未知（detached / 远端）时如实说不知道，不编数字', () => {
    const block = formatSettledJobsBlock([
      { id: 'sshproc-2', command: 'make -j8', exitCode: null, stderr: 'error: boom' }
    ]);
    expect(block).toContain('退出码未知');
    expect(block).toContain('error: boom');
  });

  it('按真实启动时长说清「多久之前起的」，不笼统说「上一轮」', () => {
    const now = Date.parse('2026-10-28T22:00:00+08:00');
    const block = formatSettledJobsBlock(
      [{ id: 'hostproc-9', command: 'npm run build', exitCode: 0, startedAt: now - 12 * 60000 }],
      now
    );
    expect(block).toContain('12 分钟前启动');
    expect(block).not.toContain('上一轮');
  });

  it('空列表不产生任何上下文', () => {
    expect(formatSettledJobsBlock([])).toBe('');
    expect(formatSettledJobsBlock(null)).toBe('');
  });

  it('条数有上限，避免一轮上下文被一堆任务吃掉', () => {
    const jobs = Array.from({ length: 6 }, (_, i) => ({
      id: `hostproc-${i}`,
      command: `cmd-${i}`,
      exitCode: 0,
      stdout: 'ok'
    }));
    const block = formatSettledJobsBlock(jobs);
    expect(block).toContain('hostproc-0');
    expect(block).not.toContain('hostproc-5');
  });
});
