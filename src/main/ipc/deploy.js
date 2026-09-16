'use strict';

/**
 * Tier-A IPC: registered before app.whenReady (no gateway/services required).
 *
 * @param {import('./context').MainIpcContext & {
 *   getDeployUiDefaults: () => object
 * }} ctx
 */
function registerDeployIpc(ctx) {
  const { ipcMain, getDeployUiDefaults } = ctx;

  ipcMain.handle('deploy:get-ui-defaults', () => getDeployUiDefaults());
}

module.exports = { registerDeployIpc };
