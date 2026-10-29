'use strict';
// @ts-check

/**
 * MCP runtime/catalogs and scheduled-plans assembly (called from app.whenReady).
 * Factories are injectable for unit tests; production uses the real modules.
 */

const path = require('path');
const { McpCatalog } = require('../mcp/catalog');
const { SkillCatalog, listInstalledCatalogIds } = require('../skills/catalog');
const { createMcpRuntimeManager } = require('../mcp/runtime-manager');
const { isMcpServerConfigured } = require('../mcp/server-config');
const mcpPackageStore = require('../mcp/package-store');
const { resolveBundledMcpLaunch } = require('../mcp/bundled-launch');
const {
  OPEN_API_MCP_IDS,
  getDieyunOpenApiEnvFromDeploy,
  mergeMcpServerSecrets
} = require('../mcp/open-api-deploy-env');
const { PlansStore } = require('../plans/store');
const { PlansScheduler } = require('../plans/scheduler');
const { runPlan } = require('../plans/runner');
const { getAgentLimits } = require('../agent/agent-limits');
const { getActiveAgentLoopCount } = require('../agent/rust-loop-runner');
const { createPlanRunTrace } = require('../plans/plan-run-events');
const { ensurePlanSession } = require('../plans/plan-session');
const { beginPlanRunTurn, endPlanRunTurn, assistantReplyText, interruptedRunResult } = require(
  '../plans/plan-run-turn'
);
// 目标型计划（trigger=goal）的判定与验收：唯一来源，本文件只负责接线
const { runGoalVerify, decideContinuation, buildGoalAuditReport } = require('../plans/goal-run');
const { deliverPlanResult } = require('../plans/deliver');
const { parsePlanFromText } = require('../plans/parser');
const { AGENT_RUN_EVENT_TYPES, createAgentRunEvent } = require('../agent/run-events');
const { dieyunSkillsDir } = require('../agent-home');

/** 计划运行 trace 的 IPC 合并窗口（与 Renderer 侧 120ms 的进度节流同级） */
const PLAN_TRACE_FLUSH_MS = 120;

/**
 * @typedef {object} McpPlansLog
 * @property {(msg: string, ...rest: unknown[]) => void} info
 * @property {(msg: string, ...rest: unknown[]) => void} warn
 */

/**
 * @param {object} deps
 * @param {string} deps.userData
 * @param {ReturnType<typeof import('../mcp/store').createMcpStore>} deps.mcpStore
 * @param {() => { getWorkspace?: () => { workspacePath?: string } } | null} deps.getLocalGateway
 * @param {McpPlansLog} deps.log
 * @param {object | null} [deps.existingRuntime]
 * @param {object | null} [deps.existingMcpCatalog]
 * @param {object | null} [deps.existingSkillCatalog]
 * @param {typeof createMcpRuntimeManager} [deps.createMcpRuntimeManager]
 * @param {typeof isMcpServerConfigured} [deps.isMcpServerConfigured]
 * @param {{ ensureMcpNpmPackage: Function }} [deps.mcpPackageStore]
 * @param {typeof McpCatalog} [deps.McpCatalog]
 * @param {typeof SkillCatalog} [deps.SkillCatalog]
 * @param {typeof listInstalledCatalogIds} [deps.listInstalledCatalogIds]
 * @param {() => string} [deps.dieyunSkillsDir]
 */
