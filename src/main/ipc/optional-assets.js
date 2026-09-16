'use strict';

const { BrowserWindow } = require('electron');

/**
 * @param {object} ctx
 */
function registerOptionalAssetsIpc(ctx) {
  const {
    ipcMain,
    app,
    dialog,
    getMainWindow,
    getRemoteGatewayPackRoot,
    getActiveRemoteGatewayStatus,
    broadcastToRenderers
  } = ctx;

  ipcMain.handle('optional-assets:ensure', async (_evt, { assetId, force } = {}) => {
    const id = String(assetId || '').trim();
    if (!id) return { ok: false, error: 'assetId 必填' };
    try {
      const { ensureOptionalAsset, getMonacoVsUrl } = require('../../optional-assets/service');
      const root = await ensureOptionalAsset(id, {
        userDataPath: app.getPath('userData'),
        resourcesPath: process.resourcesPath,
        remoteGatewayPackRoot: getRemoteGatewayPackRoot(),
        force: force === true,
        onProgress: (payload) =>
          broadcastToRenderers('optional-assets:progress', { assetId: id, ...(payload || {}) })
      });
      if (id === 'bge-base-zh-v1.5') {
        require('../../codebase/local-embedding').resetBuiltinExtractor();
      }
      if (id === 'monaco-editor') {
        return { ok: true, vsUrl: getMonacoVsUrl(root) };
      }
      return { ok: true, path: root };
    } catch (e) {
      return { ok: false, error: e.message || String(e) };
    }
  });

  ipcMain.handle('optional-assets:install-from-file', async (_evt, { assetId } = {}) => {
    const id = String(assetId || '').trim();
    if (!id) return { ok: false, error: 'assetId 必填' };
    const win = BrowserWindow.getFocusedWindow() || getMainWindow();
    const { OPTIONAL_ASSETS } = require('../../optional-assets/manifest');
    const def = OPTIONAL_ASSETS[id];
    if (!def) return { ok: false, error: `未知组件: ${id}` };
    const filters =
      def.kind === 'tgz'
        ? [{ name: 'Tarball', extensions: ['gz', 'tgz', 'tar.gz'] }]
        : [
            { name: 'Archive', extensions: ['zip', 'tgz', 'gz'] },
            { name: 'All', extensions: ['*'] }
          ];
    const picked = await dialog.showOpenDialog(win, {
      title: `选择 ${def.label} 安装包`,
      properties: ['openFile'],
      filters
    });
    if (picked.canceled || !picked.filePaths || !picked.filePaths[0]) {
      return { ok: false, cancelled: true };
    }
    try {
      const { installOptionalAssetFromFile, getMonacoVsUrl } = require('../../optional-assets/service');
      const root = await installOptionalAssetFromFile(id, picked.filePaths[0], app.getPath('userData'), (payload) =>
        broadcastToRenderers('optional-assets:progress', { assetId: id, ...(payload || {}) })
      );
      if (id === 'bge-base-zh-v1.5') {
        require('../../codebase/local-embedding').resetBuiltinExtractor();
      }
      if (id === 'monaco-editor') {
        return { ok: true, vsUrl: getMonacoVsUrl(root) };
      }
      return { ok: true, path: root };
    } catch (e) {
      return { ok: false, error: e.message || String(e) };
    }
  });

  ipcMain.handle('components:status', async () => {
    const { getAllComponentsStatus } = require('../../optional-assets/components');
    const { isInflight } = require('../../optional-assets/service');
    const inflight = {};
    for (const id of ['bge-base-zh-v1.5', 'monaco-editor', 'remote-gateway-linux-node']) {
      if (isInflight(id)) inflight[id] = true;
    }
    return getAllComponentsStatus({
      userDataPath: app.getPath('userData'),
      resourcesPath: process.resourcesPath,
      remoteGatewayPackRoot: getRemoteGatewayPackRoot(),
      remoteGatewayStatus: getActiveRemoteGatewayStatus(),
      inflight
    });
  });

  ipcMain.handle('components:set-usage', (_evt, { componentId, inUse } = {}) => {
    const { beginComponentUse, endComponentUse } = require('../../optional-assets/usage');
    const id = String(componentId || '').trim();
    if (!id) return { ok: false };
    if (inUse) beginComponentUse(id);
    else endComponentUse(id);
    return { ok: true };
  });
}

module.exports = { registerOptionalAssetsIpc };
