'use strict';

const { RRule } = require('rrule');

/**
 * @param {import('./store').normalizePlan extends Function ? ReturnType<import('./store').normalizePlan> : object} plan
 * @param {Date} [now]
 * @returns {number|null} ms until next run
 */
function msUntilNextRun(plan, now = new Date()) {
  if (!plan || !plan.enabled) return null;

  if (plan.onceAt) {
    const at = new Date(plan.onceAt).getTime();
    if (Number.isNaN(at) || at <= now.getTime()) return null;
    return at - now.getTime();
  }

  if (!plan.rrule) return null;

  try {
    const opts = RRule.parseString(plan.rrule);
    if (!opts.dtstart) {
      opts.dtstart = plan.dtstart ? new Date(plan.dtstart) : now;
    }
    if (opts.byhour == null && opts.byminute == null && plan.rrule.includes('BYHOUR')) {
      // parseString may leave BYHOUR in string only — rebuild from parts
    }
    const rule = new RRule(opts);
    const next = rule.after(now, false);
    if (!next) return null;
    const ms = next.getTime() - now.getTime();
    return ms > 0 ? ms : null;
  } catch {
    return null;
  }
}

function formatPlanSchedule(plan) {
  if (plan.onceAt) {
    try {
      return `单次 · ${new Date(plan.onceAt).toLocaleString('zh-CN')}`;
    } catch {
      return `单次 · ${plan.onceAt}`;
    }
  }
  if (plan.rrule) return plan.rrule;
  return '未设置';
}

module.exports = { msUntilNextRun, formatPlanSchedule };