function bootMcpSkillCatalogs(deps) {
  const userData = deps.userData;
  const mcpStore = deps.mcpStore;
  const getLocalGateway = deps.getLocalGateway;
  const log = deps.log;
  const createRuntime = deps.createMcpRuntimeManager || createMcpRuntimeManager;
  const configured = deps.isMcpServerConfigured || isMcpServerConfigured;
  const pkgStore = deps.mcpPackageStore || mcpPackageStore;
  const Catalog = deps.McpCatalog || McpCatalog;
  const Skills = deps.SkillCatalog || SkillCatalog;
  const listIds = deps.listInstalledCatalogIds || listInstalledCatalogIds;
  const skillsDir = deps.dieyunSkillsDir || dieyunSkillsDir;

  try {
    const { app } = require('electron');
    if (app && !app.isPackaged) {
      const store = mcpStore.loadMcpStore(userData);
      let changed = false;
      for (const mcpId of OPEN_API_MCP_IDS) {
        const service = String(mcpId).replace(/^mcp-/, '');
        const deployEnv = getDieyunOpenApiEnvFromDeploy({ serviceId: service });
        const hasKey = Object.keys(deployEnv).some(
          (k) => k.endsWith('_API_KEY') && String(deployEnv[k] || '').trim()
        );
        if (hasKey && !Object.prototype.hasOwnProperty.call(store.enabled || {}, mcpId)) {
          store.enabled = store.enabled || {};
          store.enabled[mcpId] = true;
          changed = true;
          log.info(`开发模式：已启用预装 MCP ${mcpId}（凭据来自 deploy.local.json）`);
        }
      }
      if (changed) mcpStore.saveMcpStore(userData, store);
    }
  } catch {
    // 非 Electron / 测试环境
  }

  let mcpRuntime = deps.existingRuntime || null;
  if (!mcpRuntime) {
    mcpRuntime = createRuntime(
      () => {
        const creds = mcpStore.ensureMcpCredentialsStore(userData);
        return mcpStore.listMcpServersForUi(userData).filter((server) => {
          return (
            server.enabled &&
            configured(server, { getSecretMeta: (id) => creds.getSecretMeta(id) })
          );
        });
      },
      {
        catalogPath: path.join(userData, 'mcp-tools-catalog.json'),
        // 会话断开 / 连接失败落到主日志：MCP 出问题时的第一现场在 logs/main.log
        log: (msg) => log.warn(msg),
        getServerSecrets: (id) => {
          const raw = mcpStore.ensureMcpCredentialsStore(userData).loadSecrets(id);
          return mergeMcpServerSecrets(id, raw);
        },
        getWorkspacePath: () => {
          try {
            const gw = getLocalGateway();
            return gw && gw.getWorkspace ? gw.getWorkspace().workspacePath || '' : '';
          } catch {
            return '';
          }
        },
        ensureLocalPackage: async (server) => {
          try {
            const bundled = resolveBundledMcpLaunch(server);
            if (bundled) return { server: bundled, bundled: true };
          } catch (err) {
            if (err && err.code === 'BUNDLED_MCP_MISSING') throw err;
          }
          return pkgStore.ensureMcpNpmPackage({
            userDataPath: userData,
            server
          });
        }
      }
    );
  }

  let mcpCatalog = deps.existingMcpCatalog || null;
  if (!mcpCatalog) {
    mcpCatalog = new Catalog({
      userDataPath: userData,
      log: (msg) => log.warn(msg),
      listInstalled: () => mcpStore.listMcpServersForUi(userData),
      upsertInstalled: (payload) => {
        return mcpStore.upsertMcpFromCatalog(userData, payload);
      }
    });
  }

  let skillCatalog = deps.existingSkillCatalog || null;
  if (!skillCatalog) {
    skillCatalog = new Skills({
      userDataPath: userData,
      log: (msg) => log.warn(msg),
      listInstalled: () => listIds(skillsDir())
    });
  }

  return { mcpRuntime, mcpCatalog, skillCatalog };
}

/**
 * @param {object} deps
 * @param {() => object | null} deps.getPlansStore
 * @param {() => object | null} deps.getLocalGateway
 * @param {() => { notifyScheduledPlanTray: Function } | null} deps.getTrayNotify
 * @param {() => { getMainWindow?: () => { webContents?: { send: Function } } | null } | null} deps.getWindowTray
 * @param {McpPlansLog} deps.log
 * @param {typeof deliverPlanResult} [deps.deliverPlanResult]
 */
