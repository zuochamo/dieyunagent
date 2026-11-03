'use strict';

/** 本地 / 远程 dieyun-core RPC 共用超时（避免 core-bridge 与 gateway 漂移） */
const DEFAULT_TIMEOUT_MS = 120000;
const INDEX_TIMEOUT_MS = 600000;
/** 与 dieyun-core compaction/llm.rs `LLM_HTTP_TIMEOUT_SECS`(75s，单次不重试) + 余量对齐 */
const COMPACTION_MAYBE_COMPACT_TIMEOUT_MS = 90 * 1000;

/**
 * 端到端耗时超过它就打 `RPC_SLOW <method> <ms>`。
 *
 * 与 Rust `dieyun_core::rpc::SLOW_RPC_LOG_MS` 同值（跨语言没法共享常量）：
 * 两边都记录才能分辨「core 内部慢」还是「RPC 堵在管道 / 守护进程 / SSH 里」——
 * `memory.long_recall` 那次 120s 超时就是缺了这组对照，只能靠猜。
 */
const SLOW_RPC_LOG_MS = 2000;

/**
 * @param {string} method
 * @param {number} [timeoutMs] 显式覆盖
 * @returns {number}
 */
function resolveCoreRpcTimeoutMs(method, timeoutMs) {
  if (timeoutMs != null && Number(timeoutMs) > 0) return Number(timeoutMs);
  const m = String(method || '');
  if (
    m === 'codebase.index' ||
    m === 'graph.index'
  ) {
    return INDEX_TIMEOUT_MS;
  }
  if (m === 'codebase.index.start' || m === 'graph.index.start') return 60000;
  // status 是纯读库，健康库上应毫秒级返回；45s 只会在真卡住时把调用拖成「假死」。
  if (m === 'codebase.status' || m === 'graph.status') return 15000;
  if (
    m === 'graph.lsp_resolve' ||
    m === 'graph.ingest_lsp_callers' ||
    m === 'index.ping'
  ) {
    return 60000;
  }
  if (m === 'compaction.maybe_compact') return COMPACTION_MAYBE_COMPACT_TIMEOUT_MS;
  return DEFAULT_TIMEOUT_MS;
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  INDEX_TIMEOUT_MS,
  COMPACTION_MAYBE_COMPACT_TIMEOUT_MS,
  SLOW_RPC_LOG_MS,
  resolveCoreRpcTimeoutMs
};
