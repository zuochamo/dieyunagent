'use strict';

const path = require('path');

const SSH_URI_RE = /^ssh:\/\/([^@/]+)@([^/:]+)(?::(\d+))?(\/.*)?$/i;
const SSH_URI_LEGACY_RE = /^ssh:([^@/]+)@([^/:]+)(?::(\d+))?(\/.*)?$/i;

function normalizeRemotePath(p) {
  const raw = String(p || '').trim().replace(/\\/g, '/');
  if (!raw) return '/';
  const withSlash = raw.startsWith('/') ? raw : `/${raw}`;
  return path.posix.normalize(withSlash.replace(/\/+$/, '') || '/');
}

function parseSshUriFields(s) {
  const m = SSH_URI_RE.exec(s) || SSH_URI_LEGACY_RE.exec(s);
  if (!m) return null;
  return {
    username: decodeURIComponent(m[1]),
    host: m[2],
    port: Number(m[3]) || 22,
    remotePath: normalizeRemotePath(m[4] || '/')
  };
}

function buildSshUri(target) {
  if (!target || target.kind !== 'ssh') return '';
  const port = Number(target.port) || 22;
  const remotePath = normalizeRemotePath(target.remotePath);
  const portPart = port === 22 ? '' : `:${port}`;
  return `ssh://${target.username}@${target.host}${portPart}${remotePath}`;
}

function isRemoteWorkspacePath(input) {
  return /^ssh:/i.test(String(input || '').trim());
}

function parseWorkspaceInput(input) {
  if (input == null || input === '') return null;
  if (typeof input === 'object' && input.kind === 'ssh') {
    return {
      kind: 'ssh',
      host: String(input.host || '').trim(),
      port: Number(input.port) || 22,
      username: String(input.username || '').trim(),
      remotePath: normalizeRemotePath(input.remotePath || '/')
    };
  }
  if (typeof input === 'object' && input.kind === 'local') {
    const p = String(input.path || input.workspacePath || '').trim();
    return p ? { kind: 'local', path: path.resolve(p) } : null;
  }
  const s = String(input).trim();
  if (!s) return null;
  // Legacy WSL workspace URIs are no longer supported.
  if (/^wsl:/i.test(s) || (typeof input === 'object' && input.kind === 'wsl')) {
    return null;
  }
  const ssh = parseSshUriFields(s);
  if (ssh) {
    return { kind: 'ssh', ...ssh };
  }
  return { kind: 'local', path: path.resolve(s) };
}

function targetFromDisk(raw) {
  if (!raw || typeof raw !== 'object') {
    const legacy = raw && raw.workspacePath ? String(raw.workspacePath) : '';
    return legacy ? parseWorkspaceInput(legacy) : null;
  }
  if (raw.kind === 'ssh') {
    return {
      kind: 'ssh',
      host: String(raw.host || ''),
      port: Number(raw.port) || 22,
      username: String(raw.username || ''),
      remotePath: normalizeRemotePath(raw.remotePath || '/')
    };
  }
  if (raw.kind === 'wsl') {
    return null;
  }
  if (raw.kind === 'local' && raw.workspacePath) {
    return { kind: 'local', path: path.resolve(String(raw.workspacePath)) };
  }
  if (raw.workspacePath) return parseWorkspaceInput(raw.workspacePath);
  return null;
}

function targetToDisk(target) {
  if (!target) return {};
  if (target.kind === 'ssh') {
    return {
      kind: 'ssh',
      host: target.host,
      port: target.port || 22,
      username: target.username,
      remotePath: normalizeRemotePath(target.remotePath),
      workspacePath: buildSshUri(target)
    };
  }
  return { kind: 'local', workspacePath: target.path };
}

function formatWorkspaceDisplay(target, opts = {}) {
  if (!target) return '';
  if (target.kind === 'ssh') {
    const conn = opts.connected ? '' : ' [未连接]';
    const rp = target.remotePath === '/' ? '' : target.remotePath;
    return `SSH ${target.username}@${target.host}:${rp}${conn}`;
  }
  return target.path;
}

function workspacePathForSession(target) {
  if (!target) return null;
  if (target.kind === 'ssh') return buildSshUri(target);
  return target.path;
}

function normalizeSshEndpoint(target) {
  if (!target) return null;
  const host = String(target.host || '').trim();
  const username = String(target.username || '').trim();
  if (!host || !username) return null;
  return {
    host,
    port: Number(target.port) || 22,
    username
  };
}

function isSameSshTarget(a, b) {
  const ea = normalizeSshEndpoint(a);
  const eb = normalizeSshEndpoint(b);
  if (!ea || !eb) return false;
  return ea.host === eb.host && ea.port === eb.port && ea.username === eb.username;
}

/** Pool key: same login host shares one SSH endpoint identity (port allocation, terminal routing). */
function sshTargetKey(target) {
  if (!target || target.kind !== 'ssh') return '';
  const ea = normalizeSshEndpoint(target);
  if (!ea) return '';
  return `${ea.username}@${ea.host}:${ea.port}`;
}

function sshGatewayKey(target) {
  const tk = sshTargetKey(target);
  if (!tk) return '';
  return `${tk}|${normalizeRemotePath(target.remotePath || '/')}`;
}

function isRemoteWorkspaceKind(kind) {
  return kind === 'ssh';
}

module.exports = {
  normalizeRemotePath,
  buildSshUri,
  parseWorkspaceInput,
  targetFromDisk,
  targetToDisk,
  formatWorkspaceDisplay,
  workspacePathForSession,
  isSameSshTarget,
  sshTargetKey,
  sshGatewayKey,
  isRemoteWorkspacePath,
  isRemoteWorkspaceKind
};
