'use strict';

function createArtifactHandlers({ getRemoteFs, resolveHostSidecarLocalPath, sidecarReadOpts, readSidecarFileAt, readAllowedTextFile, listAllowedArtifactFiles }) {
  return {
    'artifact.read_file': async ({ filePath, encoding, offset, maxBytes }) => {
      const sidecar = resolveHostSidecarLocalPath(filePath, sidecarReadOpts());
      if (sidecar) return readSidecarFileAt(sidecar, encoding, { offset, maxBytes });
      const remote = getRemoteFs();
      if (remote) return remote.readFile(filePath, encoding, { offset, maxBytes });
      return readAllowedTextFile(filePath, encoding, { offset, maxBytes });
    },

    /**
     * 工作区文件清单（按 mtime 倒序）。`sinceMs` 给定时只返回该时间之后改动过的文件
     * —— 产物区据此得出「本会话真的落盘过什么」，与「哪个工具写的」无关。
     */
    'artifact.list_files': async ({ dirPath, limit, sinceMs, maxDepth }) => {
      const opts = { sinceMs, maxDepth };
      const remote = getRemoteFs();
      if (remote) return remote.listArtifactFiles(limit, opts);
      return listAllowedArtifactFiles(dirPath, limit, opts);
    },
  };
}

module.exports = { createArtifactHandlers };
