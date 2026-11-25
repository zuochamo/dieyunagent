'use strict';

/**
 * 记忆归纳（knowledge maintenance）—— **Main / Node 侧唯一实现**。
 *
 * 曾经的实现散在 Renderer 两处（`renderer-knowledge-maintainer.js` 的 unified 版 +
 * `renderer-agent-llm.js` 的 legacy 版），带来三个问题：
 *   1. 长期 Agent 状态机（定时器 / 队列 / 冷却 / 重试）写在 Renderer，窗口一关就停摆；
 *   2. 同一职责两份 prompt、两份 project/global 判定，靠 `typeof X === 'function'` 选路；
 *   3. 门闩是「文本长度 >= 8 或 有任何工具轨迹」，几乎恒真，等于每个成功轮次一次小模型调用。
 *
 * 现在**触发与执行都在本模块**（Renderer 只剩设置页 UI）。Main 的三个运行入口跑完各调一次
 * `afterAgentRun({ result, opts })`：
 *   1. `agent:run`（对话，`src/main/ipc/agent-runtime.js`）；
 *   2. `agent:planner-run`（计划模式，planner 管线结果）；
 *   3. `runPlanAgentLoop`（定时计划 / 目标任务，`src/plans/plan-agent-runner.js`）。
 * 事实（trace / plan / review / 正文）本来就在 Main —— 于是手机端、定时计划、计划模式
 * 也会沉淀（以前只有 Renderer 收尾路径会归纳，这些轮次永远不沉淀）。
 *
 * 计划 worktree 的「应用后才归纳」也在本模块暂存（`pending` + `knowledgePlanApplyWaitMs`）：
 * Renderer 只在用户采纳/放弃时回一句结论（`resolvePending`），不再把上下文和兜底定时器
 * 放在窗口里 —— 窗口关掉、切会话都不会丢。
 *
 * 分层约定（AGENTS.md）：
 *   - 记忆数据真相源仍是 Rust `memory.*` RPC，本模块只经 Gateway `invokeRpc` 读写；
 *   - 项目记忆只能进 `.dieyun/memory.md`（`project-memory-file.js` 唯一实现），不往库里塞 scope 文本；
 *   - LLM 端点与请求头一律走 `llm-request.js`，这里不拼 URL、不写 Authorization；
 *   - 数字上限一律走 `agent-limits.js`（`knowledge*` 一组），本文件不存字面量；
 *   - 「哪些工具算写文件」用 `guardrails-shared.js` 的 `FILE_WRITE_TOOL_NAMES`，不写第二份正则。
 *
 * 文件布局（2026-11-21 第 4 批按依赖顺序切了七刀，逻辑未改）：
 *   `knowledge/settings.js`（设置落盘）→ `signals.js`（信号与门闩）→ `prompt.js`（提示词）
 *   → `apply.js`（落库 + 项目记忆文件）→ `llm.js`（LLM 调用）→ `shared-memory.js`（跨机提炼）
 *   → `run.js`（两条运行路径）。本文件只剩调度器、入口与再导出。
 */

const { getAgentLimits } = require('./agent-limits');

// 设置（落盘 / 归一 / 档位常量）住在 `knowledge/settings.js`：第 4 批第一刀搬出，
// 这里继续再导出，调用方（设置页 / 归纳器自己）看到的入口不变。
const {
  KNOWLEDGE_SETTINGS_FILE,
  KNOWLEDGE_INTERVAL_CHOICES,
  KNOWLEDGE_MODES,
  normalizeKnowledgeSettings,
  readKnowledgeSettings,
  writeKnowledgeSettings
} = require('./knowledge/settings');

// 提示词与写入规则住在 `knowledge/prompt.js`：第 4 批第三刀搬出（逻辑未改）。
const { buildKnowledgeSystemPrompt, agentsPressureNote } = require('./knowledge/prompt');

// 信号与门闩住在 `knowledge/signals.js`：第 4 批第二刀搬出。
const {
  collectKnowledgeSignals,
  shouldRunKnowledgeMaintenance,
  normalizeMemoryScope,
  parseKnowledgeJson
} = require('./knowledge/signals');

