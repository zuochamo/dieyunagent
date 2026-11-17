//! memory 域的阻塞型 RPC：每个方法一个函数（参数校验与返回形状都在这里）。
//!
//! 由 `ServiceSnapshot::dispatch` 的臂体机械搬来：`snap.*` → `snap.*`，其余逐字未改。
//! 迁移纪律见 `rpc/registry.rs` 顶部注释；parity 测试会拦「双份实现」与「搬完忘删臂」。

use serde_json::{json, Value};

use crate::error::CoreError;
use crate::memory;
use crate::rpc::ServiceSnapshot;

/// `memory.ping`
pub(crate) fn ping(snap: &ServiceSnapshot, _params: &Value) -> Result<Value, CoreError> {
    Ok(snap.memory.ping())
}

/// `memory.touch_session`
pub(crate) fn touch_session(snap: &ServiceSnapshot, params: &Value) -> Result<Value, CoreError> {
        let session_id = params
            .get("sessionId")
            .and_then(|v| v.as_str())
            .ok_or_else(|| CoreError::rpc("INVALID_PARAMS", "sessionId 必填"))?;
        let title = params.get("title").and_then(|v| v.as_str());
        snap.memory.touch_session(session_id, title)?;
        Ok(json!({ "ok": true }))
    }
    // 显式标题写入（AI 总结 / 用户改名）：无条件覆盖，来源落 title_source。

/// `memory.session_set_title`
pub(crate) fn session_set_title(snap: &ServiceSnapshot, params: &Value) -> Result<Value, CoreError> {
        let session_id = params
            .get("sessionId")
            .and_then(|v| v.as_str())
            .ok_or_else(|| CoreError::rpc("INVALID_PARAMS", "sessionId 必填"))?;
        let title = params.get("title").and_then(|v| v.as_str()).unwrap_or("");
        let source = params
            .get("source")
            .and_then(|v| v.as_str())
            .ok_or_else(|| CoreError::rpc("INVALID_PARAMS", "source 必填"))?;
        snap.memory.set_session_title(session_id, title, source)
    }

/// `memory.sessions_list`
pub(crate) fn sessions_list(snap: &ServiceSnapshot, params: &Value) -> Result<Value, CoreError> {                let limit = params
            .get("limit")
            .and_then(|v| v.as_i64())
            .unwrap_or(40)
            .clamp(1, 100);
        let archived = params
            .get("archived")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        let rows = snap.memory.list_sessions(limit, archived)?;
        Ok(serde_json::to_value(rows)?)
    }

/// `memory.session_get`
pub(crate) fn session_get(snap: &ServiceSnapshot, params: &Value) -> Result<Value, CoreError> {
        let session_id = params
            .get("sessionId")
            .and_then(|v| v.as_str())
            .ok_or_else(|| CoreError::rpc("INVALID_PARAMS", "sessionId 必填"))?;
        let row = snap.memory.get_session(session_id)?;
        Ok(row
            .map(|r| serde_json::to_value(r).unwrap_or(Value::Null))
            .unwrap_or(Value::Null))
    }

/// `memory.session_create`
pub(crate) fn session_create(snap: &ServiceSnapshot, params: &Value) -> Result<Value, CoreError> {
        let title = params.get("title").and_then(|v| v.as_str());
        let workspace_path = params.get("workspacePath").and_then(|v| v.as_str());
        let row = snap.memory.create_session(title, workspace_path)?;
        Ok(serde_json::to_value(row)?)
    }

/// `memory.handoff_save`
pub(crate) fn handoff_save(snap: &ServiceSnapshot, params: &Value) -> Result<Value, CoreError> {
        let session_id = params
            .get("sessionId")
            .and_then(|v| v.as_str())
            .ok_or_else(|| CoreError::rpc("INVALID_PARAMS", "sessionId 必填"))?;
        let title = params.get("title").and_then(|v| v.as_str()).unwrap_or("");
        let payload = params
            .get("payload")
            .and_then(|v| v.as_str())
            .ok_or_else(|| CoreError::rpc("INVALID_PARAMS", "payload 必填"))?;
        snap.memory.handoff_save(session_id, title, payload)?;
        Ok(json!({ "ok": true }))
    }

/// `memory.handoff_get`
pub(crate) fn handoff_get(snap: &ServiceSnapshot, params: &Value) -> Result<Value, CoreError> {
        let session_id = params
            .get("sessionId")
            .and_then(|v| v.as_str())
            .ok_or_else(|| CoreError::rpc("INVALID_PARAMS", "sessionId 必填"))?;
        let row = snap.memory.handoff_get(session_id)?;
        Ok(row.unwrap_or(Value::Null))
    }

