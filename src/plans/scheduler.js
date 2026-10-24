'use strict';

const { msUntilNextRun } = require('./rrule-next');

/** setTimeout 的最大延时（约 24.8 天），超过它只能分段等待 */
const TIMER_MAX_MS = 2147483647;

class PlansScheduler {
  /**
   * @param {{ getPlans: () => object[], runPlan: (plan: object) => Promise<object>, log?: (m: string) => void,
   *           isBusy?: () => boolean, idlePollMs?: number, idleQuietMs?: number }} opts
   *
   * 定时计划（trigger=schedule，默认）按 rrule/onceAt 上闹钟；
   * 闲时计划（trigger=idle）不定时，由 _idleTick 空闲轮询触发：
   * isBusy 是「系统是否忙」的唯一外部信号（Main 注入 rust-loop-runner 的活跃 loop 计数），
   * lastBusyAt 让「刚结束一次运行」也算忙 —— 空闲任务之间、以及空闲任务与用户运行之间
   * 至少间隔 idleQuietMs，避免背靠背触发。
   */
  constructor(opts) {
    this.getPlans = opts.getPlans;
    this.runPlan = opts.runPlan;
    this.log = opts.log || (() => {});
    /** @type {Map<string, NodeJS.Timeout>} */
    this.timers = new Map();
    this.running = new Set();
    this.isBusy = typeof opts.isBusy === 'function' ? opts.isBusy : null;
    this.idlePollMs = opts.idlePollMs > 0 ? opts.idlePollMs : 60 * 1000;
    this.idleQuietMs = opts.idleQuietMs > 0 ? opts.idleQuietMs : 5 * 60 * 1000;
    this.lastBusyAt = Date.now();
    /** @type {NodeJS.Timeout|null} */
    this.idleTimer = null;
  }

  clearAll() {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    if (this.idleTimer) {
      clearInterval(this.idleTimer);
      this.idleTimer = null;
    }
  }

  reload() {
    this.clearAll();
    for (const plan of this.getPlans()) {
      if (plan.enabled) this._arm(plan);
    }
    this._armIdlePoll();
  }

  _arm(plan) {
    if (plan.trigger === 'idle') return; // 闲时计划不走定时器（见 _idleTick）
    const ms = msUntilNextRun(plan);
    if (ms == null) return;
    if (ms > TIMER_MAX_MS) {
      // setTimeout 上限约 24.8 天：远期计划只能先睡满一段再重算。
      // 若把这一段当成「到点」触发，远期计划就会提前执行（时间对不上设定）。
      const timer = setTimeout(() => {
        this.timers.delete(plan.id);
        const fresh = this.getPlans().find((p) => p.id === plan.id);
        if (fresh && fresh.enabled) this._arm(fresh);
      }, TIMER_MAX_MS);
      this.timers.set(plan.id, timer);
      return;
    }
    const timer = setTimeout(() => this._tick(plan.id), ms);
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
    if (fresh && fresh.enabled && !fresh.onceAt && fresh.trigger !== 'idle') {
      this._arm(fresh);
    }
  }

  _armIdlePoll() {
    if (this.idleTimer || !this.isBusy) return;
    this.idleTimer = setInterval(() => {
      this._idleTick().catch(() => {});
    }, this.idlePollMs);
    if (typeof this.idleTimer.unref === 'function') this.idleTimer.unref();
  }

  async _idleTick() {
    if (this.running.size > 0 || (this.isBusy && this.isBusy())) {
      this.lastBusyAt = Date.now();
      return;
    }
    if (Date.now() - this.lastBusyAt < this.idleQuietMs) return;
    const plan = this.getPlans().find(
      (p) => p && p.enabled && p.trigger === 'idle' && !this.running.has(p.id)
    );
    if (!plan) return;
    this.running.add(plan.id);
    this.lastBusyAt = Date.now();
    try {
      await this.runPlan(plan);
    } catch (e) {
      this.log(`闲时计划执行失败 ${plan.name}: ${e.message}`);
    } finally {
      this.running.delete(plan.id);
      this.lastBusyAt = Date.now();
    }
  }

  async runNow(planId) {
    const plan = this.getPlans().find((p) => p.id === planId);
    if (!plan) throw new Error('计划不存在');
    if (this.running.has(planId)) throw new Error('计划正在执行');
    this.running.add(planId);
    this.lastBusyAt = Date.now();
    try {
      return await this.runPlan(plan);
    } finally {
      this.running.delete(planId);
      this.lastBusyAt = Date.now();
    }
  }
}

module.exports = { PlansScheduler };
