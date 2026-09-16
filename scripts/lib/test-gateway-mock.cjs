'use strict';

const fs = require('fs/promises');
const path = require('path');

/**
 * 轻量 mock Gateway（不依赖 better-sqlite3），用于 CLI 测试 tool bridge
 * @param {string} workspaceRoot
 */
function createMockGateway(workspaceRoot) {
  const root = path.resolve(workspaceRoot);

  function resolveSafe(p) {
    const fp = path.resolve(root, String(p || ''));
    if (!fp.startsWith(root)) throw new Error('path outside workspace');
    return fp;
  }

  return {
    invokeRpc: async (method, params = {}) => {
      switch (method) {
        case 'fs.read_file': {
          const fp = resolveSafe(params.filePath);
          const data = await fs.readFile(fp, params.encoding || 'utf8');
          return { ok: true, data: String(data) };
        }
        case 'fs.list_dir': {
          const dp = resolveSafe(params.dirPath || '.');
          const items = await fs.readdir(dp, { withFileTypes: true });
          return {
            entries: items.map((e) => ({
              name: e.name,
              isDirectory: e.isDirectory()
            }))
          };
        }
        case 'codebase.search':
          return { ok: true, results: [], needsIndex: true, query: params.query || '' };
        default:
          throw new Error(`mock gateway 未实现: ${method}`);
      }
    },
    async stop() {}
  };
}

module.exports = { createMockGateway };
