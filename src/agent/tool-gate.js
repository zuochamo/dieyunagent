'use strict';

// @ts-check
/**
 * 工具关卡（tool gate）：**一次工具调用的唯一流程 + 唯一关卡清单**。
 *
 * 为什么要有它：判定逻辑（参数校验 / 重复调用止损 / 遥测 / 大输出落盘 / 出站净化 /
 * 写入气味提示）此前散在 `ToolHarnessSession.execute` 和 `tool-bridge-main.executeAgentTool`
 * 两处，执行顺序只能靠通读代码才知道，加一条检查就得改流程本身。现在：
 *
 * ```
 * 归一（只做一次）  normalizeToolCall
 *   → before 关卡（顺序 = DEFAULT_TOOL_GATE_HOOKS 里 before 的声明顺序）
 *       可 return/置 call.block 短路：一旦有结论就不再调用工具
 *   → 调用（重试/退避不属于关卡，留在调用方）
 *   → after 关卡（顺序 = 声明顺序；外层通过 extraAfterHooks 追加自己的关卡）
 *       可改写 call.result（落盘、净化、提示）
 * ```
 *
 * 约束（刻意不做的事）：
 * - **不新增判定逻辑**：每个关卡都是既有单一来源的调用点（`tool-validate` / `tool-guardrails` /
 *   `tool-telemetry` / `tool-output-spill` / `guardrails-shared` 的 `sanitizeToolResultForApi`）。
 * - **不做全局可变注册表**：关卡清单是模块级冻结数组 + 每次调用的 `extraAfterHooks`，
 *   所以测试可以并行、也不存在"谁先 require 谁先跑"的顺序耦合。
 * - **不吞错误**：抛错由调用方归一成信封后**才**进 after 关卡，观察者只需处理一种形状。
 */

const { normalizeAgentToolName, PERMISSION_GATED_TOOLS, permissionGateBlockMessage } = require('./guardrails-shared');
const {
  shouldBlockRepeatToolCall,
  recordToolCallFingerprint,
  repeatToolBlockMessage
} = require('./tool-guardrails');
const { validateToolArgs } = require('./tool-validate');
const { spillToolOutputIfLarge } = require('./tool-output-spill');
const { recordToolTelemetry } = require('./tool-telemetry');

/** 关卡阶段。`before` 决定"还能不能调用"，`after` 决定"结果长什么样"。 */
const TOOL_GATE_STAGES = Object.freeze(['before', 'after']);

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

/**
 * 归一一次，之后整条链路只认 `call.name` / `call.args`。
 *
 * 之前 `executeAgentTool` 拿到的是**原始** name/args，内部 harness 归一过一次，
 * 外层为了给 write-smell 判定又归一了第二次（`tool-bridge-main.js` 里的手写注释就是这事）。
 * 归一本身幂等，但"归一发生在哪"决定了别名工具（write_file / edit / str_replace_editor …）
 * 会不会在某一层被跳过判定 —— 所以只留一个入口。
 *
 * @param {{ name: string, args?: object, session?: object, harness?: object, permissions?: object,
 *           extraAfterHooks?: Array<object> }} desc
 *   `permissions` 是调用方手上已有的权限快照（Main 的 `gateway.getPermissions()`）；
 *   给不出就看关卡自己按 userDataPath 读同一份 store，两条路读的是**同一个文件**。
 */
function createToolCall(desc) {
  const d = desc || {};
  const rawName = String(d.name || '');
  const rawArgs = d.args && typeof d.args === 'object' ? d.args : {};
  const norm = normalizeAgentToolName(rawName, rawArgs);
  return {
    /** 标记：让调用方可以把 `call` 直接当"已归一的工具调用"传下去 */
    __toolCall: true,
    /** 模型原样给的名字（排查别名问题用；判定一律用 name） */
    rawName,
    name: norm.name,
    args: norm.args,
    /** ToolHarnessSession 实例：关卡通过它拿会话 ctx / 指纹表 / 落盘序号 */
    harness: d.harness || null,
    /** 调用方已有的权限快照（缺省时关卡读 host-permissions.json，同一份 store） */
    permissions: d.permissions && typeof d.permissions === 'object' ? d.permissions : null,
    /** 外层追加的 after 关卡（sanitize / 写味提示 / 视觉吸收…） */
    extraAfterHooks: Array.isArray(d.extraAfterHooks) ? d.extraAfterHooks.slice() : [],
    startedAt: Date.now(),
    attempt: 0,
    /** 归一后的失败契约（`tool-harness.classifyFailure` 的产物），null = 成功 */
    failure: null,
    /** 当前结果（after 关卡可改写） */
    result: null,
    /** before 关卡给出结论时置位 = 短路 */
    block: null
  };
}

