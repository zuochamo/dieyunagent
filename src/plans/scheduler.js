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
    for (const planId of [...this.timers.keys()]) this._disarm(planId);
    if (this.idleTimer) {
      clearInterval(this.idleTimer);
      this.idleTimer = null;
    }
  }

  /** 取消某个计划的待跑 timer（同一计划只允许有一个待跑 timer，见 _arm） */
  _disarm(planId) {
    const timer = this.timers.get(planId);
    if (timer) clearTimeout(timer);
    this.timers.delete(planId);
  }

  reload() {
    this.clearAll();
    for (const plan of this.getPlans()) {
      if (plan.enabled) this._arm(plan);
    }
    this._armIdlePoll();
  }

  _arm(plan) {
    // 闲时（idle）与目标型（goal）都不走定时器：前者看「静默达标」，后者看 nextRunAt 退避，
    // 统一由 _idleTick 的轮询触发 —— 触发源只有一处。
    if (plan.trigger === 'idle' || plan.trigger === 'goal') return;
    const ms = msUntilNextRun(plan);
    if (ms == null) return;
    // 同一计划只留一个待跑 timer：覆盖前必须先清掉旧的。`reload()` 与「运行结束再上钟」
    // 是两条都会上钟的路，旧 timer 若只是被 map 覆盖、没人 clearTimeout，就成了
    // 谁也管不着的幽灵：到期时与新 timer 一起把同一个计划跑两遍
    // （2026-11-18 实测日志里 17:00:08 同一计划连着起跑两次，两个 runId 相差 90ms）。
    this._disarm(plan.id);
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
    this._disarm(planId);
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
    // 目标型优先，且不吃 idleQuietMs：它的节奏由 nextRunAt 退避决定。
    // 夜里没人操作时 isBusy() 为 false，目标要能一轮接一轮推进，而不是每轮先等 5 分钟静默。
    const goal = this._dueGoal();
    if (goal) {
      await this._runGoal(goal);
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

  /** 到点的目标型计划（无 nextRunAt = 立即，或 nextRunAt 已过）；取列表里第一个 */
  _dueGoal() {
    const now = Date.now();
    return (
      this.getPlans().find((p) => {
        if (!p || !p.enabled || p.trigger !== 'goal') return false;
        if (this.running.has(p.id)) return false;
        if (!p.nextRunAt) return true;
        const at = Date.parse(p.nextRunAt);
        return !Number.isFinite(at) || at <= now;
      }) || null
    );
  }

  async _runGoal(plan) {
    this.running.add(plan.id);
    this.lastBusyAt = Date.now();
    try {
      await this.runPlan(plan);
    } catch (e) {
      this.log(`目标型计划执行失败 ${plan.name}: ${e.message}`);
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
