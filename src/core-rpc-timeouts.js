'use strict';

/** 本地 / 远程 dieyun-core RPC 共用超时（避免 core-bridge 与 gateway 漂移） */
const DEFAULT_TIMEOUT_MS = 120000;
const INDEX_TIMEOUT_MS = 600000;
/** 与 dieyun-core compaction/llm.rs `COMPACTION_LLM_MAX_WAIT_MS`(180s) + 余量对齐 */
const COMPACTION_MAYBE_COMPACT_TIMEOUT_MS = 210 * 1000;

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
    m === 'graph.index' ||
    m === 'graph.index_remote' ||
    m === 'graph.embed_symbols'
  ) {
    return INDEX_TIMEOUT_MS;
  }
  if (m === 'codebase.index.start' || m === 'graph.index.start') return 60000;
  if (m === 'codebase.status' || m === 'graph.status') return 45000;
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
  resolveCoreRpcTimeoutMs
};
