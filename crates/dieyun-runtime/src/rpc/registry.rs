//! RPC 方法表：**唯一**的「有哪些方法 / 谁阻塞 / 谁的预算多少」声明处。
//!
//! 为什么要有这张表：以前这三个知识分散在三处 —— 方法名在两条 `match` 里，
//! 「谁阻塞」靠「写在哪个 match 里」表达（审计原话：清单有两处，靠约定不靠机制），
//! 预算在 `request_budget_ms`，而 Node 侧还有第三份超时表。加一个方法要改三处，
//! 改错任何一处都不会让测试变红（历史事故：`llm.complete` 漏出超时表，长回答 120s 就
//! reject，而 core 按 600s 还在流）。
//!
//! 现在的规则：
//! - 加方法 = 在 [`METHODS`] 加一行 + 实现落在对应的那条分派链里
//!   （`Async` → `AppState::dispatch`，`Blocking` → `ServiceSnapshot::dispatch`）；
//! - 两条分派链的 `match` 只是执行体，**路由与预算以本表为准**；
//! - 本文件末尾的 parity 测试直接扫 `mod.rs` 源码：表里有、实现没有 → 红；
//!   实现有、表里没有 → 红；路由标错（表说 Async 却实现在阻塞链）→ 红。

use dieyun_base::error::CoreError;
use crate::rpc::handlers;
use crate::rpc::{AppState, ServiceSnapshot};
use serde_json::Value;

/// async handler 的返回类型：`Send + 'a` 的装箱 future。
///
/// 为什么用装箱而不是 `async fn` 指针：Rust 里没有「async fn 指针」这种东西，
/// 而表需要把 27 个 async 方法收进同一个 `&'static [MethodSpec]`。
pub(crate) type BoxFuture<'a> = std::pin::Pin<
    Box<dyn std::future::Future<Output = Result<Value, CoreError>> + Send + 'a>,
>;

/// 阻塞型方法的实现签名：拿到服务快照与参数，同步返回。
///
/// 没有 `self`、没有 `.await`、没有全局状态 —— 所以既能被单测直接调用，也天生离得开
/// async worker（调用方把它扔进阻塞池）。
pub(crate) type BlockingHandler = fn(&ServiceSnapshot, &Value) -> Result<Value, CoreError>;

/// async 方法的实现签名：借用 `AppState`（要读锁 / 发事件 / 调 LLM）。
pub(crate) type AsyncHandler = for<'a> fn(&'a AppState, &'a Value) -> BoxFuture<'a>;

/// 一条方法的实现归属。**没有「还没实现」这个状态** —— 表里 86 行都必须填一个。
pub(crate) enum Impl {
    Async(AsyncHandler),
    Blocking(BlockingHandler),
}

/// 在途预算档位。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Budget {
    /// 宿主会反复轮询的方法（`core.ping` / `rpc.cancel` / `*.status`）：
    /// 卡住就要立刻说出来，而不是让宿主干等到自己的超时。
    Fast,
    /// 长任务（建库 / 检索 / 折叠 / LLM）：**刻意不设**预算 —— 掐断 awaiter 也停不下底下
    /// 已经跑起来的阻塞任务，只会制造「假失败」。减法优先：不为超时再造一层取消机制。
    None,
}

impl Budget {
    /// 毫秒；`None` = 不设预算。
    pub(crate) fn ms(self) -> Option<u64> {
        match self {
            Budget::Fast => Some(FAST_METHOD_BUDGET_MS),
            Budget::None => None,
        }
    }
}

/// 快读方法的在途预算（毫秒）。
///
/// 取值必须**小于**宿主侧最小超时（`src/core-rpc-timeouts.js` 的 15s），否则这条预算
/// 永远轮不到触发 —— 历史上这里是 20s > 宿主 15s，等于一段死代码。
pub(crate) const FAST_METHOD_BUDGET_MS: u64 = 10_000;

pub(crate) struct MethodSpec {
    pub(crate) name: &'static str,
    pub(crate) budget: Budget,
    /// 这条方法的实现在哪。类型上只有一个枚举值，**不存在「忘了接实现」这个状态**：
    /// 加方法时漏填 `imp` 编译就不过（旧设计里那是运行期 `UNKNOWN_METHOD`）。
    pub(crate) imp: Impl,
}

