'use strict';

/**
 * Linux（deb）自动更新的**安装执行**。
 *
 * 为什么不用 electron-updater 的 DebUpdater：它是在**本进程**里 `pkexec` 提权（
 * electron-updater/out/DebUpdater.js → LinuxUpdater.runCommandWithSudoIfNeeded）。
 * Linux 的 `NoNewPrivs` 一旦被设为 1，内核就不再认 setuid 位 → pkexec 退出码 127、
 * 只打一行 `pkexec must be setuid root`，`sudo` 同样失效。而 NNP 是线程级、**只能设
 * 不能撤**，子进程还会继承。
 *
 * 实测（dieyun17 / Ubuntu 26.04）：更新安装成功后 electron-updater 用
 * `isForceRunAfter` 自重启回来的那一份实例，整个进程树带 `NoNewPrivs: 1`，
 * 于是之后每一次自动安装都是 127，日志停在「更新安装包已下载，跳过本次检查」。
 * 同一台机器上新起的实例则是 `NoNewPrivs: 0`、pkexec 正常。
 *
 * 根因在进程属性上，无法在进程内消除（不能撤销 NNP），所以只能**换一棵干净的进程树
 * 去提权**：让 systemd 用户实例（`systemd-run --user`，其 fork 出的进程 NNP=0）
 * 执行 `pkexec → dpkg`。这也是本仓库唯一既有的「另起进程树」机制，不引入常驻服务、
 * 不引入新的凭据通道。
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const PROC_SELF_STATUS = '/proc/self/status';
const PKEXEC = '/usr/bin/pkexec';
const SYSTEMD_RUN_CANDIDATES = ['/usr/bin/systemd-run', '/bin/systemd-run', '/usr/local/bin/systemd-run'];
const BASH = '/bin/bash';

/**
 * 单元名的默认值：**必须带 pid + 时间戳**。
 *
 * `systemd-run --user --collect --unit=X` 的 X 在单元活着的期间是独占的；重启应用用的
 * 那个单元名以前固定成 `dieyunagent`，于是「上一次更新拉起来的应用」自己就占着它，
 * 下一次更新再拉就必然 `Unit ... already exists` 失败（表现为「装完 → 退出 → 没起来」）。
 * @param {string} prefix
 */
function defaultUnitName(prefix) {
  return `${prefix}-${process.pid}-${Date.now()}`;
}

/**
 * 跑一个外部命令并等它结束。**用异步 spawn，不用 spawnSync**：
 * 提权期间 polkit 会弹密码窗（等人输入，可达数十秒到几分钟），同步等待会把主进程
 * ——连同窗口、IPC、后台任务——整个冻住。
 *
 * @param {string} cmd
 * @param {string[]} args
 * @param {{ timeoutMs?: number }} [opts]
 * @returns {Promise<{ status: number|null, stderr: string, error?: Error }>}
 */
function runCommand(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const timeoutMs = Number(opts.timeoutMs) || 0;
    let stderr = '';
    let settled = false;
    let timer = null;
    const finish = (res) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(res);
    };
    let child;
    try {
      child = spawn(cmd, args, { windowsHide: true });
    } catch (err) {
      finish({ status: null, stderr: '', error: err });
      return;
    }
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          // ignore
        }
        finish({ status: null, stderr, error: new Error(`命令超时（${timeoutMs}ms）`) });
      }, timeoutMs);
      if (timer && typeof timer.unref === 'function') timer.unref();
    }
    // 只留尾巴：失败原因总在最后几行，无限增长会把内存拖爆。
    // stdout 也要收：`systemd-run --pipe` 把单元输出接到自己的 stdout，dpkg 的错误常落在那儿，
    // 只收 stderr 会出现「安装失败，原因空着」。
    const collect = (chunk) => {
      stderr += String(chunk);
      if (stderr.length > 20000) stderr = stderr.slice(-20000);
    };
    child.stderr.on('data', collect);
    child.stdout.on('data', collect);
    child.on('error', (err) => finish({ status: null, stderr, error: err }));
    child.on('close', (code) => finish({ status: typeof code === 'number' ? code : null, stderr }));
  });
}

/**
 * 从 /proc/<pid>/status 的文本里取 `NoNewPrivs`（0/1）。取不到返回 null。
 * @param {string} statusText
 * @returns {number|null}
 */
function readNoNewPrivs(statusText) {
  const m = /^NoNewPrivs:\s*(\d+)\s*$/m.exec(String(statusText || ''));
  return m ? Number(m[1]) : null;
}

/**
 * 本进程当前的 NoNewPrivs（非 Linux 或读不到时为 null）。
 * @returns {number|null}
 */
