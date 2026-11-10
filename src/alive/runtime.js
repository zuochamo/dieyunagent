'use strict';

/**
 * 生命感运行时：**一个心跳、一套体征、一份状态文件**。
 *
 * 它不做的事（与原 `--alive` 设计的差别，见 docs/ALIVE.md）：
 * 不占预算、不会死、不衰减记忆、不产遗物、不绑定 incarnation、不隔离记忆。
 * 它只做四件事：按 300s 跳动、漂移体征、推进相位、在张力越线时**问模型要不要动**。
 *
 * 宿主无关：桌面主进程与 headless 都调 `createAliveRuntime`，只换 `turnRunner`。
 */

const vitals = require('./vitals');
const tensionEngine = require('./tension');
const waker = require('./waker');
const decide = require('./decide');
const { createAliveStore } = require('./store');
const { onLlmUsage } = require('../agent/llm-usage-recorder');
const agentLimits = require('../agent/agent-limits');

const { clamp } = vitals;

function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * 从 `agent-limits` 取数并做一次结构性夹取。
 * 数字的唯一来源是 `agent-limits.js` 的 DEFAULTS（不进 SCHEMA：生命体征不是用户旋钮）；
 * 这里只保证「拿到的一定是能跑的值」——坏值不该让心跳直接崩。
 */
function resolveAliveConfig(limits) {
  const D = agentLimits.AGENT_LIMITS_DEFAULTS;
  const pick = (key) => (limits && limits[key] !== undefined ? limits[key] : D[key]);
  const cfg = {
    tickIntervalMs: clamp(num(pick('aliveTickIntervalMs'), D.aliveTickIntervalMs), 1000, 30 * 60 * 1000),
    wakeThreshold: num(pick('aliveWakeThreshold'), D.aliveWakeThreshold),
    wakeThresholdMin: num(pick('aliveWakeThresholdMin'), D.aliveWakeThresholdMin),
    wakeThresholdMax: num(pick('aliveWakeThresholdMax'), D.aliveWakeThresholdMax),
    wakeThresholdMuPerHour: num(pick('aliveWakeThresholdMuPerHour'), D.aliveWakeThresholdMuPerHour),
    wakeThresholdNuPerHour: num(pick('aliveWakeThresholdNuPerHour'), D.aliveWakeThresholdNuPerHour),
    wakeRefusalBaseline: num(pick('aliveWakeRefusalBaseline'), D.aliveWakeRefusalBaseline),
    refusalWindowMs: num(pick('aliveWakeRefusalWindowMs'), D.aliveWakeRefusalWindowMs),
    wakeMinIntervalMs: num(pick('aliveWakeMinIntervalMs'), D.aliveWakeMinIntervalMs),
    wakeMaxPerDay: Math.max(1, num(pick('aliveWakeMaxPerDay'), D.aliveWakeMaxPerDay)),
    tensionMean: num(pick('aliveTensionMean'), D.aliveTensionMean),
    tensionGainPerHour: num(pick('aliveTensionGainPerHour'), D.aliveTensionGainPerHour),
    tensionRestorePerHour: num(pick('aliveTensionRestorePerHour'), D.aliveTensionRestorePerHour),
    tensionEps: Math.max(0, num(pick('aliveTensionEps'), D.aliveTensionEps)),
    tensionMax: num(pick('aliveTensionMax'), D.aliveTensionMax),
    tensionIdleRampPerHour: num(pick('aliveTensionIdleRampPerHour'), D.aliveTensionIdleRampPerHour),
    tensionIdleGraceHours: num(pick('aliveTensionIdleGraceHours'), D.aliveTensionIdleGraceHours),
    tensionIdleMax: num(pick('aliveTensionIdleMax'), D.aliveTensionIdleMax),
    loopTensionUnit: num(pick('aliveLoopTensionUnit'), D.aliveLoopTensionUnit),
    loopMax: Math.max(1, num(pick('aliveLoopMax'), D.aliveLoopMax)),
    loopStaleHours: Math.max(1, num(pick('aliveLoopStaleHours'), D.aliveLoopStaleHours)),
    fatiguePerKToken: num(pick('aliveFatiguePerKToken'), D.aliveFatiguePerKToken),
    fatigueSettlePerHour: num(pick('aliveFatigueSettlePerHour'), D.aliveFatigueSettlePerHour),
    fatigueEps: Math.max(0, num(pick('aliveFatigueEps'), D.aliveFatigueEps)),
    voiceMaxPerDay: Math.max(0, num(pick('aliveVoiceMaxPerDay'), D.aliveVoiceMaxPerDay)),
    voiceMinIntervalMs: Math.max(0, num(pick('aliveVoiceMinIntervalMs'), D.aliveVoiceMinIntervalMs)),
    phaseInertiaAlert: Math.max(1, num(pick('alivePhaseInertiaAlert'), D.alivePhaseInertiaAlert)),
    phaseInertiaLow: Math.max(1, num(pick('alivePhaseInertiaLow'), D.alivePhaseInertiaLow)),
    phaseInertiaSettle: Math.max(1, num(pick('alivePhaseInertiaSettle'), D.alivePhaseInertiaSettle)),
    phaseInertiaCompress: Math.max(1, num(pick('alivePhaseInertiaCompress'), D.alivePhaseInertiaCompress)),
    phaseLoadWindowMs: Math.max(1000, num(pick('alivePhaseLoadWindowMs'), D.alivePhaseLoadWindowMs)),
    phaseLoadHigh: num(pick('alivePhaseLoadHigh'), D.alivePhaseLoadHigh),
    phaseLoadLow: num(pick('alivePhaseLoadLow'), D.alivePhaseLoadLow),
    phaseFatigueHigh: num(pick('alivePhaseFatigueHigh'), D.alivePhaseFatigueHigh),
    phaseFatigueLow: num(pick('alivePhaseFatigueLow'), D.alivePhaseFatigueLow),
    loadTokensHigh: Math.max(1, num(pick('alivePhaseLoadTokensHigh'), D.alivePhaseLoadTokensHigh)),
    historyMax: Math.max(20, num(pick('aliveHistoryMax'), D.aliveHistoryMax)),
    readOnlyWake: pick('aliveReadOnlyWake') !== false
  };
  cfg.wakeThreshold = clamp(cfg.wakeThreshold, cfg.wakeThresholdMin, cfg.wakeThresholdMax);
  return cfg;
}

