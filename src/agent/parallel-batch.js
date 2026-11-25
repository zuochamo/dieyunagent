'use strict';

/**
 * Run jobs concurrently via Promise.allSettled semantics, racing an optional abort waiter.
 * The waiter rejects on abort and never fulfills; fulfillment is ignored so a
 * resolved waiter cannot steal Promise.race from the batch results.
 *
 * `opts.limit` 给并发闸：**顺序不变、结果不丢**，只是同一时刻最多 `limit` 个在跑
 * （进程内取号，跑完一个补一个）。planner 的并行执行器靠它把「plan 里 A–F 六路」
 * 收在 `agent-limits.plannerMaxParallelWorkers` 之内 —— 六条 LLM 并发流同时打向同一个
 * provider 会被限流成超时，表现却是「某个 worker 莫名失败」，比排队难查得多。
 * 缺省 Infinity（历史行为：一把全放）。
 *
 * @param {Array<any>} jobs
 * @param {(job: any) => Promise<any>} runJob
 * @param {{ signal?: any, createAbortWaiter?: Function, createAbortError?: Function,
 *   onAbort?: Function, limit?: number }} [opts]
 * @returns {Promise<Array<{status:'fulfilled',value:any}|{status:'rejected',reason:any}>>}
 */
async function settleAllAbortable(jobs, runJob, opts = {}) {
  const list = Array.isArray(jobs) ? jobs : [];
  const rawLimit = Number(opts.limit);
  // 缺省（没传 / NaN / Infinity）= 不限并发（历史行为）。
  // 显式传了 ≤0 的值属调用方算错了：按**串行**处理（宁可慢，也不要在算错时放开成无限并发）。
  const limit = Number.isNaN(rawLimit)
    ? Infinity
    : rawLimit === Infinity
      ? Infinity
      : rawLimit > 0
        ? Math.floor(rawLimit)
        : 1;
  /** @type {Array<{status:'fulfilled',value:any}|{status:'rejected',reason:any}>} */
  const settled = new Array(list.length);

  // 取号池：每个 runner 依次领下一个下标，直到领完。位置固定 ⇒ 结果顺序与输入一致。
  let cursor = 0;
  const runnerCount = Math.max(1, Math.min(limit, list.length));
  const runners = [];
  for (let r = 0; r < runnerCount; r += 1) {
    runners.push(
      (async () => {
        for (;;) {
          const index = cursor;
          cursor += 1;
          if (index >= list.length) return;
          try {
            settled[index] = { status: 'fulfilled', value: await runJob(list[index]) };
          } catch (reason) {
            settled[index] = { status: 'rejected', reason };
          }
        }
      })()
    );
  }
  // 每个 runner 自己吞掉异常 ⇒ all 不会提前 reject，等价 allSettled
  const batchPromise = Promise.all(runners).then(() => settled);

  const abortWaiter = typeof opts.createAbortWaiter === 'function' ? opts.createAbortWaiter(opts.signal) : null;
  if (abortWaiter && abortWaiter.promise && typeof abortWaiter.promise.catch === 'function') {
    abortWaiter.promise.catch(() => {});
  }
  try {
    if (!abortWaiter) return await batchPromise;
    const abortSide = new Promise((_, reject) => {
      Promise.resolve(abortWaiter.promise).then(
        () => {},
        async () => {
          try {
            if (typeof opts.onAbort === 'function') await opts.onAbort();
          } catch {
            // cancel failures must not mask the abort
          }
          if (typeof opts.createAbortError === 'function') {
            reject(opts.createAbortError());
            return;
          }
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        }
      );
    });
    // 中止时**不等整批跑完**：以前这里 `await batchPromise.catch(…)`，界面会停在「停止中」，
    // 在途的 worker 继续烧 token 与工具时间（工具调用本身不可取消），用户点了停止要等几分钟
    // （2026-11-19 审计）。各 runner 会在自己的下一次 `throwIfAborted` 处收尾。
    // `batchPromise` 永远不会 reject（settleAllAbortable 已把每个 runner 收敛成 settled），
    // 因此提前返回不会留下 unhandledRejection。
    return await Promise.race([batchPromise, abortSide]);
  } finally {
    if (abortWaiter && typeof abortWaiter.cancel === 'function') abortWaiter.cancel();
  }
}

module.exports = { settleAllAbortable };
