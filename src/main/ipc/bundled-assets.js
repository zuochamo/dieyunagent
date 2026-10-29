'use strict';

/**
 * 内置资产的只读查询 IPC。没有下载 / 安装 / 进度 —— 资产随安装包发布。
 */
const { ipcMain } = require('electron');
const { getMonacoVsUrl } = require('../../bundled-assets/monaco');

function registerBundledAssetsIpc() {
  ipcMain.handle('bundled-assets:monaco-vs-url', async () => {
    try {
      const vsUrl = getMonacoVsUrl();
      if (!vsUrl) {
        return { ok: false, error: '内置 Monaco 编辑器缺失（请重新安装应用）' };
      }
      return { ok: true, vsUrl };
    } catch (err) {
      return { ok: false, error: err.message || String(err) };
    }
  });
}

module.exports = { registerBundledAssetsIpc };
