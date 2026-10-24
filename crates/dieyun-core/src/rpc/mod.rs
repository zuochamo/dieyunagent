use std::sync::Arc;

use serde_json::Value;
use tokio::sync::RwLock;

use crate::agent::AgentLoopManager;
use crate::blocking::run_blocking;
use crate::compaction;
use crate::config::{AppConfig, ConfigureParams, VERSION};
use crate::error::{CoreError, RpcErrorBody};
use crate::fs_ops;
use crate::graph::GraphService;
use crate::index::IndexService;
use crate::memory;
use crate::planner::PlannerRunManager;
use crate::sqlite::SqliteHandle;
use serde_json::json;

pub mod stdio;

/// 架构约束守卫：`AppState` 必须可跨线程共享，RPC 才能在多线程运行时上 `tokio::spawn`。
/// 断言失败说明某个服务重新引入了裸 `Connection` 等 `!Sync` 字段——那会把整个状态机拖回单线程。
#[allow(dead_code)]
fn _assert_app_state_is_send_sync() {
    fn assert_send_sync<T: Send + Sync>() {}
    assert_send_sync::<AppState>();
}

#[derive(Clone)]
pub struct AppState {
    inner: Arc<RwLock<StateInner>>,
}

struct StateInner {
    config: AppConfig,
    /// codebase.db 的唯一句柄：index / graph 共享同一条常驻连接。
    ///
    /// 存在这里是为了让配置热更新能在库文件没变时**复用**它——
    /// 否则每次 configure 都会另开一条连接，旧的随服务一起被 drop，
    /// 在异步写锁上同步做一次 WAL checkpoint。
    codebase_db: Arc<SqliteHandle>,
    index: IndexService,
    graph: GraphService,
    memory: memory::MemoryStore,
    agent: AgentLoopManager,
    planner: PlannerRunManager,
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
struct ServiceSnapshot {
    config: AppConfig,
    index: IndexService,
    graph: GraphService,
    memory: memory::MemoryStore,
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

impl ServiceSnapshot {
    /// 同步 RPC 分支的**唯一实现**。
    ///
    /// 这里刻意没有 `.await`：整段是同步世界，由 [`run_blocking`] 在阻塞线程池上调用，
    /// 因此不可能借到 `AppState` 的读锁，也不可能压在 async worker 上。
    ///
    /// 与 [`AppState::dispatch`] 的分工只有一条标准——**会不会把线程钉住**：
    /// 需要等（LLM / embedding / 索引任务）或只碰内存的留在那边，
    /// 碰 SQLite / 文件系统 / 纯 CPU 的落到这里。判断依据是「阻塞」而非「哪个模块」，
    /// 所以 `memory.*` 一部分在这里（查询），一部分在那边（向量召回）。
    fn dispatch(&self, method: &str, params: &Value) -> Result<Value, CoreError> {
        match method {
            // ---- memory：会话 / 消息 ----
            "memory.ping" => Ok(self.memory.ping()),
            "memory.touch_session" => {
                let session_id = params
                    .get("sessionId")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| CoreError::rpc("INVALID_PARAMS", "sessionId 必填"))?;
                let title = params.get("title").and_then(|v| v.as_str());
                self.memory.touch_session(session_id, title)?;
                Ok(json!({ "ok": true }))
            }
            "memory.sessions_list" => {
                let limit = params
                    .get("limit")
                    .and_then(|v| v.as_i64())
                    .unwrap_or(40)
                    .clamp(1, 100);
                let archived = params
                    .get("archived")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false);
                let rows = self.memory.list_sessions(limit, archived)?;
                Ok(serde_json::to_value(rows)?)
            }
            "memory.session_get" => {
                let session_id = params
                    .get("sessionId")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| CoreError::rpc("INVALID_PARAMS", "sessionId 必填"))?;
                let row = self.memory.get_session(session_id)?;
                Ok(row
                    .map(|r| serde_json::to_value(r).unwrap_or(Value::Null))
                    .unwrap_or(Value::Null))
            }
            "memory.session_create" => {
                let title = params.get("title").and_then(|v| v.as_str());
                let workspace_path = params.get("workspacePath").and_then(|v| v.as_str());
                let row = self.memory.create_session(title, workspace_path)?;
                Ok(serde_json::to_value(row)?)
            }
            "memory.message_append" => {
                let session_id = params
                    .get("sessionId")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| CoreError::rpc("INVALID_PARAMS", "sessionId 必填"))?;
                let role = params
                    .get("role")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| CoreError::rpc("INVALID_PARAMS", "role 必填"))?;
                let content = params
                    .get("content")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| CoreError::rpc("INVALID_PARAMS", "content 必填"))?;
                // 该轮真思考：可选、与 content 分列；缺省/空白落 NULL。
                let reasoning = params.get("reasoning").and_then(|v| v.as_str());
                let ins = self.memory.append_message(session_id, role, content, reasoning)?;
                Ok(json!({ "ok": true, "localMsgId": ins.local_msg_id }))
            }
            "memory.messages_recent" => {
                let session_id = params
                    .get("sessionId")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| CoreError::rpc("INVALID_PARAMS", "sessionId 必填"))?;
                let limit = params
                    .get("limit")
                    .and_then(|v| v.as_i64())
                    .unwrap_or(200)
                    .clamp(1, 500);
                let rows = self.memory.recent_messages(session_id, limit)?;
                Ok(serde_json::to_value(rows)?)
            }
            "memory.messages_older" => {
                let session_id = params
                    .get("sessionId")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| CoreError::rpc("INVALID_PARAMS", "sessionId 必填"))?;
                let before_id = params
                    .get("beforeId")
                    .and_then(|v| v.as_i64())
                    .ok_or_else(|| CoreError::rpc("INVALID_PARAMS", "beforeId 必填"))?;
                let limit = params
                    .get("limit")
                    .and_then(|v| v.as_i64())
                    .unwrap_or(100)
                    .clamp(1, 500);
                let rows = self
                    .memory
                    .messages_older_than(session_id, before_id, limit)?;
                Ok(serde_json::to_value(rows)?)
            }
            "memory.compaction_archive" => {
                let input: memory::CompactionArchiveInput = serde_json::from_value(params.clone())
                    .map_err(|e| CoreError::rpc("INVALID_PARAMS", e.to_string()))?;
                self.memory.save_compaction_archive(input)
            }
            "memory.compaction_recent" => {
                let session_id = params
                    .get("sessionId")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| CoreError::rpc("INVALID_PARAMS", "sessionId 必填"))?;
                let limit = params
                    .get("limit")
                    .and_then(|v| v.as_i64())
                    .unwrap_or(8)
                    .clamp(1, 50);
                let rows = self.memory.recent_compaction_archives(session_id, limit)?;
                Ok(serde_json::to_value(rows)?)
            }
            "memory.request_snapshot_append" => {
                let input: memory::RequestSnapshotInput = serde_json::from_value(params.clone())
                    .map_err(|e| CoreError::rpc("INVALID_PARAMS", e.to_string()))?;
                self.memory.save_request_snapshot(input)
            }
            "memory.request_snapshot_recent" => {
                let session_id = params
                    .get("sessionId")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| CoreError::rpc("INVALID_PARAMS", "sessionId 必填"))?;
                let limit = params
                    .get("limit")
                    .and_then(|v| v.as_i64())
                    .unwrap_or(20);
                let rows = self.memory.recent_request_snapshots(session_id, limit)?;
                Ok(serde_json::to_value(rows)?)
            }
            "memory.request_snapshot_get" => {
                let id = params
                    .get("id")
                    .and_then(|v| v.as_i64())
                    .ok_or_else(|| CoreError::rpc("INVALID_PARAMS", "id 必填"))?;
                self.memory.request_snapshot_get(id)
            }
            "memory.session_archive" => {
                let session_id = params
                    .get("sessionId")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| CoreError::rpc("INVALID_PARAMS", "sessionId 必填"))?;
                let archived = params
                    .get("archived")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(true);
                self.memory.set_session_archived(session_id, archived)
            }
            "memory.session_workspace_set" => {
                let session_id = params
                    .get("sessionId")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| CoreError::rpc("INVALID_PARAMS", "sessionId 必填"))?;
                let workspace_path = params.get("workspacePath").and_then(|v| v.as_str());
                self.memory
                    .set_session_workspace(session_id, workspace_path)
            }
            "memory.session_delete" | "memory.messages_clear" => {
                let session_id = params
                    .get("sessionId")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| CoreError::rpc("INVALID_PARAMS", "sessionId 必填"))?;
                self.memory.clear_session(session_id)
            }
            // ---- memory：长期记忆（向量 / embedding 部分不在这里） ----
            "memory.long_recent" => {
                let limit = params
                    .get("limit")
                    .and_then(|v| v.as_i64())
                    .unwrap_or(20)
                    .clamp(1, 100);
                let scope = params.get("scope").and_then(|v| v.as_str());
                let rows = self.memory.recent_long_memories(limit, scope)?;
                Ok(serde_json::to_value(rows)?)
            }
            "memory.long_keyword_search" => {
                let query = params.get("query").and_then(|v| v.as_str()).unwrap_or("");
                let limit = params
                    .get("limit")
                    .and_then(|v| v.as_i64())
                    .unwrap_or(12)
                    .clamp(1, 50);
                self.memory.keyword_search_long_memories(query, limit)
            }
            "memory.long_vector_status" => self.memory.long_memory_vector_status(),
            "memory.long_status_set" => {
                let memory_id = params
                    .get("memoryId")
                    .and_then(|v| v.as_i64())
                    .ok_or_else(|| CoreError::rpc("INVALID_PARAMS", "memoryId 必填"))?;
                let status = params
                    .get("status")
                    .and_then(|v| v.as_str())
                    .unwrap_or("active");
                self.memory.update_long_memory_status(memory_id, status)
            }
            "memory.messages_delete_turn" => {
                let session_id = params
                    .get("sessionId")
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                let ids: Vec<i64> = params
                    .get("messageId")
                    .and_then(|v| v.as_array())
                    .map(|arr| {
                        arr.iter()
                            .filter_map(|v| v.as_i64())
                            .filter(|id| *id > 0)
                            .collect()
                    })
                    .unwrap_or_default();
                let remove_count = params.get("removeCount").and_then(|v| v.as_i64());
                self.memory
                    .delete_turn_messages(session_id, &ids, remove_count)
            }
            "memory.consolidation_job_create" => {
                let scope = params.get("scope").and_then(|v| v.as_str());
                let reason = params.get("reason").and_then(|v| v.as_str());
                self.memory
                    .create_consolidation_job(scope, reason, Some("pending"))
            }
            "memory.consolidation_job_finish" => {
                let job_id = params
                    .get("jobId")
                    .and_then(|v| v.as_i64())
                    .ok_or_else(|| CoreError::rpc("INVALID_PARAMS", "jobId 必填"))?;
                let status = params
                    .get("status")
                    .and_then(|v| v.as_str())
                    .unwrap_or("completed");
                let error = params.get("error").and_then(|v| v.as_str());
                self.memory.finish_consolidation_job(job_id, status, error)
            }
            "memory.long_decay" => {
                let stale_days = params
                    .get("staleDays")
                    .and_then(|v| v.as_i64())
                    .unwrap_or(120);
                let archive_days = params
                    .get("archiveDays")
                    .and_then(|v| v.as_i64())
                    .unwrap_or(240);
                self.memory.decay_long_memories(stale_days, archive_days)
            }
            "memory.sessions_with_messages" => {
                let rows = self.memory.list_sessions_with_messages()?;
                Ok(serde_json::to_value(rows)?)
            }
            "memory.messages_after" => {
                let after_id = params.get("afterId").and_then(|v| v.as_i64()).unwrap_or(0);
                let limit = params.get("limit").and_then(|v| v.as_i64()).unwrap_or(500);
                let rows = self.memory.list_messages_after_id(after_id, limit)?;
                Ok(serde_json::to_value(rows)?)
            }
            "memory.long_memories_after" => {
                let after_id = params.get("afterId").and_then(|v| v.as_i64()).unwrap_or(0);
                let limit = params.get("limit").and_then(|v| v.as_i64()).unwrap_or(200);
                let rows = self.memory.list_long_memories_after_id(after_id, limit)?;
                Ok(serde_json::to_value(rows)?)
            }
            // ---- compaction：纯 CPU，无 IO ----
            "compaction.estimate" => Ok(compaction::estimate(params)),
            "compaction.prepare" => {
                let p: compaction::PrepareParams = serde_json::from_value(params.clone())
                    .map_err(|e| CoreError::rpc("INVALID_PARAMS", e.to_string()))?;
                let r = compaction::prepare(p)?;
                Ok(serde_json::to_value(r)?)
            }
            "compaction.apply" => {
                let p: compaction::ApplyParams = serde_json::from_value(params.clone())
                    .map_err(|e| CoreError::rpc("INVALID_PARAMS", e.to_string()))?;
                let r = compaction::apply(p);
                Ok(serde_json::to_value(r)?)
            }
            // ---- agent：运行账本 / trace ----
            "agent.run_upsert" => self.memory.upsert_agent_run(params),
            "agent.plan_save" => {
                let saved = self.memory.upsert_agent_plan(params)?;
                if params.get("steps").and_then(|v| v.as_array()).is_some() {
                    let mut step_input = params.clone();
                    if let Some(obj) = step_input.as_object_mut() {
                        obj.insert(
                            "planId".into(),
                            saved.get("planId").cloned().unwrap_or(Value::Null),
                        );
                    }
                    self.memory.save_agent_steps(&step_input)?;
                }
                Ok(saved)
            }
            "agent.steps_save" => self.memory.save_agent_steps(params),
            "agent.state_get" => {
                let session_id = params
                    .get("sessionId")
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                let row = self.memory.get_latest_agent_state(session_id)?;
                Ok(row.unwrap_or(Value::Null))
            }
            "agent.trace_save" => self.memory.save_agent_trace(params),
            "agent.trace_get" => {
                let row = self.memory.get_agent_trace(params)?;
                Ok(row.unwrap_or(Value::Null))
            }
            // ---- fs：磁盘 IO ----
            "fs.read_file" => {
                let file_path = params
                    .get("filePath")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| CoreError::rpc("INVALID_PARAMS", "filePath 必填"))?;
                let encoding = params.get("encoding").and_then(|v| v.as_str());
                let offset = params.get("offset").and_then(|v| v.as_u64());
                let max_bytes = params.get("maxBytes").and_then(|v| v.as_u64());
                let r = fs_ops::read_file(&self.config, file_path, encoding, offset, max_bytes)?;
                Ok(serde_json::to_value(r)?)
            }
            "fs.list_dir" => {
                let dir_path = params
                    .get("dirPath")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| CoreError::rpc("INVALID_PARAMS", "dirPath 必填"))?;
                let r = fs_ops::list_dir(&self.config, dir_path)?;
                Ok(serde_json::to_value(r)?)
            }
            // ---- codebase / graph：同步查询与索引启动 ----
            "codebase.status" => {
                let workspace_root = params
                    .get("workspaceRoot")
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                let r = self.index.status(workspace_root)?;
                Ok(serde_json::to_value(r)?)
            }
            "codebase.index.start" => {
                let workspace_root = params
                    .get("workspaceRoot")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| CoreError::rpc("INVALID_PARAMS", "workspaceRoot 必填"))?;
                let force = params
                    .get("force")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(true);
                let skip_if_ready = params
                    .get("skipIfReady")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(true);
                let r = self
                    .index
                    .start_index_workspace(workspace_root, force, skip_if_ready)?;
                Ok(serde_json::to_value(r)?)
            }
            "graph.status" => {
                let workspace_root = params
                    .get("workspaceRoot")
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                let r = self.graph.status(workspace_root)?;
                Ok(serde_json::to_value(r)?)
            }
            "graph.index.start" => {
                let workspace_root = params
                    .get("workspaceRoot")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| CoreError::rpc("INVALID_PARAMS", "workspaceRoot 必填"))?;
                let force = params
                    .get("force")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(true);
                let skip_if_ready = params
                    .get("skipIfReady")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(true);
                let r = self
                    .graph
                    .start_index_workspace(workspace_root, force, skip_if_ready)?;
                Ok(serde_json::to_value(r)?)
            }
            "graph.module_deps" => {
                let workspace_root = params
                    .get("workspaceRoot")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| CoreError::rpc("INVALID_PARAMS", "workspaceRoot 必填"))?;
                let path = params.get("path").and_then(|v| v.as_str());
                let depth = params
                    .get("depth")
                    .and_then(|v| v.as_u64())
                    .map(|n| n as u32);
                let r = self.graph.module_deps(workspace_root, path, depth)?;
                Ok(serde_json::to_value(r)?)
            }
            "graph.repo_map" => {
                let workspace_root = params
                    .get("workspaceRoot")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| CoreError::rpc("INVALID_PARAMS", "workspaceRoot 必填"))?;
                let limit = params
                    .get("limit")
                    .and_then(|v| v.as_u64())
                    .map(|n| n as u32);
                let r = self.graph.repo_map(workspace_root, limit)?;
                Ok(serde_json::to_value(r)?)
            }
            "graph.symbol_search" => {
                let workspace_root = params
                    .get("workspaceRoot")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| CoreError::rpc("INVALID_PARAMS", "workspaceRoot 必填"))?;
                let query = params
                    .get("query")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| CoreError::rpc("INVALID_QUERY", "query 必填"))?;
                let kind = params.get("kind").and_then(|v| v.as_str());
                let limit = params
                    .get("limit")
                    .and_then(|v| v.as_u64())
                    .map(|n| n as u32);
                let r = self
                    .graph
                    .symbol_search(workspace_root, query, kind, limit)?;
                Ok(serde_json::to_value(r)?)
            }
            "graph.callers" => {
                let workspace_root = params
                    .get("workspaceRoot")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| CoreError::rpc("INVALID_PARAMS", "workspaceRoot 必填"))?;
                let symbol_id = params.get("symbolId").and_then(|v| v.as_i64());
                let path = params.get("path").and_then(|v| v.as_str());
                let name = params.get("name").and_then(|v| v.as_str());
                let r = self.graph.callers(workspace_root, symbol_id, path, name)?;
                Ok(serde_json::to_value(r)?)
            }
            "graph.callees" => {
                let workspace_root = params
                    .get("workspaceRoot")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| CoreError::rpc("INVALID_PARAMS", "workspaceRoot 必填"))?;
                let symbol_id = params.get("symbolId").and_then(|v| v.as_i64());
                let path = params.get("path").and_then(|v| v.as_str());
                let name = params.get("name").and_then(|v| v.as_str());
                let r = self.graph.callees(workspace_root, symbol_id, path, name)?;
                Ok(serde_json::to_value(r)?)
            }
            "graph.impact" => {
                let workspace_root = params
                    .get("workspaceRoot")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| CoreError::rpc("INVALID_PARAMS", "workspaceRoot 必填"))?;
                let path = params
                    .get("path")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| CoreError::rpc("INVALID_PARAMS", "path 必填"))?;
                let depth = params
                    .get("depth")
                    .and_then(|v| v.as_u64())
                    .map(|n| n as u32);
                let r = self.graph.impact(workspace_root, path, depth)?;
                Ok(serde_json::to_value(r)?)
            }
            "graph.ingest_lsp_callers" => {
                let workspace_root = params
                    .get("workspaceRoot")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| CoreError::rpc("INVALID_PARAMS", "workspaceRoot 必填"))?;
                let callee_symbol_id = params
                    .get("calleeSymbolId")
                    .and_then(|v| v.as_i64())
                    .ok_or_else(|| CoreError::rpc("INVALID_PARAMS", "calleeSymbolId 必填"))?;
                let callee_name = params
                    .get("calleeName")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| CoreError::rpc("INVALID_PARAMS", "calleeName 必填"))?;
                let sites: Vec<crate::graph::LspCallSiteIn> =
                    serde_json::from_value(params.get("sites").cloned().unwrap_or_default())
                        .map_err(|e| CoreError::rpc("INVALID_PARAMS", e.to_string()))?;
                let r = self.graph.ingest_lsp_callers(
                    workspace_root,
                    callee_symbol_id,
                    callee_name,
                    sites,
                )?;
                Ok(serde_json::to_value(r)?)
            }
            _ => Err(CoreError::rpc(
                "UNKNOWN_METHOD",
                format!("未知 RPC: {method}"),
            )),
        }
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

