'use strict';

const path = require('path');
const {
  MAX_FILES,
  MAX_FILE_BYTES,
  shouldSkipDir,
  isTextFile
} = require('./index-service');

/**
 * @typedef {{ relPath: string, content: string, mtime: number }} RemoteCodebaseFile
 */

/**
 * @param {object} opts
 * @param {ReturnType<import('../ssh/session-manager').createSshSessionManager> | null} [opts.ssh]
 * @param {string} opts.remoteRoot
 * @param {{ readdir: Function, readFile: Function } | null} [opts.transport]
 * @param {number} [opts.maxFiles]
 * @returns {Promise<RemoteCodebaseFile[]>}
 */
async function collectRemoteCodebaseFiles(opts) {
  const { normalizeRemotePath } = require('../workspace/target');
  const root = normalizeRemotePath(opts.remoteRoot);
  const maxFiles = Math.min(MAX_FILES, Number(opts.maxFiles) || MAX_FILES);
  const transport = opts.transport || null;
  const ssh = opts.ssh || null;
  if (!transport && !ssh) {
    throw new Error('远程 codebase 采集需要 SSH 或 remote transport');
  }

  /** @type {{ abs: string, rel: string, mtime: number, size: number }[]} */
  const listed = [];
  if (transport) {
    await walkRemoteTransport(transport, root, root, listed, maxFiles);
  } else {
    await walkRemoteSsh(ssh, root, root, listed, maxFiles);
  }
  listed.sort((a, b) => a.rel.localeCompare(b.rel));

  /** @type {RemoteCodebaseFile[]} */
  const out = [];
  for (const file of listed.slice(0, maxFiles)) {
    if (file.size > MAX_FILE_BYTES) continue;
    try {
      let buf;
      let truncated;
      if (transport) {
        const r = await transport.readFile(file.abs, MAX_FILE_BYTES + 1);
        buf = r.buf;
        truncated = r.truncated;
      } else {
        const r = await ssh.sftpReadFile(file.abs, MAX_FILE_BYTES + 1);
        buf = r.buf;
        truncated = r.truncated;
      }
      if (truncated) continue;
      const text = buf.toString('utf8');
      if (text.includes('\0')) continue;
      out.push({
        relPath: file.rel,
        content: text,
        mtime: file.mtime
      });
    } catch {
      // skip unreadable files
    }
  }
  return out;
}

async function walkRemoteTransport(transport, dir, remoteRoot, out, maxFiles) {
  let list;
  try {
    list = await transport.readdir(dir);
  } catch {
    return;
  }
  for (const ent of list) {
    if (!ent || !ent.filename || ent.filename === '.' || ent.filename === '..') continue;
    const full = path.posix.join(dir, ent.filename);
    const isDir = (ent.attrs.mode & 0o170000) === 0o040000;
    if (isDir) {
      if (shouldSkipDir(ent.filename)) continue;
      await walkRemoteTransport(transport, full, remoteRoot, out, maxFiles);
    } else if (isTextFile(ent.filename)) {
      out.push({
        abs: full,
        rel: path.posix.relative(remoteRoot, full).replace(/\\/g, '/') || ent.filename,
        mtime: Math.floor((ent.attrs.mtime || 0) * 1000),
        size: ent.attrs.size || 0
      });
    }
    if (out.length >= maxFiles) return;
  }
}

async function walkRemoteSsh(ssh, dir, remoteRoot, out, maxFiles) {
  let list;
  try {
    list = await ssh.sftpReaddir(dir);
  } catch {
    return;
  }
  for (const ent of list) {
    if (!ent || !ent.filename || ent.filename === '.' || ent.filename === '..') continue;
    const full = path.posix.join(dir, ent.filename);
    const isDir = (ent.attrs.mode & 0o170000) === 0o040000;
    if (isDir) {
      if (shouldSkipDir(ent.filename)) continue;
      await walkRemoteSsh(ssh, full, remoteRoot, out, maxFiles);
    } else if (isTextFile(ent.filename)) {
      out.push({
        abs: full,
        rel: path.posix.relative(remoteRoot, full).replace(/\\/g, '/') || ent.filename,
        mtime: Math.floor((ent.attrs.mtime || 0) * 1000),
        size: ent.attrs.size || 0
      });
    }
    if (out.length >= maxFiles) return;
  }
}

module.exports = {
  collectRemoteCodebaseFiles
};
