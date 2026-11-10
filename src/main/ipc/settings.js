'use strict';

const { registerLlmIpc } = require('../../llm-stream-bridge');
const { loadModelSettings } = require('../../model-settings');
const { detectModelsFromPayload } = require('../../openai-models');
const { applyModelSettings } = require('../../model-settings-apply');

/**
 * @param {import('../context').MainIpcContext & {
 *   getUserDataPath: () => string,
 *   getLocalGateway: () => import('../../gateway/server').LocalGateway | null,
 *   getMobileBridge: () => import('../../mobile/bridge').MobileBridge | null,
 *   getAgentService: () => any,
 *   loadModelSettings: (userData: string) => object,
 *   log: { warn: (msg: string, ...args: unknown[]) => void }
 * }} ctx
 */
function registerSettingsIpc(ctx) {
  const {
    ipcMain,
    getUserDataPath,
    getLocalGateway,
    loadModelSettings,
    log
  } = ctx;

  ipcMain.handle('model:sync-settings', async (_evt, settings) =>
    // 落盘 + 推语音设置给手机端 + 让 core 重读配置，三件事的单一来源
    // （服务器版 desktop.save_model_settings 也用它）
    applyModelSettings({
      userData: getUserDataPath(),
      settings,
      gateway: getLocalGateway(),
      mobileBridge: typeof ctx.getMobileBridge === 'function' ? ctx.getMobileBridge() : null,
      agentService: typeof ctx.getAgentService === 'function' ? ctx.getAgentService() : null,
      log: (m) => log.warn(m)
    })
  );

  ipcMain.handle('model:get-settings', async () => loadModelSettings(getUserDataPath()));

  const { loadLimitsByTierFromDisk, saveAgentLimitsToDisk } = require('../../agent/agent-limits');
  ipcMain.handle('agent:sync-limits', async (_evt, limits) => {
    if (limits && typeof limits === 'object') {
      saveAgentLimitsToDisk(getUserDataPath(), limits);
    }
    return { ok: true };
  });
  ipcMain.handle('agent:get-limits', async () => loadLimitsByTierFromDisk(getUserDataPath()));

  // 「模型与段预算」按档持久化：Main 侧的压缩 / planner / 定时计划都从这里读，
  // 磁盘那一份是唯一真相，Renderer 的 localStorage 只是同步读的缓存。
  const {
    loadRuntimeByTierFromMain,
    saveRuntimeByTierToMain
  } = require('../../agent/model-runtime-by-tier');
  ipcMain.handle('model:sync-runtime-by-tier', async (_evt, byTier) => {
    if (byTier && typeof byTier === 'object') {
      saveRuntimeByTierToMain(getUserDataPath(), byTier);
    }
    return { ok: true };
  });
  ipcMain.handle('model:get-runtime-by-tier', async () => loadRuntimeByTierFromMain(getUserDataPath()));

  registerLlmIpc(ipcMain);

  ipcMain.handle('models:fetch-list', async (_evt, payload) => {
    // payload → 结果的语义在 openai-models 里（服务器版的 desktop.fetch_models 共用同一份）
    const result = await detectModelsFromPayload(payload);
    if (!result.ok) {
      log.warn('拉取模型列表失败:', result.error);
      return result;
    }
    if (result.removed > 0) {
      log.info(
        `模型可用性检测：列表 ${result.listed} 个，探测 ${result.probed} 个，剔除不可用 ${result.removed} 个，保留 ${result.validated} 个`
      );
    }
    return result;
  });
}

module.exports = { registerSettingsIpc };
