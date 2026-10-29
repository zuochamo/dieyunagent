'use strict';

/**
 * 目标型计划（plans trigger=goal）的判定与验收 —— **唯一来源**。
 *
 * 这里只做三件事，且**对技术栈零感知**（不知道对面是 Node / Rust / UE / 任何别的东西）：
 *   1. `runGoalVerify`：跑用户填的那一条命令，拿到退出码与证据尾巴；
 *   2. `decideContinuation`：纯函数，依据落盘证据决定「再来一轮 / 完成 / 停下写报告」；
 *   3. `buildGoalAuditReport`：停下来的统一措辞（预算耗尽 ≠ 完成）。
 *
 * 纪律：
 * - 命令只从结构化字段 `plan.goal.verify` 来，**不解析用户文本里的关键词**（AGENTS.md 第 3 条）。
 * - 不按工程类型 / 文件后缀 / 工程名分支；唯一的技术判断是「退出码是否为 0」。
 * - 数字上限一律来自 agent-limits（默认值 + schema clamp），此文件不另存常量。
 */

const { AGENT_LIMITS_DEFAULTS, SCHEMA_BY_KEY } = require('../agent/agent-limits');

/** 验收命令的最大长度：防止把整段脚本塞进 plans.json 与注入文本 */
const GOAL_VERIFY_MAX_CHARS = 2000;

/** 停止原因 → 一句人话（审计报告第一段） */
const STOP_LABELS = {
  done: '验收通过',
  attempts: '轮次预算用完',
  budget: '时长预算用完',
  blocked: '需要人工确认，无人可批',
  'no-verify': '没有可用的验收命令',
  'baseline-green': '验收命令在未动工时就已经通过（尺子无效）'
};

function schemaMax(key) {
  const item = SCHEMA_BY_KEY && SCHEMA_BY_KEY[key];
  const max = item && Number(item.max);
  return Number.isFinite(max) && max > 0 ? max : Number(AGENT_LIMITS_DEFAULTS[key]);
}

function limitValue(key, limits) {
  const raw = limits && Number(limits[key]);
  if (Number.isFinite(raw) && raw > 0) return raw;
  return Number(AGENT_LIMITS_DEFAULTS[key]);
}

/**
 * 用户填的预算 + 默认值 + 上限，收敛成一个可用的区间。
 * 表单里填 0 / 空 / 超上限都被收敛，调用方不需要自己判断。
 */
function resolveGoalBudget(plan, limits) {
  const b = (plan && plan.budget) || {};
  const attempts = Number(b.maxAttempts);
  const wall = Number(b.maxWallMs);
  return {
    maxAttempts:
      Number.isFinite(attempts) && attempts > 0
        ? Math.min(Math.floor(attempts), schemaMax('goalMaxAttempts'))
        : limitValue('goalMaxAttempts', limits),
    maxWallMs:
      Number.isFinite(wall) && wall > 0
        ? Math.min(Math.floor(wall), schemaMax('goalMaxWallMs'))
        : limitValue('goalMaxWallMs', limits)
  };
}

/** 验收命令：只取结构化字段，trim 后截断；空 = 没有尺子 */
function goalVerifyCommand(plan) {
  const raw = plan && plan.goal && plan.goal.verify;
  return String(raw || '')
    .trim()
    .slice(0, GOAL_VERIFY_MAX_CHARS);
}

/** 证据尾巴：stdout 优先，其次 stderr，按字符上限裁剪（上限 = `agent-limits.goalVerifyTailChars`） */
function tailEvidence(stdout, stderr, maxChars) {
  const out = String(stdout || '').trim();
  const err = String(stderr || '').trim();
  const text = out && err ? `${out}\n--- stderr ---\n${err}` : out || err;
  const limit = Number.isFinite(maxChars) && maxChars > 0 ? maxChars : limitValue('goalVerifyTailChars');
  return text.length > limit ? text.slice(-limit) : text;
}

/**
 * 跑一次验收命令。
 *
 * 走 `host.exec` 唯一入口（沙箱三档 / 审批 / 进程句柄表全部复用），不另写 shell 执行器。
 *
 * @param {{ gateway: object, plan: object, limits?: object, cwd?: string, sessionId?: string, runId?: string, log?: (m: string) => void }} opts
 * @returns {Promise<{ ok: boolean, exitCode: number|null, at: string, tail: string, note: string }>}
 */
