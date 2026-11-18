// @ts-check
'use strict';

/**
 * 内网 peer 的 IPC（Renderer ↔ Main）。
 *
 * 形状约定与其它 IPC 一致：`{ ok: true, ... }` / `{ ok: false, error }`。
 * **动作语义不在本文件**：全部在 `src/peer/actions.js`（headless 的浏览器界面走 `/ws`
 * 调的是同一份），这里只把 `peer:<name>` 通道挂到那张动作表上 —— 加一个动作改两处
 * （actions 表 + preload）就够，不会出现「桌面有、网页没有」的分叉。
 */

const { createPeerActions, PEER_ACTION_NAMES } = require('../../peer/actions');

/**
 * @param {object} ctx
 * @param {import('electron').IpcMain} ctx.ipcMain
 * @param {() => any} ctx.getPeerCoordinator
 */
function registerPeerIpc(ctx) {
  const { ipcMain, getPeerCoordinator } = ctx;
  const actions = createPeerActions(getPeerCoordinator);

  for (const name of PEER_ACTION_NAMES) {
    ipcMain.handle(`peer:${name}`, (_evt, payload) => actions.handle(name, payload));
  }
}

module.exports = { registerPeerIpc };
