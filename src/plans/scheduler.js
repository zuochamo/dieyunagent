'use strict';

const { msUntilNextRun } = require('./rrule-next');

class PlansScheduler {
  /**
   * @param {{ getPlans: () => object[], runPlan: (plan: object) => Promise<object>, log?: (m: string) => void }} opts
   */
  constructor(opts) {
    this.getPlans = opts.getPlans;
    this.runPlan = opts.runPlan;
    this.log = opts.log || (() => {});
    /** @type {Map<string, NodeJS.Timeout>} */
    this.timers = new Map();
    this.running = new Set();
  }

  clearAll() {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }

  reload() {
    this.clearAll();
    for (const plan of this.getPlans()) {
      if (plan.enabled) this._arm(plan);
    }
  }

  _arm(plan) {
    const ms = msUntilNextRun(plan);
    if (ms == null) return;
    const cap = Math.min(ms, 2147483647);
    const timer = setTimeout(() => this._tick(plan.id), cap);
    this.timers.set(plan.id, timer);
  }

  async _tick(planId) {
    this.timers.delete(planId);
    const plan = this.getPlans().find((p) => p.id === planId);
    if (!plan || !plan.enabled) return;
    if (this.running.has(planId)) {
      this._arm(plan);
      return;
    }
    this.running.add(planId);
    try {
      await this.runPlan(plan);
    } catch (e) {
      this.log(`计划执行失败 ${plan.name}: ${e.message}`);
    } finally {
      this.running.delete(planId);
    }
    const fresh = this.getPlans().find((p) => p.id === planId);
    if (fresh && fresh.enabled && !fresh.onceAt) {
      this._arm(fresh);
    }
  }

  async runNow(planId) {
    const plan = this.getPlans().find((p) => p.id === planId);
    if (!plan) throw new Error('计划不存在');
    if (this.running.has(planId)) throw new Error('计划正在执行');
    this.running.add(planId);
    try {
      return await this.runPlan(plan);
    } finally {
      this.running.delete(planId);
    }
  }
}

module.exports = { PlansScheduler };
