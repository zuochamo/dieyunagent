'use strict';

const os = require('os');
const { spawn } = require('child_process');
const { buildSshUri } = require('../workspace/target');

const PLATFORM_LABELS = {
  win32: 'Windows',
  linux: 'Linux',
  darwin: 'macOS'
};

async function probeLocalPowerShell(cwd) {
  return new Promise((resolve) => {
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.ToString()'],
      { cwd: cwd || os.homedir(), windowsHide: true }
    );
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // ignore
      }
      resolve({ ok: false, error: 'PowerShell 探测超时', line: '' });
    }, 12000);
    child.stdout.on('data', (d) => {
      stdout += d.toString();
    });
    child.stderr.on('data', (d) => {
      stderr += d.toString();
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ ok: false, error: err.message || String(err), line: '' });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const line = stdout.trim().split(/\r?\n/)[0] || '';
      resolve({
        ok: code === 0 && !!line,
        version: line,
        error: code === 0 ? '' : (stderr || stdout || `exit ${code}`).trim().slice(0, 120),
        line
      });
    });
  });
}

async function runProbe(exec, command, timeoutMs = 8000) {
  if (!exec) return { ok: false, error: 'exec 不可用', line: '' };
  try {
    const r = await exec(command, timeoutMs);
    const code = r.code != null ? r.code : r.exitCode;
    const stdout = String(r.stdout || '').trim();
    const stderr = String(r.stderr || '').trim();
    const ok = code === 0;
    const firstLine = (ok ? stdout : stderr || stdout).split(/\r?\n/).find((l) => l.trim()) || '';
    return { ok, code, stdout, stderr, line: firstLine.trim() };
  } catch (err) {
    return { ok: false, error: err.message || String(err), line: '' };
  }
}

function hostExecShellHints(effectivePlatform, workspaceKind, powershellOk) {
  const lines = [];
  if (workspaceKind === 'ssh') {
    lines.push('远端命令经 SSH 执行（默认 `bash -lc` 包装）；路径用 Linux/Unix 风格。');
    lines.push('用 `cwd` 指定子目录，勿写 `cd foo &&` 链。');
    lines.push('改已有文件用 fs_edit，新建用 fs_write_file；远端没有 apply_patch 命令。同一文件多处不相交改动用一次 fs_edit 的 edits[]，均对原文件匹配。');
    return lines;
  }
  if (effectivePlatform === 'win32') {
    lines.push('`host_exec` 默认 **cmd.exe**（不是 PowerShell）。');
    lines.push('`python -c "a; b"` 会因分号被 cmd 截断 → 请写临时 `.py` 再执行。');
    lines.push('GUI / 长期进程：`host_exec(command=pythonw main.py, cwd=子目录, detached=true)`。');
    if (powershellOk) {
      lines.push('复杂单行可用 `powershell -NoProfile -Command "..."`。');
    }
    return lines;
  }
  lines.push('`host_exec` 使用 `/bin/sh -c`。');
  lines.push('后台进程优先 `detached=true`。');
  return lines;
}

function inferRemotePlatform(unameLine) {
  const u = String(unameLine || '').toLowerCase();
  if (u.includes('darwin')) return 'darwin';
  if (u.includes('windows') || u.includes('mingw') || u.includes('msys')) return 'win32';
  return 'linux';
}

/**
 * @param {object} probe
 * @returns {string} AGENTS.md environment section body (no marker)
 */
function formatEnvironmentSectionBody(probe) {
  const lines = [
    '> 本节由叠云自动刷新（同工作空间 60 秒内不重复探测）；保留 `<!-- dieyun:section:environment -->` marker。',
    '',
    `- **操作系统**：${probe.osLabel || '未知'}${probe.osRelease ? ` (${probe.osRelease})` : ''}${probe.arch ? ` · ${probe.arch}` : ''}`,
    `- **工作空间**：${probe.workspaceLabel || '未选择'}`,
    `- **连接**：${probe.connectionLabel || '—'}`
  ];
  if (probe.shellDefault) {
    lines.push(`- **host_exec Shell**：${probe.shellDefault}`);
  }
  if (probe.remoteShell) {
    lines.push(`- **远端 Shell**：${probe.remoteShell}`);
  }
  if (probe.powershell) {
    const pw = probe.powershell;
    if (pw.skipped) {
      lines.push('- **PowerShell**：跳过（非 Windows 或未连接 SSH）');
    } else if (pw.ok) {
      lines.push(`- **PowerShell**：可用${pw.version ? ` (${pw.version})` : ''}`);
    } else {
      lines.push(`- **PowerShell**：不可用${pw.error ? ` — ${pw.error}` : ''}`);
    }
  }
  for (const t of probe.tools || []) {
    if (t.skipped) {
      lines.push(`- **${t.name}**：未探测（${t.reason || 'SSH 未连接'}）`);
    } else {
      lines.push(`- **${t.name}**：${t.ok ? t.line || '可用' : t.line || '未检测到'}`);
    }
  }
  const hints = probe.hostExecHints || [];
  if (hints.length) {
    lines.push('', '**host_exec 提示**', ...hints.map((h) => `- ${h}`));
  }
  lines.push('', `_探测时间：${probe.probedAt || new Date().toISOString()}_`);
  return lines.join('\n');
}

