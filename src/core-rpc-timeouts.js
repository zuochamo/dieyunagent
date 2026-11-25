'use strict';

/** 本地 / 远程 dieyun-core RPC 共用超时（避免 core-bridge 与 gateway 漂移） */
const DEFAULT_TIMEOUT_MS = 120000;
const INDEX_TIMEOUT_MS = 600000;
/**
 * `compaction.fold` 是纯 CPU 的就地截短（毫秒级），没有网络往返。
 * 30s 只是「别让一次卡死的折叠把发送拖成 120s 假死」的上限，不是 LLM 超时；
 * 旧的 `compaction.maybe_compact` 因为要发一次 75s 的摘要请求，得单独占 90s。
 */
const COMPACTION_FOLD_TIMEOUT_MS = 30 * 1000;

/**
 * `llm.complete`：一次 LLM 调用的整体预算。
 *
 * 它比默认 120s 宽得多，因为流式长回答本身就可能跑几分钟；上限对齐 Rust 侧
 * `agent::llm::STREAM_TIMEOUT_SECS`（600s）再加余量 —— 两个数字必须成对改。
 * 真正的「卡住了」由 runner 的首字/空闲超时先发现，这里只防「永远不返回」。
 */
const LLM_CHAT_TIMEOUT_MS = 660 * 1000;

/**
 * `agent.run.start` / `agent.run.tools`：**core 自己调 LLM** 的那两条驱动 RPC。
 *
 * 与 `llm.complete` 同量级、同样对齐 Rust 侧 `agent::llm::STREAM_TIMEOUT_SECS`（600s）
 * 再加余量 —— 四个数字必须成对改：这两条 RPC 跑的正是同一次 `llm::chat_completion`，
 * 只是从「宿主经 RPC 发」变成「core 在自己循环里发」。
 * 真正的「卡住了」由 runner 的 run-stall 看门狗（`runStallWarnMs` / `runStallAbortMs`）先发现，
 * 这里只防「永远不返回」。
 */
const AGENT_RUN_TIMEOUT_MS = 660 * 1000;

/**
 * 端到端耗时超过它就打 `RPC_SLOW <method> <ms>`。
 *
 * 与 Rust `dieyun_core::rpc::slow_rpc_log_ms()` 同源（`src/agent/agent-shared.json` 的
 * `rpc.slowLogMs`，不再是「跨语言没法共享常量」的手抄值）：
 * 两边都记录才能分辨「core 内部慢」还是「RPC 堵在管道 / 守护进程 / SSH 里」——
 * `memory.long_recall` 那次 120s 超时就是缺了这组对照，只能靠猜。
 */
const SLOW_RPC_LOG_MS = require('./agent/shared-constants').rpc.slowLogMs;

/**
 * `codebase.status` / `graph.status` 的超时。
 *
 * 数字与 Rust 侧同源（`src/agent/agent-shared.json` 的 `rpc.hostStatusTimeoutMs`）：
 * 内核的 `Fast` 档预算必须小于它，`crates/dieyun-runtime/src/rpc/registry.rs` 的用例
 * 直接读这一份做断言 —— 手抄两份时，宿主把它调小、那条断言照样绿。
 */
const HOST_STATUS_TIMEOUT_MS = require('./agent/shared-constants').rpc.hostStatusTimeoutMs;

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
  // status 是纯读库，健康库上应毫秒级返回；15s 只会在真卡住时把调用拖成「假死」。
  if (m === 'codebase.status' || m === 'graph.status') return HOST_STATUS_TIMEOUT_MS;
  if (
    m === 'graph.lsp_resolve' ||
    m === 'graph.ingest_lsp_callers' ||
    m === 'index.ping'
  ) {
    return 60000;
  }
  if (m === 'compaction.fold') return COMPACTION_FOLD_TIMEOUT_MS;
  // `llm.complete` 是辅助任务（标题 / 汇总 / 评审 / 计划 / 记忆提炼）与 Renderer 流式对话
  // 的唯一 LLM 入口。以前这里写的是已被删除的 `agent.llm.chat`，于是真正在跑的这条落到
  // 默认 120s：core 侧按 600s 还在流，宿主 120s 就放弃 —— 长回答表现为「说到一半突然失败」。
  if (m === 'llm.complete') return LLM_CHAT_TIMEOUT_MS;
  if (m === 'agent.run.start' || m === 'agent.run.tools') return AGENT_RUN_TIMEOUT_MS;
  return DEFAULT_TIMEOUT_MS;
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  INDEX_TIMEOUT_MS,
  COMPACTION_FOLD_TIMEOUT_MS,
  LLM_CHAT_TIMEOUT_MS,
  AGENT_RUN_TIMEOUT_MS,
  SLOW_RPC_LOG_MS,
  resolveCoreRpcTimeoutMs
};
