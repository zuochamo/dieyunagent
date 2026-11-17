//! 上下文压缩（compaction）。
//!
//! 语义全在 [`fold`]：确定性、幂等、无 LLM 的**就地折叠**。
//!
//! 这里删掉的是整套旧机制 —— `llm.rs`（一次最长 75s 的摘要请求）、`atoms.rs` 里的
//! 摘要格式化与消息重组（`build_digest_messages` / `reassemble_after_compaction` /
//! `format_compaction_summary`）、`file_ops.rs`（折叠后只留一张路径白名单），以及
//! `CompactionPrompts` / `cumulativeSummary` / `compactionRoundCount` 冷却窗口：
//! 它们存在的唯一目的是「让 LLM 摘要尽量不丢信息」，而折叠把原始消息留在原位，
//! 根本不需要一层摘要去替它保管信息。
//!
//! 触发的三个输入（预算 / 触发比 / 已用 token）由调用方给：预算与触发比的数值唯一
//! 来源是 Node（模型窗口与运行时预设），已用 token 优先取服务端回报的 usage。

mod fold;
mod tokens;

pub use fold::{fold, strip_images_only, FoldParams, FoldResult};
pub use tokens::estimate_messages_tokens;

use serde_json::{json, Value};

/// 只回答「这段 messages 值多少 token」。
///
/// 只有一个消费方：UI 的上下文圆环（`{ messages }` 进、`{ tokens }` 出）。
/// 触发判定不走这里——那是 [`fold`] 内部的事，且优先用服务端 usage。
pub fn estimate(params: &Value) -> Value {
    let messages = params
        .get("messages")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    json!({ "tokens": estimate_messages_tokens(&messages) })
}
