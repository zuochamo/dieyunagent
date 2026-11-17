'use strict';

const { getEffectiveInputBudget } = require('../../agent/compaction-main');
const { applyTierRuntime } = require('../../agent/model-runtime-by-tier');

/**
 * Renderer / 手机端触发的压缩 IPC。
 *
 * 语义全在 `compaction-main.js`（预算解析）与 Rust `compaction.fold`（折叠本身）。
 * 这里只做参数归一：`tokenBudget` 缺省时才用磁盘 settings 算，别在调用点各算一份。
 *
 * @param {object} ctx
 */
function registerCompactionIpc(ctx) {
  const { ipcMain, getUserDataPath, getCoreBridge, ensureMainCompactionAgent, loadModelSettings } = ctx;

  ipcMain.handle('compaction:maybe-compact', async (_evt, payload = {}) => {
    const agent = ensureMainCompactionAgent();
    const userData = getUserDataPath();
    const settings = loadModelSettings(userData);
    const payloadModel = payload.model || settings.textModel || '';
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
      model: payloadModel,
      force: !!payload.force,
      toolsChars: payload.toolsChars,
      sessionId: payload.sessionId || null,
      // 服务端 usage 由 Renderer 的上一轮响应带上；没有就是 null（Rust 回落到估值）
      observedPromptTokens: payload.observedPromptTokens
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
}

module.exports = { registerCompactionIpc };
