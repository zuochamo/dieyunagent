'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { msUntilNextRun } = require('./rrule-next');
// 运行态保留条数等数字的唯一来源（AGENTS.md §6：数字上限只改 agent-limits）
const { AGENT_LIMITS_DEFAULTS } = require('../agent/agent-limits');

const FILE_NAME = 'plans.json';

/** rrule 里的「总共执行多少次」（COUNT=）。只用于判定「跑满即停用」，规则的真相仍是 rrule。 */
const COUNT_LIMIT_RE = /(?:^|;)COUNT=\d+/i;

/** 规则签名：只用于判断「频率规则是否被改过」（改过才重新对齐计数锚点） */
function ruleSignature(rrule) {
  return String(rrule || '').trim().toUpperCase();
}

/**
 * 把 COUNT 计划的 dtstart 对齐到「下一次触发」。
 *
 * RRULE 的 COUNT 是「从 dtstart 起的第 N 次触发」：dtstart 落在今天 00:00（或计划创建前），
 * 今天已经过去的那一次也会占掉一个名额 —— 用户填「总共 3 次」却只跑 2 次。
 * 对齐到下一次触发不会改变后续触发序列（它本身就是序列里的一个成员），
 * 只让 COUNT 数的正好是「从现在起还会跑几次」。
 */
function alignCountLimitedStart(plan) {
  if (!plan || plan.trigger !== 'schedule' || !COUNT_LIMIT_RE.test(String(plan.rrule || ''))) return;
  // enabled 先当作 true 再算：停用状态不影响「下一次触发是什么时候」
  const ms = msUntilNextRun({ ...plan, enabled: true });
  // 规则无效 / 已经跑满：不动锚点，交给调度器与 updateRunResult 的停用逻辑
  if (ms == null) return;
  plan.dtstart = new Date(Date.now() + ms).toISOString();
}

function newId() {
  return crypto.randomBytes(8).toString('hex');
}

/**
 * 运行边界标记（唯一权威的「这次运行已经开始、但还没收尾」记录）。
 *
 * 进程被杀时 Main 的收尾代码不会执行，只有落盘的标记能告诉下次启动
 * 「会话里那条用户轮次还没有回复」，从而补写中断回执。
 */
function normalizeRunState(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const runId = String(raw.runId || '').trim();
  const sessionId = String(raw.sessionId || '').trim();
  if (!runId && !sessionId) return null;
  return {
    runId,
    sessionId,
    startedAt: String(raw.startedAt || '').trim() || new Date().toISOString()
  };
}

function normalizeTrigger(v) {
  if (v === 'idle') return 'idle';
  if (v === 'goal') return 'goal';
  return 'schedule';
}

function normalizeIso(v) {
  if (!v) return null;
  const s = String(v).trim();
  if (!s) return null;
  return Number.isFinite(Date.parse(s)) ? s : null;
}

/**
 * 目标型验收面：**只存结构化命令**，不解析自然语言（禁意图关键词硬编码）。
 *
 * v2：验收不再是「调度器每轮无条件跑的一条命令」，而是模型随时可调的检查清单（`goal_check`）。
 * 每条命令的语义只有一条通用契约：退出码 0 = 通过。代码不分类、不分档、不按技术栈分支。
 */
function normalizeGoal(raw) {
  const g = raw && typeof raw === 'object' ? raw : {};
  const checks = Array.isArray(g.checks)
    ? g.checks
        .map((c) => {
          const item = typeof c === 'string' ? { command: c } : c || {};
          const command = String(item.command || '').trim().slice(0, 2000);
          if (!command) return null;
          return { id: String(item.id || '').trim() || command.slice(0, 40), command };
        })
        .filter(Boolean)
    : [];
  return {
    checks,
    cwd: String(g.cwd || '').trim()
  };
}

/** 预算：只存用户选择（0/空 = 用 agent-limits 默认值），clamp 在 goal-run.resolveGoalBudget */
function normalizeBudget(raw) {
  const b = raw && typeof raw === 'object' ? raw : {};
  const num = (v) => {
    const n = Math.floor(Number(v));
    return Number.isFinite(n) && n > 0 ? n : 0;
  };
  return {
    maxAttempts: num(b.maxAttempts),
    maxWallMs: num(b.maxWallMs)
  };
}

