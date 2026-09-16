'use strict';

const { createPlaybookStorage } = require('../playbook/playbook-rpc');
const {
  ensureWikiDir,
  listWikiPages,
  readWikiPage,
  writeWikiPage,
  recallWikiPages
} = require('./wiki-service');

function requireWorkspacePath(workspacePath) {
  const p = String(workspacePath || '').trim();
  if (!p) {
    const e = new Error('workspacePath 必填');
    e.code = 'INVALID_WORKSPACE';
    throw e;
  }
  return p;
}

/**
 * @param {Parameters<typeof createPlaybookStorage>[0]} deps
 */
function createWikiRpcHandlers(deps) {
  function storageFor(workspacePath) {
    return createPlaybookStorage(deps, { cwd: workspacePath });
  }

  return {
    'wiki.ensure': async (payload = {}) => {
      deps.assertFsWrite();
      const workspacePath = requireWorkspacePath(payload.workspacePath);
      return ensureWikiDir(storageFor(workspacePath));
    },

    'wiki.list': async (payload = {}) => {
      deps.assertFsRead();
      const workspacePath = requireWorkspacePath(payload.workspacePath);
      const pages = await listWikiPages(storageFor(workspacePath));
      return { ok: true, root: '.dieyun/wiki', pages };
    },

    'wiki.read': async (payload = {}) => {
      deps.assertFsRead();
      const workspacePath = requireWorkspacePath(payload.workspacePath);
      return readWikiPage(storageFor(workspacePath), payload.slug || payload.path);
    },

    'wiki.write': async (payload = {}) => {
      deps.assertFsWrite();
      const workspacePath = requireWorkspacePath(payload.workspacePath);
      return writeWikiPage(storageFor(workspacePath), payload);
    },

    'wiki.recall': async (payload = {}) => {
      deps.assertFsRead();
      const workspacePath = requireWorkspacePath(payload.workspacePath);
      const pages = await listWikiPages(storageFor(workspacePath));
      const results = recallWikiPages(pages, payload.query || '', payload.limit || 8);
      return { ok: true, results, mode: 'keyword' };
    }
  };
}

module.exports = {
  createWikiRpcHandlers
};