// 落库住在 `knowledge/apply.js`：第 4 批第四刀搬出（逻辑未改）。
// 本文件只用到 `mirrorShareable`（调度器里按需触发跨机镜像）；其余在 run.js 内部使用。
const { mirrorShareable } = require('./knowledge/apply');

// 共享记忆提炼住在 `knowledge/shared-memory.js`：第 4 批第六刀搬出（逻辑未改）。
const { runSharedMemoryConsolidation } = require('./knowledge/shared-memory');

// 两条运行路径（一轮收尾 / 定时完整归纳）住在 `knowledge/run.js`：第 4 批第七刀搬出（逻辑未改）。
// `finishJob` 由 run.js 内部使用，不再从本文件透出。
const {
  runTaskMaintenance,
  runPeriodicMaintenance,
  buildRunFacts
} = require('./knowledge/run');

// ---------------------------------------------------------------------------
// 调度器（Main 侧唯一定时器；队列与冷却都用 agent-limits 的数字）
// ---------------------------------------------------------------------------

/**
 * @param {{
 *   getGateway: () => any,
 *   getUserDataPath: () => string,
 *   getAgentBusy: () => boolean,
 *   notify?: (event: string, payload?: object) => void
 * }} deps
 */
function createKnowledgeMaintainer(deps) {
  const state = {
    queue: [],
    running: false,
    lastRunAt: 0,
    pumpTimer: null,
    intervalTimer: null,
    kickTimer: null,
    idleTimer: null,
    workspacePath: ''
  };

  /** @type {Map<string, {facts: object, timer: any}>} 计划 worktree 待应用期间的暂存（按会话） */
  const pending = new Map();

  const invokeRpc = async (method, params) => {
    const gateway = deps.getGateway();
    if (!gateway || typeof gateway.invokeRpc !== 'function') {
      throw new Error('Gateway 未就绪');
    }
    return gateway.invokeRpc(method, params);
  };

  const ctx = {
    get gateway() {
      return deps.getGateway();
    },
    get userData() {
      return deps.getUserDataPath();
    },
    get workspacePath() {
      return state.workspacePath;
    },
    sessionId: '',
    invokeRpc,
    /** 测试注入点：默认走 core 的 llm.complete */
    fetchChatCompletion: typeof deps.fetchChatCompletion === 'function' ? deps.fetchChatCompletion : null,
    limits: () => getAgentLimits(deps.getUserDataPath()),
    readAgentsMdPrefs: () => require('./agents-md-prefs').readAgentsMdPrefs(deps.getUserDataPath()),
    getSettings: () => readKnowledgeSettings(deps.getUserDataPath()),
    updateSettings: (patch) => {
      const next = writeKnowledgeSettings(deps.getUserDataPath(), patch);
      notify('agent:knowledge-maintenance-status', next);
      return next;
    },
    isAgentBusy: () => {
      try {
        return typeof deps.getAgentBusy === 'function' ? !!deps.getAgentBusy() : false;
      } catch {
        return false;
      }
    },
    /** 共享记忆（跨机）实例；未装配（headless / 扩展关闭）时为 null —— 调用方据此跳过 */
    get sharedMemory() {
      try {
        return typeof deps.getSharedMemory === 'function' ? deps.getSharedMemory() : null;
      } catch {
        return null;
      }
    }
  };

  function notify(event, payload) {
    try {
      if (typeof deps.notify === 'function') deps.notify(event, payload);
    } catch {
      // 通知失败不影响归纳本身
    }
  }

  function pump() {
    if (state.running || !state.queue.length) return;
    const limits = ctx.limits();
    const waitMs = (Number(limits.knowledgeMaintenanceCooldownMs) || 50000) - (Date.now() - state.lastRunAt);
    if (waitMs > 0) {
      if (state.pumpTimer) clearTimeout(state.pumpTimer);
      state.pumpTimer = setTimeout(() => {
        state.pumpTimer = null;
        pump();
      }, Math.min(waitMs + 50, 60000));
      return;
    }
    const next = state.queue.shift();
    if (!next) return;
    state.running = true;
    ctx.sessionId = String(next.sessionId || '');
    state.workspacePath = String(next.workspacePath || '').trim();
    runTaskMaintenance(ctx, next)
      .then((res) => notify('agent:knowledge-maintenance-done', { ...res, sessionId: next.sessionId }))
      .catch((err) => console.warn('[dieyun:memory] knowledge maintenance', err && (err.message || err)))
      .finally(() => {
        state.running = false;
        state.lastRunAt = Date.now();
        state.workspacePath = '';
        pump();
      });
  }

  /**
   * 任务收尾触发（`afterRun` / 计划应用结果共用）。返回是否入队，不等 LLM。
   *
   * `mode=off` 是「关掉归纳」而不是「只关定时」：曾经 off 只管定时，逐轮归纳照样
   * 每轮打一次模型，设置页写着「关闭」却还在后台花钱。
   */
  function schedule(payload = {}) {
    if (ctx.getSettings().mode === 'off') return { ok: false, reason: 'disabled' };
    const limits = ctx.limits();
    const max = Number(limits.knowledgeMaintenanceQueueMax) || 8;
    if (state.queue.length >= max) {
      return { ok: false, reason: 'queue_full' };
    }
    const minDelay = Number(limits.knowledgeMaintenanceDelayMs) || 15000;
    const maxDelay = Number(limits.knowledgeMaintenanceDelayMaxMs) || 300000;
    const delayMs = Math.min(maxDelay, Math.max(1000, Number(payload.delayMs) || minDelay));
    state.queue.push({ ...payload, delayMs });
    if (state.pumpTimer) clearTimeout(state.pumpTimer);
    state.pumpTimer = setTimeout(() => {
      state.pumpTimer = null;
      pump();
    }, delayMs);
    return { ok: true, queued: state.queue.length };
  }

  /**
   * 计划 worktree 暂存：等用户采纳/放弃（`resolvePending`）。
   * 暂存在 Main，所以切会话、关窗口都不丢；超时按「验收通过但未应用」补一次。
   */
  function armPending(facts) {
    const sid = facts.sessionId;
    const prev = pending.get(sid);
    if (prev && prev.timer) clearTimeout(prev.timer);
    const waitMs = Number(ctx.limits().knowledgePlanApplyWaitMs) || 20 * 60 * 1000;
    const timer = setTimeout(() => {
      pending.delete(sid);
      if (facts.reviewAccepted) schedule({ ...facts, source: 'plan-completed' });
    }, waitMs);
    if (timer.unref) timer.unref();
    pending.set(sid, { facts, timer });
    return { ok: true, deferred: true };
  }

  /**
   * 计划 worktree 的应用结果。Renderer 只报结论，不带上下文。
   * @param {string} sessionId
   * @param {'applied'|'no_changes'|'skipped'} outcome
   * @param {{appliedPaths?: string[]}} extra
   */
  function resolvePending(sessionId, outcome, extra = {}) {
    const sid = String(sessionId || '').trim();
    const row = sid ? pending.get(sid) : null;
    if (!row) return { ok: false, reason: 'none' };
    pending.delete(sid);
    if (row.timer) clearTimeout(row.timer);
    if (outcome === 'applied') {
      return schedule({
        ...row.facts,
        source: 'plan-worktree-applied',
        appliedPaths: Array.isArray(extra.appliedPaths) ? extra.appliedPaths : []
      });
    }
    if (outcome === 'no_changes') {
      // 非 git 工作空间 / 纯读计划：验收通过但没有待合并项，按「计划完成」整理
      return schedule({ ...row.facts, source: 'plan-completed' });
    }
    // 用户放弃应用：plan 相关的产出不写进长期记忆
    return { ok: true, dropped: true };
  }

  /**
   * 一轮 Agent 运行结束（Main 侧三个 loop 调用点的统一入口）。
   * 事实装配 → 门闩 → 立即入队 / 计划 pending / 丢弃。
   */
  function afterRun(run = {}) {
    const facts = buildRunFacts(run);
    if (!facts) return { ok: false, reason: 'no_session' };
    if (ctx.getSettings().mode === 'off') return { ok: false, reason: 'disabled' };
    const limits = ctx.limits();
    const signals = collectKnowledgeSignals(facts, limits);
    if (!shouldRunKnowledgeMaintenance({ signals, limits })) {
      maybeRunIdlePeriodic();
      return { ok: false, reason: 'skip' };
    }
    if (facts.reason === 'task_not_completed') {
      // 验收没过、且没有交付物：不把半成品写进长期记忆
      maybeRunIdlePeriodic();
      return { ok: false, reason: 'not_completed' };
    }
    if (facts.isPlanRun && !facts.reviewAccepted) {
      maybeRunIdlePeriodic();
      return { ok: false, reason: 'plan_not_accepted' };
    }
    const res = facts.deferWorktree ? armPending(facts) : schedule(facts);
    maybeRunIdlePeriodic();
    return res;
  }

  /**
   * idle 模式的「忙完补跑」。
   *
   * 老实现撞上忙碌就直接返回，下次机会是 +intervalHours（6h 后）——整天在用 Agent 的用户
   * 等于永远不归纳。这里改成：每轮收尾时检查「已过间隔且现在不忙」，是就跑；
   * 仍在忙则排一次 5 分钟后的重试（只排一次，不叠兜底层）。
   */
  function maybeRunIdlePeriodic() {
    const settings = ctx.getSettings();
    if (settings.mode === 'off') return;
    const intervalMs = Math.max(1, Number(settings.intervalHours) || 6) * 60 * 60 * 1000;
    if (settings.lastRunAt && Date.now() - settings.lastRunAt < intervalMs) return;
    if (state.running || state.queue.length) return;
    if (ctx.isAgentBusy()) {
      scheduleIdleRetry();
      return;
    }
    runPeriodic({ reason: 'idle_after_run' }).catch(() => {});
  }

  function scheduleIdleRetry() {
    if (state.idleTimer) return;
    const waitMs = Number(ctx.limits().knowledgeIdleRetryMs) || 5 * 60 * 1000;
    state.idleTimer = setTimeout(() => {
      state.idleTimer = null;
      // 还忙就交给下一轮收尾去判：定时器只重排一次，避免多层兜底互相打架
      if (ctx.isAgentBusy()) return;
      maybeRunIdlePeriodic();
    }, waitMs);
    if (state.idleTimer.unref) state.idleTimer.unref();
  }

  /** 定时归纳（Main 定时器 / 设置页「立即运行」共用）。 */
  async function runPeriodic(opts = {}) {
    if (state.running) return { ok: false, reason: 'busy' };
    state.running = true;
    // 定时运行没有 composer 会话：项目记忆与 AGENTS.md 的语料只能来自「当前工作空间」。
    // 不注入这一步，定时归纳会退化成「只整理用户级记忆」。
    if (!state.workspacePath) {
      try {
        state.workspacePath = String(
          (typeof deps.getWorkspacePath === 'function' && deps.getWorkspacePath()) || ''
        ).trim();
      } catch {
        state.workspacePath = '';
      }
    }
    try {
      const res = await runPeriodicMaintenance(ctx, opts);
      notify('agent:knowledge-maintenance-done', res);
      return res;
    } finally {
      state.running = false;
      state.lastRunAt = Date.now();
      state.workspacePath = '';
    }
  }

  function stopSchedule() {
    for (const key of ['intervalTimer', 'kickTimer', 'pumpTimer', 'idleTimer']) {
      if (state[key]) clearTimeout(state[key]);
      state[key] = null;
    }
    for (const row of pending.values()) {
      if (row && row.timer) clearTimeout(row.timer);
    }
    pending.clear();
    state.queue.length = 0;
  }

  function startSchedule(opts = {}) {
    stopSchedule();
    const settings = ctx.getSettings();
    if (settings.mode === 'off') return settings;
    const intervalMs = Math.max(1, Number(settings.intervalHours) || 6) * 60 * 60 * 1000;
    state.intervalTimer = setInterval(() => {
      runPeriodic({ reason: 'periodic' }).catch(() => {});
    }, intervalMs);
    if (state.intervalTimer.unref) state.intervalTimer.unref();
    const due = !settings.lastRunAt || Date.now() - settings.lastRunAt >= intervalMs;
    if (due || opts.reschedule) {
      state.kickTimer = setTimeout(
        () => {
          state.kickTimer = null;
          runPeriodic({ reason: 'periodic' }).catch(() => {});
        },
        opts.immediate ? 2000 : 90 * 1000
      );
      if (state.kickTimer.unref) state.kickTimer.unref();
    }
    return settings;
  }

  return {
    schedule,
    afterRun,
    resolvePending,
    runPeriodic,
    startSchedule,
    stopSchedule,
    /** 设置页「立即提炼」：抢锁后整理一次共享记忆（抢不到就返回 locked_or_cooldown） */
    consolidateSharedMemory: (trigger) => runSharedMemoryConsolidation(ctx, trigger || 'manual'),
    getSettings: () => ctx.getSettings(),
    updateSettings: (patch) => {
      const next = ctx.updateSettings(patch || {});
      startSchedule({ reschedule: true });
      return next;
    }
  };
}

