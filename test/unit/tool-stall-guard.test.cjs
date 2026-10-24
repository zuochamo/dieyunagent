'use strict';
/**
 * 工具级「无进展看门狗」（2026-10-23→24 事故的护栏）。
 *
 * 事故形态：`host_exec` 起了一个前台长驻脚本，工具 promise 永不 settle，harness 永远
 * await ⇒ 没有下一轮 LLM 请求、没有新 trace、没有一行日志，`agent_runs.status` 一直
 * 是 running（实测静默 11 小时）。`mutate-queue` 的 stall 只管「排队」，管不到「执行中」。
 *
 * 这里钉住四条语义：
 *   1. 永不 settle 的调用 → TOOL_STALLED（retryable:false，带 suggestedFix）；
 *   2. 正常返回不受影响（不改变结果、不加延迟语义）；
 *   3. 只放弃等待、**不终止原调用**（原 promise 继续跑，不得产生 unhandledRejection）；
 *   4. stallMs 为 0/未配置时不启用（允许上层关掉）。
 */
const assert = require('node:assert/strict');
const { raceToolStall, classifyFailure } = require('../../src/agent/tool-harness.js');

const never = () => new Promise(() => {});

describe('工具级无进展看门狗', () => {
  it('永不返回的工具 → TOOL_STALLED，且错误契约完整', async () => {
    let err = null;
    try {
      await raceToolStall(never(), { name: 'host_exec' }, 60);
    } catch (e) {
      err = e;
    }
    assert.ok(err, '应当超时失败');
    assert.equal(err.code, 'TOOL_STALLED');
    assert.equal(err.retryable, false);
    assert.equal(err.stalled, true);
    assert.match(err.message, /host_exec/);
    assert.match(err.message, /没有返回/);
    assert.match(err.suggestedFix, /detached/);
  });

  it('正常返回的工具原样透传结果', async () => {
    const r = await raceToolStall(Promise.resolve({ ok: true, value: 42 }), { name: 'fs_read_file' }, 60);
    assert.deepEqual(r, { ok: true, value: 42 });
  });

  it('工具抛错时按原错误返回，不被看门狗改写', async () => {
    const boom = Object.assign(new Error('命令失败'), { code: 'SHELL_TIMEOUT' });
    let err = null;
    try {
      await raceToolStall(Promise.reject(boom), { name: 'host_exec' }, 5000);
    } catch (e) {
      err = e;
    }
    assert.equal(err.code, 'SHELL_TIMEOUT');
  });

  it('stallMs=0 → 不启用看门狗（仍等原 promise）', async () => {
    const r = await raceToolStall(Promise.resolve('ok'), { name: 'x' }, 0);
    assert.equal(r, 'ok');
  });

  it('放弃等待不终止原调用：原 promise 后续 reject 不得产生 unhandledRejection', async () => {
    const unhandled = [];
    const onUnhandled = (e) => unhandled.push(e);
    process.on('unhandledRejection', onUnhandled);
    try {
      const late = new Promise((_, reject) => {
        setTimeout(() => reject(Object.assign(new Error('迟到的失败'), { code: 'LATE' })), 30);
      });
      await raceToolStall(late, { name: 'host_exec' }, 10).catch(() => {});
      await new Promise((r) => setTimeout(r, 80));
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
    assert.equal(unhandled.length, 0);
  });

  it('超时错误经 classifyFailure 仍保留 TOOL_STALLED（不塌成 EXCEPTION）', async () => {
    let err = null;
    try {
      await raceToolStall(never(), { name: 'host_exec' }, 30);
    } catch (e) {
      err = e;
    }
    const failure = classifyFailure('host_exec', null, err);
    assert.equal(failure.errorCode, 'TOOL_STALLED');
    assert.equal(failure.retryable, false);
    assert.ok(failure.suggestedFix);
  });
});

describe('看门狗窗口按工具身份选择', () => {
  const { resolveToolStallMs } = require('../../src/agent/tool-harness.js');
  const limits = { toolStallMs: 12 * 60 * 1000, toolStallMsLong: 45 * 60 * 1000 };

  it('普通工具用通用窗口', () => {
    assert.equal(resolveToolStallMs('host_exec', limits), 12 * 60 * 1000);
  });

  it('subagent 用长窗口（一次完整子 run，不能被 12 分钟误杀）', () => {
    assert.equal(resolveToolStallMs('subagent', limits), 45 * 60 * 1000);
  });

  it('长窗口缺失时回退到通用窗口', () => {
    assert.equal(resolveToolStallMs('subagent', { toolStallMs: 60000 }), 60000);
  });

  it('两个窗口都没配 → 0（看门狗关闭）', () => {
    assert.equal(resolveToolStallMs('host_exec', {}), 0);
  });
});
