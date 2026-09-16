'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.tif', '.tiff']);

/** @type {((url: string) => Promise<void>) | null} */
let shellOpenExternal = null;
try {
  const { shell } = require('electron');
  if (shell && typeof shell.openExternal === 'function') {
    shellOpenExternal = (url) => shell.openExternal(url);
  }
} catch {
  // 非 Electron 主进程时可回退到 shell 命令
}

function assertHttpUrl(url) {
  const u = String(url || '').trim();
  let parsed;
  try {
    parsed = new URL(u);
  } catch {
    const err = new Error('无效的 URL');
    err.code = 'INVALID_URL';
    throw err;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    const err = new Error('仅支持 http/https 链接');
    err.code = 'INVALID_URL';
    throw err;
  }
  return u;
}

async function openExternalUrl(url) {
  const u = assertHttpUrl(url);
  if (shellOpenExternal) {
    await shellOpenExternal(u);
    return { ok: true, url: u };
  }
  const quoted = u.replace(/"/g, '\\"');
  let cmd;
  if (process.platform === 'win32') {
    cmd = `start "" "${quoted}"`;
  } else if (process.platform === 'darwin') {
    cmd = `open "${quoted}"`;
  } else {
    cmd = `xdg-open "${quoted}"`;
  }
  const result = await runShell(cmd, { timeoutMs: 15000 });
  if (result.code !== 0 && result.stderr) {
    const err = new Error(result.stderr || `打开链接失败 (code ${result.code})`);
    err.code = 'OPEN_URL_FAILED';
    throw err;
  }
  return { ok: true, url: u };
}

/** @type {Set<import('child_process').ChildProcess>} */
const activeShellChildren = new Set();

/** 停止 Agent 时杀掉未 detached 的 host_exec 子进程；可按 sessionId 过滤避免并行串杀 */
function killActiveShellChildren(opts = {}) {
  const sid =
    opts && opts.sessionId != null && String(opts.sessionId).trim()
      ? String(opts.sessionId).trim()
      : null;
  for (const child of [...activeShellChildren]) {
    if (sid) {
      const childSid = child && child.__dieyunSessionId ? String(child.__dieyunSessionId) : '';
      if (childSid && childSid !== sid) continue;
      if (!childSid) continue;
    }
    try {
      child.__dieyunStopKill = true;
      child.kill();
    } catch {
      // ignore
    }
    activeShellChildren.delete(child);
  }
}

/**
 * @param {string} command
 * @param {{ cwd?: string, timeoutMs?: number, maxBuffer?: number, signal?: AbortSignal }} opts
 */
function runShell(command, opts = {}) {
  const timeoutMs = Math.min(180000, Math.max(1000, Number(opts.timeoutMs) || 90000));
  const maxBuffer = Math.min(2 * 1024 * 1024, Math.max(4096, Number(opts.maxBuffer) || 512 * 1024));
  const cwd = opts.cwd && String(opts.cwd).trim() ? opts.cwd : os.homedir();
  const shell = process.platform === 'win32' ? process.env.ComSpec || 'cmd.exe' : '/bin/sh';
  const shellFlag = process.platform === 'win32' ? '/c' : '-c';
  const signal = opts.signal || null;

  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      const err = new Error('已停止');
      err.name = 'AbortError';
      reject(err);
      return;
    }

    const child = spawn(shell, [shellFlag, String(command)], {
      cwd,
      windowsHide: true,
      env: process.env
    });
    if (opts.sessionId != null && String(opts.sessionId).trim()) {
      child.__dieyunSessionId = String(opts.sessionId).trim();
    }
    activeShellChildren.add(child);

    let stdout = '';
    let stderr = '';
    let settled = false;
    let killed = false;
    let abortReason = false;

    const cleanupSignal = () => {
      if (signal && typeof signal.removeEventListener === 'function') {
        signal.removeEventListener('abort', onAbort);
      }
    };

    const settleReject = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanupSignal();
      activeShellChildren.delete(child);
      reject(err);
    };

    const settleResolve = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanupSignal();
      activeShellChildren.delete(child);
      resolve(value);
    };

    const killChild = () => {
      killed = true;
      try {
        child.kill();
      } catch {
        // ignore
      }
    };

    const onAbort = () => {
      abortReason = true;
      killChild();
    };

    const timer = setTimeout(() => {
      if (settled) return;
      killChild();
      if (abortReason) {
        const e = new Error('已停止');
        e.name = 'AbortError';
        settleReject(e);
        return;
      }
      settleReject(new Error(`命令超时（${timeoutMs}ms）`));
    }, timeoutMs);

    if (signal && typeof signal.addEventListener === 'function') {
      signal.addEventListener('abort', onAbort, { once: true });
    }

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
      if (stdout.length > maxBuffer) stdout = stdout.slice(0, maxBuffer) + '\n…(截断)';
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > maxBuffer) stderr = stderr.slice(0, maxBuffer) + '\n…(截断)';
    });

    child.on('error', (err) => {
      if (abortReason) {
        const e = new Error('已停止');
        e.name = 'AbortError';
        settleReject(e);
        return;
      }
      if (!killed) settleReject(err);
      else {
        // 外部 kill（停止 Agent）未走 signal 时，按停止处理
        const e = new Error('已停止');
        e.name = 'AbortError';
        settleReject(e);
      }
    });

    child.on('close', (code) => {
      if (abortReason || child.__dieyunStopKill || (killed && !settled)) {
        const e = new Error('已停止');
        e.name = 'AbortError';
        settleReject(e);
        return;
      }
      if (killed) return;
      settleResolve({
        code: code == null ? -1 : code,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        cwd
      });
    });
  });
}

