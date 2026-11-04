'use strict';

/**
 * src/main/linux-deb-install.js 的纯逻辑/参数构造回归。
 *
 * 这层代码解决的问题有现场记录（dieyun17 / Ubuntu 26.04）：更新装完自重启回来的实例
 * 带 NoNewPrivs=1，进程内 pkexec 一律 127 `must be setuid root`，而 NNP 撤不掉 ——
 * 所以提权必须换到 systemd 起的干净进程树里。构造错了就等于又回到必然失败的老路径，
 * 因此参数形状要钉死。
 */

const assert = require('assert');
const {
  readNoNewPrivs,
  shellSingleQuote,
  buildDebInstallCommand,
  buildSystemdRunArgs,
  resolveSystemdRun,
  manualInstallCommand,
  installDebInCleanTree,
  relaunchInCleanTree
} = require('../src/main/linux-deb-install');

// --- NoNewPrivs 解析 ---------------------------------------------------------
const sample = [
  'Name:\tdieyunagent',
  'Uid:\t1000\t1000\t1000\t1000',
  'NoNewPrivs:\t1',
  'Seccomp:\t0'
].join('\n');
assert.strictEqual(readNoNewPrivs(sample), 1, 'NNP=1');
assert.strictEqual(readNoNewPrivs('NoNewPrivs:\t0\n'), 0, 'NNP=0');
assert.strictEqual(readNoNewPrivs('NoNewPrivs: 1'), 1, 'blank separator');
assert.strictEqual(readNoNewPrivs(''), null, 'empty -> null');
assert.strictEqual(readNoNewPrivs(undefined), null, 'undefined -> null');
assert.strictEqual(readNoNewPrivs('Something:\t1'), null, 'unrelated key ignored');

// --- shell 转义：安装路径里有空格和中文是常态 --------------------------------
assert.strictEqual(shellSingleQuote('/opt/叠云 Agent/a.deb'), "'/opt/叠云 Agent/a.deb'", 'plain');
assert.strictEqual(shellSingleQuote("a'b"), "'a'\\''b'", 'single quote escaped');

// --- 安装命令：两步（dpkg，失败再补依赖重试） --------------------------------
const cmd = buildDebInstallCommand('/home/u/.cache/x/dieyunagent_0.1.72_amd64.deb');
assert(cmd.includes('/usr/bin/pkexec --disable-internal-agent dpkg -i'), 'pkexec dpkg');
assert(cmd.includes("'/home/u/.cache/x/dieyunagent_0.1.72_amd64.deb'"), 'deb quoted');
assert(cmd.includes('apt-get install -f -y'), 'dependency repair fallback');
assert.strictEqual(cmd.split('||').length, 2, 'exactly two attempts');
const customPkexec = buildDebInstallCommand('/d.deb', { pkexec: '/x/pkexec' });
assert(customPkexec.startsWith('/x/pkexec '), 'pkexec override');

// --- systemd-run 参数：--wait 才有退出码，--collect 避免同名单元占位 ----------
const args = buildSystemdRunArgs({ unit: 'dieyunagent-deb-install', command: 'echo hi' });
assert(args.includes('--user'), '--user');
assert(args.includes('--wait'), '--wait (exit code)');
assert(args.includes('--pipe'), '--pipe (capture stderr)');
assert(args.includes('--collect'), '--collect');
assert(args.includes('--unit=dieyunagent-deb-install'), 'unit name');
const sep = args.indexOf('--');
assert(sep === 5, 'options before --');
assert.deepStrictEqual(args.slice(sep + 1), ['/bin/bash', '-c', 'echo hi'], 'exec form');

// --- systemd 用户实例可用性判定 ----------------------------------------------
const fsAll = () => true;
assert.strictEqual(
  resolveSystemdRun({ env: { XDG_RUNTIME_DIR: '/run/user/1000' }, fileExists: fsAll, platform: 'linux' }),
  '/usr/bin/systemd-run',
  'available'
);
assert.strictEqual(
  resolveSystemdRun({ env: {}, fileExists: fsAll, platform: 'linux' }),
  null,
  'no XDG_RUNTIME_DIR -> unavailable'
);
assert.strictEqual(
  resolveSystemdRun({
    env: { XDG_RUNTIME_DIR: '/run/user/1000' },
    fileExists: (p) => !p.endsWith('/systemd/private'),
    platform: 'linux'
  }),
  null,
  'no user bus -> unavailable'
);
assert.strictEqual(
  resolveSystemdRun({ env: { XDG_RUNTIME_DIR: '/run/user/1000' }, fileExists: fsAll, platform: 'win32' }),
  null,
  'non-linux -> unavailable'
);

