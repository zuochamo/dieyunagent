//! core → 宿主**反向调用**通道（`agent.run` 施工图第一步）。
//!
//! 与 `rpc::events` 的区别：事件是单向「通知」，这里是「请求 + 答复」。core 需要宿主做
//! 只有宿主才能做的事（每轮视觉注入、工具执行），必须能等一个结果回来。
//!
//! 线上形状（stdout 出 / stdin 回）：
//!
//! ```text
//! core → {"type":"call","id":7,"method":"round.prepare","params":{…}}
//! host → {"type":"reply","id":7,"result":{…}}        // 或 {"error":{"code","message"}}
//! ```
//!
//! 分流规则只有一条：带 `type` 的行按 type 走（`event` → 订阅者、`call` → 宿主 handler），
//! 其余按 `id` 匹配「请求的响应」。三种行共用一条 stdout，靠 `type` 区分。
//!
//! 超时是**必需**的：反向调用的答复由宿主决定，宿主崩了/忘了回，core 不能永远等下去。

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use serde_json::{json, Value};
use tokio::sync::oneshot::Sender;

use crate::error::CoreError;

/// 一次反向调用的默认等待上限。宿主 handler 都是毫秒级（注入图片 / 跑工具由外层 RPC 计时），
/// 30s 只是「宿主死了别把 core 一起拖死」的上限。
pub const HOST_CALL_TIMEOUT_MS: u64 = 30_000;

type Pending = Arc<Mutex<HashMap<u64, Sender<Result<Value, CoreError>>>>>;

static PENDING: OnceLock<Pending> = OnceLock::new();
static NEXT_ID: AtomicU64 = AtomicU64::new(1);

fn pending() -> &'static Pending {
    PENDING.get_or_init(|| Arc::new(Mutex::new(HashMap::new())))
}

/// 发起一次反向调用，等宿主答复。
pub async fn call_host(method: &str, params: Value) -> Result<Value, CoreError> {
    call_host_with_timeout(method, params, HOST_CALL_TIMEOUT_MS).await
}

pub async fn call_host_with_timeout(
    method: &str,
    params: Value,
    timeout_ms: u64,
) -> Result<Value, CoreError> {
    if !super::events::enabled() {
        // 没有宿主通道（`dieyun-core index` 这类一次性命令）：直接报不可用，
        // 而不是发出一条永远没人回的行然后等到超时。
        return Err(CoreError::rpc(
            "HOST_UNAVAILABLE",
            format!("没有宿主通道，无法反向调用 {method}"),
        ));
    }
    let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
    let (tx, rx) = tokio::sync::oneshot::channel();
    {
        let mut map = pending()
            .lock()
            .map_err(|_| CoreError::rpc("HOST_CALL", "pending 表锁中毒"))?;
        map.insert(id, tx);
    }
    // 交给 stdout 写者（事件通道与响应共用一条输出，顺序由写锁保证）
    super::events::emit(
        "host.call",
        json!({ "id": id, "method": method, "params": params }),
    );
    match tokio::time::timeout(Duration::from_millis(timeout_ms), rx).await {
        Ok(Ok(result)) => result,
        Ok(Err(_)) => Err(CoreError::rpc(
            "HOST_CALL",
            format!("{method} 的等待端被丢弃"),
        )),
        Err(_) => {
            if let Ok(mut map) = pending().lock() {
                map.remove(&id);
            }
            Err(CoreError::rpc(
                "HOST_CALL_TIMEOUT",
                format!("{method} 超过 {timeout_ms}ms 没有答复（宿主没接这条反向调用？）"),
            ))
        }
    }
}

/// 宿主答复到达：`result` 与 `error` 二选一。
pub fn resolve_reply(id: u64, result: Option<Value>, error: Option<Value>) {
    let tx = pending().lock().ok().and_then(|mut map| map.remove(&id));
    let Some(tx) = tx else {
        // 超时后才到的答复：丢掉即可（调用方早已按超时收场）
        return;
    };
    let outcome = match (result, error) {
        (_, Some(err)) => {
            let code = err
                .get("code")
                .and_then(|c| c.as_str())
                .unwrap_or("HOST_CALL_FAILED")
                .to_string();
            let message = err
                .get("message")
                .and_then(|m| m.as_str())
                .unwrap_or("宿主返回错误")
                .to_string();
            Err(CoreError::rpc(
                "HOST_CALL_FAILED",
                format!("{code}: {message}"),
            ))
        }
        (Some(result), None) => Ok(result),
        (None, None) => Ok(Value::Null),
    };
    let _ = tx.send(outcome);
}

/// 当前在等的反向调用数（诊断用；`core.host_probe` 与将来 run 的看门狗都读它）。
pub fn pending_count() -> usize {
    pending().lock().map(|m| m.len()).unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reply_with_error_becomes_rpc_error() {
        let (tx, rx) = tokio::sync::oneshot::channel::<Result<Value, CoreError>>();
        pending().lock().unwrap().insert(9001, tx);
        resolve_reply(
            9001,
            None,
            Some(json!({"code": "HOST_BOOM", "message": "宿主炸了"})),
        );
        let outcome = futures_free_recv(rx);
        match outcome {
            Err(CoreError::Rpc { code, message }) => {
                // 分类码固定（`CoreError::rpc` 只收 &'static str），宿主给的码进 detail：
                // 「谁的锅」仍可查，只是不再当错误码用。
                assert_eq!(code, "HOST_CALL_FAILED");
                assert!(message.contains("HOST_BOOM"), "detail 要带宿主码：{message}");
                assert!(message.contains("宿主炸了"));
            }
            other => panic!("应为 Rpc 错误，实际 {other:?}"),
        }
        assert_eq!(pending_count(), 0, "答复到达后必须从表里摘掉");
    }

    #[test]
    fn reply_with_result_is_ok_and_unknown_id_is_ignored() {
        let (tx, rx) = tokio::sync::oneshot::channel::<Result<Value, CoreError>>();
        pending().lock().unwrap().insert(9002, tx);
        resolve_reply(9002, Some(json!({"messages": []})), None);
        assert!(matches!(futures_free_recv(rx), Ok(v) if v["messages"].is_array()));
        // 迟到 / 未知 id：不能 panic，也不能留在表里
        resolve_reply(999_999, Some(json!({})), None);
        assert_eq!(pending_count(), 0);
    }

    /// 同步取 oneshot 结果（测试里不需要 async 运行时）
    fn futures_free_recv(
        rx: tokio::sync::oneshot::Receiver<Result<Value, CoreError>>,
    ) -> Result<Value, CoreError> {
        match rx.blocking_recv() {
            Ok(v) => v,
            Err(_) => panic!("sender 应已发送"),
        }
    }
}
