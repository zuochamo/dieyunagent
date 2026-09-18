'use strict';

const path = require('path');
const { resolveRemotePath } = require('../ssh/remote-path');
const { normalizeRemotePath } = require('../workspace/target');
const { normalizeReadParams } = require('./fs-read-limits');
const { sftpEntryIsDirectory } = require('../ssh/session-manager');

function summarizeLineDiff(beforeText, afterText) {
  const before = beforeText == null ? [] : String(beforeText).split(/\r?\n/);
  const after = String(afterText || '').split(/\r?\n/);
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let beforeEnd = before.length - 1;
  let afterEnd = after.length - 1;
  while (beforeEnd >= start && afterEnd >= start && before[beforeEnd] === after[afterEnd]) {
    beforeEnd--;
    afterEnd--;
  }
  return {
    added: Math.max(0, afterEnd - start + 1),
    removed: Math.max(0, beforeEnd - start + 1)
  };
}

/**
 * @param {ReturnType<import('../ssh/session-manager').createSshSessionManager>} ssh
 * @param {import('../workspace/target').SshWorkspaceTarget} target
 * @param {{ roots?: string[] }} [opts] 额外的可用根（如远程兜底 workspace，见 ssh/remote-path.remoteAllowedRoots）
 */
function createRemoteFsAdapter(ssh, target, opts = {}) {
  const root = normalizeRemotePath(target.remotePath);
  const extraRoots = (Array.isArray(opts.roots) ? opts.roots : [])
    .filter((r) => r != null && String(r).trim() !== '')
    .map((r) => normalizeRemotePath(r));
  // 工作空间根恒为首根（相对路径基准 / listArtifactFiles 基准都用它），兜底根只放宽落点
  const roots = Array.from(new Set([root, ...extraRoots]));

  function resolve(input, defaultCwd) {
    return resolveRemotePath(input, roots, defaultCwd || root);
  }

  async function readFile(filePath, encoding, readOpts = {}) {
    const safe = resolve(filePath, root);
    const { offset, maxBytes } = normalizeReadParams(readOpts);
    const st = await ssh.sftpStat(safe);
    const { buf, truncated } = await ssh.sftpReadFile(safe, maxBytes + 1, offset);
    const enc = encoding === 'base64' ? null : encoding || 'utf8';
    const fileTruncated = truncated || offset + buf.length < (st.size || 0);
    if (enc === null) {
      return {
        data: buf.toString('base64'),
        encoding: 'base64',
        path: safe,
        size: st.size || 0,
        offset,
        truncated: fileTruncated,
        remote: true
      };
    }
    return {
      data: buf.toString(enc),
      encoding: enc,
      path: safe,
      size: st.size || 0,
      offset,
      truncated: fileTruncated,
      remote: true
    };
  }

  async function writeFile(filePath, data, encoding) {
    const safe = resolve(filePath, root);
    const enc = encoding === 'base64' ? 'base64' : 'utf8';
    const buf = enc === 'base64' ? Buffer.from(String(data), 'base64') : Buffer.from(String(data), 'utf8');
    let beforeText = null;
    try {
      if (enc === 'utf8') {
        const prev = await readFile(safe, 'utf8');
        beforeText = prev.data;
      }
    } catch {
      beforeText = null;
    }
    const dir = path.posix.dirname(safe);
    if (dir && dir !== '/') await ssh.sftpMkdirp(dir);
    await ssh.sftpWriteFile(safe, buf);
    let diff = null;
    if (enc === 'utf8') diff = summarizeLineDiff(beforeText, data);
    return { ok: true, path: safe, diff, remote: true };
  }

  async function listDir(dirPath) {
    const safe = resolve(dirPath || root, root);
    const list = await ssh.sftpReaddir(safe);
    const out = [];
    for (const ent of list) {
      if (!ent || !ent.filename || ent.filename === '.' || ent.filename === '..') continue;
      out.push({
        name: ent.filename,
        isDirectory: sftpEntryIsDirectory(ent),
        size: (ent.attrs && ent.attrs.size) || 0,
        mtimeMs: ((ent.attrs && ent.attrs.mtime) || 0) * 1000
      });
    }
    return out;
  }

  async function stat(filePath) {
    const safe = resolve(filePath, root);
    const st = await ssh.sftpStat(safe);
    const mode = st.mode || 0;
    return {
      isFile: (mode & 0o170000) === 0o100000,
      isDirectory: (mode & 0o170000) === 0o040000,
      size: st.size || 0,
      mtimeMs: (st.mtime || 0) * 1000
    };
  }

  async function mkdir(dirPath) {
    const safe = resolve(dirPath, root);
    await ssh.sftpMkdirp(safe);
    return { ok: true, path: safe, remote: true };
  }

  async function listArtifactFiles(limit) {
    const max = Math.min(500, Math.max(1, Number(limit) || 200));
    const skipDirs = new Set([
      '.git',
      '.agents',
      '.codex',
      'node_modules',
      '__pycache__',
      '.venv',
      'venv',
      'dist',
      'build'
    ]);
    const out = [];
    const stack = [{ dir: root, depth: 0 }];
    while (stack.length && out.length < max) {
      const cur = stack.pop();
      let entries = [];
      try {
        entries = await ssh.sftpReaddir(cur.dir);
      } catch {
        continue;
      }
      for (const ent of entries) {
        if (out.length >= max) break;
        if (!ent || !ent.filename || ent.filename.startsWith('~$')) continue;
        if (ent.filename === '.' || ent.filename === '..') continue;
        const full = path.posix.join(cur.dir, ent.filename);
        const isDir = sftpEntryIsDirectory(ent);
        if (isDir) {
          if (cur.depth < 2 && !skipDirs.has(ent.filename)) {
            stack.push({ dir: full, depth: cur.depth + 1 });
          }
          continue;
        }
        out.push({
          path: full,
          relativePath: path.posix.relative(root, full) || ent.filename,
          size: (ent.attrs && ent.attrs.size) || 0,
          mtimeMs: ((ent.attrs && ent.attrs.mtime) || 0) * 1000,
          remote: true
        });
      }
    }
    out.sort((a, b) => Number(b.mtimeMs || 0) - Number(a.mtimeMs || 0));
    return { base: root, files: out.slice(0, max) };
  }

  return {
    root,
    resolve,
    readFile,
    writeFile,
    listDir,
    stat,
    mkdir,
    listArtifactFiles
  };
}

module.exports = { createRemoteFsAdapter };
