'use strict';

/** 全局 Embedding 串行队列（内置 BGE / 远程 API 共用，避免多会话并行抢同一向量模型） */
let tail = Promise.resolve();

/**
 * @template T
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
function runInEmbeddingQueue(fn) {
  const next = tail.then(fn, fn);
  tail = next.catch(() => {});
  return next;
}

module.exports = {
  runInEmbeddingQueue
};
