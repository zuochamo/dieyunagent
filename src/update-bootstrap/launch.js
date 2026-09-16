'use strict';

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { buildInstallRunnerScript } = require('./install-runner-script');

const PROGRESS_FILE = path.join(os.tmpdir(), 'dieyun-update-progress.json');
const LOG_FILE = path.join(os.tmpdir(), 'dieyun-update-launch.log');

function vbsQuote(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

function writeLaunchLog(message) {
  try {
    fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${message}\n`, 'utf8');
  } catch {
    // ignore
  }
}

/**
 * 下载完成后启动 NSIS 安装向导：先弹出 WinForms 进度窗，再等待主进程退出并拉起 NSIS。
 *
 * @param {{ installerPath: string, version?: string, fromVersion?: string, installDir?: string }} opts
 */
function launchUpdateBootstrap(opts) {
  const installerPath = opts && opts.installerPath ? String(opts.installerPath) : '';
  if (!installerPath || !fs.existsSync(installerPath)) {
    throw new Error('安装包不存在');
  }

  const parentPid = process.pid;
  const targetExeName = path.basename(process.execPath);
  const stamp = `${Date.now()}-${parentPid}`;
  const psPath = path.join(os.tmpdir(), `dieyun-guided-update-${stamp}.ps1`);
  const vbsPath = path.join(os.tmpdir(), `dieyun-guided-update-${stamp}.vbs`);

  try {
    const utf8Payload = JSON.stringify({ percent: 4, message: '正在启动安装程序…' });
    fs.writeFileSync(PROGRESS_FILE, `\ufeff${utf8Payload}`, 'utf8');
  } catch {
    // ignore
  }

  const psScript = buildInstallRunnerScript({
    installerPath,
    progressFile: PROGRESS_FILE,
    bootstrapPid: parentPid,
    targetExeName,
    targetVersion: opts.version || '',
    fromVersion: opts.fromVersion || ''
  });

  fs.writeFileSync(psPath, `\ufeff${psScript}`, 'utf8');
  const psCommand = `powershell.exe -NoProfile -ExecutionPolicy Bypass -Sta -WindowStyle Hidden -File "${psPath}"`;
  const vbsScript = [
    'Set shell = CreateObject("WScript.Shell")',
    `shell.Run ${vbsQuote(psCommand)}, 0, False`,
    ''
  ].join('\r\n');
  fs.writeFileSync(vbsPath, vbsScript, 'utf8');

  writeLaunchLog(`guided update prepared installer=${installerPath}`);
  writeLaunchLog(`guided update scripts ps=${psPath} vbs=${vbsPath}`);

  const child = spawn('explorer.exe', [vbsPath], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    cwd: os.tmpdir()
  });
  child.unref();
  writeLaunchLog(`guided update launched WinForms runner pid=${child.pid || 'unknown'}`);

  return PROGRESS_FILE;
}

module.exports = { launchUpdateBootstrap, PROGRESS_FILE };
