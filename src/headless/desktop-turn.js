'use strict';

/**
 * 浏览器里的桌面界面（`/app/`）跑一轮对话。
 *
 * 为什么需要这一层（别再想别的办法绕开）：
 *  - 桌面窗口里，聊天轮是 `Renderer → preload IPC → Main`，Main 用 `runRustAgentLoop` 驱动
 *    Rust `agent.loop.*`，工具在 Main 执行。Renderer 负责拼 prompt / 选模型 / 展示。
 *  - 浏览器里没有 Main，也没有 IPC。但**循环只有一份实现**（`src/agent/rust-loop-runner.js`），
 *    所以这里不是「再写一个循环」，而是把 Main 那个 handler（`agent:rust-loop-run`）在这台
 *    服务器上等价地跑一遍：拿渲染层送上来的 messages/tools/apiConfig，交给同一个
 *    `runRustAgentLoop`，工具交给同一份 `createMainToolBridge()`，phase 事件推回浏览器。
 *  - 结果形状与 `agent:rust-loop-run` 保持一致（`content` / `trace` / `messages` /
 *    `hitRoundLimit`），渲染层不用改。
 *
 * 传输：手机端桥的 `/ws`（同一套 `{type:'call'|'result'|'event'}` 线协议），因为浏览器里
 * 那是唯一一条能跟 Main 侧说话的通道；phase 走 `event` 帧，按 `cancelToken` 归属到各自页面。
 *
 * @param {{
 *   gateway: { invokeRpc: Function },
 *   getCoreBridge: () => any,
 *   createToolBridge: () => any,
 *   getCompactionAgent: () => any,
 *   userData: string,
 *   loadModelSettings: (userData: string) => object,
 *   log?: (msg: string) => void
 * }} deps
 */
