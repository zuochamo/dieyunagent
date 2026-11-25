'use strict';
/**
 * `src/agent/progress-flush.js` —— 流式进度合批的唯一实现。
 *
 * 守的是三件事（改造前分散在四处、各自漂移）：
 * 1. **只留最新一份**：一个 SSE 分片一次 push，但一次投递只送最后那一份（中途的帧可以丢）；
 * 2. **结构事件按最小间隔**：同一份 trace 只多了几个字 → 贴帧；结构变了 → 不早于 minInterval；
 * 3. **`flushNow()` 先冲挂起的增量**：结构相位绝不能越过还没送到的那几个字。
 */
const assert = require('node:assert/strict');
const { createProgressFlush } = require('../../src/agent/progress-flush');

/** 假时钟 + 假调度：手动推进 timer / 帧，避免真实定时器带来的抖动 */
function makeHarness(opts = {}) {
  const state = { now: 0, timers: [], frames: [], delivered: [] };
  const flush = createProgressFlush({
    minIntervalMs: opts.minIntervalMs == null ? 40 : opts.minIntervalMs,
    signature: opts.signature || ((p) => p.sig || ''),
    now: () => state.now,
    setTimer: (fn, ms) => {
      const timer = { fn, at: state.now + ms };
      state.timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => {
      state.timers = state.timers.filter((t) => t !== timer);
    },
    requestFrame: opts.noFrame
      ? null
      : (fn) => {
          const frame = { fn };
          state.frames.push(frame);
          return frame;
        },
    cancelFrame: (frame) => {
      state.frames = state.frames.filter((f) => f !== frame);
    },
    flush: (payload) => state.delivered.push(payload)
  });
  const advance = (ms) => {
    state.now += ms;
    const due = state.timers.filter((t) => t.at <= state.now);
    state.timers = state.timers.filter((t) => t.at > state.now);
    due.forEach((t) => t.fn());
  };
  const runFrames = () => {
    const pending = state.frames;
    state.frames = [];
    pending.forEach((f) => f.fn());
  };
  return { state, flush, advance, runFrames };
}

describe('progress-flush（流式进度合批的唯一实现）', () => {
  it('100 次 push 只投递一次，且内容是最后那一份', () => {
    const h = makeHarness({ noFrame: true, minIntervalMs: 40 });
    for (let i = 0; i < 100; i += 1) h.flush.push({ seq: i, sig: 'same' });
    assert.equal(h.state.delivered.length, 1, '第一份立即投递（此前没有任何投递）');
    assert.equal(h.state.delivered[0].seq, 0);
    h.advance(40);
    assert.equal(h.state.delivered.length, 2);
    assert.equal(h.state.delivered[1].seq, 99, '第二次投递拿到的是最新一份，不是排队的第一份');
    assert.equal(h.state.timers.length, 0, '期间不再排第二个定时器（覆盖式，不排队）');
  });

  it('结构签名不变时贴帧、不叠加最小间隔（出字要顺滑）', () => {
    const h = makeHarness();
    h.flush.push({ sig: 'round1' }); // 第一份：结构事件
    h.advance(40);
    h.runFrames();
    assert.equal(h.state.delivered.length, 1);

    h.flush.push({ sig: 'round1', text: 'a' });
    h.flush.push({ sig: 'round1', text: 'ab' });
    assert.equal(h.state.timers.length, 0, '纯流式文本不排定时器');
    h.runFrames();
    assert.equal(h.state.delivered.length, 2);
    assert.equal(h.state.delivered[1].text, 'ab', '一帧只投递最新文本');
  });

  it('结构变化走最小间隔，且不早于上一次投递 + minInterval', () => {
    const h = makeHarness({ minIntervalMs: 40 });
    h.flush.push({ sig: 'round1' });
    h.advance(40);
    h.runFrames(); // lastFlushAt = 40
    h.advance(10); // now = 50
    h.flush.push({ sig: 'round2' }); // 结构变化 → 应等到 80
    assert.equal(h.state.delivered.length, 1);
    h.advance(29); // now = 79
    assert.equal(h.state.delivered.length, 1, '未到最小间隔不许投递');
    h.advance(1); // now = 80 → 定时器到点，转帧
    h.runFrames();
    assert.equal(h.state.delivered.length, 2);
    assert.equal(h.state.delivered[1].sig, 'round2');
  });

  it('flushNow 先冲挂起的增量，再让结构事件走（顺序不能反）', () => {
    const h = makeHarness({ noFrame: true, minIntervalMs: 40 });
    h.flush.push({ sig: 'round1', text: '第一段' });
    h.advance(40);
    assert.equal(h.state.delivered.length, 1);
    h.flush.push({ sig: 'round1', text: '第一段+第二段（还在队列里）' });
    h.flush.flushNow();
    assert.equal(h.state.delivered.length, 2);
    assert.match(h.state.delivered[1].text, /队列里/);
    assert.equal(h.state.timers.length, 0, 'flushNow 顺手清掉了已排的定时器');
    h.flush.flushNow();
    assert.equal(h.state.delivered.length, 2, '没有挂起时 flushNow 什么都不发');
  });

  it('cancel 丢掉挂起的那一份（用户停止 / 换会话）', () => {
    const h = makeHarness({ noFrame: true, minIntervalMs: 40 });
    h.flush.push({ sig: 'round1', text: 'a' });
    h.advance(40);
    h.flush.push({ sig: 'round1', text: 'b' });
    h.flush.cancel();
    h.advance(1000);
    assert.equal(h.state.delivered.length, 1, 'cancel 之后不该再冒出一次投递');
    assert.equal(h.flush.hasPending, false);
  });

  it('缺 flush 回调直接报错（装配错误要早暴露，别静默丢帧）', () => {
    assert.throws(() => createProgressFlush({}), /flush/);
  });
});
