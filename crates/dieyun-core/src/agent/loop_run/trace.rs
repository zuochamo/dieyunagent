//! 收尾：把账本里的 trace / 正文 / messages 收成一个 `done` 响应。
//!
//! 从 `agent/loop_run.rs` 机械搬来（纯移动）。取 messages 与把 run 从账本移除必须在
//! **同一个临界区**里完成 —— 两次 `lock().ok()` 会让 poison 变成「messages=null」
//! （Node 侧整段工具结果丢失），或让 run 永不删除。

use serde_json::Value;

use super::{AgentLoopManager, LoopResponse, TraceRound};

impl AgentLoopManager {

    /// 收尾并从账本移除：取 messages 与移除在**同一个**临界区里完成。
    ///
    /// 旧实现两次 `lock().ok()`：第一次失败（poison）→ messages 变成 `None`（Node 侧整段
    /// 工具结果随之丢失）；第二次失败 → run 永不删除。poison 用 `into_inner()` 明确恢复。
    pub(crate) fn finish_run(
        &self,
        run_id: &str,
        trace: Vec<TraceRound>,
        content: Option<String>,
        hit_limit: bool,
    ) -> LoopResponse {
        let messages = match self.runs.lock() {
            Ok(mut runs) => runs.remove(run_id).map(|state| state.messages),
            Err(poisoned) => poisoned.into_inner().remove(run_id).map(|state| state.messages),
        };
        self.build_done(run_id, trace, content, hit_limit, messages)
    }


    pub(crate) fn build_done(
        &self,
        run_id: &str,
        trace: Vec<TraceRound>,
        content: Option<String>,
        hit_limit: bool,
        messages: Option<Vec<Value>>,
    ) -> LoopResponse {
        LoopResponse {
            phase: "done".into(),
            run_id: run_id.to_string(),
            llm_body: None,
            delegates: None,
            content,
            trace: Some(trace),
            hit_round_limit: if hit_limit { Some(true) } else { None },
            messages,
            message: None,
            compacted: None,
        }
    }

}