function createDesktopTurn(deps) {
  const { gateway, getCoreBridge, createToolBridge, getCompactionAgent, userData } = deps;
  const loadModelSettings =
    typeof deps.loadModelSettings === 'function'
      ? deps.loadModelSettings
      : (ud) => require('../model-settings').loadModelSettings(ud);
  const log = typeof deps.log === 'function' ? deps.log : () => {};

  const { runRustAgentLoop } = require('../agent/rust-loop-runner');
  const { resolveLoopToolCallLimit } = require('../agent/agent-limits');
  const { applyTierRuntime, resolveContextTierIdFromSettings } = require('../agent/model-runtime-by-tier');
  const { clampModelRuntimeValue } = require('../agent/model-runtime-schema');
  const { getEffectiveInputBudget } = require('../agent/compaction-main');
  const { buildLoopCompactionHandler } = require('../agent/compaction-loop');
  const { isAbortError } = require('../llm-reconnect-retry');
  const { clearToolHarnessSessionsForSession } = require('../agent/tool-harness');

  /** cancelToken → { abortController, sessionId } */
  const running = new Map();

  /**
   * @param {object} payload 渲染层 `agentRustLoopRun` 的参数
   * @param {(frame: object) => void} sendPhase 推 phase 事件（event 帧）
   */
  async function runTurn(payload, sendPhase) {
    const coreBridge = getCoreBridge();
    if (!coreBridge || typeof coreBridge.isReady !== 'function' || !coreBridge.isReady()) {
      throw new Error('dieyun-core 未就绪');
    }
    const p = payload && typeof payload === 'object' ? payload : {};
    const cancelToken = String(p.cancelToken || `rl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`);
    const sessionId = p.sessionId || (p.startParams && p.startParams.sessionId) || undefined;
    const model = p.model || (p.startParams && p.startParams.model) || '';

    const rawSettings = loadModelSettings(userData);
    const contextTierId = p.contextTierId || resolveContextTierIdFromSettings(rawSettings, model);
    const runSettings = applyTierRuntime(rawSettings, userData, { tierId: contextTierId, model });
    const llmModel = model || runSettings.textModel || '';
    if (!llmModel) throw new Error('未选择模型');
    const tokenBudget = getEffectiveInputBudget(runSettings, llmModel);

    const apiConfig = p.apiConfig && typeof p.apiConfig === 'object' ? p.apiConfig : {};
    const baseUrl = apiConfig.baseUrl || runSettings.baseUrl;
    const apiKey = apiConfig.apiKey || runSettings.apiKey;
    // 逐字段重建会丢 headers / authMode / userAgent（与 Main handler 同一条注意点）
    const apiCfg = { ...apiConfig, baseUrl, apiKey, model: llmModel, sessionId };

    const startParams = { ...(p.startParams || {}) };
    startParams.model = llmModel;
    if (!startParams.maxToolCalls) startParams.maxToolCalls = resolveLoopToolCallLimit(runSettings);
    if (!startParams.maxRounds) startParams.maxRounds = clampModelRuntimeValue('agentMaxRounds', runSettings.agentMaxRounds);
    const workspacePath = String(p.runWorkspaceRoot || startParams.workspaceRoot || '').trim() || undefined;
    if (workspacePath && !startParams.workspaceRoot) startParams.workspaceRoot = workspacePath;

    const abortController = new AbortController();
    running.set(cancelToken, { abortController, sessionId, ws: sendPhase.ws || null });
    const toolBridge = createToolBridge();
    try {
      const result = await runRustAgentLoop({
        coreBridge,
        llm: apiCfg,
        settings: runSettings,
        userData,
        useStream: true,
        signal: abortController.signal,
        sessionId,
        runSource: 'chat',
        browserVision: p.browserVision === true,
        contextAudit: p.contextAudit || null,
        contextTierId,
        startParams,
        onPhase: (phase, data) => sendPhase({ cancelToken, phase, data: data || {} }),
        compactMessages: buildLoopCompactionHandler({
          compactionAgent: getCompactionAgent(),
          gateway,
          userData,
          sessionId,
          workspacePath,
          tokenBudget,
          contextTierId,
          apiConfig: apiCfg,
          model: llmModel
        }),
        turnEndSynthesis: true,
        delegateTool: async (name, args) =>
          toolBridge.executeAgentTool(name, args, {
            workspacePath,
            sessionId,
            model: llmModel,
            contextTierId
          })
      });
      return result && typeof result === 'object' ? result : { content: '', trace: [], messages: [] };
    } catch (err) {
      if (!isAbortError(err)) throw err;
      // 用户点了停止：与 Main 一致地返回「已中止」而不是抛错，渲染层才不会弹失败
      sendPhase({ cancelToken, phase: 'done', data: { aborted: true } });
      return { aborted: true, phase: 'done', content: '', trace: [], hitRoundLimit: false, messages: [] };
    } finally {
      running.delete(cancelToken);
      try {
        clearToolHarnessSessionsForSession(sessionId);
      } catch {
        // 清理失败不影响本轮结果
      }
    }
  }

  /**
   * 手机端桥的 call 分派（见 `src/mobile/bridge.js#_handleCall`）。
   * @param {'desktop.loop_run'|'desktop.loop_cancel'} method
   */
  async function handleCall(method, params, sendEvent, ws) {
    if (method === 'desktop.loop_cancel') {
      const cancelToken = String((params && params.cancelToken) || '');
      const box = running.get(cancelToken);
      if (box) {
        box.abortController.abort();
        log(`桌面界面停止本轮：${cancelToken}`);
      }
      return { stopped: !!box };
    }
    if (method === 'desktop.loop_run') {
      // 记下归属连接：页面关掉/刷新就和「点了停止」一样，不能留着循环在后台烧模型
      const send = (frame) => sendEvent(frame);
      send.ws = ws || null;
      return runTurn((params && params.payload) || {}, send);
    }
    throw new Error('未知方法: ' + method);
  }

  /** 连接断开：中止它发起的那些轮次 */
  function cancelForSocket(ws) {
    for (const [token, box] of running) {
      if (box.ws !== ws) continue;
      box.abortController.abort();
      running.delete(token);
    }
  }

  return { handleCall, runTurn, cancelForSocket, running };
}

module.exports = { createDesktopTurn };
