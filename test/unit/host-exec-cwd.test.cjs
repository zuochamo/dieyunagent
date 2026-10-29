'use strict';

/**
 * host_exec 的两条「失败必须点名」契约（2026-10-28 线上取证）：
 *
 * 1. cwd 不存在时，错误必须是 `CWD_NOT_FOUND` + 路径；
 *    以前 spawn 一个不存在的 cwd，libuv 回的是 `spawn C:\WINDOWS\system32\cmd.exe ENOENT`
 *    —— 报 ComSpec 找不到（其实它好好的），模型只能盲试（实测 4 次 2–6ms 连败）。
 * 2. spawn 失败只算一次失败：`child.on('error')` 已经 settle 外层 Promise，
 *    attachExecSettlement 因同一个 error 再 reject 时不得冒成 unhandledRejection
 *    （线上 main.log 有 4 条 `Unhandled rejection: Error: spawn ... ENOENT`）。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { runShell, runShellDetached } = require('../../src/gateway/host-control');

const isWin = process.platform === 'win32';

describe('host_exec cwd 校验（唯一解析点 resolveSpawnCwd）', () => {
  it('cwd 不存在 → CWD_NOT_FOUND，错误里带路径且不 retryable', async () => {
    const missing = path.join(os.tmpdir(), `dy-missing-cwd-${process.pid}-${Date.now()}`);
    expect(fs.existsSync(missing)).toBe(false);

    const err = await runShell('echo hi', { cwd: missing, timeoutMs: 5000 }).then(
      () => null,
      (e) => e
    );
    expect(err).toBeTruthy();
    expect(err.code).toBe('CWD_NOT_FOUND');
    expect(err.retryable).toBe(false);
    expect(err.message).toContain(missing);
    // 不再把锅甩给 ComSpec
    expect(err.message).not.toContain('cmd.exe ENOENT');
  });

  it('cwd 是文件而不是目录 → 同样 CWD_NOT_FOUND', async () => {
    const file = path.join(os.tmpdir(), `dy-cwd-is-file-${process.pid}-${Date.now()}.txt`);
    fs.writeFileSync(file, 'x', 'utf8');
    try {
      const err = await runShell('echo hi', { cwd: file, timeoutMs: 5000 }).then(
        () => null,
        (e) => e
      );
      expect(err && err.code).toBe('CWD_NOT_FOUND');
      expect(err.message).toContain(file);
    } finally {
      try {
        fs.unlinkSync(file);
      } catch {
        /* ignore */
      }
    }
  });

  it('detached 路径共用同一判定（不会先起进程再报错）', async () => {
    const missing = path.join(os.tmpdir(), `dy-missing-cwd-bg-${process.pid}-${Date.now()}`);
    const err = await runShellDetached('echo hi', { cwd: missing }).then(
      () => null,
      (e) => e
    );
    expect(err && err.code).toBe('CWD_NOT_FOUND');
    expect(err.message).toContain(missing);
  });

  it('合法 cwd 照常执行（校验不误伤）', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dy-cwd-ok-'));
    try {
      const res = await runShell('echo ok-marker', { cwd: dir, timeoutMs: 15000 });
      expect(res.stdout).toContain('ok-marker');
      expect(res.cwd).toBe(dir);
    } finally {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  });
});

describe('spawn 失败不产生 unhandledRejection', () => {
  it('shell 起不来时只 reject 一次，不冒 unhandledRejection', async () => {
    if (!isWin) return; // 只有走 ComSpec 分支才复刻得到线上那条 ENOENT
    const leaked = [];
    const onUnhandled = (reason) => leaked.push(reason && reason.message);
    const saved = process.env.ComSpec;
    process.env.ComSpec = 'C:\\__dy_no_such_shell__\\cmd.exe';
    process.on('unhandledRejection', onUnhandled);
    try {
      const err = await runShell('echo hi', { cwd: os.tmpdir(), timeoutMs: 5000 }).then(
        () => null,
        (e) => e
      );
      expect(err).toBeTruthy();
      expect(err.code).toBe('ENOENT');
      // 给 unhandledRejection 的下一 tick 留出时间
      await new Promise((r) => setTimeout(r, 150));
      expect(leaked).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
      if (saved === undefined) delete process.env.ComSpec;
      else process.env.ComSpec = saved;
    }
  });
});
