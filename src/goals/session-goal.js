// @ts-check
'use strict';

/**
 * 会话级目标对象（`session_goals` 表）：**唯一读写点**。
 *
 * 分工与 `plans/goal-run.js` 一致：
 *   - 形状归一化 / 事实 / 核对 / 续跑判定 / 事实块 —— 全在 goal-run.js（单一来源）；
 *   - 本文只负责「按会话存取」：读 → 改 → 写、单会话单目标、预算与轮次自增、给 UI 的投影。
 *
 * 刻意不做的事：
 *   - 不用 `plans.json`（那是调度器配置）：会话目标跟着会话生灭，`session_goals` 有
 *     `ON DELETE CASCADE`，删会话即清；也不进任何定时器。
 *   - 不在 Rust 侧解析目标：Rust 只当 KV（`memory.session_goal_get / put`）。
 *   - 不判断「目标达成没有」：那是 `judgeGoalFinish` + 事实的事。
 */

const {
  normalizeGoal,
  normalizeEvidence,
  normalizeClaim,
  normalizeBudget,
  normalizeIso,
  resolveGoalBudget,
  goalCheckProgress,
  latestFactFor,
  factsForCheck,
  decideContinuation
} = require('../plans/goal-run');
const { AGENT_LIMITS_DEFAULTS } = require('../agent/agent-limits');

const STATUSES = ['active', 'paused', 'stalled', 'blocked'];

/** 单会话串行化：读-改-写之间不允许插进另一次写（同进程内只有 Main 会写目标） */
const chains = new Map();

function withLock(sessionId, fn) {
  const key = String(sessionId || '');
  const prev = chains.get(key) || Promise.resolve();
  const next = prev.then(fn, fn);
  // 链尾失败不能污染后续调用；只保留顺序
  chains.set(
    key,
    next.then(
      () => {},
      () => {}
    )
  );
  return next;
}

function toIso(v) {
  return normalizeIso(v) || new Date().toISOString();
}

/**
 * 目标对象归一化（存前 / 读后都走这里，保证磁盘上的东西和内存里的一致）。
 * @param {object} raw
 */
function normalizeSessionGoal(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const status = STATUSES.includes(String(r.status)) ? String(r.status) : 'active';
  const outcome = r.outcome === 'complete' || r.outcome === 'blocked' ? r.outcome : null;
  return {
    goal: normalizeGoal(r.goal),
    budget: normalizeBudget(r.budget),
    evidence: (Array.isArray(r.evidence) ? r.evidence : []).map(normalizeEvidence).filter(Boolean),
    claims: (Array.isArray(r.claims) ? r.claims : []).map(normalizeClaim).filter(Boolean),
    outcome,
    status,
    attempt: Math.max(0, Math.floor(Number(r.attempt) || 0)),
    attemptStartedAt: normalizeIso(r.attemptStartedAt),
    startedAt: toIso(r.startedAt),
    // `updatedAt` 是「上次落盘的时间」：读路径必须还原存储值，不能每次都写成 now。
    // 写成 now 的后果不是少一个字段，而是这个字段永远等于「刚刚」——任何
    // 「这条目标多久没动了 / 收尾之后对话又继续了没有」都判不出来。
    updatedAt: normalizeIso(r.updatedAt) || new Date().toISOString()
  };
}

/**
 * 读会话目标。损坏的 JSON 当「没有目标」处理并留一行日志 ——
 * 一个坏 blob 不该让整轮 prompt 组装失败。
 */
async function loadGoal(opts = {}) {
  const invokeRpc = opts.invokeRpc;
  const sessionId = String(opts.sessionId || '');
  if (!invokeRpc || !sessionId) return null;
  let res;
  try {
    res = await invokeRpc('memory.session_goal_get', { sessionId });
  } catch (e) {
    if (opts.log) opts.log(`读会话目标失败: ${(e && e.message) || String(e)}`);
    return null;
  }
  const raw = res && (res.goalJson != null ? res.goalJson : res.goal_json);
  if (!raw) return null;
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    const goal = normalizeSessionGoal(parsed);
    // 没有 objective 的目标没有意义（也注入不出东西）：当作没有
    return goal.goal.objective ? goal : null;
  } catch (e) {
    if (opts.log) opts.log(`会话目标 JSON 损坏（按无目标处理）: ${(e && e.message) || String(e)}`);
    return null;
  }
}