/// `memory.handoff_latest`
pub(crate) fn handoff_latest(snap: &ServiceSnapshot, params: &Value) -> Result<Value, CoreError> {
        let exclude = params.get("excludeSessionId").and_then(|v| v.as_str());
        let row = snap.memory.handoff_latest(exclude)?;
        Ok(row.unwrap_or(Value::Null))
    }
    // 领走 = 读出来并删掉：交接是一次性资源，领到才允许建会话（见 handoff_take 注释）。

/// `memory.handoff_take`
pub(crate) fn handoff_take(snap: &ServiceSnapshot, params: &Value) -> Result<Value, CoreError> {
        let session_id = params
            .get("sessionId")
            .and_then(|v| v.as_str())
            .ok_or_else(|| CoreError::rpc("INVALID_PARAMS", "sessionId 必填"))?;
        let row = snap.memory.handoff_take(session_id)?;
        Ok(row.unwrap_or(Value::Null))
    }

/// `memory.message_append`
pub(crate) fn message_append(snap: &ServiceSnapshot, params: &Value) -> Result<Value, CoreError> {
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
        let ins = snap.memory.append_message(session_id, role, content, reasoning)?;
        Ok(json!({ "ok": true, "localMsgId": ins.local_msg_id }))
    }

/// `memory.messages_recent`
pub(crate) fn messages_recent(snap: &ServiceSnapshot, params: &Value) -> Result<Value, CoreError> {
        let session_id = params
            .get("sessionId")
            .and_then(|v| v.as_str())
            .ok_or_else(|| CoreError::rpc("INVALID_PARAMS", "sessionId 必填"))?;
        let limit = params
            .get("limit")
            .and_then(|v| v.as_i64())
            .unwrap_or(200)
            .clamp(1, 500);
        let rows = snap.memory.recent_messages(session_id, limit)?;
        Ok(serde_json::to_value(rows)?)
    }

/// `memory.messages_older`
pub(crate) fn messages_older(snap: &ServiceSnapshot, params: &Value) -> Result<Value, CoreError> {
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
        let rows = snap
            .memory
            .messages_older_than(session_id, before_id, limit)?;
        Ok(serde_json::to_value(rows)?)
    }

/// `memory.compaction_archive`
pub(crate) fn compaction_archive(snap: &ServiceSnapshot, params: &Value) -> Result<Value, CoreError> {
        let input: memory::CompactionArchiveInput = serde_json::from_value(params.clone())
            .map_err(|e| CoreError::rpc("INVALID_PARAMS", e.to_string()))?;
        snap.memory.save_compaction_archive(input)
    }

/// `memory.compaction_recent`
pub(crate) fn compaction_recent(snap: &ServiceSnapshot, params: &Value) -> Result<Value, CoreError> {
        let session_id = params
            .get("sessionId")
            .and_then(|v| v.as_str())
            .ok_or_else(|| CoreError::rpc("INVALID_PARAMS", "sessionId 必填"))?;
        let limit = params
            .get("limit")
            .and_then(|v| v.as_i64())
            .unwrap_or(8)
            .clamp(1, 50);
        let rows = snap.memory.recent_compaction_archives(session_id, limit)?;
        Ok(serde_json::to_value(rows)?)
    }

/// `memory.request_snapshot_append`
pub(crate) fn request_snapshot_append(snap: &ServiceSnapshot, params: &Value) -> Result<Value, CoreError> {
        let input: memory::RequestSnapshotInput = serde_json::from_value(params.clone())
            .map_err(|e| CoreError::rpc("INVALID_PARAMS", e.to_string()))?;
        snap.memory.save_request_snapshot(input)
    }

/// `memory.request_snapshot_recent`
pub(crate) fn request_snapshot_recent(snap: &ServiceSnapshot, params: &Value) -> Result<Value, CoreError> {
        let session_id = params
            .get("sessionId")
            .and_then(|v| v.as_str())
            .ok_or_else(|| CoreError::rpc("INVALID_PARAMS", "sessionId 必填"))?;
        let limit = params
            .get("limit")
            .and_then(|v| v.as_i64())
            .unwrap_or(20);
        let rows = snap.memory.recent_request_snapshots(session_id, limit)?;
        Ok(serde_json::to_value(rows)?)
    }

