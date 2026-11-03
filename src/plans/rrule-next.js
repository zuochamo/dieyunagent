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
 * @param {import('./store').normalizePlan extends Function ? ReturnType<import('./store').normalizePlan> : object} plan
 * @param {Date} [now]
 * @returns {number|null} ms until next run
 */
function msUntilNextRun(plan, now = new Date()) {
  if (!plan || !plan.enabled) return null;

  // onceAt 存的就是真实时刻（ISO），不经过墙钟
  if (plan.onceAt) {
    const at = new Date(plan.onceAt).getTime();
    if (Number.isNaN(at) || at <= now.getTime()) return null;
    return at - now.getTime();
  }

  if (!plan.rrule) return null;

  try {
    const opts = RRule.parseString(plan.rrule);
    const startInstant = plan.dtstart ? new Date(plan.dtstart) : now;
    if (Number.isNaN(startInstant.getTime())) return null;
    opts.dtstart = localToWallClock(startInstant);
    // UNTIL 是 iCal 意义上的真实时刻（编辑器写成 …Z），同样要换算到墙钟再与逐次触发比较，
    // 否则「生效结束」在 16:00 之后的计划会少跑最后一天
    if (opts.until instanceof Date && !Number.isNaN(opts.until.getTime())) {
      opts.until = localToWallClock(opts.until);
    }
    const next = new RRule(opts).after(localToWallClock(now), false);
    if (!next) return null;
    const ms = wallClockToLocal(next).getTime() - now.getTime();
    return ms > 0 ? ms : null;
  } catch {
    return null;
  }
}

module.exports = { msUntilNextRun };
