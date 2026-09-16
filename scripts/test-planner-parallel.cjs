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
