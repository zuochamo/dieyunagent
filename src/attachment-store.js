'use strict';

const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const { normalizeRemotePath } = require('./workspace/target');

const DIEYUN_ATTACHMENTS = path.join('.dieyun', 'attachments');

function makeSafeFileName(originalName) {
  const base = path.basename(String(originalName || 'file'))
    .replace(/[^\w.\-\u4e00-\u9fff()+]/g, '_')
    .slice(0, 120);
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${base || 'file'}`;
}

function workspaceRelativeAttachment(name) {
  return path.join(DIEYUN_ATTACHMENTS, name).replace(/\\/g, '/');
}

function fallbackUploadsDir(readableDirPath, userDataPath) {
  return path.join(readableDirPath || path.join(userDataPath, 'gateway-readable'), 'uploads');
}

/**
 * @param {{ localGateway?: object, readableDirPath?: string, userDataPath: string, srcPath?: string, buffer?: Buffer, originalName: string, mime?: string }} opts
 */
async function stageAttachment(opts) {
  const {
    localGateway,
    readableDirPath,
    userDataPath,
    srcPath,
    buffer,
    originalName,
    mime
  } = opts;

  let buf = buffer;
  if (!buf && srcPath) {
    buf = await fsp.readFile(srcPath);
  }
  if (!buf || !buf.length) {
    throw new Error('无效的附件数据');
  }

  const safeName = makeSafeFileName(originalName);
  const ws = localGateway && typeof localGateway.getWorkspace === 'function' ? localGateway.getWorkspace() : null;

  if (ws && ws.kind === 'local' && ws.workspacePath) {
    const dir = path.join(ws.workspacePath, DIEYUN_ATTACHMENTS);
    await fsp.mkdir(dir, { recursive: true });
    const dest = path.join(dir, safeName);
    await fsp.writeFile(dest, buf);
    const st = await fsp.stat(dest);
    const rel = workspaceRelativeAttachment(safeName);
    return {
      originalName: path.basename(originalName),
      path: rel,
      absolutePath: dest,
      workspaceRelative: rel,
      size: st.size,
      mime: mime || undefined
    };
  }

  if (ws && ws.kind === 'ssh' && ws.sshConnected && localGateway.ssh) {
    const remoteRoot = normalizeRemotePath((ws.ssh && ws.ssh.remotePath) || ws.workspacePath || '/');
    const remoteDir = path.posix.join(remoteRoot, '.dieyun', 'attachments');
    const remotePath = path.posix.join(remoteDir, safeName);
    if (typeof localGateway.ssh.sftpMkdirp === 'function') {
      await localGateway.ssh.sftpMkdirp(remoteDir);
    }
    await localGateway.ssh.sftpWriteFile(remotePath, buf);
    const rel = workspaceRelativeAttachment(safeName);
    return {
      originalName: path.basename(originalName),
      path: rel,
      absolutePath: remotePath,
      workspaceRelative: rel,
      size: buf.length,
      mime: mime || undefined,
      remote: true
    };
  }

  const uploadsDir = fallbackUploadsDir(readableDirPath, userDataPath);
  await fsp.mkdir(uploadsDir, { recursive: true });
  const dest = path.join(uploadsDir, safeName);
  await fsp.writeFile(dest, buf);
  const st = await fsp.stat(dest);
  return {
    originalName: path.basename(originalName),
    path: dest,
    absolutePath: dest,
    workspaceRelative: '',
    size: st.size,
    mime: mime || undefined
  };
}

/**
 * 解析当前工作区的附件目录，返回落盘口径（本地 / 远端 + ssh 会话）。
 * 保留策略必须复用这里的路径拼接，避免两处各写一份。
 *
 * @param {{ getWorkspace?: Function, ssh?: object } | null} localGateway
 * @returns {{ kind: 'local', dir: string } | { kind: 'ssh', dir: string, ssh: object } | null}
 */
function resolveAttachmentsDir(localGateway) {
  const ws =
    localGateway && typeof localGateway.getWorkspace === 'function' ? localGateway.getWorkspace() : null;
  if (ws && ws.kind === 'local' && ws.workspacePath) {
    return { kind: 'local', dir: path.join(ws.workspacePath, DIEYUN_ATTACHMENTS) };
  }
  if (ws && ws.kind === 'ssh' && ws.sshConnected && localGateway.ssh) {
    const remoteRoot = normalizeRemotePath((ws.ssh && ws.ssh.remotePath) || ws.workspacePath || '/');
    return {
      kind: 'ssh',
      dir: path.posix.join(remoteRoot, '.dieyun', 'attachments'),
      ssh: localGateway.ssh
    };
  }
  return null;
}

module.exports = {
  DIEYUN_ATTACHMENTS,
  resolveAttachmentsDir,
  stageAttachment,
  stageAttachmentFiles: async (opts, filePaths) => {
    const out = [];
    for (const src of filePaths) {
      out.push(
        await stageAttachment({
          ...opts,
          srcPath: src,
          originalName: path.basename(src)
        })
      );
    }
    return out;
  }
};
