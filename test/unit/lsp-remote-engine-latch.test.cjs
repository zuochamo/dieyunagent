'use strict';

/**
 * 远程诊断的两道闸门（2026-10-27）。
 *
 * 事故形态：远端没装 typescript / eslint / prettier 时，watch 每来一个脏文件就重跑
 * 三条必然失败的命令（tsc→eslint→prettier，实测约 1.4s 一轮），且每次都打一行
 * `[diagnostics] 远程引擎未运行`。打开一个大工程 = 几千条无效 SSH 命令 + 刷屏日志。
 *
 * 设计口径（与本地路径一致）：**只跑项目自己有的工具**。项目没配 eslint/prettier，
 * 就不要 `npx -y` 拉一个用户没装的东西来指责他的代码。因此：
 * - 闸门一：一次 `ls` + `package.json` 依赖探测，决定这轮跑哪些引擎（`skippedEngines` 说明没跑的原因）；
 * - 闸门二：真的跑起来却失败时，负缓存把重试压到 TTL 一次，日志也只记一行；
 *   「命令不存在」与「网络抖动」必须区别对待（后者不许记成引擎不可用）。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { createLspDiagnosticsService } = require('../../src/lsp/diagnostics-service');
const { runRemoteTscBatch } = require('../../src/lsp/cli-fallback');

const ROOT = '/home/u/proj';
const FILES = ['a.ts', 'b.ts', 'c.ts'];
const PROBE_MARK = '--dieyun-deps--';

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

/** 探测应答：`files` 是项目根下存在的配置文件，`deps` 是 package.json 里声明的工具。 */
function probeReply(files, deps) {
  return {
    stdout: `${(files || []).join('\n')}\n${PROBE_MARK}\n${(deps || []).map((d) => `"${d}":`).join('\n')}`,
    stderr: '',
    code: 0
  };
}

/**
 * 一个「项目配了三个工具、但远端三个命令全都跑不起来」的 SSH 假执行器。
 * eslint/prettier = 127 + sh not found，tsc = npm 找不到可执行文件。
 */