// ---------------------------------------------------------------------------
// Main 侧唯一实例注册（三个 loop 调用点共用一个入口）
// ---------------------------------------------------------------------------

let activeMaintainer = null;

/** 由 `main/ipc/agent-runtime.js` 在创建实例后注册；测试可传 null 注销。 */
function registerKnowledgeMaintainer(maintainer) {
  activeMaintainer = maintainer && typeof maintainer.afterRun === 'function' ? maintainer : null;
  return activeMaintainer;
}

/**
 * 当前生效的归纳器实例（可能为 null）。
 * 唯一用途：不经过 `agent-runtime` 闭包的调用方（如扩展页签的「立即提炼」IPC）拿同一个实例 ——
 * 再 `createKnowledgeMaintainer()` 一份就会有两套队列与定时器。
 */
function getActiveKnowledgeMaintainer() {
  return activeMaintainer;
}

/**
 * 一轮 Agent 运行结束的统一入口（对话 / 计划模式对话 / 定时计划 / 子代理）。
 *
 * 归纳不是主链路：没有实例（测试、sidecar 未就绪）时静默跳过，调用方不需要判空。
 * @param {{result?: object, opts?: object}} run
 */
function afterAgentRun(run = {}) {
  if (!activeMaintainer) return { ok: false, reason: 'no_maintainer' };
  try {
    return activeMaintainer.afterRun(run);
  } catch (err) {
    return { ok: false, reason: 'error', error: err && (err.message || String(err)) };
  }
}