function createFinishPlanRun(deps) {
  const deliver = deps.deliverPlanResult || deliverPlanResult;
  return async function finishPlanRun(plan, result) {
    const plansStore = deps.getPlansStore();
    if (!plan || !plansStore) return result;
    const stopped = !!(result && (result.aborted || result.stopped));
    // 用户主动停止没有「结果」可言：不覆盖上一次成功/失败的结论
    if (!stopped) plansStore.updateRunResult(plan.id, result);
    let sessionId = result && result.sessionId ? String(result.sessionId) : null;
    const localGateway = deps.getLocalGateway();
    if (!sessionId) {
      try {
        sessionId = await deliver(localGateway, plan, result);
      } catch (e) {
        deps.log.warn('计划投递会话失败:', e && e.message);
      }
    }
    const fresh = plansStore.get(plan.id) || plan;
    const payload = {
      planId: fresh.id,
      planName: fresh.name,
      sessionId: sessionId || (fresh.deliver && fresh.deliver.sessionId) || null,
      ok: !!(result && result.ok),
      stopped,
      summary: result && result.summary ? String(result.summary) : '',
      error: result && result.error ? String(result.error) : ''
    };
    const trayNotify = deps.getTrayNotify && deps.getTrayNotify();
    if (trayNotify) trayNotify.notifyScheduledPlanTray(fresh, result);
    const windowTray = deps.getWindowTray && deps.getWindowTray();
    const win = windowTray && windowTray.getMainWindow ? windowTray.getMainWindow() : null;
    if (win && win.webContents) {
      win.webContents.send('plans:ran', payload);
    }
    return result;
  };
}

/**
 * @param {object} deps
 * @param {string} deps.userData
 * @param {() => object | null} deps.getLocalGateway
 * @param {() => object | null} deps.getCoreBridge
 * @param {() => object | null} deps.getMcpRuntime
 * @param {() => object | null} deps.getWindowTray
 * @param {(webContents?: object | null) => object} deps.createToolBridge
 * @param {() => object} deps.ensureMainCompactionAgent
 * @param {() => object | null} deps.getTrayNotify
 * @param {McpPlansLog} deps.log
 * @param {typeof PlansStore} [deps.PlansStore]
 * @param {typeof PlansScheduler} [deps.PlansScheduler]
 * @param {typeof runPlan} [deps.runPlan]
 * @param {typeof deliverPlanResult} [deps.deliverPlanResult]
 */