/** usage → token 数（形状归一还在 `llm-usage-stats`，这里只兜住缺字段） */
function usageTokens(usage) {
  if (!usage || typeof usage !== 'object') return 0;
  const total = Number(usage.total_tokens != null ? usage.total_tokens : usage.totalTokens);
  if (Number.isFinite(total) && total > 0) return total;
  const prompt = Number(usage.prompt_tokens != null ? usage.prompt_tokens : usage.input_tokens) || 0;
  const completion =
    Number(usage.completion_tokens != null ? usage.completion_tokens : usage.output_tokens) || 0;
  return Math.max(0, prompt) + Math.max(0, completion);
}

/**
 * @param {{ userDataPath: string, limits?: object, log?: any,
 *           now?: () => number, rng?: () => number,
 *           turnRunner?: ((ctx: object) => Promise<any>)|null }} opts
 */
function createAliveRuntime(opts) {
  const d = opts || {};
  const store = createAliveStore(d.userDataPath);
  const cfg = resolveAliveConfig(d.limits);
  const log = d.log || (() => {});
  const now = typeof d.now === 'function' ? d.now : () => Date.now();
  const rng = typeof d.rng === 'function' ? d.rng : Math.random;

  /** @type {object|null} */
  let state = null;
  let timer = null;
  let ticking = false;
  let wakeInFlight = false;
  let unsubscribe = null;
  let pendingTokens = 0;
  /**
   * 停机代次：stop()/reset() 各 +1。
   *
   * 为什么需要它：唤醒轮是一次**几分钟的异步调用**，而「关开关」是同步动作。
   * 没有这个令牌时，关掉开关（或点「重新开始」清空）之后，那一轮回来后仍会 `store.write(state)`，
   * 于是：关掉的开关又写回一份状态、清空的状态被旧值复活。
   */
  let generation = 0;
  /** 当前唤醒轮的中止开关：关总开关 / 重新开始时直接中止那一轮（不再烧 token） */
  /** @type {AbortController|null} */
  let wakeAbort = null;
  /** @type {Array<{ ts: number, tokens: number }>} */
  let samples = [];
  const turnRunner = typeof d.turnRunner === 'function' ? d.turnRunner : null;
  /** 感官开关的取值入口（由宿主提供；缺省 = 全关，宁可不给能力） */
  const getSenses =
    typeof d.getSenses === 'function'
      ? d.getSenses
      : () => ({ drawer: false, eyes: false, voice: false });

  function pushEvent(evt) {
    store.appendEvent(Object.assign({ ts: now() }, evt));
  }

  function loadState() {
    const raw = store.read();
    if (!raw) return null;
    if (Number(raw.version) !== vitals.STATE_VERSION) {
      const err = new Error(
        `生命状态版本不认识（文件 v${raw.version}，本程序 v${vitals.STATE_VERSION}）：不迁移、不猜`
      );
      err.code = 'ALIVE_STATE_VERSION';
      throw err;
    }
    return raw;
  }

  function ensureState() {
    if (state) return state;
    const loaded = loadState();
    const nowMs = now();
    if (loaded) {
      // 停机期间时间仍在走：让第一次漂移按真实间隔结算（上限 24h，避免一次睡一周就跳满）
      state = loaded;
    } else {
      state = vitals.createInitialState(cfg, nowMs);
      store.write(state);
      pushEvent({ kind: 'BIRTH', phase: state.phase, threshold: state.wakeThreshold });
      log(`[alive] 出生：${store.stateFile}`);
    }
    return state;
  }

  function computeLoad(nowMs) {
    const from = nowMs - cfg.phaseLoadWindowMs;
    while (samples.length && samples[0].ts < from) samples.shift();
    const tokens = samples.reduce((n, s) => n + s.tokens, 0);
    return clamp(tokens / cfg.loadTokensHigh, 0, 1);
  }

  async function runWakeTurn() {
    if (typeof turnRunner !== 'function') {
      pushEvent({ kind: 'WAKE_SKIPPED', reason: 'no-turn-runner' });
      return;
    }
    if (wakeInFlight) {
      pushEvent({ kind: 'WAKE_SKIPPED', reason: 'already-running' });
      return;
    }
    wakeInFlight = true;
    const gen = generation;
    wakeAbort = new AbortController();
    const nowMs = now();
    let senses = { drawer: false, eyes: false, voice: false };
    try {
      senses = getSenses() || senses;
    } catch {
      // 读不到能力就当没有
    }
    const stateBlock = decide.renderStateBlock(state, cfg, { nowMs, senses });
    const before = Number(state.tickCount || 0);
    try {
      await turnRunner({ stateBlock, state, cfg, senses, signal: wakeAbort.signal });
    } catch (err) {
      pushEvent({
        kind: 'WAKE_ERROR',
        message: String((err && err.message) || err).slice(0, 300)
      });
      log(`[alive] 唤醒轮失败：${(err && err.message) || err}`);
    } finally {
      wakeInFlight = false;
      wakeAbort = null;
      // 期间被关掉/清空过：这一轮的结果作废，不写盘、不记事件（否则会把停表或清空覆盖掉）
      if (gen !== generation) return;
      state.lastWakeFinishedAt = now();
      state.lastWakeTick = before;
      pushEvent({
        kind: 'WAKE_END',
        phase: state.phase,
        tension: Number(Number(state.tension).toFixed(1))
      });
      store.write(state);
    }
  }

  /** 一次心跳（`tickOnce` 是测试/演示的入口，定时器只是它的调用者） */
  async function tickOnce() {
    if (ticking) return { skipped: 'busy' };
    ticking = true;
    try {
      const st = ensureState();
      const nowMs = now();
      const tokens = pendingTokens;
      pendingTokens = 0;
      const dtH = clamp((nowMs - Number(st.lastTickAt || nowMs)) / 3600000, 0, 24);
      const loopTension = tensionEngine.totalLoopTension(st.loops, nowMs, cfg);
      vitals.stepVitals(st, { nowMs, tokens, loopTension, cfg, rng });
      const pruned = tensionEngine.pruneLoops(st, { nowMs, cfg });
      tensionEngine.driftThreshold(st, { nowMs, dtH, cfg });
      tensionEngine.pruneDecisions(st, { nowMs, cfg });
      const load = computeLoad(nowMs);
      const phaseRes = vitals.stepPhase(st, { nowMs, load, cfg });
      if (phaseRes.changed) {
        pushEvent({ kind: 'PHASE', from: phaseRes.from, to: phaseRes.to, load: Number(load.toFixed(2)) });
      }
      const decision = waker.evaluate({ state: st, cfg, nowMs });
      if (decision.wake) {
        waker.markWoken(st, nowMs);
        pushEvent({
          kind: 'WAKE',
          trigger: 'internal',
          tension: Number(Number(st.tension).toFixed(1)),
          threshold: Number(Number(st.wakeThreshold).toFixed(1)),
          phase: st.phase
        });
        store.write(st);
        // 唤醒轮内部会再次写盘；先落一次「已唤醒」再跑，避免异常时丢掉这次唤醒
        await runWakeTurn();
      } else {
        store.write(st);
      }
      return {
        skipped: null,
        wake: decision.wake,
        reason: decision.reason,
        pruned,
        phase: st.phase,
        tension: st.tension,
        fatigue: st.fatigue,
        threshold: st.wakeThreshold
      };
    } finally {
      ticking = false;
    }
  }

  function start() {
    if (timer) return false;
    ensureState();
    if (!unsubscribe) {
      unsubscribe = onLlmUsage((usage) => {
        const tokens = usageTokens(usage);
        if (tokens <= 0) return;
        // 负载（相位用）看的是「这台机器现在忙不忙」：用户聊天也算忙 → 全局旁听。
        samples.push({ ts: now(), tokens });
        const from = now() - cfg.phaseLoadWindowMs;
        samples = samples.filter((s) => s.ts >= from);
        // 疲劳（它自己累不累）**只数唤醒轮用掉的 token**。
        // 用户在主对话里烧的 token 不是它的账 —— 否则「疲劳」测的是「你有没有在聊天」，
        // 一次长对话就能把它钉在 100 并长期压进 COMPRESS 相位（见 issue/2026-11-10）。
        if (!wakeInFlight) return;
        pendingTokens += tokens;
      });
    }
    timer = setInterval(() => {
      tickOnce().catch((err) => log(`[alive] tick 失败：${(err && err.message) || err}`));
    }, cfg.tickIntervalMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
    log(`[alive] 心跳已启动（${Math.round(cfg.tickIntervalMs / 1000)}s）`);
    return true;
  }

  function stop() {
    generation += 1;
    // 中止在跑的那一轮：关开关之后不该继续烧 token、也不该继续写会话
    if (wakeAbort) {
      try {
        wakeAbort.abort();
      } catch {
        // ignore
      }
      wakeAbort = null;
    }
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    if (unsubscribe) {
      try {
        unsubscribe();
      } catch {
        // ignore
      }
      unsubscribe = null;
    }
    // 停机也落一次：否则「上次 tick」永远停在上一个心跳，重开会结算一大段时间
    if (state) {
      try {
        store.write(state);
      } catch {
        // ignore
      }
    }
    return true;
  }

  /**
   * 记一条事件。**事件流的唯一出口**：感官（说/听/看）这类由调用方测得的事实，
   * 也必须从这里落盘，而不是各自 `store.appendEvent`（否则口径会分叉）。
   */
  function recordEvent(evt) {
    if (!evt || !evt.kind) return false;
    pushEvent(evt);
    return true;
  }

  /** 主动出声/收音的记账（**成功之后**才调；跨天重置由 tick 的 `rollDay` 负责） */
  function noteVoice(atMs) {
    if (!state) return false;
    state.voiceCountToday = Number(state.voiceCountToday || 0) + 1;
    state.lastVoiceAt = Number.isFinite(Number(atMs)) ? Number(atMs) : now();
    try {
      store.write(state);
    } catch {
      // 记不上只影响频率上限的精度，不影响这一轮已经发生的事
    }
    return true;
  }

  /** 模型通过 `alive_decide` 工具落到这里（唯一写决策的入口） */
  function applyDecision(args) {
    if (!state) {
      try {
        ensureState();
      } catch (err) {
        return { ok: false, error: (err && err.message) || '生命状态不可读' };
      }
    }
    const res = decide.applyDecision(state, args, { cfg, nowMs: now() });
    if (res.ok) {
      pushEvent({
        kind: 'DECISION',
        decision: res.decision,
        loopId: args && args.loopId ? String(args.loopId) : null,
        closed: !!res.closedLoop
      });
      store.write(state);
    }
    return res;
  }

  function status() {
    let st = state;
    if (!st) {
      if (!store.exists()) return { enabled: false, running: false, exists: false };
      try {
        st = loadState();
      } catch (err) {
        // 坏版本 / 坏文件不该让整页崩：如实报一行原因，页面显示「不可读」
        return {
          enabled: true,
          running: !!timer,
          exists: true,
          unreadable: (err && err.message) || String(err)
        };
      }
    }
    if (!st) return { enabled: false, running: false, exists: false };
    return {
      enabled: true,
      running: !!timer,
      exists: true,
      bornAt: st.bornAt,
      lastTickAt: st.lastTickAt,
      lastWakeAt: st.lastWakeAt,
      tickCount: st.tickCount,
      phase: st.phase,
      phaseEnteredAt: st.phaseEnteredAt,
      tension: st.tension,
      wakeThreshold: st.wakeThreshold,
      fatigue: st.fatigue,
      /** 疲劳的解释线：到这里就进压缩相位（页面据此给出可读解释，而不是两个矛盾的数字） */
      fatigueHigh: cfg.phaseFatigueHigh,
      /** 静息回落速度（每小时）：解释"为什么等一会儿就能再醒" */
      fatigueSettlePerHour: cfg.fatigueSettlePerHour,
      /** 主动出声/收音：当日次数、上次时间与上限（页面对账用） */
      voiceCountToday: Number(st.voiceCountToday || 0),
      lastVoiceAt: Number(st.lastVoiceAt || 0),
      voiceMaxPerDay: cfg.voiceMaxPerDay,
      loops: (st.loops || []).length,
      wakeCountToday: st.wakeCountToday,
      wakeMaxPerDay: cfg.wakeMaxPerDay,
      actCount: st.actCount,
      deferCount: st.deferCount,
      refuseCount: st.refuseCount,
      /** 当日拒绝数（跨天重置）：`suspiciousObedience` 只该看今天，不看历史累计 */
      refuseToday: st.refuseToday,
      tickIntervalMs: cfg.tickIntervalMs,
      totalTokens: st.totalTokens,
      suspiciousObedience: decide.suspiciousObedience(st, cfg)
    };
  }

  function decisions(limit) {
    return store.readEvents(limit || 30);
  }

  /** 彻底重置（设置页「清除体征状态」：等同让它重新出生，历史事件一并清空） */
  function reset() {
    stop();
    store.clear();
    state = null;
    pendingTokens = 0;
    samples = [];
    return true;
  }

  function setTurnRunner(fn) {
    turnRunner = typeof fn === 'function' ? fn : null;
    return true;
  }

  function senses() {
    try {
      return getSenses() || { drawer: false, eyes: false, voice: false };
    } catch {
      return { drawer: false, eyes: false, voice: false };
    }
  }

  return {
    cfg,
    store,
    start,
    stop,
    reset,
    tickOnce,
    applyDecision,
    recordEvent,
    noteVoice,
    setTurnRunner,
    senses,
    status,
    decisions,
    getState: () => state,
    getTickIntervalMs: () => cfg.tickIntervalMs,
    isRunning: () => !!timer
  };
}

module.exports = {
  createAliveRuntime,
  resolveAliveConfig,
  usageTokens
};
