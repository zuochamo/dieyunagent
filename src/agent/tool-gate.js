// 类型债（暂缓）：本文件还有未修完的类型错，因此**没**列进 tsconfig.check.json。把 @ts-check 留在第 1 行会让人以为它在被检查 —— 宁可明说没开；清单见 docs/RUST-CORE-REFACTOR-PLAN.md「类型债」一节。
'use strict';

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
 *   `tool-telemetry` / `tool-output-spill`）。出站净化（`sanitizeToolResultForApi`）不在本文件，
 *   它由调用方作为 after 关卡传入（`tool-bridge-main.js:1944` 的 `sanitize-result`），
 *   顺序必须晚于 `record-browser-screenshot` —— 否则 base64 先被剥掉，图永远进不了视觉通道。
 * - **不做全局可变注册表**：关卡清单是模块级冻结数组 + 每次调用的 `extraAfterHooks`，
 *   所以测试可以并行、也不存在"谁先 require 谁先跑"的顺序耦合。
 * - **不吞错误**：抛错由调用方归一成信封后**才**进 after 关卡，观察者只需处理一种形状。
 */

const path = require('path');
const {
  normalizeAgentToolName,
  PERMISSION_GATED_TOOLS,
  permissionGateBlockMessage,
  ALIVE_SENSE_TOOLS,
  ALIVE_WAKE_WRITE_TOOL_NAMES,
  isAliveWakeToolAllowed,
  isAliveYieldTool
} = require('./guardrails-shared');
const {
  decideFsWrite,
  decideShellCommand,
  // 「在根下吗」只有这一份实现（与沙箱判定同源，含 Windows 大小写归一）
  isUnder
} = require('../gateway/sandbox-policy');
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
    userDataPath: ctx.userDataPath || '',
    /** 只读作用域（后台心跳轮）：决定「改动类工具能不能用」，不改变其它判定 */
    readOnly: ctx.readOnly === true,
    /** 感官开关（`senses.eyes` 等）：只读作用域里还要逐项授权（摄像头 = 看现实） */
    senses: ctx.senses && typeof ctx.senses === 'object' ? ctx.senses : null,
    /**
     * 心跳轮的权力档（`read`/`write`/`exec`）：null = 不是心跳轮（普通对话照旧）。
     * 这是「能不能改/能不能跑」的唯一判定输入，见 `hookWakePowerScope`。
     */
    wakePower: ctx.wakePower ? String(ctx.wakePower) : '',
    /** 心跳轮允许动的根目录（空 = 取 workspacePath）；越界写/执行一律拒 */
    wakeRoot: ctx.wakeRoot ? String(ctx.wakeRoot) : '',
    /** 这一轮的写/执行预算（跨调用累计，由关卡自增；`agent-limits.aliveWake*MaxPerWake` 定上限） */
    wakeBudget: ctx.wakeBudget && typeof ctx.wakeBudget === 'object' ? ctx.wakeBudget : null
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

/**
 * 只读作用域：后台心跳轮（`src/alive`）**只能调用白名单里的工具**。
 *
 * 为什么是一个**关卡**而不是在调用点拿 if 判：能不能用某个工具是「这次调用能不能发生」
 * 的问题，归口就在 tool-gate；调用点（`main-turn-runner`）只声明自己处在什么作用域。
 *
 * 为什么用白名单（`ALIVE_READ_ONLY_TOOL_NAMES`）而不是拦掉写类工具：黑名单漏得太狠 ——
 * `web_fetch`（出网）、`peer_send`（跨机派活）、`memory_forget`（不可逆删记忆）、
 * `subagent`（子 loop 不继承 readOnly）、`plan_run`、`goal_check`（内部执行命令）
 * 都不是 `isWriteTool` 眼里的"写"，但全都有真实副作用。清单外一律拒绝。
 */
