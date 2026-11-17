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

/// 内核侧的预算守卫（低于它的预算视为调用方给错）。
///
/// 它是 Rust 独有的数字，不进 `assets/agent-shared.json`；但必须**不大于**共享文件里的
/// `compaction.contextWindowFloorTokens`，否则 Node 派生的合法预算会被内核静默抬高 ——
/// `shared.rs` 的测试钉着这条关系（所以这里只在测试构建里暴露）。
#[cfg(test)]
pub(crate) const MIN_BUDGET_TOKENS: usize = fold::MIN_BUDGET_TOKENS;

use serde_json::{json, Value};

use crate::error::CoreError;

/// 只回答「这段 messages 值多少 token」。
///
/// 只有一个消费方：UI 的上下文圆环（`{ messages }` 进、`{ tokens }` 出）。
/// 触发判定不走这里——那是 [`fold`] 内部的事，且优先用服务端 usage。
///
/// **形状不对要报错，不要回 `tokens: 0`**：0 与「上下文真的是空的」不可区分 —— 圆环显示
/// 「空上下文」、任何「接近上限才提醒」的 UI 判断都不触发，而调用方完全不知道自己传错了。
/// （同一份 `messages` 参数在 `compaction.fold` 里就是硬报 `INVALID_PARAMS`，口径要对齐。）
pub fn estimate(params: &Value) -> Result<Value, CoreError> {
    let messages = params
        .get("messages")
        .and_then(|v| v.as_array())
        .ok_or_else(|| {
            CoreError::rpc("INVALID_PARAMS", "messages 必填且必须是数组（估算只看消息列表）")
        })?;
    Ok(json!({ "tokens": estimate_messages_tokens(messages) }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// 回归（A19）：形状错误的入参必须报错，不能回 `tokens: 0`。
    ///
    /// 0 与「上下文真的是空的」不可区分 —— 圆环显示「空上下文」，任何「接近上限才提醒」
    /// 的 UI 判断都不触发，而调用方完全不知道自己传错了。
    #[test]
    fn estimate_rejects_malformed_messages() {
        for bad in [
            json!({}),
            json!({ "messages": null }),
            json!({ "messages": "oops" }),
        ] {
            let err = estimate(&bad).expect_err("形状不对就该报错");
            assert!(format!("{err}").contains("messages"), "{err}");
        }
        // 空数组是合法的「空上下文」：这里的 0 是真值
        let out = estimate(&json!({ "messages": [] })).unwrap();
        assert_eq!(out["tokens"], 0);
    }
}
