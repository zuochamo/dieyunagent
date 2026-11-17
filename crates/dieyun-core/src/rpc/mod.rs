use std::sync::Arc;

use serde_json::Value;
use tokio::sync::RwLock;

use crate::agent::AgentLoopManager;
use crate::blocking::run_blocking;
use crate::config::AppConfig;
use crate::error::{CoreError, RpcErrorBody};
use crate::graph::{GraphScope, GraphService};
use crate::index::IndexService;
use crate::memory;
use crate::planner::PlannerRunManager;
use crate::sqlite::SqliteHandle;
use self::registry::Impl;
use serde_json::json;

pub mod calls;
pub mod events;
pub mod handlers;
pub mod registry;
pub mod stdio;

/// 架构约束守卫：`AppState` 必须可跨线程共享，RPC 才能在多线程运行时上 `tokio::spawn`。
/// 断言失败说明某个服务重新引入了裸 `Connection` 等 `!Sync` 字段——那会把整个状态机拖回单线程。
#[allow(dead_code)]
fn _assert_app_state_is_send_sync() {
    fn assert_send_sync<T: Send + Sync>() {}
    assert_send_sync::<AppState>();
}

/// core 内部耗时超过这个值就打一行 `[rpc-slow] <method> <ms>` 到 stderr。
///
/// 数值唯一来源是 `assets/agent-shared.json` 的 `rpc.slowLogMs`（Node 侧
/// `core-rpc-timeouts.js:SLOW_RPC_LOG_MS` 读同一份）：两侧都记才能分辨「core 内部慢」
/// 还是「RPC 堵在管道 / 守护进程 / SSH 里」—— `memory.long_recall` 那两次 120s 超时
/// 就是缺了这组对照，只能瞎猜。这不是超时机制（不掐断、不重试）。
pub fn slow_rpc_log_ms() -> u64 {
    crate::shared::shared().rpc.slow_log_ms
}

#[derive(Clone)]
pub struct AppState {
    pub(crate) inner: Arc<RwLock<StateInner>>,
}

pub(crate) struct StateInner {
    pub(crate) config: AppConfig,
    /// codebase.db 的唯一句柄：index / graph 共享同一条常驻连接。
    ///
    /// 存在这里是为了让配置热更新能在库文件没变时**复用**它——
    /// 否则每次 configure 都会另开一条连接，旧的随服务一起被 drop，
    /// 在异步写锁上同步做一次 WAL checkpoint。
    pub(crate) codebase_db: Arc<SqliteHandle>,
    pub(crate) index: IndexService,
    pub(crate) graph: GraphService,
    pub(crate) memory: memory::MemoryStore,
    /// 账本管理器包一层 `Arc`：`agent.run` 的驱动器要在**不持锁**的情况下跑完一整轮
    /// （里面有一次 HTTP），持锁跑会把 `core.configure` 卡住整整一轮对话。
    pub(crate) agent: Arc<AgentLoopManager>,
    pub(crate) planner: PlannerRunManager,
}

/// 阻塞 RPC 分支的执行上下文。
///
/// 它存在的唯一理由：`spawn_blocking` 要求闭包 `Send + 'static`，不能借用 `AppState`。
/// 于是把「同步世界需要的东西」先克隆成快照：在 `inner` 读锁下只做 `Arc` 克隆
/// （微秒级），锁一放，剩下全部时间都在阻塞池里跑。这样做同时拿到两个好处——
/// 一次全表扫描不再压在 async worker 上，也不会攥着读锁挡住 `core.configure` 这类写路径。
///
/// 只装**阻塞分支真正会用到**的服务：`agent` / `planner` 的循环账本方法都是纯内存操作，
/// 留在 `AppState::dispatch` 的 async 分支里，不进这个快照。
#[derive(Clone)]
pub(crate) struct ServiceSnapshot {
    pub(crate) config: AppConfig,
    pub(crate) index: IndexService,
    pub(crate) graph: GraphService,
    pub(crate) memory: memory::MemoryStore,
}

/// 架构约束守卫：快照必须能整体移动到阻塞池，否则 [`run_blocking`] 的调用点无法成立。
#[allow(dead_code)]
fn _assert_snapshot_is_send_static() {
    fn assert_send_static<T: Send + 'static>() {}
    assert_send_static::<ServiceSnapshot>();
}

impl StateInner {
    /// 取一份服务句柄快照。各字段内部都是 `Arc`，克隆廉价且立即释放读锁。
    fn snapshot(&self) -> ServiceSnapshot {
        ServiceSnapshot {
            config: self.config.clone(),
            index: self.index.clone(),
            graph: self.graph.clone(),
            memory: self.memory.clone(),
        }
    }
}