const hookReadOnlyScope = {
  id: 'read-only-scope',
  stage: 'before',
  run(call) {
    const ctx = callContext(call);
    const power = ctx.wakePower;
    if (!ctx.readOnly && !power) return;
    /**
     * 心跳轮的三档权力（`read` 默认 / `write` / `exec`）。
     *
     * 老调用方只给了 `readOnly` 布尔（没有 `wakePower`）→ 按 `read` 处理，行为与以前完全一致。
     * 放开档不是"少拦一点"，而是**换成另一套更窄的许可**：清单内的工具 + 只能动一个根 +
     * 每轮次数上限 + 需要人当场同意的操作直接拒（后台不排队等审批）。
     */
    const effective = power || 'read';
    if (!isAliveWakeToolAllowed(effective, call.name)) {
      recordTelemetry(call, false, 'READ_ONLY_SCOPE', 0);
      call.block = wrapStructuredError({
        retryable: false,
        errorCode: 'READ_ONLY_SCOPE',
        error:
          `工具 ${call.name} 没有执行：这一轮是后台心跳唤起的（当前权力：${effective}）。` +
          (effective === 'read'
            ? '只读轮只允许读文件 / 找东西 / 读记忆。写盘、执行命令、出网、跨机发消息、起子任务、跑计划都属于清单外，重试也不会成功。'
            : `「${effective}」档也没有这个工具：改文件只放开 fs_write_file / fs_edit，跑命令只放开 host_exec，出网只放开 web_search / web_fetch，占屏/键鼠只放开 browser_* 与 computer（且要没人正在跑任务）。跨机发消息、起子任务、跑计划一律不放。`) +
          '需要动手时等用户在场的一轮再做，或者把那件事记进未闭合事项（alive_decide.loops）。'
      });
      return;
    }
    // 感官类（摄像头）即便在白名单里，也要对应的开关打开 —— 默认全关
    const sense = ALIVE_SENSE_TOOLS[call.name];
    if (sense && !(ctx.senses && ctx.senses[sense] === true)) {
      recordTelemetry(call, false, 'SENSE_DISABLED', 0);
      call.block = wrapStructuredError({
        retryable: false,
        errorCode: 'SENSE_DISABLED',
        error:
          `工具 ${call.name} 没有执行：这个感官是关着的（${sense}）。` +
          '这不是故障，重试也不会成功——要看得等用户在「设置 → 拟态 → 生命」里打开。'
      });
      return;
    }
    /**
     * **避让**：会占屏 / 抢键鼠的工具（`browser_*` / `computer`），只要还有**别的** agent 轮在跑就不动。
     *
     * 判据是 `getActiveAgentLoopCount()`（`rust-loop-runner` 里「系统忙不忙」的唯一来源）：
     * 这一轮自己算一条，`> 1` 就是别人在跑（用户在对话、计划在跑、频道任务、另一个远端会话）。
     * 为什么不是"等它做完再试"：后台轮没有排队语义，等 = 挂住整轮；所以直接拒，让它下一轮再决定。
     * 懒 require：`rust-loop-runner` 会反过来用到本模块与关卡，加载期引入会固化顺序。
     */
    if (isAliveYieldTool(call.name)) {
      let busy = 0;
      try {
        const { getActiveAgentLoopCount } = require('./rust-loop-runner');
        busy = Number(getActiveAgentLoopCount()) || 0;
      } catch {
        busy = 0;
      }
      if (busy > 1) {
        recordTelemetry(call, false, 'WAKE_YIELD', 0);
        call.block = wrapStructuredError({
          retryable: false,
          errorCode: 'WAKE_YIELD',
          error:
            `工具 ${call.name} 没有执行：这台机器上还有别的任务在跑（${busy} 个轮次），` +
            '现在动浏览器或键鼠会跟它抢同一块屏幕、同一套鼠标键盘。' +
            '不是你做错了，也不是故障 —— 等那件事做完，下一轮醒来再试；着急就把这件事记进未闭合事项。'
        });
        return;
      }
    }
    if (effective === 'read') return;
    // —— 以下是放开档的三道闸门 ——
    const budget = ctx.wakeBudget;
    const blockWith = (errorCode, error) => {
      recordTelemetry(call, false, errorCode, 0);
      call.block = wrapStructuredError({ retryable: false, errorCode, error });
    };
    /**
     * 可写/可执行的根：**只认显式声明**（`ctx.wakeRoot`，缺省用会话工作空间）。
     *
     * 空 = 这一轮没有可动的根 → **直接拒**（fail-closed）。绝不回退到 `process.cwd()`：
     * 那等于把「应用安装目录」当成可写根，闸门会静默放宽到一个谁也没选过的地方。
     */
    const rootRaw = String(ctx.wakeRoot || ctx.workspacePath || '').trim();
    if (!rootRaw) {
      blockWith(
        'WAKE_NO_ROOT',
        `${call.name} 没有执行：这一轮没有声明可动的根目录（wakeRoot / 工作空间都为空）。` +
          '后台轮不会替你猜一个目录 —— 需要动手时等用户在场的一轮，或先把工作空间绑好。'
      );
      return;
    }
    const root = path.resolve(rootRaw);
    if (ALIVE_WAKE_WRITE_TOOL_NAMES.has(call.name)) {
      const target = path.resolve(root, String((call.args && call.args.filePath) || ''));
      // 根内判定用 `sandbox-policy.isUnder`（唯一实现）：自己写 `rel.startsWith('..')` 会把
      // 根内合法文件名 `..eslintrc` / `..cache` 判成越界，也不处理 Windows 大小写。
      // `target === root` 仍然拒：那是「往目录本身写」，下游必然失败。
      if (target === root || !isUnder(target, root, process.platform === 'win32')) {
        blockWith(
          'WAKE_PATH_OUTSIDE',
          `${call.name} 没有执行：这一轮它只被允许在「${root}」里动文件，目标是「${(call.args && call.args.filePath) || '(空)'}」。` +
            '越界不是故障，重试也不会成功——要改别处请让用户在对话里那一轮做。'
        );
        return;
      }
      // 沙箱策略仍然是最初的判定者：需要人同意的（工作区外/档位不允许）在后台直接拒
      const decision = decideFsWrite(target, { mode: 'workspace-write', workspaceRoots: [root] });
      if (decision.action === 'deny') {
        blockWith('WAKE_POLICY_DENIED', `${call.name} 没有执行：${decision.reason}`);
        return;
      }
      if (decision.action === 'ask') {
        blockWith(
          'WAKE_NEEDS_APPROVAL',
          `${call.name} 没有执行：这一步需要用户当场同意（${decision.reason}）。后台不排队等审批，重试也不会成功。`
        );
        return;
      }
      if (budget && Number(budget.writes) >= Number(budget.maxWrites)) {
        blockWith(
          'WAKE_BUDGET',
          `这一轮的改文件次数用完了（上限 ${budget.maxWrites} 次）。剩下的留到下次醒来，或者先收口再继续。`
        );
        return;
      }
      if (budget) budget.writes = Number(budget.writes) + 1;
      return;
    }
    if (call.name === 'host_exec') {
      const command = String((call.args && call.args.command) || '');
      // 后台轮不启动「脱离进程」：没人收尾、没人看输出，等于偷偷留一个常驻任务
      if (call.args && call.args.detached === true) {
        blockWith(
          'WAKE_POLICY_DENIED',
          'host_exec 没有执行：心跳轮不允许 detached=true（会在你不在时留下一个没人收尾的常驻进程）。'
        );
        return;
      }
      const cwdRaw = String((call.args && call.args.cwd) || '').trim();
      const cwd = cwdRaw ? path.resolve(root, cwdRaw) : root;
      if (!isUnder(cwd, root, process.platform === 'win32')) {
        blockWith('WAKE_PATH_OUTSIDE', `host_exec 没有执行：cwd 必须在「${root}」之下。`);
        return;
      }
      const decision = decideShellCommand(command, { mode: 'workspace-write', workspaceRoots: [root], cwd });
      if (decision.action === 'deny') {
        blockWith('WAKE_POLICY_DENIED', `host_exec 没有执行：${decision.reason}`);
        return;
      }
      if (decision.action === 'ask') {
        blockWith(
          'WAKE_NEEDS_APPROVAL',
          `host_exec 没有执行：这条命令需要用户当场同意（${decision.reason}）。后台不排队等审批，重试也不会成功。`
        );
        return;
      }
      if (budget && Number(budget.execs) >= Number(budget.maxExecs)) {
        blockWith(
          'WAKE_BUDGET',
          `这一轮的命令次数用完了（上限 ${budget.maxExecs} 条）。剩下的留到下次醒来。`
        );
        return;
      }
      // 命令超时按这一档的上限夹住（`aliveWakeExecTimeoutSec`）：它自己写 10 分钟也不行
      if (budget && Number(budget.timeoutMs) > 0 && call.args && typeof call.args === 'object') {
        const want = Number(call.args.timeoutMs);
        if (!Number.isFinite(want) || want <= 0 || want > Number(budget.timeoutMs)) {
          call.args.timeoutMs = Number(budget.timeoutMs);
        }
      }
      if (budget) budget.execs = Number(budget.execs) + 1;
    }
  }
};

const hookRepeatGuard = {  id: 'repeat-guard',
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
  hookReadOnlyScope,
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
