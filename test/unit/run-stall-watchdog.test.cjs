'use strict';
/**
 * run 级「无进展」看门狗（2026-10-23→24 两次静默卡死的护栏）。
 *
 * `while (phase !== 'done')` 里的每个 await（压缩 / 快照写库 / 循环 RPC / 委托回填）
 * 此前都没有时间维度：任何一段挂住，现象都一样 —— 没有下一轮请求、没有 trace、
 * main.log 一行不写，run 永远 running。
 *
 * 这里钉住四条语义：
 *   1. 有进展时绝不报警；
 *   2. 超过 warnMs → 报一次（不刷屏），再 check 不重复；
 *   3. note() 重置计时与 warn 状态（有进展就重新开始）；
 *   4. 超过 abortMs → 报一次 abort（调用方据此走既有 agent.loop.cancel）。
 */
const assert = require('node:assert/strict');
const { createRunStallWatchdog } = require('../../src/agent/rust-loop-runner.js');

describe('run 级无进展看门狗', () => {
  it('有进展期间不报警', () => {
    const wd = createRunStallWatchdog({ warnMs: 1000, abortMs: 5000 });
    const t0 = Date.now();
    wd.note('llm_fetch');
    assert.equal(wd.check(t0, 'run-1'), null);
    assert.equal(wd.check(t0 + 500, 'run-1'), null);
  });

  it('超过 warnMs 报一次 warn，之后不重复（不刷屏）', () => {
    const wd = createRunStallWatchdog({ warnMs: 1000, abortMs: 5000 });
    const t0 = Date.now();
    wd.note('delegate');
    const first = wd.check(t0 + 1500, 'run-2');
    assert.ok(first, '应当报 warn');
    assert.equal(first.level, 'warn');
    assert.equal(first.stage, 'delegate');
    assert.match(first.message, /RUN_STALL /);
    assert.match(first.message, /stage=delegate/);
    // 同一段内继续检查：不再重复
    assert.equal(wd.check(t0 + 2000, 'run-2'), null);
    assert.equal(wd.check(t0 + 3000, 'run-2'), null);
  });

  it('note() 重置计时与 warn 状态', () => {
    const wd = createRunStallWatchdog({ warnMs: 1000, abortMs: 5000 });
    const t0 = Date.now();
    wd.note('delegate');
    assert.ok(wd.check(t0 + 1500, 'run-3'));
    const t1 = Date.now();
    wd.note('llm_fetch');
    assert.equal(wd.check(t1 + 100, 'run-3'), null, '刚有进展不该报');
    const again = wd.check(t1 + 1500, 'run-3');
    assert.ok(again);
    assert.equal(again.stage, 'llm_fetch');
  });

  it('超过 abortMs 报一次 abort（调用方据此 cancel）', () => {
    const wd = createRunStallWatchdog({ warnMs: 1000, abortMs: 5000 });
    const t0 = Date.now();
    wd.note('tool_results');
    const warn = wd.check(t0 + 1200, 'run-4');
    assert.equal(warn.level, 'warn');
    const abort = wd.check(t0 + 6000, 'run-4');
    assert.ok(abort, '应当报 abort');
    assert.equal(abort.level, 'abort');
    assert.match(abort.message, /RUN_STALL_ABORT/);
    assert.match(abort.message, /agent\.loop\.cancel/);
    // 只报一次
    assert.equal(wd.check(t0 + 9000, 'run-4'), null);
  });

  it('abort 阈值不高于 warn 时被抬到 >= warn（配置写反不自毁）', () => {
    const wd = createRunStallWatchdog({ warnMs: 5000, abortMs: 1000 });
    const t0 = Date.now();
    wd.note('x');
    assert.equal(wd.check(t0 + 4999, 'run-5'), null, '未到 warn 阈值不该报');
    const warn = wd.check(t0 + 5000, 'run-5');
    assert.equal(warn.level, 'warn', '首次只 warn');
    const abort = wd.check(t0 + 5000, 'run-5');
    assert.equal(abort.level, 'abort', 'abort 阈值被抬到 = warn，越过即收尾');
  });

  it('stage / idleMs 可读（供日志与排查）', () => {
    const wd = createRunStallWatchdog();
    wd.note('compact');
    assert.equal(wd.stage, 'compact');
    assert.ok(wd.idleMs >= 0);
  });
});