/// 结构索引的建库范围（R5 的唯一解析点）。
///
/// `calls` 缺省 **false**：符号 + import + mtime 是 `repo_map` / `find_symbol` /
/// `module_deps` 的底座，必须常建；调用关系只有 `callers` / `callees` / `impact`
/// 用得到，由调用方按需打开（传 `calls: true`）。
pub(crate) fn graph_scope_from_params(params: &Value) -> GraphScope {
    let with_calls = params
        .get("calls")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    if with_calls {
        GraphScope::WithCalls
    } else {
        GraphScope::Structural
    }
}

fn same_path(a: &std::path::Path, b: &std::path::Path) -> bool {
    if a == b {
        return true;
    }
    let na = a.canonicalize().unwrap_or_else(|_| a.to_path_buf());
    let nb = b.canonicalize().unwrap_or_else(|_| b.to_path_buf());
    na == nb
}

impl AppState {
    pub fn new(config: AppConfig) -> Self {
        // 索引与图谱落在同一个库文件上，共用同一条常驻连接。
        let codebase_db = crate::codebase_db::handle(config.codebase_db_path());
        let index = IndexService::from_config(&config, Arc::clone(&codebase_db));
        let graph = GraphService::new(Arc::clone(&codebase_db));
        let memory = memory::MemoryStore::from_config(&config)
            .unwrap_or_else(|e| panic!("memory store init failed: {e}"));
        Self {
            inner: Arc::new(RwLock::new(StateInner {
                config,
                codebase_db,
                index,
                graph,
                memory,
                agent: Arc::new(AgentLoopManager::default()),
                planner: PlannerRunManager::default(),
            })),
        }
    }

    /// 在兼容 async 语义的前提下取出服务快照（读锁只覆盖克隆那几行）。
    pub(crate) async fn snapshot(&self) -> ServiceSnapshot {
        self.inner.read().await.snapshot()
    }

    /// RPC 总入口。**路由以 [`registry::METHODS`] 为准**，这里的 `match` 只是执行体：
    ///
    /// 1. 表里标 `Async` 的（LLM、embedding、索引任务、事件推送）在本函数里 `.await`；
    /// 2. 表里标 `Blocking` 的（`rusqlite` 查询、文件读写、压缩计算）交给
    ///    [`ServiceSnapshot::dispatch`]，在阻塞线程池上执行 —— 判断标准是「这段代码会不会
    ///    把线程钉住」，不是「属于哪个模块」。
    ///
    /// 未知方法在这里就回 `UNKNOWN_METHOD`，不再落到兜底分支里「顺手当成阻塞方法」。
    /// 表、实现、路由三者的对应关系由 `registry.rs` 末尾的 parity 测试静态校验。
    pub async fn dispatch(
        &self,
        method: &str,
        params: serde_json::Value,
    ) -> Result<serde_json::Value, CoreError> {
        let Some(spec) = registry::find(method) else {
            return Err(registry::unknown_method(method));
        };
        // 路由、实现、预算全部来自方法表（`registry.rs`）。
        // 这里不再有 `match method`：方法名只存在于表里，实现只存在于 `handlers/` 与表中。
        match spec.imp {
            Impl::Async(handler) => handler(self, &params).await,
            Impl::Blocking(handler) => {
                // 快照在锁下只做 Arc 克隆；整段工作交给阻塞池，async worker 不被钉住。
                let snap = self.snapshot().await;
                run_blocking(move || handler(&snap, &params)).await
            }
        }
    }
}

#[derive(Debug, serde::Deserialize)]
pub struct RpcRequest {
    pub id: serde_json::Value,
    pub method: String,
    #[serde(default)]
    pub params: serde_json::Value,
}

// ---- `agent.run.*` 的装配与收口（驱动器在 `agent::driver`）----

pub(crate) fn drive_spec(params: &Value) -> Result<crate::agent::driver::DriveSpec, CoreError> {
    let url = params
        .get("url")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    if url.is_empty() {
        return Err(CoreError::rpc("INVALID_PARAMS", "url 必填"));
    }
    let content_channel = params
        .get("contentChannel")
        .cloned()
        .map(serde_json::from_value)
        .transpose()
        .map_err(|e| CoreError::rpc("INVALID_PARAMS", format!("contentChannel 非法: {e}")))?
        .unwrap_or_default();
    Ok(crate::agent::driver::DriveSpec {
        url,
        stream: params.get("stream").and_then(|v| v.as_bool()).unwrap_or(true),
        content_channel,
        include_raw: params
            .get("includeRaw")
            .and_then(|v| v.as_bool())
            .unwrap_or(false),
    })
}

