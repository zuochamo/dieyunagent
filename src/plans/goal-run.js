'use strict';

// @ts-check
/**
 * 目标型计划（plans trigger=goal）：**事实、核对、文字块的唯一来源**。
 *
 * 分工（v2，核心是「代码判事实，模型判意义」）：
 *   1. `runGoalCheck`        跑一条检查命令 → 落一条事实（退出码 / 超时 / 沙箱拒绝 + 输出尾巴）；
 *   2. `judgeGoalFinish`     模型申请收尾时，**只核对主张与事实是否一致**；
 *   3. `decideContinuation`  收尾了 / 预算用完 → 停，否则接下一轮（纯函数，可单测）；
 *   4. `renderEvidenceBlock` 把事实渲染成不可编辑的块；措辞与判断归模型。
 *
 * 这里刻意不做的事（减法优先）：
 *   - 不猜技术栈、不按文件后缀/工程名分支，唯一的机械契约是「退出码 0 = 通过」；
 *   - 不解析自然语言里的关键词（检查命令只从结构化字段 `plan.goal.checks` 来）；
 *   - 不分检查档位、不定「每轮必跑」节奏 —— 什么时候跑哪条，是模型的决定；
 *   - 不数「连续失败几轮才算阻塞」这类语义阈值；
 *   - 不生成「已完成 / 未完成」结论文案 —— 预算耗尽与新事实一样，只是事实。
 *
 * 数字上限一律来自 `agent-limits`（AGENTS.md §6），本文不另存常量。
 */

const { AGENT_LIMITS_DEFAULTS, SCHEMA_BY_KEY } = require('../agent/agent-limits');

/** 单条检查命令的最大长度：防止把整段脚本塞进 plans.json 与注入文本 */
const GOAL_CHECK_MAX_CHARS = 2000;

function schemaMax(key) {
  // SCHEMA_BY_KEY 是 Map（agent-limits 的唯一表格）；写成 obj[key] 会永远落回默认值，
  // 于是「表单填的数不能突破上限」这条约束会静默失效。
  const item = SCHEMA_BY_KEY && typeof SCHEMA_BY_KEY.get === 'function' ? SCHEMA_BY_KEY.get(key) : null;
  const max = item && Number(item.max);
  return Number.isFinite(max) && max > 0 ? max : Number(AGENT_LIMITS_DEFAULTS[key]);
}

function limitValue(key, limits) {
  const raw = limits && Number(limits[key]);
  if (Number.isFinite(raw) && raw > 0) return raw;
  return Number(AGENT_LIMITS_DEFAULTS[key]);
}

/**
 * 用户填的预算 + 默认值 + 上限，收敛成一个可用区间。
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

/** 声明的检查清单：只取结构化字段，空数组 = 未验证模式（能跑，但代码无法核对完成） */
function goalChecks(plan) {
  const g = (plan && plan.goal) || {};
  return Array.isArray(g.checks) ? g.checks.filter((c) => c && c.command) : [];
}

/** 没有声明任何检查 = 未验证模式 */
function isUnverified(plan) {
  return goalChecks(plan).length === 0;
}

/** 证据尾巴：stdout 优先，其次 stderr，按字符上限裁剪（上限 = agent-limits.goalEvidenceTailChars） */
function tailEvidence(stdout, stderr, maxChars) {
  const out = String(stdout || '').trim();
  const err = String(stderr || '').trim();
  const text = out && err ? `${out}\n--- stderr ---\n${err}` : out || err;
  const limit = Number.isFinite(maxChars) && maxChars > 0 ? maxChars : limitValue('goalEvidenceTailChars');
  return text.length > limit ? text.slice(-limit) : text;
}

/**
 * 跑一条检查命令，返回**一条事实**（不判完成、不决定后续）。
 *
 * 走 `host.exec` 唯一入口（沙箱三档 / 审批 / 进程句柄表全部复用），不另写 shell 执行器。
 *
 * @param {{ gateway: object, plan?: object, command?: string, checkId?: string, cwd?: string,
 *           limits?: object, sessionId?: string, runId?: string, round?: number, log?: (m: string) => void }} opts
 * @returns {Promise<{ at: string, round: number, checkId: string, command: string, ok: boolean,
 *                     exitCode: number|null, note: string, tail: string }>}
 */