/**
 * 一条检查事实（`goal.evidence` 的元素）：**只放机器可判定的字段**，
 * 措辞与判断留给模型和人 —— 代码不允许在这里写「完成/未完成」这类结论。
 */
function normalizeEvidence(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const at = normalizeIso(raw.at);
  const command = String(raw.command || '').trim().slice(0, 2000);
  if (!command && !at) return null;
  const exitCodeNum = Number(raw.exitCode);
  return {
    at: at || new Date().toISOString(),
    round: Math.max(0, Math.floor(Number(raw.round) || 0)),
    checkId: String(raw.checkId || '').trim(),
    command,
    ok: raw.ok === true,
    exitCode: Number.isFinite(exitCodeNum) ? exitCodeNum : null,
    note: String(raw.note || '').trim().slice(0, 40),
    tail: String(raw.tail || '').slice(0, 8000)
  };
}

/** 一次「完成/阻塞」主张（`goal.claims` 的元素）：模型说的，代码原样留痕供复盘 */
function normalizeClaim(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const at = normalizeIso(raw.at);
  const outcome = raw.outcome === 'complete' || raw.outcome === 'blocked' ? raw.outcome : '';
  if (!at || !outcome) return null;
  return {
    at,
    outcome,
    round: Math.max(0, Math.floor(Number(raw.round) || 0)),
    accepted: raw.accepted === true,
    note: String(raw.note || '').trim().slice(0, 1000)
  };
}

function normalizePlan(raw) {
  const p = raw && typeof raw === 'object' ? raw : {};
  const deliver = p.deliver && typeof p.deliver === 'object' ? p.deliver : {};
  const todos = Array.isArray(p.todos)
    ? p.todos.map((x) => String(x || '').trim()).filter(Boolean).slice(0, 50)
    : [];
  return {
    id: p.id || newId(),
    name: String(p.name || '未命名计划').trim() || '未命名计划',
    enabled: p.enabled !== false,
    // 触发方式：
    //   schedule：按 rrule/onceAt 定时
    //   idle：无活跃 Agent 运行且静默达标后触发，跑一次即停用
    //   goal：目标型 —— 模型在轮内自行调用 goal_check 留证据、调 goal_finish 申请收尾；
    //         代码只核对事实与预算（见 goal-run.js），不判断「目标达成没有」
    trigger: normalizeTrigger(p.trigger),
    rrule: String(p.rrule || '').trim(),
    onceAt: p.onceAt ? String(p.onceAt).trim() : '',
    tz: String(p.tz || 'Asia/Shanghai').trim() || 'Asia/Shanghai',
    dtstart: p.dtstart ? String(p.dtstart).trim() : new Date().toISOString(),
    prompt: String(p.prompt || '').trim(),
    todos,
    skillIds: Array.isArray(p.skillIds)
      ? p.skillIds.map((x) => String(x).trim()).filter(Boolean).slice(0, 8)
      : [],
    // 计划绑定的模型路由（custom:<id> / builtin:<supplierId>:<modelId>）。
    // 只存路由，绝不存 apiKey：执行时按路由现算配置，避免密钥落盘。
    model: String(p.model || '').trim(),
    modelRoute: String(p.modelRoute || '').trim(),
    deliver: {
      type: deliver.type === 'session' ? 'session' : 'session',
      sessionId: String(deliver.sessionId || p.sessionId || '').trim()
    },
    // 计划绑定的工作空间（本地目录，或 ssh:// 远端工作区）。
    // 空 = 跟随执行时当前打开的工作空间（历史行为）：定时执行没有打开的会话，
    // 工作区不随计划落盘就只能「跑在碰巧开着的那个目录里」。
    workspace: String(p.workspace || '').trim(),
    // 目标型计划的验收面与预算（仅 trigger==='goal' 时使用；其余触发方式原样保留不影响行为）
    goal: normalizeGoal(p.goal),
    budget: normalizeBudget(p.budget),
    // 运行态：只在下方专用方法里维护，normalize 只负责保留合法值
    runState: normalizeRunState(p.runState),
    attempt: Math.max(0, Math.floor(Number(p.attempt) || 0)),
    attemptStartedAt: normalizeIso(p.attemptStartedAt),
    nextRunAt: normalizeIso(p.nextRunAt),
    // 模型给出的「完成/阻塞」主张（代码核对过事实后才会置位，见 goal-run.judgeGoalFinish）
    outcome: p.outcome === 'complete' || p.outcome === 'blocked' ? p.outcome : null,
    evidence: Array.isArray(p.evidence) ? p.evidence.map(normalizeEvidence).filter(Boolean) : [],
    claims: Array.isArray(p.claims) ? p.claims.map(normalizeClaim).filter(Boolean) : [],
    createdAt: p.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    lastRunAt: p.lastRunAt || null,
    lastRunOk: p.lastRunOk == null ? null : !!p.lastRunOk,
    lastRunSummary: String(p.lastRunSummary || '').slice(0, 4000)
  };
}