pub(crate) async fn drive_llm_config(params: &Value, state: &AppState) -> Result<crate::config::LlmConfig, CoreError> {
    match params.get("llm").cloned() {
        Some(value) => serde_json::from_value(value)
            .map_err(|e| CoreError::rpc("INVALID_PARAMS", format!("llm 非法: {e}"))),
        None => Ok(state.snapshot().await.config.llm),
    }
}

/// 驱动器停点 → RPC 响应。`need_tools` 是「把执行权交回宿主」，不是错误。
pub(crate) fn finish_drive(result: Result<crate::agent::driver::DriveStop, CoreError>) -> Result<Value, CoreError> {
    match result? {
        crate::agent::driver::DriveStop::NeedTools { response, delegates } => Ok(json!({
            "phase": "need_tools",
            "runId": response.run_id,
            "delegates": delegates,
            // 折叠事实必须一起回去：工具轮之前折过的那次，Node 的遥测/归档只能从这里拿
            "compacted": response.compacted,
        })),
        crate::agent::driver::DriveStop::Done(response) => Ok(serde_json::to_value(response)?),
    }
}

#[derive(Debug, serde::Serialize)]
pub struct RpcResponse {
    pub id: serde_json::Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<RpcErrorBody>,
}

impl RpcResponse {
    pub fn ok(id: serde_json::Value, result: serde_json::Value) -> Self {
        Self {
            id,
            result: Some(result),
            error: None,
        }
    }

    pub fn err(id: serde_json::Value, error: RpcErrorBody) -> Self {
        Self {
            id,
            result: None,
            error: Some(error),
        }
    }
}

/// 测试支撑：handler 单测需要一个 `&ServiceSnapshot`，但不想起整个 `AppState`
/// （`AppState::new` 会建目录、开库、装配服务；handler 只关心自己那几个字段）。
#[cfg(test)]
pub(crate) mod tests_support {
    use super::*;

    pub(crate) fn snapshot(dir: &std::path::Path) -> ServiceSnapshot {
        ServiceSnapshot {
            config: AppConfig::default(),
            index: IndexService::new(
                crate::codebase_db::handle(dir.join("idx.sqlite")),
                crate::embedding::EmbeddingConfig::default(),
            ),
            graph: GraphService::new(crate::codebase_db::handle(dir.join("graph.sqlite"))),
            memory: memory::MemoryStore::open(
                dir.join("memory.sqlite"),
                crate::embedding::EmbeddingConfig::default(),
            )
            .expect("memory store 建不起来"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 预算与路由的唯一来源是 `registry.rs` 的方法表 —— 这里只留一条「表里没有就不设预算」。
    #[test]
    fn budget_comes_from_the_registry_table() {
        assert_eq!(
            registry::find("core.ping").and_then(|s| s.budget.ms()),
            Some(registry::FAST_METHOD_BUDGET_MS)
        );
        assert_eq!(registry::find("codebase.index").and_then(|s| s.budget.ms()), None);
        assert!(registry::find("memory.status").is_none(), "memory.status 从来没实现过");
    }

    /// **可达性** parity：表里每一个方法都必须真的走到实现，一个也不许回 `UNKNOWN_METHOD`。
    ///
    /// 静态 parity（表 ↔ 源码）只能证明「名字对得上」；这条是端到端那条 —— 它抓到的是
    /// 「表里写了 handler，但路由分支没接上」这类只在运行期才现形的问题。
    /// 参数一律传 `{}`：缺参导致的 `INVALID_PARAMS` 属正常，只有「未知方法 / 没接实现」才算失败。
    #[tokio::test]
    async fn every_registered_method_reaches_an_implementation() {
        let dir = tempfile::tempdir().unwrap();
        let cfg = AppConfig {
            data_dir: dir.path().to_path_buf(),
            ..AppConfig::default()
        };
        let state = AppState::new(cfg);
        for spec in registry::METHODS {
            let err = match state.dispatch(spec.name, json!({})).await {
                Ok(_) => continue,
                Err(err) => format!("{err}"),
            };
            assert!(
                !err.contains("未知 RPC") && !err.contains("没有实现"),
                "{} 在表里，却走不到实现：{err}",
                spec.name
            );
        }
    }
}
