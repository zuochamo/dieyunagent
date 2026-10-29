'use strict';

const { createPermissionsHandlers } = require('./permissions');
const { createAgentHandlers } = require('./agent');
const { createMemoryHandlers } = require('./memory');
const { createWebHandlers } = require('./web');
const { createSpeechHandlers } = require('./speech');
const { createIndexRemoteHandlers } = require('./index-remote');
const { createArtifactHandlers } = require('./artifact');
const { createCodebaseHandlers } = require('./codebase');
const { createGraphHandlers } = require('./graph');
const { createLspWorkspaceHandlers } = require('./lsp-workspace');
const { createFsHandlers } = require('./fs');
const { createHostHandlers } = require('./host');
const { createBrowserHandlers } = require('./browser');
const { createComputerHandlers } = require('./computer');
const { createUndoHandlers } = require('./undo');
const { createScmHandlers } = require('./scm');
const { createWorkspaceHandlers } = require('./workspace');

/**
 * Compose extracted RPC handler namespaces.
 * @param {object} deps — closure values from createRpcHandlers
 */
function createExtractedHandlers(deps) {
  return {
    ...createPermissionsHandlers(deps),
    ...createMemoryHandlers(deps),
    ...createAgentHandlers(deps),
    ...createWebHandlers(deps),
    ...createSpeechHandlers(deps),
    ...createIndexRemoteHandlers(deps),
    ...createArtifactHandlers(deps),
    ...createCodebaseHandlers(deps),
    ...createGraphHandlers(deps),
    ...createLspWorkspaceHandlers(deps),
    ...createFsHandlers(deps),
    ...createHostHandlers(deps),
    ...createBrowserHandlers(deps),
    ...createComputerHandlers(deps),
    ...createUndoHandlers(deps),
    ...createScmHandlers(deps),
    ...createWorkspaceHandlers(deps)
  };
}

module.exports = { createExtractedHandlers };
