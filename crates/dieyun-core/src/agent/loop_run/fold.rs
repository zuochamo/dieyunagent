//! 折叠调度：把「这一轮要不要折 / 强折一次」接到 `compaction::fold` 上。
//!
//! 从 `agent/loop_run.rs` 机械搬来（纯移动）。预算与触发比来自宿主（0 = 本 run 不折）；
//! 已用 token 优先取上一轮服务端 `usage.prompt_tokens`，拿不到才让折叠器回落到字符比估值。

use super::{FoldFact, RunState};

/// 在发出下一次请求之前折叠自己的 messages。
///
/// 为什么在核心里做：transcript 归这层所有。早先由 Node 每轮调 compaction.fold、
/// 再用 gent.loop.set_messages 把整段对话推回来 —— 同一份对话两个写者，谁都能改。
///
/// 预算 / 触发比来自 Node（0 = 本 run 不折）；已用 token 优先取上一轮服务端
/// usage.prompt_tokens，拿不到才让折叠器回落到字符比估值。
pub(crate) fn fold_if_needed(state: &mut RunState) {
    fold_state(state, false);
}


/// 强制折叠一次：宿主在「上下文溢出」时用。那次失败已经证明估算不准，
/// 不能再等触发线（与旧实现里 `force: true` 的语义一致）。
pub(crate) fn fold_force(state: &mut RunState) {
    fold_state(state, true);
}


pub(crate) fn fold_state(state: &mut RunState, force: bool) {
    if state.token_budget == 0 || state.trigger_ratio <= 0.0 {
        return;
    }
    // 借用转移而不是 clone：这段 messages 可能上百 KB，每轮复制一次不值得
    let messages = std::mem::take(&mut state.messages);
    let result = crate::compaction::fold(crate::compaction::FoldParams {
        messages,
        token_budget: state.token_budget,
        trigger_ratio: state.trigger_ratio,
        observed_prompt_tokens: state.observed_prompt_tokens,
        force,
        keep_tail_atoms: None,
    });
    state.messages = result.messages;
    if result.compacted {
        state.pending_fold = Some(FoldFact {
            level: result.level,
            tokens_before: result.tokens_before,
            tokens_after: result.tokens_after,
            trigger_source: result.trigger_source.to_string(),
            folded_tool_results: result.folded_tool_results,
            folded_texts: result.folded_texts,
            folded_images: result.folded_images,
        });
    }
}

