'use strict';

const {
  shouldBlockRepeatToolCall,
  recordToolCallFingerprint,
  repeatToolBlockMessage,
  normalizeAgentToolName
} = require('./tool-guardrails');
const { validateToolArgs } = require('./tool-validate');
const { spillToolOutputIfLarge } = require('./tool-output-spill');
const { recordToolTelemetry } = require('./tool-telemetry');

const { getAgentLimits } = require('./agent-limits');

function sleepMs(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function formatArgsBrief(name, args) {
  if (!args || typeof args !== 'object') return '';
  if (name === 'host_exec') return String(args.command || '').slice(0, 80);
  try {
    const s = JSON.stringify(args);
    return s.length > 80 ? `${s.slice(0, 80)}…` : s;
  } catch {
    return '';
  }
}

function classifyFailure(name, result, thrownErr) {
  if (thrownErr) {
    const msg = String(thrownErr.message || thrownErr);
    if (/timeout|ECONNRESET|ETIMEDOUT|ENOTFOUND|429|502|503|socket hang up|display surface not available|not available for capture/i.test(msg)) {
      return { retryable: true, errorCode: 'TRANSIENT', error: msg };
    }
    return { retryable: false, errorCode: 'EXCEPTION', error: msg };
  }
  if (!result || typeof result !== 'object') return null;
  if (result.ok === false && result.errorCode) {
    return {
      retryable: !!result.retryable,
      errorCode: result.errorCode,
      error: result.error || '工具失败',
      suggestedFix: result.suggestedFix
    };
  }
  if (result.error) {
    const err = String(result.error);
    if (result.retryable === true) {
      return { retryable: true, errorCode: result.errorCode || 'TRANSIENT', error: err };
    }
    if (/超时|timeout|ECONN|503|502|429|暂时|not ready|display surface|not available for capture/i.test(err)) {
      return { retryable: true, errorCode: 'TRANSIENT', error: err };
    }
    if (/安全策略|BLOCKED|重复|缺少|无效|未知工具|validation|拒绝/i.test(err)) {
      return { retryable: false, errorCode: 'POLICY', error: err };
    }
    return { retryable: false, errorCode: 'TOOL_ERROR', error: err };
  }
  return null;
}

function wrapStructuredError(failure, extra = {}) {
  return {
    ok: false,
    error: failure.error,
    errorCode: failure.errorCode,
    retryable: !!failure.retryable,
    suggestedFix: failure.suggestedFix || extra.suggestedFix || undefined,
    ...extra
  };
}

class ToolHarnessSession {
  /**
   * @param {{ runId?: string, sessionId?: string, model?: string, workspacePath?: string, userDataPath?: string }} ctx
   */
  constructor(ctx = {}) {
    this.ctx = ctx;
    this.fingerprints = [];
    this.spillSeq = 0;
    this.runKey = String(ctx.runId || ctx.sessionId || 'run');
  }

  validationError(name, args, v) {
    recordToolTelemetry(this.ctx.userDataPath, {
      tool: name,
      ok: false,
      errorCode: v.errorCode,
      model: this.ctx.model,
      sessionId: this.ctx.sessionId,
      durationMs: 0
    });
    return wrapStructuredError(
      { retryable: false, errorCode: v.errorCode, error: v.error },
      { suggestedFix: v.suggestedFix }
    );
  }

  repeatBlockError(name, args, limit) {
    const brief = formatArgsBrief(name, args);
    const msg = repeatToolBlockMessage(
      name,
      brief,
      this.ctx.userDataPath,
      this.ctx.contextTierId,
      this.ctx.model,
      limit
    );
    recordToolTelemetry(this.ctx.userDataPath, {
      tool: name,
      ok: false,
      errorCode: 'REPEAT_BLOCK',
      model: this.ctx.model,
      sessionId: this.ctx.sessionId,
      durationMs: 0
    });
    return wrapStructuredError(
      { retryable: false, errorCode: 'REPEAT_BLOCK', error: msg },
      { repeated: true }
    );
  }

  postProcessSuccess(name, raw) {
    this.spillSeq += 1;
    let out = spillToolOutputIfLarge(name, raw, {
      runId: this.runKey,
      sessionId: this.ctx.sessionId,
      workspacePath: this.ctx.workspacePath,
      userDataPath: this.ctx.userDataPath,
      spillSeq: this.spillSeq
    });
    if (out && typeof out === 'object' && out.error) {
      return out;
    }
    return out;
  }

  /**
   * @param {string} name
   * @param {object} args
   * @param {() => Promise<object>} invokeFn
   */
  async execute(name, args, invokeFn) {
    const norm = normalizeAgentToolName(name, args);
    const toolName = norm.name;
    args = norm.args;
    const started = Date.now();

    const validation = validateToolArgs(toolName, args);
    if (!validation.ok) {
      return this.validationError(toolName, args, validation);
    }

    const tierId = this.ctx.contextTierId || 'default';
    const lim = getAgentLimits(this.ctx.userDataPath, tierId);
    if (
      shouldBlockRepeatToolCall(
        toolName,
        args,
        this.fingerprints,
        undefined,
        this.ctx.userDataPath,
        tierId,
        this.ctx.model
      )
    ) {
      return this.repeatBlockError(toolName, args);
    }
    recordToolCallFingerprint(
      this.fingerprints,
      toolName,
      args,
      this.ctx.userDataPath,
      tierId,
      this.ctx.model
    );

    let lastFailure = null;
    const transientMaxRetries = lim.transientMaxRetries;
    const retryBaseMs = lim.retryBaseMs;
    for (let attempt = 0; attempt <= transientMaxRetries; attempt++) {
      try {
        const raw = await invokeFn(toolName, args);
        const failure = classifyFailure(toolName, raw, null);
        if (failure && failure.retryable && attempt < transientMaxRetries) {
          lastFailure = failure;
          await sleepMs(retryBaseMs * (attempt + 1));
          continue;
        }
        if (failure) {
          recordToolTelemetry(this.ctx.userDataPath, {
            tool: toolName,
            ok: false,
            errorCode: failure.errorCode,
            model: this.ctx.model,
            sessionId: this.ctx.sessionId,
            durationMs: Date.now() - started,
            attempt
          });
          return wrapStructuredError(failure, { attempts: attempt + 1 });
        }
        recordToolTelemetry(this.ctx.userDataPath, {
          tool: toolName,
          ok: true,
          errorCode: 'ok',
          model: this.ctx.model,
          sessionId: this.ctx.sessionId,
          durationMs: Date.now() - started,
          attempt
        });
        return this.postProcessSuccess(toolName, raw);
      } catch (e) {
        const failure = classifyFailure(toolName, null, e);
        if (failure.retryable && attempt < transientMaxRetries) {
          lastFailure = failure;
          await sleepMs(retryBaseMs * (attempt + 1));
          continue;
        }
        recordToolTelemetry(this.ctx.userDataPath, {
          tool: toolName,
          ok: false,
          errorCode: failure.errorCode,
          model: this.ctx.model,
          sessionId: this.ctx.sessionId,
          durationMs: Date.now() - started,
          attempt
        });
        return wrapStructuredError(failure, { attempts: attempt + 1 });
      }
    }
    return wrapStructuredError(lastFailure || { retryable: false, errorCode: 'TOOL_ERROR', error: '工具失败' });
  }
}

/** @type {Map<string, ToolHarnessSession>} */
const sessions = new Map();

function harnessSessionKey(ctx) {
  return `${ctx.sessionId || 's'}::${ctx.runId || 'r'}`;
}

function getToolHarnessSession(ctx = {}) {
  const key = harnessSessionKey(ctx);
  let session = sessions.get(key);
  if (!session) {
    session = new ToolHarnessSession(ctx);
    sessions.set(key, session);
  } else {
    session.ctx = { ...session.ctx, ...ctx };
  }
  return session;
}

function clearToolHarnessSession(ctx = {}) {
  sessions.delete(harnessSessionKey(ctx));
}

function clearToolHarnessSessionsForSession(sessionId) {
  const sid = String(sessionId || '');
  for (const key of [...sessions.keys()]) {
    if (key.startsWith(`${sid}::`)) sessions.delete(key);
  }
}

module.exports = {
  ToolHarnessSession,
  getToolHarnessSession,
  clearToolHarnessSession,
  clearToolHarnessSessionsForSession,
  classifyFailure,
  formatArgsBrief
};