/// `memory.request_snapshot_get`
pub(crate) fn request_snapshot_get(snap: &ServiceSnapshot, params: &Value) -> Result<Value, CoreError> {
        let id = params
            .get("id")
            .and_then(|v| v.as_i64())
            .ok_or_else(|| CoreError::rpc("INVALID_PARAMS", "id 必填"))?;
        snap.memory.request_snapshot_get(id)
    }
    // 「索引内容有没有进上下文」全窗口聚合：口径在 memory::snapshot::count_index_injections
    // 的 doc 注释里（工具遥测看不见自动注入，统计页不能只拿调用占比评估索引）。

/// `memory.request_snapshot_index_audit`
pub(crate) fn request_snapshot_index_audit(snap: &ServiceSnapshot, params: &Value) -> Result<Value, CoreError> {
        let since = params.get("since").and_then(|v| v.as_i64());
        snap.memory.count_index_injections(since)
    }

/// `memory.session_archive`
pub(crate) fn session_archive(snap: &ServiceSnapshot, params: &Value) -> Result<Value, CoreError> {
        let session_id = params
            .get("sessionId")
            .and_then(|v| v.as_str())
            .ok_or_else(|| CoreError::rpc("INVALID_PARAMS", "sessionId 必填"))?;
        let archived = params
            .get("archived")
            .and_then(|v| v.as_bool())
            .unwrap_or(true);
        snap.memory.set_session_archived(session_id, archived)
    }

/// `memory.session_workspace_set`
pub(crate) fn session_workspace_set(snap: &ServiceSnapshot, params: &Value) -> Result<Value, CoreError> {
        let session_id = params
            .get("sessionId")
            .and_then(|v| v.as_str())
            .ok_or_else(|| CoreError::rpc("INVALID_PARAMS", "sessionId 必填"))?;
        let workspace_path = params.get("workspacePath").and_then(|v| v.as_str());
        snap.memory
            .set_session_workspace(session_id, workspace_path)
    }
    // 只有这一个名字：`clear_session` 删的是**会话行**（连 traces / runs / handoffs），
    // 不是「清空消息」。以前这里还挂着别名 `memory.messages_clear`（无调用方），
    // 语义与名字相反 —— 任何一天有人把它接到「清空当前对话」按钮，用户丢的是整个会话。

/// `memory.session_delete`
pub(crate) fn session_delete(snap: &ServiceSnapshot, params: &Value) -> Result<Value, CoreError> {
        let session_id = params
            .get("sessionId")
            .and_then(|v| v.as_str())
            .ok_or_else(|| CoreError::rpc("INVALID_PARAMS", "sessionId 必填"))?;
        snap.memory.clear_session(session_id)
    }
    // ---- memory：会话级目标对象（语义在 Node 的 plans/goal-run.js，这里只存取） ----

/// `memory.session_goal_get`
pub(crate) fn session_goal_get(snap: &ServiceSnapshot, params: &Value) -> Result<Value, CoreError> {
        let session_id = params
            .get("sessionId")
            .and_then(|v| v.as_str())
            .ok_or_else(|| CoreError::rpc("INVALID_PARAMS", "sessionId 必填"))?;
        let goal = snap.memory.get_session_goal(session_id)?;
        Ok(json!({ "goalJson": goal }))
    }

/// `memory.session_goal_put`
pub(crate) fn session_goal_put(snap: &ServiceSnapshot, params: &Value) -> Result<Value, CoreError> {
        let session_id = params
            .get("sessionId")
            .and_then(|v| v.as_str())
            .ok_or_else(|| CoreError::rpc("INVALID_PARAMS", "sessionId 必填"))?;
        // null / 缺省 = 删除；字符串 = 覆盖。调用方（Node）负责序列化。
        let goal_json = params.get("goalJson").and_then(|v| v.as_str());
        snap.memory.put_session_goal(session_id, goal_json)
    }
    // ---- memory：长期记忆（向量 / embedding 部分不在这里） ----

/// `memory.long_recent`
pub(crate) fn long_recent(snap: &ServiceSnapshot, params: &Value) -> Result<Value, CoreError> {
        let limit = params
            .get("limit")
            .and_then(|v| v.as_i64())
            .unwrap_or(20)
            .clamp(1, 100);
        let scope = params.get("scope").and_then(|v| v.as_str());
        let rows = snap.memory.recent_long_memories(limit, scope)?;
        Ok(serde_json::to_value(rows)?)
    }

/// `memory.long_keyword_search`
pub(crate) fn long_keyword_search(snap: &ServiceSnapshot, params: &Value) -> Result<Value, CoreError> {
        let query = params.get("query").and_then(|v| v.as_str()).unwrap_or("");
        let limit = params
            .get("limit")
            .and_then(|v| v.as_i64())
            .unwrap_or(12)
            .clamp(1, 50);
        snap.memory.keyword_search_long_memories(query, limit)
    }