/**
 * 把目标压进**落盘预算**（唯一写入口的保证，见 `agent-limits.goalBlobMaxChars`）。
 *
 * 为什么必须有这一步：事实保留预算（20 条 × 每条 4000 字符尾巴）满额 JSON 实测 83k 字符，
 * 而 `dieyun-core` 的 `SESSION_GOAL_MAX_CHARS` 是 64000。写满之后每次 `session_goal_put`
 * 都被拒 —— `goal_check` 的命令已经跑完、事实却落不了库，`goal_finish` 也写不进去，
 * 目标就此卡死，界面上只看到「检查跑过了但面板不动」。
 *
 * 裁剪顺序即「先丢最没用的」：先削最早那些事实的输出尾巴（面板/注入块只有最新一条会印尾巴），
 * 再丢最早的事实（至少留一条：收尾核对要看最新那条），最后丢最早的主张（至少留一条）。
 *
 * @param {object} goal 已归一化的目标（原地裁剪）
 * @param {number} [maxChars]
 * @returns {object} 同一个对象
 */
function fitGoalToBudget(goal, maxChars) {
  const raw = Number(maxChars);
  const budget =
    Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : Number(AGENT_LIMITS_DEFAULTS.goalBlobMaxChars);
  const size = () => JSON.stringify(goal).length;
  if (!(budget > 0) || size() <= budget) return goal;
  for (let i = 0; i < goal.evidence.length && size() > budget; i += 1) {
    if (goal.evidence[i].tail) goal.evidence[i].tail = '';
  }
  while (size() > budget && goal.evidence.length > 1) goal.evidence.shift();
  while (size() > budget && goal.claims.length > 1) goal.claims.shift();
  if (size() > budget) {
    // 单条事实就撑爆预算（例如 objective + 一条 2000 字符命令）：宁可报错也不写一条
    // 会被 Rust 拒掉的账 —— 后者只会让模型以为「写成功了」。
    const e = new Error('目标超出存储上限（goalBlobMaxChars）');
    e.code = 'GOAL_TOO_LARGE';
    throw e;
  }
  return goal;
}

/** 写会话目标（整体覆盖）。`goal = null` 表示删除。 */
async function saveGoal(opts = {}) {
  const invokeRpc = opts.invokeRpc;
  const sessionId = String(opts.sessionId || '');
  if (!invokeRpc || !sessionId) return { ok: false, error: '缺少 invokeRpc / sessionId' };
  const goal = opts.goal ? normalizeSessionGoal(opts.goal) : null;
  // 落盘这一刻的时间戳（读路径只还原、不重写，见 normalizeSessionGoal）
  if (goal) goal.updatedAt = new Date().toISOString();
  // 预算在这里落地：库里的硬上限（Rust 64000）与这里的保留预算（20 × 4000 尾巴）
  // 本来会打架，裁剪只做一次，就在唯一的写入口。
  const fitted = goal ? fitGoalToBudget(goal, opts.maxChars) : null;
  await invokeRpc('memory.session_goal_put', {
    sessionId,
    goalJson: fitted ? JSON.stringify(fitted) : null
  });
  return { ok: true, goal: fitted };
}

/**
 * 读-改-写（串行）。`mutate` 拿到当前目标（可能 null），返回新目标或 null。
 * 返回改后的目标，便于调用方直接用最新事实回话给模型。
 */
async function patchGoal(opts = {}) {
  const invokeRpc = opts.invokeRpc;
  const sessionId = String(opts.sessionId || '');
  const mutate = opts.mutate;
  if (!invokeRpc || !sessionId || typeof mutate !== 'function') {
    return { ok: false, error: '缺少 invokeRpc / sessionId / mutate' };
  }
  return withLock(sessionId, async () => {
    const current = await loadGoal({ invokeRpc, sessionId, log: opts.log });
    const draft = await mutate(current);
    if (draft === undefined) return { ok: true, goal: current, unchanged: true };
    const saved = await saveGoal({ invokeRpc, sessionId, goal: draft });
    return saved;
  });
}

/**
 * 开一个新目标。
 *
 * 单会话单目标：已有「还在跑」的目标（`active` 且未收尾）→ 拒绝并把现有目标回给模型，
 * 让它接着推进而不是每轮重开。已完成 / 已阻塞 / 已暂停 / 预算尽 → 允许覆盖（那是新目标），
 * 但**覆盖必须留下回执**：旧目标的清单与事实随覆盖一起消失，`replaced` 让模型能就这件事说一句话，
 * 而不是账本悄悄归零（2026-11-07 审计）。
 */
