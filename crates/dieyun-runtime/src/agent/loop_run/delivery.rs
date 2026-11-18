//! 交付正文口径：**本轮交给下游的那段文字**只从这里出。
//!
//! 从 `agent/loop_run.rs` 机械搬来（纯移动）。四条终态路径（正常收尾 / 轮次上限 /
//! 工具次数上限 / 长度截断）必须共用同一个判据 —— 旧实现里上限分支自己拼正文，
//! 于是「思考顶正文」在单通道模型上必现（见 docs/REASONING-ISOLATION-PLAN.md）。

use serde_json::{json, Value};

use super::{ContentChannel, LlmResponseInput};

/// 本段结束、交给下游的正文 —— **四条终态路径（正常收尾 / 轮次上限 / 工具次数上限）**
/// 只有这一处口径：
/// - 思考通道（`ContentChannel::Reasoning`，单通道模型的 `content` 键）**永不**作为正文；
/// - 其余情况正文为空即 `None`：下游（`applyTurnEndSynthesis`、子 Agent 摘要）据此
///   判定「空回复」，而不是拿到一段空字符串的假正文。
///
/// 「被轮次/预算截断」这一事实用 `hit_round_limit` 与 `TraceRound.content_source` 表达；
/// 交付形态交给 Node 侧的四态收口（见 docs/REASONING-ISOLATION-PLAN.md §3.4）。
pub(crate) fn delivered_content(content: Option<&str>, channel: ContentChannel) -> Option<String> {
    if channel == ContentChannel::Reasoning {
        return None;
    }
    let text = content.unwrap_or("");
    if text.trim().is_empty() {
        None
    } else {
        Some(text.to_string())
    }
}


pub(crate) fn is_length_stop(reason: &Option<String>) -> bool {
    matches!(
        reason
            .as_deref()
            .map(|s| s.trim().to_ascii_lowercase())
            .as_deref(),
        Some("length") | Some("max_tokens")
    )
}


pub(crate) const TRUNCATED_TOOL_ERROR: &str =
    "未执行：模型输出触及 token 上限，参数可能不完整。请用完整参数重新调用。";


/// When a segment hits the tool-call cap, persist text-only assistant output.
/// Never append `tool_calls` without matching `tool` results — that breaks long-horizon continuation.
///
/// `content` 必须是**已经过通道口径过滤**的正文（即 `delivered_content()` 的结果）：
/// 思考通道的 `content` 只是思考的存放处，落进这里就成了「思考顶正文」。
///
/// `synthetic: true` 标明这段正文是**平台补的**（上限提示），不是模型原话。账本据此把
/// 该轮记成 `ContentSource::Synthetic`。字段只活在账本里（出站投影仍待收口，
/// 见 `docs/RUST-CORE-REFACTOR-PLAN.md` R2），不要假设 Node 侧会替你剥掉它。
/// 返回写入的文本，供调用方记账。
pub(crate) fn push_assistant_text_only(
    messages: &mut Vec<Value>,
    content: Option<&str>,
    fallback: &str,
) -> String {
    let text = content
        .filter(|c| !c.trim().is_empty())
        .unwrap_or(fallback)
        .to_string();
    messages.push(json!({
        "role": "assistant",
        "content": text,
        "synthetic": true
    }));
    text
}


/// 思考原文的来源**唯一**：`reasoning` 键；单通道模型（入口盖章 `content` 即思考）
/// 则取 `content` 键。绝不拿「正文」兜底思考 —— 旧实现正是靠那条兜底让思考区复述回答。
pub(crate) fn llm_thought_raw(llm: &LlmResponseInput) -> Option<String> {
    let pick = |slot: &Option<String>| -> Option<String> {
        slot.as_ref().filter(|v| !v.trim().is_empty()).cloned()
    };
    match llm.content_channel {
        ContentChannel::Reasoning => pick(&llm.content).or_else(|| pick(&llm.reasoning)),
        _ => pick(&llm.reasoning),
    }
}

