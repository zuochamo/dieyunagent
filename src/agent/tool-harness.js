'use strict';

// 工具执行的会话宿主：**流程与关卡都不在这里**。
// 关卡清单与顺序的唯一来源是 `tool-gate.js`（before：校验/重复止损；after：遥测/落盘）；
// 这里只负责三件不属于关卡的事：会话级状态（指纹表 / 落盘序号）、瞬时失败重试、失败分类。

const {
  createToolCall,
  isToolCall,
  runToolGateStage,
  formatArgsBrief,
  wrapStructuredError
} = require('./tool-gate');
const { getAgentLimits } = require('./agent-limits');
const { isLongRunningAgentTool } = require('./guardrails-shared');
const { sleepMs } = require('../llm-reconnect-retry');

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
    // 有声明用声明 —— 与抛错分支同一条规则。少了这一条，handler 里写清楚的
    // `MCP_UNAVAILABLE` / `GATEWAY_UNAVAILABLE` / `PLANS_UNAVAILABLE` / `CAMERA_UNAVAILABLE`
    // 会被下面的消息启发式压成 TOOL_ERROR/POLICY，模型就看不出「能力没开」和「调用出错」的区别。
    if (result.errorCode) {
      return { retryable: false, errorCode: String(result.errorCode), error: err, diagnostics };
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

/**
 * 单次工具执行的「无进展看门狗」。
 *
 * **为什么必须有**（2026-10-23→24 事故）：`host_exec` 起了一个前台长驻脚本，工具 promise
 * 永不 settle，harness 就永远 await 在这一句上 —— 结果是**没有下一轮 LLM 请求、没有新 trace、
 * 没有一行日志**，`agent_runs.status` 一直是 running。那天这条 run 静默卡了 11 小时，
 * 直到 UE 进程被杀、脚本自己退出才"复活"。
 *
 * `mutate-queue` 的 stall 看门狗只管**排队**（写类工具在等前一个），管不到「执行中」。
 * 两者语义保持一致：**只放弃等待，不终止原调用** —— 取消属 `delegate-batch` 的 abort 契约，
 * 在这里 kill 会把「超时」变成「误杀长任务」。原 promise 继续在后台跑，结果丢弃。
 *
 * 超时后按 `TOOL_STALLED`（retryable:false）回给模型，并提示改用 detached / 缩小命令范围；
 * 遥测的 `errorCode` 会记下它，统计页可查 —— 这是"它停了"唯一留下的痕迹。
 *
 * @template T
 * @param {Promise<T>} promise
 * @param {{ name?: string }} call
 * @param {number} stallMs 0/未配置 = 不启用
 * @returns {Promise<T>}
 */
function raceToolStall(promise, call, stallMs) {
  const ms = Number(stallMs) || 0;
  if (!(ms > 0)) return promise;
  // 原调用的后续 reject 必须被吃掉：race 已经不再持有它，否则会升级成
  // 进程级 unhandledRejection（Electron 主进程会弹错误框）。
  promise.catch(() => {});
  let timer = null;
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const minutes = Math.max(1, Math.round(ms / 60000));
      const name = (call && call.name) || '工具';
      const e = new Error(`${name} 超过 ${minutes} 分钟没有返回，已判定卡住（原调用仍在后台运行，未被终止）。`);
      e.code = 'TOOL_STALLED';
      e.retryable = false;
      e.stalled = true;
      e.suggestedFix =
        '不要原样重跑同一条调用。① 长驻/守护型脚本（打印 READY 后不退出）必须用 detached=true；' +
        '② 长任务给 waitMs 让它到点转后台，再用 host_proc action=output 续读；' +
        '③ 交互式命令（如 timeout /t、等待 stdin 的工具）在无控制台环境下会一直挂住，改用轮询式检查。';
      reject(e);
    }, ms);
    if (timer && typeof timer.unref === 'function') timer.unref();
  });
  return Promise.race([promise, guard]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/**
 * 选本次调用的看门狗窗口：长任务工具（`subagent`）用 `toolStallMsLong`，其余用 `toolStallMs`。
 * 工具清单来源 `guardrails-shared.js: LONG_RUNNING_TOOL_NAMES`（别在这里写第二份清单）。
 */
function resolveToolStallMs(name, limits) {
  const base = Number(limits && limits.toolStallMs) || 0;
  const long = Number(limits && limits.toolStallMsLong) || 0;
  return isLongRunningAgentTool(name) ? long || base : base;
}

class ToolHarnessSession {
  /**
   * @param {{ runId?: string, sessionId?: string, model?: string, workspacePath?: string, userDataPath?: string, contextTierId?: string }} ctx
   */
  constructor(ctx = {}) {
    this.ctx = ctx;
    /** 连续调用指纹表（repeat-guard 关卡的数据源） */
    this.fingerprints = [];
    /** 大输出落盘序号（spill-output 关卡的数据源） */
    this.spillSeq = 0;
    this.runKey = String(ctx.runId || ctx.sessionId || 'run');
  }

  /**
   * 执行一次工具调用。两种入参都支持：
   * - `execute(call, invokeFn)`：`call` 由 `tool-gate.createToolCall` 造好（推荐，全局只归一一次）
   * - `execute(name, args, invokeFn)`：兼容旧调用点（内部自己造 call）
   *
   * @param {object|string} callOrName
   * @param {Function|object} argsOrInvoke
   * @param {() => Promise<object>} [maybeInvokeFn]
   */
  async execute(callOrName, argsOrInvoke, maybeInvokeFn) {
    const call = isToolCall(callOrName)
      ? callOrName
      : createToolCall({ name: callOrName, args: argsOrInvoke });
    const invoke = typeof argsOrInvoke === 'function' ? argsOrInvoke : maybeInvokeFn;
    if (typeof invoke !== 'function') throw new Error('ToolHarnessSession.execute 需要 invoke 函数');
    call.harness = this;
    call.startedAt = call.startedAt || Date.now();

    const blocked = await runToolGateStage('before', call);
    if (blocked) return blocked;

    const lim = getAgentLimits(this.ctx.userDataPath, this.ctx.contextTierId || 'default');
    const stallMs = resolveToolStallMs(call.name, lim);
    const transientMaxRetries = lim.transientMaxRetries;
    const retryBaseMs = lim.retryBaseMs;
    let lastFailure = null;

    for (let attempt = 0; attempt <= transientMaxRetries; attempt++) {
      call.attempt = attempt;
      try {
        // 同步抛错也变成 reject：看门狗只认 promise，不能让它漏掉一层。
        const invocation = Promise.resolve().then(() => invoke(call.name, call.args));
        call.result = await raceToolStall(invocation, call, stallMs);
        call.failure = classifyFailure(call.name, call.result, null);
        if (call.failure && call.failure.retryable && attempt < transientMaxRetries) {
          lastFailure = call.failure;
          await sleepMs(retryBaseMs * (attempt + 1));
          continue;
        }
        // 成功 / 终态失败都走 after 关卡：观察类关卡只该看到一种"调用已结束"的形状。
        await runToolGateStage('after', call);
        return call.failure ? wrapStructuredError(call.failure, { attempts: attempt + 1 }) : call.result;
      } catch (e) {
        call.failure = classifyFailure(call.name, null, e);
        if (call.failure.retryable && attempt < transientMaxRetries) {
          lastFailure = call.failure;
          await sleepMs(retryBaseMs * (attempt + 1));
          continue;
        }
        await runToolGateStage('after', call);
        return wrapStructuredError(call.failure, { attempts: attempt + 1 });
      }
    }
    await runToolGateStage('after', call);
    return wrapStructuredError(
      lastFailure || call.failure || { retryable: false, errorCode: 'TOOL_ERROR', error: '工具失败' }
    );
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
  formatArgsBrief,
  // 单测直接钉住看门狗语义（不必为 12 分钟的默认值等真实时间）
  raceToolStall,
  resolveToolStallMs
};
