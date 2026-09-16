'use strict';

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

    'agent.trace_save': async ({
      runId,
      sessionId,
      messageId,
      userMessageId,
      trace,
      traceText,
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
        traceText,
        phase,
        status,
        summary,
        stateSnapshot
      }),

    'agent.trace_get': async ({ runId, messageId }) =>
      requireRustCore('agent.trace_get', { runId, messageId })
  };
}

module.exports = { createAgentHandlers };