async function runGoalCheck(opts = {}) {
  const { gateway } = opts;
  const limits = opts.limits || AGENT_LIMITS_DEFAULTS;
  const at = new Date().toISOString();
  const round = Math.max(0, Math.floor(Number(opts.round) || 0));
  const checkId = String(opts.checkId || '').trim();
  const command = String(opts.command || '')
    .trim()
    .slice(0, GOAL_CHECK_MAX_CHARS);
  const base = { at, round, checkId, command, ok: false, exitCode: null, note: 'missing', tail: '' };

  if (!command) return { ...base, note: 'missing' };
  if (!gateway || typeof gateway.invokeRpc !== 'function') {
    return { ...base, note: 'error', tail: 'Gateway 未就绪' };
  }

  // 超时必须 ≤ host.exec 的硬上限（600s），否则合法构建会被截断后误判为失败
  const timeoutMs = Math.min(
    Math.floor(limitValue('goalCheckTimeoutMs', limits)),
    schemaMax('goalCheckTimeoutMs')
  );
  const tailChars = limitValue('goalEvidenceTailChars', limits);

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
        if (opts.log) opts.log(`检查命令超时后结束进程失败: ${(e && e.message) || String(e)}`);
      }
    }
    const tail = tailEvidence(r && r.stdout, r && r.stderr, tailChars);
    if (timedOut) return { ...base, exitCode: code, note: 'timeout', tail };
    return {
      ...base,
      ok: code === 0,
      exitCode: code,
      note: code === 0 ? 'pass' : 'fail',
      tail
    };
  } catch (e) {
    const code = String((e && e.code) || '');
    // 沙箱/审批拒绝 = 「这条命令没被执行」，是一种事实，不是失败也不是策略
    const blocked = /^SANDBOX_/.test(code) || code === 'APPROVAL_TIMEOUT' || code === 'SHELL_DISABLED';
    const timedOut = code === 'SHELL_TIMEOUT' || !!(e && e.timedOut === true);
    return {
      ...base,
      exitCode: null,
      note: blocked ? 'blocked' : timedOut ? 'timeout' : 'error',
      tail: tailEvidence('', (e && e.message) || String(e), tailChars)
    };
  }
}

/**
 * 取某条声明检查的**最新**事实。
 *
 * 匹配顺序：checkId 相等 → 同一条命令。都不匹配 = 这条检查还没有事实。
 *
 * @param {object[]} evidence
 * @param {{ id?: string, command: string }} check
 */
function latestFactFor(evidence, check) {
  const list = Array.isArray(evidence) ? evidence : [];
  const id = String((check && check.id) || '').trim();
  const command = String((check && check.command) || '').trim();
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const f = list[i];
    if (!f) continue;
    if (id && f.checkId === id) return f;
    if (command && f.command === command) return f;
  }
  return null;
}

/**
 * 核对模型提出的收尾主张与已落盘事实是否一致 —— **只判客观事实**。
 *
 * - `complete`：最近一条检查事实必须通过；声明了检查时，每条声明检查的最新事实也必须通过；
 *   一条事实都没有时，只有「没声明检查」的未验证模式才接受（并标注 `unverified`）。
 * - `blocked`：接受（停下），事实与理由留痕，由人复盘。
 *
 * 注意这里**不判断**「检查够不够证明目标达成」——那是语义判断，归模型与人。
 *
 * @param {{ plan: object, outcome?: string }} input
 * @returns {{ accept: boolean, outcome: string, facts: object, reason: string }}
 */
function judgeGoalFinish(input = {}) {
  const { plan } = input;
  const outcome = input.outcome === 'blocked' ? 'blocked' : 'complete';
  const checks = goalChecks(plan);
  const evidence = Array.isArray(plan && plan.evidence) ? plan.evidence : [];
  const last = evidence.length ? evidence[evidence.length - 1] : null;
  const facts = {
    evidenceCount: evidence.length,
    lastOk: !!(last && last.ok),
    lastExitCode: last ? last.exitCode : null,
    declaredChecks: checks.length,
    unverified: checks.length === 0
  };

  if (outcome === 'blocked') return { accept: true, outcome, facts, reason: '' };

  if (!evidence.length) {
    if (!checks.length) return { accept: true, outcome, facts, reason: '' };
    return {
      accept: false,
      outcome,
      facts,
      reason: '还没有任何检查事实：先调用 goal_check 跑一次检查，再申请完成'
    };
  }

  const pending = checks.filter((c) => {
    const f = latestFactFor(evidence, c);
    return !f || !f.ok;
  });
  if (pending.length) {
    const detail = pending
      .map((c) => {
        const f = latestFactFor(evidence, c);
        const code = f && f.exitCode != null ? `exit ${f.exitCode}` : (f && f.note) || '没有结果';
        return `「${c.command}」→ ${code}`;
      })
      .join('；');
    return { accept: false, outcome, facts, reason: `检查还没通过：${detail}` };
  }
  // 最近一次事实必须是绿的：模型临时跑的另一条命令刚刚报红时，也不许收尾
  if (!last.ok) {
    const code = last.exitCode != null ? `exit ${last.exitCode}` : last.note;
    return {
      accept: false,
      outcome,
      facts,
      reason: `最近一次检查「${last.command}」没通过（${code}），不能按完成收尾`
    };
  }
  return { accept: true, outcome, facts, reason: '' };
}

/**
 * 续跑判定（纯函数，可单测）。
 *
 * 顺序即优先级：收尾主张 > 轮次 > 墙钟 > 续跑。
 * 「预算用完」只有一种含义：**还没收尾**，不是完成。
 *
 * @param {{ plan: object, limits?: object, now?: number, interrupted?: boolean }} input
 * @returns {{ cont: boolean, stop: string|null, delayMs?: number, budget: object }}
 */
