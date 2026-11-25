use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::{mpsc, Mutex};

use super::{AppState, RpcRequest, RpcResponse};
use dieyun_base::error::CoreError;

/// stdout 是否还活着。
///
/// 写失败（EPIPE）的**唯一**含义是宿主进程没了：这时 core 再跑下去也不会有人读到结果，
/// 只会白烧 token。旧实现三处写全是 `let _ =`，于是宿主崩了之后 core 还在跑完整条 run，
/// 而宿主那边只能等自己的超时 —— 连一行错误都没有。
static STDOUT_ALIVE: AtomicBool = AtomicBool::new(true);

/// 驱动循环据此收手（见 `agent::driver::drive`）。
pub(crate) fn stdout_alive() -> bool {
    STDOUT_ALIVE.load(Ordering::Relaxed)
}

fn mark_stdout_dead(err: &str) {
    if STDOUT_ALIVE.swap(false, Ordering::Relaxed) {
        dieyun_base::obs::io_error("stdout", err);
    }
}

/// 写一行（自带换行）到共用 stdout；`false` = 对端已断，调用方应收手。
async fn write_json_line<W>(writer: &Mutex<W>, text: &str) -> bool
where
    W: tokio::io::AsyncWrite + Unpin,
{
    let mut guard = writer.lock().await;
    match write_line(&mut *guard, text).await {
        Ok(()) => true,
        Err(err) => {
            mark_stdout_dead(&err);
            false
        }
    }
}

