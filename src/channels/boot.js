'use strict';

const { createChannelStore } = require('./store');
const { createChannelRuntime } = require('./runtime');
const { createChannelTurnRunner } = require('./agent-turn');

/**
 * 频道运行时的装配点（Main）。形状照 `plans/boot`：这里只把依赖接起来，
 * 「一条频道怎么连、怎么跑一轮」分别在 `runtime.js` / `agent-turn.js`。
 *
 * 启动时机：等窗口与 Gateway / dieyun-core 都就绪后再 `startEnabled()` ——
 * 频道连接是后台常驻资源，不该和首屏抢启动时间，也不该在 core 未就绪时白跑一轮。
 *
 * @param {{
 *   userData: string,
 *   safeStorage?: import('electron').SafeStorage,
 *   getLocalGateway: () => any,
 *   getCoreBridge: () => any,
 *   getMcpRuntime: () => any,
 *   getCompactionAgent: () => any,
 *   createToolBridge: (webContents: any) => any,
 *   listMcpServers?: (userDataPath: string) => any[],
 *   notifySessionsChanged?: (payload: { channelId: string, sessionId: string, title: string }) => void,
 *   log?: { info?: Function, warn?: Function } | Function
 * }} deps
 */
function bootChannelsRuntime(deps) {
  const rawLog = deps.log;
  const log =
    typeof rawLog === 'function'
      ? rawLog
      : (msg) => {
          if (rawLog && typeof rawLog.info === 'function') rawLog.info(msg);
        };

  const channelStore = createChannelStore({
    userDataPath: deps.userData,
    safeStorage: deps.safeStorage,
    log
  });

  const turnRunner = createChannelTurnRunner({
    store: channelStore,
    userData: deps.userData,
    getGateway: deps.getLocalGateway,
    getCoreBridge: deps.getCoreBridge,
    getMcpRuntime: deps.getMcpRuntime,
    getCompactionAgent: deps.getCompactionAgent,
    createToolBridge: deps.createToolBridge,
    listMcpServers: deps.listMcpServers,
    // 共享记忆（跨机）：频道跑一轮也用同一个实例（扩展开着才非 null）
    getSharedMemory: deps.getSharedMemory,
    notifySessionsChanged: deps.notifySessionsChanged,
    log
  });

  const channelRuntime = createChannelRuntime({
    store: channelStore,
    log,
    runTurn: turnRunner.runTurn
  });

  return { channelStore, channelRuntime };
}

module.exports = { bootChannelsRuntime };
