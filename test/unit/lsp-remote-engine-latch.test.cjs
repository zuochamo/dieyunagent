'use strict';

/**
 * 远程引擎负缓存（2026-10-27）。
 *
 * 事故形态：远端没装 typescript / eslint / prettier 时，watch 每来一个脏文件就重跑
 * 三条必然失败的命令（tsc→eslint→prettier，实测约 1.4s 一轮），且每次都打一行
 * `[diagnostics] 远程引擎未运行`。打开一个大工程 = 几千条无效 SSH 命令 + 刷屏日志。
 *
 * 这里守四个不变量：
 * 1. 结构性失败（命令/工具不存在）只发**一轮**命令，之后 TTL 内一条都不发；
 * 2. 失败仍要如实汇报（`failures`），不能变成「扫完了，没问题」；
 * 3. 瞬时失败（exec 抛错/超时，exitCode=null）**不许**记成「引擎不可用」；
 * 4. TTL 到期会重新探测一次（远端装好依赖后自愈，不用重启）。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { createLspDiagnosticsService } = require('../../src/lsp/diagnostics-service');

const ROOT = '/home/u/proj';
const FILES = ['a.ts', 'b.ts', 'c.ts'];

let tmpRoot = '';
let userData = '';
let service = null;
let logs = [];

function makeService() {
  logs = [];
  return createLspDiagnosticsService({
    userDataPath: userData,
    log: (msg) => logs.push(String(msg))
  });
}

/** 远端「三条命令全都不存在」：eslint/prettier = 127 + sh not found，tsc = npm 找不到可执行文件。 */
function missingEnginesExec(calls) {
  return async (cmd) => {
    calls.push(String(cmd));
    if (/typescript/.test(cmd)) {
      return { stdout: 'npm error could not determine executable to run', stderr: '', code: 1 };
    }
    const tool = /prettier/.test(cmd) ? 'prettier' : 'eslint';
    return { stdout: `sh: 1: ${tool}: not found`, stderr: '', code: 127 };
  };
}

beforeAll(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dieyun-lsp-remote-engines-'));
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
  service = makeService();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('远程引擎负缓存', () => {
  it('结构性失败只发一轮命令，TTL 内不再发，且仍如实汇报 failures', async () => {
    const calls = [];
    const sshExec = missingEnginesExec(calls);

    const first = await service.diagnoseFilesRemote({ workspaceRoot: ROOT, files: FILES, sshExec });
    const firstCalls = calls.length;
    expect(firstCalls).toBe(3); // tsc 1 + eslint 1 + prettier 1（prettier 命中 127 后立刻停）
    expect(first.failures.map((f) => f.engine).sort()).toEqual(['eslint', 'prettier', 'tsc']);

    const second = await service.diagnoseFilesRemote({ workspaceRoot: ROOT, files: FILES, sshExec });
    expect(calls.length).toBe(firstCalls); // 一条命令都没再发
    expect(second.failures.every((f) => f.blocked === true)).toBe(true);

    // 日志限流：三个引擎各只记一行，不是每文件一行
    const unavailable = logs.filter((l) => l.includes('远程引擎未运行'));
    expect(unavailable.length).toBe(3);
    expect((await service.getStatus()).remoteEngines.length).toBe(3);
  });

  it('watch 批量刷新 6 个文件：只有第一个文件真的发了远程命令', async () => {
    const calls = [];
    const sshExec = missingEnginesExec(calls);
    for (const rel of ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts', 'f.ts']) {
      await service.scheduleFileDiagnosticsRefresh(ROOT, `${ROOT}/${rel}`, {
        immediate: true,
        mode: 'ssh',
        sshExec
      });
    }
    // 修复前：6 个文件 × 3 引擎 = 18 条必然失败的远程命令（线上实测每 1.4s 一轮刷屏）
    expect(calls.length).toBe(3);
    expect(logs.filter((l) => l.includes('远程引擎未运行')).length).toBe(3);
  });

  it('瞬时失败（exec 抛错）不记负缓存，下次仍会探测', async () => {
    let attempts = 0;
    const sshExec = async () => {
      attempts += 1;
      throw new Error('ssh: connect to host timeout');
    };

    await service.diagnoseFilesRemote({ workspaceRoot: ROOT, files: FILES, sshExec });
    const afterFirst = attempts;
    expect(afterFirst).toBeGreaterThan(0);

    await service.diagnoseFilesRemote({ workspaceRoot: ROOT, files: FILES, sshExec });
    expect(attempts).toBeGreaterThan(afterFirst); // 没有被「永久判死」
    expect((await service.getStatus()).remoteEngines.length).toBe(0);
  });

  it('TTL 到期后重新探测一次（远端装好依赖能自愈）', async () => {
    const calls = [];
    const sshExec = missingEnginesExec(calls);

    await service.diagnoseFilesRemote({ workspaceRoot: ROOT, files: FILES, sshExec });
    const firstCalls = calls.length;

    await service.diagnoseFilesRemote({ workspaceRoot: ROOT, files: FILES, sshExec });
    expect(calls.length).toBe(firstCalls);

    // 把时间推过结构性 TTL（10 分钟）
    const realNow = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(realNow + 11 * 60 * 1000);

    await service.diagnoseFilesRemote({ workspaceRoot: ROOT, files: FILES, sshExec });
    expect(calls.length).toBeGreaterThan(firstCalls);
  });
});
