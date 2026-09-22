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
const { sleepMs } = require('../llm-reconnect-retry');

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
    // 抛错同样可以带契约信息：网关 invokeRpc 原样抛出 handler 的 Error（保留 code），
    // 浏览器 runner 在点击失败 / 目标被遮挡 / 缺 ref 等场景还会挂 diagnostics 与 suggestedFix。
    // 一律折叠成 EXCEPTION 会让模型丢掉「失败在哪、下一步怎么改」，错误码也不再是契约。
    // 规则：有声明用声明，没有才回退到原有的消息启发式（retryable 判定口径不变）。
    const retryable =
      typeof thrownErr.retryable === 'boolean'
        ? thrownErr.retryable
        : /timeout|ECONNRESET|ETIMEDOUT|ENOTFOUND|429|502|503|socket hang up|display surface not available|not available for capture/i.test(msg);
    const failure = {
      retryable,
      errorCode: thrownErr.errorCode || thrownErr.code || (retryable ? 'TRANSIENT' : 'EXCEPTION'),
      error: msg
    };
    if (thrownErr.suggestedFix) failure.suggestedFix = thrownErr.suggestedFix;
    if (thrownErr.diagnostics) failure.diagnostics = thrownErr.diagnostics;
    return failure;
  }
  if (!result || typeof result !== 'object') return null;
  if (result.ok === false && result.errorCode) {
    const failure = {
      retryable: !!result.retryable,
      errorCode: result.errorCode,
      error: result.error || '工具失败',
      suggestedFix: result.suggestedFix
    };
    // 结构化诊断（浏览器实例 / ref 世代 / 遮挡元素 …）是错误体的一部分：
    // 归一化失败信封时必须原样带过，否则模型只看到「失败了」，看不到「失败在哪、下一步怎么改」。
    if (result.diagnostics) failure.diagnostics = result.diagnostics;
    return failure;
  }
  if (result.error) {
    const err = String(result.error);
    const diagnostics = result.diagnostics;
    if (result.retryable === true) {
      return { retryable: true, errorCode: result.errorCode || 'TRANSIENT', error: err, diagnostics };
    }
    if (/超时|timeout|ECONN|503|502|429|暂时|not ready|display surface|not available for capture/i.test(err)) {
      return { retryable: true, errorCode: 'TRANSIENT', error: err, diagnostics };
    }
    if (/安全策略|BLOCKED|重复|缺少|无效|未知工具|validation|拒绝/i.test(err)) {
      return { retryable: false, errorCode: 'POLICY', error: err, diagnostics };
    }
    return { retryable: false, errorCode: 'TOOL_ERROR', error: err, diagnostics };
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
    ...(failure.diagnostics ? { diagnostics: failure.diagnostics } : null),
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
