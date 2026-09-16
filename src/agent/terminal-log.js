'use strict';

const fs = require('fs');
const path = require('path');
const { isVirtualWorkspacePath, hostSidecarRoots, TERMINALS_REL } = require('./host-sidecar');

/** @type {{ filePath: string|null, stream: import('fs').WriteStream|null }} */
let state = { filePath: null, stream: null };

function resolveTerminalLogPath(workspacePath, userDataPath) {
  const ws = workspacePath ? String(workspacePath).trim() : '';
  if (ws && !isVirtualWorkspacePath(ws)) {
    return path.join(ws, '.dieyun', 'terminals', 'integrated.log');
  }
  return path.join(hostSidecarRoots(userDataPath).terminals, 'integrated.log');
}

function ensureTerminalLogStream(workspacePath, userDataPath) {
  const filePath = resolveTerminalLogPath(workspacePath, userDataPath);
  if (state.filePath === filePath && state.stream) return state;
  if (state.stream) {
    try {
      state.stream.end();
    } catch {
      // ignore
    }
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  state = {
    filePath,
    stream: fs.createWriteStream(filePath, { flags: 'a', encoding: 'utf8' })
  };
  return state;
}

function appendTerminalLog(text, opts = {}) {
  const chunk = String(text || '');
  if (!chunk) return null;
  const { stream, filePath } = ensureTerminalLogStream(opts.workspacePath, opts.userDataPath);
  try {
    stream.write(chunk);
  } catch {
    // ignore
  }
  return filePath;
}

function resetTerminalLogTarget(workspacePath, userDataPath) {
  if (state.stream) {
    try {
      state.stream.end();
    } catch {
      // ignore
    }
  }
  state = { filePath: null, stream: null };
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
