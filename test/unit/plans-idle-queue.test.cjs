'use strict';
/**
 * 闲时队列（plans trigger=idle）：store 校验/一次性语义 + scheduler 空闲触发。
 *
 * 守的语义：
 * 1. store：idle 计划可不填 rrule/onceAt；schedule 计划仍要求至少一项；
 *    idle 计划成功跑完自动停用（重新启用 = 重新排队），失败不停用；
 * 2. scheduler：忙（isBusy 或有计划在跑）不触发且刷新 lastBusyAt；
 *    静默未达 idleQuietMs 不触发；闲 + 静默达标 → 按创建序跑第一个 idle 计划；
 *    idle 计划不占用定时器（_arm 跳过）；runNow 手动触发不受空闲条件限制。
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PlansStore } = require('../../src/plans/store');
const { PlansScheduler } = require('../../src/plans/scheduler');

function tmpStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dieyun-plans-idle-'));
  return new PlansStore(dir);
}

function idlePlan(name) {
  return { id: `idle-${name}`, name, enabled: true, trigger: 'idle', prompt: '做点事' };
}

test('store：idle 计划免 rrule/onceAt，schedule 计划仍校验', () => {
  const store = tmpStore();
  const plan = store.upsert(idlePlan('a'));
  assert.equal(plan.trigger, 'idle');
  assert.equal(plan.enabled, true);

  assert.throws(
    () => store.upsert({ id: 'bad', prompt: 'x' }),
    (e) => e.code === 'INVALID_SCHEDULE'
  );
  // 旧数据不带 trigger 字段 → 默认 schedule（存量行为不变）
  const legacy = store.upsert({ id: 'legacy', prompt: 'x', rrule: 'FREQ=DAILY;BYHOUR=9' });
  assert.equal(legacy.trigger, 'schedule');
});

test('store：idle 计划成功跑完自动停用，失败保持启用', () => {
  const store = tmpStore();
  const a = store.upsert(idlePlan('a'));
  store.updateRunResult(a.id, { ok: true, summary: 'done' });
  assert.equal(store.get(a.id).enabled, false, '成功 → 停用（一次性语义）');

  const b = store.upsert(idlePlan('b'));
  store.updateRunResult(b.id, { ok: false, error: 'boom' });
  assert.equal(store.get(b.id).enabled, true, '失败 → 保持启用，下次空闲重试');
});

function makeScheduler({ plans, isBusy = () => false, quietMs = 1000 }) {
  const ran = [];
  const s = new PlansScheduler({
    getPlans: () => plans,
    runPlan: async (plan) => {
      ran.push(plan.id);
      return { ok: true };
    },
    isBusy,
    idlePollMs: 10,
    idleQuietMs: quietMs
  });
  return { s, ran };
}

test('scheduler：忙时不触发，且刷新静默计时', async () => {
  const plans = [idlePlan('a')];
  const { s, ran } = makeScheduler({ plans, isBusy: () => true });
  s.lastBusyAt = Date.now() - 10 * 1000; // 早已静默达标，但现在是忙的
  await s._idleTick();
  assert.equal(ran.length, 0, '忙 → 不跑');
  assert.ok(Date.now() - s.lastBusyAt < 1000, '忙会刷新 lastBusyAt');
});

test('scheduler：静默未达标不触发；达标后跑第一个 idle 计划', async () => {
  const plans = [idlePlan('a'), idlePlan('b')];
  const { s, ran } = makeScheduler({ plans, quietMs: 60 * 1000 });
  s.lastBusyAt = Date.now() - 1000; // 只静默 1s < 60s
  await s._idleTick();
  assert.equal(ran.length, 0, '静默未达标 → 不跑');

  s.lastBusyAt = Date.now() - 61 * 1000;
  await s._idleTick();
  assert.deepEqual(ran, ['idle-a'], '达标 → 只跑创建序第一个 idle 计划');
  // 跑完刷新 lastBusyAt：下一个 idle 计划至少再等 quietMs
  assert.ok(Date.now() - s.lastBusyAt < 1000);
  await s._idleTick();
  assert.deepEqual(ran, ['idle-a'], '静默窗口内不背靠背触发');
});

test('scheduler：idle 计划不占定时器；runNow 可手动触发', async () => {
  const plans = [idlePlan('a')];
  const { s, ran } = makeScheduler({ plans });
  s._arm(plans[0]);
  assert.equal(s.timers.size, 0, 'idle 计划不上定时器');

  await s.runNow(plans[0].id);
  assert.deepEqual(ran, ['idle-a'], 'runNow 不受空闲条件限制');
});

test('scheduler：无 isBusy 信号时不建轮询定时器（兼容旧构造）', () => {
  const s = new PlansScheduler({ getPlans: () => [], runPlan: async () => ({}) });
  s.reload();
  assert.equal(s.idleTimer, null);
});
