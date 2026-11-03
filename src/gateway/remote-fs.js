'use strict';

const path = require('path');
const { resolveRemotePath } = require('../ssh/remote-path');
const { normalizeRemotePath } = require('../workspace/target');
const { normalizeReadParams } = require('./fs-read-limits');
const { sftpEntryIsDirectory } = require('../ssh/session-manager');
const { computeLineDiffStats } = require('./line-diff-stats');
const { scanRecentArtifactFiles } = require('./artifact-scan');

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
    /** 旧内容是否**完整**读到：读不全就不能当「改动前」（不存在 ⇒ 按新建处理，全算新增） */
    let beforeKnown = true;
    try {
      if (enc === 'utf8') {
        const prev = await readFile(safe, 'utf8');
        // 旧内容被读上限截断时**不能**当作"改动前"：拿 2MB 的前缀去比一个更大的文件，
        // diff 会报出巨量 added/removed（前端改动摘要与 undo 快照都建在这个数字上）。
        if (prev.truncated) {
          beforeKnown = false;
        } else {
          beforeText = prev.data;
        }
      }
    } catch {
      beforeText = null; // 文件不存在：按新建处理
    }
    const dir = path.posix.dirname(safe);
    if (dir && dir !== '/') await ssh.sftpMkdirp(dir);
    await ssh.sftpWriteFile(safe, buf);
    let diff = null;
    if (enc === 'utf8' && beforeKnown) diff = computeLineDiffStats(beforeText, data);
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

  /**
   * 远程工作区的文件清单（按 mtime 倒序）。遍历与排除表复用 artifact-scan.js
   * ——本地 / SFTP / 远程 Agent 三处过去各写一份，排除表已开始漂移。
   */
  async function listArtifactFiles(limit, opts = {}) {
    const res = await scanRecentArtifactFiles(
      {
        async readdir(dir) {
          const list = await ssh.sftpReaddir(dir);
          const out = [];
          for (const ent of list || []) {
            if (!ent || !ent.filename) continue;
            if (ent.filename === '.' || ent.filename === '..') continue;
            out.push({
              name: ent.filename,
              isDirectory: sftpEntryIsDirectory(ent),
              isFile: !sftpEntryIsDirectory(ent),
              size: (ent.attrs && ent.attrs.size) || 0,
              mtimeMs: ((ent.attrs && ent.attrs.mtime) || 0) * 1000
            });
          }
          return out;
        },
        join: (dir, name) => path.posix.join(dir, name),
        relative: (base, full) => path.posix.relative(base, full)
      },
      { base: root, sinceMs: opts.sinceMs, limit, maxDepth: opts.maxDepth }
    );
    return {
      ...res,
      files: res.files.map((f) => ({ ...f, remote: true }))
    };
  }

  return {
    root,
    // 传输标识：写文件的增量索引通知只在 SFTP 这条路上需要补
    // （RPC 写入由远端 handler 自己调度，见 remote-agent-fs.js）
    transport: 'sftp',
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
