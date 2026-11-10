'use strict';

/**
 * 张力引擎：**未闭合项**（open loop）的聚合，以及唤醒阈值 `W` 的漂移（性格 = 轨迹）。
 *
 * 关键取舍：未闭合项**由模型自己声明**（`alive_decide.loops`），代码不去猜
 * 「这轮算不算没做完」——那必然落到关键词匹配上（AGENTS 原则 3 明令禁止）。
 * 代码只做三件机械的事：加权求和、自然消退、上限裁剪。
 */

const { clamp } = require('./vitals');

const LOOP_TEXT_MAX = 160;

/** FNV-1a：给未闭合项一个可用文本复现的稳定 id（不引 crypto，避免无谓依赖） */
function stableId(text) {
  let h = 0x811c9dc5;
  const s = String(text || '');
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `loop-${h.toString(16).padStart(8, '0')}`;
}

function normalizeLoopText(text) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, LOOP_TEXT_MAX);
}

/** 一条未闭合项此刻的张力：权重 × 基准 × 自然消退（48h 时间常数，长久的会自己淡掉） */
function loopTension(loop, nowMs, cfg) {
  const hours = Math.max(0, (nowMs - Number(loop.updatedAt || nowMs)) / 3600000);
  const decay = Math.exp(-hours / Math.max(1, cfg.loopStaleHours));
  return Math.max(0, Number(loop.weight) || 1) * cfg.loopTensionUnit * decay;
}

function totalLoopTension(loops, nowMs, cfg) {
  let sum = 0;
  for (const loop of Array.isArray(loops) ? loops : []) sum += loopTension(loop, nowMs, cfg);
  return sum;
}

/**
 * 合并模型声明的未闭合项：同文本 → 续命（updatedAt/weight），新文本 → 新增。
 * 超过上限按「此刻张力最低」先丢（保留最扎手的那些）。
 *
 * @returns {{ added: number, refreshed: number, dropped: number }}
 */
function upsertLoops(state, declared, opts) {
  const cfg = opts.cfg;
  const nowMs = opts.nowMs;
  const list = Array.isArray(state.loops) ? state.loops : [];
  let added = 0;
  let refreshed = 0;
  for (const raw of Array.isArray(declared) ? declared : []) {
    const text = normalizeLoopText(raw && typeof raw === 'object' ? raw.text : raw);
    if (!text) continue;
    const weight = clamp(
      raw && typeof raw === 'object' && raw.weight != null ? raw.weight : 1,
      1,
      3
    );
    const existing =
      list.find((l) => l.id === (raw && raw.id)) || list.find((l) => l.text === text);
    if (existing) {
      existing.updatedAt = nowMs;
      existing.weight = weight;
      refreshed += 1;
      continue;
    }
    list.push({
      id: (raw && raw.id) || stableId(text),
      text,
      weight,
      createdAt: nowMs,
      updatedAt: nowMs
    });
    added += 1;
  }

  let dropped = 0;
  const max = Math.max(1, cfg.loopMax);
  while (list.length > max) {
    let weakest = 0;
    for (let i = 1; i < list.length; i += 1) {
      if (loopTension(list[i], nowMs, cfg) < loopTension(list[weakest], nowMs, cfg)) weakest = i;
    }
    list.splice(weakest, 1);
    dropped += 1;
  }
  state.loops = list;
  return { added, refreshed, dropped };
}

/** 关掉一条（决策 REFUSE 时由 `decide.js` 调用）：这是「决定不做」，与「做完了」不是一回事 */
function closeLoop(state, loopId) {
  const list = Array.isArray(state.loops) ? state.loops : [];
  const idx = list.findIndex((l) => l.id === loopId);
  if (idx < 0) return null;
  const [removed] = list.splice(idx, 1);
  state.loops = list;
  return removed;
}

/** 自然消退到几乎没有的项直接清掉（否则状态文件无界增长） */
function pruneLoops(state, opts) {
  const cfg = opts.cfg;
  const nowMs = opts.nowMs;
  const before = Array.isArray(state.loops) ? state.loops.length : 0;
  state.loops = (state.loops || []).filter((l) => loopTension(l, nowMs, cfg) >= 1);
  return before - state.loops.length;
}

/**
 * 拒绝率（滑动窗口）：只看「决策过的那几次」，没决策的轮次不计入分母。
 * @returns {{ rate: number, decided: number, refused: number }}
 */
function refusalRate(state, opts) {
  const cfg = opts.cfg;
  const nowMs = opts.nowMs;
  const from = nowMs - Math.max(60000, cfg.refusalWindowMs);
  const decisions = (Array.isArray(state.decisions) ? state.decisions : []).filter(
    (d) => d && Number(d.ts) >= from
  );
  const refused = decisions.filter((d) => d.decision === 'REFUSE').length;
  return {
    rate: decisions.length ? refused / decisions.length : 0,
    decided: decisions.length,
    refused
  };
}

/** 滑动窗口裁剪（只留窗口内的决策，状态文件不会无界） */
function pruneDecisions(state, opts) {
  const cfg = opts.cfg;
  const nowMs = opts.nowMs;
  const from = nowMs - Math.max(60000, cfg.refusalWindowMs);
  state.decisions = (Array.isArray(state.decisions) ? state.decisions : []).filter(
    (d) => d && Number(d.ts) >= from
  );
}

/**
 * 阈值漂移：
 *   W += (μ·(基线 − 拒绝率) + ν·(疲劳/100 − 0.5)) · Δt(小时)
 *
 * 含义：长期很少拒绝 → 阈值升高（更挑）；长期拒绝太多 → 降低（更容易被推动）；
 * 越疲劳越难被唤起。所有项都按**小时**归一，所以量级与 tick 间隔无关
 * （原设计按 tick 计，1 小时就会把 W 钉死在 80，见评审 N2）。
 *
 * 注意：原 spec 公式写的是 `μ·(refuse_rate − 0.2)`，但同一段解释写的是
 * 「拒绝率长期偏低则阈值升高」—— 两者方向相反。这里按**解释**实现（更符合直觉，
 * 也符合「从不拒绝的实例该变得更挑」这条诊断），符号差异记在 docs/ALIVE.md。
 */
function driftThreshold(state, opts) {
  const cfg = opts.cfg;
  const dtH = clamp(Number(opts.dtH) || 0, 0, 24);
  if (dtH <= 0) return state.wakeThreshold;
  const { rate, decided } = refusalRate(state, opts);
  const refuseTerm =
    decided >= 3 ? cfg.wakeThresholdMuPerHour * (cfg.wakeRefusalBaseline - rate) : 0;
  const fatigueTerm = cfg.wakeThresholdNuPerHour * (state.fatigue / 100 - 0.5);
  state.wakeThreshold = clamp(
    state.wakeThreshold + (refuseTerm + fatigueTerm) * dtH,
    cfg.wakeThresholdMin,
    cfg.wakeThresholdMax
  );
  return state.wakeThreshold;
}

module.exports = {
  LOOP_TEXT_MAX,
  stableId,
  normalizeLoopText,
  loopTension,
  totalLoopTension,
  upsertLoops,
  closeLoop,
  pruneLoops,
  refusalRate,
  pruneDecisions,
  driftThreshold
};
