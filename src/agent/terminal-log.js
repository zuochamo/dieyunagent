'use strict';

const path = require('path');
const { isVirtualWorkspacePath, hostSidecarRoots, TERMINALS_REL } = require('./host-sidecar');
const { getRotatingLog, closeLog } = require('../logs/rotating-file-log');

/**
 * 集成终端日志。
 *
 * `appendTerminalLog` 挂在 PTY 的 onData 上——终端每吐一个数据块就写一次，
 * 是仓库里频率最高、也最容易被 build 输出（HMR / 进度条 / verbose）打爆的落盘路径。
 * 上限、轮转、批写节流全部交给 logs/rotating-file-log.js，这里只管路径与目标切换。
 */
const TERMINAL_LOG_MAX_BYTES = 4 * 1024 * 1024;

/** 当前日志目标；切工作区时需要先把它刷盘，避免缓冲串台 @type {string|null} */
let currentTarget = null;

function resolveTerminalLogPath(workspacePath, userDataPath) {
  const ws = workspacePath ? String(workspacePath).trim() : '';
  if (ws && !isVirtualWorkspacePath(ws)) {
    return path.join(ws, '.dieyun', 'terminals', 'integrated.log');
  }
  return path.join(hostSidecarRoots(userDataPath).terminals, 'integrated.log');
}

function appendTerminalLog(text, opts = {}) {
  const chunk = String(text || '');
  if (!chunk) return null;
  const filePath = resolveTerminalLogPath(opts.workspacePath, opts.userDataPath);
  // 目标变了：先把旧目标的缓冲落盘，否则残留内容会串到新工作区的日志里
  if (currentTarget && currentTarget !== filePath) closeLog(currentTarget);
  currentTarget = filePath;
  const log = getRotatingLog(filePath, { maxBytes: TERMINAL_LOG_MAX_BYTES });
  if (log) log.write(chunk);
  return filePath;
}

function resetTerminalLogTarget(workspacePath, userDataPath) {
  if (currentTarget) {
    closeLog(currentTarget);
    currentTarget = null;
  }
  return resolveTerminalLogPath(workspacePath, userDataPath);
}

function terminalLogHint(workspacePath, userDataPath) {
  const rel = isVirtualWorkspacePath(workspacePath)
    ? `${TERMINALS_REL}/integrated.log`
    : (() => {
        const p = resolveTerminalLogPath(workspacePath, userDataPath);
        return workspacePath && p.startsWith(String(workspacePath))
          ? p.slice(String(workspacePath).length).replace(/^[/\\]+/, '')
          : p;
      })();
  return `集成终端输出同步至 ${rel}；host_exec 失败时可 fs_read_file 读取该日志排查。`;
}

module.exports = {
  appendTerminalLog,
  resetTerminalLogTarget,
  resolveTerminalLogPath,
  terminalLogHint
};