/**
 * 计划 worktree 的应用结果（Renderer → IPC → 这里）。outcome: applied | skipped。
 */
function resolveKnowledgePlanOutcome(sessionId, outcome, extra = {}) {
  if (!activeMaintainer) return { ok: false, reason: 'no_maintainer' };
  try {
    return activeMaintainer.resolvePending(sessionId, outcome, extra);
  } catch (err) {
    return { ok: false, reason: 'error', error: err && (err.message || String(err)) };
  }
}

module.exports = {
  KNOWLEDGE_SETTINGS_FILE,
  KNOWLEDGE_INTERVAL_CHOICES,
  KNOWLEDGE_MODES,
  buildKnowledgeSystemPrompt,
  agentsPressureNote,
  collectKnowledgeSignals,
  shouldRunKnowledgeMaintenance,
  parseKnowledgeJson,
  normalizeMemoryScope,
  buildRunFacts,
  normalizeKnowledgeSettings,
  readKnowledgeSettings,
  writeKnowledgeSettings,
  runTaskMaintenance,
  runPeriodicMaintenance,
  runSharedMemoryConsolidation,
  mirrorShareable,
  createKnowledgeMaintainer,
  registerKnowledgeMaintainer,
  getActiveKnowledgeMaintainer,
  afterAgentRun,
  resolveKnowledgePlanOutcome
};
