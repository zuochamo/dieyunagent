//! core → 宿主的事件通道（单向推送）。
//!
//! 为什么不能只用「响应」：一次 run 的增量（首字、思考片段、工具进度）必须在**响应返回之前**
//! 就到达 UI，一问一答的 RPC 模型表达不了这件事。此前 Node 靠正则刮 core 的 stderr 人类日志
//! 来「猜」这类进度（`[compaction-llm] …`），那是把日志当日志以外的用途用；这里给它一个
//! 正经的出口：stdout 上带 `type:"event"` 的行，宿主按 type 分发。
//!
//! 为什么是进程级单例：一个 core sidecar 进程只服务一个宿主，事件天然带 `runId` 归属；
//! 多开 core 就是多开进程，不存在串台。

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;

use serde_json::{json, Value};
use tokio::sync::mpsc::UnboundedSender;

static SINK: OnceLock<UnboundedSender<Value>> = OnceLock::new();

/// 事件通道是否已经关上（接收端退出 = `serve_stdio` 的写者没了）。
///
/// `tx.send` 失败以前是 `let _ =`：流式增量从那一刻起静默停掉，谁都不知道。
static SINK_CLOSED: AtomicBool = AtomicBool::new(false);

/// 由 `rpc::stdio::serve_stdio` 在启动时装一次。
pub fn install(tx: UnboundedSender<Value>) {
    let _ = SINK.set(tx);
}

pub fn enabled() -> bool {
    SINK.get().is_some() && !SINK_CLOSED.load(Ordering::Relaxed)
}

/// 推一条事件。没有装通道时静默丢弃（`dieyun-core index` 这类一次性命令也会走到这里）。
pub fn emit(kind: &str, fields: Value) {
    let Some(tx) = SINK.get() else {
        return;
    };
    if SINK_CLOSED.load(Ordering::Relaxed) {
        return;
    }
    let mut event = fields;
    if let Some(obj) = event.as_object_mut() {
        obj.insert("type".to_string(), json!(kind));
    }
    if tx.send(event).is_err() && !SINK_CLOSED.swap(true, Ordering::Relaxed) {
        // 只记一次：这条通道一旦关上，后面每条事件都会失败。
        dieyun_base::obs::io_error("events", "事件接收端已退出，后续事件被丢弃");
    }
}

/// 流式增量：`content`/`reasoning` 两个通道分开推，绝不在这一层合并。
pub fn emit_delta(run_id: &str, content: Option<&str>, reasoning: Option<&str>) {
    // 这里**没有** `round`：增量属于「正在飞的那一轮」，而账本的 `round` 是收到响应才自增的，
    // 请求发出时它还是上一轮 —— 填进去就是错的。这个字段以前恒为 `null`，宿主只能拿自己的
    // 计数兜底；与其留一个永远为空的字段，不如删掉（宿主的 `llmRound` 本来就是每轮递增的）。
    emit(
        "agent.delta",
        json!({
            "runId": run_id,
            "content": content,
            "reasoning": reasoning,
        }),
    );
}
