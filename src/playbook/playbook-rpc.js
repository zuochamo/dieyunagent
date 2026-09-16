'use strict';

const fs = require('fs/promises');
const path = require('path');
const {
  createDraft,
  confirmDraft,
  discardDraft,
  listDrafts,
  readIndex
} = require('./playbook-service');
const { recallPlaybooks, upsertPlaybookVector } = require('./playbook-index');

/**
 * @param {{
 *   getRemoteFs: () => object | null,
 *   defaultCwd: string | null,
 *   writable: string[],
 *   roots: string[],
 *   normalizeFilePathInput: (p: string, cwd: string | null) => string,
 *   assertAllowedPath: (p: string, roots: string[]) => string,
 *   userDataPath: string,
 *   getEmbeddingConfig: () => object,
 *   assertFsWrite: () => void,
 *   assertFsRead: () => void
 * }} deps
 */
/**
 * @param {Parameters<typeof createPlaybookStorage>[0]} deps
 * @param {{ cwd?: string | null }} [opts] 覆盖 defaultCwd，供 wiki/playbook 按 payload.workspacePath 落盘
 */
function createPlaybookStorage(deps, opts = {}) {
  const {
    getRemoteFs,
    defaultCwd,
    writable,
    roots,
    normalizeFilePathInput,
    assertAllowedPath,
    assertFsWrite,
    assertFsRead
  } = deps;
  const cwdOverride = opts && opts.cwd != null ? String(opts.cwd).trim() : '';
  const cwd = cwdOverride || defaultCwd;
  const readRoots = cwdOverride
    ? Array.from(new Set([...(roots || []), ...(writable || []), path.resolve(cwdOverride)]))
    : roots;
  const writeRoots = cwdOverride
    ? Array.from(new Set([...(writable || []), path.resolve(cwdOverride)]))
    : writable;

  return {
    async readText(relPath, maxBytes = 512000) {
      assertFsRead();
      const remote = getRemoteFs();
      if (remote) {
        const r = await remote.readFile(relPath, 'utf8', { maxBytes });
        return String(r.data || '');
      }
      const resolved = normalizeFilePathInput(relPath, cwd);
      const safe = assertAllowedPath(resolved, readRoots);
      const buf = await fs.readFile(safe, 'utf8');
      const text = String(buf || '');
      return text.length > maxBytes ? text.slice(0, maxBytes) : text;
    },
    async writeText(relPath, data) {
      assertFsWrite();
      const remote = getRemoteFs();
      if (remote) {
        await remote.writeFile(relPath, String(data || ''), 'utf8');
        return;
      }
      const resolved = normalizeFilePathInput(relPath, cwd);
      const safe = assertAllowedPath(resolved, writeRoots);
      await fs.mkdir(path.dirname(safe), { recursive: true });
      await fs.writeFile(safe, String(data || ''), 'utf8');
    },
    async mkdir(relDir) {
      assertFsWrite();
      const remote = getRemoteFs();
      if (remote) {
        await remote.mkdir(relDir);
        return;
      }
      const resolved = normalizeFilePathInput(relDir, cwd);
      const safe = assertAllowedPath(resolved, writeRoots);
      await fs.mkdir(safe, { recursive: true });
    },
    async listDir(relDir) {
      assertFsRead();
      const remote = getRemoteFs();
      if (remote) return remote.listDir(relDir);
      const resolved = normalizeFilePathInput(relDir, cwd);
      const safe = assertAllowedPath(resolved, readRoots);
      const names = await fs.readdir(safe, { withFileTypes: true });
      const out = [];
      for (const ent of names) {
        const full = path.join(safe, ent.name);
        let st;
        try {
          st = await fs.stat(full);
        } catch {
          continue;
        }
        out.push({
          name: ent.name,
          isDirectory: st.isDirectory(),
          size: st.size,
          mtimeMs: st.mtimeMs
        });
      }
      return out;
    },
    async deleteFile(relPath) {
      assertFsWrite();
      const remote = getRemoteFs();
      if (remote) {
        const safe = remote.resolve(relPath, remote.root);
        await remote.writeFile(relPath, '', 'utf8');
        return;
      }
      const resolved = normalizeFilePathInput(relPath, cwd);
      const safe = assertAllowedPath(resolved, writeRoots);
      await fs.unlink(safe);
    }
  };
}

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
 * @param {ReturnType<typeof createPlaybookStorage> extends never ? never : Parameters<typeof createPlaybookStorage>[0]} deps
 */
function createPlaybookRpcHandlers(deps) {
  const storageFactory = () => createPlaybookStorage(deps);

  function assertFsWrite() {
    deps.assertFsWrite();
  }

  function assertFsRead() {
    deps.assertFsRead();
  }

  async function indexPlaybook(workspacePath, entry, markdown) {
    await upsertPlaybookVector(deps.userDataPath, workspacePath, deps.getEmbeddingConfig(), entry, markdown);
  }

  return {
    'playbook.draft_create': async (payload = {}) => {
      assertFsWrite();
      requireWorkspacePath(payload.workspacePath);
      const storage = storageFactory();
      return createDraft(storage, payload);
    },

    'playbook.draft_list': async (payload = {}) => {
      assertFsRead();
      requireWorkspacePath(payload.workspacePath);
      const storage = storageFactory();
      const drafts = await listDrafts(storage);
      return { ok: true, drafts };
    },

    'playbook.confirm': async (payload = {}) => {
      assertFsWrite();
      const workspacePath = requireWorkspacePath(payload.workspacePath);
      const storage = storageFactory();
      return confirmDraft(storage, payload, async (entry) => {
        await indexPlaybook(workspacePath, entry, entry.markdown);
      });
    },

    'playbook.discard': async (payload = {}) => {
      assertFsWrite();
      requireWorkspacePath(payload.workspacePath);
      const storage = storageFactory();
      return discardDraft(storage, payload);
    },

    'playbook.recall': async (payload = {}) => {
      assertFsRead();
      const workspacePath = requireWorkspacePath(payload.workspacePath);
      const storage = storageFactory();
      const index = await readIndex(storage);
      const active = (index.entries || []).filter((e) => e && e.status === 'active');
      return recallPlaybooks({
        userData: deps.userDataPath,
        workspacePath,
        embeddingConfig: deps.getEmbeddingConfig(),
        catalogEntries: active,
        query: payload.query || '',
        limit: payload.limit || 3
      });
    },

    'playbook.list': async (payload = {}) => {
      assertFsRead();
      requireWorkspacePath(payload.workspacePath);
      const storage = storageFactory();
      const index = await readIndex(storage);
      return { ok: true, entries: index.entries || [] };
    }
  };
}

module.exports = {
  createPlaybookStorage,
  createPlaybookRpcHandlers
};
