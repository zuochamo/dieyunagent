'use strict';

const { createSharedMemoryActions } = require('../../memory-shared/actions');

/**
 * 扩展页签「共享记忆」的 IPC（桌面端）。
 *
 * 这里**只做传输注册**：五个动作的唯一实现在 `src/memory-shared/actions.js`，浏览器版
 * （headless `/ws`）共用同一份。不在这里拼 SQL、不在这里调模型、不在这里判断「算不算连上」。
 *
 * @param {{
 *   ipcMain: import('electron').IpcMain,
 *   getSharedMemory: () => any,
 *   getKnowledgeMaintainer?: () => any,
 *   log?: { info?: Function, warn?: Function }
 * }} ctx
 */
function registerSharedMemoryIpc(ctx) {
  const { ipcMain } = ctx;
  const actions = createSharedMemoryActions(ctx);

  ipcMain.handle('shared-memory:status', () => actions.status());
  ipcMain.handle('shared-memory:save', (_evt, patch = {}) => actions.save(patch || {}));
  ipcMain.handle('shared-memory:test', (_evt, patch = {}) => actions.test(patch || {}));
  ipcMain.handle('shared-memory:probe', () => actions.probe());
  ipcMain.handle('shared-memory:consolidate', () => actions.consolidate());
}

module.exports = { registerSharedMemoryIpc };
