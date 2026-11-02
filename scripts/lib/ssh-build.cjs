'use strict';

/**
 * SSH 远程构建的传输层 —— 只负责「把命令和文件送到远端」。
 *
 * 刻意不含任何业务步骤（装依赖 / 编译 / 打包都在调用方）。
 *
 * 与脚本 pack-dieyun-core-linux-remote.cjs 的关系：那个脚本自带一份历史实现
 * （已上线、有超时重试等细节），为避免改坏它，这里没有强改它来复用；
 * **新增**远程构建请一律用本文件，不要再抄第三份。
 *
 * 语义边界（重要）：本文件只做「远程构建」，不绑定工作空间——
 * 不注入 ~/.dieyun/remote-agent/、不建索引、远端目录可临时可删、
 * 也不受 src/ssh/remote-path.js 的路径白名单约束。
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const SSH_CONNECT_TIMEOUT_SEC = 60;

/** 统一执行外部命令：非 0 退出即抛错，错误信息带命令名 */
function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, {
    cwd: opts.cwd,
    input: opts.input,
    stdio: opts.input ? ['pipe', 'inherit', 'inherit'] : 'inherit',
    timeout: opts.timeoutMs,
    windowsHide: true
  });
  if (r.error) throw r.error;
  if (r.status !== 0) {
    throw new Error(`${path.basename(cmd)} 失败（exit ${r.status}）`);
  }
  return r;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function sshBaseArgs(opts) {
  const args = [
    '-o',
    `ConnectTimeout=${SSH_CONNECT_TIMEOUT_SEC}`,
    '-o',
    'BatchMode=yes',
    '-p',
    String(opts.port || 22)
  ];
  if (opts.identityFile) args.push('-i', opts.identityFile);
  args.push(opts.ssh);
  return args;
}

function scpBaseArgs(opts) {
  const args = [
    '-o',
    `ConnectTimeout=${SSH_CONNECT_TIMEOUT_SEC}`,
    '-o',
    'BatchMode=yes',
    '-P',
    String(opts.port || 22)
  ];
  if (opts.identityFile) args.push('-i', opts.identityFile);
  return args;
}

/** 在远端用 bash 执行一段脚本（脚本走 stdin，避免多层引号转义地狱） */
function sshScript(opts, script, { timeoutMs = 30 * 60 * 1000 } = {}) {
  return run('ssh', [...sshBaseArgs(opts), 'bash -s'], {
    input: script,
    timeoutMs
  });
}

/** 在远端执行单条命令并拿到 stdout（用于探测环境） */
function sshCapture(opts, script) {
  const r = spawnSync('ssh', [...sshBaseArgs(opts), 'bash -s'], {
    input: script,
    encoding: 'utf8',
    windowsHide: true
  });
  if (r.error) throw r.error;
  return { status: r.status, stdout: String(r.stdout || ''), stderr: String(r.stderr || '') };
}

function scpToRemote(opts, localPath, remotePath) {
  run('scp', [...scpBaseArgs(opts), localPath, `${opts.ssh}:${remotePath}`]);
}

function scpFromRemote(opts, remotePath, localPath) {
  run('scp', [...scpBaseArgs(opts), `${opts.ssh}:${remotePath}`, localPath]);
}

function ensureOpenSsh() {
  const probe = spawnSync(process.platform === 'win32' ? 'where' : 'command', 
    process.platform === 'win32' ? ['ssh'] : ['-v', 'ssh'],
    { stdio: 'ignore', shell: process.platform !== 'win32', windowsHide: true });
  if (probe.status !== 0) {
    throw new Error('未找到 ssh 客户端：Windows 请确认已启用「OpenSSH 客户端」功能');
  }
}

/**
 * 打包源码为单个 tgz。
 *
 * 两个坑：
 * - tar 产物必须用 cwd 内的**相对路径**：GNU tar 会把 `C:\...` 的盘符冒号当远程主机名；
 * - 必须排除 node_modules / build / dist：它们是平台相关或产物，传过去只会让远端状态变脏。
 */
function packSources(rootDir, tgzName, excludes) {
  const tmpTar = path.join(rootDir, tgzName);
  try {
    fs.unlinkSync(tmpTar);
  } catch {
    // 不存在即可
  }
  const args = ['-czf', tgzName];
  for (const p of excludes) args.push(`--exclude=${p}`);
  // 产物本身也要排除：否则 tar 会试图把正在写的包放进自己（Can't add archive to itself）
  args.push(`--exclude=${tgzName}`);
  args.push('.');
  run('tar', args, { cwd: rootDir });
  if (!fs.existsSync(tmpTar)) throw new Error('源码打包失败：' + tmpTar);
  return tmpTar;
}

module.exports = {
  SSH_CONNECT_TIMEOUT_SEC,
  run,
  shellQuote,
  sshBaseArgs,
  scpBaseArgs,
  sshScript,
  sshCapture,
  scpToRemote,
  scpFromRemote,
  ensureOpenSsh,
  packSources
};
