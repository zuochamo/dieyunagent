'use strict';

const { runRustAgentLoop } = require('../../agent/rust-loop-runner');
const { createSubagentRunner } = require('../../agent/subagent-runner');
const {
  createLiveLoopTraceTracker,
  mapLoopTraceToUi,
  mergeIsolatedCards
} = require('../../agent/live-loop-trace');
const { createMainPlannerRunner } = require('../../agent/planner-runner-main');
const { createMainCompactionAgent, getEffectiveInputBudget } = require('../../agent/compaction-main');
const { summarizeTelemetry } = require('../../agent/tool-telemetry');
const {
  ensureRunAbortController,
  abortRun,
  abortSessionRuns,
  clearRunAbortController
} = require('../../agent/run-cancel-registry');

/**
 * Agent rust-loop / planner / coordinator / AgentService IPC.
 * @param {object} ctx
 */
function registerAgentRuntimeIpc(ctx) {
  const {
    ipcMain,
    rustLoopCancels,
    plannerRunCancels,
    abortedAgentCancelTokens,
    getCoreBridge,
    getUserDataPath,
    getLocalGateway,
    getAgentCoordinator,
    getSubagentStore,
    getAgentService,
    getWorktreeService,
    getMainCompactionAgent,
    setMainCompactionAgent,
    createRustLoopToolBridge,
    resolveAgentRunWorkspacePath,
    workspaceRootPath,
    dieyunHome,
    loadModelSettings,
    listMcpServersForUi,
    safeWebContentsSend,
    canSendToWebContents,
    killActiveShellChildren,
    clearToolHarnessSessionsForSession
  } = ctx;

  const live = {
    get coreBridge() {
      return getCoreBridge();
    },
    get userData() {
      return getUserDataPath();
    },
    get localGateway() {
      return getLocalGateway();
    },
    get agentCoordinator() {
      return getAgentCoordinator();
    },
    get subagentStore() {
      return getSubagentStore();
    },
    get agentService() {
      return getAgentService();
    },
    get worktreeService() {
      return getWorktreeService();
    },
    get mainCompactionAgent() {
      return getMainCompactionAgent();
    },
    set mainCompactionAgent(v) {
      setMainCompactionAgent(v);
    },
    createRustLoopToolBridge,
    resolveAgentRunWorkspacePath,
    workspaceRootPath,
    dieyunHome,
    loadModelSettings,
    safeWebContentsSend,
    canSendToWebContents,
    killActiveShellChildren,
    clearToolHarnessSessionsForSession
  };

  ipcMain.handle('agent:rust-loop-ping', async () => {
    if (!live.coreBridge || !live.coreBridge.isReady()) {
      return { ok: false, error: 'rust_core_unavailable' };
    }
    try {
      return await live.coreBridge.invoke('agent.ping', {}, 10000);
    } catch (e) {
      return { ok: false, error: e.message || String(e) };
    }
  });

  ipcMain.handle('agent:prep-system-prompt', async (_evt, payload = {}) => {
    const gateway = live.localGateway;
    if (!gateway || typeof gateway.invokeRpc !== 'function') {
      throw new Error('Gateway 未就绪');
    }
    const { prepSystemPrompt, resolveAgentHome } = require('../../agent/system-prompt-prep');
    const userData = live.userData;
    const snapshot = payload && typeof payload === 'object' ? payload : {};
    const wsPath =
      (snapshot.workspaceInfo && snapshot.workspaceInfo.workspacePath) ||
      snapshot.runWorkspaceRoot ||
      null;
    const path = require('path');
    const { scanSkills, readSkillContent, assertReadableSkillPath } = require('../../skills/scanner');
    const { recallSkills } = require('../../skills/vector-index');
    const { getEmbeddingConfig } = require('../../model-settings');
    const { getScanRoots, filterAccessibleSkillRoots } = require('../../agent-home');
    return prepSystemPrompt(snapshot, {
      invokeRpc: (method, params) => gateway.invokeRpc(method, params),
      getPermissions: () => gateway.getPermissions(),
      getAgentHome: () => resolveAgentHome(userData, wsPath),
      userDataPath: userData,
      listMcpServers: () =>
        typeof listMcpServersForUi === 'function' ? listMcpServersForUi(userData) : [],
      skills: {
        scan: () => scanSkills({ userData, workspacePath: wsPath }),
        recall: async ({ query, enabledIds, limit }) => {
          const settings = loadModelSettings(userData);
          const embeddingConfig = getEmbeddingConfig(settings);
          return recallSkills({
            userData,
            workspacePath: wsPath,
            embeddingConfig,
            enabledIds: Array.isArray(enabledIds) ? enabledIds : [],
            query: query || '',
            limit: limit || 8
          });
        },
        read: async (skillPath) => {
          const roots = filterAccessibleSkillRoots(
            getScanRoots(userData, wsPath).map((r) => path.resolve(r))
          );
          assertReadableSkillPath(skillPath, roots);
          return readSkillContent(skillPath);
        }
      }
    });
  });

  ipcMain.handle('agent:rust-loop-run', async (evt, payload = {}) => {
    if (!live.coreBridge || !live.coreBridge.isReady()) {
      throw new Error('dieyun-core 未就绪');
    }
    const cancelToken = String(
      payload.cancelToken || `rl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    );
    if (abortedAgentCancelTokens.has(cancelToken)) {
      return {
        aborted: true,
        phase: 'done',
        content: '',
        trace: [],
        hitRoundLimit: false,
        messages: []
      };
    }
    const abortController = new AbortController();
    const entry = {
      runId: null,
      aborted: false,
      abortController,
      sessionId: payload.sessionId || null
    };
    rustLoopCancels.set(cancelToken, entry);
    const settings = live.loadModelSettings(live.userData);
    const apiConfig = payload.apiConfig || {};
    const baseUrl = apiConfig.baseUrl || settings.baseUrl;
    const apiKey = apiConfig.apiKey || settings.apiKey;
    let workspacePath =
      payload.runWorkspaceRoot ||
      payload.workspaceRoot ||
      (payload.startParams && payload.startParams.workspaceRoot) ||
      null;
    if (!workspacePath && payload.sessionId) {
      workspacePath = await live.resolveAgentRunWorkspacePath(payload.sessionId);
    }
    // 有 sessionId 时禁止回落到当前视图工作区，避免并行本地任务串台
    if (!workspacePath && !payload.sessionId) {
      workspacePath = live.workspaceRootPath();
    }
    const ctx = {
      workspacePath: workspacePath || undefined,
      worktreePath: payload.worktreePath || undefined,
      sessionId: payload.sessionId || undefined,
      undoTurnId: payload.undoTurnId || undefined,
      model:
        payload.model ||
        (payload.startParams && payload.startParams.model) ||
        undefined,
      contextTierId: payload.contextTierId || undefined,
      taskTier: payload.taskTier || (payload.startParams && payload.startParams.taskTier) || undefined,
      longHorizon: !!(
        payload.longHorizon ||
        (payload.startParams && payload.startParams.longHorizon)
      ),
      runId: undefined,
      // 本次运行实际使用的模型路由（Renderer 传入）：
      // plan_create 等 Main 侧要自己调模型的地方据此解析配置，勿只看顶层 settings.apiKey
      modelRoute: payload.modelRoute || undefined,
      browserVision: payload.browserVision === true
    };
    const { resolveContextTierIdForNode } = require('../../agent/agent-limits');
    if (!ctx.contextTierId && ctx.model) {
      ctx.contextTierId = resolveContextTierIdForNode(live.userData, ctx.model);
    }
    const sendPhase = (phase, data) => {
      live.safeWebContentsSend(evt.sender, 'agent:rust-loop-phase', {
        cancelToken,
        phase,
        data: data || {}
      });
    };
    let runFinishedOk = false;
    try {
      const startParams = { ...(payload.startParams || {}) };
      if (!startParams.workspaceRoot && workspacePath) {
        startParams.workspaceRoot = workspacePath;
      }
      if (!live.mainCompactionAgent) {
        live.mainCompactionAgent = createMainCompactionAgent(live.userData, live.coreBridge);
      }
      const sessionModel =
        payload.model ||
        startParams.model ||
        settings.textModel ||
        '';
      const tokenBudget = getEffectiveInputBudget(settings, sessionModel);
      // 整体继承 payload.apiConfig：逐字段重建会丢掉 headers / authMode / userAgent，
      // 结果就是「设置页配了自定义头，主循环却不带」。压缩走同一份 apiCfg。
      const apiCfg = {
        ...apiConfig,
        baseUrl,
        apiKey,
        model: sessionModel,
        sessionId: payload.sessionId || undefined
      };
      // 本轮开始先清空浏览器日志缓冲，避免上一轮/别的会话的残留错误触发本轮完成验收提示
      if (live.localGateway && typeof live.localGateway.invokeRpc === 'function') {
        live.localGateway.invokeRpc('browser.reset_logs', {}).catch(() => {});
      }
      const toolBridge = live.createRustLoopToolBridge(evt.sender);
      // 只读并发调研子 Agent。Agent 主循环是「协调者」，Renderer 已在工具集里注入 subagent；
      // 这里只负责执行：子 Agent 跑一次完整的内层循环，工具集是 Explore 只读白名单（无 subagent，
      // 因此深度恒为 1），只有摘要回注主上下文。
      //
      // 过程可见性：子 Agent 的内层 phase 经 live-loop-trace 装配成「隔离 trace 卡片」，
      // 走独立通道 agent:subagent-trace 推给 Renderer —— 不混进父 agent:rust-loop-phase，
      // 因为子运行的 runId 会覆盖父 entry.runId（外层 onPhase 用 data.runId 回写），
      // 串了会导致取消打错目标。子 Agent 的正文仍不回父上下文，只走卡片。
      const subagentTraceState = new Map();
      const emitSubagentTrace = (meta, entries, streamContent, done) => {
        live.safeWebContentsSend(evt.sender, 'agent:subagent-trace', {
          cancelToken,
          subagentId: meta.subagentId || '',
          label: meta.label || '',
          index: Number(meta.index) || 0,
          parallel: !!meta.parallel,
          done: !!done,
          entries: Array.isArray(entries) ? entries : [],
          streamContent: streamContent || ''
        });
      };
      // 把并发标记写进卡片条目：条目构建时读到的 meta.parallel 可能落后一次事件，
      // 这里统一重盖，保证卡片上的并发样式与实际并发数一致。
      const stampParallel = (entries, parallel) =>
        (Array.isArray(entries) ? entries : []).map((e) => ({ ...e, parallel: !!parallel }));
      // 并发判定：同一父运行里同时在跑的子 Agent 多于一个 → 卡片标记为并发
      // （首个启动时还不知道后面会不会并行，故新卡加入/退出时统一回推一次）。
      const resyncSubagentParallel = () => {
        const parallel = subagentTraceState.size > 1;
        for (const st of subagentTraceState.values()) {
          const changed = !!st.meta.parallel !== parallel;
          st.meta.parallel = parallel;
          st.entries = stampParallel(st.entries, parallel);
          if (!changed) continue;
          emitSubagentTrace(st.meta, st.entries, st.streamContent, false);
        }
      };
      const finalizeSubagentTrace = (state, loopResult) => {
        const meta = state.meta;
        // 收尾：把 Rust 的最终 trace 合进「实时卡片」，保持同一个条目（一个子 Agent 一张卡片）。
        const rustCard = mapLoopTraceToUi((loopResult && loopResult.trace) || [], meta)[0] || null;
        const liveCard = (state.entries || [])[0] || null;
        const card = rustCard && liveCard ? mergeIsolatedCards(liveCard, rustCard) : rustCard || liveCard;
        const entries = card ? [card] : state.entries || [];
        state.entries = entries;
        if (loopResult && loopResult.content) {
          state.streamContent = String(loopResult.content).slice(0, 800);
        }
        meta.parallel = subagentTraceState.size > 1;
        emitSubagentTrace(meta, entries, state.streamContent, true);
        subagentTraceState.delete(meta.subagentId);
        resyncSubagentParallel();
      };
      const subagentRunner = createSubagentRunner({
        allTools: startParams.tools,
        model: sessionModel,
        userDataPath: live.userData,
        contextTierId: ctx.contextTierId,
        signal: abortController.signal,
        runChildLoop: async (req, meta) => {
          const state = {
            meta: { ...(meta || {}), parallel: false },
            entries: [],
            streamContent: ''
          };
          const subagentId = state.meta.subagentId || '';
          const tracker = createLiveLoopTraceTracker(state.meta, {
            onUpdate: (entries, content) => {
              state.entries = entries;
              if (content) state.streamContent = content;
              subagentTraceState.set(subagentId, state);
              resyncSubagentParallel();
              emitSubagentTrace(state.meta, state.entries, state.streamContent, false);
            }
          });
          tracker.handlePhase('start', {});
          let loopResult = null;
          try {
            loopResult = await runRustAgentLoop({
              coreBridge: live.coreBridge,
              llm: apiCfg,
              startParams: {
                ...startParams,
                messages: req.messages,
                tools: req.tools,
                maxRounds: req.maxRounds,
                maxToolCalls: req.maxToolCalls
              },
              settings,
              userData: live.userData,
              contextTierId: ctx.contextTierId,
              // 子 Agent 的正文不回父上下文，只走卡片；phase 单独转发给 tracker。
              useStream: false,
              onPhase: (phaseName, data) => {
                try {
                  tracker.handlePhase(phaseName, data || {});
                } catch {
                  // 卡片装配失败不应影响子 Agent 执行
                }
              },
              signal: abortController.signal,
              delegateTool: (n, a) =>
                toolBridge.executeAgentTool(n, a, { ...ctx, subagentDepth: 1 })
            });
          } finally {
            // 先补发节流中未到达的一帧，再落收尾卡片：否则最后 ~120ms 的流式文本会被节流丢掉
            try {
              tracker.dispose();
            } catch {
              // ignore
            }
            try {
              finalizeSubagentTrace(state, loopResult);
            } catch {
              // ignore
            }
          }
          return loopResult;
        }
      });
      const protocolAbort = () => {
        try {
          live.killActiveShellChildren({ sessionId: entry.sessionId || null });
        } catch {
          // ignore
        }
        const rid = entry.runId;
        if (rid) abortRun(rid);
        else if (entry.sessionId) abortSessionRuns(entry.sessionId);
        if (live.coreBridge && typeof live.coreBridge.abortPending === 'function') {
          try {
            live.coreBridge.abortPending({
              runId: rid || undefined,
              reason: '已停止'
            });
          } catch {
            // ignore
          }
        }
      };
      abortController.signal.addEventListener('abort', protocolAbort, { once: true });
      const result = await runRustAgentLoop({
        coreBridge: live.coreBridge,
        // 请求头 / 会话标识随配置一并交给 loop runner（装配单一来源：llm-request.js）。
        // sessionId 让供应商自定义头里的 {{sessionId}} 生效，并提升上游 prompt 缓存命中。
        llm: apiCfg,
        turnEndSynthesis: payload.turnEndSynthesis === true,
        browserVision: payload.browserVision === true,
        startParams,
        settings,
        userData: live.userData,
        contextTierId: ctx.contextTierId,
        useStream: payload.useStream !== false,
        signal: abortController.signal,
        onPhase: (phase, data) => {
          if (data && data.runId) {
            entry.runId = data.runId;
            const ac = ensureRunAbortController(data.runId, entry.sessionId || payload.sessionId);
            if (ac && abortController.signal.aborted && !ac.signal.aborted) {
              try {
                ac.abort();
              } catch {
                // ignore
              }
            }
          }
          sendPhase(phase, data);
        },
        compactMessages: async (messages, ctx) => {
          const cr = await live.mainCompactionAgent.maybeCompactMessages(messages, {
            tokenBudget,
            apiConfig: apiCfg,
            model: sessionModel,
            sessionId: payload.sessionId || null,
            signal: ctx?.signal || abortController.signal,
            runId: ctx?.runId || entry.runId || undefined,
            force: !!ctx?.force,
            toolsChars: ctx?.toolsChars
          });
          if (cr.compacted && payload.sessionId && live.localGateway) {
            live.localGateway
              .invokeRpc('memory.compaction_archive', {
                sessionId: payload.sessionId,
                workspacePath: workspacePath || null,
                tokensBefore: cr.tokensBefore,
                tokensAfter: cr.tokensAfter,
                summary: cr.summary || null,
                foldedTranscript: cr.foldedTranscript || null
              })
              .catch(() => {});
          }
          return cr;
        },
        delegateTool: async (name, args) => {
          if (entry.aborted || abortController.signal.aborted) {
            const err = new Error('已停止');
            err.name = 'AbortError';
            err.code = 'ABORT_ERR';
            throw err;
          }
          if (entry.runId) {
            ctx.runId = entry.runId;
            ensureRunAbortController(entry.runId, entry.sessionId || payload.sessionId);
          }
          ctx.signal = abortController.signal;
          if (name === subagentRunner.toolName) {
            return subagentRunner.run(args, ctx);
          }
          return toolBridge.executeAgentTool(name, args, ctx);
        }
      });
      runFinishedOk = true;
      return result;
    } catch (err) {
      const msg = String(err && (err.message || err));
      if (
        entry.aborted ||
        (err && err.name === 'AbortError') ||
        /已停止|aborterror/i.test(msg)
      ) {
        return {
          aborted: true,
          phase: 'done',
          content: '',
          trace: [],
          hitRoundLimit: false,
          messages: []
        };
      }
      throw err;
    } finally {
      rustLoopCancels.delete(cancelToken);
      if (runFinishedOk) {
        abortedAgentCancelTokens.delete(cancelToken);
      } else {
        abortedAgentCancelTokens.add(cancelToken);
      }
      const rid = entry.runId;
      if (!runFinishedOk) {
        if (rid) abortRun(rid);
        if (live.coreBridge && typeof live.coreBridge.abortPending === 'function') {
          try {
            live.coreBridge.abortPending({ runId: rid || undefined, reason: '已停止' });
          } catch {
            // ignore
          }
        }
        if (rid && live.coreBridge && live.coreBridge.isReady()) {
          try {
            await live.coreBridge.invoke('agent.loop.cancel', { runId: rid }, 10000);
          } catch {
            // ignore
          }
        }
      }
      if (rid) clearRunAbortController(rid);
      if (payload.sessionId) {
        live.clearToolHarnessSessionsForSession(payload.sessionId);
      }
    }
  });

  ipcMain.handle('agent:retry-tool', async (evt, payload = {}) => {
    const settings = live.loadModelSettings(live.userData);
    let workspacePath = payload.workspacePath ? String(payload.workspacePath) : null;
    if (!workspacePath && payload.sessionId) {
      workspacePath = await live.resolveAgentRunWorkspacePath(payload.sessionId);
    }
    if (!workspacePath && !payload.sessionId) {
      const ws = live.localGateway ? live.localGateway.getWorkspace() : null;
      workspacePath = ws && ws.kind === 'local' ? ws.workspacePath : live.workspaceRootPath();
    }
    const toolBridge = live.createRustLoopToolBridge(evt.sender);
    const model = payload.model || settings.textModel || undefined;
    const { resolveContextTierIdForNode } = require('../../agent/agent-limits');
    const ctx = {
      workspacePath: workspacePath || undefined,
      sessionId: payload.sessionId || undefined,
      undoTurnId: payload.undoTurnId || undefined,
      model,
      contextTierId: payload.contextTierId || (model ? resolveContextTierIdForNode(live.userData, model) : 'default'),
      runId: payload.runId || `retry-${Date.now()}`
    };
    return toolBridge.executeAgentTool(String(payload.name || ''), payload.args || {}, ctx);
  });

  ipcMain.handle('agent:tool-telemetry-summary', async () => {
    return summarizeTelemetry(live.userData);
  });

  ipcMain.handle('agent:rust-loop-cancel', async (_evt, { cancelToken, runId } = {}) => {
    const token = cancelToken ? String(cancelToken) : '';
    if (token) abortedAgentCancelTokens.add(token);
    const entry = token ? rustLoopCancels.get(token) : null;
    if (entry) {
      entry.aborted = true;
      if (entry.abortController) entry.abortController.abort();
    }
    try {
      live.killActiveShellChildren({ sessionId: entry?.sessionId || null });
    } catch {
      // ignore
    }
    const rid = runId || (entry && entry.runId);
    if (rid) abortRun(rid);
    else if (entry?.sessionId) abortSessionRuns(entry.sessionId);
    if (live.coreBridge && typeof live.coreBridge.abortPending === 'function') {
      try {
        live.coreBridge.abortPending({ runId: rid || undefined, reason: '已停止' });
      } catch {
        // ignore
      }
    }
    if (rid && live.coreBridge && live.coreBridge.isReady()) {
      try {
        await live.coreBridge.invoke('agent.loop.cancel', { runId: rid }, 10000);
      } catch {
        // ignore
      }
    }
    return { ok: true };
  });

  const mainPlannerRunner = createMainPlannerRunner({
    coreBridge: live.coreBridge,
    coordinator: live.agentCoordinator,
    worktreeService: live.worktreeService,
    subagentStore: live.subagentStore,
    dieyunHome: live.dieyunHome,
    workspaceRootPath: live.workspaceRootPath,
    resolveAgentRunWorkspacePath: live.resolveAgentRunWorkspacePath,
    localGateway: live.localGateway,
    userData: live.userData,
    createToolBridge: (webContents) => live.createRustLoopToolBridge(webContents)
  });

  ipcMain.handle('agent:planner-ping', async () => {
    if (!live.coreBridge || !live.coreBridge.isReady()) {
      return { ok: false, error: 'rust_core_unavailable' };
    }
    try {
      return await live.coreBridge.invoke('planner.ping', {}, 10000);
    } catch (e) {
      return { ok: false, error: e.message || String(e) };
    }
  });

  ipcMain.handle('agent:planner-run', async (evt, payload = {}) => {
    if (!live.coreBridge || !live.coreBridge.isReady()) {
      throw new Error('dieyun-core 未就绪');
    }
    const cancelToken = String(
      payload.cancelToken || `pl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    );
    if (abortedAgentCancelTokens.has(cancelToken)) {
      return { aborted: true };
    }
    const abortController = new AbortController();
    const entry = {
      aborted: false,
      rustPlannerRunId: null,
      abortController,
      sessionId: payload.sessionId || null
    };
    plannerRunCancels.set(cancelToken, entry);
    let pendingProgressData = null;
    let progressFlushTimer = null;
    const clearPlannerProgressFlush = () => {
      if (progressFlushTimer) {
        clearTimeout(progressFlushTimer);
        progressFlushTimer = null;
      }
      pendingProgressData = null;
    };
    const onPlannerSenderDestroyed = () => clearPlannerProgressFlush();
    if (live.canSendToWebContents(evt.sender)) {
      evt.sender.once('destroyed', onPlannerSenderDestroyed);
    }
    const flushPlannerProgress = () => {
      if (progressFlushTimer) {
        clearTimeout(progressFlushTimer);
        progressFlushTimer = null;
      }
      if (!pendingProgressData) return;
      if (!live.canSendToWebContents(evt.sender)) {
        clearPlannerProgressFlush();
        return;
      }
      const data = pendingProgressData;
      pendingProgressData = null;
      live.safeWebContentsSend(evt.sender, 'agent:planner-phase', {
        cancelToken,
        phase: 'progress',
        data
      });
    };
    const sendPhase = (name, data) => {
      if (!live.canSendToWebContents(evt.sender)) {
        clearPlannerProgressFlush();
        return;
      }
      if (name === 'progress') {
        pendingProgressData = data || {};
        if (!progressFlushTimer) {
          progressFlushTimer = setTimeout(flushPlannerProgress, 160);
        }
        return;
      }
      flushPlannerProgress();
      live.safeWebContentsSend(evt.sender, 'agent:planner-phase', {
        cancelToken,
        phase: name,
        data: data || {}
      });
    };
    let plannerFinishedOk = false;
    try {
      const plannerResult = await mainPlannerRunner.runPipeline(payload, {
        webContents: evt.sender,
        signal: abortController.signal,
        onProgress: (trace, streamContent, plan) =>
          sendPhase('progress', { trace, streamContent: streamContent || '', plan: plan || null }),
        onPhase: (name, data) => {
          if (data && data.rustPlannerRunId) entry.rustPlannerRunId = data.rustPlannerRunId;
          if (data && data.runId && !entry.rustPlannerRunId) entry.rustPlannerRunId = data.runId;
          sendPhase(name, data);
        }
      });
      plannerFinishedOk = true;
      return plannerResult;
    } catch (err) {
      const msg = String(err && (err.message || err));
      if (
        entry.aborted ||
        abortController.signal.aborted ||
        (err && err.name === 'AbortError') ||
        /已停止|aborterror/i.test(msg)
      ) {
        return { aborted: true };
      }
      throw err;
    } finally {
      flushPlannerProgress();
      plannerRunCancels.delete(cancelToken);
      if (plannerFinishedOk) {
        abortedAgentCancelTokens.delete(cancelToken);
      } else {
        abortedAgentCancelTokens.add(cancelToken);
        const rid = entry.rustPlannerRunId;
        if (rid && live.coreBridge && live.coreBridge.isReady()) {
          try {
            await live.coreBridge.invoke('planner.run.cancel', { runId: rid }, 10000);
          } catch {
            // ignore
          }
        }
      }
      clearPlannerProgressFlush();
      try {
        evt.sender.removeListener('destroyed', onPlannerSenderDestroyed);
      } catch {
        // ignore
      }
    }
  });

  ipcMain.handle('agent:planner-cancel', async (_evt, { cancelToken, runId } = {}) => {
    const token = cancelToken ? String(cancelToken) : '';
    if (token) abortedAgentCancelTokens.add(token);
    const entry = token ? plannerRunCancels.get(token) : null;
    if (entry) {
      entry.aborted = true;
      if (entry.abortController) entry.abortController.abort();
    }
    try {
      live.killActiveShellChildren({ sessionId: entry?.sessionId || null });
    } catch {
      // ignore
    }
    const rid = runId || (entry && entry.rustPlannerRunId);
    if (rid) abortRun(rid);
    if (live.coreBridge && typeof live.coreBridge.abortPending === 'function') {
      try {
        live.coreBridge.abortPending({ runId: rid || undefined, reason: '已停止' });
      } catch {
        // ignore
      }
    }
    if (rid && live.coreBridge && live.coreBridge.isReady()) {
      try {
        await live.coreBridge.invoke('planner.run.cancel', { runId: rid }, 10000);
      } catch {
        // ignore
      }
    }
    return { ok: true };
  });

  ipcMain.handle('agent:run-start', (_evt, meta) => {
    if (!live.agentCoordinator) return { ok: false, error: 'coordinator_unavailable' };
    return { ok: true, ...live.agentCoordinator.startRun(meta || {}) };
  });
  ipcMain.handle('agent:run-cancel', (_evt, { runId, reason }) => {
    if (!live.agentCoordinator) return { ok: false };
    return live.agentCoordinator.cancelRun(runId, reason);
  });
  ipcMain.handle('agent:run-end', (_evt, { runId }) => {
    if (!live.agentCoordinator) return { ok: false };
    return live.agentCoordinator.endRun(runId);
  });
  ipcMain.handle('agent:is-cancelled', (_evt, { runId }) => ({
    cancelled: live.agentCoordinator ? live.agentCoordinator.isRunCancelled(runId) : true
  }));
  ipcMain.handle('agent:task-enqueue', (_evt, { runId, task }) => {
    try {
      const r = live.agentCoordinator.enqueueTask(runId, task || {});
      return { ok: true, task: r.task };
    } catch (e) {
      return { ok: false, error: e.message || String(e) };
    }
  });
  ipcMain.handle('agent:task-running', (_evt, { runId, taskId }) => {
    try {
      const r = live.agentCoordinator.markTaskRunning(runId, taskId);
      return { ok: true, task: r.task };
    } catch (e) {
      return { ok: false, error: e.message || String(e) };
    }
  });
  ipcMain.handle('agent:task-complete', (_evt, { runId, taskId, result }) => {
    try {
      const r = live.agentCoordinator.completeTask(runId, taskId, result);
      return { ok: true, task: r.task };
    } catch (e) {
      return { ok: false, error: e.message || String(e) };
    }
  });
  ipcMain.handle('agent:task-fail', (_evt, { runId, taskId, error, cancel }) => {
    try {
      const r = live.agentCoordinator.failTask(runId, taskId, error, { cancel: !!cancel });
      return { ok: true, ...r };
    } catch (e) {
      return { ok: false, error: e.message || String(e) };
    }
  });
  ipcMain.handle('agent:message-post', (_evt, { runId, message }) => {
    try {
      const msg = live.agentCoordinator.postMessage(runId, message || {});
      return { ok: true, message: msg };
    } catch (e) {
      return { ok: false, error: e.message || String(e) };
    }
  });
  ipcMain.handle('agent:messages-for-role', (_evt, { runId, roleId }) => ({
    ok: true,
    messages: live.agentCoordinator ? live.agentCoordinator.getMessagesForRole(runId, roleId) : []
  }));
  ipcMain.handle('agent:messages-for-role-since', (_evt, { runId, roleId, since }) => {
    if (!live.agentCoordinator) return { ok: true, messages: [], lastAt: since || 0 };
    const r = live.agentCoordinator.getMessagesForRoleSince(runId, roleId, since);
    return { ok: true, messages: r.messages, lastAt: r.lastAt };
  });
  ipcMain.handle('agent:checkpoint-save', (_evt, { runId, data }) => {
    try {
      return live.subagentStore.saveCheckpoint(live.dieyunHome(), runId, data || {});
    } catch (e) {
      return { ok: false, error: e.message || String(e) };
    }
  });
  ipcMain.handle('agent:checkpoint-load', (_evt, { runId }) =>
    live.subagentStore.loadCheckpoint(live.dieyunHome(), runId)
  );
  ipcMain.handle('agent:checkpoint-delete', (_evt, { runId }) =>
    live.subagentStore.deleteCheckpoint(live.dieyunHome(), runId)
  );
  ipcMain.handle('agent:checkpoint-list', (_evt, { limit }) =>
    live.subagentStore.listCheckpoints(live.dieyunHome(), limit || 20)
  );
  ipcMain.handle('agent:trace', (_evt, { runId }) => live.agentCoordinator.getTrace(runId));
  ipcMain.handle('agent:arbitrate', (_evt, { runId, decision }) =>
    live.agentCoordinator.arbitrate(runId, decision || {})
  );
  ipcMain.on('agent-service:task-accepted', (_evt, payload) => {
    if (live.agentService) live.agentService.acceptTask(payload || {});
  });
  ipcMain.on('agent-service:task-rejected', (_evt, payload) => {
    if (live.agentService) live.agentService.rejectTask(payload || {});
  });
  ipcMain.on('agent-service:task-progress', (_evt, payload) => {
    if (live.agentService) live.agentService.progressTask(payload || {});
  });
  ipcMain.on('agent-service:task-completed', (_evt, payload) => {
    if (live.agentService) live.agentService.completeTask(payload || {});
  });
}

module.exports = { registerAgentRuntimeIpc };
