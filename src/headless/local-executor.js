'use strict';

/**
 * `AgentService.executor` 的**无窗口实现**：同一个进程里把这轮跑完。
 *
 * 桌面的 executor 是「转发给 Renderer」；这里没有 Renderer，于是直接调
 * `agent/main-turn-runner#runMainTurn` —— 与频道、定时计划同一条路径。
 *
 * 事件契约照抄 Renderer 那一侧（`acceptTask` / `progressTask` / `completeTask`），
 * 所以手机端、浏览器端、桌面端看到的是同一套 `AgentRunEvent`；不为 headless 造平行事件。
 */

const { runMainTurn } = require('../agent/main-turn-runner');
const { createPlanRunTrace } = require('../plans/plan-run-events');

/** trace 增量推给前端的合并窗口（与计划 / 桌面 120ms 同级） */
const PROGRESS_FLUSH_MS = 120;
const SUMMARY_CHARS = 400;

/** 会话绑定的工作空间优先；没有绑定就用 headless 的默认工作空间。 */
async function resolveSessionWorkspace(gateway, sessionId, fallback) {
  const fb = String(fallback || '');
  try {
    const row = await gateway.invokeRpc('memory.session_get', { sessionId });
    const bound = row && row.workspacePath ? String(row.workspacePath) : '';
    return bound || fb;
  } catch {
    return fb;
  }
}

/**
 * @param {{
 *   agentService: object,
 *   userData: string,
 *   getGateway: () => any,
 *   getCoreBridge: () => any,
 *   getMcpRuntime: () => any,
 *   getCompactionAgent: () => any,
 *   createToolBridge: (webContents: any) => any,
 *   workspacePath: string,
 *   model?: string,
 *   route?: string,
 *   runSource?: string,
 *   listMcpServers?: (userDataPath: string) => any[],
 *   log?: (msg: string) => void
 * }} deps
 */
function createLocalExecutor(deps) {
  const log = typeof deps.log === 'function' ? deps.log : () => {};
  /** requestId → { controller, sessionId } */
  const active = new Map();

  async function runOne(task) {
    const requestId = String((task && task.requestId) || '');
    const sessionId = String((task && task.sessionId) || '');
    const text = String((task && task.text) || '').trim();
    if (!requestId || !sessionId || !text) return;
    const controller = new AbortController();
    active.set(requestId, { controller, sessionId });
    deps.agentService.acceptTask({ requestId, sessionId });

    const trace = createPlanRunTrace({ phaseLabel: '执行任务' });
    let timer = null;
    const flush = () => {
      timer = null;
      const { trace: rows, streamContent } = {
        trace: trace.snapshot(),
        streamContent: trace.getStreamContent()
      };
      deps.agentService.progressTask({ requestId, sessionId, trace: rows, streamContent });
    };
    const scheduleFlush = () => {
      if (timer) return;
      timer = setTimeout(flush, PROGRESS_FLUSH_MS);
      if (typeof timer.unref === 'function') timer.unref();
    };

    try {
      const gateway = deps.getGateway();
      const coreBridge = deps.getCoreBridge();
      const workspacePath = await resolveSessionWorkspace(gateway, sessionId, deps.workspacePath);
      const result = await runMainTurn({
        userData: deps.userData,
        gateway,
        coreBridge,
        mcpRuntime: deps.getMcpRuntime ? deps.getMcpRuntime() : null,
        compactionAgent: deps.getCompactionAgent ? deps.getCompactionAgent() : null,
        toolBridge: deps.createToolBridge(null),
        sessionId,
        workspacePath,
        userText: text,
        ledgerText: text,
        runSource: String(deps.runSource || 'headless'),
        model: deps.model || '',
        route: deps.route || '',
        signal: controller.signal,
        onPhase: (phase, data) => {
          trace.handlePhase(phase, data);
          scheduleFlush();
        },
        listMcpServers: deps.listMcpServers,
        // 共享记忆（跨机）：`runMainTurn` 读这个装配召回块；未配置/连不上时块自动缺席
        getSharedMemory: deps.getSharedMemory
      });
      if (timer) clearTimeout(timer);
      // 终态前先把攒着的 trace 推完，否则最后几轮进度会被终态事件吃掉
      flush();
      deps.agentService.completeTask({
        requestId,
        sessionId,
        status: result.aborted ? 'stopped' : 'completed',
        summary: String(result.content || '').slice(0, SUMMARY_CHARS),
        trace: result.trace,
        runId: result.runId || null
      });
    } catch (err) {
      if (timer) clearTimeout(timer);
      const userSafe = !!(err && err.userSafe);
      if (!userSafe) log(`headless 回合失败：${(err && err.stack) || err}`);
      deps.agentService.completeTask({
        requestId,
        sessionId,
        status: 'failed',
        error: userSafe ? String(err.message) : '执行失败，请查看服务端日志',
        trace: trace.snapshot()
      });
    } finally {
      active.delete(requestId);
    }
  }

  /** 桌面那边是「转发给 Renderer」，这里是「就地跑一轮」（不阻塞 submitTask 的返回） */
  function executor(task) {
    runOne(task).catch((err) => log(`headless 回合异常：${(err && err.stack) || err}`));
  }

  function canceller(payload) {
    const requestId = String((payload && payload.requestId) || '');
    const box = requestId ? active.get(requestId) : null;
    if (!box) return;
    try {
      box.controller.abort();
    } catch {
      // ignore
    }
  }

  /** 进程退出时用：把所有在跑的轮次按中止收尾，不留悬空请求 */
  function abortAll() {
    for (const [requestId, box] of active) {
      try {
        box.controller.abort();
      } catch {
        // ignore
      }
      active.delete(requestId);
    }
  }

  return { executor, canceller, abortAll, activeCount: () => active.size };
}

module.exports = { createLocalExecutor, resolveSessionWorkspace };