function decideContinuation(input = {}) {
  const { plan } = input;
  const limits = input.limits || AGENT_LIMITS_DEFAULTS;
  const now = Number.isFinite(input.now) ? input.now : Date.now();
  const budget = resolveGoalBudget(plan, limits);
  const attempt = Math.max(0, Math.floor(Number(plan && plan.attempt) || 0));

  if (plan && plan.outcome === 'complete') return { cont: false, stop: 'done', budget };
  if (plan && plan.outcome === 'blocked') return { cont: false, stop: 'blocked', budget };
  if (attempt >= budget.maxAttempts) return { cont: false, stop: 'attempts', budget };

  const startedAt = plan && plan.attemptStartedAt ? Date.parse(plan.attemptStartedAt) : NaN;
  if (Number.isFinite(startedAt) && now - startedAt >= budget.maxWallMs) {
    return { cont: false, stop: 'budget', budget };
  }

  // 正常跑完一轮立刻接下一轮：节奏由模型决定，代码不额外加等待。
  // 只有崩溃/异常恢复才退避 —— 那是唯一「代码知道得比模型多」的情形。
  const delayMs = input.interrupted ? limitValue('goalRetryBackoffMs', limits) : 0;
  return { cont: true, stop: null, delayMs, budget };
}

/** 一条事实的单行摘要（事实块与工具结果共用同一措辞，避免两处漂移） */
function factLine(fact) {
  const when = String((fact && fact.at) || '').replace('T', ' ').slice(0, 19);
  const round = fact && fact.round ? `第 ${fact.round} 轮 ` : '';
  const code = fact && fact.exitCode != null ? `exit ${fact.exitCode}` : String((fact && fact.note) || '—');
  const cmd = `\`${String((fact && fact.command) || '').slice(0, 160)}\``;
  const mark = fact && fact.ok ? '通过' : String((fact && fact.note) || '未通过');
  return `- ${round}${when} ${cmd} → ${code}（${mark}）`;
}

/**
 * 事实块（**唯一渲染点**）：只陈述事实，不写结论。
 *
 * 谁来做完没做完的判断？读到它的人与模型 —— 代码在这里既不写「已完成」也不写「未完成」，
 * 所以「预算耗尽」看起来就只是「跑了 N 轮、最后一条检查 exit 1」，不会被话术包装成完成。
 *
 * @param {{ plan: object, limits?: object, upcoming?: boolean, writes?: number|null }} input
 * @returns {string}
 */
function renderEvidenceBlock(input = {}) {
  const { plan } = input;
  const limits = input.limits || AGENT_LIMITS_DEFAULTS;
  const budget = resolveGoalBudget(plan, limits);
  const done = Math.max(0, Math.floor(Number(plan && plan.attempt) || 0));
  const round = input.upcoming === false ? done : done + 1;
  const checks = goalChecks(plan);
  const evidence = Array.isArray(plan && plan.evidence) ? plan.evidence : [];

  const lines = [];
  const wall = Math.round(budget.maxWallMs / 60000);
  const startedAt = plan && plan.attemptStartedAt ? Date.parse(plan.attemptStartedAt) : NaN;
  const used = Number.isFinite(startedAt) ? Math.max(0, Math.round((Date.now() - startedAt) / 60000)) : 0;
  lines.push(
    `【目标第 ${round}/${budget.maxAttempts} 轮 · 已跑 ${used} 分钟 / 预算 ${wall} 分钟】`
  );

  lines.push(
    checks.length
      ? `声明的检查（${checks.length} 条）：${checks.map((c) => `\`${String(c.command).slice(0, 120)}\``).join('、')}`
      : '声明的检查：无（未验证模式 —— 完成申请不会被代码核对，事实块会标注「未验证」）'
  );
  // 「改了几次文件」只有在确实量过时才写（null/undefined = 不知道，不冒充 0）
  if (input.writes != null && Number.isFinite(Number(input.writes))) {
    lines.push(`本轮改动工作区的工具调用：${Number(input.writes)} 次`);
  }

  if (evidence.length) {
    lines.push('', '检查事实（代码记录，不可编辑）：');
    const recent = evidence.slice(-5);
    for (const f of recent) lines.push(factLine(f));
    const last = evidence[evidence.length - 1];
    if (last && last.tail) {
      lines.push(`最近一次输出尾部（\`${String(last.command).slice(0, 80)}\`）：`, '```', last.tail, '```');
    }
  } else {
    lines.push('', '检查事实：这一轮还没有检查记录');
  }
  return lines.join('\n');
}

module.exports = {
  GOAL_CHECK_MAX_CHARS,
  resolveGoalBudget,
  goalChecks,
  isUnverified,
  tailEvidence,
  runGoalCheck,
  latestFactFor,
  judgeGoalFinish,
  decideContinuation,
  factLine,
  renderEvidenceBlock
};
