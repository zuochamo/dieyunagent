'use strict';

const { settleAllAbortable } = require('../src/agent/parallel-batch');

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function run() {
  const starts = [];
  const ends = [];
  const settled = await settleAllAbortable(['A', 'B'], async (id) => {
    starts.push({ id, t: Date.now() });
    await sleep(80);
    ends.push({ id, t: Date.now() });
    return id;
  });
  assert(settled.length === 2, 'two jobs');
  assert(settled.every((s) => s.status === 'fulfilled'), 'both fulfilled');
  assert(starts.length === 2 && ends.length === 2, 'recorded timings');
  const firstEnd = Math.min(ends[0].t, ends[1].t);
  const secondStart = Math.max(starts[0].t, starts[1].t);
  assert(secondStart < firstEnd, 'worker loops overlap in time');

  // 并发闸（agent-limits.plannerMaxParallelWorkers 的落地）：同时在跑的不超过 limit，
  // 且**顺序与结果都不变** —— 取号池只是限制同时开工数，不是重排。
  {
    let inFlight = 0;
    let maxInFlight = 0;
    const order = [];
    const limited = await settleAllAbortable(
      ['a', 'b', 'c', 'd', 'e'],
      async (id) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await sleep(30);
        inFlight -= 1;
        order.push(id);
        return id;
      },
      { limit: 2 }
    );
    assert(limited.length === 5, 'limit 不丢任务');
    assert(
      limited.every((s, i) => s.status === 'fulfilled' && s.value === ['a', 'b', 'c', 'd', 'e'][i]),
      'limit 不改变结果顺序'
    );
    assert(maxInFlight === 2, `同时在跑应为 2，实际 ${maxInFlight}`);
    assert(order.length === 5, 'limit 下全部执行');

    // limit=1 → 严格串行
    let inFlight1 = 0;
    let maxInFlight1 = 0;
    await settleAllAbortable(
      ['x', 'y', 'z'],
      async () => {
        inFlight1 += 1;
        maxInFlight1 = Math.max(maxInFlight1, inFlight1);
        await sleep(10);
        inFlight1 -= 1;
      },
      { limit: 1 }
    );
    assert(maxInFlight1 === 1, `limit=1 必须串行，实际同时在跑 ${maxInFlight1}`);

    // limit 传了 ≤0 = 调用方算错了：按串行处理，绝不放开成无限并发
    let inFlight0 = 0;
    let maxInFlight0 = 0;
    await settleAllAbortable(
      ['p', 'q', 'r'],
      async () => {
        inFlight0 += 1;
        maxInFlight0 = Math.max(maxInFlight0, inFlight0);
        await sleep(5);
        inFlight0 -= 1;
      },
      { limit: 0 }
    );
    assert(maxInFlight0 === 1, `limit=0 应退成串行，实际同时在跑 ${maxInFlight0}`);
  }

  const ac = new AbortController();
  function createAbortWaiter(signal) {
    let onAbort;
    const promise = new Promise((_, reject) => {
      onAbort = () => {
        const err = new Error('已停止');
        err.name = 'AbortError';
        reject(err);
      };
      signal.addEventListener('abort', onAbort, { once: true });
    });
    return {
      promise,
      cancel() {
        signal.removeEventListener('abort', onAbort);
      }
    };
  }
  let aborted = false;
  const abortP = settleAllAbortable(
    ['slow'],
    async () => {
      await sleep(5000);
      return 'done';
    },
    {
      signal: ac.signal,
      createAbortWaiter,
      createAbortError() {
        const err = new Error('已停止');
        err.name = 'AbortError';
        return err;
      },
      async onAbort() {
        aborted = true;
      }
    }
  );
  ac.abort();
  let threw = false;
  try {
    await abortP;
  } catch (err) {
    threw = err && err.name === 'AbortError';
  }
  assert(threw, 'abort rejects');
  assert(aborted, 'onAbort ran');
}

run()
  .then(() => {
    console.log('test-planner-parallel.cjs ok');
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
