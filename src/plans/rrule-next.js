'use strict';

const { RRule } = require('rrule');

/**
 * rrule 2.x 的 RRule 是「UTC 墙钟」计算器：dtstart / BYHOUR / BYMINUTE / UNTIL
 * 一律按 UTC 字段解释，与运行机器的本地时区无关（传 tzid 也不生效）。
 *
 * 而这条链路上的其它一切用的都是**本地时间**：UI 的时间输入框、plans.json 的
 * onceAt / dtstart、编辑器的「生效结束」。两侧口径不一致就会整体平移一个时区，
 * 例如 Asia/Shanghai 下「每天 09:00」实际在本地 17:00 触发。
 *
 * 所以这里做唯一的桥接点：进 rrule 之前把本地时刻换算成墙钟（把本地字段写成
 * UTC 字段的等价 Date），出来之后再换回本地时刻。时区语义（含 UNTIL）只在本模块处理，
 * 调用方继续只传 / 只收本地时刻。
 */

/** 墙钟 ⇄ 本地时刻的换算系数：东八区为 +8h（getTimezoneOffset 是「UTC - 本地」的分钟数） */
function offsetMsAt(instant) {
  return -instant.getTimezoneOffset() * 60000;
}

/** 本地时刻 → 墙钟（Date 的 UTC 字段 == 该时刻的本地字段） */
function localToWallClock(instant) {
  return new Date(instant.getTime() + offsetMsAt(instant));
}

/**
 * 墙钟 → 本地时刻。
 * 先用墙钟字面值估一次偏移，夏令时切换点附近再迭代一次收敛。
 */
function wallClockToLocal(wall) {
  let off = offsetMsAt(wall);
  let instant = new Date(wall.getTime() - off);
  const off2 = offsetMsAt(instant);
  if (off2 !== off) instant = new Date(wall.getTime() - off2);
  return instant;
}

/**
 * 按本地时刻取「接下来 count 次触发」。
 *
 * @param {object} plan
 * @param {Date} [now]
 * @param {number} [count]
 * @returns {Date[]} 本地时刻，升序；拿不到就是空数组
 */
function nextRuns(plan, now = new Date(), count = 1) {
  if (!plan || !plan.enabled) return [];
  const want = Math.max(1, Math.floor(Number(count) || 1));
  if (plan.onceAt) {
    const at = new Date(plan.onceAt);
    return !Number.isNaN(at.getTime()) && at.getTime() > now.getTime() ? [at] : [];
  }
  if (!plan.rrule) return [];
  try {
    const opts = RRule.parseString(plan.rrule);
    const startInstant = plan.dtstart ? new Date(plan.dtstart) : now;
    if (Number.isNaN(startInstant.getTime())) return [];
    opts.dtstart = localToWallClock(startInstant);
    // UNTIL 是 iCal 意义上的真实时刻（编辑器写成 …Z），同样要换算到墙钟再与逐次触发比较，
    // 否则「生效结束」在 16:00 之后的计划会少跑最后一天
    if (opts.until instanceof Date && !Number.isNaN(opts.until.getTime())) {
      opts.until = localToWallClock(opts.until);
    }
    const rule = new RRule(opts);
    const out = [];
    let cursor = localToWallClock(now);
    for (let i = 0; i < want; i += 1) {
      const hit = rule.after(cursor, false);
      if (!hit) break;
      out.push(wallClockToLocal(hit));
      // 下一次从这次之后找（inclusive=false），避免同一时刻被算两遍
      cursor = hit;
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * @param {import('./store').normalizePlan extends Function ? ReturnType<import('./store').normalizePlan> : object} plan
 * @param {Date} [now]
 * @returns {number|null} ms until next run
 */
function msUntilNextRun(plan, now = new Date()) {
  const [first] = nextRuns(plan, now, 1);
  if (!first) return null;
  const ms = first.getTime() - now.getTime();
  return ms > 0 ? ms : null;
}

/**
 * 「这条规则接下来会怎么跑」的事实（给 `plan_create` 回执用）：
 * 下一次触发时刻、触发间隔、按间隔折算的每日次数。
 *
 * 为什么不在这里判「频次是不是太高」：那是策略，不是事实。模型/用户看到 `runsPerDay` 自己判断；
 * 要挡无界增长用 `agent-limits.plansMaxCount`（条数上限），不夹取间隔（夹取等于替用户改规则）。
 *
 * @param {object} plan
 * @param {Date} [now]
 * @returns {{ nextAt: string, intervalMs: number, runsPerDay: number, once: boolean } | null}
 */
function scheduleFacts(plan, now = new Date()) {
  const runs = nextRuns(plan, now, 2);
  if (!runs.length) return null;
  const once = !!plan.onceAt;
  const intervalMs = runs.length > 1 ? Math.max(0, runs[1].getTime() - runs[0].getTime()) : 0;
  return {
    nextAt: runs[0].toISOString(),
    intervalMs,
    runsPerDay: intervalMs > 0 ? Math.round((24 * 60 * 60 * 1000 * 100) / intervalMs) / 100 : 0,
    once
  };
}

module.exports = { msUntilNextRun, nextRuns, scheduleFacts };
