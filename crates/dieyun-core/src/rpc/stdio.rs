use std::sync::Arc;

use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::{mpsc, Mutex};

use super::{AppState, RpcRequest, RpcResponse};
use crate::error::CoreError;

/// JSON-RPC over stdin/stdout。
///
/// 在**多线程**运行时上并发处理请求。此前的 current-thread + LocalSet 建立在
/// 「rusqlite Connection 非 Send，不能直接 tokio::spawn」这一错误前提上：
/// `rusqlite::Connection` 其实是 `Send`（仅 `!Sync`），被 `Mutex` 包住后
/// `SqliteHandle` / `MemoryStore` / `AppState` 全部 `Send + Sync`
/// （由 `rpc::_assert_app_state_is_send_sync` 钉住）。
///
/// 单线程运行时的真实代价是：任意一处同步 SQLite 都会冻结整条线程，连带冻住
/// 所有并发 subagent 的 `agent.loop.*`。多线程解除了这层天花板，但**不替代**
/// 把同步 DB 段移出 async worker 的工作——那由 `blocking::run_blocking` 统一承担。
pub async fn serve_stdio(state: AppState) -> anyhow::Result<()> {
    let (tx, mut rx) = mpsc::unbounded_channel::<String>();
    let worker = std::thread::Builder::new()
        .name("dieyun-core-rpc".into())
        .spawn(move || {
            let rt = match tokio::runtime::Builder::new_multi_thread().enable_all().build() {
                Ok(rt) => rt,
                Err(e) => {
                    eprintln!("dieyun-core rpc runtime failed: {e}");
                    return;
                }
            };
            rt.block_on(async move {
                let stdout = Arc::new(Mutex::new(tokio::io::stdout()));
                while let Some(raw) = rx.recv().await {
                    let state = state.clone();
                    let stdout = stdout.clone();
                    tokio::spawn(async move {
                        let response = match serde_json::from_str::<RpcRequest>(&raw) {
                            Ok(req) => handle_request(&state, req).await,
                            Err(err) => RpcResponse::err(
                                serde_json::Value::Null,
                                CoreError::rpc("INVALID_REQUEST", err.to_string()).into(),
                            ),
                        };
                        if let Ok(out) = serde_json::to_string(&response) {
                            let mut guard = stdout.lock().await;
                            let _ = guard.write_all((out + "\n").as_bytes()).await;
                            let _ = guard.flush().await;
                        }
                    });
                }
            });
        })?;

    let stdin = tokio::io::stdin();
    let mut reader = BufReader::new(stdin);
    let mut line = String::new();
    loop {
        line.clear();
        let n = reader.read_line(&mut line).await?;
        if n == 0 {
            break;
        }
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        if tx.send(trimmed.to_string()).is_err() {
            break;
        }
    }
    drop(tx);
    let _ = worker.join();
    Ok(())
}

async fn handle_request(state: &AppState, req: RpcRequest) -> RpcResponse {
    let method = req.method.clone();
    let dispatched = state.dispatch(&req.method, req.params);
    // 预算只加在宿主轮询类方法上（见 `request_budget_ms` 的取舍说明）。
    let result = match super::request_budget_ms(&method) {
        Some(budget) => {
            match tokio::time::timeout(std::time::Duration::from_millis(budget), dispatched).await {
                Ok(r) => r,
                Err(_) => Err(CoreError::rpc(
                    "RPC_TIMEOUT",
                    format!("{method} 超过 {budget}ms 在途预算（core 正忙于长任务）"),
                )),
            }
        }
        None => dispatched.await,
    };
    match result {
        Ok(result) => RpcResponse::ok(req.id, result),
        Err(err) => RpcResponse::err(req.id, err.into()),
    }
}

/// 同步 stdin 模式（便于单元测试与非 tokio 宿主）
pub fn serve_stdio_sync(state: AppState) -> anyhow::Result<()> {
    let rt = tokio::runtime::Runtime::new()?;
    rt.block_on(serve_stdio(state))
}