// --- 手动安装命令是最后出口 --------------------------------------------------
assert.strictEqual(
  manualInstallCommand('/a b/x.deb'),
  "sudo dpkg -i '/a b/x.deb'",
  'manual command'
);

// --- 安装执行：把退出码/stderr 如实带出来 ------------------------------------
// 注入的 `run` 是异步的（实现里用 spawn 而非 spawnSync：提权要等 polkit 密码窗，
// 同步等会把主进程冻结）。测试因此整体包在 async main 里。
async function main() {
  const okRun = await installDebInCleanTree({
    debPath: '/d.deb',
    systemdRunPath: '/usr/bin/systemd-run',
    run: async () => ({ status: 0, stderr: '' })
  });
  assert.strictEqual(okRun.ok, true, 'exit 0 -> ok');
  assert.strictEqual(okRun.exitCode, 0, 'exit code kept');

  const failRun = await installDebInCleanTree({
    debPath: '/d.deb',
    systemdRunPath: '/usr/bin/systemd-run',
    run: async () => ({ status: 127, stderr: 'pkexec must be setuid root' })
  });
  assert.strictEqual(failRun.ok, false, 'exit 127 -> not ok');
  assert.strictEqual(failRun.exitCode, 127, 'exit code kept on failure');
  assert(failRun.stderr.includes('pkexec must be setuid root'), 'stderr passes through');

  let timeoutSeen = null;
  await installDebInCleanTree({
    debPath: '/d.deb',
    systemdRunPath: '/usr/bin/systemd-run',
    timeoutMs: 1234,
    run: async (_cmd, _args, opts) => {
      timeoutSeen = opts;
      return { status: 0, stderr: '' };
    }
  });
  assert.strictEqual(timeoutSeen.timeoutMs, 1234, '超时预算透传给执行器（默认 5 分钟太长会一直挂）');

  const noSystemd = await installDebInCleanTree({
    debPath: '/d.deb',
    systemdRunPath: null,
    run: async () => {
      throw new Error('run must not be called without systemd-run');
    }
  });
  assert.strictEqual(noSystemd.ok, false, 'no systemd -> not ok');
  assert(/systemd/.test(noSystemd.error || ''), 'reason mentions systemd');

  // --- 重启：也是干净进程树，且必须等旧实例退出（单实例锁） --------------------
  let relaunchArgv = null;
  const relaunch = await relaunchInCleanTree({
    exePath: '/opt/叠云 Agent/dieyunagent',
    delaySec: 3,
    systemdRunPath: '/usr/bin/systemd-run',
    unit: 'dieyunagent-relaunch-test',
    run: async (_cmd, argv) => {
      relaunchArgv = argv;
      return { status: 0 };
    }
  });
  assert.strictEqual(relaunch.ok, true, 'relaunch ok');
  assert.deepStrictEqual(
    relaunchArgv,
    [
      '--user',
      '--collect',
      '--unit=dieyunagent-relaunch-test',
      '--',
      '/bin/bash',
      '-c',
      "sleep 3; exec '/opt/叠云 Agent/dieyunagent'"
    ],
    'relaunch argv (delayed, so the singleton lock is free)'
  );
  assert(
    !relaunch.command.includes('systemd-run --user --collect --unit=dieyunagent-relaunch-test -- /opt'),
    'relaunch goes through bash (delay), not直接 exec exe'
  );

  // 单元名默认必须带 pid/时间戳：固定成 `dieyunagent` 时，第二次更新会撞上上一次
  // 仍在 active 的那个单元（`Unit ... already exists`），表现为「更新完应用没起来」。
  let defaultUnit = null;
  await relaunchInCleanTree({
    exePath: '/x',
    systemdRunPath: '/usr/bin/systemd-run',
    run: async (_cmd, argv) => {
      defaultUnit = argv.find((a) => a.startsWith('--unit='));
      return { status: 0 };
    }
  });
  assert(
    /^--unit=dieyunagent-relaunch-\d+-\d+$/.test(defaultUnit || ''),
    `默认单元名要唯一，实际：${defaultUnit}`
  );
}

main().then(
  () => console.log('test-linux-deb-install.cjs ok'),
  (err) => {
    console.error(err && err.stack ? err.stack : err);
    process.exit(1);
  }
);