async function startGoal(opts = {}) {
  const draft = opts.draft || {};
  /** 覆盖掉的旧目标摘要（没有旧目标 / 旧目标仍在跑 → null） */
  let replaced = null;
  const res = await patchGoal({
    invokeRpc: opts.invokeRpc,
    sessionId: opts.sessionId,
    log: opts.log,
    mutate: (current) => {
      if (current && current.status === 'active' && !current.outcome) {
        return undefined;
      }
      if (current && current.goal && current.goal.objective) {
        const todos = Array.isArray(current.goal.todos) ? current.goal.todos : [];
        replaced = {
          objective: current.goal.objective,
          status: current.status,
          outcome: current.outcome || null,
          attempt: current.attempt,
          evidenceCount: Array.isArray(current.evidence) ? current.evidence.length : 0,
          todosDone: todos.filter((t) => t.done).length,
          todosTotal: todos.length
        };
      }
      const goal = normalizeSessionGoal({
        goal: {
          objective: draft.objective,
          checks: draft.checks,
          todos: draft.todos,
          cwd: draft.cwd
        },
        budget: draft.budget,
        evidence: [],
        claims: [],
        outcome: null,
        status: 'active',
        attempt: 0,
        attemptStartedAt: null,
        startedAt: new Date().toISOString()
      });
      if (!goal.goal.objective) return undefined;
      return goal;
    }
  });
  return replaced ? { ...res, replaced } : res;
}

/** 已有目标且仍在推进（未收尾、未停）—— 这是「单会话单目标」的判据 */
function isActiveGoal(goal) {
  return !!(goal && goal.status === 'active' && !goal.outcome);
}

/** 起一轮：attempt+1，第一次自动续跑时记下墙钟起点 */
function advanceAttempt(goal) {
  if (!goal) return goal;
  goal.attempt = Math.max(0, Math.floor(Number(goal.attempt) || 0)) + 1;
  if (!goal.attemptStartedAt) goal.attemptStartedAt = new Date().toISOString();
  return goal;
}

/** 追加一条检查事实（保留条数 = agent-limits.goalEvidenceKeep，与计划目标一致） */
function pushEvidence(goal, fact, keep) {
  if (!goal || !fact) return goal;
  const max =
    Number.isFinite(Number(keep)) && Number(keep) > 0
      ? Math.floor(Number(keep))
      : AGENT_LIMITS_DEFAULTS.goalEvidenceKeep;
  const list = Array.isArray(goal.evidence) ? goal.evidence.slice() : [];
  list.push(normalizeEvidence(fact));
  goal.evidence = list.filter(Boolean).slice(-max);
  return goal;
}

/** 记一条主张（留痕；是否接受由 judgeGoalFinish 决定） */
function recordClaim(goal, claim) {
  if (!goal || !claim) return goal;
  const list = Array.isArray(goal.claims) ? goal.claims.slice() : [];
  // 时间戳由这里补：调用方（工具桥）只关心 outcome / round / accepted / note
  list.push(normalizeClaim({ at: new Date().toISOString(), ...claim }));
  // 与 evidence 同一个保留上限：两处都写 20 会变成第二份真相
  goal.claims = list.filter(Boolean).slice(-AGENT_LIMITS_DEFAULTS.goalEvidenceKeep);
  return goal;
}

/**
 * 一轮结束后的续跑判定（**会话目标的唯一判定点**）。
 *
 * 为什么只在这里判：一次 `agent:rust-loop-run` 的返回 = 一轮结束，这是唯一
 * 「知道这一轮干了什么」的时点。定时器只知道到点了，调度器不知道目标推进到哪。
 *
 * 判定本身是纯函数 `decideContinuation`（与计划目标共用）；本文只负责
 * 「判完把状态落盘」（预算用尽 → `stalled`，否则状态不动）。
 *
 * `attempt` 的自增**不在这里**：那在一轮开始时（`agent:rust-loop-run` 入口的
 * `advanceAttempt`）做，一次一轮，人驱动的轮与自动续跑的轮口径一致。
 *
 * @param {{ invokeRpc: Function, sessionId: string, limits?: object, log?: Function }} opts
 * @returns {Promise<null | {active: boolean, cont: boolean, stop: string|null, attempt: number, max: number}>}
 *   无目标 / 已收尾 / 已暂停 → null（Renderer 拿不到这个字段就不续跑）
 */