function bootPlansRuntime(deps) {
  const Store = deps.PlansStore || PlansStore;
  const Scheduler = deps.PlansScheduler || PlansScheduler;
  const run = deps.runPlan || runPlan;
  const userData = deps.userData;
  const log = deps.log;

  const plansStore = new Store(userData);
  /** @type {Map<string, { runId: string, sessionId: string, startedAt: number, controller: AbortController }>} */
  const runningPlans = new Map();

  const getMainWindowWebContents = () => {
    try {
      const tray = deps.getWindowTray && deps.getWindowTray();
      const win = tray && tray.getMainWindow ? tray.getMainWindow() : null;
      return win && win.webContents ? win.webContents : null;
    } catch {
      return null;
    }
  };

  /** 计划运行事件 → Renderer（窗口不在 / 正在关闭时静默丢弃） */
  const sendPlanPhase = (event) => {
    const wc = getMainWindowWebContents();
    if (!wc || typeof wc.send !== 'function') return;
    try {
      wc.send('plans:phase', event);
    } catch {
      // 窗口销毁竞态：事件是纯 UI 增量，丢了不影响落库
    }
  };

  const finishPlanRun = createFinishPlanRun({
    getPlansStore: () => plansStore,
    getLocalGateway: deps.getLocalGateway,
    getTrayNotify: deps.getTrayNotify,
    getWindowTray: deps.getWindowTray,
    log,
    deliverPlanResult: deps.deliverPlanResult
  });

  const emitRunStart = (info) =>
    sendPlanPhase(
      createAgentRunEvent(AGENT_RUN_EVENT_TYPES.RUN_START, {
        sessionId: info.sessionId || null,
        runId: info.runId,
        meta: { planId: info.planId, planName: info.planName, startedAt: info.startedAt }
      })
    );

  /** agent-limits 快照：轮询间隔、目标型预算/超时/退避的唯一数字来源 */
  const agentLimits = () => getAgentLimits(userData, '') || {};

  /**
   * 计划运行的工作空间：计划显式绑定优先，否则用此刻的当前工作空间（历史行为）。
   * 定时执行没有打开的会话，计划的目录必须随计划落盘（见 plans/store#workspace），
   * 否则「选了目录」到点仍会跑在碰巧开着的那个工作区里。
   */
  const resolvePlanWorkspacePath = (plan) => {
    const bound = String((plan && plan.workspace) || '').trim();
    if (bound) return bound;
    try {
      const gw = deps.getLocalGateway();
      const ws = gw && typeof gw.getWorkspace === 'function' ? gw.getWorkspace() || {} : {};
      return ws.workspacePath || null;
    } catch {
      return null;
    }
  };

  const plansScheduler = new Scheduler({
    getPlans: () => plansStore.list(),
    // 闲时队列（plans trigger=idle）：忙信号唯一来源 = 活跃 agent loop 计数
    //（聊天 / Planner worker / 计划运行全走 runRustAgentLoop）。数值上限只认 agent-limits。
    isBusy: deps.isBusy || (() => getActiveAgentLoopCount() > 0),
    idlePollMs: agentLimits().plansIdlePollMs,
    idleQuietMs: agentLimits().plansIdleQuietMs,
    runPlan: async (plan) => {
      log.info(`计划开始: ${plan.name}`);
      const runId = `plan-${plan.id}-${Date.now().toString(36)}`;
      const controller = new AbortController();
      const startedAt = Date.now();
      const record = {
        runId,
        planId: plan.id,
        planName: plan.name,
        sessionId: (plan.deliver && plan.deliver.sessionId) || '',
        startedAt,
        controller
      };
      runningPlans.set(plan.id, record);

      let sessionId = record.sessionId;
      const baseMeta = { planId: plan.id, planName: plan.name, startedAt };

      // llm_delta 是逐 SSE chunk 触发：不节流会把整条 trace 以每秒几十次的频率过 IPC
      let pendingTrace = null;
      let traceTimer = null;
      const flushTrace = () => {
        if (traceTimer) {
          clearTimeout(traceTimer);
          traceTimer = null;
        }
        if (!pendingTrace) return;
        const { rows, streamContent } = pendingTrace;
        pendingTrace = null;
        sendPlanPhase(
          createAgentRunEvent(AGENT_RUN_EVENT_TYPES.TRACE, {
            sessionId: sessionId || null,
            runId,
            trace: rows,
            streamContent,
            meta: baseMeta
          })
        );
      };
      const queueTrace = (rows, streamContent) => {
        pendingTrace = { rows, streamContent };
        if (traceTimer) return;
        traceTimer = setTimeout(flushTrace, PLAN_TRACE_FLUSH_MS);
      };

      const trace = createPlanRunTrace({
        phaseLabel: '执行计划',
        onUpdate: ({ trace: rows, streamContent }) => queueTrace(rows, streamContent)
      });

      // 运行边界（唯一入口）：先确保计划专用会话存在、并写入本次触发的用户轮次，再广播 run_start。
      // 顺序很重要 —— memory.sessions_list 只返回「有消息」的会话，会话里先有这一轮，
      // Renderer 才能在运行一开始就刷新出该会话与「运行中」；反过来（只在收尾投递时写）
      // 就表现为「计划跑完了才出现会话」。
      const gw = deps.getLocalGateway();
      const limits = agentLimits();
      let boundPlan = plan;
      let planUserPrompt = '';
      if (gw && typeof gw.invokeRpc === 'function') {
        try {
          const begun = await beginPlanRunTurn(gw, plansStore, plan, { limits });
          boundPlan = begun.plan;
          sessionId = begun.sessionId;
          planUserPrompt = begun.userText;
          record.sessionId = sessionId;
          if (begun.rebuilt) {
            log.warn(
              `计划绑定会话已失联，已重建: ${plan.name} (${begun.staleSessionId || '未知'} → ${sessionId})`
            );
          }
          // 运行边界落盘：用户轮次已在会话里，从这里开始到 endRun 之间的任何进程退出
          // 都会在下次启动被 recoverInterruptedRuns 补上中断回执。
          plansStore.beginRun(plan.id, { runId, sessionId });
        } catch (e) {
          log.warn('计划会话准备失败:', (e && e.message) || String(e));
        }
      }
      emitRunStart(record);

      const isGoal = boundPlan.trigger === 'goal';
      /** 本次运行的工作空间：计划绑定优先，否则当前工作空间 */
      const planWorkspacePath = resolvePlanWorkspacePath(boundPlan);
      /** 验收命令的工作目录：计划显式指定优先，否则用计划运行的工作区 */
      const verifyCwd = (boundPlan.goal && boundPlan.goal.cwd) || planWorkspacePath || undefined;
      /** 目标型收尾判定结果（非目标型恒为 null） */
      let goalStop = null;
      let goalVerify = null;
      let goalBudget = null;
      let goalNextDelayMs = null;

      // 目标型第一步：开工基线（尺子自检）。
      // 只在「还没跑过任何一轮」「还没量过」时做一次：命令若在未动工时就已经通过，
      // 它无法区分「干没干完」，此时继续跑一整晚毫无意义 —— 直接停并说明原因。
      if (isGoal && !boundPlan.baseline && (Number(boundPlan.attempt) || 0) === 0) {
        if (gw && typeof gw.invokeRpc === 'function') {
          const b = await runGoalVerify({
            gateway: gw,
            plan: boundPlan,
            limits,
            cwd: verifyCwd,
            sessionId: sessionId || undefined,
            runId,
            log: (m) => log.warn(m)
          });
          plansStore.setBaseline(plan.id, {
            red: !b.ok,
            exitCode: b.exitCode,
            tail: b.tail,
            note: b.note
          });
          if (b.ok) {
            goalStop = 'baseline-green';
            goalVerify = { ...b, ok: true, note: 'baseline-green' };
            plansStore.updateVerify(plan.id, goalVerify);
            log.warn(`目标型验收命令在未动工时已通过，已终止: ${plan.name}`);
          }
        } else {
          log.warn('Gateway 未就绪，跳过验收基线自检');
        }
      }

      if (isGoal && !goalStop) plansStore.beginAttempt(plan.id);

      let result;
      const planCtx = {
        userData,
        workspacePath: planWorkspacePath,
        gateway: gw,
        plansStore,
        coreBridge: deps.getCoreBridge(),
        mcpRuntime: deps.getMcpRuntime(),
        createToolBridge: (webContents) => {
          const win = webContents || getMainWindowWebContents();
          return deps.createToolBridge(win || null);
        },
        compactionAgent: deps.ensureMainCompactionAgent(),
        webContents: getMainWindowWebContents(),
        signal: controller.signal,
        // 会话与本次触发的用户轮次已经在 run_start 之前就绪，这里只转发执行阶段的进度
        sessionId,
        planUserPrompt,
        onPlanPhase: (name, data) => {
          trace.handlePhase(name, data);
        },
        log: (m) => log.info(m)
      };
      if (goalStop) {
        // 基线就红了（尺子无效）：这一轮不执行 agent，只落一条「为什么没跑」的说明
        result = {
          ok: false,
          error: '验收命令在尚未动工时就已经通过，无法判定完成，已停止',
          summary: '验收基线未通过（尺子无效）'
        };
      } else {
        try {
          result = await run(planCtx, boundPlan);
        } catch (e) {
          result = { ok: false, error: (e && e.message) || String(e) };
        } finally {
          runningPlans.delete(plan.id);
        }
      }
      if (!result || typeof result !== 'object') {
        result = { ok: false, error: '计划执行未返回结果' };
      }

      // 目标型：跑完命令再判定（判定权在 Main，不在模型；模型自称完成不算）
      if (isGoal && !goalStop) {
        goalVerify = await runGoalVerify({
          gateway: gw,
          plan: plansStore.get(plan.id) || boundPlan,
          limits,
          cwd: verifyCwd,
          sessionId: sessionId || undefined,
          runId,
          log: (m) => log.warn(m)
        });
        plansStore.updateVerify(plan.id, goalVerify);
        const fresh = plansStore.get(plan.id) || boundPlan;
        const decision = decideContinuation({ plan: fresh, verify: goalVerify, limits, now: Date.now() });
        goalBudget = decision.budget;
        if (decision.cont) {
          goalNextDelayMs = decision.delayMs;
        } else {
          goalStop = decision.stop;
        }
        log.info(
          `目标型验收: ${plan.name} / ${goalVerify.note}${goalVerify.exitCode == null ? '' : ` (exit ${goalVerify.exitCode})`}` +
            (decision.cont ? ` → ${Math.round(decision.delayMs / 1000)}s 后续跑` : ` → 停止(${decision.stop})`)
        );
      }
      // 目标型的「这一轮是否成功」= 验收是否通过：交给 updateRunResult 统一落 lastRunOk
      if (goalVerify) result.verify = goalVerify;

      // assistant 轮次必须在终态事件之前落库：Renderer 收到 DONE/STOPPED/ERROR 就会重载该会话，
      // 消息先在库里，重载才能立刻看到这一轮（含 traceRunId —— 思考过程靠它挂回气泡）
      let replyText = assistantReplyText(result);
      if (isGoal && goalStop && goalStop !== 'done') {
        // 停下来时附「未完成报告」：预算耗尽不是完成，措辞上必须能与「做完了」区分开
        replyText = `${replyText}\n\n${buildGoalAuditReport({
          plan: plansStore.get(plan.id) || boundPlan,
          verify: goalVerify,
          stop: goalStop,
          budget: goalBudget
        })}`;
      }
      if (sessionId) {
        result.sessionId = sessionId;
        try {
          await endPlanRunTurn(gw, sessionId, boundPlan, result, { traceRunId: runId, replyText });
        } catch (e) {
          log.warn('计划会话落库失败:', (e && e.message) || String(e));
        }
      }
      // 边界收束：assistant 轮次已落库（或已确认落不了），运行态不再需要重启恢复。
      // 残留只可能来自「进程被杀」，那时这里根本不会执行 —— 由启动恢复接管。
      plansStore.endRun(plan.id);
      // 目标型收尾：只有「还要继续」才排下一轮；任何停止（完成/预算/阻塞/尺子无效）
      // 都直接停用，不留一条会在凌晨自己又跑起来的尾巴。
      if (isGoal) {
        if (goalNextDelayMs != null) plansStore.scheduleNextAttempt(plan.id, goalNextDelayMs);
        else if (goalStop) plansStore.setEnabled(plan.id, false);
      }
      // 终态之前先把攒着的 trace 推完，否则最后几轮进度会被终态事件吃掉
      flushTrace();

      const stopped = !!(result && (result.aborted || result.stopped));
      sendPlanPhase(
        createAgentRunEvent(
          stopped
            ? AGENT_RUN_EVENT_TYPES.STOPPED
            : result && result.ok
              ? AGENT_RUN_EVENT_TYPES.DONE
              : AGENT_RUN_EVENT_TYPES.ERROR,
          {
            sessionId: sessionId || null,
            runId,
            // 正文与落库同源：终态事件带上这一轮的最终正文，Renderer 收尾时
            // 气泡收成什么，就与重载会话后看到的消息完全一致（模型不流式正文时也不会空）
            streamContent: replyText,
            summary: result && result.summary ? String(result.summary) : '',
            error: result && result.error ? String(result.error) : '',
            stopped,
            meta: baseMeta
          }
        )
      );
      finishPlanRun(boundPlan, result).catch((e) => log.warn('计划收尾失败:', e && e.message));
      log.info(`计划结束: ${plan.name}`, stopped ? 'stopped' : result.ok ? 'ok' : String(result.error || ''));
      return result;
    },
    log: (m) => log.info(m)
  });

  /**
   * 启动恢复：上次进程被杀时 Main 的收尾不会执行，会话里会留下一条永远没有回复的
   * 用户轮次（界面停在悬空轮次上）。这里按落盘的 runState 补写一条中断回执。
   *
   * 只补回执、不重跑：重跑会让用户看到两次执行。写回执失败（Gateway 未就绪等）
   * 时保留 runState，下次启动重试，避免把未回复的轮次永久留在会话里。
   *
   * @returns {Promise<number>} 本次恢复的计划条数
   */
  const recoverInterruptedRuns = async () => {
    const stale = typeof plansStore.listRunning === 'function' ? plansStore.listRunning() : [];
    if (!stale.length) return 0;
    const gw = deps.getLocalGateway();
    let recovered = 0;
    for (const { plan, runState } of stale) {
      const sessionId = String(runState.sessionId || (plan.deliver && plan.deliver.sessionId) || '');
      const result = interruptedRunResult(
        `应用在计划执行期间退出或重启（${runState.startedAt || '未知时间'}）`
      );
      if (sessionId && gw && typeof gw.invokeRpc === 'function') {
        try {
          // 不写 traceRunId：那次运行的 trace 随进程丢失，挂上去只会留下空思考区
          await endPlanRunTurn(gw, sessionId, plan, result, {
            replyText: assistantReplyText(result)
          });
          result.sessionId = sessionId;
        } catch (e) {
          log.warn(`计划中断回执写入失败，保留待下次启动重试 ${plan.name}:`, (e && e.message) || String(e));
          continue;
        }
      }
      plansStore.endRun(plan.id);
      // 复用统一收尾：写 lastRun 结论 + 托盘/插件事件（窗口未就绪时内部自动跳过）
      await finishPlanRun(plan, result).catch((e) =>
        log.warn('计划中断收尾失败:', (e && e.message) || String(e))
      );
      // 目标型：崩溃时这一轮没有被验收过，恢复的语义是「再排一轮」而不是「重跑同一轮」。
      // 仍然受 attempt / 墙钟预算约束，且带退避——崩溃本身不构成「无限重试」的理由。
      if (plan.trigger === 'goal' && plan.enabled) {
        try {
          const decision = decideContinuation({
            plan: plansStore.get(plan.id) || plan,
            verify: { ok: false, note: 'interrupted' },
            limits: agentLimits(),
            now: Date.now()
          });
          if (decision.cont) {
            plansStore.scheduleNextAttempt(plan.id, decision.delayMs);
            log.warn(
              `目标型计划上次未收尾，已排下一轮（${Math.round(decision.delayMs / 1000)}s 后）: ${plan.name}`
            );
          } else {
            plansStore.setEnabled(plan.id, false);
            log.warn(`目标型计划上次未收尾且预算已尽，已停用: ${plan.name}（${decision.stop}）`);
          }
        } catch (e) {
          log.warn('目标型崩溃恢复排程失败:', (e && e.message) || String(e));
        }
      }
      recovered += 1;
      log.warn(`计划上次未收尾，已补写中断回执: ${plan.name}`);
    }
    return recovered;
  };

  /**
   * 启动恢复带有限重试：Gateway 尚未就绪时不能放弃，
   * 否则那条悬空轮次要一直挂到下次启动。
   */
  const scheduleRecover = (attempt = 0) => {
    void recoverInterruptedRuns()
      .catch((e) => log.warn('计划中断恢复失败:', (e && e.message) || String(e)))
      .then(() => {
        const left =
          typeof plansStore.listRunning === 'function' ? plansStore.listRunning().length : 0;
        if (left <= 0) return;
        if (attempt < 3) setTimeout(() => scheduleRecover(attempt + 1), 5000).unref?.();
        else log.warn(`仍有 ${left} 条计划运行未收尾，留待下次启动恢复`);
      });
  };

  plansScheduler.reload();
  scheduleRecover();

  /** @returns {Array<{ planId: string, runId: string, sessionId: string, startedAt: number }>} */
  const listRunningPlans = () =>
    [...runningPlans.values()].map((r) => ({
      planId: r.planId,
      runId: r.runId,
      sessionId: r.sessionId,
      startedAt: r.startedAt
    }));

  /** 用户从 UI 停止计划：只中止当前这次运行，不改变计划的启用状态 */
  const cancelPlanRun = (planId) => {
    const rec = runningPlans.get(String(planId || ''));
    if (!rec) return { ok: false, error: '计划未在运行' };
    try {
      rec.controller.abort();
    } catch {
      // ignore
    }
    return { ok: true };
  };

  return {
    plansStore,
    plansScheduler,
    finishPlanRun,
    listRunningPlans,
    cancelPlanRun,
    recoverInterruptedRuns
  };
}