/** 是不是 `createToolCall` 造的调用对象（用来区分「已归一」与「原始 name+args」两种入参）。 */
function isToolCall(value) {
  return !!(value && typeof value === 'object' && value.__toolCall === true);
}

/** 关卡可用的会话事实（统一形状，避免每个 hook 自己掏参数）。 */
function callContext(call) {
  const ctx = (call.harness && call.harness.ctx) || {};
  return {
    runId: ctx.runId || '',
    sessionId: ctx.sessionId || '',
    model: ctx.model || '',
    contextTierId: ctx.contextTierId || 'default',
    workspacePath: ctx.workspacePath || '',
    userDataPath: ctx.userDataPath || ''
  };
}

function recordTelemetry(call, ok, errorCode, durationMs) {
  const c = callContext(call);
  recordToolTelemetry(c.userDataPath, {
    tool: call.name,
    ok,
    errorCode,
    model: c.model,
    sessionId: c.sessionId,
    durationMs,
    attempt: call.attempt
  });
}

const hookValidateArgs = {
  id: 'validate-args',
  stage: 'before',
  run(call) {
    const v = validateToolArgs(call.name, call.args);
    if (v.ok) return;
    recordTelemetry(call, false, v.errorCode, 0);
    call.block = wrapStructuredError(
      { retryable: false, errorCode: v.errorCode, error: v.error },
      { suggestedFix: v.suggestedFix }
    );
  }
};

/**
 * 能力授权：`camera_look` 这类「碰得到现实世界」的工具，执行前必须确认用户此刻是开着的。
 *
 * 权限快照的来路：优先用调用方给的 `call.permissions`（Main 手里就有 gateway 的
 * `getPermissions()`）；没给就按 ctx 的 userDataPath 读一次 `host-permissions.json`
 * （`ToolHarnessSession` 那条路径就是这种情况）。两处都读**同一份** store，
 * 这里不做第二套判定规则，只做「键名 → 工具名」的映射（`PERMISSION_GATED_TOOLS`）。
 *
 * 放在 repeat-guard 之前：没授权的调用不该占用重复调用的计数。
 */
const hookToolPermission = {
  id: 'tool-permission',
  stage: 'before',
  run(call) {
    const key = PERMISSION_GATED_TOOLS[call.name];
    if (!key) return;
    const perms = permissionSnapshot(call);
    if (!perms) return; // 拿不到权限快照时不假装拦截：执行层另有失败兜底
    if (perms[key] === true) return;
    recordTelemetry(call, false, 'PERMISSION_DENIED', 0);
    call.block = wrapStructuredError({
      retryable: false,
      errorCode: 'PERMISSION_DENIED',
      error: permissionGateBlockMessage(call.name, key)
    });
  }
};

/**
 * 权限快照（`permissions-store` 的形状）。读不到返回 null。
 *
 * 为什么懒 require：`permissions-store` 在 gateway 层，模块顶层引入会把
 * 「agent → gateway」的加载顺序固化下来；这里只在真需要时才取一次。
 */
function permissionSnapshot(call) {
  if (call && call.permissions && typeof call.permissions === 'object') return call.permissions;
  const userDataPath = callContext(call).userDataPath;
  if (!userDataPath) return null;
  try {
    const path = require('node:path');
    const { loadPermissions } = require('../gateway/permissions-store');
    return loadPermissions(path.join(userDataPath, 'host-permissions.json'));
  } catch {
    return null;
  }
}