/// `memory.messages_search`
pub(crate) fn messages_search(snap: &ServiceSnapshot, params: &Value) -> Result<Value, CoreError> {
        let query = params.get("query").and_then(|v| v.as_str()).unwrap_or("");
        let workspace = params
            .get("workspacePath")
            .and_then(|v| v.as_str())
            .filter(|s| !s.trim().is_empty());
        let session_id = params
            .get("sessionId")
            .and_then(|v| v.as_str())
            .filter(|s| !s.trim().is_empty());
        let limit = params
            .get("limit")
            .and_then(|v| v.as_i64())
            .unwrap_or(20)
            .clamp(1, 100);
        let snippet_chars = params
            .get("snippetChars")
            .and_then(|v| v.as_i64())
            .unwrap_or(240);
        snap.memory
            .search_messages(query, workspace, session_id, limit, snippet_chars)
    }

/// `memory.compaction_folded`
pub(crate) fn compaction_folded(snap: &ServiceSnapshot, params: &Value) -> Result<Value, CoreError> {
        let query = params.get("query").and_then(|v| v.as_str()).unwrap_or("");
        let workspace = params
            .get("workspacePath")
            .and_then(|v| v.as_str())
            .filter(|s| !s.trim().is_empty());
        let session_id = params
            .get("sessionId")
            .and_then(|v| v.as_str())
            .filter(|s| !s.trim().is_empty());
        let limit = params
            .get("limit")
            .and_then(|v| v.as_i64())
            .unwrap_or(10)
            .clamp(1, 50);
        let snippet_chars = params
            .get("snippetChars")
            .and_then(|v| v.as_i64())
            .unwrap_or(600);
        snap.memory
            .search_compaction_folded(query, workspace, session_id, limit, snippet_chars)
    }

/// `memory.long_vector_status`
pub(crate) fn long_vector_status(snap: &ServiceSnapshot, _params: &Value) -> Result<Value, CoreError> {
    snap.memory.long_memory_vector_status()
}

/// `memory.long_status_set`
pub(crate) fn long_status_set(snap: &ServiceSnapshot, params: &Value) -> Result<Value, CoreError> {
        let memory_id = params
            .get("memoryId")
            .and_then(|v| v.as_i64())
            .ok_or_else(|| CoreError::rpc("INVALID_PARAMS", "memoryId 必填"))?;
        let status = params
            .get("status")
            .and_then(|v| v.as_str())
            .unwrap_or("active");
        snap.memory.update_long_memory_status(memory_id, status)
    }

/// `memory.messages_delete_turn`
pub(crate) fn messages_delete_turn(snap: &ServiceSnapshot, params: &Value) -> Result<Value, CoreError> {
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
        snap.memory
            .delete_turn_messages(session_id, &ids, remove_count)
    }

/// `memory.consolidation_job_create`
pub(crate) fn consolidation_job_create(snap: &ServiceSnapshot, params: &Value) -> Result<Value, CoreError> {
        let scope = params.get("scope").and_then(|v| v.as_str());
        let reason = params.get("reason").and_then(|v| v.as_str());
        snap.memory
            .create_consolidation_job(scope, reason, Some("pending"))
    }

/// `memory.consolidation_job_finish`
pub(crate) fn consolidation_job_finish(snap: &ServiceSnapshot, params: &Value) -> Result<Value, CoreError> {
        let job_id = params
            .get("jobId")
            .and_then(|v| v.as_i64())
            .ok_or_else(|| CoreError::rpc("INVALID_PARAMS", "jobId 必填"))?;
        let status = params
            .get("status")
            .and_then(|v| v.as_str())
            .unwrap_or("completed");
        let error = params.get("error").and_then(|v| v.as_str());
        snap.memory.finish_consolidation_job(job_id, status, error)
    }

/// `memory.long_decay`
pub(crate) fn long_decay(snap: &ServiceSnapshot, params: &Value) -> Result<Value, CoreError> {
        let stale_days = params
            .get("staleDays")
            .and_then(|v| v.as_i64())
            .unwrap_or(120);
        let archive_days = params
            .get("archiveDays")
            .and_then(|v| v.as_i64())
            .unwrap_or(240);
        snap.memory.decay_long_memories(stale_days, archive_days)
    }

/// `memory.sessions_with_messages`
pub(crate) fn sessions_with_messages(snap: &ServiceSnapshot, _params: &Value) -> Result<Value, CoreError> {
        let rows = snap.memory.list_sessions_with_messages()?;
        Ok(serde_json::to_value(rows)?)
    }