/// 图谱索引收尾：同步的两段 `status` 查询走阻塞池，中间的 `embed_symbols` 才 `.await`。
///
/// `graph` 按值传入（`GraphService` 内部全是 `Arc`，克隆廉价），这样每段同步查询
/// 都能把自己的那份句柄移进闭包，不必在 `.await` 前后借用调用方。
async fn graph_status_with_optional_embed(
    graph: GraphService,
    workspace_root: &str,
    force: bool,
    should_embed: bool,
) -> Result<Value, CoreError> {
    let mut embed_error: Option<String> = None;
    if should_embed {
        let st = {
            let graph = graph.clone();
            let workspace_root = workspace_root.to_string();
            run_blocking(move || graph.status(&workspace_root)).await?
        };
        if st.indexed && st.symbol_count > 0 {
            if let Err(e) = graph.embed_symbols(workspace_root, force).await {
                embed_error = Some(e.to_string());
            }
        }
    }
    let st = {
        let graph = graph.clone();
        let workspace_root = workspace_root.to_string();
        run_blocking(move || graph.status(&workspace_root)).await?
    };
    let mut val = serde_json::to_value(st).map_err(|e| CoreError::rpc("SERIALIZE", e.to_string()))?;
    if let Some(err) = embed_error {
        if let Value::Object(ref mut map) = val {
            map.insert("embedError".to_string(), Value::String(err));
        }
    }
    Ok(val)
}