/**
 * @param {object} deps
 * @param {string} deps.userData
 * @param {() => { upsert: Function, get?: Function } | null} deps.getPlansStore
 * @param {() => { reload: Function } | null} deps.getPlansScheduler
 * @param {() => object | null} deps.getLocalGateway
 * @param {typeof parsePlanFromText} [deps.parsePlanFromText]
 * @param {typeof ensurePlanSession} [deps.ensurePlanSession]
 */
function createPlansCreateFromText(deps) {
  const parse = deps.parsePlanFromText || parsePlanFromText;
  const ensureSession = deps.ensurePlanSession || ensurePlanSession;
  return async function plansCreateFromText(payload) {
    const plansStore = deps.getPlansStore();
    if (!plansStore) throw new Error('计划存储未就绪');
    const text = payload && payload.text != null ? String(payload.text) : '';
    if (!text.trim()) throw new Error('请提供计划描述');
    const plan = await parse(deps.userData, text, {
      skillIds: payload && payload.skillIds ? payload.skillIds : [],
      // 结构化优先：给了 rrule / onceAt 就直接落盘，不再调模型解析
      structured: payload && payload.structured ? payload.structured : undefined,
      // 模型配置解析用的路由（缺失时 parse 内部走兜底）
      route: payload && payload.modelRoute ? payload.modelRoute : undefined,
      model: payload && payload.model ? payload.model : undefined
    });
    // 计划绑定本次运行的路由，供定时执行（无 Renderer）自洽解析；只存路由，不存 apiKey
    let saved = plansStore.upsert({
      ...plan,
      modelRoute: (payload && payload.modelRoute) || plan.modelRoute || '',
      model: (payload && payload.model) || plan.model || ''
    });
    const localGateway = deps.getLocalGateway();
    if (localGateway) {
      saved = (await ensureSession(localGateway, plansStore, saved)).plan;
    }
    const plansScheduler = deps.getPlansScheduler();
    if (plansScheduler) plansScheduler.reload();
    return { ok: true, plan: saved };
  };
}

module.exports = {
  bootMcpSkillCatalogs,
  bootPlansRuntime,
  createFinishPlanRun,
  createPlansCreateFromText
};
