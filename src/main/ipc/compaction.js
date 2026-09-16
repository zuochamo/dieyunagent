'use strict';

const { createMainCompactionAgent, getEffectiveInputBudget } = require('../../agent/compaction-main');

/**
 * @param {object} ctx
 */
function registerCompactionIpc(ctx) {
  const {
    ipcMain,
    getUserDataPath,
    getCoreBridge,
    getMainCompactionAgent,
    setMainCompactionAgent,
    loadModelSettings
  } = ctx;

  function ensureMainCompactionAgent() {
    let agent = getMainCompactionAgent();
    if (!agent) {
      agent = createMainCompactionAgent(getUserDataPath(), getCoreBridge());
      setMainCompactionAgent(agent);
    }
    return agent;
  }

  ipcMain.handle('compaction:maybe-compact', async (_evt, payload = {}) => {
    const agent = ensureMainCompactionAgent();
    const userData = getUserDataPath();
    const settings = loadModelSettings(userData);
    const payloadModel =
      payload.model || (payload.apiConfig && payload.apiConfig.model) || settings.textModel || '';
    const tokenBudget =
      Number(payload.tokenBudget) > 0
        ? Number(payload.tokenBudget)
        : getEffectiveInputBudget(settings, payloadModel);
    return agent.maybeCompactMessages(Array.isArray(payload.messages) ? payload.messages : [], {
      tokenBudget,
      force: !!payload.force,
      sessionId: payload.sessionId || null,
      apiConfig: {
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