const SHELL_METACHAR_RE = /[|&;<>^`%\r\n]/;

/** 解析简单「可执行文件 + 参数」命令（无 shell 元字符） */
function parseSimpleCommand(command) {
  const trimmed = String(command || '').trim();
  if (!trimmed || SHELL_METACHAR_RE.test(trimmed)) return null;
  const m = trimmed.match(/^("([^"]+)"|'([^']+)'|(\S+))(?:\s+(.*))?$/);
  if (!m) return null;
  const exe = m[2] || m[3] || m[4];
  const rest = (m[5] || '').trim();
  const args = [];
  if (rest) {
    const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
    let hit;
    while ((hit = re.exec(rest))) {
      args.push(hit[1] ?? hit[2] ?? hit[3]);
    }
  }
  return { exe, args };
}

function psSingleQuote(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

/**
 * 后台启动进程（GUI / 长期运行），不阻塞 host_exec。
 * @param {string} command
 * @param {{ cwd?: string }} opts
 */
function runShellDetached(command, opts = {}) {
  const cwd = opts.cwd && String(opts.cwd).trim() ? opts.cwd : os.homedir();
  const cmd = String(command || '').trim();
  if (!cmd) {
    return Promise.reject(new Error('command 为空'));
  }

  if (process.platform === 'win32') {
    const simple = parseSimpleCommand(cmd);
    if (simple) {
      return new Promise((resolve, reject) => {
        const child = spawn(simple.exe, simple.args, {
          cwd,
          detached: true,
          stdio: 'ignore',
          windowsHide: true,
          shell: false
        });
        child.on('error', reject);
        child.unref();
        resolve({
          code: 0,
          stdout: `已后台启动 PID ${child.pid}`,
          stderr: '',
          cwd,
          detached: true,
          pid: child.pid
        });
      });
    }
    const ps = [
      'powershell.exe',
      '-NoProfile',
      '-Command',
      `$p = Start-Process -FilePath 'cmd.exe' -ArgumentList '/c',${psSingleQuote(cmd)} -WorkingDirectory ${psSingleQuote(cwd)} -WindowStyle Hidden -PassThru; if ($p) { $p.Id }`
    ];
    return new Promise((resolve, reject) => {
      const child = spawn(ps[0], ps.slice(1), { cwd, windowsHide: true });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => {
        stdout += chunk.toString();
      });
      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
      });
      child.on('error', reject);
      child.on('close', (code) => {
        const pid = parseInt(String(stdout).trim(), 10);
        if (code !== 0 && !Number.isFinite(pid)) {
          reject(new Error(stderr.trim() || `detached 启动失败 (code ${code})`));
          return;
        }
        resolve({
          code: 0,
          stdout: Number.isFinite(pid) ? `已后台启动 PID ${pid}` : '已后台启动',
          stderr: stderr.trim(),
          cwd,
          detached: true,
          pid: Number.isFinite(pid) ? pid : undefined
        });
      });
    });
  }

  const simple = parseSimpleCommand(cmd);
  if (simple) {
    return new Promise((resolve, reject) => {
      const child = spawn(simple.exe, simple.args, {
        cwd,
        detached: true,
        stdio: 'ignore',
        shell: false
      });
      child.on('error', reject);
      child.unref();
      resolve({
        code: 0,
        stdout: `已后台启动 PID ${child.pid}`,
        stderr: '',
        cwd,
        detached: true,
        pid: child.pid
      });
    });
  }

  return runShell(`nohup ${cmd} >/dev/null 2>&1 & echo $!`, { cwd, timeoutMs: 15000 }).then((r) => {
    const pid = parseInt(String(r.stdout || '').trim(), 10);
    return {
      code: 0,
      stdout: Number.isFinite(pid) ? `已后台启动 PID ${pid}` : '已后台启动',
      stderr: r.stderr || '',
      cwd,
      detached: true,
      pid: Number.isFinite(pid) ? pid : undefined
    };
  });
}

/**
 * 规范化模型传入的路径，避免 dir + "绝对路径" 拼接错误。
 * @param {string} filePath
 * @param {string | null | undefined} defaultCwd
 */
function normalizeFilePathInput(filePath, defaultCwd) {
  let p = String(filePath || '').trim();
  if (!p) {
    const err = new Error('filePath 必填');
    err.code = 'INVALID_PATH';
    throw err;
  }
  // 若误传了拼接路径，提取最后一个像 Windows 绝对路径的片段
  const absMatches = p.match(/[A-Za-z]:[\\/][^"']+/g);
  if (absMatches && absMatches.length > 1) {
    p = absMatches[absMatches.length - 1].trim();
  }
  p = p.replace(/^["']+|["']+$/g, '').trim();
  if (!path.isAbsolute(p) && defaultCwd) {
    p = path.join(defaultCwd, p);
  }
  return path.resolve(p);
}

function printImageWindows(absPath) {
  const mspaint = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'mspaint.exe');
  if (fs.existsSync(mspaint)) {
    return new Promise((resolve, reject) => {
      const child = spawn(mspaint, ['/p', absPath], {
        windowsHide: true,
        detached: true,
        stdio: 'ignore'
      });
      child.on('error', reject);
      child.unref();
      setTimeout(() => resolve({ ok: true, path: absPath, method: 'mspaint' }), 600);
    });
  }

  return new Promise((resolve, reject) => {
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-Command', `Start-Process -LiteralPath ${JSON.stringify(absPath)} -Verb Print`],
      { windowsHide: true }
    );
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0 || code === null) {
        resolve({ ok: true, path: absPath, method: 'powershell-print' });
        return;
      }
      const err = new Error(stderr.trim() || `打印失败 (code ${code})`);
      err.code = 'PRINT_FAILED';
      reject(err);
    });
  });
}

/**
 * @param {string} absPath 已校验的绝对路径
 */
async function printImage(absPath) {
  const ext = path.extname(absPath).toLowerCase();
  if (!IMAGE_EXTENSIONS.has(ext)) {
    const err = new Error(`不支持的图片格式「${ext || '(无扩展名)'}」，支持 jpg/png/gif/bmp/webp/tif`);
    err.code = 'UNSUPPORTED_FORMAT';
    throw err;
  }
  if (!fs.existsSync(absPath)) {
    const err = new Error(`文件不存在: ${absPath}`);
    err.code = 'FILE_NOT_FOUND';
    throw err;
  }
  if (process.platform === 'win32') {
    return printImageWindows(absPath);
  }
  if (process.platform === 'darwin') {
    return runShell(`lpr ${JSON.stringify(absPath)}`, { timeoutMs: 30000 });
  }
  return runShell(`lp ${JSON.stringify(absPath)}`, { timeoutMs: 30000 });
}

module.exports = {
  runShell,
  runShellDetached,
  killActiveShellChildren,
  openExternalUrl,
  normalizeFilePathInput,
  printImage
};