/// `memory.messages_after`
pub(crate) fn messages_after(snap: &ServiceSnapshot, params: &Value) -> Result<Value, CoreError> {
        let after_id = params.get("afterId").and_then(|v| v.as_i64()).unwrap_or(0);
        let limit = params.get("limit").and_then(|v| v.as_i64()).unwrap_or(500);
        let rows = snap.memory.list_messages_after_id(after_id, limit)?;
        Ok(serde_json::to_value(rows)?)
    }

/// `memory.long_memories_after`
pub(crate) fn long_memories_after(snap: &ServiceSnapshot, params: &Value) -> Result<Value, CoreError> {
        let after_id = params.get("afterId").and_then(|v| v.as_i64()).unwrap_or(0);
        let limit = params.get("limit").and_then(|v| v.as_i64()).unwrap_or(200);
        let rows = snap.memory.list_long_memories_after_id(after_id, limit)?;
        Ok(serde_json::to_value(rows)?)
    }
    // ---- compaction：纯 CPU，无 IO ----
    // ---- 向量后端：状态与解析结果的唯一出口（设置页据此说清「为什么走不了本地」）----
    // 折叠是确定性的就地截短：没有网络、没有超时，因此和 estimate 一样落在
    // 阻塞池分支里（旧的 `compaction.maybe_compact` 因为要发 LLM 请求，只能放在
    // async 分支并独占一条 90s 的宿主超时）。
    //
    // 上面这三类（`compaction.*` / `embedding.status` / `fs.*` / `codebase.status`）
    // 的函数体已经搬进 `rpc/handlers/`：本 `match` 只保留还没搬的臂。
    // 迁移纪律：搬一个方法 = 表里加 `blocking: Some(handler)` + 删掉这里的臂；
    // `registry.rs` 的 parity 测试会拦「双份实现」与「两边都没有」。
    // ---- agent：运行账本 / trace ----

// ---- 下面是「没有 await 的 memory 方法」：以前写成 async 壳，真正的 rusqlite 全压在
// async worker 上（并发时连 core.ping 都要排队）。A14 把它们搬回阻塞池。----

/// `memory.project_resolve`
pub(crate) fn project_resolve(snap: &ServiceSnapshot, params: &Value) -> Result<Value, CoreError> {
    let path = params
        .get("path")
        .and_then(|v| v.as_str())
        .ok_or_else(|| CoreError::rpc("INVALID_PARAMS", "path 必填"))?;
    let git_origin = params.get("gitOrigin").and_then(|v| v.as_str());
    let memory = &snap.memory;
    memory.resolve_project(path, git_origin)
}

/// `memory.project_list`
pub(crate) fn project_list(snap: &ServiceSnapshot, params: &Value) -> Result<Value, CoreError> {
    let limit = params.get("limit").and_then(|v| v.as_u64()).unwrap_or(50) as usize;
    let memory = &snap.memory;
    memory.list_projects(limit)
}

/// `memory.project_alias_add`
pub(crate) fn project_alias_add(snap: &ServiceSnapshot, params: &Value) -> Result<Value, CoreError> {
    let project_id = params
        .get("projectId")
        .and_then(|v| v.as_i64())
        .ok_or_else(|| CoreError::rpc("INVALID_PARAMS", "projectId 必填"))?;
    let path = params
        .get("path")
        .and_then(|v| v.as_str())
        .ok_or_else(|| CoreError::rpc("INVALID_PARAMS", "path 必填"))?;
    let memory = &snap.memory;
    memory.add_project_alias(project_id, path)
}

/// `memory.long_by_session`
pub(crate) fn long_by_session(snap: &ServiceSnapshot, params: &Value) -> Result<Value, CoreError> {
    let session_id = params
        .get("sessionId")
        .and_then(|v| v.as_str())
        .ok_or_else(|| CoreError::rpc("INVALID_PARAMS", "sessionId 必填"))?;
    let limit = params.get("limit").and_then(|v| v.as_i64()).unwrap_or(50);
    let memory = &snap.memory;
    let rows = memory.long_memories_by_session(session_id, limit)?;
    Ok(json!({ "results": rows }))
}

/// `memory.long_forget_session`
pub(crate) fn long_forget_session(snap: &ServiceSnapshot, params: &Value) -> Result<Value, CoreError> {
    let session_id = params
        .get("sessionId")
        .and_then(|v| v.as_str())
        .ok_or_else(|| CoreError::rpc("INVALID_PARAMS", "sessionId 必填"))?;
    let memory = &snap.memory;
    let archived = memory.archive_long_memories_by_session(session_id)?;
    Ok(json!({ "archived": archived }))
}
