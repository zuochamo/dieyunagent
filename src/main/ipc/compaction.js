'use strict';

const { getEffectiveInputBudget } = require('../../agent/compaction-main');
const { applyTierRuntime } = require('../../agent/model-runtime-by-tier');

/**
 * @param {object} ctx
 */
function registerCompactionIpc(ctx) {
  const {
    ipcMain,
    getUserDataPath,
    getCoreBridge,
    getMainCompactionAgent,
    // 压缩实例的唯一创建入口（main-entry 单例）；本模块不再自建，避免出现第二个实例
    ensureMainCompactionAgent,
    loadModelSettings
  } = ctx;

  ipcMain.handle('compaction:maybe-compact', async (_evt, payload = {}) => {
    const agent = ensureMainCompactionAgent();
    const userData = getUserDataPath();
    const settings = loadModelSettings(userData);
    const payloadModel =
      payload.model || (payload.apiConfig && payload.apiConfig.model) || settings.textModel || '';
    const tokenBudget =
      Number(payload.tokenBudget) > 0
        ? Number(payload.tokenBudget)
        : getEffectiveInputBudget(
            applyTierRuntime(settings, userData, {
              tierId: payload.contextTierId,
              model: payloadModel
            }),
            payloadModel
          );
    return agent.maybeCompactMessages(Array.isArray(payload.messages) ? payload.messages : [], {
      tokenBudget,
      contextTierId: payload.contextTierId,
      force: !!payload.force,
      toolsChars: payload.toolsChars,
      sessionId: payload.sessionId || null,
      // 整体继承 payload.apiConfig：逐字段重建会丢掉 headers / authMode / userAgent
      apiConfig: {
        ...(payload.apiConfig || {}),
        baseUrl: (payload.apiConfig && payload.apiConfig.baseUrl) || settings.baseUrl,
        apiKey: (payload.apiConfig && payload.apiConfig.apiKey) || settings.apiKey,
        model:
          payload.model || (payload.apiConfig && payload.apiConfig.model) || settings.textModel || ''
      },
      model: payload.model || (payload.apiConfig && payload.apiConfig.model) || settings.textModel || ''
    });
  });

  ipcMain.handle('compaction:estimate-tokens', async (_evt, payload = {}) => {
    const messages = Array.isArray(payload.messages) ? payload.messages : [];
    const coreBridge = getCoreBridge();
    if (!coreBridge || !coreBridge.isReady()) {
      return { tokens: null, error: 'rust_core_unavailable' };
    }
    try {
      return await coreBridge.invoke('compaction.estimate', { messages }, 10000);
    } catch (e) {
      return { tokens: null, error: e.message || String(e) };
    }
  });

  ipcMain.handle('compaction:reset-state', async (_evt, { sessionId } = {}) => {
    const mainCompactionAgent = getMainCompactionAgent();
    if (mainCompactionAgent && mainCompactionAgent.resetCompactionState) {
      mainCompactionAgent.resetCompactionState(sessionId || null);
    }
    return { ok: true };
  });
}

module.exports = { registerCompactionIpc };