const hookRepeatGuard = {
  id: 'repeat-guard',
  stage: 'before',
  run(call) {
    const c = callContext(call);
    const hist = (call.harness && call.harness.fingerprints) || [];
    if (
      shouldBlockRepeatToolCall(
        call.name,
        call.args,
        hist,
        undefined,
        c.userDataPath,
        c.contextTierId,
        c.model
      )
    ) {
      const msg = repeatToolBlockMessage(
        call.name,
        formatArgsBrief(call.name, call.args),
        c.userDataPath,
        c.contextTierId,
        c.model
      );
      recordTelemetry(call, false, 'REPEAT_BLOCK', 0);
      call.block = wrapStructuredError(
        { retryable: false, errorCode: 'REPEAT_BLOCK', error: msg },
        { repeated: true }
      );
      return;
    }
    // 只有真的放行才计指纹：被拦下的调用不该再撑大连续计数。
    if (call.harness) {
      recordToolCallFingerprint(hist, call.name, call.args, c.userDataPath, c.contextTierId, c.model);
    }
  }
};

const hookTelemetry = {
  id: 'telemetry',
  stage: 'after',
  run(call) {
    const durationMs = Math.max(0, Date.now() - Number(call.startedAt || Date.now()));
    if (call.failure) recordTelemetry(call, false, call.failure.errorCode, durationMs);
    else recordTelemetry(call, true, 'ok', durationMs);
  }
};

const hookSpillOutput = {
  id: 'spill-output',
  stage: 'after',
  run(call) {
    if (call.failure) return; // 失败信封不落盘：模型需要看到错误本身
    if (!call.harness) return;
    call.harness.spillSeq += 1;
    const out = spillToolOutputIfLarge(call.name, call.result, {
      runId: call.harness.runKey,
      sessionId: callContext(call).sessionId,
      workspacePath: call.harness.ctx.workspacePath,
      userDataPath: call.harness.ctx.userDataPath,
      spillSeq: call.harness.spillSeq
    });
    if (out !== undefined) call.result = out;
  }
};

/**
 * 默认关卡清单：**顺序即语义**。
 * 想加一条检查 → 在这个数组里按正确位置插入，不要改 `runToolGateStage` 的流程。
 */
const DEFAULT_TOOL_GATE_HOOKS = Object.freeze([
  hookValidateArgs,
  hookToolPermission,
  hookRepeatGuard,
  hookTelemetry,
  hookSpillOutput
]);

/** 取某阶段的关卡（默认清单 + 每次调用的追加项）。 */
function hooksForStage(stage, call, hooks) {
  const base = Array.isArray(hooks) ? hooks : DEFAULT_TOOL_GATE_HOOKS;
  const extra = stage === 'after' && call && Array.isArray(call.extraAfterHooks) ? call.extraAfterHooks : [];
  return [...base, ...extra].filter((h) => h && h.stage === stage);
}

/**
 * 跑一个阶段。`before` 阶段遇到 `call.block` 立即返回该结论（短路语义在这里定义，
 * 而不是散落在每个调用点）。`after` 阶段总是全部跑完（观察类关卡不该互相短路）。
 *
 * @returns {Promise<object|null>} before 阶段：block 结果或 null；after 阶段恒为 null
 */
async function runToolGateStage(stage, call, hooks) {
  if (!call) throw new Error('runToolGateStage: call required');
  for (const hook of hooksForStage(stage, call, hooks)) {
    await hook.run(call);
    if (stage === 'before' && call.block) return call.block;
  }
  return null;
}

module.exports = {
  TOOL_GATE_STAGES,
  DEFAULT_TOOL_GATE_HOOKS,
  createToolCall,
  isToolCall,
  runToolGateStage,
  formatArgsBrief,
  wrapStructuredError,
  /**
   * 仅供 `tool-validate` / 关卡外的极限场景复用的只读视图；不要拿它当注册表用。
   */
  listHookIds: () => DEFAULT_TOOL_GATE_HOOKS.map((h) => `${h.stage}:${h.id}`)
};