async function judgeAfterTurn(opts = {}) {
  const goal = await loadGoal(opts);
  if (!isActiveGoal(goal)) return null;
  // 墙钟起点退化为目标创建时间：`attemptStartedAt` 由第一轮自增时写入，若那次写盘失败，
  // 判定不能连墙钟都没有 —— 否则「轮次计数坏掉」就只剩无限续跑一种可能。
  const plan =
    goal.attemptStartedAt || !goal.startedAt
      ? goal
      : { ...goal, attemptStartedAt: goal.startedAt };
  const decision = decideContinuation({ plan, limits: opts.limits });
  const budget = decision.budget || {};
  const attempt = Math.max(0, Math.floor(Number(goal.attempt) || 0));
  const max = Math.max(0, Math.floor(Number(budget.maxAttempts) || 0));
  if (decision.cont) return { active: true, cont: true, stop: null, attempt, max };
  // 预算用尽 = 还没收尾但不再往下跑：状态落成 stalled，注入块与面板都据此说「预算已尽」。
  // 收尾（complete/blocked）不改状态：outcome 才是收尾的表达，status 只表达「停/续」。
  if (decision.stop === 'attempts' || decision.stop === 'budget') {
    try {
      await patchGoal({
        invokeRpc: opts.invokeRpc,
        sessionId: opts.sessionId,
        log: opts.log,
        mutate: (g) => {
          if (!isActiveGoal(g)) return undefined;
          g.status = 'stalled';
          return g;
        }
      });
    } catch {
      // 状态落盘失败不影响本轮交付：下一轮还会再判一次
    }
  }
  return { active: true, cont: false, stop: decision.stop || 'stop', attempt, max };
}

/** 暂停（用户按停止 / 面板停）：只影响「自动推进」，事实与清单全部保留 */
async function pauseGoal(opts = {}) {
  return patchGoal({
    invokeRpc: opts.invokeRpc,
    sessionId: opts.sessionId,
    log: opts.log,
    mutate: (g) => {
      if (!isActiveGoal(g)) return undefined;
      g.status = 'paused';
      return g;
    }
  });
}

/**
 * 继续（面板 / 预算用尽后的人工续跑）：回到 active 并**重置轮次预算**。
 * 事实与清单不动 —— 已跑过的检查结果仍是下一轮的依据。
 */
async function resumeGoal(opts = {}) {
  return patchGoal({
    invokeRpc: opts.invokeRpc,
    sessionId: opts.sessionId,
    log: opts.log,
    mutate: (g) => {
      if (!g || g.outcome) return undefined;
      g.status = 'active';
      g.attempt = 0;
      g.attemptStartedAt = new Date().toISOString();
      return g;
    }
  });
}

/**
 * 收尾时间：已收尾目标的「结账那一刻」。
 *
 * 取自**被接受的那条 claim**（就是 `judgeGoalFinish` 放行的那次申请），所以它与
 * 「谁同意它收尾」是同一个事实；老数据没有 claim 时退回最后一条检查事实，再退回
 * `updatedAt` —— 只为给面板一个说得出口的时间点，不参与任何判定。
 */
function goalClosedAt(goal) {
  if (!goal || !goal.outcome) return null;
  const claims = Array.isArray(goal.claims) ? goal.claims : [];
  for (let i = claims.length - 1; i >= 0; i -= 1) {
    const c = claims[i];
    if (c && c.accepted === true && c.outcome === goal.outcome) return c.at;
  }
  const evidence = Array.isArray(goal.evidence) ? goal.evidence : [];
  if (evidence.length) return evidence[evidence.length - 1].at;
  return normalizeIso(goal.updatedAt) || null;
}

/**
 * 给侧栏「目标」页的投影：**UI 需要的都在这里成型**，面板不再自己算进度/截断事实。
 *
 * 进度的来源有优先级（`progressFrom` 一并给出去，Renderer 只按它选文案、不自己判）：
 *   1. `checks` —— 有声明检查：进度 = 最新结果通过的检查数 / 声明检查数。**客观**，来自代码记录的
 *      事实，与 `judgeGoalFinish` 用的是同一个算法（`goalCheckProgress`）。
 *   2. `todos`  —— 没有声明检查（未验证模式）：退回清单勾选比例。这是**模型自述**，只能当参考。
 *   3. `outcome`—— 两样都没有：只有两种可判定取值，收尾 1 / 否则 0（不编造百分比）。
 *
 * 为什么不再继续只按 todos 算：勾选完全由模型一次性写全（完工才回来勾），进度条会永远
 * 停在 0 然后跳到满格，等于没信息；而 `evidence` 是代码写的，逐轮自然往前走。
 *
 * `completedAt` / `superseded` 解决的是另一件事：**收尾的目标不是当前在做的事**。
 * 一条 11-06 收尾、11-07 又聊了半天别的东西的目标，如果还按「一个目标」原样画，
 * 面板上就会出现「已完成 · 第 1/12 轮 · 验收通过 1/1」，与窗口里的对话完全对不上。
 * 判据只有一条，且不猜语义：收尾之后**这个会话又有人说了话**（`lastUserMessageAt` 由
 * Main 从消息表取，Renderer 不参与判断）。
 *
 * @param {{ goal?: object|null, limits?: object, evidenceShown?: number, lastUserMessageAt?: string|null }} input
 */
