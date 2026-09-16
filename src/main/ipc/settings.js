'use strict';

const { registerLlmIpc } = require('../../llm-stream-bridge');
const { loadModelSettings, resolveSpeechApiConfig } = require('../../model-settings');

function broadcastSpeechSettingsToMobile(ctx) {
  const bridge = typeof ctx.getMobileBridge === 'function' ? ctx.getMobileBridge() : null;
  if (!bridge || typeof bridge.broadcast !== 'function') return;
  const settings = loadModelSettings(ctx.getUserDataPath());
  const cfg = resolveSpeechApiConfig(settings);
  bridge.broadcast({
    type: 'settings.speech',
    at: Date.now(),
    model: cfg.model || 'whisper-1',
    language: cfg.language || 'zh'
  });
}

/**
 * @param {import('../context').MainIpcContext & {
 *   getUserDataPath: () => string,
 *   getLocalGateway: () => import('../../gateway/server').LocalGateway | null,
 *   getMobileBridge: () => import('../../mobile/bridge').MobileBridge | null,
 *   saveModelSettings: (userData: string, settings: object) => void,
 *   loadModelSettings: (userData: string) => object,
 *   fetchOpenAiModelList: (baseUrl: string, apiKey: string, opts: object) => Promise<object>,
 *   log: { warn: (msg: string, ...args: unknown[]) => void }
 * }} ctx
 */
function registerSettingsIpc(ctx) {
  const {
    ipcMain,
    getUserDataPath,
    getLocalGateway,
    saveModelSettings,
    loadModelSettings,
    fetchOpenAiModelList,
    log
  } = ctx;

  ipcMain.handle('model:sync-settings', async (_evt, settings) => {
    if (settings && typeof settings === 'object') {
      saveModelSettings(getUserDataPath(), settings);
      broadcastSpeechSettingsToMobile(ctx);
    }
    const localGateway = getLocalGateway();
    if (localGateway) {
      void localGateway._syncRustCoreConfig();
      void localGateway.syncRemoteIndexCoreConfig();
    }
    return { ok: true };
  });

  ipcMain.handle('model:get-settings', async () => loadModelSettings(getUserDataPath()));

  const { loadLimitsByTierFromDisk, saveAgentLimitsToDisk } = require('../../agent/agent-limits');
  ipcMain.handle('agent:sync-limits', async (_evt, limits) => {
    if (limits && typeof limits === 'object') {
      saveAgentLimitsToDisk(getUserDataPath(), limits);
    }
    return { ok: true };
  });
  ipcMain.handle('agent:get-limits', async () => loadLimitsByTierFromDisk(getUserDataPath()));

  registerLlmIpc(ipcMain);

  ipcMain.handle('models:fetch-list', async (_evt, payload) => {
    const baseUrl = payload && payload.baseUrl ? String(payload.baseUrl).trim() : '';
    const apiKey = payload && payload.apiKey ? String(payload.apiKey).trim() : '';
    const validate = !(payload && payload.validate === false);
    try {
      const result = await fetchOpenAiModelList(baseUrl, apiKey, { validate });
      if (result.removed > 0) {
        log.info(
          `模型可用性检测：列表 ${result.listed} 个，探测 ${result.probed} 个，剔除不可用 ${result.removed} 个，保留 ${result.validated} 个`
        );
      }
      return { ok: true, ...result };
    } catch (err) {
      log.warn('拉取模型列表失败:', err && (err.message || err));
      return { ok: false, error: err && (err.message || String(err)), models: [] };
    }
  });
}

module.exports = { registerSettingsIpc };
