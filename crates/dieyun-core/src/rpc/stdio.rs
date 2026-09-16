use std::sync::Arc;

use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::{mpsc, Mutex};
use tokio::task::LocalSet;

use super::{AppState, RpcRequest, RpcResponse};
use crate::error::CoreError;

/// JSON-RPC over stdin/stdout。
/// 在独立 current-thread + LocalSet 上并发处理请求，使 `*.status` / `*.index.start`
/// 不被同步的 `codebase.index` / `graph.index` 堵住（rusqlite Connection 非 Send，不能直接 tokio::spawn）。
pub async fn serve_stdio(state: AppState) -> anyhow::Result<()> {
    let (tx, mut rx) = mpsc::unbounded_channel::<String>();
    let worker = std::thread::Builder::new()
        .name("dieyun-core-rpc".into())
        .spawn(move || {
            let rt = match tokio::runtime::Builder::new_current_thread().enable_all().build() {
                Ok(rt) => rt,
                Err(e) => {
                    eprintln!("dieyun-core rpc runtime failed: {e}");
                    return;
                }
            };
            let local = LocalSet::new();
            local.block_on(&rt, async move {
                let stdout = Arc::new(Mutex::new(tokio::io::stdout()));
                while let Some(raw) = rx.recv().await {
                    let state = state.clone();
                    let stdout = stdout.clone();
                    tokio::task::spawn_local(async move {
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
    match state.dispatch(&req.method, req.params).await {
        Ok(result) => RpcResponse::ok(req.id, result),
        Err(err) => RpcResponse::err(req.id, err.into()),
    }
}

/// 同步 stdin 模式（便于单元测试与非 tokio 宿主）
pub fn serve_stdio_sync(state: AppState) -> anyhow::Result<()> {
    let rt = tokio::runtime::Runtime::new()?;
    rt.block_on(serve_stdio(state))
}
