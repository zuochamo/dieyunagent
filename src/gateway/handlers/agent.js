'use strict';

const { getAgentLimits } = require('../../agent/agent-limits');
const { shapeTraceForDisplay } = require('../../agent/trace-display');

/**
 * @param {{ requireRustCore: (method: string, params?: object, timeoutMs?: number) => Promise<unknown> }} deps
 */
function createAgentHandlers({ requireRustCore }) {
  return {
    'agent.run_upsert': async ({
      id,
      sessionId,
      userMessageId,
      assistantMessageId,
      status,
      summary,
      stateSnapshot
    }) =>
      requireRustCore('agent.run_upsert', {
        id,
        sessionId,
        userMessageId,
        assistantMessageId,
        status,
        summary,
        stateSnapshot
      }),

    'agent.plan_save': async ({
      id,
      runId,
      sessionId,
      version,
      status,
      parentPlanId,
      summary,
      plan,
      steps,
      stateSnapshot
    }) =>
      requireRustCore('agent.plan_save', {
        id,
        runId,
        sessionId,
        version,
        status,
        parentPlanId,
        summary,
        plan,
        steps,
        stateSnapshot
      }),

    'agent.steps_save': async ({ planId, runId, sessionId, steps, status }) =>
      requireRustCore('agent.steps_save', { planId, runId, sessionId, steps, status }),

    'agent.state_get': async ({ sessionId }) =>
      requireRustCore('agent.state_get', { sessionId: String(sessionId || '') }),

    // `traceText` 已废除：跨边界可回读的只有结构化 `trace`（思考通道隔离 §3.7 D4）。
    // 旧客户端仍可能带该字段，Rust 侧会忽略，不再透传，避免又出现一条「思考纯文本」通路。
    'agent.trace_save': async ({
      runId,
      sessionId,
      messageId,
      userMessageId,
      trace,
      traceFrom,
      phase,
      status,
      summary,
      stateSnapshot
    }) =>
      requireRustCore('agent.trace_save', {
        runId,
        sessionId,
        messageId,
        userMessageId,
        trace,
        traceFrom,
        phase,
        status,
        summary,
        stateSnapshot
      }),

    // `shape: 'display'` 只服务回放展示（渲染层按需换完整态）：裁掉界面从不读的字段、
    // 思考全文只留开头一截。**默认 full** —— 任何要落库 / 判定的调用方都别传 display。
    'agent.trace_get': async ({ runId, messageId, shape }) => {
      const row = await requireRustCore('agent.trace_get', { runId, messageId });
      if (shape !== 'display') return row;
      return shapeTraceForDisplay(row, {
        thoughtHeadChars: getAgentLimits().traceDisplayThoughtHeadChars
      });
    },

    // 批量读（回放一屏最多 32 条回合）：一次 core 调用取代逐条往返，展示态整形逐行复用同一份。
    'agent.traces_get': async ({ runIds, shape }) => {
      const rows = await requireRustCore('agent.traces_get', { runIds });
      if (shape !== 'display' || !rows || typeof rows !== 'object') return rows;
      const thoughtHeadChars = getAgentLimits().traceDisplayThoughtHeadChars;
      const shaped = {};
      for (const [runId, row] of Object.entries(rows.rows || {})) {
        shaped[runId] = shapeTraceForDisplay(row, { thoughtHeadChars });
      }
      return { ...rows, rows: shaped };
    }
  };
}

module.exports = { createAgentHandlers };