async function runGoalVerify(opts = {}) {
  const { gateway, plan } = opts;
  const limits = opts.limits || AGENT_LIMITS_DEFAULTS;
  const at = new Date().toISOString();
  const command = goalVerifyCommand(plan);
  const tailChars = limitValue('goalVerifyTailChars', limits);

  if (!command) return { ok: false, exitCode: null, at, tail: '', note: 'no-verify' };
  if (!gateway || typeof gateway.invokeRpc !== 'function') {
    return { ok: false, exitCode: null, at, tail: 'Gateway 未就绪', note: 'no-gateway' };
  }

  // 超时必须 ≤ host.exec 的硬上限（600s），否则合法构建会被截断后误判为失败
  const timeoutMs = Math.min(
    Math.floor(limitValue('goalVerifyTimeoutMs', limits)),
    schemaMax('goalVerifyTimeoutMs')
  );

  try {
    const r = await gateway.invokeRpc('host.exec', {
      command,
      cwd: opts.cwd || undefined,
      timeoutMs,
      sessionId: opts.sessionId || undefined,
      runId: opts.runId || undefined
    });
    const code = r && typeof r.code === 'number' ? r.code : null;
    const timedOut = !!(r && r.timedOut);
    // 超时时 host.exec 会把命令转后台继续跑：这里顺手收掉，
    // 否则一晚上的构建进程会攒在句柄表里，下一轮抢占同一批中间产物。
    if (timedOut && r && r.stillRunning && r.handle) {
      try {
        await gateway.invokeRpc('host.proc_kill', {
          id: r.handle,
          sessionId: opts.sessionId || undefined
        });
      } catch (e) {
        if (opts.log) opts.log(`验收命令超时后结束进程失败: ${(e && e.message) || String(e)}`);
      }
    }
    const tail = tailEvidence(r && r.stdout, r && r.stderr, tailChars);
    if (timedOut) return { ok: false, exitCode: code, at, tail, note: 'timeout' };
    return {
      ok: code === 0,
      exitCode: code,
      at,
      tail,
      note: code === 0 ? 'pass' : 'fail'
    };
  } catch (e) {
    const code = String((e && e.code) || '');
    // 沙箱四种「没被执行」+ shell 未授权：无人值守时都等于「阻塞」，不是「失败重试」
    const blocked =
      /^SANDBOX_/.test(code) || code === 'APPROVAL_TIMEOUT' || code === 'SHELL_DISABLED';
    // 不带 keepOnTimeout 时，超时是以 SHELL_TIMEOUT 抛出来的（host-control 的约定）
    const timedOut = code === 'SHELL_TIMEOUT' || !!(e && e.timedOut === true);
    return {
      ok: false,
      exitCode: null,
      at,
      tail: tailEvidence('', (e && e.message) || String(e), tailChars),
      note: blocked ? 'blocked-approval' : timedOut ? 'timeout' : 'error'
    };
  }
}

/**
 * 续跑判定（纯函数，可单测）。
 *
 * 顺序即优先级：完成 > 阻塞 > 轮次 > 墙钟 > 退避续跑。
 * 「预算用完」永远返回 stop（未完成），绝不会返回 done。
 *
 * @param {{ plan: object, verify: object, limits?: object, now?: number }} input
 * @returns {{ cont: boolean, stop: string|null, delayMs?: number, budget: object }}
 */
function decideContinuation(input = {}) {
  const { plan, verify } = input;
  const limits = input.limits || AGENT_LIMITS_DEFAULTS;
  const now = Number.isFinite(input.now) ? input.now : Date.now();
  const budget = resolveGoalBudget(plan, limits);
  const attempt = Math.max(0, Math.floor(Number(plan && plan.attempt) || 0));

  if (verify && verify.ok) return { cont: false, stop: 'done', budget };
  if (verify && verify.note === 'blocked-approval') return { cont: false, stop: 'blocked', budget };
  if (verify && verify.note === 'no-verify') return { cont: false, stop: 'no-verify', budget };
  if (attempt >= budget.maxAttempts) return { cont: false, stop: 'attempts', budget };

  const startedAt = plan && plan.attemptStartedAt ? Date.parse(plan.attemptStartedAt) : NaN;
  if (Number.isFinite(startedAt) && now - startedAt >= budget.maxWallMs) {
    return { cont: false, stop: 'budget', budget };
  }

  const base = limitValue('goalRetryBackoffMs', limits);
  const cap = limitValue('goalRetryBackoffMaxMs', limits);
  // 第 1 轮失败后等 base，第二轮回 base*2 ……封顶 cap
  const exp = Math.max(0, attempt - 1);
  const delayMs = Math.min(cap, Math.round(base * Math.pow(2, exp)));
  return { cont: true, stop: null, delayMs, budget };
}

/**
 * 收尾措辞（唯一来源）：停下来时给用户看的「未完成报告」。
 * 刻意不出现「已完成」字样 —— 预算耗尽不是完成（对齐 Codex /goal 的语义）。
 */
function buildGoalAuditReport(input = {}) {
  const { plan, verify, stop, budget } = input;
  const b = budget || resolveGoalBudget(plan);
  const attempt = Math.max(0, Math.floor(Number(plan && plan.attempt) || 0));
  const label = STOP_LABELS[stop] || '已停止';
  const lines = [
    `【目标未完成】${label}`,
    `· 轮次：${attempt}/${b.maxAttempts}`,
    `· 时长预算：${Math.round(b.maxWallMs / 60000)} 分钟` +
      (plan && plan.attemptStartedAt ? `（起于 ${plan.attemptStartedAt}）` : '')
  ];
  if (verify) {
    lines.push(`· 最后验收：${verify.note}${verify.exitCode == null ? '' : `（exit ${verify.exitCode}）`}`);
    if (verify.tail) lines.push('', '```', verify.tail, '```');
  }
  if (stop === 'blocked') {
    lines.push('', '需要你本人确认那条命令（夜间无人可批），确认后重新启用该目标即可从下一轮继续。');
  } else if (stop === 'no-verify') {
    lines.push('', '这个目标没有填验收命令，无法判断做没做完。填一条「会失败」的检查再启用。');
  } else if (stop === 'budget' || stop === 'attempts') {
    lines.push('', '预算已用完。需要继续请提高轮次/时长上限后重新启用；不继续也不影响已落盘的改动。');
  }
  return lines.join('\n');
}

module.exports = {
  GOAL_VERIFY_MAX_CHARS,
  STOP_LABELS,
  resolveGoalBudget,
  goalVerifyCommand,
  tailEvidence,
  runGoalVerify,
  decideContinuation,
  buildGoalAuditReport
};
