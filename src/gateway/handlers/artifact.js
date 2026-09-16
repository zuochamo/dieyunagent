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

    'artifact.list_files': async ({ dirPath, limit }) => {
      const remote = getRemoteFs();
      if (remote) return remote.listArtifactFiles(limit);
      return listAllowedArtifactFiles(dirPath, limit);
    },
  };
}

module.exports = { createArtifactHandlers };
