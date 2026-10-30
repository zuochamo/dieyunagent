'use strict';

const { registerLlmIpc } = require('../../llm-stream-bridge');
const { loadModelSettings } = require('../../model-settings');

/**
 * 把语音相关设置推给手机端。
 *
 * 载荷**只有一份来源**：`AgentService.getSpeechSettings()`（手机端拉取时用的是同一个函数）。
 * 早先这里自己按 resolveSpeechApiConfig 拼了一遍，加「朗读（合成）」能力时就会
 * 出现「手机拉取有、推送没有」的两套字段。
 */
function broadcastSpeechSettingsToMobile(ctx) {
  const bridge = typeof ctx.getMobileBridge === 'function' ? ctx.getMobileBridge() : null;
  if (!bridge || typeof bridge.broadcast !== 'function') return;
  const agentService = typeof ctx.getAgentService === 'function' ? ctx.getAgentService() : null;
  const payload = agentService && typeof agentService.getSpeechSettings === 'function'
    ? agentService.getSpeechSettings()
    : null;
  if (!payload) return;
  bridge.broadcast({ type: 'settings.speech', at: Date.now(), ...payload });
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
    const baseUrl = payload && payload.baseUrl ? String(payload.baseUrl).trim() : '';
    const apiKey = payload && payload.apiKey ? String(payload.apiKey).trim() : '';
    const validate = !(payload && payload.validate === false);
    // 请求修饰随 payload 透传：检测请求必须与真实请求同一套头，
    // 否则会出现「检测失败但聊天正常」或反之。
    const requestOptions = {
      authMode: payload && payload.authMode ? String(payload.authMode).trim() : '',
      headers: payload && payload.headers ? payload.headers : undefined,
      userAgent: payload && payload.userAgent ? String(payload.userAgent).trim() : ''
    };
    try {
      const result = await fetchOpenAiModelList(baseUrl, apiKey, { validate, ...requestOptions });
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
