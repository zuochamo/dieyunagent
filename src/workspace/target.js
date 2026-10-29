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
    // 对象形态也要挡住远端 URI：`{kind:'local', path:'ssh://…'}` 若被 path.resolve，
    // 就得到 `E:\...\ssh:\user@host\path` 这种假目录（索引键被污染、面板恒「未建立」）。
    if (!p || isRemoteWorkspacePath(p)) return null;
    return { kind: 'local', path: path.resolve(p) };
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
  // 认得出是远端前缀（`ssh:`）但形态不合法，例如 `ssh:user@host:/path`：
  // 宁可不挂工作区，也不要把它 path.resolve 成本地目录——那会让整条会话的 cwd
  // 指向一个不存在的 Windows 路径，远端工具全部 CWD_NOT_FOUND。
  if (isRemoteWorkspacePath(s)) return null;
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
    // 存量里可能躺着被写坏的本地条目（workspacePath 是 ssh URI）：交给统一解析，
    // 别在这里 path.resolve 成假目录。
    return parseWorkspaceInput(String(raw.workspacePath));
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

/**
 * worktree 是「会话写到哪儿」的实现细节，不是它对外的身份。
 * 目录规则（本地 / 远端共用）：`<repo>/.dieyun/worktrees/<id>[/<role>]`。
 * 去掉这一段就回到它所属的仓库——远端建 worktree、本地跑 Plan、历史列表分组都只认这一个形状。
 */
const WORKTREE_TAIL_RE = /[\\/]\.dieyun[\\/]worktrees[\\/][^\\/]+(?:[\\/][^\\/]+)?$/i;

/** @param {string} p @returns {string} 去掉 worktree 尾巴后的路径（没尾巴就原样返回） */
function stripWorktreeSuffix(p) {
  const s = String(p || '');
  if (!s) return '';
  const out = s.replace(WORKTREE_TAIL_RE, '');
  return out === s ? s : out;
}

/**
 * 会话工作区的「项目身份」： ssh URI 与本地路径都支持，形态与输入保持一致。
 * 同一项目的多个会话因此落在同一个分组里，而不是各自变成名为 `main` 的文件夹。
 *
 * 只剥尾巴、不做 path.resolve：远端会话存的是 POSIX 路径，在 Windows 上 resolve
 * 会把它变成 `E:\srv\...`。剥尾巴这个动作与平台、与是不是 URI 都无关。
 * @param {string} input ssh://user@host:port/path 或本地路径
 * @returns {string}
 */
function projectWorkspacePath(input) {
  const raw = String(input || '').trim();
  if (!raw) return '';
  return stripWorktreeSuffix(raw) || raw;
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
  stripWorktreeSuffix,
  projectWorkspacePath,
  isSameSshTarget,
  sshTargetKey,
  sshGatewayKey,
  isRemoteWorkspacePath,
  isRemoteWorkspaceKind
};
