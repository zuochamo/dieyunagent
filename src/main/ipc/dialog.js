'use strict';

/**
 * @param {import('../context').MainIpcContext} ctx
 */
function registerDialogIpc(ctx) {
  const { ipcMain, dialog, getMainWindow } = ctx;

  ipcMain.handle('dialog:pick-folder', async () => {
    const win = getMainWindow();
    const res = await dialog.showOpenDialog(win, {
      properties: ['openDirectory', 'createDirectory']
    });
    if (res.canceled || !res.filePaths.length) return null;
    return res.filePaths[0];
  });

  ipcMain.handle('dialog:pick-plugin-zip', async () => {
    const win = getMainWindow();
    const res = await dialog.showOpenDialog(win, {
      properties: ['openFile'],
      filters: [
        { name: 'Plugin Zip', extensions: ['zip'] },
        { name: 'All Files', extensions: ['*'] }
      ]
    });
    if (res.canceled || !res.filePaths.length) return null;
    return res.filePaths[0];
  });

  ipcMain.handle('dialog:pick-private-key', async () => {
    const win = getMainWindow();
    const res = await dialog.showOpenDialog(win, {
      properties: ['openFile'],
      filters: [
        { name: 'SSH Private Key', extensions: ['pem', 'key', 'ppk'] },
        { name: 'All Files', extensions: ['*'] }
      ]
    });
    if (res.canceled || !res.filePaths.length) return null;
    return res.filePaths[0];
  });

  ipcMain.handle('dialog:pick-files', async () => {
    const win = getMainWindow();
    const res = await dialog.showOpenDialog(win, {
      properties: ['openFile', 'multiSelections']
    });
    if (res.canceled || !res.filePaths.length) return [];
    return res.filePaths;
  });
}

module.exports = { registerDialogIpc };