/**
 * @param {object} opts
 * @param {string} opts.platform
 * @param {string} [opts.arch]
 * @param {import('../workspace/target').WorkspaceTarget | null} [opts.workspaceTarget]
 * @param {boolean} [opts.sshConnected]
 * @param {string | null} [opts.defaultCwd]
 * @param {(command: string, timeoutMs?: number) => Promise<{code?: number, stdout?: string, stderr?: string}>} [opts.runLocalShell]
 * @param {(command: string, timeoutMs?: number) => Promise<{code?: number, stdout?: string, stderr?: string}>} [opts.runRemoteShell]
 */
async function probeHostEnvironment(opts = {}) {
  const platform = opts.platform || process.platform;
  const arch = opts.arch || process.arch;
  const workspaceTarget = opts.workspaceTarget || null;
  const sshConnected = !!opts.sshConnected;
  const defaultCwd = opts.defaultCwd || null;
  const isSsh = workspaceTarget && workspaceTarget.kind === 'ssh';

  let workspaceLabel = defaultCwd || '未选择工作空间';
  let connectionLabel = '本地工作空间';
  if (isSsh) {
    workspaceLabel =
      buildSshUri(workspaceTarget) ||
      `${workspaceTarget.username}@${workspaceTarget.host}:${workspaceTarget.remotePath}`;
    connectionLabel = sshConnected
      ? `SSH 已连接 · ${workspaceTarget.username}@${workspaceTarget.host}`
      : 'SSH 未连接（请先在工作空间菜单重连；文件/命令可能失败）';
  }

  const shellDefault =
    platform === 'win32' ? process.env.ComSpec || 'cmd.exe' : process.env.SHELL || '/bin/sh';

  const canRemote = isSsh && sshConnected && typeof opts.runRemoteShell === 'function';
  const execLocal = typeof opts.runLocalShell === 'function' ? opts.runLocalShell : null;
  const exec = canRemote ? opts.runRemoteShell : isSsh ? null : execLocal;

  let remoteOs = '';
  let remoteShell = null;
  let effectivePlatform = platform;
  if (canRemote) {
    const uname = await runProbe(exec, 'uname -s 2>/dev/null || echo Linux');
    remoteOs = uname.line || 'Linux';
    effectivePlatform = inferRemotePlatform(remoteOs);
    const shellProbe = await runProbe(exec, 'printf %s "${SHELL:-/bin/bash}"');
    remoteShell = shellProbe.line || '/bin/bash';
  }

  let powershell = null;
  if (isSsh && !sshConnected) {
    powershell = { ok: false, skipped: true, version: '', error: '' };
  } else if (effectivePlatform === 'win32' && !isSsh && execLocal) {
    const ps = await probeLocalPowerShell(defaultCwd || os.homedir());
    powershell = {
      ok: ps.ok,
      version: ps.version || ps.line || '',
      error: ps.ok ? '' : ps.error || ''
    };
  } else if (effectivePlatform === 'win32' && exec) {
    const ps = await runProbe(
      exec,
      'powershell -NoProfile -Command "Write-Output test"',
      12000
    );
    powershell = {
      ok: ps.ok,
      version: ps.ok ? '（远端 Windows）' : '',
      error: ps.ok ? '' : String(ps.error || ps.line || `exit ${ps.code}`).slice(0, 120)
    };
  } else if (canRemote) {
    const ps = await runProbe(
      exec,
      'pwsh -NoProfile -Command \'$PSVersionTable.PSVersion.ToString()\' 2>/dev/null || powershell -NoProfile -Command \'$PSVersionTable.PSVersion.ToString()\' 2>/dev/null || echo __NO_PS__',
      12000
    );
    const missing = /__NO_PS__/.test(ps.stdout || ps.line || '');
    powershell = {
      ok: ps.ok && !missing,
      version: ps.ok && !missing ? ps.line : '',
      error: missing ? '远端未安装 PowerShell/pwsh' : ps.ok ? '' : String(ps.error || ps.line).slice(0, 120)
    };
  } else {
    powershell = { ok: false, skipped: true, version: '', error: '非 Windows 工作空间' };
  }

  const toolDefs = [
    { name: 'Python', cmd: 'python --version', alt: 'python3 --version' },
    { name: 'Node.js', cmd: 'node --version', alt: null },
    { name: 'npm', cmd: 'npm --version', alt: null }
  ];
  const tools = [];
  for (const t of toolDefs) {
    if (!exec) {
      tools.push({ name: t.name, ok: false, skipped: true, reason: 'SSH 未连接', line: '' });
      continue;
    }
    let r = await runProbe(exec, t.cmd);
    if (!r.ok && t.alt) r = await runProbe(exec, t.alt);
    tools.push({ name: t.name, ok: r.ok, line: r.line || (r.error || '').slice(0, 80) });
  }

  const osLabel = canRemote && remoteOs ? remoteOs : PLATFORM_LABELS[platform] || platform;
  const osRelease = canRemote ? '' : os.release();

  const result = {
    platform,
    arch,
    effectivePlatform,
    osLabel,
    osRelease,
    workspaceKind: isSsh ? 'ssh' : 'local',
    sshConnected,
    workspaceLabel,
    connectionLabel,
    shellDefault: isSsh ? null : shellDefault,
    remoteShell,
    powershell,
    tools,
    hostExecHints: hostExecShellHints(effectivePlatform, isSsh ? 'ssh' : 'local', !!(powershell && powershell.ok)),
    probedAt: new Date().toISOString()
  };
  result.markdown = formatEnvironmentSectionBody(result);
  return result;
}

module.exports = {
  probeHostEnvironment,
  formatEnvironmentSectionBody,
  PLATFORM_LABELS
};