class PlansStore {
  constructor(userData) {
    this.filePath = path.join(userData, FILE_NAME);
    this.plans = [];
    this._load();
  }

  _load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      const list = Array.isArray(raw.plans) ? raw.plans : [];
      this.plans = list.map(normalizePlan);
    } catch {
      this.plans = [];
    }
  }

  _save() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(
      this.filePath,
      JSON.stringify({ version: 1, plans: this.plans }, null, 2),
      'utf8'
    );
  }

  list() {
    return this.plans.map((p) => ({ ...p }));
  }

  get(id) {
    const hit = this.plans.find((p) => p.id === id);
    return hit ? { ...hit } : null;
  }

  upsert(patch) {
    const plan = normalizePlan(patch);
    // 目标型不需要 rrule/onceAt；也**不强制**填检查命令 —— 没有检查就是「未验证模式」：
    // 照样能跑（覆盖没法机器验收的主观目标），但完成申请不会被代码核对通过，
    // 且事实块会明说「未验证」。要不要给检查由人/模型决定，代码不替它判断。
    if (plan.trigger !== 'idle' && plan.trigger !== 'goal' && !plan.rrule && !plan.onceAt) {
      const err = new Error('rrule 或 onceAt 至少填一项（空闲/目标触发计划除外）');
      err.code = 'INVALID_SCHEDULE';
      throw err;
    }
    if (!plan.prompt) {
      const err = new Error('prompt 必填');
      err.code = 'INVALID_PROMPT';
      throw err;
    }
    const idx = this.plans.findIndex((p) => p.id === plan.id);
    const prev = idx >= 0 ? this.plans[idx] : null;
    if (prev) {
      plan.createdAt = prev.createdAt;
      if (!patch.dtstart) plan.dtstart = prev.dtstart;
      // 运行态不是表单字段：UI 保存不应清掉正在运行的边界标记、轮次与检查事实，
      // 只由 beginRun/endRun/beginAttempt/pushEvidence/recordClaim/setOutcome/scheduleNextAttempt 维护
      if (!patch || !('runState' in patch)) plan.runState = prev.runState;
      plan.attempt = prev.attempt;
      plan.attemptStartedAt = prev.attemptStartedAt;
      plan.nextRunAt = prev.nextRunAt;
      plan.outcome = prev.outcome;
      plan.evidence = prev.evidence;
      plan.claims = prev.claims;
      this.plans[idx] = plan;
    } else {
      this.plans.push(plan);
    }
    // 「总共执行 N 次」的计数锚点：只在新建或换了规则时对齐一次
    //（每次保存都对齐会把次数重新充满，等于「永远跑不完」）。
    if (!prev || ruleSignature(prev.rrule) !== ruleSignature(plan.rrule)) alignCountLimitedStart(plan);
    this._save();
    return plan;
  }

  delete(id) {
    const before = this.plans.length;
    this.plans = this.plans.filter((p) => p.id !== id);
    if (this.plans.length !== before) this._save();
    return { ok: true };
  }

  updateRunResult(id, result) {
    const p = this.plans.find((x) => x.id === id);
    if (!p) return;
    p.lastRunAt = new Date().toISOString();
    // 目标型：这一轮「成功」= 模型申请完成且代码核对过事实通过（outcome=complete），
    // 不是「模型写了正文」。result 带 outcome 字段就按它判（goal 轮次恒带，null = 未收尾）。
    p.lastRunOk =
      result && 'outcome' in result
        ? result.outcome === 'complete'
        : !!(result && result.ok);
    p.lastRunSummary = result
      ? result.summary || result.error || ''
      : '';
    p.updatedAt = p.lastRunAt;
    // onceAt 与 idle 都是「一次性」语义：成功跑完即停用，重新启用 = 重新排队
    // 目标型（goal）不在这里收尾：它由 setOutcome + decideContinuation 决定，见 goal-run.js
    if ((p.onceAt || p.trigger === 'idle') && p.lastRunOk) {
      p.enabled = false;
    } else if (p.trigger === 'schedule' && COUNT_LIMIT_RE.test(String(p.rrule || ''))) {
      // 「总共执行 N 次」的计划跑满即完成：RRULE 已没有下一次触发就停用，
      // 免得列表里长期挂着一条「启用中」却永远不会再跑的计划。
      if (msUntilNextRun(p) == null) p.enabled = false;
    }
    this._save();
  }

  /** 开关（用户唯一的手动开关；目标型收尾也只是替用户关掉，不会自己打开） */
  setEnabled(id, enabled) {
    const p = this.plans.find((x) => x.id === id);
    if (!p) return null;
    p.enabled = enabled !== false;
    p.updatedAt = new Date().toISOString();
    if (p.enabled) {
      // 重新启用 = 重新排队：清掉上一轮的待跑时间，避免一启用就立刻触发
      p.nextRunAt = null;
    }
    this._save();
    return { ...p };
  }

  /**
   * 目标型：一轮开始。轮次 +1、清掉待跑时间与上一轮的主张；首轮记下墙钟预算起点。
   * 与 runState 同处维护，进程被杀的场景下靠它和 runState 一起恢复。
   *
   * @returns {object|null} 更新后的计划快照
   */
  beginAttempt(id) {
    const p = this.plans.find((x) => x.id === id);
    if (!p) return null;
    p.attempt = Math.max(0, Math.floor(Number(p.attempt) || 0)) + 1;
    p.nextRunAt = null;
    p.outcome = null;
    if (!p.attemptStartedAt) p.attemptStartedAt = new Date().toISOString();
    p.updatedAt = new Date().toISOString();
    this._save();
    return { ...p };
  }

  /**
   * 目标型：落一条检查事实（`goal_check` 的唯一写入口）。
   *
   * 只放机器可判定的字段；判定不在这里做。保留条数由 `agent-limits.goalEvidenceKeep`
   * 约束（运行态有界，更早的事实仍在计划会话的 trace 里）。
   *
   * @param {string} id
   * @param {object} raw 一条证据（goal-run.runGoalCheck 的产物）
   * @param {number} [keep] 保留条数上限（缺省取 agent-limits）
   * @returns {{ fact: object|null, evidence: object[] }}
   */
  pushEvidence(id, raw, keep) {
    const p = this.plans.find((x) => x.id === id);
    if (!p) return { fact: null, evidence: [] };
    const fact = normalizeEvidence({ ...raw, at: (raw && raw.at) || new Date().toISOString() });
    if (!fact) return { fact: null, evidence: p.evidence };
    const cap = Number.isFinite(keep) && keep > 0 ? Math.floor(keep) : AGENT_LIMITS_DEFAULTS.goalEvidenceKeep;
    p.evidence = (Array.isArray(p.evidence) ? p.evidence.concat(fact) : [fact]).slice(-cap);
    p.updatedAt = fact.at;
    this._save();
    return { fact, evidence: p.evidence };
  }

  /**
   * 目标型：记录模型的一次「完成/阻塞」主张（含被代码拒绝的那些）。
   * 主张是模型的判断，事实是代码的记录 —— 两者都留痕，人早上复盘才有依据。
   */
  recordClaim(id, raw) {
    const p = this.plans.find((x) => x.id === id);
    if (!p) return null;
    const claim = normalizeClaim({ ...raw, at: (raw && raw.at) || new Date().toISOString() });
    if (!claim) return null;
    p.claims = (Array.isArray(p.claims) ? p.claims.concat(claim) : [claim]).slice(-10);
    p.updatedAt = claim.at;
    this._save();
    return claim;
  }

  /** 目标型：写下本轮收尾结论（`complete` / `blocked`）；由 goal_finish 核对事实后调用 */
  setOutcome(id, outcome) {
    const p = this.plans.find((x) => x.id === id);
    if (!p) return null;
    p.outcome = outcome === 'complete' || outcome === 'blocked' ? outcome : null;
    p.updatedAt = new Date().toISOString();
    this._save();
    return { ...p };
  }

  /**
   * 目标型：排下一轮（`delayMs` 后）。写的是「最早可跑时间」，不启动定时器：
   * 真正的触发由 PlansScheduler 的轮询统一负责（单一触发源）。
   */
  scheduleNextAttempt(id, delayMs) {
    const p = this.plans.find((x) => x.id === id);
    if (!p) return null;
    const delay = Math.max(0, Math.floor(Number(delayMs) || 0));
    p.nextRunAt = new Date(Date.now() + delay).toISOString();
    p.updatedAt = new Date().toISOString();
    this._save();
    return p.nextRunAt;
  }

  /**
   * 目标型：已完成记录有界保留 —— 只清「按完成收尾」的最早若干条。
   *
   * 为什么必须清：一张收尾卡最多带 20 条检查事实（每条尾巴可达数 KB），
   * 而卡片一旦收尾就永远停在「已停用」里 —— 不设上限，plans.json 会无界增长。
   * 为什么只清 `complete`：`blocked` 是「夜里卡住了、还没人看」，删掉等于把问题藏起来；
   * 未收尾（outcome=null）与仍在启用的也一律不碰。
   *
   * @param {number} [keep] 保留条数（默认 agent-limits.goalCompletedKeep）
   * @returns {string[]} 被清掉的计划 id（供调用方记日志）
   */
  pruneFinishedGoals(keep) {
    const raw = Number(keep);
    const cap = Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : AGENT_LIMITS_DEFAULTS.goalCompletedKeep;
    const done = this.plans.filter(
      (p) => p && p.trigger === 'goal' && p.outcome === 'complete' && p.enabled === false
    );
    if (done.length <= cap) return [];
    // updatedAt 在 setOutcome 里刷新，等价于「收尾时刻」：升序排，清最早的
    done.sort((a, b) => String(a.updatedAt || '').localeCompare(String(b.updatedAt || '')));
    const dropIds = done.slice(0, done.length - cap).map((p) => p.id);
    const drop = new Set(dropIds);
    this.plans = this.plans.filter((p) => !drop.has(p.id));
    this._save();
    return dropIds;
  }

  /** 目标型：清空运行态（用户重新启用 / 从零开始时用），保留 goal/budget 配置 */
  clearGoalRuntime(id) {
    const p = this.plans.find((x) => x.id === id);
    if (!p) return null;
    p.attempt = 0;
    p.attemptStartedAt = null;
    p.nextRunAt = null;
    p.outcome = null;
    p.evidence = [];
    p.claims = [];
    p.updatedAt = new Date().toISOString();
    this._save();
    return { ...p };
  }

  /**
   * 运行边界开始：本次触发的用户轮次已写入会话后调用。
   *
   * 必须在用户轮次落库之后落盘 —— 这之后无论进程怎么死，
   * 下次启动都能从这条标记知道「哪条用户轮次还没有回复」。
   *
   * @returns {object|null} 写入的 runState
   */
  beginRun(id, info) {
    const p = this.plans.find((x) => x.id === id);
    if (!p) return null;
    p.runState = normalizeRunState({ ...info, startedAt: new Date().toISOString() });
    this._save();
    return p.runState;
  }

  /** 运行边界结束：assistant 轮次已落库（或已确认无法落库）后调用 */
  endRun(id) {
    const p = this.plans.find((x) => x.id === id);
    if (!p || !p.runState) return false;
    p.runState = null;
    this._save();
    return true;
  }

  /** 上次进程退出时仍在运行的计划，供启动恢复补写中断回执 */
  listRunning() {
    return this.plans
      .filter((p) => p && p.runState)
      .map((p) => ({ plan: { ...p }, runState: { ...p.runState } }));
  }
}

module.exports = { PlansStore, normalizePlan, newId };