function missingEnginesExec(calls, extra = {}) {
  return async (cmd) => {
    const text = String(cmd);
    calls.push(text);
    if (text.includes(PROBE_MARK)) {
      return probeReply(
        extra.files || ['tsconfig.json', 'eslint.config.js', '.prettierrc'],
        extra.deps || []
      );
    }
    if (/typescript/.test(text)) {
      return { stdout: 'npm error could not determine executable to run', stderr: '', code: 1 };
    }
    const tool = /prettier/.test(text) ? 'prettier' : 'eslint';
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

describe('远程 tsc 命令', () => {
  it('必须显式点名 tsc 这个 bin', async () => {
    // 包 `typescript` 有两个 bin（tsc / tsserver），`npx -y typescript …` 在装了 5.x 的机器上
    // 必报 `npm error could not determine executable to run`：命令根本没跑，诊断却当引擎失败。
    const cmds = [];
    const exec = async (cmd) => {
      cmds.push(String(cmd));
      return { stdout: '', code: 0 };
    };
    await runRemoteTscBatch({ exec, projectRoot: ROOT, absPaths: [`${ROOT}/a.ts`] });
    expect(cmds.length).toBe(1);
    expect(cmds[0]).toContain('-p typescript tsc');
    expect(cmds[0]).not.toMatch(/npx -y typescript\b/);
  });
});

describe('闸门一：项目没配的工具不跑', () => {
  it('只有 package.json、没有任何 lint/format 配置时，一条引擎命令都不发', async () => {
    const calls = [];
    const sshExec = missingEnginesExec(calls, { files: ['package.json'] });

    const res = await service.diagnoseFilesRemote({ workspaceRoot: ROOT, files: FILES, sshExec });

    expect(calls.length).toBe(1); // 只有那次探测
    expect(calls[0]).toContain(PROBE_MARK);
    expect(res.failures).toBeUndefined(); // 不是失败：是「项目里没有，跳过」
    expect(res.skippedEngines.sort()).toEqual(['eslint', 'prettier', 'tsc']);
  });

  it('package.json 声明了 prettier 依赖就算「项目用它」，会真跑 prettier', async () => {
    const calls = [];
    const sshExec = missingEnginesExec(calls, { files: ['package.json'], deps: ['prettier'] });

    const res = await service.diagnoseFilesRemote({ workspaceRoot: ROOT, files: FILES, sshExec });

    expect(calls.some((c) => /prettier/.test(c))).toBe(true);
    expect(res.skippedEngines.sort()).toEqual(['eslint', 'tsc']);
  });
});

describe('闸门二：跑起来却失败时，压成 TTL 一次', () => {  it('结构性失败只发一轮命令，TTL 内不再发，且仍如实汇报 failures', async () => {
    const calls = [];
    const sshExec = missingEnginesExec(calls);

    const first = await service.diagnoseFilesRemote({ workspaceRoot: ROOT, files: FILES, sshExec });
    const firstCalls = calls.length;
    expect(firstCalls).toBe(4); // 探测 1 + tsc/eslint/prettier 各 1（prettier 命中 127 后立刻停）
    expect(first.failures.map((f) => f.engine).sort()).toEqual(['eslint', 'prettier', 'tsc']);

    const second = await service.diagnoseFilesRemote({ workspaceRoot: ROOT, files: FILES, sshExec });
    expect(calls.length).toBe(firstCalls); // 一条命令都没再发（探测与失败都命中缓存）
    expect(second.failures.every((f) => f.blocked === true)).toBe(true);

    // 日志限流：三个引擎各只记一行，不是每文件一行
    const unavailable = logs.filter((l) => l.includes('远程引擎未运行'));
    expect(unavailable.length).toBe(3);
    expect((await service.getStatus()).remoteEngines.length).toBe(3);
  });

  it('watch 批量刷新 6 个文件：探测 1 次 + 首文件 3 条，后面全部跳过', async () => {
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
    expect(calls.length).toBe(4);
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

    const realNow = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(realNow + 6 * 60 * 1000); // 把探测缓存放过期
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

describe('远程工作区的路径归一', () => {
  it('agent 诊断上下文必须用 POSIX 根做 cwd，不能 resolve 成 E:\\run\\media\\…', async () => {
    // 事故形态：`getAgentDiagnosticsContext` 无条件 `path.resolve(workspaceRoot)`，
    // Windows 上把 `/home/u/proj` 变成 `E:\home\u\proj`，后续 sshExec 的 cwd 全部失效，
    // 远程工作区的 agent 诊断上下文长期是空的。
    const calls = [];
    const sshExec = async (cmd, cwd) => {
      const text = String(cmd);
      calls.push({ cmd: text, cwd: String(cwd) });
      if (text.includes(PROBE_MARK)) return probeReply(['tsconfig.json', 'eslint.config.js'], []);
      if (/typescript/.test(text)) return { stdout: '', stderr: '', code: 0 };
      if (/prettier/.test(text)) return { stdout: '', stderr: '', code: 0 };
      return {
        stdout: JSON.stringify([
          {
            filePath: `${ROOT}/a.ts`,
            messages: [{ line: 1, column: 1, severity: 2, ruleId: 'no-unused-vars', message: 'unused' }]
          }
        ]),
        stderr: '',
        code: 1
      };
    };

    const res = await service.getAgentDiagnosticsContext({
      workspaceRoot: ROOT,
      files: ['a.ts'],
      sshExec,
      triggerProjectScan: false
    });

    expect(res.ok).toBe(true);
    expect(res.workspaceRoot).toBe(ROOT);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((c) => c.cwd === ROOT)).toBe(true);
    // 真跑出诊断并落到 store，说明「POSIX 根 → 探测 → 引擎 → store」整条链路是通的
    expect(res.items.some((it) => String(it.file).endsWith('/a.ts'))).toBe(true);
    // 项目没配 prettier：要如实说「没跑」，而不是让调用方以为「0 个问题」
    expect(res.skippedEngines).toEqual(['prettier']);
  });
});