/// 全部 RPC 方法。**加方法只改这里**（外加在 `handlers/` 里写一个 `fn`）。
pub(crate) static METHODS: &[MethodSpec] = &[
    MethodSpec { name: "agent.ping", budget: Budget::None, imp: Impl::Async(handlers::async_core::agent_ping) },
    MethodSpec { name: "agent.plan_save", budget: Budget::None, imp: Impl::Blocking(handlers::agent::plan_save) },
    MethodSpec { name: "agent.run.cancel", budget: Budget::None, imp: Impl::Async(handlers::async_core::agent_run_cancel) },
    MethodSpec { name: "agent.run.start", budget: Budget::None, imp: Impl::Async(handlers::async_core::agent_run_start) },
    MethodSpec { name: "agent.run.tools", budget: Budget::None, imp: Impl::Async(handlers::async_core::agent_run_tools) },
    MethodSpec { name: "agent.run_upsert", budget: Budget::None, imp: Impl::Blocking(handlers::agent::run_upsert) },
    MethodSpec { name: "agent.state_get", budget: Budget::None, imp: Impl::Blocking(handlers::agent::state_get) },
    MethodSpec { name: "agent.steps_save", budget: Budget::None, imp: Impl::Blocking(handlers::agent::steps_save) },
    MethodSpec { name: "agent.trace_get", budget: Budget::None, imp: Impl::Blocking(handlers::agent::trace_get) },
    MethodSpec { name: "agent.trace_save", budget: Budget::None, imp: Impl::Blocking(handlers::agent::trace_save) },
    MethodSpec { name: "agent.traces_get", budget: Budget::None, imp: Impl::Blocking(handlers::agent::traces_get) },
    MethodSpec { name: "codebase.index", budget: Budget::None, imp: Impl::Async(handlers::async_data::codebase_index) },
    MethodSpec { name: "codebase.index.start", budget: Budget::None, imp: Impl::Blocking(handlers::codebase::index_start) },
    MethodSpec { name: "codebase.search", budget: Budget::None, imp: Impl::Async(handlers::async_data::codebase_search) },
    MethodSpec { name: "codebase.status", budget: Budget::Fast, imp: Impl::Blocking(handlers::codebase::status) },
    MethodSpec { name: "compaction.estimate", budget: Budget::None, imp: Impl::Blocking(handlers::system::estimate) },
    MethodSpec { name: "compaction.fold", budget: Budget::None, imp: Impl::Blocking(handlers::system::fold) },
    MethodSpec { name: "core.configure", budget: Budget::None, imp: Impl::Async(handlers::async_core::core_configure) },
    MethodSpec { name: "core.host_probe", budget: Budget::None, imp: Impl::Async(handlers::async_core::core_host_probe) },
    MethodSpec { name: "core.ping", budget: Budget::Fast, imp: Impl::Async(handlers::async_core::core_ping) },
    MethodSpec { name: "embedding.query", budget: Budget::None, imp: Impl::Async(handlers::async_core::embedding_query) },
    MethodSpec { name: "embedding.status", budget: Budget::Fast, imp: Impl::Blocking(handlers::system::embedding_status) },
    MethodSpec { name: "fs.list_dir", budget: Budget::None, imp: Impl::Blocking(handlers::fs::list_dir) },
    MethodSpec { name: "fs.read_file", budget: Budget::None, imp: Impl::Blocking(handlers::fs::read_file) },
    MethodSpec { name: "graph.callees", budget: Budget::None, imp: Impl::Blocking(handlers::graph::callees) },
    MethodSpec { name: "graph.callers", budget: Budget::None, imp: Impl::Blocking(handlers::graph::callers) },
    MethodSpec { name: "graph.impact", budget: Budget::None, imp: Impl::Blocking(handlers::graph::impact) },
    MethodSpec { name: "graph.index", budget: Budget::None, imp: Impl::Async(handlers::async_data::graph_index) },
    MethodSpec { name: "graph.index.start", budget: Budget::None, imp: Impl::Blocking(handlers::graph::index_start) },
    MethodSpec { name: "graph.ingest_lsp_callers", budget: Budget::None, imp: Impl::Blocking(handlers::graph::ingest_lsp_callers) },
    MethodSpec { name: "graph.module_deps", budget: Budget::None, imp: Impl::Blocking(handlers::graph::module_deps) },
    MethodSpec { name: "graph.repo_map", budget: Budget::None, imp: Impl::Blocking(handlers::graph::repo_map) },
    MethodSpec { name: "graph.status", budget: Budget::Fast, imp: Impl::Blocking(handlers::graph::status) },
    MethodSpec { name: "graph.symbol_search", budget: Budget::None, imp: Impl::Blocking(handlers::graph::symbol_search) },
    MethodSpec { name: "llm.complete", budget: Budget::None, imp: Impl::Async(handlers::async_core::llm_complete) },
    MethodSpec { name: "memory.compaction_archive", budget: Budget::None, imp: Impl::Blocking(handlers::memory::compaction_archive) },
    MethodSpec { name: "memory.compaction_folded", budget: Budget::None, imp: Impl::Blocking(handlers::memory::compaction_folded) },
    MethodSpec { name: "memory.compaction_recent", budget: Budget::None, imp: Impl::Blocking(handlers::memory::compaction_recent) },
    MethodSpec { name: "memory.consolidation_job_create", budget: Budget::None, imp: Impl::Blocking(handlers::memory::consolidation_job_create) },
    MethodSpec { name: "memory.consolidation_job_finish", budget: Budget::None, imp: Impl::Blocking(handlers::memory::consolidation_job_finish) },
    MethodSpec { name: "memory.handoff_get", budget: Budget::None, imp: Impl::Blocking(handlers::memory::handoff_get) },
    MethodSpec { name: "memory.handoff_latest", budget: Budget::None, imp: Impl::Blocking(handlers::memory::handoff_latest) },
    MethodSpec { name: "memory.handoff_save", budget: Budget::None, imp: Impl::Blocking(handlers::memory::handoff_save) },
    MethodSpec { name: "memory.handoff_take", budget: Budget::None, imp: Impl::Blocking(handlers::memory::handoff_take) },
    MethodSpec { name: "memory.long_add", budget: Budget::None, imp: Impl::Async(handlers::async_data::memory_long_add) },
    MethodSpec { name: "memory.long_add_many", budget: Budget::None, imp: Impl::Async(handlers::async_data::memory_long_add_many) },
    MethodSpec { name: "memory.long_by_session", budget: Budget::None, imp: Impl::Blocking(handlers::memory::long_by_session) },
    MethodSpec { name: "memory.long_decay", budget: Budget::None, imp: Impl::Blocking(handlers::memory::long_decay) },
    MethodSpec { name: "memory.long_forget_session", budget: Budget::None, imp: Impl::Blocking(handlers::memory::long_forget_session) },
    MethodSpec { name: "memory.long_keyword_search", budget: Budget::None, imp: Impl::Blocking(handlers::memory::long_keyword_search) },
    MethodSpec { name: "memory.long_memories_after", budget: Budget::None, imp: Impl::Blocking(handlers::memory::long_memories_after) },
    MethodSpec { name: "memory.long_recall", budget: Budget::None, imp: Impl::Async(handlers::async_data::memory_long_recall) },
    MethodSpec { name: "memory.long_recent", budget: Budget::None, imp: Impl::Blocking(handlers::memory::long_recent) },
    MethodSpec { name: "memory.long_reindex", budget: Budget::None, imp: Impl::Async(handlers::async_data::memory_long_reindex) },
    MethodSpec { name: "memory.long_status_set", budget: Budget::None, imp: Impl::Blocking(handlers::memory::long_status_set) },
    MethodSpec { name: "memory.long_vector_status", budget: Budget::None, imp: Impl::Blocking(handlers::memory::long_vector_status) },
    MethodSpec { name: "memory.message_append", budget: Budget::None, imp: Impl::Blocking(handlers::memory::message_append) },
    MethodSpec { name: "memory.messages_after", budget: Budget::None, imp: Impl::Blocking(handlers::memory::messages_after) },
    MethodSpec { name: "memory.messages_delete_turn", budget: Budget::None, imp: Impl::Blocking(handlers::memory::messages_delete_turn) },
    MethodSpec { name: "memory.messages_older", budget: Budget::None, imp: Impl::Blocking(handlers::memory::messages_older) },
    MethodSpec { name: "memory.messages_recent", budget: Budget::None, imp: Impl::Blocking(handlers::memory::messages_recent) },
    MethodSpec { name: "memory.messages_search", budget: Budget::None, imp: Impl::Blocking(handlers::memory::messages_search) },
    MethodSpec { name: "memory.ping", budget: Budget::None, imp: Impl::Blocking(handlers::memory::ping) },
    MethodSpec { name: "memory.project_alias_add", budget: Budget::None, imp: Impl::Blocking(handlers::memory::project_alias_add) },
    MethodSpec { name: "memory.project_list", budget: Budget::None, imp: Impl::Blocking(handlers::memory::project_list) },
    MethodSpec { name: "memory.project_resolve", budget: Budget::None, imp: Impl::Blocking(handlers::memory::project_resolve) },
    MethodSpec { name: "memory.request_snapshot_append", budget: Budget::None, imp: Impl::Blocking(handlers::memory::request_snapshot_append) },
    MethodSpec { name: "memory.request_snapshot_get", budget: Budget::None, imp: Impl::Blocking(handlers::memory::request_snapshot_get) },
    MethodSpec { name: "memory.request_snapshot_index_audit", budget: Budget::None, imp: Impl::Blocking(handlers::memory::request_snapshot_index_audit) },
    MethodSpec { name: "memory.request_snapshot_recent", budget: Budget::None, imp: Impl::Blocking(handlers::memory::request_snapshot_recent) },
    MethodSpec { name: "memory.session_archive", budget: Budget::None, imp: Impl::Blocking(handlers::memory::session_archive) },
    MethodSpec { name: "memory.session_create", budget: Budget::None, imp: Impl::Blocking(handlers::memory::session_create) },
    MethodSpec { name: "memory.session_delete", budget: Budget::None, imp: Impl::Blocking(handlers::memory::session_delete) },
    MethodSpec { name: "memory.session_get", budget: Budget::None, imp: Impl::Blocking(handlers::memory::session_get) },
    MethodSpec { name: "memory.session_goal_get", budget: Budget::None, imp: Impl::Blocking(handlers::memory::session_goal_get) },
    MethodSpec { name: "memory.session_goal_put", budget: Budget::None, imp: Impl::Blocking(handlers::memory::session_goal_put) },
    MethodSpec { name: "memory.session_set_title", budget: Budget::None, imp: Impl::Blocking(handlers::memory::session_set_title) },
    MethodSpec { name: "memory.session_workspace_set", budget: Budget::None, imp: Impl::Blocking(handlers::memory::session_workspace_set) },
    MethodSpec { name: "memory.sessions_list", budget: Budget::None, imp: Impl::Blocking(handlers::memory::sessions_list) },
    MethodSpec { name: "memory.sessions_with_messages", budget: Budget::None, imp: Impl::Blocking(handlers::memory::sessions_with_messages) },
    MethodSpec { name: "memory.touch_session", budget: Budget::None, imp: Impl::Blocking(handlers::memory::touch_session) },
    MethodSpec { name: "planner.ping", budget: Budget::None, imp: Impl::Async(handlers::async_core::planner_ping) },
    MethodSpec { name: "planner.run.cancel", budget: Budget::None, imp: Impl::Async(handlers::async_core::planner_run_cancel) },
    MethodSpec { name: "planner.run.continue", budget: Budget::None, imp: Impl::Async(handlers::async_core::planner_run_continue) },
    MethodSpec { name: "planner.run.start", budget: Budget::None, imp: Impl::Async(handlers::async_core::planner_run_start) },
    MethodSpec { name: "planner.run.worker_loop", budget: Budget::None, imp: Impl::Async(handlers::async_core::planner_run_worker_loop) },
    MethodSpec { name: "rpc.cancel", budget: Budget::Fast, imp: Impl::Async(handlers::async_core::rpc_cancel) },
];

