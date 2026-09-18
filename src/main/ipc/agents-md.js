'use strict';

/**
 * @param {import('../context').MainIpcContext & {
 *   loadDieyunInstructions: () => unknown,
 *   openDieyunMdInEditor: () => unknown,
 *   formatDieyunBlock: (opts: object) => string
 * }} ctx
 */
function registerAgentsMdIpc(ctx) {
  const { ipcMain, loadDieyunInstructions, openDieyunMdInEditor, formatDieyunBlock } = ctx;

  ipcMain.handle('workspace:get-dieyun-md', () => loadDieyunInstructions());
  ipcMain.handle('workspace:open-dieyun-md', () => openDieyunMdInEditor());
  // Renderer 侧按相关性裁好内容后回传，由这里统一套 header/前言（文案单一来源）
  ipcMain.handle('workspace:format-dieyun-md', (_evt, payload) => {
    if (typeof formatDieyunBlock !== 'function') return '';
    const p = payload && typeof payload === 'object' ? payload : {};
    return formatDieyunBlock({
      content: p.content,
      filePath: p.filePath,
      modeHint: p.modeHint,
      maxChars: p.maxChars
    });
  });

  ipcMain.handle('embedding:test-builtin', async () => {
    try {
      const {
        embedWithBuiltin,
        BUILTIN_EMBEDDING_DIMENSIONS,
        hasBuiltinEmbeddingModel
      } = require('../../codebase/local-embedding');
      if (!hasBuiltinEmbeddingModel()) {
        return {
          ok: false,
          error: '内置向量模型未安装。请打开设置 → 组件，下载 bge-base-zh-v1.5，或手动安装 zip'
        };
      }
      const vectors = await embedWithBuiltin('叠云向量模型测试');
      const vec = vectors && vectors[0];
      if (!Array.isArray(vec) || vec.length !== BUILTIN_EMBEDDING_DIMENSIONS) {
        return {
          ok: false,
          error: `向量维度异常：${Array.isArray(vec) ? vec.length : 0}`
        };
      }
      return { ok: true, dimensions: vec.length };
    } catch (e) {
      return { ok: false, error: e.message || String(e) };
    }
  });
}

/**
 * AGENTS.md template/edit IPC (registered after app.whenReady).
 * @param {object} ctx
 */
function registerAgentsMdReadyIpc(ctx) {
  const { ipcMain } = ctx;
  const {
    loadBundledTemplate,
    applySectionUpdates,
    formatAgentsMdSystemBlock,
    parseMaintainerJson,
    contentHash
  } = require('../../agents-md');
  const { readAgentsMdPrefs, writeAgentsMdPrefs } = require('../../agent/agents-md-prefs');

  function userDataPath() {
    return typeof ctx.getUserDataPath === 'function' ? ctx.getUserDataPath() : '';
  }

  ipcMain.handle('agents-md:get-template', () => loadBundledTemplate());
  ipcMain.handle('agents-md:get-prefs', () => readAgentsMdPrefs(userDataPath()));
  ipcMain.handle('agents-md:set-prefs', (_evt, payload = {}) => {
    return writeAgentsMdPrefs(userDataPath(), payload);
  });
  ipcMain.handle('agents-md:apply-updates', (_evt, payload) => {
    const content = payload && payload.content != null ? String(payload.content) : '';
    const updates = payload && Array.isArray(payload.updates) ? payload.updates : [];
    const source = payload && payload.source ? String(payload.source) : 'agent';
    const result = applySectionUpdates(content, updates, { source });
    return { ...result, contentHash: contentHash(result.content) };
  });
  ipcMain.handle('agents-md:format-block', (_evt, payload) => {
    return formatAgentsMdSystemBlock({
      content: payload && payload.content,
      relativePath: payload && payload.relativePath,
      workspacePath: payload && payload.workspacePath
    });
  });
  ipcMain.handle('agents-md:parse-maintainer', (_evt, payload) => {
    return parseMaintainerJson(payload && payload.text);
  });
}

module.exports = { registerAgentsMdIpc, registerAgentsMdReadyIpc };
