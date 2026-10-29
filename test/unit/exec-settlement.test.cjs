'use strict';

/**
 * 「一条命令什么时候算结束」的唯一判定（issue-host-exec-background-timeout.md）。
 *
 * 真机现象：命令主体退出时 sshd 就发了 exit-status，但后台进程继承了这次会话的输出管道
 * → `close` 迟迟不来 → 旧代码一直等到 timeout，把「已启动」报成 SSH_EXEC_TIMEOUT。本机
 * POSIX 侧（Node spawn）同源。这里用假事件源复刻两种事件顺序，锁住「exit-status 后按静默
 * 窗口收尾」。
 */

const { EventEmitter } = require('events');
const { attachExecSettlement, EXIT_QUIET_MS } = require('../../src/exec-settlement');

/** ssh2 Channel 替身：data/exit/close 都在同一个对象上，另有 stderr。 */
function fakeChannel() {
  const ch = new EventEmitter();
  ch.stderr = new EventEmitter();
  return ch;
}

/** Node ChildProcess 替身：stdout/stderr 是独立流，生命周期事件在 child 上。 */
function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  return child;
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

describe('attachExecSettlement', () => {
  it('正常结束：按 close 收尾，带 exit code 与 stdout/stderr', async () => {
    const ch = fakeChannel();
    const p = attachExecSettlement({ out: ch, err: ch.stderr, life: ch }, { quietMs: 80, accumulate: true });
    ch.emit('data', Buffer.from('hi\n'));
    ch.stderr.emit('data', Buffer.from('warn\n'));
    ch.emit('exit', 0);
    ch.emit('close', 0);
    const r = await p;
    expect(r).toMatchObject({ code: 0, stdout: 'hi\n', stderr: 'warn\n', settledBy: 'close' });
  });

  it('后台进程握着输出管道（只来 exit-status）→ 静默窗口收尾，并让调用方释放资源', async () => {
    const ch = fakeChannel();
    const released = [];
    const t0 = Date.now();
    const p = attachExecSettlement(
      { out: ch, err: ch.stderr, life: ch },
      { quietMs: 80, accumulate: true, onSettle: (by) => released.push(by) }
    );
    ch.emit('data', Buffer.from('started\n'));
    ch.emit('exit', 0); // 管道被后台进程占着 → 永远等不到 close
    const r = await p;
    expect(r.settledBy).toBe('exit');
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('started\n');
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(released).toEqual(['exit']);
  });

  it('exit 之后仍在途的尾部输出不会被丢掉（静默窗口内继续收）', async () => {
    const ch = fakeChannel();
    const p = attachExecSettlement({ out: ch, err: ch.stderr, life: ch }, { quietMs: 120, accumulate: true });
    ch.emit('data', Buffer.from('a'));
    ch.emit('exit', 0);
    await wait(60);
    ch.emit('data', Buffer.from('b'));
    const r = await p;
    expect(r.stdout).toBe('ab');
    expect(r.settledBy).toBe('exit');
  });

  it('exit 之后持续有输出时静默窗口被重置，不会半路截断', async () => {
    const ch = fakeChannel();
    const p = attachExecSettlement({ out: ch, err: ch.stderr, life: ch }, { quietMs: 120, accumulate: true });
    ch.emit('exit', 0);
    for (let i = 0; i < 5; i++) {
      await wait(60);
      ch.emit('data', Buffer.from(String(i)));
    }
    expect((await p).stdout).toBe('01234');
  });

  it('Node ChildProcess 形状（stdout/stderr 独立流）也能按 close 收尾', async () => {
    const child = fakeChild();
    const p = attachExecSettlement(
      { out: child.stdout, err: child.stderr, life: child },
      { quietMs: 80, accumulate: false }
    );
    child.stdout.emit('data', Buffer.from('x'));
    child.emit('exit', 3);
    child.emit('close', 3);
    const r = await p;
    expect(r).toMatchObject({ code: 3, settledBy: 'close' });
    expect(r.stdout).toBeUndefined(); // accumulate=false：输出由调用方自己攒（本机 runShell 有带上限的缓冲）
  });

  it('既没有 exit 也没有 close 时不自己收尾（超时由调用方兜底）', async () => {
    const ch = fakeChannel();
    let settled = false;
    attachExecSettlement({ out: ch, err: ch.stderr, life: ch }, { quietMs: 60, accumulate: true }).then(() => {
      settled = true;
    });
    await wait(EXIT_QUIET_MS);
    expect(settled).toBe(false);
  });

  it('退出码原样带出（含 signal 终止的 null），由调用方决定怎么归一', async () => {
    const a = fakeChannel();
    const pa = attachExecSettlement({ out: a, err: a.stderr, life: a }, { quietMs: 60 });
    a.emit('exit', 2);
    expect((await pa).code).toBe(2);

    const b = fakeChannel();
    const pb = attachExecSettlement({ out: b, err: b.stderr, life: b }, { quietMs: 60 });
    b.emit('exit', null);
    expect((await pb).code).toBe(null);
  });

  it('通道错误在拿到 exit-status 之后不再影响结论', async () => {
    const ch = fakeChannel();
    const p = attachExecSettlement({ out: ch, err: ch.stderr, life: ch }, { quietMs: 80, accumulate: true });
    ch.emit('data', Buffer.from('ok'));
    ch.emit('exit', 0);
    ch.emit('error', new Error('ECONNRESET after exit'));
    const r = await p;
    expect(r.stdout).toBe('ok');
    expect(r.settledBy).toBe('exit');
  });

  /**
   * ssh2 的 data 是按字节包交付的：一个汉字被切成两个包很常见。
   * 旧实现每块单独 `chunk.toString()`，被切开的字符变成 U+FFFD（远端 shell 早已用
   * TextDecoder(stream:true) 修过，exec 这条漏了）。
   */
  it('跨包被切开的 UTF-8 字符要拼回来，不能变成替换符', async () => {
    const ch = fakeChannel();
    const p = attachExecSettlement({ out: ch, err: ch.stderr, life: ch }, { quietMs: 80, accumulate: true });
    const whole = Buffer.from('中文输出：✅\n', 'utf8');
    // 在「中」字的三个字节中间切开
    ch.emit('data', whole.subarray(0, 1));
    ch.emit('data', whole.subarray(1, 8));
    ch.emit('data', whole.subarray(8));
    ch.emit('exit', 0);
    ch.emit('close', 0);
    const r = await p;
    expect(r.stdout).toBe('中文输出：✅\n');
    expect(r.stdout).not.toContain('\uFFFD');
  });

  it('输出超上限时保留尾部并报 truncated/droppedChars（不能让一条 yes 吃光内存）', async () => {
    const ch = fakeChannel();
    const p = attachExecSettlement(
      { out: ch, err: ch.stderr, life: ch },
      { quietMs: 80, accumulate: true, maxChars: 1024 }
    );
    ch.emit('data', Buffer.from('A'.repeat(600)));
    ch.emit('data', Buffer.from('B'.repeat(600)));
    ch.emit('data', Buffer.from('TAIL'));
    ch.emit('exit', 0);
    ch.emit('close', 0);
    const r = await p;
    expect(r.truncated).toBe(true);
    expect(r.droppedChars).toBe(600 + 600 + 4 - 1024);
    expect(r.stdout.endsWith('TAIL')).toBe(true);
    expect(r.stdout.length).toBe(1024);
  });

  it('未超上限时不报 truncated（默认路径不许出现假的截断标记）', async () => {
    const ch = fakeChannel();
    const p = attachExecSettlement({ out: ch, err: ch.stderr, life: ch }, { quietMs: 80, accumulate: true });
    ch.emit('data', Buffer.from('small'));
    ch.emit('close', 0);
    const r = await p;
    expect(r.truncated).toBe(false);
    expect(r.droppedChars).toBe(undefined);
  });
});