/// 查表；未知方法返回 `None`（调用方负责回 `UNKNOWN_METHOD`）。
pub(crate) fn find(name: &str) -> Option<&'static MethodSpec> {
    METHODS.iter().find(|spec| spec.name == name)
}

/// 未知方法的统一错误：带上方法名，宿主能立刻看出是「调错了」而不是「core 挂了」。
pub(crate) fn unknown_method(method: &str) -> CoreError {
    CoreError::rpc("UNKNOWN_METHOD", format!("未知 RPC 方法：{method}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 两条分派链的源码（编译期嵌入，保证测的就是当前实现）。
    const MOD_SRC: &str = include_str!("mod.rs");

    #[test]
    fn table_has_no_duplicates() {
        let mut seen = std::collections::HashSet::new();
        for spec in METHODS {
            assert!(seen.insert(spec.name), "方法表里重复登记了 {}", spec.name);
        }
    }

    /// 表是唯一真相：分派链里**不许**再出现 `match method` 的方法名（迁完就该只剩查表）。
    ///
    /// 这条钉住「加方法漏登记」——旧实现里那会表现为运行期 `UNKNOWN_METHOD`，
    /// 而 `catch {}` 会把它吞掉（历史事故：`agent.loop.cancel`）。
    #[test]
    fn no_method_names_left_in_the_dispatch_chain() {
        let lines: Vec<&str> = MOD_SRC.lines().collect();
        let start = lines
            .iter()
            .position(|line| line.contains("pub async fn dispatch("))
            .expect("AppState::dispatch 找不到了");
        // dispatch 的收尾：签名之后第一条「正好 4 空格 + }」的行（`lines()` 已去掉 \r）
        let end = lines
            .iter()
            .skip(start)
            .position(|line| line.trim_end() == "    }")
            .map(|offset| start + offset)
            .expect("dispatch 的收尾找不到");
        let body = lines[start..=end].join("\n");
        for spec in METHODS {
            assert!(
                !body.contains(&format!("\"{}\"", spec.name)),
                "{} 还以字符串形式出现在 dispatch 里 —— 方法名只该在方法表里",
                spec.name
            );
        }
    }

    /// 回归（A14）：「体内只有 rusqlite、没有任何 `.await`」的方法必须留在**阻塞池**。
    ///
    /// 它们以前写成 `async fn` 壳（只是为了拿 `state.snapshot()`），真正的 SQLite 全压在
    /// async worker 上 —— 并发时连 `core.ping` 都要排队，面板显示「core 卡死」。
    /// 反面对照：`memory.long_recall` / `long_add*` / `long_reindex` 要等 embedding，必须是 Async。
    #[test]
    fn sqlite_only_methods_stay_in_the_blocking_pool() {
        for name in [
            "memory.project_resolve",
            "memory.project_list",
            "memory.project_alias_add",
            "memory.long_by_session",
            "memory.long_forget_session",
        ] {
            let spec = find(name).unwrap_or_else(|| panic!("表里没有 {name}"));
            assert!(
                matches!(spec.imp, Impl::Blocking(_)),
                "{name} 体内只有 SQLite，必须在阻塞池里跑"
            );
        }
        for name in ["memory.long_recall", "memory.long_add", "memory.long_reindex"] {
            let spec = find(name).unwrap_or_else(|| panic!("表里没有 {name}"));
            assert!(
                matches!(spec.imp, Impl::Async(_)),
                "{name} 要等 embedding，必须留在 async 链"
            );
        }
    }

    /// 预算档位只有两类，且必须与「宿主会反复轮询」这条口径一致。
    #[test]
    fn only_polling_methods_carry_a_budget() {
        for spec in METHODS {
            let should_be_fast = spec.name == "core.ping"
                || spec.name == "rpc.cancel"
                || spec.name.ends_with(".status");
            let is_fast = spec.budget == Budget::Fast;
            assert_eq!(
                is_fast, should_be_fast,
                "{} 的预算档位与「宿主轮询类方法」口径不一致",
                spec.name
            );
        }
        // 快读预算必须小于宿主侧最小超时，否则永远轮不到触发。
        // 那个「宿主最小超时」（`codebase.status` / `graph.status` 的 15s）不是本文件的常量：
        // 唯一来源是 `src/agent/agent-shared.json#rpc.hostStatusTimeoutMs`（Node 侧
        // `core-rpc-timeouts.js` 读同一份），所以这里读运行期值 —— 以前手抄 `15_000`，
        // 宿主调小超时后这条断言照样绿，契约等于没有闸门。
        let host_min_ms = dieyun_base::shared::shared().rpc.host_status_timeout_ms;
        assert!(
            FAST_METHOD_BUDGET_MS < host_min_ms,
            "Fast 预算 {FAST_METHOD_BUDGET_MS}ms 必须小于宿主最小超时 {host_min_ms}ms"
        );
    }

    /// `memory.status` 从来没实现过（旧测试却断言它有预算）。这条钉住「表即真相」。
    #[test]
    fn status_methods_are_the_ones_that_exist() {
        let status: Vec<&str> = METHODS
            .iter()
            .map(|spec| spec.name)
            .filter(|n| n.ends_with(".status"))
            .collect();
        assert_eq!(
            status,
            vec!["codebase.status", "embedding.status", "graph.status"]
        );
    }
}
