'use strict';

const { createPermissionsHandlers } = require('./permissions');
const { createAgentHandlers } = require('./agent');
const { createMemoryHandlers } = require('./memory');
const { createSqlHandlers } = require('./sql');
const { createWebHandlers } = require('./web');
const { createSpeechHandlers } = require('./speech');
const { createIndexRemoteHandlers } = require('./index-remote');
const { createPluginsHandlers } = require('./plugins');
const { createArtifactHandlers } = require('./artifact');
const { createCodebaseHandlers } = require('./codebase');
const { createGraphHandlers } = require('./graph');
const { createLspWorkspaceHandlers } = require('./lsp-workspace');
const { createFsHandlers } = require('./fs');
const { createHostHandlers } = require('./host');
const { createBrowserHandlers } = require('./browser');
const { createUndoHandlers } = require('./undo');

/**
 * Compose extracted RPC handler namespaces.
 * @param {object} deps — closure values from createRpcHandlers
 */
function createExtractedHandlers(deps) {
  return {
    ...createPermissionsHandlers(deps),
    ...createMemoryHandlers(deps),
    ...createAgentHandlers(deps),
    ...createSqlHandlers(deps),
    ...createWebHandlers(deps),
    ...createSpeechHandlers(deps),
    ...createIndexRemoteHandlers(deps),
    ...createPluginsHandlers(deps),
    ...createArtifactHandlers(deps),
    ...createCodebaseHandlers(deps),
    ...createGraphHandlers(deps),
    ...createLspWorkspaceHandlers(deps),
    ...createFsHandlers(deps),
    ...createHostHandlers(deps),
    ...createBrowserHandlers(deps),
    ...createUndoHandlers(deps)
  };
}

module.exports = { createExtractedHandlers };
