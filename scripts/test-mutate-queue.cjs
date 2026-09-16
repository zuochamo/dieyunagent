'use strict';

const {
  runExclusive,
  isWorkspaceMutateBusy,
  getWorkspaceMutatePending,
  listWorkspaceMutateHolders
} = require('../src/agent/mutate-queue');

async function testRunExclusiveSerializes() {
  const key = '/tmp/ws-a';
  let concurrent = 0;
  let maxConcurrent = 0;
  const tasks = [1, 2, 3].map(
    (n) =>
      runExclusive(async () => {
        concurrent += 1;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await new Promise((r) => setTimeout(r, 5));
        concurrent -= 1;
        return n;
      }, key, `sess-${n}`)
  );
  const out = await Promise.all(tasks);
  if (maxConcurrent > 1) throw new Error(`expected serial execution, saw ${maxConcurrent}`);
  if (out.join(',') !== '1,2,3') throw new Error('unexpected task results');
  console.log('ok mutate queue serializes writes');
}

async function testWorkspaceMutateBusyDetectsOtherHolders() {
  const key = '/tmp/ws-b';
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const pending = runExclusive(async () => gate, key, 'sess-a');
  await new Promise((r) => setTimeout(r, 0));
  if (!isWorkspaceMutateBusy(key, 'sess-b')) {
    throw new Error('expected busy for other session holder');
  }
  if (isWorkspaceMutateBusy(key, 'sess-a')) {
    throw new Error('current holder should not count as foreign busy');
  }
  const holders = listWorkspaceMutateHolders(key);
  if (!holders.includes('sess-a')) throw new Error('expected sess-a holder');
  release();
  await pending;
  if (getWorkspaceMutatePending(key) !== 0) throw new Error('expected pending cleared');
  console.log('ok mutate queue busy detection');
}

async function main() {
  await testRunExclusiveSerializes();
  await testWorkspaceMutateBusyDetectsOtherHolders();
  console.log('\nmutate-queue: ALL OK');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