function getSelfNoNewPrivs() {
  if (process.platform !== 'linux') return null;
  try {
    return readNoNewPrivs(fs.readFileSync(PROC_SELF_STATUS, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * POSIX shell 单引号包裹（`'` 用 `'\''` 转义）。路径里带空格/中文（`/opt/叠云 Agent/`）是常态。
 * @param {string} value
 * @returns {string}
 */
function shellSingleQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

/**
 * 提权安装命令：先 `dpkg -i`，失败再补依赖后重试。
 * @param {string} debPath
 * @param {{ pkexec?: string }} [opts]
 * @returns {string}
 */
function buildDebInstallCommand(debPath, opts) {
  const pkexec = (opts && opts.pkexec) || PKEXEC;
  const deb = shellSingleQuote(debPath);
  const repairAndInstall = shellSingleQuote(`apt-get install -f -y && dpkg -i ${deb}`);
  return (
    `${pkexec} --disable-internal-agent dpkg -i ${deb} || ` +
    `${pkexec} --disable-internal-agent ${BASH} -c ${repairAndInstall}`
  );
}

/**
 * `systemd-run` 的参数：`--wait` 让它在单元结束后返回该单元的退出码，`--pipe` 把
 * stdout/stderr 接回来，`--collect` 让失败单元自动回收（否则同名单元会被占住）。
 * @param {{ unit: string, command: string }} opts
 * @returns {string[]}
 */
function buildSystemdRunArgs(opts) {
  return [
    '--user',
    '--wait',
    '--pipe',
    '--collect',
    `--unit=${opts.unit}`,
    '--',
    BASH,
    '-c',
    opts.command
  ];
}

/**
 * 找到可用的 systemd-run，并确认用户实例总线在（`$XDG_RUNTIME_DIR/systemd/private`）。
 * @param {{ env?: NodeJS.ProcessEnv, fileExists?: (p: string) => boolean, platform?: string }} [opts]
 * @returns {string|null} systemd-run 的绝对路径，不可用时 null
 */
function resolveSystemdRun(opts) {
  const env = (opts && opts.env) || process.env;
  const fileExists = (opts && opts.fileExists) || ((p) => fs.existsSync(p));
  const platform = (opts && opts.platform) || process.platform;
  if (platform !== 'linux') return null;
  const runtimeDir = String(env.XDG_RUNTIME_DIR || '').trim();
  if (!runtimeDir) return null;
  // 这些永远是 Linux 路径：用 posix 拼接，免得在别的平台上拼出反斜杠（测试会跑在 Windows）。
  if (!fileExists(path.posix.join(runtimeDir, 'systemd', 'private'))) return null;
  return SYSTEMD_RUN_CANDIDATES.find((p) => fileExists(p)) || null;
}

/**
 * 手动安装命令（安装失败时给用户的可执行出口）。
 * @param {string} debPath
 * @returns {string}
 */
function manualInstallCommand(debPath) {
  return `sudo dpkg -i ${shellSingleQuote(debPath)}`;
}

/**
 * 在干净进程树里安装 deb，并等它结束（异步：不阻塞主进程）。
 *
 * @param {{
 *   debPath: string,
 *   unit?: string,
 *   systemdRunPath?: string,
 *   run?: (cmd: string, args: string[], opts?: object) => Promise<{ status: number|null, stderr: string, error?: Error }>,
 *   timeoutMs?: number
 * }} opts
 * @returns {Promise<{ ok: boolean, exitCode: number|null, stderr: string, command: string, error?: string }>}
 */
async function installDebInCleanTree(opts) {
  const debPath = opts.debPath;
  const command = buildDebInstallCommand(debPath);
  const systemdRunPath = opts.systemdRunPath || resolveSystemdRun();
  const run = opts.run || runCommand;
  if (!systemdRunPath) {
    return {
      ok: false,
      exitCode: null,
      stderr: '',
      command,
      error: '没有可用的 systemd 用户实例（systemd-run）'
    };
  }
  const args = buildSystemdRunArgs({
    unit: opts.unit || defaultUnitName('dieyunagent-deb-install'),
    command
  });
  const res =
    (await run(systemdRunPath, args, {
      // 期间 polkit 会弹密码窗，等人输入；超时上限只是防止无人值守时一直挂着
      timeoutMs: Number(opts.timeoutMs) || 5 * 60 * 1000
    })) || {};
  const exitCode = typeof res.status === 'number' ? res.status : null;
  // 尾巴 2000 字符够看清原因，也不至于让 UI 里那条失败提示变成一屏 dpkg 日志
  const stderr = String(res.stderr || '').trim().slice(-2000);
  return {
    ok: exitCode === 0,
    exitCode,
    stderr,
    command,
    error: res.error ? String(res.error.message || res.error) : undefined
  };
}

/**
 * 装完之后用干净进程树把应用重新拉起来（不要让被污染的树再拉起它）。
 *
 * `delaySec` 不是保守：旧实例还持有 Electron 单实例锁，立刻拉起的新实例抢不到锁会直接
 * 退出——那样「安装成功」反而把应用关没了。所以让单元先等一下，等我们退出后再 exec。
 *
 * 单元名默认带 pid + 时间戳（见 `defaultUnitName`）：固定名字会在第二次更新时撞上
 * 上一次那个仍在 active 的单元。
 *
 * @param {{
 *   exePath: string,
 *   unit?: string,
 *   delaySec?: number,
 *   systemdRunPath?: string,
 *   run?: (cmd: string, args: string[], opts?: object) => Promise<{ status: number|null, stderr: string, error?: Error }>
 * }} opts
 * @returns {Promise<{ ok: boolean, command: string }>}
 */
async function relaunchInCleanTree(opts) {
  const systemdRunPath = opts.systemdRunPath || resolveSystemdRun();
  const run = opts.run || runCommand;
  const unit = opts.unit || defaultUnitName('dieyunagent-relaunch');
  const delaySec = Number.isFinite(opts.delaySec) ? Math.max(0, Number(opts.delaySec)) : 3;
  const script = `sleep ${delaySec}; exec ${shellSingleQuote(opts.exePath)}`;
  const argv = ['--user', '--collect', `--unit=${unit}`, '--', BASH, '-c', script];
  const command = [systemdRunPath || 'systemd-run', ...argv].join(' ');
  if (!systemdRunPath) return { ok: false, command };
  const res = (await run(systemdRunPath, argv, { timeoutMs: 20000 })) || {};
  return { ok: res.status === 0, command };
}

module.exports = {
  readNoNewPrivs,
  getSelfNoNewPrivs,
  shellSingleQuote,
  buildDebInstallCommand,
  buildSystemdRunArgs,
  resolveSystemdRun,
  manualInstallCommand,
  installDebInCleanTree,
  relaunchInCleanTree
};