impl AppState {
    pub fn new(config: AppConfig) -> Self {
        // 索引与图谱落在同一个库文件上，共用同一条常驻连接。
        let codebase_db = crate::codebase_db::handle(config.codebase_db_path());
        let index = IndexService::from_config(&config, Arc::clone(&codebase_db));
        let graph = GraphService::from_config(&config, Arc::clone(&codebase_db));
        let memory = memory::MemoryStore::from_config(&config)
            .unwrap_or_else(|e| panic!("memory store init failed: {e}"));
        Self {
            inner: Arc::new(RwLock::new(StateInner {
                config,
                codebase_db,
                index,
                graph,
                memory,
                agent: AgentLoopManager::default(),
                planner: PlannerRunManager::default(),
            })),
        }
    }

    /// 在兼容 async 语义的前提下取出服务快照（读锁只覆盖克隆那几行）。
    async fn snapshot(&self) -> ServiceSnapshot {
        self.inner.read().await.snapshot()
    }

    /// RPC 总入口。这里只保留两类分支：
    ///
    /// 1. 只碰内存的（`core.ping` / `rpc.cancel` / planner 与 agent 循环账本）；
    /// 2. 真正需要 `.await` 的（LLM、embedding、索引任务）。
    ///
    /// 其余一切同步工作——`rusqlite` 查询、文件读写、压缩计算——都由兜底分支
    /// 交给 [`ServiceSnapshot::dispatch`]，在阻塞线程池上执行。判断标准是
    /// 「这段代码会不会把线程钉住」，而不是「属于哪个模块」。
    pub async fn dispatch(
        &self,
        method: &str,
        params: serde_json::Value,
    ) -> Result<serde_json::Value, CoreError> {
        match method {
            "core.ping" => Ok(serde_json::json!({
                "ok": true,
                "version": VERSION,
                "engine": "rust"
            })),
            // 协议级取消：按 runId 标记 agent/planner run；ids 由宿主侧 settle，core 仅尽力取消语义 run。
            "rpc.cancel" => {
                let run_id = params.get("runId").and_then(|v| v.as_str()).unwrap_or("");
                let ids = params
                    .get("ids")
                    .and_then(|v| v.as_array())
                    .map(|arr| {
                        arr.iter()
                            .filter_map(|x| x.as_u64().or_else(|| x.as_i64().map(|n| n as u64)))
                            .collect::<Vec<_>>()
                    })
                    .unwrap_or_default();
                let mut agent_ok = false;
                let mut planner_ok = false;
                if !run_id.is_empty() {
                    let guard = self.inner.read().await;
                    agent_ok = guard.agent.cancel(run_id).is_ok();
                    planner_ok = guard.planner.cancel(run_id).is_ok();
                }
                Ok(serde_json::json!({
                    "ok": true,
                    "runId": if run_id.is_empty() { serde_json::Value::Null } else { serde_json::Value::String(run_id.to_string()) },
                    "ids": ids,
                    "agentCancelled": agent_ok,
                    "plannerCancelled": planner_ok
                }))
            },
            "agent.ping" => Ok(serde_json::json!({
                "ok": true,
                "engine": "rust",
                "delegateOnly": true
            })),
            "planner.ping" => {
                let guard = self.inner.read().await;
                Ok(guard.planner.ping())
            }
            "planner.run.start" => {
                let p: crate::planner::PlannerStartParams = serde_json::from_value(params)
                    .map_err(|e| CoreError::rpc("INVALID_PARAMS", e.to_string()))?;
                let guard = self.inner.read().await;
                let r = guard.planner.start(p)?;
                Ok(r)
            }
            "planner.run.continue" => {
                let run_id = params
                    .get("runId")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| CoreError::rpc("INVALID_PARAMS", "runId 必填"))?;
                let mut input_val = params.clone();
                if let Some(obj) = input_val.as_object_mut() {
                    obj.remove("runId");
                }
                let input: crate::planner::PlannerContinueInput = serde_json::from_value(input_val)
                    .map_err(|e| CoreError::rpc("INVALID_PARAMS", e.to_string()))?;
                let guard = self.inner.read().await;
                let r = guard.planner.continue_run(run_id, input)?;
                Ok(r)
            }
            "planner.run.worker_loop" => {
                let run_id = params
                    .get("runId")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| CoreError::rpc("INVALID_PARAMS", "runId 必填"))?;
                let worker = params
                    .get("worker")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| CoreError::rpc("INVALID_PARAMS", "worker 必填"))?;
                let task_id = params
                    .get("taskId")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| CoreError::rpc("INVALID_PARAMS", "taskId 必填"))?;
                let subagent_id = params
                    .get("subagentId")
                    .and_then(|v| v.as_str())
                    .unwrap_or("exec");
                let worktree_path = params.get("worktreePath").and_then(|v| v.as_str());
                let role_messages = params
                    .get("roleMessages")
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                let prior_summary = params
                    .get("priorSummary")
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                let guard = self.inner.read().await;
                let r = guard.planner.worker_loop_body(
                    run_id,
                    worker,
                    task_id,
                    subagent_id,
                    worktree_path,
                    role_messages,
                    prior_summary,
                )?;
                Ok(r)
            }
            "planner.run.state" => {
                let run_id = params
                    .get("runId")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| CoreError::rpc("INVALID_PARAMS", "runId 必填"))?;
                let guard = self.inner.read().await;
                let r = guard.planner.state(run_id)?;
                Ok(r)
            }
            "planner.run.cancel" => {
                let run_id = params
                    .get("runId")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| CoreError::rpc("INVALID_PARAMS", "runId 必填"))?;
                let guard = self.inner.read().await;
                let r = guard.planner.cancel(run_id)?;
                Ok(r)
            }
            "agent.loop.start" => {
                let p: crate::agent::StartParams = serde_json::from_value(params)
                    .map_err(|e| CoreError::rpc("INVALID_PARAMS", e.to_string()))?;
                let guard = self.inner.read().await;
                let r = guard.agent.start(p)?;
                Ok(serde_json::to_value(r)?)
            }
            "agent.loop.continue" => {
                let run_id = params
                    .get("runId")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| CoreError::rpc("INVALID_PARAMS", "runId 必填"))?;
                let llm: crate::agent::LlmResponseInput = params
                    .get("llm")
                    .cloned()
                    .map(serde_json::from_value)
                    .transpose()
                    .map_err(|e| CoreError::rpc("INVALID_PARAMS", e.to_string()))?
                    .unwrap_or_default();
                let guard = self.inner.read().await;
                let r = guard.agent.continue_llm(&guard.config, &guard.index, run_id, llm)?;
                Ok(serde_json::to_value(r)?)
            }
            "agent.loop.tool_results" => {
                let run_id = params
                    .get("runId")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| CoreError::rpc("INVALID_PARAMS", "runId 必填"))?;
                let results: Vec<crate::agent::ToolResultInput> = params
                    .get("results")
                    .cloned()
                    .map(serde_json::from_value)
                    .transpose()
                    .map_err(|e| CoreError::rpc("INVALID_PARAMS", e.to_string()))?
                    .unwrap_or_default();
                let guard = self.inner.read().await;
                let r =
                    guard
                        .agent
                        .submit_tool_results(&guard.config, &guard.index, run_id, results)?;
                Ok(serde_json::to_value(r)?)
            }
            "agent.loop.cancel" => {
                let run_id = params
                    .get("runId")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| CoreError::rpc("INVALID_PARAMS", "runId 必填"))?;
                let guard = self.inner.read().await;
                guard.agent.cancel(run_id)?;
                Ok(serde_json::json!({ "ok": true }))
            }
            "agent.loop.set_messages" => {
                let run_id = params
                    .get("runId")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| CoreError::rpc("INVALID_PARAMS", "runId 必填"))?;
                let messages: Vec<Value> = params
                    .get("messages")
                    .cloned()
                    .map(serde_json::from_value)
                    .transpose()
                    .map_err(|e| CoreError::rpc("INVALID_PARAMS", e.to_string()))?
                    .unwrap_or_default();
                let guard = self.inner.read().await;
                guard.agent.set_messages(run_id, messages)?;
                Ok(serde_json::json!({ "ok": true }))
            }
            "core.configure" => {
                let p: ConfigureParams = serde_json::from_value(params)
                    .map_err(|e| CoreError::rpc("INVALID_PARAMS", e.to_string()))?;
                // 不要在写锁上重开记忆库：写锁等待会把 status 等读请求全部堵住（tokio RwLock
                // writer-prefer），表现为「1 个 txt 也索引超时」。
                let reopen_cfg = {
                    let mut guard = self.inner.write().await;
                    let old_mem_path = guard.memory.db_path().to_path_buf();
                    guard.config.apply_configure(&p).map_err(CoreError::Other)?;
                    let new_mem_path = guard.config.memory_db_path();
                    // 库文件没换就沿用原句柄：连接、页缓存、建表结果都不必重来。
                    let new_db_path = guard.config.codebase_db_path();
                    let codebase_db = if same_path(guard.codebase_db.path(), &new_db_path) {
                        Arc::clone(&guard.codebase_db)
                    } else {
                        crate::codebase_db::handle(new_db_path)
                    };
                    guard.codebase_db = Arc::clone(&codebase_db);
                    guard.index =
                        IndexService::from_config(&guard.config, Arc::clone(&codebase_db));
                    guard.graph = GraphService::from_config(&guard.config, codebase_db);
                    if same_path(&old_mem_path, &new_mem_path) {
                        let embedding = guard.config.embedding.clone();
                        let models_dirs = guard.config.models_dirs.clone();
                        guard.memory.set_embedding(embedding, models_dirs);
                        None
                    } else {
                        Some(guard.config.clone())
                    }
                };
                if let Some(cfg) = reopen_cfg {
                    let store = tokio::task::spawn_blocking(move || {
                        memory::MemoryStore::from_config(&cfg)
                    })
                    .await
                    .map_err(|e| CoreError::rpc("MEMORY_REOPEN_JOIN", e.to_string()))??;
                    let mut guard = self.inner.write().await;
                    guard.memory = store;
                }
                Ok(serde_json::json!({ "ok": true }))
            }
            "memory.long_recall" => {
                let query = params.get("query").and_then(|v| v.as_str()).unwrap_or("").to_string();
                let scope = params.get("scope").and_then(|v| v.as_str()).map(|s| s.to_string());
                let limit = params
                    .get("limit")
                    .and_then(|v| v.as_i64())
                    .unwrap_or(12)
                    .clamp(1, 50);
                let memory = self.snapshot().await.memory;
                memory
                    .recall_long_memories(&query, scope.as_deref(), limit)
                    .await
            }
            "memory.long_add" => {
                let content = params
                    .get("content")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| CoreError::rpc("INVALID_PARAMS", "content 必填"))?;
                let source = params
                    .get("source")
                    .and_then(|v| v.as_str())
                    .unwrap_or("user");
                let kind = params.get("kind").and_then(|v| v.as_str());
                let scope = params.get("scope").and_then(|v| v.as_str());
                let importance = params.get("importance").and_then(|v| v.as_i64());
                let expires_at = params.get("expiresAt").and_then(|v| v.as_i64());
                let metadata = params.get("metadata").cloned();
                let memory = self.snapshot().await.memory;
                let ins = memory.add_long_memory(
                    content,
                    source,
                    kind,
                    scope,
                    importance,
                    expires_at,
                    metadata.as_ref(),
                )?;
                let memory_id = ins
                    .get("localMemoryId")
                    .and_then(|v| v.as_i64())
                    .unwrap_or(0);
                let vector = memory.index_long_memory(memory_id).await?;
                Ok(json!({
                    "ok": true,
                    "localMemoryId": memory_id,
                    "vector": vector,
                }))
            }
            "memory.long_reindex" => {
                let limit = params
                    .get("limit")
                    .and_then(|v| v.as_i64())
                    .unwrap_or(500)
                    .clamp(1, 2000);
                let memory = self.snapshot().await.memory;
                memory.reindex_long_memories(limit).await
            }
            "compaction.maybe_compact" => {
                let p: compaction::MaybeCompactParams = serde_json::from_value(params)
                    .map_err(|e| CoreError::rpc("INVALID_PARAMS", e.to_string()))?;
                // 勿在 LLM 重试期间持有 inner 读锁，否则停止后的 memory/agent 写会卡住
                let llm = self.snapshot().await.config.llm;
                let r = compaction::maybe_compact(&llm, p).await?;
                Ok(serde_json::to_value(r)?)
            }
            "codebase.index" => {
                let workspace_root = params
                    .get("workspaceRoot")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| CoreError::rpc("INVALID_PARAMS", "workspaceRoot 必填"))?
                    .to_string();
                let force = params
                    .get("force")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(true);
                let index = self.snapshot().await.index;
                let r = index.index_workspace(&workspace_root, force).await?;
                Ok(serde_json::to_value(r)?)
            }
            "codebase.search" => {
                let workspace_root = params
                    .get("workspaceRoot")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| CoreError::rpc("INVALID_PARAMS", "workspaceRoot 必填"))?
                    .to_string();
                let query = params
                    .get("query")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| CoreError::rpc("INVALID_QUERY", "query 必填"))?;
                let limit = params
                    .get("limit")
                    .and_then(|v| v.as_u64())
                    .map(|n| n as u32);
                let auto_index = params
                    .get("autoIndex")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(true);
                let index = self.snapshot().await.index;
                // status 是同步 SQLite 聚合：走阻塞池，别压在 async worker 上
                let st = {
                    let index = index.clone();
                    let workspace_root = workspace_root.clone();
                    run_blocking(move || index.status(&workspace_root)).await?
                };
                if !st.indexed || st.chunk_count == 0 {
                    if st.indexing {
                        return Err(CoreError::rpc(
                            "INDEXING_IN_PROGRESS",
                            "代码库索引构建中，请等待完成后再搜索",
                        ));
                    }
                    if auto_index {
                        let ws = crate::index::resolve_workspace(&workspace_root)?;
                        if ws.is_remote {
                            return Err(CoreError::rpc(
                                "INDEX_REQUIRED",
                                "远程工作区需先完成代码库索引",
                            ));
                        }
                        // 不再在 search 内同步全量建库；交给 prep / index.start
                        return Err(CoreError::rpc(
                            "INDEX_REQUIRED",
                            "代码库尚未索引，请先等待准备工作中的索引完成",
                        ));
                    }
                    return Err(CoreError::rpc("INDEX_REQUIRED", "代码库尚未索引"));
                }
                let r = index.search(&workspace_root, query, limit).await?;
                Ok(serde_json::to_value(r)?)
            }
            "codebase.index_remote" => {
                let workspace_root = params
                    .get("workspaceRoot")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| CoreError::rpc("INVALID_PARAMS", "workspaceRoot 必填"))?
                    .to_string();
                let force = params
                    .get("force")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(true);
                let phase = params
                    .get("phase")
                    .and_then(|v| v.as_str())
                    .unwrap_or("full")
                    .to_string();
                let index = self.snapshot().await.index;
                let ws = crate::index::resolve_workspace(&workspace_root)?;
                if !ws.is_remote {
                    return Err(CoreError::rpc(
                        "LOCAL_INDEX_REQUIRED",
                        "本地工作空间请使用 codebase.index",
                    ));
                }
                match phase.as_str() {
                    "begin" => {
                        index.index_remote_begin(&ws, force).await?;
                        let st = {
                            let index = index.clone();
                            let workspace_root = workspace_root.clone();
                            run_blocking(move || index.status(&workspace_root)).await?
                        };
                        Ok(serde_json::to_value(st)?)
                    }
                    "push" => {
                        let files: Vec<crate::index::RemoteFileInput> = params
                            .get("files")
                            .map(|v| serde_json::from_value(v.clone()))
                            .transpose()
                            .map_err(|e| CoreError::rpc("INVALID_PARAMS", e.to_string()))?
                            .unwrap_or_default();
                        let count = files.len();
                        {
                            let index = index.clone();
                            let ws = ws.clone();
                            run_blocking(move || index.index_remote_push(&ws, &files)).await?
                        };
                        Ok(serde_json::json!({ "ok": true, "pushed": count }))
                    }
                    "finish" => {
                        let r = index.index_remote_finish(&ws).await?;
                        Ok(serde_json::to_value(r)?)
                    }
                    _ => {
                        let files: Vec<crate::index::RemoteFileInput> = params
                            .get("files")
                            .map(|v| serde_json::from_value(v.clone()))
                            .transpose()
                            .map_err(|e| CoreError::rpc("INVALID_PARAMS", e.to_string()))?
                            .unwrap_or_default();
                        let r = index.index_remote(&workspace_root, files, force).await?;
                        Ok(serde_json::to_value(r)?)
                    }
                }
            }
            "graph.index" => {
                let workspace_root = params
                    .get("workspaceRoot")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| CoreError::rpc("INVALID_PARAMS", "workspaceRoot 必填"))?
                    .to_string();
                let force = params
                    .get("force")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(true);
                let embed_symbols = params
                    .get("embedSymbols")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(true);
                let graph = self.snapshot().await.graph;
                let should_embed = embed_symbols && graph.embedding_enabled();
                {
                    let graph = graph.clone();
                    let workspace_root = workspace_root.clone();
                    run_blocking(move || graph.index_workspace(&workspace_root, force)).await?
                };
                graph_status_with_optional_embed(graph, &workspace_root, force, should_embed).await
            }
            "graph.index_remote" => {
                let workspace_root = params
                    .get("workspaceRoot")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| CoreError::rpc("INVALID_PARAMS", "workspaceRoot 必填"))?
                    .to_string();
                let force = params
                    .get("force")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(true);
                let phase = params
                    .get("phase")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let embed_symbols = params
                    .get("embedSymbols")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(true);
                let files: Vec<crate::index::RemoteFileInput> = serde_json::from_value(
                    params
                        .get("files")
                        .cloned()
                        .unwrap_or_else(|| serde_json::json!([])),
                )
                .map_err(|e| CoreError::rpc("INVALID_PARAMS", e.to_string()))?;
                let graph = self.snapshot().await.graph;
                let should_embed = embed_symbols && graph.embedding_enabled();
                match phase.as_str() {
                    "begin" => {
                        let r = {
                            let graph = graph.clone();
                            let workspace_root = workspace_root.clone();
                            run_blocking(move || graph.index_remote_begin(&workspace_root)).await?
                        };
                        return Ok(serde_json::to_value(r)?);
                    }
                    "push" => {
                        let pushed = {
                            let graph = graph.clone();
                            let workspace_root = workspace_root.clone();
                            run_blocking(move || {
                                graph.index_remote_push(&workspace_root, &files)
                            })
                            .await?
                        };
                        return Ok(serde_json::json!({ "ok": true, "pushed": pushed }));
                    }
                    "finish" => {
                        let graph = graph.clone();
                        let workspace_root = workspace_root.clone();
                        run_blocking(move || graph.index_remote_finish(&workspace_root, force))
                            .await?;
                    }
                    _ => {
                        let graph = graph.clone();
                        let workspace_root = workspace_root.clone();
                        run_blocking(move || {
                            graph.index_remote(&workspace_root, files, force)
                        })
                        .await?;
                    }
                }
                graph_status_with_optional_embed(graph, &workspace_root, force, should_embed).await
            }
            "graph.embed_symbols" => {
                let workspace_root = params
                    .get("workspaceRoot")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| CoreError::rpc("INVALID_PARAMS", "workspaceRoot 必填"))?;
                let force = params
                    .get("force")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false);
                let graph = self.snapshot().await.graph;
                let r = graph.embed_symbols(workspace_root, force).await?;
                Ok(serde_json::to_value(r)?)
            }
            "graph.symbol_semantic_search" => {
                let workspace_root = params
                    .get("workspaceRoot")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| CoreError::rpc("INVALID_PARAMS", "workspaceRoot 必填"))?
                    .to_string();
                let query = params
                    .get("query")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| CoreError::rpc("INVALID_QUERY", "query 必填"))?;
                let kind = params.get("kind").and_then(|v| v.as_str());
                let limit = params
                    .get("limit")
                    .and_then(|v| v.as_u64())
                    .map(|n| n as u32);
                let auto_embed = params
                    .get("autoEmbed")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(true);
                let graph = self.snapshot().await.graph;
                let mut embed_error: Option<String> = None;
                if auto_embed {
                    let st = {
                        let graph = graph.clone();
                        let workspace_root = workspace_root.clone();
                        run_blocking(move || graph.status(&workspace_root)).await?
                    };
                    if st.indexed
                        && st.symbol_count > 0
                        && (st.symbol_vector_count < st.symbol_count
                            || graph.embedding_signature()
                                != st.symbol_embedding_model.as_deref().unwrap_or(""))
                        && graph.embedding_enabled()
                    {
                        if let Err(e) = graph.embed_symbols(&workspace_root, false).await {
                            embed_error = Some(e.to_string());
                        }
                    }
                }
                let r = graph
                    .symbol_semantic_search(&workspace_root, query, kind, limit)
                    .await?;
                let mut val =
                    serde_json::to_value(r).map_err(|e| CoreError::rpc("SERIALIZE", e.to_string()))?;
                if let Some(err) = embed_error {
                    if let Value::Object(ref mut map) = val {
                        map.insert("embedError".to_string(), Value::String(err));
                    }
                }
                Ok(val)
            }
            // 兜底：其余全部是同步分支（SQLite / 文件系统 / 纯 CPU）。
            //
            // 快照在读锁下只做 Arc 克隆，随后整段搬到阻塞池执行——于是 async worker
            // 不再被一次全表扫描占住，`core.configure` 这类写路径也不会被读锁挡住。
            // 注意：真正的「哪些方法阻塞」清单只有一处，就是 `ServiceSnapshot::dispatch`。
            _ => {
                let snap = self.snapshot().await;
                let method = method.to_string();
                run_blocking(move || snap.dispatch(&method, &params)).await
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
