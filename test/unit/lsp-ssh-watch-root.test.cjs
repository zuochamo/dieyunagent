'use strict';

/**
 * SSH 工作区的 watch 根路径（2026-10-17 修复）。
 *
 * 事故形态：`startWorkspaceDiagnosticsWatch` 用 `path.resolve('/home/u/proj')` 建桶，
 * Windows 上得到 `E:\home\u\proj`；而 `stopWorkspaceDiagnosticsWatch` / `getWatchStatus`
 * 用原串算 key。两者永不相等，导致：
 * ① stop 永远 return → `setInterval` 每 25s 跑一次 ssh git diff，永不停止；
 * ② `pollSshDirtyFiles` 把 `E:\home\u\proj` 当远程 cwd，git 命令在远程不存在；
 * ③ 面板 watch 状态恒 off。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { createLspDiagnosticsService } = require('../../src/lsp/diagnostics-service');

let tmpRoot = '';
let userData = '';
let service = null;

beforeAll(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dieyun-lsp-sshroot-'));
  userData = path.join(tmpRoot, 'userData');
  fs.mkdirSync(userData, { recursive: true });
});

afterAll(() => {
  try {
    if (service) service.shutdown();
  } catch {
    // ignore
  }
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

beforeEach(() => {
  if (service) service.shutdown();
  service = createLspDiagnosticsService({ userDataPath: userData, log: () => {} });
});

describe('SSH watch 根路径', () => {
  it('POSIX 远端根 start 后能用同一入参 stop / 查询状态', async () => {
    const root = '/home/u/proj';
    const calls = [];
    const sshExec = async (cmd, cwd) => {
      calls.push({ cmd: String(cmd || ''), cwd: String(cwd || '') });
      return { stdout: '' };
    };

    const started = service.startWorkspaceDiagnosticsWatch(root, { mode: 'ssh', sshExec });
    expect(started.ok).toBe(true);
    expect(started.mode).toBe('ssh_poll');

    const status = service.getWatchStatus(root);
    expect(status.active).toBe(true);
    expect(status.mode).toBe('ssh');

    // 立刻触发过一次 poll：cwd 必须是原始 POSIX 路径，不是 E:\home\u\proj
    await new Promise((r) => setTimeout(r, 50));
    expect(calls.length).toBeGreaterThan(0);
    expect(calls[0].cwd).toBe(root);

    // 同一个入参必须能停掉（旧实现这里静默失败，interval 泄漏到进程退出）
    service.stopWorkspaceDiagnosticsWatch(root);
    const after = service.getWatchStatus(root);
    expect(after.active).toBe(false);
    expect(after.mode).toBe('off');
  });

  it('本地根仍然走 path.resolve（行为不变）', () => {
    const local = path.join(tmpRoot, 'ws');
    fs.mkdirSync(local, { recursive: true });
    const started = service.startWorkspaceDiagnosticsWatch(local);
    expect(started.ok).toBe(true);
    expect(started.mode).toBe('local_watch');
    expect(service.getWatchStatus(local).active).toBe(true);
    service.stopWorkspaceDiagnosticsWatch(local);
    expect(service.getWatchStatus(local).active).toBe(false);
  });

  it('远端 exec 没回来时不排下一轮（不叠在串行 exec 链上）', async () => {
    vi.useFakeTimers();
    try {
      const root = '/home/u/slow';
      let calls = 0;
      let release = null;
      const sshExec = () => {
        calls += 1;
        return new Promise((resolve) => {
          release = () => resolve({ stdout: '' });
        });
      };

      service.startWorkspaceDiagnosticsWatch(root, { mode: 'ssh', sshExec });
      await vi.advanceTimersByTimeAsync(1); // 首轮立刻开跑，卡在这个永不返回的 exec 上
      expect(calls).toBe(1);

      // 四倍轮询间隔过去：旧实现（setInterval）这里会排到 5 条，全堆在同一条串行 exec 链上
      await vi.advanceTimersByTimeAsync(25_000 * 4);
      expect(calls).toBe(1);

      release(); // 这一轮回来了才允许排下一轮
      await vi.advanceTimersByTimeAsync(25_000);
      expect(calls).toBe(2);

      service.stopWorkspaceDiagnosticsWatch(root);
    } finally {
      vi.useRealTimers();
    }
  });
});
