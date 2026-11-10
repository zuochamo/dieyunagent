'use strict';

/**
 * 唤醒判定：**代码只决定「叫不叫它起来」，不决定「它醒来做什么」。**
 *
 * 这一层必须保持贫瘠：任何「按任务类型/关键词判断该不该动」的智能都属于张力引擎与模型，
 * 不属于这里。这里只有四个机械条件，缺一条就不醒：
 *   张力 ≥ 阈值 · 不在压缩相位 · 距上次唤醒够久 · 今日次数没超
 */
const { clamp } = require('./vitals');

/**
 * @param {{ state: object, cfg: object, nowMs: number }} opts
 * @returns {{ wake: boolean, reason: string }}
 */
function evaluate(opts) {
  const state = opts.state;
  const cfg = opts.cfg;
  const nowMs = opts.nowMs;
  if (!state) return { wake: false, reason: 'no-state' };
  if (state.tension < state.wakeThreshold) return { wake: false, reason: 'below-threshold' };
  // 「压缩」相位不打断：它是高疲劳（`fatigue ≥ phaseFatigueHigh`）触发的那一档，
  // 相当于累了就别再逼它动。**注意这不是昼夜节律** —— 相位只由 load 与 fatigue 决定，
  // 代码里没有任何"夜间"输入（以前这里写成"夜间重组"，与实现不符）。
  if (state.phase === 'COMPRESS') return { wake: false, reason: 'compressing' };
  const since = nowMs - Number(state.lastWakeAt || 0);
  if (state.lastWakeAt && since < cfg.wakeMinIntervalMs) {
    return { wake: false, reason: 'cooldown' };
  }
  if (Number(state.wakeCountToday || 0) >= cfg.wakeMaxPerDay) {
    return { wake: false, reason: 'daily-cap' };
  }
  return { wake: true, reason: 'tension' };
}

/** 唤醒记账（在真正跑一轮**之前**记，避免同一跳重复唤醒） */
function markWoken(state, nowMs) {
  state.lastWakeAt = nowMs;
  state.wakeCountToday = clamp(Number(state.wakeCountToday || 0) + 1, 0, 1000);
  return state;
}

module.exports = { evaluate, markWoken };
