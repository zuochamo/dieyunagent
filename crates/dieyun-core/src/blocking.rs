//! 同步世界与 async worker 之间的**唯一**桥接。
//!
//! `dieyun-core` 的 RPC 层是 async 的，但它底下挂着的是同步世界：`rusqlite` 查询、
//! 文件读写、压缩的字符串处理都会把当前线程钉住。在 async worker 上直接跑这些代码，
//! 等于用别人的一个全表扫描去挤占运行时的执行线程——并发 subagent 一多，
//! 每个 `agent.loop.*` 都要排在别人的 SQLite 后面。
//!
//! 这里只提供一件事：把 `FnOnce() -> Result<T, CoreError>` 搬到 tokio 阻塞线程池。
//! 所有需要桥接的地方都走它，于是「用什么错误码、join 失败怎么兜」只有一份实现。
//!
//! 有意不做的事：不接收 `&mut`、不借用调用方的状态。闭包必须 `Send + 'static`，
//! 这迫使调用方先把要用的句柄克隆成快照、放掉 async 侧的锁，再进阻塞池。

use crate::error::CoreError;

/// 在 tokio 阻塞线程池上执行 `f`，返回它的结果。
///
/// # Panics
/// 不 panic。任务 panic 只会以 `BLOCKING_JOIN_FAILED` 形式变成 RPC 错误——阻塞池里
/// 的一次 panic 不该带走整个 sidecar，更不该毒化 `AppState`。
///
/// # 调用约束
/// 闭包只能捕获 `Send + 'static` 的**快照**（克隆出来的服务句柄、`String`、`Value`）。
/// 需要借用 `AppState` / 持锁才能拿到的值，调用方必须先克隆出来。
pub async fn run_blocking<T, F>(f: F) -> Result<T, CoreError>
where
    F: FnOnce() -> Result<T, CoreError> + Send + 'static,
    T: Send + 'static,
{
    tokio::task::spawn_blocking(f)
        .await
        .map_err(|e| CoreError::rpc("BLOCKING_JOIN_FAILED", e.to_string()))?
}