/// 真正的写：`write_all` + `flush` 都算一次尝试（半截写出去同样等于断）。
async fn write_line<W>(writer: &mut W, text: &str) -> Result<(), String>
where
    W: tokio::io::AsyncWrite + Unpin,
{
    writer
        .write_all(format!("{text}\n").as_bytes())
        .await
        .map_err(|e| e.to_string())?;
    writer.flush().await.map_err(|e| e.to_string())
}

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
    // core → 宿主的事件通道（流式增量等）：与响应共用 stdout，但用 `type:"event"` 区分。
    let (event_tx, mut event_rx) = mpsc::unbounded_channel::<serde_json::Value>();
    super::events::install(event_tx);
    let worker = std::thread::Builder::new()
        .name("dieyun-core-rpc".into())
        .spawn(move || {
            let rt = match tokio::runtime::Builder::new_multi_thread().enable_all().build() {
                Ok(rt) => rt,
                Err(e) => {
                    dieyun_base::obs::io_error("rpc-runtime", &e.to_string());
                    return;
                }
            };
            rt.block_on(async move {
                let stdout = Arc::new(Mutex::new(tokio::io::stdout()));
                // 事件写者：独立任务，避免与响应抢锁时把流式增量憋在队列里
                let event_stdout = Arc::clone(&stdout);
                tokio::spawn(async move {
                    while let Some(event) = event_rx.recv().await {
                        // 反向调用走**自己的一种行**（`type:"call"`），宿主按 type 分流：
                        // 包在 `type:"event"` 里宿主会当通知丢掉，永远等不到答复。
                        let line = if event.get("type").and_then(|t| t.as_str()) == Some("host.call") {
                            serde_json::json!({
                                "type": "call",
                                "id": event.get("id"),
                                "method": event.get("method"),
                                "params": event.get("params"),
                            })
                        } else {
                            serde_json::json!({ "type": "event", "event": event })
                        };
                        // 序列化失败不能静默丢事件：换成一条可读的 `core.error` 再写，
                        // 否则宿主那边只会看到「流式增量忽然停了」，没有任何原因。
                        let text = match serde_json::to_string(&line) {
                            Ok(text) => text,
                            Err(err) => serde_json::json!({
                                "type": "event",
                                "event": {
                                    "type": "core.error",
                                    "message": format!("事件序列化失败：{err}"),
                                },
                            })
                            .to_string(),
                        };
                        if !write_json_line(&event_stdout, &text).await {
                            // 写不出去 = 宿主没了，这条通道再写也没人读。
                            break;
                        }
                    }
                });
                while let Some(raw) = rx.recv().await {
                    let state = state.clone();
                    let stdout = stdout.clone();
                    tokio::spawn(async move {
                        // 宿主对反向调用的答复：`{"type":"reply","id":N,"result"|"error"}`。
        // 它不是任何请求的响应，必须在解析成 RpcRequest 之前拦掉。
        if let Ok(value) = serde_json::from_str::<serde_json::Value>(&raw) {
            if value.get("type").and_then(|t| t.as_str()) == Some("reply") {
                if let Some(id) = value.get("id").and_then(|v| v.as_u64()) {
                    super::calls::resolve_reply(
                        id,
                        value.get("result").cloned(),
                        value.get("error").cloned(),
                    );
                }
                return;
            }
        }
        let response = match serde_json::from_str::<RpcRequest>(&raw) {
                            Ok(req) => handle_request(&state, req).await,
                            Err(err) => RpcResponse::err(
                                serde_json::Value::Null,
                                CoreError::rpc("INVALID_REQUEST", err.to_string()).into(),
                            ),
                        };
                        let out = match serde_json::to_string(&response) {
                            Ok(out) => out,
                            // 响应序列化失败也要回一帧错误：否则宿主拿不到任何答复，
                            // 只能等自己的超时，而 core 侧 stderr 一行都没有。
                            Err(err) => serde_json::to_string(&RpcResponse::err(
                                serde_json::Value::Null,
                                CoreError::rpc(
                                    "INVALID_RESPONSE",
                                    format!("响应序列化失败：{err}"),
                                )
                                .into(),
                            ))
                            .unwrap_or_else(|_| {
                                "{\"jsonrpc\":\"2.0\",\"error\":{\"code\":\"INVALID_RESPONSE\"}}"
                                    .to_string()
                            }),
                        };
                        write_json_line(&stdout, &out).await;
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
    let started = std::time::Instant::now();
    let dispatched = state.dispatch(&req.method, req.params);
    // 预算只加在宿主轮询类方法上；档位与数值的唯一来源是 `registry.rs` 的方法表。
    let result = match super::registry::find(&method).and_then(|spec| spec.budget.ms()) {
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
    // 慢请求落 stderr（宿主会把 core 的 stderr 收进 main.log）。
    //
    // 为什么必须有这一行：`memory.long_recall` 曾连续两次在建库窗口里撞上宿主的
    // 120s 预算，但**无从判断它卡在哪**——core 侧没有任何耗时记录，只能凭猜。
    // 有了这条「core 内部耗时」，与宿主侧同一请求的端到端耗时一减，就能定位是
    // 「core 真慢」还是「RPC 堵在传输/守护进程里」，不必再靠推理。
    let elapsed_ms = started.elapsed().as_millis() as u64;
    if elapsed_ms >= super::slow_rpc_log_ms() {
        // 唯一一条慢日志：格式与阈值都在 `obs.rs` / `src/agent/agent-shared.json`。
        dieyun_base::obs::rpc_slow(&method, elapsed_ms, super::slow_rpc_log_ms());
    }
    match result {
        Ok(result) => RpcResponse::ok(req.id, result),
        Err(err) => RpcResponse::err(req.id, err.into()),
    }
}


#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Error, ErrorKind};
    use std::pin::Pin;
    use std::task::{Context, Poll};

    /// 一个「写就断」的 writer：模拟宿主进程消失后的 EPIPE。
    struct BrokenPipe;

    impl tokio::io::AsyncWrite for BrokenPipe {
        fn poll_write(
            self: Pin<&mut Self>,
            _cx: &mut Context<'_>,
            _buf: &[u8],
        ) -> Poll<std::io::Result<usize>> {
            Poll::Ready(Err(Error::new(ErrorKind::BrokenPipe, "broken pipe")))
        }
        fn poll_flush(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
            Poll::Ready(Ok(()))
        }
        fn poll_shutdown(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
            Poll::Ready(Ok(()))
        }
    }

    /// 写不出去必须**上报**：旧实现是 `let _ =`，宿主已死之后 core 还在跑完整条 run，
    /// 宿主那边只能等自己的超时，而 stderr 一行都没有。
    #[tokio::test]
    async fn write_failure_is_reported_not_swallowed() {
        let mut writer = BrokenPipe;
        let err = write_line(&mut writer, "{}")
            .await
            .expect_err("broken pipe 必须上报");
        assert!(err.contains("broken pipe"), "{err}");
    }

    /// 断了之后 `stdout_alive()` 变假 —— 驱动循环据此停止发请求。
    #[tokio::test]
    async fn broken_stdout_flips_the_liveness_flag() {
        let mut writer = BrokenPipe;
        let err = write_line(&mut writer, "{}").await.expect_err("必须报错");
        mark_stdout_dead(&err);
        assert!(!stdout_alive());
        // 同进程其它用例共用这个开关，测完复位。
        STDOUT_ALIVE.store(true, Ordering::Relaxed);
        assert!(stdout_alive());
    }
}
