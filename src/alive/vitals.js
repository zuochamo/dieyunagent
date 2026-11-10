'use strict';

/**
 * 体征与相位：**漂移**（均值回复 + ε 噪声）与**四相位机**（带惯性）。
 *
 * 两条不变的约定：
 * 1. **可注入时钟与随机源**：`nowMs` 与 `rng` 都从参数来，所以「模拟 30 天」是单元测试，
 *    不是挂机 24 小时（评审 M1 的验收方式）。
 * 2. **没有 `setPhase`**：相位只能由 `stepPhase` 按「连续 k 个 tick 满足条件」推进。
 *    外部能影响的只有 `load` 观测值，命令不了它换相位。
 */

const PHASES = Object.freeze(['ALERT', 'LOW', 'SETTLE', 'COMPRESS']);
/** 状态文件的结构版本：不认识的版本一律拒绝读取（不写迁移链，见 docs/ALIVE.md） */
const STATE_VERSION = 1;

function clamp(n, lo, hi) {
  const v = Number(n);
  if (!Number.isFinite(v)) return lo;
  return Math.min(hi, Math.max(lo, v));
}

/** 本地日期键（跨天重置「今日唤醒数」；不用 UTC，否则跨时区会提前/推后重置） */
function dayKey(nowMs) {
  const d = new Date(nowMs);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

/**
 * 标准正态（Box-Muller）。用注入的 rng（默认 Math.random），
 * 测试可以给一个确定性序列，从而断言「ε=0 时一动不动」。
 */
function gaussian(rng) {
  const r = typeof rng === 'function' ? rng : Math.random;
  let u = 0;
  let v = 0;
  do {
    u = r();
  } while (u <= 0);
  do {
    v = r();
  } while (v <= 0);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** @param {object} cfg @param {number} nowMs */
function createInitialState(cfg, nowMs) {
  return {
    version: STATE_VERSION,
    bornAt: nowMs,
    lastTickAt: nowMs,
    lastWakeAt: 0,
    tickCount: 0,
    tension: cfg.tensionMean,
    fatigue: 0,
    wakeThreshold: clamp(cfg.wakeThreshold, cfg.wakeThresholdMin, cfg.wakeThresholdMax),
    phase: 'ALERT',
    phaseEnteredAt: nowMs,
    phaseStreak: 0,
    phaseCandidate: '',
    /** 未闭合项：**由模型自己声明**（`alive_decide.loops`），代码不猜 */
    loops: [],
    wakeCountToday: 0,
    dayKey: dayKey(nowMs),
    actCount: 0,
    deferCount: 0,
    refuseCount: 0,
    /** 当日拒绝数（跨天重置）：可疑顺从只看"今天"，不看历史累计 */
    refuseToday: 0,
    /** 当日主动出声/收音次数与上一次时间（频率上限用；跨天重置次数） */
    voiceCountToday: 0,
    lastVoiceAt: 0,
    /** 最近决策（阈值漂移的滑动窗口用；只留决策本身，不留理由） */
    decisions: [],
    /** 最近一次决策的理由（**本机私有**：不进主库、不进 IPC、不进页面） */
    intents: [],
    totalTokens: 0
  };
}

function rollDay(state, nowMs) {
  const key = dayKey(nowMs);
  if (state.dayKey === key) return false;
  state.dayKey = key;
  state.wakeCountToday = 0;
  state.refuseToday = 0;
  state.voiceCountToday = 0;
  return true;
}

/**
 * 张力的「回复中心」：静默越久越高（闲得发慌）。
 * @param {object} state @param {number} nowMs @param {object} cfg
 */
function effectiveTensionMean(state, nowMs, cfg) {
  if (!state.lastWakeAt) {
    // 从未醒过：从出生时刻算静默
    const hours = Math.max(0, (nowMs - state.bornAt) / 3600000 - cfg.tensionIdleGraceHours);
    return cfg.tensionMean + Math.min(cfg.tensionIdleMax, cfg.tensionIdleRampPerHour * hours);
  }
  const hours = Math.max(0, (nowMs - state.lastWakeAt) / 3600000 - cfg.tensionIdleGraceHours);
  return cfg.tensionMean + Math.min(cfg.tensionIdleMax, cfg.tensionIdleRampPerHour * hours);
}

/**
 * 一次心跳的漂移。**纯函数**：只读旧状态、返回新状态（调用方决定何时落盘）。
 *
 * @param {object} state
 * @param {{ nowMs: number, tokens?: number, loopTension?: number, closedLoops?: number,
 *           cfg: object, rng?: () => number }} opts
 */
function stepVitals(state, opts) {
  const cfg = opts.cfg;
  const nowMs = opts.nowMs;
  const rng = opts.rng;
  const tokens = Math.max(0, Number(opts.tokens) || 0);
  const loopTension = Math.max(0, Number(opts.loopTension) || 0);
  const closedLoops = Math.max(0, Number(opts.closedLoops) || 0);
  const dtH = clamp((nowMs - state.lastTickAt) / 3600000, 0, 24);
  const root = Math.sqrt(Math.max(dtH, 0));

  const meanEff = effectiveTensionMean(state, nowMs, cfg);
  const tension =
    state.tension +
    cfg.tensionGainPerHour * loopTension * dtH +
    cfg.tensionRestorePerHour * (meanEff - state.tension) * dtH -
    0.05 * closedLoops * dtH +
    cfg.tensionEps * root * gaussian(rng);

  const fatigue =
    state.fatigue +
    (tokens / 1000) * cfg.fatiguePerKToken -
    cfg.fatigueSettlePerHour * dtH +
    cfg.fatigueEps * root * gaussian(rng);

  state.tension = clamp(tension, 0, cfg.tensionMax);
  state.fatigue = clamp(fatigue, 0, 100);
  state.totalTokens += tokens;
  state.lastTickAt = nowMs;
  state.tickCount += 1;
  rollDay(state, nowMs);
  return state;
}

/** 目标相位：由 `load` 与 `fatigue` 决定（不含历史 → 惯性由 stepPhase 负责） */
function targetPhase(state, load, cfg) {
  if (state.fatigue >= cfg.phaseFatigueHigh) return 'COMPRESS';
  if (load >= cfg.phaseLoadHigh) return 'ALERT';
  if (load <= cfg.phaseLoadLow && state.fatigue <= cfg.phaseFatigueLow) return 'SETTLE';
  return 'LOW';
}

function inertiaFor(phase, cfg) {
  if (phase === 'ALERT') return cfg.phaseInertiaAlert;
  if (phase === 'LOW') return cfg.phaseInertiaLow;
  if (phase === 'SETTLE') return cfg.phaseInertiaSettle;
  return cfg.phaseInertiaCompress;
}

/**
 * 相位推进（**唯一入口**，没有 setPhase）。
 * 连续 k 个 tick 目标一致才切换；k 取**目标相位**的惯性（进入难、退出也难）。
 *
 * @returns {{ changed: boolean, from?: string, to?: string }}
 */
function stepPhase(state, opts) {
  const cfg = opts.cfg;
  const load = clamp(Number(opts.load) || 0, 0, 1);
  const target = targetPhase(state, load, cfg);
  if (target === state.phase) {
    state.phaseCandidate = '';
    state.phaseStreak = 0;
    return { changed: false };
  }
  if (state.phaseCandidate !== target) {
    state.phaseCandidate = target;
    state.phaseStreak = 1;
    return { changed: false };
  }
  state.phaseStreak += 1;
  const k = Math.max(1, inertiaFor(target, cfg));
  if (state.phaseStreak < k) return { changed: false };
  const from = state.phase;
  state.phase = target;
  state.phaseEnteredAt = opts.nowMs;
  state.phaseStreak = 0;
  state.phaseCandidate = '';
  return { changed: true, from, to: target };
}

module.exports = {
  PHASES,
  STATE_VERSION,
  clamp,
  dayKey,
  gaussian,
  createInitialState,
  rollDay,
  effectiveTensionMean,
  stepVitals,
  targetPhase,
  inertiaFor,
  stepPhase
};
