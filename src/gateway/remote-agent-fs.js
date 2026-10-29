'use strict';

const path = require('path');
const { resolveRemotePath } = require('../ssh/remote-path');
const { normalizeRemotePath } = require('../workspace/target');
const { normalizeReadParams } = require('./fs-read-limits');
const { scanRecentArtifactFiles } = require('./artifact-scan');

/**
 * 远端文件系统的 **RPC 实现**：所有读写都经远端 daemon（P2 的 SSH `direct-streamlocal` 通道）。
 *
 * 与 `remote-fs.js`（SFTP 版）实现同一个接口，`getRemoteFs()` 只在这一层选实现 ——
 * 调用方（fs / artifact / browser / computer / host / lsp / undo / workspace handlers）
 * 不知道也不需要知道底下是 SFTP 还是 RPC。
 *
 * 为什么要有它（审核文档 §3.2 / P4）：
 *  - **写路径合一**：远端自己的 `fs.write_file` 会算行级 diff、并按与本地同一份规则调度
 *    增量索引；SFTP 写是「桌面端先整读一遍算 diff、写完之后再补一条 fire-and-forget 通知」，
 *    两条路径的语义与失败面都不一样。
 *  - 远端 handler 因此不再是「桌面端从不调用的影子实现」。
 *
 * 保留 SFTP 版的理由只有一个：没装 Agent 的会话（`sshBackend === 'sftp'`）仍要能改文件。
 *
 * @param {{ key?: string, socketPath?: string, openChannel?: Function, workspaceRoot?: string }} info
 * @param {import('../workspace/target').SshWorkspaceTarget} target
 * @param {{ roots?: string[], call?: (method: string, params: object, timeoutMs?: number) => Promise<any> }} [opts]
 */
function createRemoteAgentFsAdapter(info, target, opts = {}) {
  const root = normalizeRemotePath(target.remotePath);
  const extraRoots = (Array.isArray(opts.roots) ? opts.roots : [])
    .filter((r) => r != null && String(r).trim() !== '')
    .map((r) => normalizeRemotePath(r));
  // 工作空间根恒为首根（相对路径基准 / listArtifactFiles 基准都用它），其余根只放宽落点
  const roots = Array.from(new Set([root, ...extraRoots]));

  /**
   * 每条命令现取 client：`getRemoteAgentClient` 自己带缓存与重连，
   * 这里捕获实例会在通道重建后指向一个死 ws。
   */
  async function call(method, params, timeoutMs) {
    if (typeof opts.call === 'function') return opts.call(method, params, timeoutMs);
    // 延迟 require：单测注入 opts.call 时不拖进 ws / 连接池
    const { getRemoteAgentClient } = require('./remote-agent-client');
    return getRemoteAgentClient(info).call(method, params, timeoutMs);
  }

  /** 本地先按**远端同一份**白名单拒绝（ws + HOME + /tmp，无本地「完全放开」档位），
   *  daemon 再用同一个 `assertAllowedPath` 复核；两边结论必须一致，不许一边松一边紧。 */
  function resolve(input, defaultCwd) {
    return resolveRemotePath(input, roots, defaultCwd || root);
  }

  async function readFile(filePath, encoding, readOpts = {}) {
    const safe = resolve(filePath, root);
    const { offset, maxBytes } = normalizeReadParams(readOpts);
    const res = await call('fs.read_file', { filePath: safe, encoding, offset, maxBytes });
    return { ...res, remote: true };
  }

  async function writeFile(filePath, data, encoding) {
    const safe = resolve(filePath, root);
    const res = await call('fs.write_file', { filePath: safe, data, encoding });
    return { ...res, remote: true };
  }

  async function listDir(dirPath) {
    const safe = resolve(dirPath || root, root);
    const rows = await call('fs.list_dir', { dirPath: safe });
    return (Array.isArray(rows) ? rows : []).map((ent) => ({
      name: ent.name,
      isDirectory: !!ent.isDirectory,
      size: ent.size || 0,
      mtimeMs: ent.mtimeMs || 0
    }));
  }

  async function stat(filePath) {
    const safe = resolve(filePath, root);
    const st = await call('fs.stat', { filePath: safe });
    return {
      isFile: !!st.isFile,
      isDirectory: !!st.isDirectory,
      size: st.size || 0,
      mtimeMs: st.mtimeMs || 0
    };
  }

  async function mkdir(dirPath) {
    const safe = resolve(dirPath, root);
    const res = await call('fs.mkdir', { dirPath: safe });
    return { ...res, remote: true };
  }

  /**
   * 远程工作区的文件清单（按 mtime 倒序）。遍历规则在 artifact-scan.js ——
   * 本地 / SFTP / 远程 Agent 三处共用同一份，排除表不会再漂移。
   */
  async function listArtifactFiles(limit, listOpts = {}) {
    const res = await scanRecentArtifactFiles(
      {
        async readdir(dir) {
          const rows = await call('fs.list_dir', { dirPath: dir });
          return (Array.isArray(rows) ? rows : []).map((ent) => ({
            name: ent.name,
            isDirectory: !!ent.isDirectory,
            isFile: !ent.isDirectory,
            size: ent.size || 0,
            mtimeMs: ent.mtimeMs || 0
          }));
        },
        join: (dir, name) => path.posix.join(dir, name),
        relative: (base, full) => path.posix.relative(base, full)
      },
      { base: root, sinceMs: listOpts.sinceMs, limit, maxDepth: listOpts.maxDepth }
    );
    return {
      ...res,
      files: res.files.map((f) => ({ ...f, remote: true }))
    };
  }

  return {
    root,
    transport: 'rpc',
    resolve,
    readFile,
    writeFile,
    listDir,
    stat,
    mkdir,
    listArtifactFiles
  };
}

module.exports = { createRemoteAgentFsAdapter };
