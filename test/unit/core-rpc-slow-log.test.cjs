'use strict';
/**
 * RPC 耗时口径（`src/core-rpc-timeouts.js`）。
 *
 * 这组常量是 `memory.long_recall` 那两次 120s 超时的产物：当时无从判断 RPC 卡在
 * 「core 内部」还是「管道 / 守护进程 / SSH」，只能靠推理。现在两侧都留耗时记录，
 * 但前提是**预算与慢请求阈值不能漂**——漂了就会出现「core 说没慢、宿主说超时」的
 * 无解现场。
 */
const assert = require('node:assert/strict');
const {
  DEFAULT_TIMEOUT_MS,
  INDEX_TIMEOUT_MS,
  COMPACTION_FOLD_TIMEOUT_MS,
  SLOW_RPC_LOG_MS,
  resolveCoreRpcTimeoutMs
} = require('../../src/core-rpc-timeouts');

describe('core RPC 超时与慢请求口径', () => {
  it('慢请求阈值必须远小于默认预算，否则超时前打不出任何日志', () => {
    assert.equal(SLOW_RPC_LOG_MS, 2000);
    assert.ok(
      SLOW_RPC_LOG_MS * 10 < DEFAULT_TIMEOUT_MS,
      `慢日志阈值 ${SLOW_RPC_LOG_MS}ms 与默认预算 ${DEFAULT_TIMEOUT_MS}ms 不成比例`
    );
  });

  it('建库预算仍是最长的那个（否则建库会被自己的超时掐断）', () => {
    assert.equal(INDEX_TIMEOUT_MS, 600000);
    assert.ok(INDEX_TIMEOUT_MS > DEFAULT_TIMEOUT_MS);
    assert.equal(resolveCoreRpcTimeoutMs('codebase.index'), INDEX_TIMEOUT_MS);
  });

  it('memory.long_recall 走默认预算：修法是归属，不是给它单独加超时', () => {
    // 曾经的想法是「给 long_recall 加长超时」。那是把「被拖死」当成「本来就要慢」，
    // 真正的修法是不让它排在长任务后面（见 docs/SQLITE-ACCESS.md 三通道）。
    assert.equal(resolveCoreRpcTimeoutMs('memory.long_recall'), DEFAULT_TIMEOUT_MS);
  });

  it('status 类预算明显短于默认，轮询卡住时能早报错', () => {
    assert.equal(resolveCoreRpcTimeoutMs('codebase.status'), 15000);
    assert.equal(resolveCoreRpcTimeoutMs('graph.status'), 15000);
    assert.ok(resolveCoreRpcTimeoutMs('codebase.status') < DEFAULT_TIMEOUT_MS);
  });

  it('压缩预算按 LLM 单次超时 + 余量给，且显式覆盖优先', () => {
    assert.equal(resolveCoreRpcTimeoutMs('compaction.fold'), COMPACTION_FOLD_TIMEOUT_MS);
    // 折叠是纯 CPU（毫秒级），预算必须远小于默认的 120s：它压在「发请求之前」的关键路径上
    assert.ok(COMPACTION_FOLD_TIMEOUT_MS < DEFAULT_TIMEOUT_MS);
    assert.equal(resolveCoreRpcTimeoutMs('memory.long_recall', 5000), 5000);
  });
});
