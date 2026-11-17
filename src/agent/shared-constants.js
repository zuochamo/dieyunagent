'use strict';

/**
 * 跨语言常量的**唯一来源**（Node 读取器）。
 *
 * 为什么要有这个文件：token 折算、预算地板、触发比夹取、读上限、慢请求阈值、上下文溢出
 * 词表这些数字/词表，Node 与 Rust **两边都算**，而两侧没法 `require` 到彼此。历史做法是
 * 手抄一份 + 注释写「与 Rust 同值，改一个必须改另一个」—— 2026-11 审计实测已经漂了两处
 * （预算地板 4096/8192、溢出词表少三条），而且两处都不会让任何测试变红。
 *
 * 现在的规则：
 * - 值只写在 `assets/agent-shared.json`；
 * - Node 一律从这里取（`agent-limits` / `fs-read-limits` / `core-rpc-timeouts` /
 *   `llm-reconnect-retry` / `model-runtime-by-tier` 都是消费方，不是来源）；
 * - Rust 侧同一份文件（`crates/dieyun-core/src/shared.rs`，`include_str!` 编译期嵌入）；
 * - 加键必须两侧都有人读，`scripts/check-shared-constants.cjs` 会验。
 *
 * 注意：`assets/**` 已在 electron-builder 的 files 里；headless 包要单独列（见
 * `scripts/pack-headless.cjs` 的 EXTRA_FILES）。
 */

const raw = require('../../assets/agent-shared.json');

const frozen = (obj) => Object.freeze({ ...obj });

module.exports = {
  raw,
  tokenEstimate: frozen(raw.tokenEstimate),
  compaction: frozen(raw.compaction),
  readLimits: frozen(raw.readLimits),
  rpc: frozen(raw.rpc),
  snippets: frozen(raw.snippets),
  contextOverflowPatterns: Object.freeze([...raw.contextOverflowPatterns])
};
