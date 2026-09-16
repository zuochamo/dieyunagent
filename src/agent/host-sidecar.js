'use strict';

const path = require('path');
const os = require('os');
const { isRemoteWorkspacePath } = require('../workspace/target');

const TOOL_OUTPUT_REL = '.dieyun/tool-output';
const TERMINALS_REL = '.dieyun/terminals';

function isVirtualWorkspacePath(workspacePath) {
  return isRemoteWorkspacePath(workspacePath);
}

function hostSidecarRoots(userDataPath) {
  const base = userDataPath || path.join(os.homedir(), '.dieyun');
  return {
    toolOutput: path.join(base, 'tool-output'),
    terminals: path.join(base, 'terminals')
  };
}

function isPathInside(parent, child) {
  const p = path.resolve(parent);
  const c = path.resolve(child);
  const pn = process.platform === 'win32' ? p.toLowerCase() : p;
  const cn = process.platform === 'win32' ? c.toLowerCase() : c;
  return cn === pn || cn.startsWith(pn + path.sep);
}

function looksAbsoluteLocalPath(p) {
  const s = String(p || '');
  return /^[a-zA-Z]:[\\/]/.test(s) || s.startsWith('\\\\');
}

function matchVirtualRel(posixPath, prefix) {
  const stripped = String(posixPath || '')
    .replace(/\\/g, '/')
    .replace(/^\.\//, '');
  if (stripped === prefix) return '';
  if (stripped.startsWith(`${prefix}/`)) return stripped.slice(prefix.length + 1);
  return null;
}

/**
 * Map an agent-facing path to a local sidecar file (userData/tool-output or userData/terminals).
 * Returns an absolute local path, or null if this is a normal workspace file.
 */
function resolveHostSidecarLocalPath(filePath, opts = {}) {
  const raw = String(filePath || '').trim();
  if (!raw) return null;
  const roots = hostSidecarRoots(opts.userDataPath);

  if (looksAbsoluteLocalPath(raw)) {
    const abs = path.resolve(raw);
    if (isPathInside(roots.toolOutput, abs) || isPathInside(roots.terminals, abs)) return abs;
    return null;
  }

  if (!isVirtualWorkspacePath(opts.workspacePath)) return null;

  const toolRest = matchVirtualRel(raw, TOOL_OUTPUT_REL);
  if (toolRest != null) {
    return toolRest ? path.join(roots.toolOutput, toolRest.split('/').join(path.sep)) : roots.toolOutput;
  }
  const termRest = matchVirtualRel(raw, TERMINALS_REL);
  if (termRest != null) {
    return termRest ? path.join(roots.terminals, termRest.split('/').join(path.sep)) : roots.terminals;
  }
  return null;
}

function workspaceRelativeSpillPath(runKey, fileName) {
  return `${TOOL_OUTPUT_REL}/${runKey}/${fileName}`.replace(/\\/g, '/');
}

module.exports = {
  TOOL_OUTPUT_REL,
  TERMINALS_REL,
  isVirtualWorkspacePath,
  hostSidecarRoots,
  resolveHostSidecarLocalPath,
  workspaceRelativeSpillPath
};
