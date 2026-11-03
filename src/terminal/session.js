'use strict';

const fs = require('fs');
const { spawn } = require('child_process');
const os = require('os');
const path = require('path');

/**
 * 末尾「像是被切开的多字节字符」的字节数（0 = 没有被切开）。
 * 只往回看最多 4 个字节，用于跨数据块续接：管道读到的块可以切断任意一个多字节字符。
 */
function utf8IncompleteTailLen(buf) {
  for (let i = buf.length - 1; i >= 0 && buf.length - i <= 4; i--) {
    const b = buf[i];
    if ((b & 0xc0) === 0x80) continue; // 续字节，继续往前找首字节
    let need = 0;
    if ((b & 0xe0) === 0xc0) need = 2;
    else if ((b & 0xf0) === 0xe0) need = 3;
    else if ((b & 0xf8) === 0xf0) need = 4;
    else return 0; // ASCII / 非法首字节：没有半截
    const have = buf.length - i;
    return have < need ? have : 0;
  }
  return 0;
}

/**
 * GBK（控制台码页）版本：末字节是前导字节但身后没有配对字节 → 被切开了，返回 1。
 * 前导字节 0x81–0xFE；若倒数第二字节也是前导字节，说明这一对是完整的。
 * 只在 UTF-8 严格解码失败后才会被问到（那时流已经是 GBK 或二进制），不会误伤 UTF-8 流。
 */
function gbkIncompleteTailLen(buf) {
  const n = buf.length;
  if (!n) return 0;
  const last = buf[n - 1];
  if (last < 0x81 || last > 0xfe) return 0;
  if (n >= 2) {
    const prev = buf[n - 2];
    if (prev >= 0x81 && prev <= 0xfe) return 0;
  }
  return 1;
}

/**
 * 输出解码器（每条管道一个）：UTF-8 优先、GBK 回落，并跨块续接被切开的字符。
 *
 * - UTF-8 优先：Windows 上 cmd.exe 的输出不总是同一个码页 —— 控制台走 OEM（936/GBK），
 *   但 Win11 的 `sudo` 提示这类字符串是按 UTF-8 直接写出来的（实测
 *   `cmd /d /s /c "sudo --help"` 原始字节就是 UTF-8）。写死 GBK 会把这类输出整行变成乱码
 *   （「已在此计算机上禁用 Sudo」→「宸插湪姝よ绠楁満涓婄鐢�」）。
 * - 跨块续接：管道读到的块能切断任意一个多字节字符，旧实现每块新建解码器 → 直接解成 U+FFFD。
 *
 * 一旦按 GBK 起了头，后续块必须继续按 GBK 收尾：否则 UTF-8 会把配对的尾字节抢去拼成别的字。
 */
function createOutputStreamDecoder() {
  /** 上一块末尾留下的半截字符 */
  let carry = Buffer.alloc(0);
  /** carry 是按 GBK 留的吗（决定下一块走哪条路） */
  let carryIsGbk = false;
  let utf8 = new TextDecoder('utf-8', { fatal: true });

  function decodeGbk(bytes) {
    return new TextDecoder('gbk').decode(bytes);
  }

  return function decode(buf) {
    if (!buf || !buf.length) return '';
    const all = carry.length ? Buffer.concat([carry, buf]) : buf;
    carry = Buffer.alloc(0);

    if (carryIsGbk) {
      const tail = gbkIncompleteTailLen(all);
      if (tail) carry = Buffer.from(all.subarray(all.length - tail));
      carryIsGbk = tail > 0;
      return decodeGbk(tail ? all.subarray(0, all.length - tail) : all);
    }

    const tail = utf8IncompleteTailLen(all);
    const head = tail ? all.subarray(0, all.length - tail) : all;
    try {
      const text = utf8.decode(head);
      if (tail) carry = Buffer.from(all.subarray(all.length - tail));
      return text;
    } catch {
      // 严格 UTF-8 解不开：整块按 OEM 码页收（含上面留的 tail，交给下面的配对规则重算）
      utf8 = new TextDecoder('utf-8', { fatal: true });
      const tailGbk = gbkIncompleteTailLen(all);
      if (tailGbk) carry = Buffer.from(all.subarray(all.length - tailGbk));
      carryIsGbk = tailGbk > 0;
      return decodeGbk(tailGbk ? all.subarray(0, all.length - tailGbk) : all);
    }
  };
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

  // 非 Windows 一律 UTF-8；Windows 走「UTF-8 严格优先 → GBK 回落」的自适应解码
  const makeDecoder = () =>
    isWin ? createOutputStreamDecoder() : (buf) => buf.toString('utf8');
  const decodeStdout = makeDecoder();
  const decodeStderr = makeDecoder();

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

  // 每条管道各一个解码器：stdout / stderr 的半截多字节字符不能互相续接
  proc.stdout.on('data', (buf) => onData(decodeStdout(buf)));
  proc.stderr.on('data', (buf) => onData(decodeStderr(buf)));
  proc.on('exit', (code) => onExit(code));

  if (cwdFallback) {
    onData(`[工作目录不可用，已改用] ${cwd}\r\n`);
  }

  return { write, kill, pid: proc.pid, shell, cwd };
}

module.exports = {
  createTerminalSession,
  createOutputStreamDecoder
};
