'use strict';

const fs = require('fs');
const { spawn } = require('child_process');
const os = require('os');
const path = require('path');

function decodeTerminalBuffer(buf) {
  if (!buf || !buf.length) return '';
  if (process.platform !== 'win32') return buf.toString('utf8');
  try {
    return new TextDecoder('gbk').decode(buf);
  } catch {
    return buf.toString('utf8');
  }
}

function pathExists(dir) {
  if (!dir) return false;
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

function resolveSafeCwd(requested) {
  const candidates = [];
  if (requested && String(requested).trim()) {
    try {
      candidates.push(path.resolve(String(requested).trim()));
    } catch {
      // ignore invalid path
    }
  }
  candidates.push(os.homedir(), process.cwd());
  for (const dir of candidates) {
    if (pathExists(dir)) return dir;
  }
  return os.homedir();
}

function resolveWindowsShell() {
  const systemRoot = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows';
  const candidates = [
    process.env.COMSPEC,
    path.join(systemRoot, 'System32', 'cmd.exe'),
    path.join(systemRoot, 'Sysnative', 'cmd.exe'),
    'C:\\Windows\\System32\\cmd.exe'
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      const resolved = path.normalize(candidate);
      if (fs.existsSync(resolved)) return resolved;
    } catch {
      // try next
    }
  }
  return 'cmd.exe';
}

function buildSpawnEnv() {
  const env = { ...process.env };
  const systemRoot = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows';
  if (process.platform === 'win32') {
    if (!env.SystemRoot) env.SystemRoot = systemRoot;
    if (!env.WINDIR) env.WINDIR = systemRoot;
    if (!env.COMSPEC) env.COMSPEC = path.join(systemRoot, 'System32', 'cmd.exe');
    const system32 = path.join(systemRoot, 'System32');
    const pathKey = Object.keys(env).find((k) => k.toLowerCase() === 'path') || 'Path';
    if (!String(env[pathKey] || '').toLowerCase().includes('system32')) {
      env[pathKey] = env[pathKey] ? `${system32};${env[pathKey]}` : system32;
    }
  }
  return env;
}

/**
 * @param {{ cwd?: string, onData?: (text: string) => void, onExit?: (code: number | null) => void }} opts
 */
function createTerminalSession(opts = {}) {
  const onData = opts.onData || (() => {});
  const onExit = opts.onExit || (() => {});
  const requestedCwd = opts.cwd && String(opts.cwd).trim() ? String(opts.cwd).trim() : '';
  const cwd = resolveSafeCwd(requestedCwd);
  const cwdFallback = requestedCwd && path.resolve(requestedCwd) !== cwd;

  const isWin = process.platform === 'win32';
  const shell = isWin ? resolveWindowsShell() : process.env.SHELL || '/bin/bash';
  const args = isWin ? [] : ['-i'];

  if (!isWin && !fs.existsSync(shell)) {
    const err = new Error(`Shell 不存在: ${shell}`);
    err.code = 'ENOENT';
    throw err;
  }
  if (isWin && shell !== 'cmd.exe' && !fs.existsSync(shell)) {
    const err = new Error(`找不到 cmd.exe: ${shell}`);
    err.code = 'ENOENT';
    throw err;
  }

  const proc = spawn(shell, args, {
    cwd,
    env: buildSpawnEnv(),
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true
  });

  proc.on('error', (err) => {
    onData(`\r\n[终端启动失败] ${err.message || err}\r\n`);
    onExit(1);
  });

  const write = (data) => {
    if (proc.stdin && !proc.stdin.destroyed) {
      try {
        proc.stdin.write(String(data));
      } catch {
        // ignore
      }
    }
  };

  const kill = () => {
    try {
      proc.kill();
    } catch {
      // ignore
    }
  };

  proc.stdout.on('data', (buf) => onData(decodeTerminalBuffer(buf)));
  proc.stderr.on('data', (buf) => onData(decodeTerminalBuffer(buf)));
  proc.on('exit', (code) => onExit(code));

  if (cwdFallback) {
    onData(`[工作目录不可用，已改用] ${cwd}\r\n`);
  }

  return { write, kill, pid: proc.pid, shell, cwd };
}

module.exports = { createTerminalSession, resolveSafeCwd, resolveWindowsShell };