function toPanelView(input = {}) {
  const goal = input.goal;
  if (!goal || !goal.goal || !goal.goal.objective) return null;
  const completedAt = goalClosedAt(goal);
  const lastUserAt = normalizeIso(input.lastUserMessageAt);
  const superseded = !!(
    completedAt &&
    lastUserAt &&
    Date.parse(lastUserAt) > Date.parse(completedAt)
  );
  const budget = resolveGoalBudget(goal, input.limits);
  const todos = Array.isArray(goal.goal.todos) ? goal.goal.todos : [];
  const done = todos.filter((t) => t.done).length;
  const evidence = Array.isArray(goal.evidence) ? goal.evidence : [];
  const shown = Number.isFinite(input.evidenceShown) ? Math.max(1, Math.floor(input.evidenceShown)) : 10;
  const last = evidence.length ? evidence[evidence.length - 1] : null;
  const checkProgress = goalCheckProgress(goal);
  const progressFrom = checkProgress.total ? 'checks' : todos.length ? 'todos' : 'outcome';
  const progress =
    progressFrom === 'checks'
      ? checkProgress.passed / checkProgress.total
      : progressFrom === 'todos'
        ? done / todos.length
        : goal.outcome === 'complete'
          ? 1
          : 0;
  return {
    objective: goal.goal.objective,
    status: goal.status,
    outcome: goal.outcome || null,
    /** 收尾时间（未收尾为 null）——面板据此说「这是哪一晚做完的那件事」 */
    completedAt,
    /** 已收尾，且此后该会话又有人说话：这是历史目标，不是当前在做的事 */
    superseded,
    attempt: goal.attempt,
    maxAttempts: budget.maxAttempts,
    maxWallMs: budget.maxWallMs,
    startedAt: goal.startedAt,
    attemptStartedAt: goal.attemptStartedAt,
    updatedAt: goal.updatedAt,
    unverified: checkProgress.total === 0,
    // 按**声明的检查**聚合事实：每条检查的最新结果 + 跑过几次。
    // 面板与「目标条」都只要这一份投影 —— 谁还想要「原始事实流水」就直接看 evidence。
    // `note` 一并带出去：`ok:false` 里有「跑过没通过」和「根本没跑成（沙箱拒绝/超时）」两种，
    // 只给布尔值的话 UI 只能都画成 ❌，那是把「没执行」说成了「失败」。
    checks: checkProgress.checks.map((c) => {
      const fact = latestFactFor(evidence, c);
      return {
        id: c.id,
        command: c.command,
        runs: factsForCheck(evidence, c).length,
        ok: fact ? fact.ok === true : null,
        note: fact ? String(fact.note || '') : '',
        exitCode: fact ? fact.exitCode : null,
        at: fact ? fact.at : null,
        round: fact ? fact.round : 0
      };
    }),
    todos: todos.map((t) => ({ text: t.text, done: t.done })),
    todosDone: done,
    todosTotal: todos.length,
    checksPassed: checkProgress.passed,
    checksTotal: checkProgress.total,
    /** 进度条比例（来源见上方优先级）；Renderer 只管画，不再自己算 */
    progress,
    /** 进度来源：checks（客观验收）/ todos（模型自述清单）/ outcome（收尾 0 或 1） */
    progressFrom,
    evidence: evidence.slice(-shown).map((f) => ({
      at: f.at,
      round: f.round,
      command: f.command,
      ok: f.ok,
      exitCode: f.exitCode,
      note: f.note
    })),
    lastFact: last
      ? { command: last.command, ok: last.ok, exitCode: last.exitCode, at: last.at, tail: last.tail }
      : null
  };
}

module.exports = {
  STATUSES,
  normalizeSessionGoal,
  loadGoal,
  saveGoal,
  fitGoalToBudget,
  patchGoal,
  startGoal,
  isActiveGoal,
  advanceAttempt,
  pushEvidence,
  recordClaim,
  judgeAfterTurn,
  pauseGoal,
  resumeGoal,
  toPanelView
};
