'use strict';

/**
 * B2：host_exec 长任务语义。
 * - keepOnTimeout：到点不杀进程，转后台并返回 handle（旧行为仍是超时终止 + 带尾部输出）；
 * - readProcessOutput：活进程也能读增量输出（detached 读落盘日志，转后台读内存缓冲）。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { runShell, readProcessOutput, listProcessHandles } = require('../../src/gateway/host-control');

const nodeBin = process.execPath;

/**
 * 造一条会跑 ms 毫秒、期间分两段输出的命令。
 * 必须落成临时 .js：Windows cmd 下 `;` 会切断命令（tool-catalog 里同款坑）。
 *
 * 命令里的路径一律加引号：runShell 现在按 cmd 规矩传参（windowsVerbatimArguments），
 * 带空格的 node 路径（`C:\Program Files\nodejs\node.exe`）不加引号会直接找不到命令。
 * 之前不加引号是绕 runShell 的转义 bug，那个 bug 已修，绕法要一起撤掉。
 */
let slowScriptPath = null;

function quoteIfNeeded(p) {
  const s = String(p);
  return /\s/.test(s) ? `"${s}"` : s;
}

function slowCommand(ms) {
  if (!slowScriptPath) {
    slowScriptPath = path.join(os.tmpdir(), `dy-slow-${process.pid}.js`);
    fs.writeFileSync(
      slowScriptPath,
      `console.log('start');\nsetTimeout(function () { console.log('done'); }, ${ms});\n`,
      'utf8'
    );
  }
  return `${quoteIfNeeded(nodeBin)} ${quoteIfNeeded(slowScriptPath)}`;
}

describe('runShell keepOnTimeout（超时转后台）', () => {
  it('到点不杀进程，返回 handle 且输出可续读', async () => {
    const res = await runShell(slowCommand(1500), {
      timeoutMs: 400,
      keepOnTimeout: true,
      trackProcess: true,
      sessionId: 'test-session'
    });
    expect(res.timedOut).toBe(true);
    expect(res.stillRunning).toBe(true);
    expect(res.handle).toMatch(/^hostproc-/);
    expect(res.code).toBeNull();
    expect(res.hint).toContain('host_proc');
    expect(res.stdout).toContain('start');

    // 进程仍在运行 → 能读到输出
    const out = await readProcessOutput({ id: res.handle, sessionId: 'test-session' });
    expect(out.ok).toBe(true);
    expect(out.stdout).toContain('start');

    // 等它自己结束，确认还能读到后段输出
    const later = await readProcessOutput({ id: res.handle, waitMs: 3000, sessionId: 'test-session' });
    expect(later.ok).toBe(true);
    expect(later.stdout).toContain('done');
    expect(later.alive).toBe(false);
  }, 20000);

  it('未开启时保持旧语义：超时终止，错误里带终止前输出', async () => {
    let err = null;
    try {
      await runShell(slowCommand(1500), { timeoutMs: 400, trackProcess: true });
    } catch (e) {
      err = e;
    }
    expect(err).toBeTruthy();
    expect(err.timedOut).toBe(true);
    expect(err.message).toContain('超时');
    expect(String(err.stdoutTail || '')).toContain('start');
  }, 20000);

  it('giveUp 路径不受影响：正常结束仍返回 code/stdout', async () => {
    const res = await runShell('echo ok-marker', { timeoutMs: 5000, trackProcess: true });
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('ok-marker');
  }, 20000);
});

describe('后台进程握着输出管道时的收尾', () => {
  /**
   * 同源坑（POSIX）：`sh -c 'sleep N & echo hi'` 里 sleep 继承了 stdout 管道，
   * Node 的 close 要等管道 EOF → 旧代码会一直等到超时，把「命令早就跑完了」报成失败。
   * 判定改由 exec-settlement 给（exit-status + 静默窗口），这里锁住「不再等到超时」。
   */
  it('命令退出但孙进程占着 stdout 时，不再等超时', async () => {
    if (process.platform === 'win32') return; // Windows 走 cmd.exe，没有同款继承语义
    const t0 = Date.now();
    const res = await runShell(`sh -c 'sleep 3 & echo hi'`, { timeoutMs: 20000 });
    const elapsed = Date.now() - t0;
    expect(res.stdout).toContain('hi');
    expect(res.code).toBe(0);
    expect(elapsed).toBeLessThan(2500);
    expect(res.behindStillHoldingStdio).toBe(true);
  }, 20000);

  it('真正长驻的前台命令仍然按等待窗口超时（不误判成功）', async () => {
    if (process.platform === 'win32') return;
    const t0 = Date.now();
    let err = null;
    try {
      await runShell('sleep 5', { timeoutMs: 900 });
    } catch (e) {
      err = e;
    }
    expect(err && err.timedOut).toBe(true);
    expect(Date.now() - t0).toBeLessThan(4000);
  }, 20000);
});

describe('超时终止的进程树语义', () => {
  it('连孙进程一起杀掉，不是只杀 cmd.exe', async () => {
    if (process.platform !== 'win32') return; // taskkill /T 是 Win32 专用，POSIX 走进程组
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dy-killtree-'));
    const tick = path.join(dir, 'tick.txt');
    const script = path.join(dir, 'tick.js');
    fs.writeFileSync(
      script,
      `const fs = require('fs');\nsetInterval(function () { fs.appendFileSync(${JSON.stringify(tick)}, 'x'); }, 150);\n`,
      'utf8'
    );
    let err = null;
    try {
      // 不带 keepOnTimeout：走「超时终止」路径（以前这里是 child.kill()，只杀 cmd.exe）
      await runShell(`${quoteIfNeeded(nodeBin)} ${quoteIfNeeded(script)}`, {
        timeoutMs: 900,
        trackProcess: true
      });
    } catch (e) {
      err = e;
    }
    expect(err && err.timedOut).toBe(true);
    // 给 taskkill /T 一点时间，然后看 tick 文件还长不长
    await new Promise((r) => setTimeout(r, 700));
    const s1 = fs.existsSync(tick) ? fs.statSync(tick).size : 0;
    expect(s1).toBeGreaterThan(0);
    await new Promise((r) => setTimeout(r, 800));
    const s2 = fs.existsSync(tick) ? fs.statSync(tick).size : 0;
    expect(s2).toBe(s1); // 还在增长说明孙进程活下来了
    fs.rmSync(dir, { recursive: true, force: true });
  }, 20000);
});

describe('readProcessOutput（读输出）', () => {
  it('不存在的句柄给出可执行提示', async () => {
    const out = await readProcessOutput({ id: 'hostproc-does-not-exist' });
    expect(out.ok).toBe(false);
    expect(out.errorCode).toBe('PROC_NOT_FOUND');
    expect(out.hint).toContain('host_proc');
  });

  it('list 会标出哪些句柄有输出可读', async () => {
    const res = await runShell(slowCommand(1200), {
      timeoutMs: 300,
      keepOnTimeout: true,
      trackProcess: true,
      sessionId: 'test-list'
    });
    const listed = listProcessHandles({ sessionId: 'test-list' });
    const row = listed.processes.find((p) => p.id === res.handle);
    expect(row).toBeTruthy();
    expect(row.hasOutput).toBe(true);
    // 收尾，避免留下进程
    await readProcessOutput({ id: res.handle, waitMs: 2500, sessionId: 'test-list' });
  }, 20000);
});
