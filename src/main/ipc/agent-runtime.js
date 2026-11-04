'use strict';

const { runRustAgentLoop } = require('../../agent/rust-loop-runner');
const { createSubagentRunner } = require('../../agent/subagent-runner');
const {
  createLiveLoopTraceTracker,
  mapLoopTraceToUi,
  mergeIsolatedCards
} = require('../../agent/live-loop-trace');
const { createMainPlannerRunner } = require('../../agent/planner-runner-main');
const { maybeGenerateSessionTitle } = require('../../agent/session-title');
const { summarizeTelemetry, describeIndexInjections } = require('../../agent/tool-telemetry');
const { evaluateTurnReadiness } = require('../../agent/completion-readiness');
const { summarizeCompactionTelemetry } = require('../../agent/compaction-telemetry');
const {
  ensureRunAbortController,
  abortRun,
  abortSessionRuns,
  clearRunAbortController,
  hasActiveRuns
} = require('../../agent/run-cancel-registry');

/** 压缩归档（旁路记录）的写入上限：它在发请求之前 await，不能让它拖住整轮。 */
const COMPACTION_ARCHIVE_TIMEOUT_MS = 2000;

// 会话目标（按轮计数）：唯一读写点，见 src/goals/session-goal.js
const sessionGoalStore = require('../../goals/session-goal');

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
    ensureMainCompactionAgent,
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

  /**
   * 一次运行归属哪个工作空间（`agent:run` / `agent:planner-run` / `agent:retry-tool` 共用口径）：
   * payload 显式给的 > 会话绑定的 > 当前 Gateway 视图工作区。
   * 有 sessionId 时禁止回落到「当前视图工作区」，避免并行本地任务串台。
   * @returns {Promise<string>} 空串表示没有可用工作空间
   */
  async function resolveRunWorkspacePath(payload = {}) {
    let workspacePath =
      payload.runWorkspaceRoot ||
      payload.workspaceRoot ||
      payload.workspacePath ||
      (payload.startParams && payload.startParams.workspaceRoot) ||
      null;
    if (!workspacePath && payload.sessionId) {
      workspacePath = await live.resolveAgentRunWorkspacePath(payload.sessionId);
    }
    if (!workspacePath && !payload.sessionId) {
      const ws = live.localGateway ? live.localGateway.getWorkspace() : null;
      workspacePath = ws && ws.kind === 'local' ? ws.workspacePath : live.workspaceRootPath();
    }
    return workspacePath || '';
  }

  ipcMain.handle('agent:prep-system-prompt', async (_evt, payload = {}) => {
    const gateway = live.localGateway;
    if (!gateway || typeof gateway.invokeRpc !== 'function') {
      throw new Error('Gateway 未就绪');
    }
    const snapshot = payload && typeof payload === 'object' ? payload : {};
    // 依赖装配（AGENTS.md / 记忆 / 技能 / MCP / 召回范围）与频道运行共用同一份实现：
    // src/agent/system-prompt-prep-main.js
    const { buildPrepSystemPromptDeps } = require('../../agent/system-prompt-prep-main');
    const built = buildPrepSystemPromptDeps({
      gateway,
      userData: live.userData,
      snapshot,
      // 共享记忆（跨机）：扩展未配置 / 连不上时 active 为 false，块自动缺席（fail-open）
      sharedMemory: typeof ctx.getSharedMemory === 'function' ? ctx.getSharedMemory() : null,
      listMcpServers: (userDataPath) =>
        typeof listMcpServersForUi === 'function' ? listMcpServersForUi(userDataPath) : []
    });
    return built.prepSystemPrompt(snapshot, built.deps);
  });

  // 会话交接：生成（Main 单轮 LLM + Rust 唯一写入口）；读取走 Gateway memory.handoff_*
  ipcMain.handle('session:handoff-generate', async (_evt, { sessionId } = {}) => {
    const gateway = live.localGateway;
    if (!gateway || typeof gateway.invokeRpc !== 'function') {
      throw new Error('Gateway 未就绪');
    }
    const { generateSessionHandoff } = require('../../agent/session-handoff');
    return generateSessionHandoff({ userData: live.userData, gateway }, { sessionId });
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
    const rawSettings = live.loadModelSettings(live.userData);
    const apiConfig = payload.apiConfig || {};
    const baseUrl = apiConfig.baseUrl || rawSettings.baseUrl;
    const apiKey = apiConfig.apiKey || rawSettings.apiKey;
    const workspacePath = await resolveRunWorkspacePath(payload);
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
      runId: undefined,
      // 本次运行实际使用的模型路由（Renderer 传入）：
      // plan_create 等 Main 侧要自己调模型的地方据此解析配置，勿只看顶层 settings.apiKey
      modelRoute: payload.modelRoute || undefined,
      browserVision: payload.browserVision === true
    };
    // 会话目标：Renderer 主循环跑一轮 = 目标推进一轮（预算按「轮」计，见 agent-limits）。
    // 只给「进行中」的目标计数；写失败一律吞掉 —— 目标计数坏掉不该让本轮跑不起来。
    // 子 Agent / 频道 / 计划各有自己的执行路径，不经过这个 IPC，因此不会被重复计一次。
    if (ctx.sessionId && live.localGateway && typeof live.localGateway.invokeRpc === 'function') {
      try {
        await sessionGoalStore.patchGoal({
          invokeRpc: live.localGateway.invokeRpc,
          sessionId: ctx.sessionId,
          mutate: (goal) => {
            if (!goal || goal.outcome || goal.status !== 'active') return undefined;
            sessionGoalStore.advanceAttempt(goal);
            return goal;
          }
        });
      } catch {
        // 目标只是背景：计数失败不影响本轮执行
      }
    }
    const { resolveContextTierIdForNode } = require('../../agent/agent-limits');
    if (!ctx.contextTierId && ctx.model) {
      ctx.contextTierId = resolveContextTierIdForNode(live.userData, ctx.model);
    }
    // 本轮生效的「模型与段预算」= 磁盘 settings 叠上该 Context 档位（见 applyTierRuntime）。
    // 主循环的 loopSpec、压缩预算、快照都用这一份；别再各处自己读扁平 settings。
    const { applyTierRuntime } = require('../../agent/model-runtime-by-tier');
    const settings = applyTierRuntime(rawSettings, live.userData, {
      tierId: ctx.contextTierId,
      model: ctx.model || rawSettings.textModel
    });
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
      // 压缩实例唯一创建入口在 main-entry（单例，与 IPC 预检 / planner 共用）；这里只取用
      const mainCompactionAgent = ensureMainCompactionAgent();
      const sessionModel =
        payload.model ||
        startParams.model ||
        settings.textModel ||
        '';
      // 整体继承 payload.apiConfig：逐字段重建会丢掉 headers / authMode / userAgent，
      // 结果就是「设置页配了自定义头，主循环却不带」。压缩走同一份 apiCfg。
      const apiCfg = {
        ...apiConfig,
        baseUrl,
        apiKey,
        model: sessionModel,
        sessionId: payload.sessionId || undefined
      };
      // 本轮开始先清空「本会话」的浏览器日志缓冲，避免上一轮残留错误触发本轮完成验收提示。
      // 带上 sessionId 是必须的：不带就等于清掉所有会话，别的会话正在看的页面日志会凭空消失。
      if (live.localGateway && typeof live.localGateway.invokeRpc === 'function') {
        live.localGateway.invokeRpc('browser.reset_logs', { sessionId: payload.sessionId || undefined }).catch(() => {});
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
              // 子 Agent 的请求同样留底：来源标 subagent、会话归属父会话（排查时按会话聚类）。
              sessionId: payload.sessionId || undefined,
              runSource: 'subagent',
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
              // 用流式：live-loop-trace 的节流/补帧（sync/dispose）本就是为主循环 subagent 写的，
              // 关掉流式会让 llm_delta 到不了 tracker，卡片只能停在「请求 LLM」这类占位文案。
              useStream: true,
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
      // 本轮开始时刻：完成验收拿它给浏览器观察账本切时间窗（那份账本按会话累计、不自动清空）
      const turnStartedAt = Date.now();
      const result = await runRustAgentLoop({
        coreBridge: live.coreBridge,
        // 请求头 / 会话标识随配置一并交给 loop runner（装配单一来源：llm-request.js）。
        // sessionId 让供应商自定义头里的 {{sessionId}} 生效，并提升上游 prompt 缓存命中。
        llm: apiCfg,
        // 请求快照的会话归属与来源：与上面的请求头标识同源，避免两套会话概念。
        sessionId: payload.sessionId || undefined,
        runSource: 'chat',
        contextAudit: payload.contextAudit || null,
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
        compactMessages: async (messages, compactCtx) => {
          const cr = await mainCompactionAgent.maybeCompactMessages(messages, {
            // 预算 / 触发比由 compaction-main 按本轮 Context 档位自己算（它才是唯一算预算的地方）
            contextTierId: ctx.contextTierId,
            apiConfig: apiCfg,
            model: sessionModel,
            sessionId: payload.sessionId || null,
            signal: compactCtx?.signal || abortController.signal,
            runId: compactCtx?.runId || entry.runId || undefined,
            force: !!compactCtx?.force,
            toolsChars: compactCtx?.toolsChars
          });
          if (cr.compacted && payload.sessionId && live.localGateway) {
            // 归档 id 回填给快照：让「这一轮压缩过」与 compaction_archives 行对得上。
            // 归档失败不影响主链路（快照里就留 null）。
            // 短超时：这次归档在**发请求之前**，DB 慢不能拖着整轮对话等它的默认 120s。
            try {
              const archived = await live.localGateway.invokeRpc(
                'memory.compaction_archive',
                {
                  sessionId: payload.sessionId,
                  workspacePath: workspacePath || null,
                  tokensBefore: cr.tokensBefore,
                  tokensAfter: cr.tokensAfter,
                  summary: cr.summary || null,
                  foldedTranscript: cr.foldedTranscript || null
                },
                { timeoutMs: COMPACTION_ARCHIVE_TIMEOUT_MS }
              );
              if (archived && archived.id != null) cr.compactionArchiveId = archived.id;
            } catch {
              // archive 是旁路记录，写失败只让快照少一个 id
            }
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
      // 完成验收：证据采集与判定都在 Main（trace 是循环账本，诊断/浏览器证据走 Gateway），
      // Renderer 只负责把 note 渲染进正文。判定失败不挡交付、不自动续跑；
      // 验收本身出意外也**不能**把这一轮判成失败（采集内部已逐段降级，这里是最后一道）。
      try {
        result.readiness = await evaluateTurnReadiness({
          gateway: live.localGateway,
          trace: result.trace,
          sessionId: payload.sessionId || null,
          workspacePath,
          userDataPath: live.userData,
          startedAt: turnStartedAt
        });
      } catch {
        result.readiness = null;
      }
      // 会话目标：一次 rust-loop-run 的返回 = 一轮结束，这是唯一的续跑判定时点。
      // 判定是纯函数（`decideContinuation`，与计划目标共用），这里只把结论交给 Renderer：
      // Renderer 读两个布尔值去机械地再开一轮，**不持有目标状态、不碰预算**。
      // 无目标 / 已收尾 / 已暂停 → 整个字段省略（Renderer 当作「不续跑」）。
      if (ctx.sessionId && live.localGateway && typeof live.localGateway.invokeRpc === 'function') {
        try {
          const { getAgentLimits } = require('../../agent/agent-limits');
          result.goal = await sessionGoalStore.judgeAfterTurn({
            invokeRpc: live.localGateway.invokeRpc,
            sessionId: ctx.sessionId,
            limits: getAgentLimits(live.userData)
          });
        } catch {
          result.goal = null;
        }
      }
      runFinishedOk = true;
      // 记忆归纳触发：事实（trace / plan / review / 正文）都在 Main，装配后入队即可；
      // 计划 worktree 未应用时先暂存，等 Renderer 报应用结果（或超时）再决定写不写。
      // 归纳失败不影响交付（不是主链路）。
      try {
        const { afterAgentRun } = require('../../agent/knowledge-maintainer');
        afterAgentRun({
          result,
          opts: {
            sessionId: payload.sessionId || '',
            workspacePath: workspacePath || '',
            model: apiCfg.model,
            apiConfig: apiCfg,
            userText: runUserText(payload)
          }
        });
      } catch {
        // ignore
      }
      // 历史列表标题：一轮正常跑完后补一次模型总结（每会话只一次，判据见 session-title.js）。
      // 刻意不 await —— 标题是列表装饰，不能让它拖住交付；生成完再推事件让 Renderer 刷列表。
      if (payload.sessionId && live.localGateway && typeof live.localGateway.invokeRpc === 'function') {
        const titleSessionId = payload.sessionId;
        void maybeGenerateSessionTitle({
          invokeRpc: (method, params) => live.localGateway.invokeRpc(method, params || {}),
          // 与主链路同一份配置：同一供应商、同一模型、同一套自定义头。
          llm: apiCfg,
          sessionId: titleSessionId,
          messages: startParams.messages,
          done: result,
          userData: live.userData,
          signal: abortController.signal
        })
          .then((title) => {
            if (!title) return;
            live.safeWebContentsSend(evt.sender, 'agent:session-title', {
              sessionId: titleSessionId,
              title
            });
          })
          .catch(() => {});
      }
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
    const workspacePath = await resolveRunWorkspacePath(payload);
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
    const summary = summarizeTelemetry(live.userData);
    // 「索引内容被自动塞进上下文的次数」：与工具调用占比同一窗口（用遥测窗口的起点），
    // 事实来自 request_snapshots，口径见 tool-telemetry.js:describeIndexInjections。
    // core 未就绪时留 null —— UI 显示「不可用」，绝不把「读不到」画成 0。
    summary.indexInjections = await readIndexInjections(live, summary.indexUsage.since);
    return summary;
  });

  /**
   * 读索引注入聚合。RPC 只有一处（`memory.request_snapshot_index_audit`），
   * 这里只负责「core 没起来 / 调用失败 → null」这一层降级，不做二次统计。
   * @param {object} live
   * @param {number | null} since
   */
  async function readIndexInjections(live, since) {
    if (!live.coreBridge || !live.coreBridge.isReady()) return null;
    try {
      const raw = await live.coreBridge.invoke(
        'memory.request_snapshot_index_audit',
        { since: Number.isFinite(since) ? since : undefined },
        10000
      );
      return describeIndexInjections(raw);
    } catch {
      return null;
    }
  }

  ipcMain.handle('agent:compaction-telemetry-summary', async (_evt, { sessionId } = {}) => {
    // limit 传 undefined 走默认窗口；sessionId 为空时维持全局口径（兼容既有调用方）
    return summarizeCompactionTelemetry(live.userData, undefined, sessionId || '');
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
    // 压缩实例与对话链路共用 Main 单例（延迟取：注册时可能尚未创建）
    getCompactionAgent: () => ensureMainCompactionAgent(),
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
      // 计划模式（planner 管线）也是「一轮任务」：不在这里触发，计划模式的产出永远不会
      // 进记忆（Renderer 的收尾路径只管对话）。worktree 未应用时由 Main 暂存等应用结果。
      try {
        const { afterAgentRun } = require('../../agent/knowledge-maintainer');
        afterAgentRun({
          result: plannerResult,
          opts: {
            sessionId: payload.sessionId || '',
            workspacePath: await resolveRunWorkspacePath(payload),
            model: payload.model || (payload.startParams && payload.startParams.model) || '',
            apiConfig: payload.apiConfig || null,
            userText: runUserText(payload)
          }
        });
      } catch {
        // 归纳失败不影响交付
      }
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

  /**
   * 会话目标面板：读视图 / 清除目标 / 继续（重置预算）。
   *
   * 只透出三件事，且语义全在 Main 侧：`clear` 删除、`resume` 回到 active 并重置轮次、
   * 其余读视图。**不在这里做目标判断** —— 进度、预算、事实尾巴全在
   * `goals/session-goal.js#toPanelView`，Renderer 拿到的是可以直接画的数字与字符串。
   */
  ipcMain.handle('agent:session-goal-panel', async (_evt, payload = {}) => {
    const sessionId = String(payload.sessionId || '').trim();
    const gatewayNow = live.localGateway;
    if (!sessionId || !gatewayNow || typeof gatewayNow.invokeRpc !== 'function') {
      return { ok: false, goal: null, error: 'session_or_gateway_unavailable' };
    }
    try {
      if (payload.action === 'clear') {
        await sessionGoalStore.saveGoal({ invokeRpc: gatewayNow.invokeRpc, sessionId, goal: null });
        return { ok: true, goal: null };
      }
      if (payload.action === 'resume') {
        // 「继续」= 重新给一份轮次预算：attempt 归零、墙钟重新起算，事实与清单保留
        await sessionGoalStore.resumeGoal({ invokeRpc: gatewayNow.invokeRpc, sessionId });
        return { ok: true, resumed: true };
      }
      if (payload.action === 'pause') {
        // 用户按停止：只关掉「自动续跑」这一个开关，事实与清单全留
        await sessionGoalStore.pauseGoal({ invokeRpc: gatewayNow.invokeRpc, sessionId });
        return { ok: true, paused: true };
      }
      const goal = await sessionGoalStore.loadGoal({ invokeRpc: gatewayNow.invokeRpc, sessionId });
      const { getAgentLimits } = require('../../agent/agent-limits');
      return {
        ok: true,
        goal: sessionGoalStore.toPanelView({ goal, limits: getAgentLimits(live.userData) })
      };
    } catch (err) {
      return { ok: false, goal: null, error: String((err && err.message) || err) };
    }
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

  // —— 记忆归纳（Main 侧唯一实现；Renderer 只发触发与设置读写）——
  // 旧实现把定时器 / 队列 / prompt / 写库全放在 Renderer，窗口一关就停摆，
  // 且与 renderer-agent-llm.js 的 legacy 版重复。现在执行体在这里，
  // 数字预算见 agent-limits.js 的 knowledge* 一组。
  let knowledgeMaintainer = null;
  const notifyKnowledge = (channel, payload) => {
    try {
      const { BrowserWindow } = require('electron');
      for (const win of BrowserWindow.getAllWindows()) {
        if (win && win.webContents) live.safeWebContentsSend(win.webContents, channel, payload);
      }
    } catch {
      // 无窗口（后台/定时）时静默：归纳结果已落库
    }
  };
  const ensureKnowledgeMaintainer = () => {
    if (!knowledgeMaintainer) {
      const {
        createKnowledgeMaintainer,
        registerKnowledgeMaintainer
      } = require('../../agent/knowledge-maintainer');
      knowledgeMaintainer = createKnowledgeMaintainer({
        getGateway: () => live.localGateway,
        getUserDataPath: () => live.userData,
        getAgentBusy: () => hasActiveRuns(),
        // 定时归纳没有会话：项目记忆 / AGENTS.md 语料取「当前工作空间」
        getWorkspacePath: () => {
          try {
            const ws = live.localGateway ? live.localGateway.getWorkspace() : null;
            return ws && ws.workspacePath ? String(ws.workspacePath) : '';
          } catch {
            return '';
          }
        },
        notify: notifyKnowledge,
        // 共享记忆（跨机）：归纳器写完本地记忆后镜像上传，并在每次归纳收尾尝试一次提炼
        getSharedMemory: () => (typeof ctx.getSharedMemory === 'function' ? ctx.getSharedMemory() : null)
      });
      // 三个 `runRustAgentLoop` 调用点（对话 / 计划模式 / 定时计划）跑完都经
      // `afterAgentRun` 进这里 —— 触发不再依赖 Renderer 的收尾路径。
      registerKnowledgeMaintainer(knowledgeMaintainer);
      // 定时归纳由 Main 拥有：应用启动即排期，不依赖任何窗口
      knowledgeMaintainer.startSchedule();
    }
    return knowledgeMaintainer;
  };
  ensureKnowledgeMaintainer();

  // 计划 worktree 的应用结果（Renderer → 这里）：applied / no_changes / skipped。
  // 归纳的其余触发点都在 `afterAgentRun`，Renderer 不再上报整包上下文。
  ipcMain.handle('agent:knowledge-plan-outcome', async (_evt, payload = {}) => {
    const { resolveKnowledgePlanOutcome } = require('../../agent/knowledge-maintainer');
    ensureKnowledgeMaintainer();
    return resolveKnowledgePlanOutcome(
      (payload && payload.sessionId) || '',
      (payload && payload.outcome) || 'skipped',
      { appliedPaths: (payload && payload.appliedPaths) || [] }
    );
  });

  // 设置读写：选项清单（模式 / 间隔档）也由 Main 给，Renderer 不再自己写死一份
  ipcMain.handle('agent:knowledge-settings-get', async () => {
    const { KNOWLEDGE_INTERVAL_CHOICES, KNOWLEDGE_MODES } = require('../../agent/knowledge-maintainer');
    return {
      ...ensureKnowledgeMaintainer().getSettings(),
      choices: { modes: [...KNOWLEDGE_MODES], intervals: [...KNOWLEDGE_INTERVAL_CHOICES] }
    };
  });

  ipcMain.handle('agent:knowledge-settings-set', async (_evt, patch = {}) =>
    ensureKnowledgeMaintainer().updateSettings(patch || {})
  );
}

/**
 * 最后一条 user 消息的文本（归纳语料里的「用户任务」）。
 * 多模态消息按 text 片段拼接，图片不参与归纳。
 *
 * **跳过合成消息**（`[系统] …` 这类，如目标续跑轮的驱动消息）：它们不是用户说的话，
 * 拿它当「用户任务」会把归纳的输入变成一句系统提示。
 */
function lastUserTextOf(messages) {
  const { isSyntheticLoopUserContent } = require('../../agent/session-context');
  const list = Array.isArray(messages) ? messages : [];
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const m = list[i];
    if (!m || m.role !== 'user') continue;
    if (isSyntheticLoopUserContent(m.content)) continue;
    const c = m.content;
    if (typeof c === 'string') return c;
    if (Array.isArray(c)) {
      return c
        .map((part) => (part && typeof part.text === 'string' ? part.text : ''))
        .join(' ')
        .trim();
    }
    return '';
  }
  return '';
}

/**
 * 归纳语料里的「用户任务」一句话。
 * 对话/计划模式的 payload 形状不同（`startParams.messages` vs 扁平 `messages`），
 * 两种都认，别在调用点各写一份。
 */
function runUserText(payload = {}) {
  return (
    lastUserTextOf(payload.messages) ||
    lastUserTextOf(payload.startParams && payload.startParams.messages)
  );
}

module.exports = { registerAgentRuntimeIpc };
