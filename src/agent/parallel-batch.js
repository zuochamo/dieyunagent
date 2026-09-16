'use strict';

/**
 * Run jobs concurrently via Promise.allSettled, racing an optional abort waiter.
 * The waiter rejects on abort and never fulfills; fulfillment is ignored so a
 * resolved waiter cannot steal Promise.race from the batch results.
 */
async function settleAllAbortable(jobs, runJob, opts = {}) {
  const list = Array.isArray(jobs) ? jobs : [];
  const batchPromise = Promise.allSettled(list.map((job) => runJob(job)));
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
    return await Promise.race([batchPromise, abortSide]);
  } catch (err) {
    await batchPromise.catch(() => {});
    throw err;
  } finally {
    if (abortWaiter && typeof abortWaiter.cancel === 'function') abortWaiter.cancel();
  }
}

module.exports = { settleAllAbortable };
