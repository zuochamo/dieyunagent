'use strict';

const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn, spawnSync } = require('child_process');

function parseCliArg(prefix) {
  const hit = process.argv.find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : '';
}

const installerPath = parseCliArg('--installer=');
const targetVersion = parseCliArg('--version=');
const fromVersion = parseCliArg('--from-version=');
const installDir = parseCliArg('--install-dir=');
const parentPid = parseInt(parseCliArg('--parent-pid='), 10) || 0;
const targetExeName = parseCliArg('--target-exe-name=') || 'dieyunagent.exe';
const progressFile =
  parseCliArg('--progress-file=') || path.join(os.tmpdir(), 'dieyun-update-progress.json');
const bootstrapLogFile = path.join(os.tmpdir(), 'dieyun-update-bootstrap.log');

const { buildInstallRunnerScript } = require('./install-runner-script');

let mainWindow = null;

function logLine(message) {
  try {
    fs.appendFileSync(
      bootstrapLogFile,
      `[${new Date().toISOString()}] ${message}\n`,
      'utf8'
    );
  } catch {
    // ignore
  }
}

function pushState(state) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    mainWindow.webContents.send('update-bootstrap:state', state);
  } catch {
    // ignore
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isProcessAlive(pid) {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err && err.code === 'EPERM';
  }
}

async function waitForParentExit() {
  pushState({
    phase: 'installing',
    percent: 8,
    message: '等待应用退出…',
    version: targetVersion,
    fromVersion
  });
  if (!parentPid) {
    await sleep(1200);
    return;
  }
  for (let i = 0; i < 180; i++) {
    if (!isProcessAlive(parentPid)) return;
    await sleep(500);
  }
}

function killOtherAgentProcesses() {
  if (process.platform !== 'win32') return;
  try {
    const { execSync } = require('child_process');
    execSync(
      `taskkill /F /IM "${targetExeName}" /FI "PID ne ${process.pid}"`,
      { stdio: 'ignore' }
    );
  } catch {
    // ignore — no other instances
  }
}

function launchDetachedInstallRunner() {
  const scriptPath = path.join(os.tmpdir(), `dieyun-install-${Date.now()}.ps1`);
  const vbsPath = path.join(os.tmpdir(), `dieyun-install-${Date.now()}.vbs`);
  const taskName = `DieyunAgentUpdate-${process.pid}-${Date.now()}`;
  const script = buildInstallRunnerScript({
    installerPath,
    progressFile,
    bootstrapPid: process.pid,
    targetExeName,
    targetVersion,
    fromVersion
  });
  fs.writeFileSync(scriptPath, `\ufeff${script}`, 'utf8');
  const psCommand = `powershell.exe -NoProfile -ExecutionPolicy Bypass -Sta -WindowStyle Hidden -File "${scriptPath}"`;
  fs.writeFileSync(
    vbsPath,
    [
      'Set shell = CreateObject("WScript.Shell")',
      `shell.Run ${JSON.stringify(psCommand)}, 0, False`,
      ''
    ].join('\r\n'),
    'utf8'
  );
  logLine(`created install runner script=${scriptPath} vbs=${vbsPath}`);

  const taskTime = new Date(Date.now() + 60 * 1000);
  const hh = String(taskTime.getHours()).padStart(2, '0');
  const mm = String(taskTime.getMinutes()).padStart(2, '0');
  const tr = `wscript.exe "${vbsPath}"`;

  try {
    const explorer = spawn('explorer.exe', [vbsPath], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      cwd: os.tmpdir()
    });
    explorer.unref();
    logLine(`launched via explorer pid=${explorer.pid || 'unknown'}`);
    return;
  } catch (err) {
    logLine(`explorer launch failed: ${err && (err.message || err)}`);
  }

  try {
    const create = spawnSync(
      'schtasks.exe',
      ['/Create', '/TN', taskName, '/SC', 'ONCE', '/ST', `${hh}:${mm}`, '/TR', tr, '/F', '/IT'],
      { stdio: 'ignore', windowsHide: true, cwd: os.tmpdir(), timeout: 8000 }
    );
    if (create.status !== 0) throw new Error('schtasks create failed');
    const run = spawnSync('schtasks.exe', ['/Run', '/TN', taskName], {
      stdio: 'ignore',
      windowsHide: true,
      cwd: os.tmpdir(),
      timeout: 8000
    });
    if (run.status !== 0) throw new Error('schtasks run failed');
    logLine(`launched via schtasks task=${taskName}`);
  } catch (err) {
    logLine(`schtasks launch failed: ${err && (err.message || err)}`);
    const fallback = spawn('wscript.exe', [vbsPath], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      cwd: os.tmpdir()
    });
    fallback.unref();
    logLine(`launched via wscript fallback pid=${fallback.pid || 'unknown'}`);
  }
}

async function runInstaller() {
  await waitForParentExit();

  pushState({
    phase: 'installing',
    percent: 14,
    message: '正在确认进程已退出…',
    version: targetVersion,
    fromVersion
  });
  killOtherAgentProcesses();
  await sleep(600);

  pushState({
    phase: 'installing',
    percent: 20,
    message: '即将开始安装，本窗口将关闭…',
    version: targetVersion,
    fromVersion
  });

  try {
    const utf8Payload = JSON.stringify({ percent: 22, message: '正在启动安装程序…' });
    fs.writeFileSync(progressFile, `\ufeff${utf8Payload}`, 'utf8');
  } catch {
    // ignore
  }

  launchDetachedInstallRunner();

  // 引导进程必须退出，否则 NSIS 无法卸载安装目录中的旧文件（错误码 2）
  setTimeout(() => {
    try {
      app.quit();
    } catch {
      process.exit(0);
    }
  }, 700);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 460,
    height: 400,
    frame: false,
    resizable: false,
    center: true,
    alwaysOnTop: true,
    show: false,
    backgroundColor: '#12151f',
    title: '叠云 Agent 更新',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadFile(path.join(__dirname, 'index.html'));
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    mainWindow.focus();
    pushState({
      phase: 'installing',
      percent: 5,
      message: '正在启动安装程序…',
      version: targetVersion,
      fromVersion
    });
    setTimeout(runInstaller, 240);
  });
}

app.whenReady().then(() => {
  if (!installerPath || !fs.existsSync(installerPath)) {
    createWindow();
    pushState({ phase: 'error', message: '找不到更新安装包' });
    return;
  }
  createWindow();
});

app.on('window-all-closed', () => {
  app.quit();
});
